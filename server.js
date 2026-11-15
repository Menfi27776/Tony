// ============================================================================
// GROYPER MINE - SERVER v2.1 (Secure + Beautiful Welcome + Compatible with app.js)
// ============================================================================
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');

// ============================================================================
// 1. SECRETS & ENV
// ============================================================================
const log = (...a) => console.log(new Date().toISOString(), ...a);
const readSecret = f => { try { return fs.readFileSync('/etc/secrets/' + f, 'utf8').trim(); } catch { return null; } };

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_WALLET = process.env.OWNER_WALLET;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : (() => {
    try { return String(JSON.parse(readSecret('admin-config.json')).admin_id); } catch { return null; }
})();
const TON_API_KEY = process.env.TON_API_KEY || readSecret('ton-api-key.txt') || '';

if (!BOT_TOKEN || !OWNER_WALLET || !APP_URL) {
    console.error('❌ Missing BOT_TOKEN / OWNER_WALLET / APP_URL');
    process.exit(1);
}

// ============================================================================
// 2. FIREBASE
// ============================================================================
const saKey = readSecret('firebase-admin-key.json');
if (!saKey) { console.error('❌ Missing /etc/secrets/firebase-admin-key.json'); process.exit(1); }
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saKey)) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const inc = n => FV.increment(n);
const userRef = id => db.collection('users').doc(String(id));
log('🔥 Firebase initialized');

// ============================================================================
// 3. CONFIG (overridable via Firestore settings/config)
// ============================================================================
const DEFAULTS = {
    symbol: 'GROYP',
    tokenAddress: 'EQBvcsqG7hqsw-HQ8bemIYrO8I_GLDTSbNiro4WOC7jAG_CH',
    channelUrl: 'https://t.me/GroyperMine',
    groupUrl: 'https://t.me/communityGroyper',
    dexUrl: 'https://dedust.io/swap/TON/EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    botUsername: 'GroyperMinebot',
    
    // Economy
    miningReward: 20,
    cooldownMs: 6 * 3600e3,
    adsPerBatch: 10,
    adsReward: 20,
    adsCooldownMs: 6 * 3600e3,
    adsMinGapSec: 15,
    adsRequirePostback: false,
    minWithdraw: 2000,
    feeTon: 0.1,
    minAccountAgeHours: 12,
    maxPendingWd: 3,
    referralReward: 75,
    milestones: [
        { count: 50, reward: 1000 },
        { count: 100, reward: 2500 },
        { count: 250, reward: 5000 },
        { count: 500, reward: 10000 },
        { count: 1000, reward: 25000 }
    ],
    boosts: {
        bronze: { price: 1, mult: 2, name: 'SPARK' },
        silver: { price: 2.5, mult: 5, name: 'BLAZE' },
        gold: { price: 10, mult: 12, name: 'INFERNO' }
    },
    boostDays: 30,
    checkinRewards: [5, 10, 15, 20, 30, 40, 60],
    
    // Limits
    dailyCap: 0,
    miningEnabled: true,
    withdrawEnabled: true,
    maintenance: false,
    banner: '',
    remindersEnabled: false
};

const mem = new Map();
const cached = async (key, ttl, fn) => {
    const c = mem.get(key);
    if (c && c.exp > Date.now()) return c.v;
    const v = await fn();
    mem.set(key, { v, exp: Date.now() + ttl });
    return v;
};
const bust = k => mem.delete(k);

const getConfig = () => cached('config', 60000, async () => {
    const s = await db.doc('settings/config').get();
    return { ...DEFAULTS, ...(s.exists ? s.data() : {}) };
});
const setConfig = async patch => { await db.doc('settings/config').set(patch, { merge: true }); bust('config'); };
const publicConfig = c => ({
    symbol: c.symbol, bot: c.botUsername, tokenAddress: c.tokenAddress,
    miningReward: c.miningReward, cooldownMs: c.cooldownMs,
    adsPerBatch: c.adsPerBatch, adsReward: c.adsReward, adsCooldownMs: c.adsCooldownMs,
    minWithdraw: c.minWithdraw, feeTon: c.feeTon,
    referralReward: c.referralReward,
    milestones: c.milestones,
    boosts: c.boosts,
    tokenSymbol: c.symbol
});

// ============================================================================
// 4. STATS (batched every 30s)
// ============================================================================
const pend = {};
const statInc = (k, n = 1) => { pend[k] = (pend[k] || 0) + n; };
let daily = { day: '', amount: 0, unflushed: 0 };
const dayKey = () => new Date().toISOString().slice(0, 10);

async function flushStats() {
    const keys = Object.keys(pend);
    try {
        if (keys.length) {
            const upd = {};
            for (const k of keys) { upd[k] = inc(pend[k]); delete pend[k]; }
            await db.doc('stats/global').set(upd, { merge: true });
        }
        if (daily.unflushed) {
            const n = daily.unflushed;
            daily.unflushed = 0;
            await db.doc('stats_daily/' + daily.day).set({ amount: inc(n) }, { merge: true });
        }
    } catch (e) { console.error('flushStats:', e.message); }
}
setInterval(flushStats, 30000);

async function dailyLoad() {
    const d = dayKey();
    if (daily.day === d) return;
    if (daily.unflushed) await flushStats();
    const s = await db.doc('stats_daily/' + d).get();
    daily = { day: d, amount: s.exists ? s.data().amount || 0 : 0, unflushed: 0 };
}

const capCheck = (cfg, n) => {
    if (cfg.dailyCap > 0 && daily.amount + n > cfg.dailyCap) {
        throw new AppErr('Daily distribution limit reached. Try again tomorrow.');
    }
};
const capCommit = n => { daily.amount += n; daily.unflushed += n; statInc('distributed', n); };

// ============================================================================
// 5. TASKS
// ============================================================================
const DEFAULT_TASKS = [
    { id: 'join_channel', name: 'Join Telegram Channel', url: DEFAULTS.channelUrl, reward: 50, iconClass: 'fab fa-telegram', verify: 'chat', chat: '@GroyperMine' },
    { id: 'join_group', name: 'Join Community Group', url: DEFAULTS.groupUrl, reward: 50, iconClass: 'fas fa-users', verify: 'chat', chat: '@communityGroyper' },
    { id: 'follow_x', name: 'Follow on X (Twitter)', url: 'https://x.com/GroyperMine', reward: 50, iconClass: 'fab fa-twitter', verify: 'delay', delaySec: 20 }
];

const getTasks = () => cached('tasks', 300000, async () => {
    const s = await db.doc('settings/tasks').get();
    return s.exists && Array.isArray(s.data().list) ? s.data().list : DEFAULT_TASKS;
});
const saveTasks = async list => { await db.doc('settings/tasks').set({ list }); bust('tasks'); };

// ============================================================================
// 6. PRICE (cached 60s)
// ============================================================================
let lastPrice = { usd: 0, change: 0, mcap: 0, fdv: 0, liq: 0, vol: 0 };
const getPrice = () => cached('price', 60000, async () => {
    try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${DEFAULTS.tokenAddress}`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        const p = (j.pairs || []).sort((a, b) => (+b.liquidity?.usd || 0) - (+a.liquidity?.usd || 0))[0];
        if (p) {
            lastPrice = {
                usd: +p.priceUsd || 0,
                change: +p.priceChange?.h24 || 0,
                mcap: +p.marketCap || 0,
                fdv: +p.fdv || 0,
                liq: +p.liquidity?.usd || 0,
                vol: +p.volume?.h24 || 0,
                change24h: +p.priceChange?.h24 || 0,
                price: +p.priceUsd || 0
            };
        }
    } catch (e) { log('price fetch failed:', e.message); }
    return lastPrice;
});

// ============================================================================
// 7. HELPERS
// ============================================================================
class AppErr extends Error {
    constructor(m, code = 400) { super(m); this.code = code; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const safeEq = (a, b) => {
    a = Buffer.from(String(a)); b = Buffer.from(String(b));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const h = fn => (req, res) => fn(req, res).catch(e => {
    if (e instanceof AppErr) return res.status(e.code).json({ success: false, error: e.message });
    console.error('ERR', req.method, req.path, e);
    res.status(500).json({ success: false, error: 'Server error' });
});

// ============================================================================
// 8. USER MODEL
// ============================================================================
const PUB = ['userId', 'username', 'firstName', 'wallet', 'walletRaw', 'balance',
    'totalWithdrawn', 'totalEarned', 'lastMiningClaim', 'boostMultiplier', 'boostType',
    'boostExpiresAt', 'adsCooldownUntil', 'adsWatched', 'completedTasks',
    'activeReferrals', 'inactiveReferrals', 'claimedMilestones', 'streak',
    'lastCheckinDay', 'isActive', 'withdrawFeePaid', 'createdAt'];

const pub = u => { const o = {}; for (const k of PUB) if (u[k] !== undefined) o[k] = u[k]; return o; };
const mult = (u, now = Date.now()) => (u.boostMultiplier > 1 && u.boostExpiresAt > now ? u.boostMultiplier : 1);

const newUser = tg => ({
    userId: tg.id,
    username: tg.username || '',
    firstName: tg.first_name || 'User',
    wallet: '',
    walletRaw: '',
    balance: 0, totalWithdrawn: 0, totalEarned: 0,
    lastMiningClaim: 0,
    boostMultiplier: 1, boostType: null, boostExpiresAt: 0,
    adsCooldownUntil: 0, adsWatched: 0,
    completedTasks: [],
    activeReferrals: 0, inactiveReferrals: 0,
    claimedMilestones: [],
    referredBy: null,
    isActive: false,
    withdrawFeePaid: false,
    pendingWd: 0,
    streak: 0, lastCheckinDay: 0,
    banned: false,
    createdAt: Date.now()
});

const notify = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

// ============================================================================
// 9. TELEGRAM AUTH (initData HMAC) + RATE LIMIT
// ============================================================================
function verifyInitData(raw) {
    if (!raw) return null;
    const p = new URLSearchParams(raw);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (!safeEq(crypto.createHmac('sha256', secret).update(str).digest('hex'), hash)) return null;
    const ad = +p.get('auth_date');
    if (!ad || Date.now() / 1000 - ad > 86400) return null;
    let u;
    try { u = JSON.parse(p.get('user') || 'null'); } catch { return null; }
    if (!u?.id) return null;
    return {
        id: String(u.id),
        username: u.username || '',
        first_name: u.first_name || 'User',
        lang: u.language_code,
        start: p.get('start_param') || null
    };
}

const rl = new Map();
const rate = (id, max = 90) => {
    const n = Date.now(), e = rl.get(id);
    if (!e || e.r < n) { rl.set(id, { c: 1, r: n + 60000 }); return true; }
    return ++e.c <= max;
};
setInterval(() => {
    const n = Date.now();
    for (const [k, v] of rl) if (v.r < n) rl.delete(k);
}, 60000);

async function authMw(req, res, next) {
    const hdr = req.headers.authorization || '';
    const tg = hdr.startsWith('tma ') ? verifyInitData(hdr.slice(4)) : null;
    if (!tg) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!rate(tg.id)) return res.status(429).json({ success: false, error: 'Too many requests' });
    req.tg = tg;
    try {
        const c = await getConfig();
        if (c.maintenance && tg.id !== ADMIN_ID) {
            return res.status(503).json({ success: false, error: 'Maintenance' });
        }
    } catch {}
    next();
}

// ============================================================================
// 10. TON PAYMENT VERIFICATION
// ============================================================================
async function tonGet(p) {
    const r = await fetch('https://tonapi.io/v2' + p, {
        headers: TON_API_KEY ? { Authorization: 'Bearer ' + TON_API_KEY } : {},
        signal: AbortSignal.timeout(10000)
    });
    return { status: r.status, json: await r.json().catch(() => null) };
}

const sha256 = b => crypto.createHash('sha256').update(b).digest();

async function verifyPayment(it, boc) {
    let hash;
    try {
        // Hash BOC via tonapi (avoids needing @ton/core locally)
        const r = await fetch('https://tonapi.io/v2/blockchain/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(TON_API_KEY ? { Authorization: 'Bearer ' + TON_API_KEY } : {}) },
            body: JSON.stringify({ boc })
        });
        const d = await r.json();
        if (!d.hash) throw new Error('invalid_boc');
        hash = d.hash;
    } catch { throw new AppErr('Invalid transaction'); }

    let tx = null;
    for (let i = 0; i < 6 && !tx; i++) {
        const r = await tonGet(`/blockchain/transactions/${hash}`).catch(() => ({}));
        if (r.status === 200 && r.json?.hash) tx = r.json;
        else await sleep(4000);
    }
    if (!tx) throw new AppErr('Transaction not confirmed yet. Please try again in a moment.');
    if (tx.success === false || tx.aborted) throw new AppErr('Transaction failed');
    if ((tx.utime || 0) * 1000 < it.createdAt - 60000) throw new AppErr('Transaction is older than request');
    if (!tx.in_msg) throw new AppErr('No payment message found');

    const value = parseFloat(tx.in_msg.value || 0) / 1e9;
    const dest = (tx.in_msg.destination?.address || '').toString();

    if (value + 1e-6 < it.amountTon * 0.98) {
        throw new AppErr(`Amount mismatch: paid ${value.toFixed(4)} TON, expected ${it.amountTon} TON`);
    }
    if (dest && dest.toLowerCase() !== OWNER_WALLET.toLowerCase()) {
        throw new AppErr('Payment destination mismatch');
    }
    return hash;
}

// ============================================================================
// 11. BOT
// ============================================================================
const bot = new Telegraf(BOT_TOKEN);
bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

// ====================== BEAUTIFUL WELCOME ======================
bot.start(async (ctx) => {
    try {
        const cfg = await getConfig();
        const uid = String(ctx.from.id);
        const name = ctx.from.first_name || 'Miner';
        const startParam = ctx.startPayload;

        // Create user if not exists
        let user = await userRef(uid).get();
        if (!user.exists) {
            await userRef(uid).set(newUser(ctx.from));
            statInc('users');
        }

        // Referral tracking
        if (startParam && startParam !== uid && /^\d{5,15}$/.test(startParam)) {
            const refSnap = await userRef(startParam).get();
            if (refSnap.exists) {
                const refsSnap = await userRef(startParam).collection('referrals').doc(uid).get();
                if (!refsSnap.exists) {
                    await userRef(startParam).collection('referrals').doc(uid).set({
                        username: ctx.from.username || ctx.from.first_name,
                        active: false,
                        createdAt: Date.now()
                    });
                    await userRef(startParam).update({ inactiveReferrals: inc(1) });
                }
            }
        }

        const welcome = `
🔥 <b>Welcome to Groyper Mine, ${esc(name)}!</b> 🔥

The <b>#1 Mining App</b> for <b>$${cfg.symbol}</b> on TON Blockchain.

💰 <b>How It Works:</b>
├ ⛏️ <b>Mining:</b> Claim <b>${cfg.miningReward} $${cfg.symbol}</b> every 6 hours.
├ 🎬 <b>Ads:</b> Watch 10 ads → earn <b>${cfg.adsReward} $${cfg.symbol}</b>.
├ ✅ <b>Tasks:</b> Complete simple tasks for <b>50 $${cfg.symbol}</b> each.
└ 👥 <b>Referrals:</b> Earn <b>${cfg.referralReward} $${cfg.symbol}</b> per active friend.

📊 <b>Token Info:</b>
The <b>$${cfg.symbol}</b> token is <b>live & tradable</b> on multiple DEXs (DeDust, STON.fi, etc.).

🎁 <b>Daily Check-in:</b> Up to <b>${cfg.checkinRewards[cfg.checkinRewards.length - 1]} $${cfg.symbol}</b> streak bonus!

🚀 <b>Start mining now:</b>
        `;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.webApp('⛏️ Launch App', APP_URL)],
            [
                Markup.button.url('📢 Channel', cfg.channelUrl),
                Markup.button.url('💬 Community', cfg.groupUrl)
            ],
            [Markup.button.url('💱 Trade on DeDust', cfg.dexUrl)]
        ]);

        await ctx.replyWithHTML(welcome, keyboard);
    } catch (e) {
        console.error('Start error:', e);
        await ctx.reply('⚠️ Something went wrong. Please try again.');
    }
});

// ====================== ADMIN PANEL ======================
const isAdmin = ctx => String(ctx.from?.id) === ADMIN_ID;
const sessions = new Map();

async function panel() {
    const c = await getConfig();
    const s = (await db.doc('stats/global').get()).data() || {};
    const t = (k, l) => Markup.button.callback(`${c[k] ? '🟢' : '🔴'} ${l}`, 'a:tg:' + k);
    
    return {
        text: `👑 <b>Admin Panel</b>\n\n` +
            `👥 Users: <b>${(s.users || 0).toLocaleString()}</b>\n` +
            `⛏ Claims: <b>${(s.claims || 0).toLocaleString()}</b>\n` +
            `💰 Distributed: <b>${(s.distributed || 0).toLocaleString()}</b>\n` +
            `⏳ Pending: <b>${(s.pendingCount || 0).toLocaleString()}</b>\n` +
            `📤 Paid out: <b>${(s.withdrawnTotal || 0).toLocaleString()}</b>\n` +
            `💎 TON revenue: <b>${(s.tonRevenue || 0).toFixed(2)}</b>\n\n` +
            `🟢 = ON. Maintenance blocks the app.`,
        kb: Markup.inlineKeyboard([
            [Markup.button.callback('📋 Pending withdrawals', 'a:wd')],
            [Markup.button.callback('📝 Tasks', 'a:tasks'), Markup.button.callback('📢 Broadcast', 'a:bc')],
            [t('miningEnabled', 'Mining'), t('withdrawEnabled', 'Withdraw')],
            [t('maintenance', 'Maintenance'), t('remindersEnabled', 'Reminders')],
            [Markup.button.callback('🔄 Refresh', 'a:home')]
        ])
    };
}

bot.command('admin', async ctx => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Access Denied');
    const p = await panel();
    ctx.replyWithHTML(p.text, p.kb);
});

bot.command('cancel', ctx => {
    if (isAdmin(ctx)) { sessions.delete(ADMIN_ID); ctx.reply('Cancelled.'); }
});

bot.command('set', async ctx => {
    if (!isAdmin(ctx)) return;
    const [, k, v] = ctx.message.text.split(/\s+/);
    const keys = ['miningReward', 'adsReward', 'referralReward', 'minWithdraw', 'feeTon',
        'minAccountAgeHours', 'maxPendingWd', 'dailyCap', 'adsMinGapSec', 'boostDays'];
    if (!keys.includes(k) || isNaN(+v)) return ctx.reply('Usage: /set <key> <number>\nKeys: ' + keys.join(', '));
    await setConfig({ [k]: +v });
    ctx.reply(`✅ ${k} = ${+v}`);
});

bot.command('banner', async ctx => {
    if (!isAdmin(ctx)) return;
    const t = ctx.message.text.replace(/^\/banner\s*/, '');
    await setConfig({ banner: t });
    ctx.reply(t ? '✅ Banner set' : '✅ Banner cleared');
});

bot.command('user', async ctx => {
    if (!isAdmin(ctx)) return;
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('/user <id>');
    const s = await userRef(id).get();
    if (!s.exists) return ctx.reply('Not found');
    const u = s.data();
    ctx.replyWithHTML(
        `<b>@${esc(u.username || '')}</b> (${u.userId})\n` +
        `Balance: ${(u.balance || 0).toLocaleString()}\n` +
        `Earned: ${(u.totalEarned || 0).toLocaleString()}\n` +
        `Withdrawn: ${(u.totalWithdrawn || 0).toLocaleString()}\n` +
        `Boost: ${u.boostType || '-'}\n` +
        `Active refs: ${u.activeReferrals || 0} / Inactive: ${u.inactiveReferrals || 0}\n` +
        `Banned: ${u.banned}\n` +
        `Wallet: <code>${u.wallet || '-'}</code>`
    );
});

// ====================== ADMIN ACTIONS ======================
bot.action(/^a:(\w+)(?::(.+))?$/, async ctx => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
    const [, act, arg] = ctx.match;
    await ctx.answerCbQuery().catch(() => {});
    
    try {
        if (act === 'home') {
            const p = await panel();
            return ctx.editMessageText(p.text, { parse_mode: 'HTML', ...p.kb }).catch(() => {});
        }
        if (act === 'tg') {
            const c = await getConfig();
            await setConfig({ [arg]: !c[arg] });
            const p = await panel();
            return ctx.editMessageText(p.text, { parse_mode: 'HTML', ...p.kb }).catch(() => {});
        }
        if (act === 'wd') {
            const snap = await db.collection('withdrawals').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(5).get();
            if (snap.empty) return ctx.reply('✅ No pending withdrawals');
            for (const d of snap.docs) {
                const w = d.data();
                await ctx.replyWithHTML(
                    `💸 <b>${w.amount.toLocaleString()} $GROYP</b>\n👤 @${esc(w.username || '')}\n💳 <code>${w.wallet || w.walletAddress}</code>`,
                    Markup.inlineKeyboard([[
                        Markup.button.callback('✅ Approve', 'a:wp:' + d.id),
                        Markup.button.callback('❌ Reject', 'a:wr:' + d.id)
                    ]])
                );
            }
            return;
        }
        if (act === 'wp' || act === 'wr') {
            const status = act === 'wp' ? 'paid' : 'rejected';
            const d = await db.runTransaction(async tx => {
                const wr = db.collection('withdrawals').doc(arg);
                const w = await tx.get(wr);
                if (!w.exists) throw new Error('Not found');
                const x = w.data();
                if (x.status !== 'pending') throw new Error('Already ' + x.status);
                tx.update(wr, { status, settledAt: Date.now() });
                if (status === 'paid') {
                    tx.set(userRef(x.userId), { totalWithdrawn: inc(x.amount), pendingWd: inc(-1) }, { merge: true });
                } else {
                    tx.set(userRef(x.userId), { balance: inc(x.amount), pendingWd: inc(-1) }, { merge: true });
                }
                return x;
            });
            statInc('pendingCount', -1);
            statInc('pendingAmount', -d.amount);
            if (status === 'paid') statInc('withdrawnTotal', d.amount);
            notify(d.userId, status === 'paid'
                ? `✅ Your withdrawal of <b>${d.amount}</b> has been sent!`
                : `❌ Your withdrawal of <b>${d.amount}</b> was rejected. Funds returned.`);
            return ctx.reply(`✅ ${status.toUpperCase()}`);
        }
        if (act === 'tasks') {
            const tasks = await getTasks();
            const txt = '📝 <b>Tasks</b>\n\n' + tasks.map((t, i) =>
                `${i + 1}. <b>${esc(t.name)}</b> (+${t.reward}) [${t.verify}]\n${esc(t.url)}`
            ).join('\n\n');
            return ctx.replyWithHTML(txt, Markup.inlineKeyboard([
                [Markup.button.callback('➕ Add', 'a:ta')],
                ...tasks.map(t => [Markup.button.callback('🗑 ' + t.name.slice(0, 30), 'a:td:' + t.id)])
            ]));
        }
        if (act === 'td') {
            const l = (await getTasks()).filter(t => t.id !== arg);
            await saveTasks(l);
            return ctx.reply('✅ Deleted');
        }
        if (act === 'ta') {
            sessions.set(ADMIN_ID, { step: 'tname' });
            return ctx.reply('Task name? (/cancel to abort)');
        }
        if (act === 'tv') {
            const s = sessions.get(ADMIN_ID);
            if (!s) return;
            if (arg === 'chat') {
                s.verify = 'chat';
                s.step = 'tchat';
                return ctx.reply('Send the channel/group @username:');
            }
            s.verify = 'delay';
            return finishTask(ctx, s);
        }
        if (act === 'bc') {
            sessions.set(ADMIN_ID, { step: 'bc' });
            return ctx.reply('📢 Send the broadcast text. /cancel to abort.');
        }
    } catch (e) {
        ctx.reply('⚠️ ' + (e.message || 'Error'));
    }
});

async function finishTask(ctx, s) {
    const tasks = await getTasks();
    tasks.push({
        id: 't' + Date.now(),
        name: s.name,
        url: s.url,
        reward: s.reward,
        verify: s.verify,
        chat: s.chat || null,
        delaySec: 20,
        iconClass: /t\.me/.test(s.url) ? 'fab fa-telegram' : /x\.com|twitter/.test(s.url) ? 'fab fa-twitter' : 'fas fa-link'
    });
    await saveTasks(tasks);
    sessions.delete(ADMIN_ID);
    ctx.reply(`✅ Task "${s.name}" added (${s.verify}).`);
}

async function broadcast(text) {
    let sent = 0, failed = 0, last = null;
    for (;;) {
        let q = db.collection('users').orderBy('__name__').limit(300);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
            try { await bot.telegram.sendMessage(d.id, '📢 ' + text, { parse_mode: 'HTML' }); sent++; }
            catch { failed++; }
            await sleep(45);
        }
        last = snap.docs[snap.docs.length - 1];
    }
    notify(ADMIN_ID, `✅ Broadcast done: ${sent} sent, ${failed} failed.`);
}

bot.on('text', async ctx => {
    if (!isAdmin(ctx)) return;
    const s = sessions.get(ADMIN_ID);
    if (!s) return;
    const t = ctx.message.text;
    if (s.step === 'tname') { s.name = t.slice(0, 60); s.step = 'turl'; return ctx.reply('Task URL (https://...):'); }
    if (s.step === 'turl') {
        if (!/^https:\/\//.test(t)) return ctx.reply('❌ Must start with https://');
        s.url = t; s.step = 'treward';
        return ctx.reply('Reward amount (number):');
    }
    if (s.step === 'treward') {
        const n = parseInt(t);
        if (!(n > 0)) return ctx.reply('❌ Invalid number');
        s.reward = n; s.step = 'tverify';
        return ctx.reply('Verification type?', Markup.inlineKeyboard([
            [Markup.button.callback('Channel/Group member', 'a:tv:chat')],
            [Markup.button.callback('Link (time delay)', 'a:tv:delay')]
        ]));
    }
    if (s.step === 'tchat') {
        if (!/^@\w{4,}$/.test(t)) return ctx.reply('❌ Send like @mychannel');
        s.chat = t;
        return finishTask(ctx, s);
    }
    if (s.step === 'bc') {
        sessions.delete(ADMIN_ID);
        ctx.reply('⏳ Broadcasting in background...');
        broadcast(t).catch(e => notify(ADMIN_ID, 'Broadcast error: ' + e.message));
    }
});

bot.catch((e, ctx) => console.error('BOT ERR', ctx?.updateType, e.message));

// ============================================================================
// 12. EXPRESS APP
// ============================================================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
app.use(cors({ origin: APP_URL }));
app.use(express.json({ limit: '100kb' }));

// ---- Static files (with cache headers) ----
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
app.get(Object.keys(FILES), (req, res) => {
    res.set('Cache-Control', req.path === '/' || req.path === '/index.html' ? 'no-cache' : 'public, max-age=300');
    res.sendFile(path.join(__dirname, FILES[req.path]));
});

app.get('/health', (_, res) => res.send('ok'));

// ---- TonConnect manifest ----
app.get('/tonconnect-manifest.json', (_, res) => res.json({
    url: APP_URL,
    name: 'Groyper Mine',
    iconUrl: 'https://assets.coingecko.com/coins/images/102172192/standard/Untitled_design__12_-removebg-preview.png',
    termsOfUseUrl: APP_URL + '/terms',
    privacyPolicyUrl: APP_URL + '/privacy'
}));

app.get('/terms', (_, res) => res.send('<h1>Terms</h1><p>Groyper Mine rewards are community incentives, not an investment offer. No guarantee of value. Abuse, bots or multi-accounting may lead to a ban.</p>'));
app.get('/privacy', (_, res) => res.send('<h1>Privacy</h1><p>We store your Telegram ID, username, wallet address and in-app activity to run the service. We never access your wallet keys.</p>'));

// ============================================================================
// 13. API ROUTES
// ============================================================================
const api = express.Router();
api.use(authMw);

// ---- Init (1 read on open) ----
api.get('/init', h(async (req, res) => {
    const [cfg, tasks, price, snap] = await Promise.all([
        getConfig(), getTasks(), getPrice(), userRef(req.tg.id).get()
    ]);
    const u = snap.exists ? snap.data() : null;
    if (u?.banned) throw new AppErr('Account banned', 403);
    res.json({
        success: true,
        user: u ? pub(u) : null,
        tasks,
        config: publicConfig(cfg),
        price,
        serverTime: Date.now(),
        banner: cfg.banner || ''
    });
}));

api.get('/price', h(async (req, res) => res.json({ success: true, price: await getPrice() })));

// ---- Register (simple wallet link — NO ton_proof for now, matches app.js) ----
api.post('/register', h(async (req, res) => {
    const tg = req.tg;
    const { wallet, startParam } = req.body || {};
    if (!wallet || typeof wallet !== 'string' || wallet.length < 10) {
        throw new AppErr('Invalid wallet address');
    }
    
    const uRef = userRef(tg.id);
    let created = false;
    const user = await db.runTransaction(async tx => {
        const us = await tx.get(uRef);
        if (us.exists) {
            const u = us.data();
            if (u.banned) throw new AppErr('Account banned', 403);
            if (!u.wallet) {
                tx.update(uRef, { wallet });
                return { ...u, wallet };
            }
            return u;
        }
        
        // New user
        const u = { ...newUser(tg), wallet };
        if (startParam && startParam !== tg.id && /^\d{5,15}$/.test(startParam)) {
            const refSnap = await tx.get(userRef(startParam));
            if (refSnap.exists) {
                u.referredBy = startParam;
                tx.set(userRef(startParam).collection('referrals').doc(tg.id), {
                    username: tg.username || tg.first_name,
                    active: false,
                    createdAt: Date.now()
                });
                tx.set(userRef(startParam), { inactiveReferrals: inc(1) }, { merge: true });
            }
        }
        tx.set(uRef, u);
        created = true;
        return u;
    });
    
    if (created) statInc('users');
    res.json({ success: true, user: pub(user) });
}));

// ---- Mining claim (transaction, live) ----
api.post('/mining/claim', h(async (req, res) => {
    const cfg = await getConfig();
    if (!cfg.miningEnabled) throw new AppErr('Mining is temporarily paused');
    await dailyLoad();
    const id = req.tg.id;
    const ref = userRef(id);
    const nowMs = Date.now();
    let refInfo = null;
    
    const out = await db.runTransaction(async tx => {
        refInfo = null;
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if (nowMs - (u.lastMiningClaim || 0) < cfg.cooldownMs - 3000) throw new AppErr('Not ready yet');
        
        const reward = cfg.miningReward * mult(u, nowMs);
        capCheck(cfg, reward);
        
        tx.update(ref, {
            balance: inc(reward),
            totalEarned: inc(reward),
            lastMiningClaim: nowMs,
            isActive: true
        });
        
        if (!u.isActive && u.referredBy) {
            const rr = userRef(u.referredBy);
            tx.set(rr, {
                activeReferrals: inc(1),
                inactiveReferrals: inc(-1),
                balance: inc(cfg.referralReward),
                totalEarned: inc(cfg.referralReward)
            }, { merge: true });
            tx.set(rr.collection('referrals').doc(id), { active: true }, { merge: true });
            refInfo = { to: u.referredBy, name: u.username || u.firstName };
        }
        return {
            reward,
            user: {
                ...u,
                balance: (u.balance || 0) + reward,
                totalEarned: (u.totalEarned || 0) + reward,
                lastMiningClaim: nowMs,
                isActive: true
            }
        };
    });
    
    capCommit(out.reward);
    statInc('claims');
    if (refInfo) {
        capCommit(cfg.referralReward);
        notify(refInfo.to, `🎉 +${cfg.referralReward} ${cfg.symbol} — your friend @${esc(refInfo.name)} is now active!`);
    }
    res.json({ success: true, reward: out.reward, user: pub(out.user) });
}));

// ---- Ads (stateful in DB, works with app.js token logic) ----
api.post('/ads/start', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const nowMs = Date.now();
    
    const s = await userRef(id).get();
    if (!s.exists) throw new AppErr('User not found');
    const u = s.data();
    if (u.banned) throw new AppErr('Account banned', 403);
    
    const watched = u.adsWatched || 0;
    const cooldownUntil = u.adsCooldownUntil || 0;
    
    if (nowMs < cooldownUntil) throw new AppErr('Ads are on cooldown');
    if (watched >= cfg.adsPerBatch) throw new AppErr('Batch complete. Claim your reward first.');
    
    // Simple ymid (stored in DB for reliability)
    const ymid = crypto.randomBytes(16).toString('hex');
    await db.collection('ads_pending').doc(ymid).set({
        userId: id,
        createdAt: nowMs,
        completed: false
    });
    setTimeout(() => db.collection('ads_pending').doc(ymid).delete().catch(() => {}), 600000);
    
    res.json({ success: true, ymid, token: ymid });
}));

api.post('/ads/watch', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const nowMs = Date.now();
    const { ymid } = req.body || {};
    if (!ymid || typeof ymid !== 'string') throw new AppErr('Missing ymid');
    
    const ref = db.collection('ads_pending').doc(ymid);
    const snap = await ref.get();
    if (!snap.exists) throw new AppErr('Invalid ad session');
    const p = snap.data();
    if (p.userId !== id) throw new AppErr('Wrong user');
    if (p.completed) throw new AppErr('Already used');
    
    const age = nowMs - p.createdAt;
    if (age > 600000) throw new AppErr('Ad session expired');
    if (age < cfg.adsMinGapSec * 1000) throw new AppErr('Ad was not completed');
    
    const s = await userRef(id).get();
    if (!s.exists) throw new AppErr('User not found');
    const u = s.data();
    if (nowMs < (u.adsCooldownUntil || 0)) throw new AppErr('Ads are on cooldown');
    if ((u.adsWatched || 0) >= cfg.adsPerBatch) throw new AppErr('Batch complete');
    
    await ref.update({ completed: true });
    await userRef(id).update({ adsWatched: inc(1) });
    const fresh = await userRef(id).get();
    
    res.json({ success: true, watched: fresh.data().adsWatched, token: ymid });
}));

api.post('/ads/claim', h(async (req, res) => {
    const cfg = await getConfig();
    await dailyLoad();
    const id = req.tg.id;
    const ref = userRef(id);
    const nowMs = Date.now();
    
    const out = await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if ((u.adsWatched || 0) < cfg.adsPerBatch) throw new AppErr('Watch all ads first');
        
        capCheck(cfg, cfg.adsReward);
        const until = nowMs + cfg.adsCooldownMs;
        tx.update(ref, {
            balance: inc(cfg.adsReward),
            totalEarned: inc(cfg.adsReward),
            adsWatched: 0,
            adsCooldownUntil: until
        });
        return {
            ...u,
            balance: (u.balance || 0) + cfg.adsReward,
            totalEarned: (u.totalEarned || 0) + cfg.adsReward,
            adsWatched: 0,
            adsCooldownUntil: until
        };
    });
    
    capCommit(cfg.adsReward);
    res.json({ success: true, reward: cfg.adsReward, user: pub(out) });
}));

// ---- Check-in ----
api.post('/checkin', h(async (req, res) => {
    const cfg = await getConfig();
    await dailyLoad();
    const id = req.tg.id;
    const ref = userRef(id);
    const day = Math.floor(Date.now() / 86400e3);
    
    const out = await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if (u.lastCheckinDay === day) throw new AppErr('Already checked in today');
        
        const streak = u.lastCheckinDay === day - 1 ? (u.streak || 0) + 1 : 1;
        const reward = cfg.checkinRewards[(streak - 1) % cfg.checkinRewards.length];
        capCheck(cfg, reward);
        tx.update(ref, {
            balance: inc(reward),
            totalEarned: inc(reward),
            streak,
            lastCheckinDay: day
        });
        return {
            reward,
            user: {
                ...u,
                balance: (u.balance || 0) + reward,
                totalEarned: (u.totalEarned || 0) + reward,
                streak,
                lastCheckinDay: day
            }
        };
    });
    
    capCommit(out.reward);
    res.json({ success: true, reward: out.reward, user: pub(out.user) });
}));

// ---- Tasks ----
api.post('/tasks/verify', h(async (req, res) => {
    const cfg = await getConfig();
    await dailyLoad();
    const id = req.tg.id;
    const taskId = String(req.body?.taskId || '');
    const task = (await getTasks()).find(t => t.id === taskId);
    if (!task) throw new AppErr('Task not found');
    
    if (task.verify === 'chat') {
        let ok = false;
        try {
            const m = await bot.telegram.getChatMember(task.chat, +id);
            ok = ['member', 'administrator', 'creator'].includes(m.status) ||
                 (m.status === 'restricted' && m.is_member);
        } catch (e) { log('getChatMember:', e.message); }
        if (!ok) throw new AppErr('Please join first, then press Verify');
    } else {
        // For delay tasks, give immediate reward (app.js doesn't implement timer)
        // The 20s delay is enforced client-side
    }
    
    const ref = userRef(id);
    const out = await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if ((u.completedTasks || []).includes(taskId)) throw new AppErr('Already completed');
        capCheck(cfg, task.reward);
        
        tx.update(ref, {
            completedTasks: FV.arrayUnion(taskId),
            balance: inc(task.reward),
            totalEarned: inc(task.reward)
        });
        return {
            ...u,
            completedTasks: [...(u.completedTasks || []), taskId],
            balance: (u.balance || 0) + task.reward,
            totalEarned: (u.totalEarned || 0) + task.reward
        };
    });
    
    capCommit(task.reward);
    res.json({ success: true, reward: task.reward, user: pub(out) });
}));

// ---- Referrals ----
api.get('/referrals', h(async (req, res) => {
    let q = userRef(req.tg.id).collection('referrals').orderBy('createdAt', 'desc').limit(20);
    if (req.query.cursor) q = q.startAfter(Number(req.query.cursor));
    const snap = await q.get();
    const items = snap.docs.map(d => ({
        username: d.data().username,
        active: !!d.data().active
    }));
    res.json({ success: true, items, cursor: snap.size === 20 ? snap.docs[19].data().createdAt : null });
}));

api.post('/referrals/milestone', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const ref = userRef(id);
    const count = +req.body?.count;
    const m = cfg.milestones.find(x => x.count === count);
    if (!m) throw new AppErr('Invalid milestone');
    
    const out = await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if ((u.claimedMilestones || []).includes(count)) throw new AppErr('Already claimed');
        if ((u.activeReferrals || 0) < count) throw new AppErr('Not enough active referrals');
        
        tx.update(ref, {
            claimedMilestones: FV.arrayUnion(count),
            balance: inc(m.reward),
            totalEarned: inc(m.reward)
        });
        return {
            ...u,
            claimedMilestones: [...(u.claimedMilestones || []), count],
            balance: (u.balance || 0) + m.reward,
            totalEarned: (u.totalEarned || 0) + m.reward
        };
    });
    
    statInc('distributed', m.reward);
    res.json({ success: true, reward: m.reward, user: pub(out) });
}));

// ---- Withdrawals ----
api.get('/withdrawals', h(async (req, res) => {
    let q = db.collection('withdrawals')
        .where('userId', '==', req.tg.id)
        .orderBy('createdAt', 'desc')
        .limit(10);
    if (req.query.cursor) q = q.startAfter(Number(req.query.cursor));
    const snap = await q.get();
    const items = snap.docs.map(d => {
        const x = d.data();
        return { id: x.id || d.id, amount: x.amount, status: x.status, createdAt: x.createdAt };
    });
    res.json({ success: true, items, cursor: snap.size === 10 ? snap.docs[9].data().createdAt : null });
}));

api.post('/withdraw/intent', h(async (req, res) => {
    const cfg = await getConfig();
    if (!cfg.withdrawEnabled) throw new AppErr('Withdrawals are temporarily paused');
    
    const id = req.tg.id;
    const amount = Math.floor(Number(req.body?.amount));
    const nowMs = Date.now();
    
    if (!(amount >= cfg.minWithdraw)) throw new AppErr('Minimum withdrawal is ' + cfg.minWithdraw);
    
    const s = await userRef(id).get();
    if (!s.exists) throw new AppErr('User not found');
    const u = s.data();
    if (u.banned) throw new AppErr('Account banned', 403);
    if (!u.wallet) throw new AppErr('Connect your wallet first');
    if (amount > (u.balance || 0)) throw new AppErr('Insufficient balance');
    if (!u.isActive) throw new AppErr('Claim mining at least once before withdrawing');
    if (nowMs - (u.createdAt || 0) < cfg.minAccountAgeHours * 3600e3) {
        throw new AppErr(`Withdrawals unlock ${cfg.minAccountAgeHours}h after registration`);
    }
    if ((u.pendingWd || 0) >= cfg.maxPendingWd) throw new AppErr('Too many pending withdrawals');
    
    const feeRequired = !u.withdrawFeePaid;
    const ref = db.collection('intents').doc();
    const it = {
        userId: id,
        kind: 'withdraw',
        amount,
        feeRequired,
        amountTon: cfg.feeTon,
        wallet: u.wallet,
        status: 'open',
        createdAt: nowMs,
        expiresAt: nowMs + 600000
    };
    await ref.set(it);
    
    res.json({
        success: true,
        requestId: ref.id,
        feeRequired,
        address: OWNER_WALLET,
        amountTon: cfg.feeTon,
        payload: feeRequired ? Buffer.from('gm' + ref.id).toString('base64') : undefined
    });
}));

api.post('/withdraw/confirm', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const iRef = db.collection('intents').doc(String(req.body?.requestId || 'x'));
    const is = await iRef.get();
    const it = is.data();
    if (!it || it.userId !== id || it.kind !== 'withdraw' || it.status !== 'open' || it.expiresAt < Date.now()) {
        throw new AppErr('Request expired. Please start again.');
    }
    
    let hash = null;
    if (it.feeRequired) {
        hash = await verifyPayment(it, String(req.body?.boc || ''));
    }
    
    const user = await db.runTransaction(async tx => {
        const uRef = userRef(id);
        const [us, is2, ps] = await Promise.all([
            tx.get(uRef),
            tx.get(iRef),
            hash ? tx.get(db.doc('used_payments/' + hash)) : null
        ]);
        if (is2.data()?.status !== 'open') throw new AppErr('Request already processed');
        if (ps?.exists) throw new AppErr('Payment already used');
        
        const u = us.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if (it.amount > (u.balance || 0)) throw new AppErr('Insufficient balance');
        if ((u.pendingWd || 0) >= cfg.maxPendingWd) throw new AppErr('Too many pending withdrawals');
        
        const wRef = db.collection('withdrawals').doc();
        tx.set(wRef, {
            id: wRef.id,
            userId: id,
            username: u.username || u.firstName,
            amount: it.amount,
            wallet: u.wallet,
            status: 'pending',
            createdAt: Date.now()
        });
        tx.update(iRef, { status: 'done' });
        if (hash) tx.set(db.doc('used_payments/' + hash), { userId: id, kind: 'withdraw-fee', at: Date.now() });
        tx.update(uRef, {
            balance: inc(-it.amount),
            pendingWd: inc(1),
            withdrawFeePaid: true
        });
        return { ...u, balance: (u.balance || 0) - it.amount, withdrawFeePaid: true };
    });
    
    statInc('pendingCount');
    statInc('pendingAmount', it.amount);
    if (hash) statInc('tonRevenue', it.amountTon);
    
    if (ADMIN_ID) {
        const w = (await db.collection('withdrawals').where('userId', '==', id).orderBy('createdAt', 'desc').limit(1).get()).docs[0]?.data();
        if (w) {
            bot.telegram.sendMessage(ADMIN_ID,
                `💸 <b>Withdrawal</b>\n\n👤 @${esc(user.username || '')}\n💰 ${it.amount.toLocaleString()} ${cfg.symbol}\n💳 <code>${user.wallet}</code>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([[
                        Markup.button.callback('✅ Approve', 'a:wp:' + w.id),
                        Markup.button.callback('❌ Reject', 'a:wr:' + w.id)
                    ]]).reply_markup
                }
            ).catch(() => {});
        }
    }
    
    res.json({ success: true, user: pub(user) });
}));

// ---- Boosts ----
api.post('/boost/intent', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const nowMs = Date.now();
    const type = String(req.body?.type || '');
    const b = cfg.boosts[type];
    if (!b) throw new AppErr('Invalid boost');
    
    const s = await userRef(id).get();
    if (!s.exists) throw new AppErr('User not found');
    const u = s.data();
    if (u.banned) throw new AppErr('Account banned', 403);
    if (!u.wallet) throw new AppErr('Connect your wallet first');
    if (mult(u, nowMs) > b.mult) throw new AppErr('You already have a stronger active boost');
    
    const ref = db.collection('intents').doc();
    await ref.set({
        userId: id,
        kind: 'boost',
        type,
        amountTon: b.price,
        wallet: u.wallet,
        status: 'open',
        createdAt: nowMs,
        expiresAt: nowMs + 600000
    });
    
    res.json({
        success: true,
        requestId: ref.id,
        address: OWNER_WALLET,
        amountTon: b.price,
        payload: Buffer.from('gm' + ref.id).toString('base64')
    });
}));

api.post('/boost/confirm', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const iRef = db.collection('intents').doc(String(req.body?.requestId || 'x'));
    const is = await iRef.get();
    const it = is.data();
    if (!it || it.userId !== id || it.kind !== 'boost' || it.status !== 'open' || it.expiresAt < Date.now()) {
        throw new AppErr('Request expired. Please start again.');
    }
    
    const b = cfg.boosts[it.type];
    if (!b) throw new AppErr('Invalid boost');
    const hash = await verifyPayment(it, String(req.body?.boc || ''));
    const exp = Date.now() + cfg.boostDays * 86400e3;
    
    const user = await db.runTransaction(async tx => {
        const uRef = userRef(id);
        const [us, is2, ps] = await Promise.all([
            tx.get(uRef),
            tx.get(iRef),
            tx.get(db.doc('used_payments/' + hash))
        ]);
        if (is2.data()?.status !== 'open') throw new AppErr('Request already processed');
        if (ps.exists) throw new AppErr('Payment already used');
        
        tx.update(uRef, {
            boostMultiplier: b.mult,
            boostType: it.type,
            boostExpiresAt: exp
        });
        tx.update(iRef, { status: 'done' });
        tx.set(db.doc('used_payments/' + hash), { userId: id, kind: 'boost', at: Date.now() });
        return { ...us.data(), boostMultiplier: b.mult, boostType: it.type, boostExpiresAt: exp };
    });
    
    statInc('tonRevenue', it.amountTon);
    res.json({ success: true, user: pub(user) });
}));

// ---- Leaderboard (cached, built by cron) ----
api.get('/leaderboard', h(async (req, res) => {
    const d = await cached('lb', 300000, async () => {
        const s = await db.doc('leaderboard/top100').get();
        return s.exists ? s.data() : { list: [] };
    });
    res.json({ success: true, list: d.list, updatedAt: d.updatedAt });
}));

app.use('/api', api);

// ============================================================================
// 14. CRON ENDPOINTS
// ============================================================================
const CRON_KEY = process.env.CRON_KEY || '';
const cron = fn => h(async (req, res) => {
    if (!CRON_KEY || !safeEq(String(req.query.key || ''), CRON_KEY)) {
        return res.status(403).json({ success: false });
    }
    res.json({ success: true, ...(await fn()) });
});

app.get('/cron/leaderboard', cron(async () => {
    const snap = await db.collection('users').orderBy('totalEarned', 'desc').limit(100).get();
    const list = snap.docs.filter(d => !d.data().banned).map(d => ({
        username: d.data().username || d.data().firstName,
        totalEarned: d.data().totalEarned
    }));
    await db.doc('leaderboard/top100').set({ list, updatedAt: Date.now() });
    bust('lb');
    return { count: list.length };
}));

app.get('/cron/cleanup', cron(async () => {
    const snap = await db.collection('intents').where('expiresAt', '<', Date.now() - 3600e3).limit(400).get();
    const b = db.batch();
    snap.docs.forEach(d => b.delete(d.ref));
    await b.commit();
    return { deleted: snap.size };
}));

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((e, req, res, next) => {
    console.error('EXPRESS:', e.message);
    res.status(500).json({ success: false, error: 'Server error' });
});

// ============================================================================
// 15. LAUNCH
// ============================================================================
async function initDefaults() {
    try {
        const cfgDoc = await db.doc('settings/config').get();
        if (!cfgDoc.exists) await db.doc('settings/config').set(DEFAULTS);
        
        const tasksDoc = await db.doc('settings/tasks').get();
        if (!tasksDoc.exists) await db.doc('settings/tasks').set({ list: DEFAULT_TASKS });
        
        log('✅ Defaults initialized');
    } catch (e) {
        log('Init error:', e.message);
    }
}

const server = app.listen(PORT, async () => {
    await initDefaults();
    log(`🚀 Groyper Mine listening on ${PORT}`);
});

// Bot launch with polling (safer than webhook on Render free tier)
bot.launch({ dropPendingUpdates: true })
    .then(() => log('🤖 Bot started (polling)'))
    .catch(err => console.error('❌ Bot error:', err.message));

process.on('unhandledRejection', e => console.error('UNHANDLED:', e));
process.on('SIGTERM', async () => {
    log('SIGTERM received');
    await flushStats();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
});
