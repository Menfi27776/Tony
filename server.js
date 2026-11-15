// ============================================================================
// GROYPER MINE - EMBER VAULT v2 - server.js
// Express + Telegraf (webhook) + Firestore. Built for Render free tier.
// ============================================================================
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const { Address, beginCell, Cell, contractAddress, loadStateInit } = require('@ton/core');
const { signVerify } = require('@ton/crypto');

// ============================================================================
// 1. SECRETS & ENV
// ============================================================================
const log = (...a) => console.log(new Date().toISOString(), ...a);
const readSecret = f => { try { return fs.readFileSync('/etc/secrets/' + f, 'utf8').trim(); } catch { return null; } };
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_WALLET = process.env.OWNER_WALLET;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
let ADMIN_ID = process.env.ADMIN_ID;
try { ADMIN_ID = ADMIN_ID || JSON.parse(readSecret('admin-config.json')).admin_id; } catch {}
ADMIN_ID = ADMIN_ID ? String(ADMIN_ID) : null;
const TON_API_KEY = process.env.TON_API_KEY || readSecret('ton-api-key.txt') || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('s:' + BOT_TOKEN).digest('hex');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.createHash('sha256').update('w:' + BOT_TOKEN).digest('hex').slice(0, 32);
const CRON_KEY = process.env.CRON_KEY || '';
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN || !OWNER_WALLET || !APP_URL) { console.error('Missing BOT_TOKEN / OWNER_WALLET / APP_URL'); process.exit(1); }

// ============================================================================
// 2. FIREBASE
// ============================================================================
const saKey = readSecret('firebase-admin-key.json');
if (!saKey) { console.error('Missing /etc/secrets/firebase-admin-key.json'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saKey)) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const inc = n => FV.increment(n);
const userRef = id => db.collection('users').doc(String(id));

// ============================================================================
// 3. HELPERS
// ============================================================================
class AppErr extends Error { constructor(m, code = 400) { super(m); this.code = code; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
const mkToken = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + sign(b); };
const rdToken = t => { try { const [b, s] = String(t).split('.'); if (!b || !s || !safeEq(sign(b), s)) return null; return JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return null; } };
const mkYmid = (id, n, s) => { const b = Buffer.from(`${id}.${n}.${s}`).toString('base64url'); return b + '.' + sign(b).slice(0, 12); };
const rdYmid = y => { try { const [b, s] = String(y).split('.'); if (!b || !s || !safeEq(sign(b).slice(0, 12), s)) return null; const [u, n, t] = Buffer.from(b, 'base64url').toString().split('.'); return { u, n: +n, s: +t }; } catch { return null; } };
const h = fn => (req, res) => fn(req, res).catch(e => {
  if (e instanceof AppErr) return res.status(e.code).json({ success: false, error: e.message });
  console.error('ERR', req.method, req.path, e); res.status(500).json({ success: false, error: 'Server error' });
});

// ---- Memory cache (safe to lose on restart) ----
const mem = new Map();
const cached = async (key, ttl, fn) => { const c = mem.get(key); if (c && c.exp > Date.now()) return c.v; const v = await fn(); mem.set(key, { v, exp: Date.now() + ttl }); return v; };
const bust = k => mem.delete(k);

// ---- Batched stats (flushed every 30s: 1 write instead of N) ----
const pend = {};
const statInc = (k, n = 1) => { pend[k] = (pend[k] || 0) + n; };
let daily = { day: '', amount: 0, unflushed: 0 };
const dayKey = () => new Date().toISOString().slice(0, 10);
async function flushStats() {
  const keys = Object.keys(pend);
  try {
    if (keys.length) { const upd = {}; for (const k of keys) { upd[k] = inc(pend[k]); delete pend[k]; } await db.doc('stats/global').set(upd, { merge: true }); }
    if (daily.unflushed) { const n = daily.unflushed; daily.unflushed = 0; await db.doc('stats_daily/' + daily.day).set({ amount: inc(n) }, { merge: true }); }
  } catch (e) { console.error('flushStats', e.message); }
}
setInterval(flushStats, 30000);
async function dailyLoad() {
  const d = dayKey(); if (daily.day === d) return;
  if (daily.unflushed) await flushStats();
  const s = await db.doc('stats_daily/' + d).get();
  daily = { day: d, amount: s.exists ? s.data().amount || 0 : 0, unflushed: 0 };
}
const capCheck = (cfg, n) => { if (cfg.dailyCap > 0 && daily.amount + n > cfg.dailyCap) throw new AppErr('Daily distribution limit reached. Try again tomorrow.'); };
const capCommit = n => { daily.amount += n; daily.unflushed += n; statInc('distributed', n); };

// ============================================================================
// 4. ECONOMY CONFIG (overridable from Firestore: settings/config, via /set)
// ============================================================================
const DEFAULTS = {
  symbol: 'GROYP', bot: 'GroyperMinebot', app: 'Mine',
  tokenAddress: 'EQBvcsqG7hqsw-HQ8bemIYrO8I_GLDTSbNiro4WOC7jAG_CH',
  channelUrl: 'https://t.me/GroyperMine', groupUrl: 'https://t.me/communityGroyper',
  dexUrl: 'https://dedust.io/swap/TON/EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
  miningReward: 20, cooldownMs: 6 * 3600e3,
  adsPerBatch: 10, adsReward: 20, adsCooldownMs: 6 * 3600e3, adsMinGapSec: 15, adsRequirePostback: false,
  minWithdraw: 2000, feeTon: 0.1, minAccountAgeHours: 12, maxPendingWd: 3,
  referralReward: 75,
  milestones: [{ count: 50, reward: 1000 }, { count: 100, reward: 2500 }, { count: 250, reward: 5000 }, { count: 500, reward: 10000 }, { count: 1000, reward: 25000 }],
  boosts: { bronze: { price: 1, mult: 2, name: 'SPARK' }, silver: { price: 2.5, mult: 5, name: 'BLAZE' }, gold: { price: 10, mult: 12, name: 'INFERNO' } },
  boostDays: 30, checkinRewards: [5, 10, 15, 20, 30, 40, 60],
  dailyCap: 0, miningEnabled: true, withdrawEnabled: true, maintenance: false, banner: '', remindersEnabled: false
};
const getConfig = () => cached('config', 60000, async () => {
  const s = await db.doc('settings/config').get();
  return { ...DEFAULTS, ...(s.exists ? s.data() : {}) };
});
const setConfig = async patch => { await db.doc('settings/config').set(patch, { merge: true }); bust('config'); };
const publicConfig = c => ({ symbol: c.symbol, bot: c.bot, app: c.app, tokenAddress: c.tokenAddress, miningReward: c.miningReward, cooldownMs: c.cooldownMs, adsPerBatch: c.adsPerBatch, adsReward: c.adsReward, adsCooldownMs: c.adsCooldownMs, minWithdraw: c.minWithdraw, feeTon: c.feeTon, referralReward: c.referralReward, milestones: c.milestones, boosts: c.boosts });

const DEFAULT_TASKS = [
  { id: 'join_channel', name: 'Join Telegram Channel', url: DEFAULTS.channelUrl, reward: 50, iconClass: 'fab fa-telegram', verify: 'chat', chat: '@GroyperMine' },
  { id: 'join_group', name: 'Join Community Group', url: DEFAULTS.groupUrl, reward: 50, iconClass: 'fas fa-users', verify: 'chat', chat: '@communityGroyper' },
  { id: 'follow_x', name: 'Follow on X', url: 'https://x.com/GroyperMine', reward: 50, iconClass: 'fab fa-twitter', verify: 'delay', delaySec: 20 }
];
const getTasks = () => cached('tasks', 300000, async () => { const s = await db.doc('settings/tasks').get(); return s.exists && Array.isArray(s.data().list) ? s.data().list : DEFAULT_TASKS; });
const saveTasks = async list => { await db.doc('settings/tasks').set({ list }); bust('tasks'); };

let lastPrice = { usd: 0, change: 0, mcap: 0, fdv: 0, liq: 0, vol: 0 };
const getPrice = () => cached('price', 60000, async () => {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${DEFAULTS.tokenAddress}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const p = (j.pairs || []).sort((a, b) => (+b.liquidity?.usd || 0) - (+a.liquidity?.usd || 0))[0];
    if (p) lastPrice = { usd: +p.priceUsd || 0, change: +p.priceChange?.h24 || 0, mcap: +p.marketCap || 0, fdv: +p.fdv || 0, liq: +p.liquidity?.usd || 0, vol: +p.volume?.h24 || 0 };
  } catch (e) { log('price fetch failed', e.message); }
  return lastPrice;
});

// ============================================================================
// 5. USER MODEL
// ============================================================================
const PUB = ['userId', 'username', 'firstName', 'wallet', 'walletRaw', 'balance', 'totalWithdrawn', 'totalEarned', 'lastMiningClaim', 'boostMultiplier', 'boostType', 'boostExpiresAt', 'adsCooldownUntil', 'completedTasks', 'activeReferrals', 'inactiveReferrals', 'claimedMilestones', 'streak', 'lastCheckinDay', 'isActive', 'withdrawFeePaid', 'createdAt'];
const pub = u => { const o = {}; for (const k of PUB) if (u[k] !== undefined) o[k] = u[k]; return o; };
const mult = (u, now = Date.now()) => (u.boostMultiplier > 1 && u.boostExpiresAt > now ? u.boostMultiplier : 1);
const newUser = tg => ({
  userId: tg.id, username: tg.username, firstName: tg.first_name, wallet: '', walletRaw: '', balance: 0, totalWithdrawn: 0, totalEarned: 0,
  lastMiningClaim: 0, remindAt: 0, boostMultiplier: 1, boostType: null, boostExpiresAt: 0, adsCooldownUntil: 0, completedTasks: [],
  activeReferrals: 0, inactiveReferrals: 0, claimedMilestones: [], referredBy: null, isActive: false, withdrawFeePaid: false,
  pendingWd: 0, streak: 0, lastCheckinDay: 0, banned: false, createdAt: Date.now()
});
const notify = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

// ============================================================================
// 6. TELEGRAM AUTH (initData HMAC) + RATE LIMIT
// ============================================================================
function verifyInitData(raw) {
  if (!raw) return null;
  const p = new URLSearchParams(raw); const hash = p.get('hash'); if (!hash) return null; p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  if (!safeEq(crypto.createHmac('sha256', secret).update(str).digest('hex'), hash)) return null;
  const ad = +p.get('auth_date'); if (!ad || Date.now() / 1000 - ad > 86400) return null;
  let u; try { u = JSON.parse(p.get('user') || 'null'); } catch { return null; }
  if (!u?.id) return null;
  return { id: String(u.id), username: u.username || '', first_name: u.first_name || 'User', lang: u.language_code, start: p.get('start_param') || null };
}
const rl = new Map();
const rate = (id, max = 90) => { const n = Date.now(), e = rl.get(id); if (!e || e.r < n) { rl.set(id, { c: 1, r: n + 60000 }); return true; } return ++e.c <= max; };
setInterval(() => { const n = Date.now(); for (const [k, v] of rl) if (v.r < n) rl.delete(k); for (const [k, v] of confirmed) if (v < n) confirmed.delete(k); for (const [k, v] of taskStart) if (v < n - 3600e3) taskStart.delete(k); }, 60000);
const confirmed = new Map(); // ad postbacks
const taskStart = new Map(); // delay-task timers

async function authMw(req, res, next) {
  const hdr = req.headers.authorization || '';
  const tg = hdr.startsWith('tma ') ? verifyInitData(hdr.slice(4)) : null;
  if (!tg) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!rate(tg.id)) return res.status(429).json({ success: false, error: 'Too many requests' });
  req.tg = tg;
  try { const c = await getConfig(); if (c.maintenance && tg.id !== ADMIN_ID) return res.status(503).json({ success: false, error: 'Maintenance' }); } catch {}
  next();
}

// ============================================================================
// 7. TON: ton_proof + payment verification
// ============================================================================
async function tonGet(p) {
  const r = await fetch('https://tonapi.io/v2' + p, { headers: TON_API_KEY ? { Authorization: 'Bearer ' + TON_API_KEY } : {}, signal: AbortSignal.timeout(10000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const proofPayload = id => { const ts = Date.now().toString(36); return `${ts}.${crypto.createHmac('sha256', SESSION_SECRET).update(`${id}.${ts}`).digest('hex').slice(0, 32)}`; };
const proofPayloadOk = (p, id) => {
  const [ts, mac] = String(p).split('.'); if (!ts || !mac) return false;
  const age = Date.now() - parseInt(ts, 36);
  return age >= 0 && age < 900000 && safeEq(crypto.createHmac('sha256', SESSION_SECRET).update(`${id}.${ts}`).digest('hex').slice(0, 32), mac);
};
const sha256 = b => crypto.createHash('sha256').update(b).digest();

async function verifyProof({ address, publicKey, proof, stateInit }, tgId) {
  if (!address || !publicKey || !proof?.signature || !proof?.domain?.value) throw new AppErr('Your wallet did not provide an ownership proof. Please reconnect.');
  let addr; try { addr = Address.parse(address); } catch { throw new AppErr('Invalid wallet address'); }
  if (proof.domain.value !== new URL(APP_URL).host) throw new AppErr('Proof domain mismatch');
  if (Math.abs(Date.now() / 1000 - proof.timestamp) > 900) throw new AppErr('Proof expired. Reconnect your wallet.');
  if (!proofPayloadOk(proof.payload, tgId)) throw new AppErr('Invalid proof payload. Reconnect your wallet.');
  const domain = Buffer.from(proof.domain.value);
  const wc = Buffer.alloc(4); wc.writeInt32BE(addr.workChain);
  const ts = Buffer.alloc(8); ts.writeBigUInt64LE(BigInt(proof.timestamp));
  const dl = Buffer.alloc(4); dl.writeUInt32LE(domain.length);
  const msg = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, addr.hash, dl, domain, ts, Buffer.from(proof.payload)]);
  const full = sha256(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256(msg)]));
  if (!signVerify(full, Buffer.from(proof.signature, 'base64'), Buffer.from(publicKey, 'hex'))) throw new AppErr('Invalid wallet signature');
  // Bind public key to address
  let bound = false;
  try { const r = await tonGet(`/accounts/${encodeURIComponent(addr.toRawString())}/publickey`); if (r.status === 200 && r.json?.public_key) bound = r.json.public_key.toLowerCase() === publicKey.toLowerCase(); } catch {}
  if (!bound && stateInit) { // undeployed wallet: StateInit hash == address
    try {
      const si = loadStateInit(Cell.fromBase64(stateInit).beginParse());
      if (contractAddress(addr.workChain, si).hash.equals(addr.hash) && si.data) {
        const bits = si.data.bits; let s = ''; for (let i = 0; i < bits.length; i++) s += bits.at(i) ? '1' : '0';
        const pk = BigInt('0x' + publicKey).toString(2).padStart(256, '0'); bound = s.includes(pk);
      }
    } catch {}
  }
  if (!bound) throw new AppErr('Could not verify wallet ownership');
  return addr;
}

const commentPayload = c => beginCell().storeUint(0, 32).storeStringTail(c).endCell().toBoc().toString('base64');

async function verifyPayment(it, boc) {
  let hash; try { hash = Cell.fromBase64(boc).hash().toString('hex'); } catch { throw new AppErr('Invalid transaction'); }
  let tx = null;
  for (let i = 0; i < 6 && !tx; i++) { const r = await tonGet(`/blockchain/messages/${hash}/transaction`).catch(() => ({})); if (r.status === 200 && r.json?.hash) tx = r.json; else await sleep(4000); }
  if (!tx) throw new AppErr('Transaction not confirmed yet. Please try again in a moment.');
  if (tx.success === false || tx.aborted) throw new AppErr('Transaction failed');
  if ((tx.utime || 0) * 1000 < it.createdAt - 60000) throw new AppErr('Transaction is older than the request');
  if (!Address.parse(tx.account.address).equals(Address.parse(it.walletRaw))) throw new AppErr('Payment must come from your linked wallet');
  const need = Math.round(it.amountTon * 1e9), owner = Address.parse(OWNER_WALLET), hex = Buffer.from(it.comment).toString('hex');
  const ok = (tx.out_msgs || []).some(m => {
    try { return m.destination && Address.parse(m.destination.address).equals(owner) && Number(m.value) >= need && (m.decoded_body?.text === it.comment || String(m.raw_body || '').toLowerCase().includes(hex)); } catch { return false; }
  });
  if (!ok) throw new AppErr('Payment details do not match');
  return hash;
}

// ============================================================================
// 8. BOT (webhook) + ADMIN PANEL
// ============================================================================
const bot = new Telegraf(BOT_TOKEN);
const isAdmin = ctx => String(ctx.from?.id) === ADMIN_ID;
const sessions = new Map();

bot.start(async ctx => {
  const c = await getConfig();
  await ctx.replyWithHTML(
    `🔥 <b>Welcome to Groyper Mine, ${esc(ctx.from.first_name)}!</b>\n\nMine <b>$${c.symbol}</b> on TON:\n⛏ Claim <b>${c.miningReward} ${c.symbol}</b> every 6 hours\n🎬 Watch ads for <b>${c.adsReward} ${c.symbol}</b> per batch\n✅ Complete tasks & daily check-ins\n👥 Earn <b>${c.referralReward} ${c.symbol}</b> per active friend`,
    Markup.inlineKeyboard([[Markup.button.webApp('⛏️ Launch App', APP_URL)], [Markup.button.url('📢 Channel', c.channelUrl), Markup.button.url('💬 Community', c.groupUrl)], [Markup.button.url('💱 Trade', c.dexUrl)]]));
});

async function settleWithdrawal(id, status) {
  const d = await db.runTransaction(async tx => {
    const wr = db.collection('withdrawals').doc(id), w = await tx.get(wr);
    if (!w.exists) throw new AppErr('Request not found');
    const x = w.data(); if (x.status !== 'pending') throw new AppErr('Already ' + x.status);
    tx.update(wr, { status, settledAt: Date.now() });
    tx.set(userRef(x.userId), status === 'paid' ? { totalWithdrawn: inc(x.amount), pendingWd: inc(-1) } : { balance: inc(x.amount), pendingWd: inc(-1) }, { merge: true });
    return x;
  });
  statInc('pendingCount', -1); statInc('pendingAmount', -d.amount); if (status === 'paid') statInc('withdrawnTotal', d.amount);
  notify(d.userId, status === 'paid' ? `✅ Your withdrawal of <b>${fmt(d.amount)}</b> has been sent to your wallet!` : `❌ Your withdrawal of <b>${fmt(d.amount)}</b> was rejected. The amount was returned to your balance.`);
  return d;
}

const wdCard = w => [`💸 <b>Withdrawal</b>`, `👤 @${esc(w.username)} (<code>${w.userId}</code>)`, `💰 <b>${fmt(w.amount)}</b>`, `💳 <code>${w.wallet}</code>`, `📅 ${new Date(w.createdAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`].join('\n');
const wdKb = id => Markup.inlineKeyboard([[Markup.button.callback('✅ Paid', 'a:wp:' + id), Markup.button.callback('❌ Reject', 'a:wr:' + id)]]);

async function panel() {
  const c = await getConfig(), s = (await db.doc('stats/global').get()).data() || {};
  const t = (k, l) => Markup.button.callback(`${c[k] ? '🟢' : '🔴'} ${l}`, 'a:tg:' + k);
  return {
    text: `👑 <b>Admin Panel</b>\n\n👥 Users: <b>${fmt(s.users)}</b>\n⛏ Claims: <b>${fmt(s.claims)}</b>\n💰 Distributed: <b>${fmt(s.distributed)}</b>\n⏳ Pending: <b>${fmt(s.pendingCount)}</b> (${fmt(s.pendingAmount)})\n📤 Paid out: <b>${fmt(s.withdrawnTotal)}</b>\n💎 TON revenue: <b>${(s.tonRevenue || 0).toFixed(2)}</b>\n\n🟢 = ON. Maintenance ON blocks the app.`,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback('📋 Pending withdrawals', 'a:wd')],
      [Markup.button.callback('📝 Tasks', 'a:tasks'), Markup.button.callback('📢 Broadcast', 'a:bc')],
      [t('miningEnabled', 'Mining'), t('withdrawEnabled', 'Withdraw')],
      [t('maintenance', 'Maintenance'), t('remindersEnabled', 'Reminders')],
      [Markup.button.callback('🔄 Refresh', 'a:home')]
    ])
  };
}

bot.command('admin', async ctx => { if (!isAdmin(ctx)) return; const p = await panel(); ctx.replyWithHTML(p.text, p.kb); });
bot.command('cancel', ctx => { if (isAdmin(ctx)) { sessions.delete(ADMIN_ID); ctx.reply('Cancelled.'); } });
bot.command('set', async ctx => {
  if (!isAdmin(ctx)) return;
  const [, k, v] = ctx.message.text.split(/\s+/);
  const keys = ['miningReward', 'adsReward', 'referralReward', 'minWithdraw', 'feeTon', 'minAccountAgeHours', 'maxPendingWd', 'dailyCap', 'adsMinGapSec', 'boostDays'];
  if (!keys.includes(k) || isNaN(+v)) return ctx.reply('Usage: /set <key> <number>\nKeys: ' + keys.join(', '));
  await setConfig({ [k]: +v }); ctx.reply(`✅ ${k} = ${+v}`);
});
bot.command('banner', async ctx => { if (!isAdmin(ctx)) return; const t = ctx.message.text.replace(/^\/banner\s*/, ''); await setConfig({ banner: t }); ctx.reply(t ? '✅ Banner set' : '✅ Banner cleared'); });
bot.command('user', async ctx => {
  if (!isAdmin(ctx)) return; const id = ctx.message.text.split(/\s+/)[1]; if (!id) return ctx.reply('/user <id>');
  const s = await userRef(id).get(); if (!s.exists) return ctx.reply('Not found');
  const u = s.data(); ctx.replyWithHTML(`<b>@${esc(u.username)}</b> (${u.userId})\nBalance: ${fmt(u.balance)}\nEarned: ${fmt(u.totalEarned)}\nWithdrawn: ${fmt(u.totalWithdrawn)}\nBoost: ${u.boostType || '-'}\nActive refs: ${u.activeReferrals} / Inactive: ${u.inactiveReferrals}\nBanned: ${u.banned}\nWallet: <code>${u.wallet}</code>`);
});
const banCmd = val => async ctx => { if (!isAdmin(ctx)) return; const id = ctx.message.text.split(/\s+/)[1]; if (!id) return ctx.reply('Need user id'); await userRef(id).set({ banned: val }, { merge: true }); ctx.reply(val ? '🚫 Banned' : '✅ Unbanned'); };
bot.command('ban', banCmd(true)); bot.command('unban', banCmd(false));
bot.command('resetwallet', async ctx => {
  if (!isAdmin(ctx)) return; const id = ctx.message.text.split(/\s+/)[1]; if (!id) return ctx.reply('Need user id');
  const s = await userRef(id).get(); if (!s.exists) return ctx.reply('Not found');
  const u = s.data(); const b = db.batch();
  if (u.walletRaw) b.delete(db.doc('wallets/' + Address.parse(u.walletRaw).hash.toString('hex')));
  b.update(userRef(id), { wallet: '', walletRaw: '' }); await b.commit(); ctx.reply('✅ Wallet unlinked');
});

bot.action(/^a:(\w+)(?::(.+))?$/, async ctx => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
  const [, act, arg] = ctx.match; await ctx.answerCbQuery().catch(() => {});
  try {
    if (act === 'home') { const p = await panel(); return ctx.editMessageText(p.text, { parse_mode: 'HTML', ...p.kb }).catch(() => {}); }
    if (act === 'tg') { const c = await getConfig(); await setConfig({ [arg]: !c[arg] }); const p = await panel(); return ctx.editMessageText(p.text, { parse_mode: 'HTML', ...p.kb }).catch(() => {}); }
    if (act === 'wd') {
      const snap = await db.collection('withdrawals').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(5).get();
      if (snap.empty) return ctx.reply('✅ No pending withdrawals');
      for (const d of snap.docs) await ctx.replyWithHTML(wdCard(d.data()), wdKb(d.id));
      return;
    }
    if (act === 'wp' || act === 'wr') {
      const w = await settleWithdrawal(arg, act === 'wp' ? 'paid' : 'rejected');
      return ctx.editMessageText(wdCard(w) + `\n\n${act === 'wp' ? '✅ MARKED PAID' : '❌ REJECTED'}`, { parse_mode: 'HTML' }).catch(() => {});
    }
    if (act === 'tasks') {
      const tasks = await getTasks();
      const txt = '📝 <b>Tasks</b>\n\n' + tasks.map((t, i) => `${i + 1}. <b>${esc(t.name)}</b> (+${t.reward}) [${t.verify}]\n${esc(t.url)}`).join('\n\n');
      return ctx.replyWithHTML(txt, Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'a:ta')], ...tasks.map(t => [Markup.button.callback('🗑 ' + t.name.slice(0, 30), 'a:td:' + t.id)])]));
    }
    if (act === 'td') { const l = (await getTasks()).filter(t => t.id !== arg); await saveTasks(l); return ctx.reply('✅ Deleted'); }
    if (act === 'ta') { sessions.set(ADMIN_ID, { step: 'tname' }); return ctx.reply('Task name? (/cancel to abort)'); }
    if (act === 'tv') { const s = sessions.get(ADMIN_ID); if (!s) return; if (arg === 'chat') { s.verify = 'chat'; s.step = 'tchat'; return ctx.reply('Send the channel/group @username (the bot must be admin there):'); } s.verify = 'delay'; return finishTask(ctx, s); }
    if (act === 'bc') { sessions.set(ADMIN_ID, { step: 'bc' }); return ctx.reply('📢 Send the broadcast text (HTML allowed). /cancel to abort.'); }
  } catch (e) { ctx.reply('⚠️ ' + (e.message || 'Error')); }
});

async function finishTask(ctx, s) {
  const tasks = await getTasks();
  tasks.push({ id: 't' + Date.now(), name: s.name, url: s.url, reward: s.reward, verify: s.verify, chat: s.chat || null, delaySec: 20, iconClass: /t\.me/.test(s.url) ? 'fab fa-telegram' : /x\.com|twitter/.test(s.url) ? 'fab fa-twitter' : 'fas fa-link' });
  await saveTasks(tasks); sessions.delete(ADMIN_ID); ctx.reply(`✅ Task "${s.name}" added (${s.verify}).`);
}

async function broadcast(text) {
  let sent = 0, failed = 0, last = null;
  for (;;) {
    let q = db.collection('users').orderBy('__name__').limit(300); if (last) q = q.startAfter(last);
    const snap = await q.get(); if (snap.empty) break;
    for (const d of snap.docs) { try { await bot.telegram.sendMessage(d.id, '📢 ' + text, { parse_mode: 'HTML' }); sent++; } catch { failed++; } await sleep(45); }
    last = snap.docs[snap.docs.length - 1];
  }
  notify(ADMIN_ID, `✅ Broadcast done: ${sent} sent, ${failed} failed.`);
}

bot.on('text', async ctx => {
  if (!isAdmin(ctx)) return; const s = sessions.get(ADMIN_ID); if (!s) return; const t = ctx.message.text;
  if (s.step === 'tname') { s.name = t.slice(0, 60); s.step = 'turl'; return ctx.reply('Task URL (https://...):'); }
  if (s.step === 'turl') { if (!/^https:\/\//.test(t)) return ctx.reply('❌ Must start with https://'); s.url = t; s.step = 'treward'; return ctx.reply('Reward amount (number):'); }
  if (s.step === 'treward') { const n = parseInt(t); if (!(n > 0)) return ctx.reply('❌ Invalid number'); s.reward = n; s.step = 'tverify'; return ctx.reply('Verification type?', Markup.inlineKeyboard([[Markup.button.callback('Channel/Group member', 'a:tv:chat'), Markup.button.callback('Link (time delay)', 'a:tv:delay')]])); }
  if (s.step === 'tchat') { if (!/^@\w{4,}$/.test(t)) return ctx.reply('❌ Send like @mychannel'); s.chat = t; return finishTask(ctx, s); }
  if (s.step === 'bc') { sessions.delete(ADMIN_ID); ctx.reply('⏳ Broadcasting in background...'); broadcast(t).catch(e => notify(ADMIN_ID, 'Broadcast error: ' + e.message)); }
});
bot.catch((e, ctx) => console.error('BOT ERR', ctx?.updateType, e.message));

// ============================================================================
// 9. EXPRESS APP
// ============================================================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
app.use(cors({ origin: APP_URL }));
app.use(express.json({ limit: '100kb' }));

const hookPath = '/tg-' + WEBHOOK_SECRET;
app.post(hookPath, (req, res, next) => {
  if (!safeEq(req.headers['x-telegram-bot-api-secret-token'] || '', WEBHOOK_SECRET)) return res.sendStatus(403);
  next();
}, bot.webhookCallback(hookPath));
app.get('/health', (_, res) => res.send('ok'));

// Static whitelist (never expose server.js / package.json)
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
app.get(Object.keys(FILES), (req, res) => { res.set('Cache-Control', req.path === '/' || req.path === '/index.html' ? 'no-cache' : 'public, max-age=300'); res.sendFile(path.join(__dirname, FILES[req.path])); });
app.get('/tonconnect-manifest.json', (_, res) => res.json({ url: APP_URL, name: 'Groyper Mine', iconUrl: 'https://assets.coingecko.com/coins/images/102172192/standard/Untitled_design__12_-removebg-preview.png', termsOfUseUrl: APP_URL + '/terms', privacyPolicyUrl: APP_URL + '/privacy' }));
app.get('/terms', (_, res) => res.send('<h1>Terms</h1><p>Groyper Mine rewards are community incentives, not an investment offer. No guarantee of value. Abuse, bots or multi-accounting may lead to a ban.</p>'));
app.get('/privacy', (_, res) => res.send('<h1>Privacy</h1><p>We store your Telegram ID, username, wallet address and in-app activity to run the service. We never access your wallet keys.</p>'));

// Ad network postback (set in Monetag: https://APP/postback?ymid={ymid}&key=CRON_KEY)
app.get('/postback', (req, res) => { if (CRON_KEY && safeEq(String(req.query.key || ''), CRON_KEY) && req.query.ymid) confirmed.set(String(req.query.ymid), Date.now() + 900000); res.send('ok'); });

const api = express.Router();
api.use(authMw);

// ---------- init (1 read) ----------
api.get('/init', h(async (req, res) => {
  const [cfg, tasks, price, snap] = await Promise.all([getConfig(), getTasks(), getPrice(), userRef(req.tg.id).get()]);
  const u = snap.exists ? snap.data() : null; if (u?.banned) throw new AppErr('Account banned', 403);
  res.json({ success: true, user: u ? pub(u) : null, tasks, config: publicConfig(cfg), price, serverTime: Date.now(), banner: cfg.banner || '' });
}));
api.get('/price', h(async (req, res) => res.json({ success: true, price: await getPrice() })));
api.get('/proof-payload', h(async (req, res) => res.json({ success: true, payload: proofPayload(req.tg.id) })));

// ---------- register / wallet link (ton_proof verified) ----------
api.post('/register', h(async (req, res) => {
  const tg = req.tg, addr = await verifyProof(req.body || {}, tg.id);
  const raw = addr.toRawString(), friendly = addr.toString({ bounceable: false, urlSafe: true });
  const uRef = userRef(tg.id), wRef = db.doc('wallets/' + addr.hash.toString('hex'));
  const sp = tg.start && /^\d{5,15}$/.test(tg.start) && tg.start !== tg.id ? tg.start : null, rRef = sp ? userRef(sp) : null;
  let created = false;
  const user = await db.runTransaction(async tx => {
    const [us, ws, rs] = await Promise.all([tx.get(uRef), tx.get(wRef), rRef ? tx.get(rRef) : null]);
    if (ws.exists && ws.data().userId !== tg.id) throw new AppErr('This wallet is already linked to another account');
    if (us.exists) {
      const u = us.data(); if (u.banned) throw new AppErr('Account banned', 403);
      if (u.walletRaw && u.walletRaw !== raw) throw new AppErr('Your account is locked to another wallet. Contact support to change it.');
      if (!u.walletRaw) { tx.update(uRef, { wallet: friendly, walletRaw: raw }); tx.set(wRef, { userId: tg.id, at: Date.now() }); return { ...u, wallet: friendly, walletRaw: raw }; }
      return u;
    }
    const u = { ...newUser(tg), wallet: friendly, walletRaw: raw };
    if (rs && rs.exists) {
      u.referredBy = sp;
      tx.set(rRef.collection('referrals').doc(tg.id), { username: tg.username || tg.first_name, active: false, createdAt: Date.now() });
      tx.set(rRef, { inactiveReferrals: inc(1) }, { merge: true });
    }
    tx.set(uRef, u); tx.set(wRef, { userId: tg.id, at: Date.now() }); created = true; return u;
  });
  if (created) statInc('users');
  res.json({ success: true, user: pub(user) });
}));

// ---------- mining ----------
api.post('/mining/claim', h(async (req, res) => {
  const cfg = await getConfig(); if (!cfg.miningEnabled) throw new AppErr('Mining is temporarily paused');
  await dailyLoad(); const id = req.tg.id, ref = userRef(id), now = Date.now(); let refInfo = null;
  const out = await db.runTransaction(async tx => {
    refInfo = null; const s = await tx.get(ref); if (!s.exists) throw new AppErr('User not found');
    const u = s.data(); if (u.banned) throw new AppErr('Account banned', 403);
    if (now - (u.lastMiningClaim || 0) < cfg.cooldownMs - 3000) throw new AppErr('Not ready yet');
    const reward = cfg.miningReward * mult(u, now); capCheck(cfg, reward);
    tx.update(ref, { balance: inc(reward), totalEarned: inc(reward), lastMiningClaim: now, remindAt: now + cfg.cooldownMs, isActive: true });
    if (!u.isActive && u.referredBy) {
      const rr = userRef(u.referredBy);
      tx.set(rr, { activeReferrals: inc(1), inactiveReferrals: inc(-1), balance: inc(cfg.referralReward), totalEarned: inc(cfg.referralReward) }, { merge: true });
      tx.set(rr.collection('referrals').doc(id), { active: true }, { merge: true }); refInfo = { to: u.referredBy, name: u.username || u.firstName };
    }
    return { reward, user: { ...u, balance: (u.balance || 0) + reward, totalEarned: (u.totalEarned || 0) + reward, lastMiningClaim: now, isActive: true } };
  });
  capCommit(out.reward); statInc('claims');
  if (refInfo) { capCommit(cfg.referralReward); notify(refInfo.to, `🎉 +${cfg.referralReward} ${cfg.symbol} - your friend @${esc(refInfo.name)} is now active!`); }
  res.json({ success: true, reward: out.reward, user: pub(out.user) });
}));

// ---------- ads (signed stateless tokens: 0 DB ops until claim) ----------
api.post('/ads/start', h(async (req, res) => {
  const cfg = await getConfig(), id = req.tg.id, now = Date.now(); let tk = rdToken(req.body?.token);
  if (!tk || tk.u !== id) { const s = await userRef(id).get(); if (!s.exists) throw new AppErr('User not found'); tk = { u: id, e: s.data().adsCooldownUntil || 0, n: 0, t: 0 }; }
  if (now < tk.e) throw new AppErr('Ads are on cooldown'); if (tk.n >= cfg.adsPerBatch) throw new AppErr('Batch complete. Claim your reward first.');
  res.json({ success: true, ymid: mkYmid(id, tk.n, now), token: mkToken(tk) });
}));
api.post('/ads/watch', h(async (req, res) => {
  const cfg = await getConfig(), id = req.tg.id, now = Date.now(), tk = rdToken(req.body?.token), y = rdYmid(req.body?.ymid);
  if (!tk || !y || tk.u !== id || y.u !== id || y.n !== tk.n) throw new AppErr('Invalid ad session');
  const age = now - y.s, gap = cfg.adsMinGapSec * 1000;
  if (age > 600000) throw new AppErr('Ad session expired'); if (age < gap || now - (tk.t || 0) < gap) throw new AppErr('Ad was not completed');
  if (now < tk.e) throw new AppErr('Ads are on cooldown'); if (tk.n >= cfg.adsPerBatch) throw new AppErr('Batch complete');
  if (cfg.adsRequirePostback && !confirmed.has(req.body.ymid)) throw new AppErr('Ad not confirmed yet, try again');
  confirmed.delete(req.body.ymid);
  const nt = { u: id, e: tk.e, n: tk.n + 1, t: now }; res.json({ success: true, watched: nt.n, token: mkToken(nt) });
}));
api.post('/ads/claim', h(async (req, res) => {
  const cfg = await getConfig(); await dailyLoad(); const id = req.tg.id, ref = userRef(id), now = Date.now(), tk = rdToken(req.body?.token);
  if (!tk || tk.u !== id || tk.n < cfg.adsPerBatch) throw new AppErr('Watch all ads first');
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) throw new AppErr('User not found'); const u = s.data(); if (u.banned) throw new AppErr('Account banned', 403);
    if (tk.e !== (u.adsCooldownUntil || 0) || now < tk.e) throw new AppErr('Session expired. Start a new batch.');
    capCheck(cfg, cfg.adsReward); const until = now + cfg.adsCooldownMs;
    tx.update(ref, { balance: inc(cfg.adsReward), totalEarned: inc(cfg.adsReward), adsCooldownUntil: until });
    return { ...u, balance: (u.balance || 0) + cfg.adsReward, totalEarned: (u.totalEarned || 0) + cfg.adsReward, adsCooldownUntil: until };
  });
  capCommit(cfg.adsReward); res.json({ success: true, reward: cfg.adsReward, user: { ...pub(out), adsWatched: 0, adsToken: null } });
}));

// ---------- daily check-in ----------
api.post('/checkin', h(async (req, res) => {
  const cfg = await getConfig(); await dailyLoad(); const id = req.tg.id, ref = userRef(id), day = Math.floor(Date.now() / 86400e3);
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) throw new AppErr('User not found'); const u = s.data(); if (u.banned) throw new AppErr('Account banned', 403);
    if (u.lastCheckinDay === day) throw new AppErr('Already checked in today');
    const streak = u.lastCheckinDay === day - 1 ? (u.streak || 0) + 1 : 1, reward = cfg.checkinRewards[(streak - 1) % cfg.checkinRewards.length]; capCheck(cfg, reward);
    tx.update(ref, { balance: inc(reward), totalEarned: inc(reward), streak, lastCheckinDay: day });
    return { reward, user: { ...u, balance: (u.balance || 0) + reward, totalEarned: (u.totalEarned || 0) + reward, streak, lastCheckinDay: day } };
  });
  capCommit(out.reward); res.json({ success: true, reward: out.reward, user: pub(out.user) });
}));

// ---------- tasks ----------
api.post('/tasks/verify', h(async (req, res) => {
  const cfg = await getConfig(); await dailyLoad(); const id = req.tg.id, taskId = String(req.body?.taskId || '');
  const task = (await getTasks()).find(t => t.id === taskId); if (!task) throw new AppErr('Task not found');
  if (task.verify === 'chat') {
    let ok = false; try { const m = await bot.telegram.getChatMember(task.chat, +id); ok = ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member); } catch (e) { log('getChatMember', e.message); }
    if (!ok) throw new AppErr('Please join first, then press Verify');
  } else {
    const k = id + ':' + taskId, st = taskStart.get(k), need = (task.delaySec || 20) * 1000;
    if (!st) { taskStart.set(k, Date.now()); throw new AppErr(`Complete the task, then press Verify again in ${task.delaySec || 20}s`); }
    if (Date.now() - st < need) throw new AppErr('Please finish the task first, then try again');
    taskStart.delete(k);
  }
  const ref = userRef(id);
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) throw new AppErr('User not found'); const u = s.data(); if (u.banned) throw new AppErr('Account banned', 403);
    if ((u.completedTasks || []).includes(taskId)) throw new AppErr('Already completed'); capCheck(cfg, task.reward);
    tx.update(ref, { completedTasks: FV.arrayUnion(taskId), balance: inc(task.reward), totalEarned: inc(task.reward) });
    return { ...u, completedTasks: [...(u.completedTasks || []), taskId], balance: (u.balance || 0) + task.reward, totalEarned: (u.totalEarned || 0) + task.reward };
  });
  capCommit(task.reward); res.json({ success: true, reward: task.reward, user: pub(out) });
}));

// ---------- referrals ----------
api.get('/referrals', h(async (req, res) => {
  let q = userRef(req.tg.id).collection('referrals').orderBy('createdAt', 'desc').limit(20);
  if (req.query.cursor) q = q.startAfter(Number(req.query.cursor));
  const snap = await q.get(), items = snap.docs.map(d => ({ username: d.data().username, active: !!d.data().active }));
  res.json({ success: true, items, cursor: snap.size === 20 ? snap.docs[19].data().createdAt : null });
}));
api.post('/referrals/milestone', h(async (req, res) => {
  const cfg = await getConfig(), id = req.tg.id, ref = userRef(id), count = +req.body?.count, m = cfg.milestones.find(x => x.count === count);
  if (!m) throw new AppErr('Invalid milestone');
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) throw new AppErr('User not found'); const u = s.data(); if (u.banned) throw new AppErr('Account banned', 403);
    if ((u.claimedMilestones || []).includes(count)) throw new AppErr('Already claimed'); if ((u.activeReferrals || 0) < count) throw new AppErr('Not enough active referrals');
    tx.update(ref, { claimedMilestones: FV.arrayUnion(count), balance: inc(m.reward), totalEarned: inc(m.reward) });
    return { ...u, claimedMilestones: [...(u.claimedMilestones || []), count], balance: (u.balance || 0) + m.reward, totalEarned: (u.totalEarned || 0) + m.reward };
  });
  statInc('distributed', m.reward); res.json({ success: true, reward: m.reward, user: pub(out) });
}));

// ---------- withdrawals ----------
api.get('/withdrawals', h(async (req, res) => {
  let q = db.collection('withdrawals').where('userId', '==', req.tg.id).orderBy('createdAt', 'desc').limit(10);
  if (req.query.cursor) q = q.startAfter(Number(req.query.cursor));
  const snap = await q.get(), items = snap.docs.map(d => { const x = d.data(); return { id: x.id, amount: x.amount, status: x.status, createdAt: x.createdAt }; });
  res.json({ success: true, items, cursor: snap.size === 10 ? snap.docs[9].data().createdAt : null });
}));

api.post('/withdraw/intent', h(async (req, res) => {
  const cfg = await getConfig(); if (!cfg.withdrawEnabled) throw new AppErr('Withdrawals are temporarily paused');
  const id = req.tg.id, amount = Math.floor(Number(req.body?.amount)), now = Date.now();
  if (!(amount >= cfg.minWithdraw)) throw new AppErr('Minimum withdrawal is ' + cfg.minWithdraw);
  const s = await userRef(id).get(); if (!s.exists) throw new AppErr('User not found'); const u = s.data();
  if (u.banned) throw new AppErr('Account banned', 403); if (!u.walletRaw) throw new AppErr('Connect your wallet first');
  if (amount > (u.balance || 0)) throw new AppErr('Insufficient balance'); if (!u.isActive) throw new AppErr('Claim mining at least once before withdrawing');
  if (now - u.createdAt < cfg.minAccountAgeHours * 3600e3) throw new AppErr(`Withdrawals unlock ${cfg.minAccountAgeHours}h after registration`);
  if ((u.pendingWd || 0) >= cfg.maxPendingWd) throw new AppErr('Too many pending withdrawals');
  const feeRequired = !u.withdrawFeePaid, ref = db.collection('intents').doc();
  const it = { userId: id, kind: 'withdraw', amount, feeRequired, amountTon: cfg.feeTon, walletRaw: u.walletRaw, comment: 'gm' + ref.id, status: 'open', createdAt: now, expiresAt: now + 600000 };
  await ref.set(it);
  res.json({ success: true, requestId: ref.id, feeRequired, address: OWNER_WALLET, amountTon: cfg.feeTon, payload: feeRequired ? commentPayload(it.comment) : undefined });
}));

api.post('/withdraw/confirm', h(async (req, res) => {
  const cfg = await getConfig(); if (!cfg.withdrawEnabled) throw new AppErr('Withdrawals are temporarily paused');
  const id = req.tg.id, iRef = db.collection('intents').doc(String(req.body?.requestId || 'x')), is = await iRef.get(), it = is.data();
  if (!it || it.userId !== id || it.kind !== 'withdraw' || it.status !== 'open' || it.expiresAt < Date.now()) throw new AppErr('Request expired. Please start again.');
  const hash = it.feeRequired ? await verifyPayment(it, String(req.body?.boc || '')) : null;
  let wd;
  const user = await db.runTransaction(async tx => {
    const uRef = userRef(id), [us, is2, ps] = await Promise.all([tx.get(uRef), tx.get(iRef), hash ? tx.get(db.doc('used_payments/' + hash)) : null]);
    if (is2.data()?.status !== 'open') throw new AppErr('Request already processed'); if (ps?.exists) throw new AppErr('Payment already used');
    const u = us.data(); if (u.banned) throw new AppErr('Account banned', 403);
    if (it.amount > (u.balance || 0)) throw new AppErr('Insufficient balance'); if ((u.pendingWd || 0) >= cfg.maxPendingWd) throw new AppErr('Too many pending withdrawals');
    const wRef = db.collection('withdrawals').doc(); wd = { id: wRef.id, userId: id, username: u.username || u.firstName, amount: it.amount, wallet: u.wallet, walletRaw: u.walletRaw, status: 'pending', createdAt: Date.now() };
    tx.set(wRef, wd); tx.update(iRef, { status: 'done' });
    if (hash) tx.set(db.doc('used_payments/' + hash), { userId: id, kind: 'withdraw-fee', at: Date.now() });
    tx.update(uRef, { balance: inc(-it.amount), pendingWd: inc(1), withdrawFeePaid: true });
    return { ...u, balance: (u.balance || 0) - it.amount, withdrawFeePaid: true };
  });
  statInc('pendingCount'); statInc('pendingAmount', wd.amount); if (hash) statInc('tonRevenue', it.amountTon);
  if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, wdCard(wd), { parse_mode: 'HTML', ...wdKb(wd.id) }).catch(() => {});
  res.json({ success: true, user: pub(user) });
}));

// ---------- boosts ----------
api.post('/boost/intent', h(async (req, res) => {
  const cfg = await getConfig(), id = req.tg.id, now = Date.now(), type = String(req.body?.type || ''), b = cfg.boosts[type]; if (!b) throw new AppErr('Invalid boost');
  const s = await userRef(id).get(); if (!s.exists) throw new AppErr('User not found'); const u = s.data();
  if (u.banned) throw new AppErr('Account banned', 403); if (!u.walletRaw) throw new AppErr('Connect your wallet first');
  if (mult(u, now) > b.mult) throw new AppErr('You already have a stronger active boost');
  const ref = db.collection('intents').doc(), it = { userId: id, kind: 'boost', type, amountTon: b.price, walletRaw: u.walletRaw, comment: 'gm' + ref.id, status: 'open', createdAt: now, expiresAt: now + 600000 };
  await ref.set(it); res.json({ success: true, requestId: ref.id, address: OWNER_WALLET, amountTon: b.price, payload: commentPayload(it.comment) });
}));
api.post('/boost/confirm', h(async (req, res) => {
  const cfg = await getConfig(), id = req.tg.id, iRef = db.collection('intents').doc(String(req.body?.requestId || 'x')), is = await iRef.get(), it = is.data();
  if (!it || it.userId !== id || it.kind !== 'boost' || it.status !== 'open' || it.expiresAt < Date.now()) throw new AppErr('Request expired. Please start again.');
  const b = cfg.boosts[it.type]; if (!b) throw new AppErr('Invalid boost');
  const hash = await verifyPayment(it, String(req.body?.boc || '')), exp = Date.now() + cfg.boostDays * 86400e3;
  const user = await db.runTransaction(async tx => {
    const uRef = userRef(id), [us, is2, ps] = await Promise.all([tx.get(uRef), tx.get(iRef), tx.get(db.doc('used_payments/' + hash))]);
    if (is2.data()?.status !== 'open') throw new AppErr('Request already processed'); if (ps.exists) throw new AppErr('Payment already used');
    tx.update(uRef, { boostMultiplier: b.mult, boostType: it.type, boostExpiresAt: exp }); tx.update(iRef, { status: 'done' });
    tx.set(db.doc('used_payments/' + hash), { userId: id, kind: 'boost', at: Date.now() });
    return { ...us.data(), boostMultiplier: b.mult, boostType: it.type, boostExpiresAt: exp };
  });
  statInc('tonRevenue', it.amountTon); res.json({ success: true, user: pub(user) });
}));

// ---------- leaderboard (served from cache, built by cron) ----------
api.get('/leaderboard', h(async (req, res) => {
  const d = await cached('lb', 300000, async () => { const s = await db.doc('leaderboard/top100').get(); return s.exists ? s.data() : { list: [] }; });
  res.json({ success: true, list: d.list, updatedAt: d.updatedAt });
}));
app.use('/api', api);

// ---------- cron (call from cron-job.org with ?key=CRON_KEY) ----------
const cron = fn => h(async (req, res) => {
  if (!CRON_KEY || !safeEq(String(req.query.key || ''), CRON_KEY)) return res.status(403).json({ success: false });
  res.json({ success: true, ...(await fn()) });
});
app.get('/cron/leaderboard', cron(async () => {
  const snap = await db.collection('users').orderBy('totalEarned', 'desc').limit(100).get();
  const list = snap.docs.filter(d => !d.data().banned).map(d => ({ username: d.data().username || d.data().firstName, totalEarned: d.data().totalEarned }));
  await db.doc('leaderboard/top100').set({ list, updatedAt: Date.now() }); bust('lb'); return { count: list.length };
}));
app.get('/cron/reminders', cron(async () => {
  const cfg = await getConfig(); if (!cfg.remindersEnabled) return { skipped: true }; const now = Date.now();
  const snap = await db.collection('users').where('remindAt', '>', now - 20 * 60000).where('remindAt', '<=', now).limit(300).get(); let n = 0;
  for (const d of snap.docs) { if (d.data().banned) continue; await bot.telegram.sendMessage(d.id, '🔥 Your mining is ready! Claim your ' + cfg.symbol + ' now.', { reply_markup: { inline_keyboard: [[{ text: '⛏️ Open App', web_app: { url: APP_URL } }]] } }).then(() => n++).catch(() => {}); await sleep(40); }
  return { sent: n };
}));
app.get('/cron/cleanup', cron(async () => {
  const snap = await db.collection('intents').where('expiresAt', '<', Date.now() - 3600e3).limit(400).get(); const b = db.batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit(); return { deleted: snap.size };
}));

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((e, req, res, next) => { console.error('EXPRESS', e.message); res.status(500).json({ success: false, error: 'Server error' }); });

// ============================================================================
// 10. LAUNCH
// ============================================================================
const server = app.listen(PORT, async () => {
  log(`Groyper Mine listening on ${PORT}`);
  try { await bot.telegram.setWebhook(APP_URL + hookPath, { secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }); log('Webhook set'); }
  catch (e) { console.error('Webhook error', e.message); }
});
process.on('unhandledRejection', e => console.error('UNHANDLED', e));
process.on('SIGTERM', async () => { log('SIGTERM'); await flushStats(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000); });
