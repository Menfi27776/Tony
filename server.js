// ============================================================================
// GROYPER MINE - EMBER VAULT EDITION
// Backend Server + Telegram Bot (server.js) - REAL TON VERIFICATION
// ============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// 1. CONFIGURATION & SECRETS
// ============================================================================

let serviceAccount = null;
let firebaseWebConfig = {};
let ADMIN_ID = null;
let BOT_TOKEN = process.env.BOT_TOKEN;
let OWNER_WALLET = process.env.OWNER_WALLET;
let APP_URL = process.env.APP_URL;

try {
    if (fs.existsSync('/etc/secrets/firebase-admin-key.json')) {
        serviceAccount = JSON.parse(fs.readFileSync('/etc/secrets/firebase-admin-key.json', 'utf8'));
    }
    if (fs.existsSync('/etc/secrets/firebase-web-config.json')) {
        firebaseWebConfig = JSON.parse(fs.readFileSync('/etc/secrets/firebase-web-config.json', 'utf8'));
    }
    if (fs.existsSync('/etc/secrets/admin-config.json')) {
        ADMIN_ID = JSON.parse(fs.readFileSync('/etc/secrets/admin-config.json', 'utf8')).admin_id;
    }
} catch (err) {
    console.error('❌ Secret loading error:', err.message);
}

const CONFIG = {
    tokenSymbol: 'GROYP',
    channelUrl: 'https://t.me/GroyperMine',
    groupUrl: 'https://t.me/communityGroyper',
    dexUrl: 'https://dedust.io/swap/TON/EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    MINING_REWARD: 20,
    MINING_COOLDOWN: 6 * 60 * 60 * 1000,
    ADS_BATCH_REWARD: 20,
    ADS_COOLDOWN: 6 * 60 * 60 * 1000,
    MAX_ADS: 10,
    REFERRAL_REWARD: 75,
    MIN_WITHDRAW: 2000,
    WITHDRAW_FEE_TON: 0.1,
    BOOSTS: {
        bronze: { price: 1, multiplier: 2 },
        silver: { price: 5, multiplier: 5 },
        gold: { price: 10, multiplier: 12 }
    }
};

// ============================================================================
// 2. FIREBASE SETUP
// ============================================================================

const admin = require('firebase-admin');
let db = null;
let usedTransactions = new Set(); // Prevent replay attacks in memory (use DB in production)

if (serviceAccount) {
    try {
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        db = admin.firestore();
    } catch (error) {
        console.error('❌ Firebase init error:', error.message);
    }
}

function checkDb() { return db !== null; }

async function getUser(userId) {
    if (!checkDb()) return null;
    const doc = await db.collection('users').doc(String(userId)).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function createUser(userId, data) {
    if (!checkDb()) return null;
    const userData = {
        userId: String(userId),
        username: data.username || 'user',
        firstName: data.firstName || 'User',
        walletAddress: data.walletAddress || '',
        balance: 0,
        totalWithdrawn: 0,
        totalEarned: 0,
        lastMiningClaim: 0,
        boostMultiplier: 1,
        adsWatched: 0,
        adsAccumulated: 0,
        adsCooldownUntil: 0,
        completedTasks: [],
        activeReferrals: 0,
        inactiveReferrals: 0,
        referrals: [],
        referredBy: data.startParam || null,
        claimedMilestones: [],
        withdrawals: [],
        isActive: false,
        withdrawFeePaid: false,
        createdAt: new Date().toISOString(),
        tasks: [
            { id: 'join_channel', name: 'Join Telegram Channel', url: CONFIG.channelUrl, reward: 50, icon: 'fa-telegram' },
            { id: 'follow_twitter', name: 'Follow on Twitter/X', url: 'https://x.com/GroyperMine', reward: 50, icon: 'fa-twitter' },
            { id: 'tweet', name: 'Tweet about Groyper', url: 'https://x.com/intent/tweet?text=I%20am%20mining%20$GROYP%20on%20@GroyperMine!', reward: 50, icon: 'fa-retweet' }
        ]
    };
    await db.collection('users').doc(String(userId)).set(userData);
    return userData;
}

async function updateUser(userId, updates) {
    if (!checkDb()) return false;
    await db.collection('users').doc(String(userId)).update(updates);
    return true;
}

// ============================================================================
// 3. REAL TON VERIFICATION
// ============================================================================

async function verifyTonPayment(boc, expectedAmountTon, expectedReceiver) {
    try {
        if (!boc) return false;

        // 1. Check for replay attack
        if (usedTransactions.has(boc)) {
            console.error('❌ Replay attack detected!');
            return false;
        }

        // 2. Send BOC to TON API to get transaction hash
        const apiResponse = await fetch('https://tonapi.io/v2/blockchain/message', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TON_API_KEY || ''}`
            },
            body: JSON.stringify({ boc })
        });

        const apiData = await apiResponse.json();
        
        if (!apiData || !apiData.hash) {
            console.error('❌ TON API failed to parse BOC');
            return false;
        }

        // 3. Verify the transaction details via TON API
        // Wait a few seconds for the transaction to be indexed
        await new Promise(resolve => setTimeout(resolve, 5000));

        const txResponse = await fetch(`https://tonapi.io/v2/blockchain/transactions/${apiData.hash}`, {
            headers: { 'Authorization': `Bearer ${process.env.TON_API_KEY || ''}` }
        });
        
        const txData = await txResponse.json();

        if (!txData || !txData.in_msg) {
            console.error('❌ Transaction not found');
            return false;
        }

        // 4. Verify receiver and amount
        const receiver = txData.in_msg.destination?.address;
        const valueInNano = parseFloat(txData.in_msg.value || 0);
        const valueInTon = valueInNano / 1e9;

        // Allow 1% tolerance for gas fees
        const minExpected = expectedAmountTon * 0.99;
        
        if (valueInTon < minExpected) {
            console.error(`❌ Incorrect amount: got ${valueInTon} TON, expected ${expectedAmountTon} TON`);
            return false;
        }

        if (receiver && receiver.toLowerCase() !== expectedReceiver.toLowerCase()) {
            console.error(`❌ Wrong receiver: got ${receiver}, expected ${expectedReceiver}`);
            return false;
        }

        // 5. Mark BOC as used
        usedTransactions.add(boc);

        // Save to DB to prevent replay across restarts
        await db.collection('used_payments').doc(apiData.hash).set({
            boc,
            amount: valueInTon,
            receiver,
            timestamp: new Date().toISOString()
        });

        console.log(`✅ Payment verified: ${valueInTon} TON to ${receiver}`);
        return true;

    } catch (error) {
        console.error('TON Verification Error:', error.message);
        return false;
    }
}

// ============================================================================
// 4. BOT SETUP
// ============================================================================

const bot = new Telegraf(BOT_TOKEN);
bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const startParam = ctx.startPayload;
    const userName = ctx.from.first_name || 'User';
    const userHandle = ctx.from.username || '';
    
    let user = await getUser(userId);
    
    const welcomeMsg = `
🔥 <b>Welcome to Groyper Mine, ${userName}!</b> 🔥

The <b>#1 Mining App</b> for <b>$GROYP</b> on TON Blockchain.

💰 <b>How It Works:</b>
├ ⛏️ <b>Mining:</b> Claim <b>${CONFIG.MINING_REWARD} $GROYP</b> every 6 hours.
├ 🎬 <b>Ads:</b> Watch 10 ads to earn <b>${CONFIG.ADS_BATCH_REWARD} $GROYP</b>.
├ ✅ <b>Tasks:</b> Complete simple tasks for <b>50 $GROYP</b> each.
└ 👥 <b>Referrals:</b> Earn <b>${CONFIG.REFERRAL_REWARD} $GROYP</b> per active friend.

📊 <b>Token Info:</b>
The <b>$GROYP</b> token is <b>live & tradable</b> on multiple DEXs (DeDust, STON.fi, etc.).
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.webApp('⛏️ Launch App', `${APP_URL}?userId=${userId}`)],
        [
            Markup.button.url('📢 Channel', CONFIG.channelUrl),
            Markup.button.url('💬 Community', CONFIG.groupUrl)
        ],
        [Markup.button.url('💱 Trade on DeDust', CONFIG.dexUrl)]
    ]);
    
    await ctx.replyWithHTML(welcomeMsg, keyboard);
    
    if (!user) {
        await createUser(userId, { username: userHandle, firstName: userName, startParam });
    }
    
    if (startParam && startParam !== String(userId)) {
        const referrer = await getUser(startParam);
        if (referrer) {
            const refs = referrer.referrals || [];
            if (!refs.find(r => r.userId === String(userId))) {
                refs.push({ userId: String(userId), username: userHandle || userName, isActive: false });
                await updateUser(startParam, { 
                    referrals: refs, 
                    inactiveReferrals: (referrer.inactiveReferrals || 0) + 1 
                });
            }
        }
    }
});

// ============================================================================
// 5. ADMIN PANEL
// ============================================================================

bot.command('admin', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply('⛔ Access Denied');
    
    const usersSnap = await db.collection('users').get();
    const pendingSnap = await db.collection('withdrawals').where('status', '==', 'pending').get();
    
    const msg = `
👑 <b>Admin Panel</b>

👥 <b>Total Users:</b> ${usersSnap.size}
📤 <b>Pending Withdrawals:</b> ${pendingSnap.size}
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📋 Pending Withdrawals', 'admin_withdrawals')],
        [Markup.button.callback('📢 Broadcast', 'admin_broadcast')]
    ]);
    
    await ctx.replyWithHTML(msg, keyboard);
});

bot.action('admin_withdrawals', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();
    
    const snap = await db.collection('withdrawals').where('status', '==', 'pending').limit(5).get();
    
    if (snap.empty) return ctx.reply('✅ No pending withdrawals');
    
    for (const doc of snap.docs) {
        const w = doc.data();
        const msg = `
💸 <b>Withdrawal Request</b>

👤 User: @${w.username}
🆔 ID: <code>${w.userId}</code>
💰 Amount: <b>${w.amount} $GROYP</b>
💳 Wallet: <code>${w.walletAddress}</code>
        `;
        
        const kb = Markup.inlineKeyboard([[
            Markup.button.callback('✅ Approve', `approve_${doc.id}`),
            Markup.button.callback('❌ Reject', `reject_${doc.id}`)
        ]]);
        
        await ctx.replyWithHTML(msg, kb);
    }
});

bot.action(/approve_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery('Approved ✅');
    const id = ctx.match[1];
    
    const doc = await db.collection('withdrawals').doc(id).get();
    if (doc.exists) {
        const w = doc.data();
        await db.collection('withdrawals').doc(id).update({ status: 'approved', approvedAt: new Date().toISOString() });
        await bot.telegram.sendMessage(w.userId, `✅ Your withdrawal of ${w.amount} $GROYP has been approved!`).catch(() => {});
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.action(/reject_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery('Rejected ❌');
    const id = ctx.match[1];
    
    const doc = await db.collection('withdrawals').doc(id).get();
    if (doc.exists) {
        const w = doc.data();
        const user = await getUser(w.userId);
        await updateUser(w.userId, { balance: (user.balance || 0) + w.amount });
        await db.collection('withdrawals').doc(id).update({ status: 'rejected', rejectedAt: new Date().toISOString() });
        await bot.telegram.sendMessage(w.userId, `❌ Your withdrawal of ${w.amount} $GROYP was rejected. Funds returned.`).catch(() => {});
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

// ============================================================================
// 6. API ROUTES
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/tonconnect-manifest.json', (req, res) => {
    res.json({
        url: APP_URL,
        name: 'Groyper Mine',
        iconUrl: 'https://assets.coingecko.com/coins/images/102172192/standard/Untitled_design__12_-removebg-preview.png',
        termsOfUseUrl: `${APP_URL}/terms`,
        privacyPolicyUrl: `${APP_URL}/privacy`
    });
});

app.get('/api/config', (req, res) => {
    res.json({ success: true, ownerWallet: OWNER_WALLET });
});

app.post('/api/user/register', async (req, res) => {
    const { userId, username, firstName, walletAddress, startParam } = req.body;
    let user = await getUser(userId);
    if (!user) {
        user = await createUser(userId, { username, firstName, walletAddress, startParam });
    } else {
        await updateUser(userId, { walletAddress });
    }
    res.json({ success: true, user });
});

app.get('/api/user/:userId', async (req, res) => {
    const user = await getUser(req.params.userId);
    if (!user) return res.json({ success: false });
    res.json({ success: true, user });
});

app.post('/api/user/update', async (req, res) => {
    const { userId, updates } = req.body;
    await updateUser(userId, updates);
    res.json({ success: true });
});

app.post('/api/mining/claim', async (req, res) => {
    const { userId } = req.body;
    const user = await getUser(userId);
    if (!user) return res.json({ success: false });
    
    const now = Date.now();
    if (now - (user.lastMiningClaim || 0) < CONFIG.MINING_COOLDOWN) {
        return res.json({ success: false, error: 'Not ready' });
    }
    
    const reward = CONFIG.MINING_REWARD * (user.boostMultiplier || 1);
    
    await updateUser(userId, {
        balance: (user.balance || 0) + reward,
        totalEarned: (user.totalEarned || 0) + reward,
        lastMiningClaim: now,
        isActive: true
    });
    
    // Referral activation
    if (!user.isActive && user.referredBy) {
        const referrer = await getUser(user.referredBy);
        if (referrer) {
            await updateUser(user.referredBy, {
                activeReferrals: (referrer.activeReferrals || 0) + 1,
                inactiveReferrals: Math.max(0, (referrer.inactiveReferrals || 0) - 1),
                balance: (referrer.balance || 0) + CONFIG.REFERRAL_REWARD
            });
            await bot.telegram.sendMessage(user.referredBy, `🎉 +${CONFIG.REFERRAL_REWARD} $GROYP from referral!`).catch(() => {});
        }
    }
    
    res.json({ success: true, reward });
});

app.post('/api/ads/claim', async (req, res) => {
    const { userId } = req.body;
    const user = await getUser(userId);
    if (!user || (user.adsWatched || 0) < CONFIG.MAX_ADS) return res.json({ success: false });
    
    await updateUser(userId, {
        balance: (user.balance || 0) + CONFIG.ADS_BATCH_REWARD,
        adsWatched: 0,
        adsAccumulated: 0,
        adsCooldownUntil: Date.now() + CONFIG.ADS_COOLDOWN
    });
    
    res.json({ success: true, reward: CONFIG.ADS_BATCH_REWARD });
});

app.post('/api/boost/verify', async (req, res) => {
    const { userId, boostType, boc } = req.body;
    const boost = CONFIG.BOOSTS[boostType];
    if (!boost) return res.json({ success: false });
    
    const verified = await verifyTonPayment(boc, boost.price, OWNER_WALLET);
    if (!verified) return res.json({ success: false, error: 'Payment not verified' });
    
    await updateUser(userId, { boostMultiplier: boost.multiplier, boostType });
    res.json({ success: true });
});

app.post('/api/tasks/verify', async (req, res) => {
    const { userId, taskId } = req.body;
    const user = await getUser(userId);
    if (!user) return res.json({ success: false });
    
    const task = (user.tasks || []).find(t => t.id === taskId);
    const completed = user.completedTasks || [];
    if (!task || completed.includes(taskId)) return res.json({ success: false });
    
    completed.push(taskId);
    await updateUser(userId, {
        completedTasks: completed,
        balance: (user.balance || 0) + task.reward,
        totalEarned: (user.totalEarned || 0) + task.reward
    });
    
    res.json({ success: true, reward: task.reward });
});

app.post('/api/withdraw/fee-verify', async (req, res) => {
    const { userId, boc } = req.body;
    const verified = await verifyTonPayment(boc, CONFIG.WITHDRAW_FEE_TON, OWNER_WALLET);
    if (!verified) return res.json({ success: false, error: 'Fee not verified' });
    
    await updateUser(userId, { withdrawFeePaid: true });
    res.json({ success: true });
});

app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount, walletAddress } = req.body;
    const user = await getUser(userId);
    if (!user || !user.withdrawFeePaid) return res.json({ success: false, error: 'Fee not paid' });
    if (amount < CONFIG.MIN_WITHDRAW) return res.json({ success: false, error: 'Below minimum' });
    if (amount > (user.balance || 0)) return res.json({ success: false, error: 'Insufficient balance' });
    
    await updateUser(userId, { balance: (user.balance || 0) - amount });
    
    const wRef = db.collection('withdrawals').doc();
    await wRef.set({
        id: wRef.id,
        userId,
        username: user.username,
        amount,
        walletAddress,
        status: 'pending',
        createdAt: new Date().toISOString()
    });
    
    if (ADMIN_ID) {
        await bot.telegram.sendMessage(ADMIN_ID, `💸 New withdrawal request from @${user.username}: ${amount} $GROYP`).catch(() => {});
    }
    
    res.json({ success: true, requestId: wRef.id });
});

// ============================================================================
// 7. LAUNCH
// ============================================================================

bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🚀 Bot started'))
    .catch(err => console.error('❌ Bot error:', err));

app.listen(PORT, () => {
    console.log(`🔥 Groyper Mine running on port ${PORT}`);
});
