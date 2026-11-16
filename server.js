// ============================================================================
// GROYPER MINE — SERVER v3.4
// Express + Telegraf (polling) + Firebase Admin
// All features preserved. Adds:
//   - 3-hour cooldown, 10 GROYP reward
//   - New boost plans (3x/8x/20x, 3/6/15 TON, 7 days)
//   - /ads/claim accepts watchedCount only (frontend-synced)
//   - Removed /ads/start and /ads/watch (frontend-only ads)
//   - fee required on EVERY withdrawal + diagnostics
//   - Withdraw fee: no automatic tonapi verification, boc fingerprint + replay protection
//   - /giftboost admin command (grant mining boost to any user, hours-based)
//   - v3.4: Force-canonical boost economy (ignore stale Firestore values),
//           strict mult() whitelist (only 1/3/8/20 accepted)
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
// 1. ENV & SECRETS
// ============================================================================
const log = (...a) => console.log(new Date().toISOString(), ...a);

const readSecret = (file) => {
    try { return fs.readFileSync('/etc/secrets/' + file, 'utf8').trim(); }
    catch { return null; }
};

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_WALLET = process.env.OWNER_WALLET;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TON_API_KEY = process.env.TON_API_KEY || readSecret('ton-api-key.txt') || '';
const CRON_KEY = process.env.CRON_KEY || '';

let ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;
if (!ADMIN_ID) {
    try { ADMIN_ID = String(JSON.parse(readSecret('admin-config.json')).admin_id); } catch {}
}

if (!BOT_TOKEN || !OWNER_WALLET || !APP_URL) {
    console.error('❌ Missing BOT_TOKEN / OWNER_WALLET / APP_URL');
    process.exit(1);
}

// ============================================================================
// 2. FIREBASE
// ============================================================================
const saKey = readSecret('firebase-admin-key.json');
if (!saKey) {
    console.error('❌ Missing /etc/secrets/firebase-admin-key.json');
    process.exit(1);
}

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saKey)) });
}
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const inc = (n) => FV.increment(n);
const arrayUnion = (v) => FV.arrayUnion(v);
const userRef = (id) => db.collection('users').doc(String(id));

log('🔥 Firebase initialized');

// ============================================================================
// 3. CONFIG (DEFAULTS)
// ============================================================================
const DEFAULTS = {
    symbol: 'GROYP',
    tokenAddress: 'EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    channelUrl: 'https://t.me/GroyperMine',
    groupUrl: 'https://t.me/communityGROYP',
    dexUrl: 'https://dedust.io/swap/TON/EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    botUsername: 'GroyperMinebot',
    botShortName: 'Mine',
    miningReward: 10,
    cooldownMs: 3 * 3600e3,
    adsPerBatch: 10,
    adsReward: 20,
    adsCooldownMs: 6 * 3600e3,
    adsMinGapSec: 15,
    minWithdraw: 2000,
    feeTon: 0.1,
    feeAlwaysRequired: true,
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
        bronze: { price: 3,  mult: 3,  name: 'SPARK' },
        silver: { price: 6,  mult: 8,  name: 'BLAZE' },
        gold:   { price: 15, mult: 20, name: 'INFERNO' }
    },
    boostDays: 7,
    checkinRewards: [5, 10, 15, 20, 30, 40, 60],
    dailyCap: 0,
    miningEnabled: true,
    withdrawEnabled: true,
    maintenance: false,
    banner: ''
};

// Canonical boost multipliers — the ONLY values accepted at runtime
const VALID_BOOST_MULTS = [1, 3, 8, 20];

const memCache = new Map();
const cached = async (key, ttl, fn) => {
    const c = memCache.get(key);
    if (c && c.exp > Date.now()) return c.v;
    const v = await fn();
    memCache.set(key, { v, exp: Date.now() + ttl });
    return v;
};
const bust = (k) => memCache.delete(k);

const getConfig = () => cached('config', 60000, async () => {
    const s = await db.doc('settings/config').get();
    const stored = s.exists ? s.data() : {};
    const merged = { ...DEFAULTS, ...stored };

    // ✅ v3.4: Force-canonical values for critical economy fields.
    // Any stale / corrupted values in Firestore are ignored.
    merged.boosts      = DEFAULTS.boosts;
    merged.boostDays   = DEFAULTS.boostDays;
    merged.miningReward = DEFAULTS.miningReward;
    merged.cooldownMs  = DEFAULTS.cooldownMs;

    return merged;
});

const setConfig = async (patch) => {
    await db.doc('settings/config').set(patch, { merge: true });
    bust('config');
};

const publicConfig = (c) => ({
    symbol: c.symbol,
    bot: c.botUsername,
    botUsername: c.botUsername,
    botShortName: c.botShortName || 'Mine',
    tokenAddress: c.tokenAddress,
    tokenSymbol: c.symbol,
    miningReward: c.miningReward,
    cooldownMs: c.cooldownMs,
    adsPerBatch: c.adsPerBatch,
    adsReward: c.adsReward,
    adsCooldownMs: c.adsCooldownMs,
    adsMinGapSec: c.adsMinGapSec,
    minWithdraw: c.minWithdraw,
    feeTon: c.feeTon,
    feeAlwaysRequired: !!c.feeAlwaysRequired,
    minAccountAgeHours: c.minAccountAgeHours,
    referralReward: c.referralReward,
    milestones: c.milestones,
    // ✅ v3.4: Always send canonical boosts to the frontend
    boosts: DEFAULTS.boosts,
    boostDays: c.boostDays,
    checkinRewards: c.checkinRewards,
    withdrawEnabled: !!c.withdrawEnabled,
    miningEnabled: !!c.miningEnabled
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
    } catch (e) { log('flushStats:', e.message); }
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
const capCommit = (n) => {
    daily.amount += n;
    daily.unflushed += n;
    statInc('distributed', n);
};

// ============================================================================
// 5. TASKS (DEFAULT — updated to X + communityGROYP)
// ============================================================================
const DEFAULT_TASKS = [
    {
        id: 'join_channel',
        name: 'Join Telegram Channel',
        url: 'https://t.me/GroyperMine',
        reward: 50,
        iconClass: 'fab fa-telegram',
        verify: 'chat',
        chat: '@GroyperMine'
    },
    {
        id: 'join_group',
        name: 'Join Community Group',
        url: 'https://t.me/communityGROYP',
        reward: 50,
        iconClass: 'fas fa-users',
        verify: 'chat',
        chat: '@communityGROYP'
    },
    {
        id: 'follow_x',
        name: 'Follow on X (Twitter)',
        url: 'https://x.com/Daily_AirdropX',
        reward: 50,
        iconClass: 'fab fa-twitter',
        verify: 'delay',
        delaySec: 20
    }
];

const getTasks = () => cached('tasks', 300000, async () => {
    const s = await db.doc('settings/tasks').get();
    return s.exists && Array.isArray(s.data().list) ? s.data().list : DEFAULT_TASKS;
});

const saveTasks = async (list) => {
    await db.doc('settings/tasks').set({ list });
    bust('tasks');
};

// ============================================================================
// 6. PRICE (cached 60s, source: DexScreener → CoinGecko fallback)
// ============================================================================
let lastPrice = { usd: 0, price: 0, change: 0, change24h: 0, mcap: 0, fdv: 0, liq: 0, vol: 0 };

const getPrice = () => cached('price', 60000, async () => {
    // 1) DexScreener
    try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${DEFAULTS.tokenAddress}`, {
            signal: AbortSignal.timeout(8000)
        });
        const j = await r.json();
        const p = (j.pairs || []).sort((a, b) => (+b.liquidity?.usd || 0) - (+a.liquidity?.usd || 0))[0];
        if (p) {
            lastPrice = {
                usd: +p.priceUsd || 0,
                price: +p.priceUsd || 0,
                change: +p.priceChange?.h24 || 0,
                change24h: +p.priceChange?.h24 || 0,
                mcap: +p.marketCap || 0,
                fdv: +p.fdv || 0,
                liq: +p.liquidity?.usd || 0,
                vol: +p.volume?.h24 || 0
            };
            return lastPrice;
        }
    } catch (e) { log('DexScreener failed:', e.message); }

    // 2) CoinGecko
    try {
        const r = await fetch(
            'https://api.coingecko.com/api/v3/coins/groyper-3?localization=false&tickers=false&community_data=false&developer_data=false',
            { signal: AbortSignal.timeout(8000) }
        );
        const j = await r.json();
        if (j?.market_data) {
            const md = j.market_data;
            lastPrice = {
                usd: md.current_price?.usd || 0,
                price: md.current_price?.usd || 0,
                change: md.price_change_percentage_24h || 0,
                change24h: md.price_change_percentage_24h || 0,
                mcap: md.market_cap?.usd || 0,
                fdv: md.fully_diluted_valuation?.usd || 0,
                liq: md.total_volume?.usd || 0,
                vol: md.total_volume?.usd || 0
            };
            return lastPrice;
        }
    } catch (e) { log('CoinGecko failed:', e.message); }

    return lastPrice;
});

// ============================================================================
// 7. HELPERS
// ============================================================================
class AppErr extends Error {
    constructor(m, code = 400) { super(m); this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const safeEq = (a, b) => {
    a = Buffer.from(String(a));
    b = Buffer.from(String(b));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const h = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (e instanceof AppErr) return res.status(e.code).json({ success: false, error: e.message });
    log('ERR', req.method, req.path, e.message);
    res.status(500).json({ success: false, error: 'Server error' });
});

// ============================================================================
// 8. USER MODEL
// ============================================================================
const PUB = [
    'userId', 'username', 'firstName', 'wallet',
    'balance', 'totalWithdrawn', 'totalEarned',
    'lastMiningClaim', 'boostMultiplier', 'boostType', 'boostExpiresAt',
    'adsCooldownUntil', 'adsWatched', 'completedTasks',
    'activeReferrals', 'inactiveReferrals', 'claimedMilestones',
    'referralEarnings',
    'streak', 'lastCheckinDay', 'isActive', 'withdrawFeePaid', 'createdAt'
];

const pub = (u) => {
    const o = {};
    for (const k of PUB) if (u[k] !== undefined) o[k] = u[k];
    return o;
};

// ✅ v3.4: Strict whitelist — only canonical multipliers accepted
const mult = (u, now = Date.now()) => {
    if (!(u.boostMultiplier > 1 && u.boostExpiresAt > now)) return 1;
    return VALID_BOOST_MULTS.includes(u.boostMultiplier) ? u.boostMultiplier : 1;
};

const newUser = (tg) => ({
    userId: tg.id,
    username: tg.username || '',
    firstName: tg.first_name || 'User',
    wallet: '',
    balance: 0,
    totalWithdrawn: 0,
    totalEarned: 0,
    lastMiningClaim: 0,
    boostMultiplier: 1,
    boostType: null,
    boostExpiresAt: 0,
    adsCooldownUntil: 0,
    adsWatched: 0,
    completedTasks: [],
    activeReferrals: 0,
    inactiveReferrals: 0,
    claimedMilestones: [],
    referralEarnings: 0,
    referredBy: null,
    isActive: false,
    withdrawFeePaid: false,
    pendingWd: 0,
    streak: 0,
    lastCheckinDay: 0,
    banned: false,
    createdAt: Date.now()
});

const notify = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

// ============================================================================
// 9. TELEGRAM AUTH
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

async function verifyPayment(it, boc) {
    let hash;
    try {
        const r = await fetch('https://tonapi.io/v2/blockchain/message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(TON_API_KEY ? { Authorization: 'Bearer ' + TON_API_KEY } : {})
            },
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

    if (!tx) throw new AppErr('Transaction not confirmed yet. Please try again.');
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
// 11. TELEGRAM BOT
// ============================================================================
const bot = new Telegraf(BOT_TOKEN);
bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

// Broadcast state
const broadcastState = {
    running: false,
    cancelled: false,
    sent: 0,
    failed: 0,
    total: 0,
    startedAt: 0
};

// ---- /start ----
bot.start(async (ctx) => {
    try {
        const cfg = await getConfig();
        const uid = String(ctx.from.id);
        const name = ctx.from.first_name || 'Miner';
        const startParam = ctx.startPayload;

        const existing = await userRef(uid).get();
        if (!existing.exists) {
            await userRef(uid).set(newUser(ctx.from));
            statInc('users');
        }

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
├ ⛏️ <b>Mining:</b> Claim <b>${cfg.miningReward} $${cfg.symbol}</b> every 3 hours.
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
        log('Start error:', e.message);
        await ctx.reply('⚠️ Something went wrong. Please try again.');
    }
});

// ---- Bot admin check for chat verification (with detailed logs) ----
const botAdminCache = new Map();

async function botIsAdmin(chatUsername) {
    if (!chatUsername) {
        log('botIsAdmin: no chatUsername provided');
        return false;
    }
    const key = String(chatUsername).toLowerCase();
    const c = botAdminCache.get(key);
    if (c && c.exp > Date.now()) return c.v;

    try {
        const me = await bot.telegram.getMe();
        const member = await bot.telegram.getChatMember(chatUsername, me.id);
        const status = member?.status;
        const isAdmin = ['administrator', 'creator'].includes(status);
        log(`botIsAdmin: bot=${me.id} chat=${chatUsername} status=${status} isAdmin=${isAdmin}`);
        botAdminCache.set(key, { v: isAdmin, exp: Date.now() + 300000 });
        return isAdmin;
    } catch (e) {
        log(`❌ botIsAdmin FAILED for ${chatUsername}: ${e.message}`);
        log(`   Possible reasons: bot is not admin, chat username wrong, or bot removed.`);
        botAdminCache.set(key, { v: false, exp: Date.now() + 60000 });
        return false;
    }
}

// ---- Admin panel ----
const isAdmin = (ctx) => String(ctx.from?.id) === ADMIN_ID;
const sessions = new Map();

async function buildAdminPanel() {
    const c = await getConfig();
    const s = (await db.doc('stats/global').get()).data() || {};
    const t = (k, l) => Markup.button.callback(`${c[k] ? '🟢' : '🔴'} ${l}`, 'a:tg:' + k);

    const rows = [
        [Markup.button.callback('📋 Pending withdrawals', 'a:wd')],
        [Markup.button.callback('📝 Tasks', 'a:tasks'), Markup.button.callback('📢 Broadcast', 'a:bc')],
        [Markup.button.callback('💰 Add balance', 'a:addbal')],
        [t('miningEnabled', 'Mining'), t('withdrawEnabled', 'Withdraw')],
        [t('maintenance', 'Maintenance')],
        [Markup.button.callback('🔄 Refresh', 'a:home')]
    ];

    if (broadcastState.running) {
        rows.unshift([
            Markup.button.callback('🛑 Cancel broadcast', 'a:bcancel'),
            Markup.button.callback('📊 Status', 'a:bstatus')
        ]);
    }

    return {
        text: `👑 <b>Admin Panel</b>\n\n` +
            `👥 Users: <b>${(s.users || 0).toLocaleString()}</b>\n` +
            `⛏ Claims: <b>${(s.claims || 0).toLocaleString()}</b>\n` +
            `💰 Distributed: <b>${(s.distributed || 0).toLocaleString()}</b>\n` +
            `⏳ Pending: <b>${(s.pendingCount || 0).toLocaleString()}</b>\n` +
            `📤 Paid out: <b>${(s.withdrawnTotal || 0).toLocaleString()}</b>\n` +
            `💎 TON revenue: <b>${(s.tonRevenue || 0).toFixed(2)}</b>\n\n` +
            `${broadcastState.running ? '📢 <b>Broadcast running</b>\n\n' : ''}` +
            `🟢 = ON. Maintenance blocks the app.`,
        kb: Markup.inlineKeyboard(rows)
    };
}

bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Access Denied');
    const p = await buildAdminPanel();
    ctx.replyWithHTML(p.text, p.kb);
});

bot.command('cancel', (ctx) => {
    if (!isAdmin(ctx)) return;
    sessions.delete(ADMIN_ID);
    ctx.reply('Cancelled.');
});

bot.command('set', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.split(/\s+/);
    const k = parts[1];
    const v = parts[2];

    const numericKeys = ['miningReward', 'adsReward', 'referralReward', 'minWithdraw', 'feeTon',
        'minAccountAgeHours', 'maxPendingWd', 'dailyCap', 'adsMinGapSec', 'boostDays', 'cooldownMs'];
    const boolKeys = ['miningEnabled', 'withdrawEnabled', 'maintenance', 'feeAlwaysRequired'];

    if (numericKeys.includes(k)) {
        if (isNaN(+v)) return ctx.reply(`Usage: /set ${k} <number>`);
        await setConfig({ [k]: +v });
        return ctx.reply(`✅ ${k} = ${+v}`);
    }

    if (boolKeys.includes(k)) {
        const boolVal = String(v).toLowerCase();
        if (!['true', 'false', '1', '0', 'on', 'off'].includes(boolVal)) {
            return ctx.reply(`Usage: /set ${k} true|false`);
        }
        const val = ['true', '1', 'on'].includes(boolVal);
        await setConfig({ [k]: val });
        return ctx.reply(`✅ ${k} = ${val}`);
    }

    ctx.reply(
        `Usage: /set <key> <value>\n\n` +
        `Numeric keys:\n${numericKeys.join(', ')}\n\n` +
        `Boolean keys:\n${boolKeys.join(', ')}`
    );
});

bot.command('banner', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const t = ctx.message.text.replace(/^\/banner\s*/, '');
    await setConfig({ banner: t });
    ctx.reply(t ? '✅ Banner set' : '✅ Banner cleared');
});

bot.command('user', async (ctx) => {
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
        `Ref earnings: ${u.referralEarnings || 0}\n` +
        `Banned: ${u.banned}\n` +
        `Wallet: <code>${u.wallet || '-'}</code>`
    );
});

// ---- /addbalance ----
bot.command('addbalance', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.split(/\s+/);
    const target = parts[1];
    const amount = Number(parts[2]);

    if (!target || !Number.isFinite(amount) || amount === 0) {
        return ctx.reply(
            'Usage: /addbalance <id_or_@username> <amount>\n' +
            'Example: /addbalance 123456789 500\n' +
            'Example: /addbalance @username 500\n' +
            'Amount can be negative to remove.'
        );
    }

    let uid = null;
    if (/^\d{5,15}$/.test(target)) {
        uid = target;
    } else if (/^@\w+$/.test(target)) {
        const username = target.slice(1).toLowerCase();
        const snap = await db.collection('users').limit(1000).get();
        for (const d of snap.docs) {
            const u = d.data();
            if ((u.username || '').toLowerCase() === username) {
                uid = d.id;
                break;
            }
        }
        if (!uid) return ctx.reply(`❌ User @${username} not found in first 1000 records`);
    } else {
        return ctx.reply('❌ Invalid target. Use numeric ID or @username');
    }

    const ref = userRef(uid);
    const snap = await ref.get();
    if (!snap.exists) return ctx.reply('❌ User not found in database');

    const u = snap.data();
    const oldBalance = Number(u.balance) || 0;
    const newBalance = Math.max(0, oldBalance + amount);

    await ref.update({
        balance: newBalance,
        totalEarned: amount > 0 ? inc(amount) : inc(0)
    });

    statInc('distributed', amount > 0 ? amount : 0);

    await ctx.replyWithHTML(
        `✅ <b>Balance updated</b>\n\n` +
        `👤 User: @${esc(u.username || '')} (${uid})\n` +
        `💰 Old: ${oldBalance.toLocaleString()} ${DEFAULTS.symbol}\n` +
        `💰 New: ${newBalance.toLocaleString()} ${DEFAULTS.symbol}\n` +
        `📊 Change: ${amount > 0 ? '+' : ''}${amount.toLocaleString()}`
    );

    if (amount > 0) {
        notify(uid, `🎁 Admin credited <b>${amount.toLocaleString()} ${DEFAULTS.symbol}</b> to your balance!`);
    }

    log(`Admin ${ADMIN_ID} added ${amount} to user ${uid} (new balance ${newBalance})`);
});

// ---- /giftboost ----
bot.command('giftboost', async (ctx) => {
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.split(/\s+/);
    const target = parts[1];
    const type = parts[2];
    const hours = Number(parts[3]);

    if (!target || !type || !hours) {
        return ctx.replyWithHTML(
            '🎁 <b>Gift Boost</b>\n\n' +
            'Usage: <code>/giftboost &lt;userId_or_@username&gt; &lt;bronze|silver|gold&gt; &lt;hours&gt;</code>\n\n' +
            'Examples:\n' +
            '<code>/giftboost 123456789 silver 3</code> → BLAZE 8x for 3 hours\n' +
            '<code>/giftboost @username gold 168</code> → INFERNO 20x for 7 days\n\n' +
            '• bronze = SPARK (3x)\n' +
            '• silver = BLAZE (8x)\n' +
            '• gold   = INFERNO (20x)'
        );
    }

    // ✅ v3.4: Use canonical DEFAULTS.boosts (never Firestore)
    const boost = DEFAULTS.boosts[type];
    if (!boost) {
        return ctx.reply('❌ Invalid boost type. Use: bronze, silver, gold');
    }

    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
        return ctx.reply('❌ Hours must be between 1 and 8760 (1 year max)');
    }

    // Find user (same logic as /addbalance)
    let uid = null;
    if (/^\d{5,15}$/.test(target)) {
        uid = target;
    } else if (/^@\w+$/.test(target)) {
        const username = target.slice(1).toLowerCase();
        const snap = await db.collection('users').limit(1000).get();
        for (const d of snap.docs) {
            const u = d.data();
            if ((u.username || '').toLowerCase() === username) {
                uid = d.id;
                break;
            }
        }
        if (!uid) return ctx.reply(`❌ User @${username} not found in first 1000 records`);
    } else {
        return ctx.reply('❌ Invalid target. Use numeric ID or @username');
    }

    const ref = userRef(uid);
    const snap = await ref.get();
    if (!snap.exists) return ctx.reply('❌ User not found in database');

    const u = snap.data();
    const expiresAt = Date.now() + hours * 3600e3;

    await ref.update({
        boostMultiplier: boost.mult,
        boostType: type,
        boostExpiresAt: expiresAt
    });

    notify(uid,
        `🎁 <b>Admin gifted you a boost!</b>\n\n` +
        `⚡ <b>${boost.name} (${boost.mult}x)</b>\n` +
        `⏱️ Duration: <b>${hours} hour${hours > 1 ? 's' : ''}</b>\n` +
        `📅 Expires: ${new Date(expiresAt).toLocaleString()}\n\n` +
        `Start mining with your new power!`
    );

    await ctx.replyWithHTML(
        `✅ <b>Boost gifted</b>\n\n` +
        `👤 User: @${esc(u.username || '')} (${uid})\n` +
        `⚡ Boost: <b>${boost.name} (${boost.mult}x)</b>\n` +
        `⏱️ Duration: <b>${hours} hour${hours > 1 ? 's' : ''}</b>\n` +
        `📅 Expires: ${new Date(expiresAt).toLocaleString()}`
    );

    log(`Admin ${ADMIN_ID} gifted ${type} (${hours}h) to user ${uid}`);
});

// ---- Admin actions ----
bot.action(/^a:(\w+)(?::(.+))?$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔');
    const [, act, arg] = ctx.match;
    await ctx.answerCbQuery().catch(() => {});

    try {
        if (act === 'home') {
            const p = await buildAdminPanel();
            return ctx.editMessageText(p.text, { parse_mode: 'HTML', ...p.kb }).catch(() => {});
        }
        if (act === 'tg') {
            const c = await getConfig();
            await setConfig({ [arg]: !c[arg] });
            const p = await buildAdminPanel();
            return ctx.editMessageText(p.text, { parse_mode: 'HTML', ...p.kb }).catch(() => {});
        }
        if (act === 'wd') {
            const snap = await db.collection('withdrawals')
                .where('status', '==', 'pending')
                .limit(10)
                .get();
            if (snap.empty) return ctx.reply('✅ No pending withdrawals');

            const sorted = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => a.createdAt - b.createdAt);

            for (const w of sorted.slice(0, 5)) {
                const bocRef = w.bocRef ? `\n🔑 <b>BOC:</b> <code>${esc(w.bocRef)}</code>` : '';
                await ctx.replyWithHTML(
                    `💸 <b>${w.amount.toLocaleString()} $GROYP</b>\n` +
                    `👤 @${esc(w.username || '')}\n` +
                    `💳 <code>${w.wallet || w.walletAddress || '-'}</code>\n` +
                    `📅 ${new Date(w.createdAt).toLocaleString()}` + bocRef,
                    Markup.inlineKeyboard([[
                        Markup.button.callback('✅ Approve', 'a:wp:' + w.id),
                        Markup.button.callback('❌ Reject', 'a:wr:' + w.id)
                    ]])
                );
            }
            return;
        }
        if (act === 'wp') {
            const d = await db.runTransaction(async (tx) => {
                const wr = db.collection('withdrawals').doc(arg);
                const w = await tx.get(wr);
                if (!w.exists) throw new Error('Not found');
                const x = w.data();
                if (x.status !== 'pending') throw new Error('Already ' + x.status);
                tx.update(wr, { status: 'approved', approvedAt: Date.now() });
                tx.set(userRef(x.userId), {
                    totalWithdrawn: inc(x.amount),
                    pendingWd: inc(-1)
                }, { merge: true });
                return x;
            });
            statInc('pendingCount', -1);
            statInc('pendingAmount', -d.amount);
            statInc('withdrawnTotal', d.amount);
            notify(d.userId, `✅ Your withdrawal of <b>${d.amount} ${DEFAULTS.symbol}</b> has been approved! Funds will be sent shortly.`);
            return ctx.reply(`✅ Approved: ${d.amount} → @${d.username}`);
        }
        if (act === 'wr') {
            sessions.set(ADMIN_ID, { step: 'reject_reason', withdrawalId: arg });
            return ctx.reply('📝 Send the rejection reason (will be sent to the user):');
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
            const list = (await getTasks()).filter(t => t.id !== arg);
            await saveTasks(list);
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
            if (broadcastState.running) {
                return ctx.reply('⚠️ Broadcast already running. Use Cancel button first.');
            }
            sessions.set(ADMIN_ID, { step: 'bc' });
            return ctx.reply('📢 Send the broadcast text. /cancel to abort.');
        }
        if (act === 'bcancel') {
            if (!broadcastState.running) return ctx.reply('No broadcast running.');
            broadcastState.cancelled = true;
            return ctx.reply('🛑 Cancelling… current message will finish, then stop.');
        }
        if (act === 'bstatus') {
            return ctx.reply(formatBroadcastStatus());
        }
        if (act === 'addbal') {
            return ctx.reply(
                'Usage: /addbalance <id_or_@username> <amount>\n\n' +
                'Examples:\n' +
                '/addbalance 123456789 500\n' +
                '/addbalance @username 500\n' +
                '/addbalance 123456789 -100'
            );
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

// ---- Broadcast status formatter ----
function formatBroadcastStatus() {
    if (!broadcastState.running) return 'No broadcast running.';
    const done = broadcastState.sent + broadcastState.failed;
    const pct = broadcastState.total > 0
        ? ((done / broadcastState.total) * 100).toFixed(1)
        : '?';
    const elapsed = ((Date.now() - broadcastState.startedAt) / 1000).toFixed(0);
    return `📊 Broadcast Status\n\n` +
        `✅ Sent: ${broadcastState.sent.toLocaleString()}\n` +
        `❌ Failed: ${broadcastState.failed.toLocaleString()}\n` +
        `📈 Progress: ${pct}%\n` +
        `⏱️ Elapsed: ${elapsed}s\n` +
        `📌 Running: ${broadcastState.cancelled ? '🛑 Cancelling' : '✅ Active'}`;
}

async function broadcast(text) {
    if (broadcastState.running) {
        notify(ADMIN_ID, '⚠️ Broadcast already running. Use /cancelbroadcast to stop.');
        return;
    }

    broadcastState.running = true;
    broadcastState.cancelled = false;
    broadcastState.sent = 0;
    broadcastState.failed = 0;
    broadcastState.startedAt = Date.now();

    try {
        const countSnap = await db.collection('users').count().get();
        broadcastState.total = countSnap.data().count;
    } catch { broadcastState.total = 0; }

    notify(ADMIN_ID,
        `📢 Broadcast started\n` +
        `👥 Users: ${broadcastState.total.toLocaleString()}\n` +
        `Use /statusbroadcast to check progress.\n` +
        `Use /cancelbroadcast to stop.`
    );

    let last = null;
    while (!broadcastState.cancelled) {
        let q = db.collection('users').orderBy('__name__').limit(50);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;

        for (const d of snap.docs) {
            if (broadcastState.cancelled) break;

            let attempt = 0;
            let success = false;

            while (attempt < 3 && !success && !broadcastState.cancelled) {
                try {
                    await bot.telegram.sendMessage(d.id, '📢 ' + text, { parse_mode: 'HTML' });
                    success = true;
                    broadcastState.sent++;
                } catch (e) {
                    if (e.code === 429) {
                        const wait = (e.parameters?.retry_after || 5) * 1000;
                        log(`⏳ Rate limit — waiting ${wait}ms`);
                        await sleep(wait + 500);
                    } else if (e.code === 403) {
                        broadcastState.failed++;
                        success = true;
                    } else {
                        attempt++;
                        await sleep(1000 * attempt);
                    }
                }
            }

            if (!success) broadcastState.failed++;
            await sleep(40);
        }

        last = snap.docs[snap.docs.length - 1];
    }

    const duration = ((Date.now() - broadcastState.startedAt) / 1000).toFixed(1);
    const msg = broadcastState.cancelled
        ? `🛑 Broadcast cancelled\n✅ Sent: ${broadcastState.sent.toLocaleString()}\n❌ Failed: ${broadcastState.failed.toLocaleString()}`
        : `✅ Broadcast complete\n✅ Sent: ${broadcastState.sent.toLocaleString()}\n❌ Failed: ${broadcastState.failed.toLocaleString()}\n⏱️ ${duration}s`;

    notify(ADMIN_ID, msg);
    log('Broadcast:', msg);
    broadcastState.running = false;
}

bot.command('cancelbroadcast', (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!broadcastState.running) return ctx.reply('No broadcast running.');
    broadcastState.cancelled = true;
    ctx.reply('🛑 Cancelling… current message will finish, then stop.');
});

bot.command('statusbroadcast', (ctx) => {
    if (!isAdmin(ctx)) return;
    ctx.reply(formatBroadcastStatus());
});

bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = sessions.get(ADMIN_ID);
    if (!s) return;
    const t = ctx.message.text;

    if (s.step === 'reject_reason') {
        const reason = t.trim().slice(0, 200);
        const wId = s.withdrawalId;
        sessions.delete(ADMIN_ID);
        try {
            const d = await db.runTransaction(async (tx) => {
                const wr = db.collection('withdrawals').doc(wId);
                const w = await tx.get(wr);
                if (!w.exists) throw new Error('Not found');
                const x = w.data();
                if (x.status !== 'pending') throw new Error('Already ' + x.status);
                tx.update(wr, { status: 'rejected', rejectReason: reason, rejectedAt: Date.now() });
                tx.set(userRef(x.userId), {
                    balance: inc(x.amount),
                    pendingWd: inc(-1)
                }, { merge: true });
                return x;
            });
            statInc('pendingCount', -1);
            statInc('pendingAmount', -d.amount);
            notify(d.userId,
                `❌ Your withdrawal of <b>${d.amount} ${DEFAULTS.symbol}</b> was rejected.\n\n<b>Reason:</b> ${esc(reason)}\n\nFunds returned to your balance.`
            );
            await ctx.reply(`✅ Rejected: ${d.amount}\nReason: ${reason}`);
        } catch (e) {
            await ctx.reply('⚠️ Error: ' + e.message);
        }
        return;
    }

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
        ctx.reply('⏳ Broadcasting…');
        broadcast(t).catch(e => notify(ADMIN_ID, 'Broadcast error: ' + e.message));
    }
});

bot.catch((e, ctx) => log('BOT ERR', ctx?.updateType, e.message));

// ============================================================================
// 12. EXPRESS APP
// ============================================================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
app.use(cors({ origin: APP_URL }));
app.use(express.json({ limit: '100kb' }));

// Static files
const FILES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css'
};

app.get(Object.keys(FILES), (req, res) => {
    res.set('Cache-Control',
        req.path === '/' || req.path === '/index.html' ? 'no-cache' : 'public, max-age=300');
    res.sendFile(path.join(__dirname, FILES[req.path]));
});

app.get('/health', (_, res) => res.send('ok'));

app.get('/tonconnect-manifest.json', (_, res) => res.json({
    url: APP_URL,
    name: 'Groyper Mine',
    iconUrl: 'https://assets.coingecko.com/coins/images/102172192/standard/Untitled_design__12_-removebg-preview.png',
    termsOfUseUrl: APP_URL + '/terms',
    privacyPolicyUrl: APP_URL + '/privacy'
}));

app.get('/terms', (_, res) => res.send('<h1>Terms</h1><p>Community incentives only. No investment offer.</p>'));
app.get('/privacy', (_, res) => res.send('<h1>Privacy</h1><p>We store Telegram ID, username, wallet, and in-app activity. We never access your keys.</p>'));

// ============================================================================
// 13. API ROUTES
// ============================================================================
const api = express.Router();
api.use(authMw);

// ---- Init ----
api.get('/init', h(async (req, res) => {
    const [cfg, tasks, price, snap] = await Promise.all([
        getConfig(), getTasks(), getPrice(), userRef(req.tg.id).get()
    ]);
    const u = snap.exists ? snap.data() : null;
    if (u?.banned) throw new AppErr('Account banned', 403);

    let userOut = u ? pub(u) : null;
    if (userOut) {
        if (typeof userOut.referralEarnings !== 'number') {
            userOut.referralEarnings = (userOut.activeReferrals || 0) * cfg.referralReward;
        }
    }

    res.json({
        success: true,
        user: userOut,
        tasks,
        config: publicConfig(cfg),
        price,
        serverTime: Date.now(),
        banner: cfg.banner || ''
    });
}));

api.get('/price', h(async (req, res) => res.json({ success: true, price: await getPrice() })));

// ---- Register ----
api.post('/register', h(async (req, res) => {
    const tg = req.tg;
    const { wallet, startParam } = req.body || {};
    if (!wallet || typeof wallet !== 'string' || wallet.length < 10) {
        throw new AppErr('Invalid wallet address');
    }

    let created = false;
    const user = await db.runTransaction(async (tx) => {
        const uRef = userRef(tg.id);
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

// ---- Mining ----
api.post('/mining/claim', h(async (req, res) => {
    const cfg = await getConfig();
    if (!cfg.miningEnabled) throw new AppErr('Mining is temporarily paused');
    await dailyLoad();

    const id = req.tg.id;
    const nowMs = Date.now();
    let refInfo = null;

    const out = await db.runTransaction(async (tx) => {
        refInfo = null;
        const ref = userRef(id);
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
            const refEarn = cfg.referralReward;

            tx.set(rr, {
                activeReferrals: inc(1),
                inactiveReferrals: inc(-1),
                balance: inc(refEarn),
                totalEarned: inc(refEarn),
                referralEarnings: inc(refEarn)
            }, { merge: true });

            tx.set(rr.collection('referrals').doc(id), { active: true }, { merge: true });
            refInfo = { to: u.referredBy, name: u.username || u.firstName, amount: refEarn };
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
        capCommit(refInfo.amount);
        notify(refInfo.to, `🎉 +${refInfo.amount} ${cfg.symbol} — your friend @${esc(refInfo.name)} is now active!`);
    }
    res.json({ success: true, reward: out.reward, user: pub(out.user) });
}));

// ---- Ads — single claim endpoint (frontend-synced) ----
// Note: /ads/start and /ads/watch removed.
// Frontend tracks `adWatchedLocal` in localStorage.
// Only when the user reaches 10 ads + taps CLAIM → this endpoint is called.
api.post('/ads/claim', h(async (req, res) => {
    const cfg = await getConfig();
    await dailyLoad();
    const id = req.tg.id;
    const nowMs = Date.now();
    const watchedCount = Number(req.body?.watchedCount) || 0;

    // Validate
    if (watchedCount < cfg.adsPerBatch) {
        throw new AppErr('Watch all ads first');
    }

    const out = await db.runTransaction(async (tx) => {
        const ref = userRef(id);
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if (nowMs < (u.adsCooldownUntil || 0)) throw new AppErr('Ads are on cooldown');

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
    const day = Math.floor(Date.now() / 86400e3);

    const out = await db.runTransaction(async (tx) => {
        const ref = userRef(id);
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

// ---- Tasks — strict chat verification ----
api.post('/tasks/verify', h(async (req, res) => {
    const cfg = await getConfig();
    await dailyLoad();
    const id = req.tg.id;
    const taskId = String(req.body?.taskId || '');
    const task = (await getTasks()).find(t => t.id === taskId);
    if (!task) throw new AppErr('Task not found');

    const pre = await userRef(id).get();
    if (pre.exists && (pre.data().completedTasks || []).includes(taskId)) {
        throw new AppErr('Already completed');
    }

    // CHAT VERIFICATION — strict enforcement
    if (task.verify === 'chat') {
        log(`[verify] task=${taskId} chat=${task.chat} user=${id} — checking bot admin...`);

        const adminOk = await botIsAdmin(task.chat);
        if (!adminOk) {
            log(`[verify] ❌ Bot NOT admin in ${task.chat} — refusing verify for task ${taskId}`);
            if (ADMIN_ID) {
                notify(ADMIN_ID,
                    `⚠️ <b>Verification blocked</b>\n\n` +
                    `Bot is NOT admin in <code>${esc(task.chat)}</code>.\n` +
                    `Task: <b>${esc(task.name)}</b> (${taskId})\n` +
                    `User: <code>${id}</code>\n\n` +
                    `Please add the bot as admin in that chat.`
                );
            }
            throw new AppErr('Verification temporarily unavailable. Please try again later.');
        }

        log(`[verify] Bot is admin in ${task.chat} — checking user membership...`);

        try {
            const m = await bot.telegram.getChatMember(task.chat, +id);
            const status = m?.status || null;
            const isMember =
                ['member', 'administrator', 'creator'].includes(status) ||
                (status === 'restricted' && m?.is_member === true);

            log(`[verify] User ${id} in ${task.chat}: status=${status} isMember=${isMember}`);

            if (!isMember) {
                throw new AppErr('Please join the channel/group first, then press Verify again.');
            }
        } catch (e) {
            if (e instanceof AppErr) throw e;
            log(`[verify] ❌ getChatMember FAILED for ${task.chat}/${id}: ${e.message}`);
            throw new AppErr('Could not verify membership. Make sure you joined, then try again.');
        }
    }

    // REWARD — only after full verification
    const out = await db.runTransaction(async (tx) => {
        const ref = userRef(id);
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if ((u.completedTasks || []).includes(taskId)) throw new AppErr('Already completed');
        capCheck(cfg, task.reward);

        tx.update(ref, {
            completedTasks: arrayUnion(taskId),
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
    const count = +req.body?.count;
    const m = cfg.milestones.find(x => x.count === count);
    if (!m) throw new AppErr('Invalid milestone');

    const out = await db.runTransaction(async (tx) => {
        const ref = userRef(id);
        const s = await tx.get(ref);
        if (!s.exists) throw new AppErr('User not found');
        const u = s.data();
        if (u.banned) throw new AppErr('Account banned', 403);
        if ((u.claimedMilestones || []).includes(count)) throw new AppErr('Already claimed');
        if ((u.activeReferrals || 0) < count) throw new AppErr('Not enough active referrals');

        tx.update(ref, {
            claimedMilestones: arrayUnion(count),
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
    try {
        const snap = await db.collection('withdrawals')
            .where('userId', '==', req.tg.id)
            .limit(20)
            .get();

        const items = snap.docs
            .map(d => {
                const x = d.data();
                return {
                    id: d.id,
                    amount: x.amount,
                    status: x.status,
                    createdAt: x.createdAt
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 10);

        res.json({ success: true, items, cursor: null });
    } catch (e) {
        log('withdrawals error:', e.message);
        res.json({ success: true, items: [], cursor: null });
    }
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

    // ✅ Fee required on EVERY withdrawal (based on config)
    const feeRequired = !!cfg.feeAlwaysRequired;

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
    let bocRef = null;

    if (it.feeRequired) {
        // ── No automatic tonapi verification ──────────────────────────────
        // The user cannot obtain a BOC without signing and broadcasting the
        // transaction from their wallet. Trust that + store a fingerprint
        // for admin audit, and enforce replay protection.
        const boc = String(req.body?.boc || '');
        if (!boc || boc.length < 20) {
            throw new AppErr('Payment required. Please complete the fee payment in your wallet.');
        }

        // Build a stable fingerprint from the BOC (deterministic hash)
        hash = crypto.createHash('sha256').update(boc).digest('hex');
        bocRef = boc.slice(0, 64) + (boc.length > 64 ? '…' : '');

        // Replay protection — same BOC cannot be reused for another withdrawal
        const usedSnap = await db.doc('used_payments/' + hash).get();
        if (usedSnap.exists) {
            throw new AppErr('This payment has already been used. Please pay again.');
        }
    }

    const user = await db.runTransaction(async (tx) => {
        const uRef = userRef(id);
        const [us, is2, ps] = await Promise.all([
            tx.get(uRef),
            tx.get(iRef),
            hash ? tx.get(db.doc('used_payments/' + hash)) : null
        ]);
        if (is2.data()?.status !== 'open') throw new AppErr('Request already processed');
        if (ps?.exists) throw new AppErr('This payment has already been used. Please pay again.');

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
            createdAt: Date.now(),
            feePaid: !!hash,
            feeTon: it.amountTon,
            bocRef: bocRef || null
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
        notify(ADMIN_ID,
            `💸 <b>New Withdrawal</b>\n\n👤 @${esc(user.username || '')}\n💰 ${it.amount.toLocaleString()} ${cfg.symbol}\n💳 <code>${user.wallet}</code>\n💎 Fee paid: ${hash ? `${it.amountTon} TON (BOC received)` : 'None'}\n\nUse /admin → 📋 Pending withdrawals to review BOC`
        );
    }

    res.json({ success: true, user: pub(user) });
}));

// ---- Boosts ----
api.post('/boost/intent', h(async (req, res) => {
    const cfg = await getConfig();
    const id = req.tg.id;
    const nowMs = Date.now();
    const type = String(req.body?.type || '');
    // ✅ v3.4: Always use canonical DEFAULTS.boosts (never Firestore)
    const b = DEFAULTS.boosts[type];
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

    // ✅ v3.4: Always use canonical DEFAULTS.boosts (never Firestore)
    const b = DEFAULTS.boosts[it.type];
    if (!b) throw new AppErr('Invalid boost');
    const hash = await verifyPayment(it, String(req.body?.boc || ''));
    const exp = Date.now() + cfg.boostDays * 86400e3;

    const user = await db.runTransaction(async (tx) => {
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

// ---- Leaderboard ----
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
const cron = (fn) => h(async (req, res) => {
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
    log('EXPRESS:', e.message);
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

bot.launch({ dropPendingUpdates: true })
    .then(() => log('🤖 Bot started (polling)'))
    .catch(err => log('Bot error:', err.message));

process.on('unhandledRejection', (e) => log('UNHANDLED:', e?.message || e));
process.on('SIGTERM', async () => {
    log('SIGTERM received');
    await flushStats();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
});
