// ============================================================================
// GROYPER MINE - EMBER VAULT EDITION
// Backend Server + Telegram Bot - FULL VERSION (server.js)
// ============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// 1. SECRETS & CONFIG
// ============================================================================

let serviceAccount = null;
let ADMIN_ID = null;
let BOT_TOKEN = process.env.BOT_TOKEN;
let OWNER_WALLET = process.env.OWNER_WALLET;
let APP_URL = process.env.APP_URL;

try {
    if (fs.existsSync('/etc/secrets/firebase-admin-key.json')) {
        serviceAccount = JSON.parse(fs.readFileSync('/etc/secrets/firebase-admin-key.json', 'utf8'));
        console.log('✅ Firebase Admin loaded');
    }
    if (fs.existsSync('/etc/secrets/admin-config.json')) {
        ADMIN_ID = JSON.parse(fs.readFileSync('/etc/secrets/admin-config.json', 'utf8')).admin_id;
        console.log(`✅ Admin ID: ${ADMIN_ID}`);
    }
} catch (e) { console.error('Secrets Error:', e.message); }

const CONFIG = {
    tokenSymbol: 'GROYP',
    channelUrl: 'https://t.me/GroyperMine',
    channelUsername: '@GroyperMine',
    groupUrl: 'https://t.me/communityGroyper',
    groupUsername: '@communityGroyper',
    dexUrl: 'https://dedust.io/swap/TON/EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    MINING_REWARD: 20,
    MINING_COOLDOWN: 6 * 60 * 60 * 1000,
    ADS_BATCH_REWARD: 20,
    ADS_COOLDOWN: 6 * 60 * 60 * 1000,
    MAX_ADS: 10,
    REFERRAL_REWARD: 75,
    MILESTONES: [
        { count: 100, reward: 2500 },
        { count: 250, reward: 5000 },
        { count: 500, reward: 10000 }
    ],
    MIN_WITHDRAW: 2000,
    WITHDRAW_FEE_TON: 0.1,
    BOOSTS: {
        bronze: { price: 1, multiplier: 2, name: 'BRONZE' },
        silver: { price: 5, multiplier: 5, name: 'SILVER' },
        gold: { price: 10, multiplier: 12, name: 'GOLD' }
    },
    DEFAULT_TASKS: [
        { id: 'join_channel', name: 'Join Telegram Channel', url: 'https://t.me/GroyperMine', reward: 50, icon: 'fa-telegram', verify: 'channel' },
        { id: 'join_group', name: 'Join Community Group', url: 'https://t.me/communityGroyper', reward: 50, icon: 'fa-users', verify: 'group' },
        { id: 'follow_twitter', name: 'Follow on Twitter/X', url: 'https://x.com/GroyperMine', reward: 50, icon: 'fa-twitter', verify: 'none' }
    ]
};

// ============================================================================
// 2. FIREBASE
// ============================================================================

const admin = require('firebase-admin');
let db = null;

if (serviceAccount) {
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('🔥 Firebase initialized');
}

// ============================================================================
// 3. USER HELPERS
// ============================================================================

async function getUser(userId) {
    if (!db) return null;
    const doc = await db.collection('users').doc(String(userId)).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function createUser(userId, data) {
    if (!db) return null;
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
        boostType: null,
        adsWatched: 0,
        adsAccumulated: 0,
        adsCooldownUntil: 0,
        completedTasks: [],
        activeReferrals: 0,
        inactiveReferrals: 0,
        referrals: [],
        referredBy: data.startParam || null,
        claimedMilestones: [],
        isActive: false,
        withdrawFeePaid: false,
        createdAt: new Date().toISOString()
    };
    await db.collection('users').doc(String(userId)).set(userData);
    return userData;
}

async function updateUser(userId, updates) {
    if (!db) return false;
    await db.collection('users').doc(String(userId)).update(updates);
    return true;
}

async function getTasks() {
    if (!db) return CONFIG.DEFAULT_TASKS;
    const doc = await db.collection('settings').doc('tasks').get();
    if (!doc.exists) {
        await db.collection('settings').doc('tasks').set({ list: CONFIG.DEFAULT_TASKS });
        return CONFIG.DEFAULT_TASKS;
    }
    return doc.data().list || CONFIG.DEFAULT_TASKS;
}

// ============================================================================
// 4. TON PAYMENT VERIFICATION
// ============================================================================

async function verifyTonPayment(boc, expectedAmountTon, expectedReceiver) {
    try {
        if (!boc) return false;

        const usedDoc = await db.collection('used_payments').doc(boc.substring(0, 60)).get();
        if (usedDoc.exists) {
            console.error('❌ Replay attack detected');
            return false;
        }

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
            console.error('❌ TON API parse failed');
            return false;
        }

        await new Promise(r => setTimeout(r, 5000));

        const txResponse = await fetch(`https://tonapi.io/v2/blockchain/transactions/${apiData.hash}`, {
            headers: { 'Authorization': `Bearer ${process.env.TON_API_KEY || ''}` }
        });
        const txData = await txResponse.json();

        if (!txData || !txData.in_msg) {
            console.error('❌ Transaction not found');
            return false;
        }

        const valueInTon = parseFloat(txData.in_msg.value || 0) / 1e9;
        const receiver = txData.in_msg.destination?.address;

        if (valueInTon < expectedAmountTon * 0.99) {
            console.error(`❌ Amount mismatch: ${valueInTon} < ${expectedAmountTon}`);
            return false;
        }

        if (receiver && expectedReceiver && receiver.toLowerCase() !== expectedReceiver.toLowerCase()) {
            console.error(`❌ Receiver mismatch: ${receiver} != ${expectedReceiver}`);
            return false;
        }

        await db.collection('used_payments').doc(apiData.hash).set({
            boc, amount: valueInTon, receiver, usedAt: new Date().toISOString()
        });

        console.log(`✅ Payment verified: ${valueInTon} TON`);
        return true;
    } catch (e) {
        console.error('TON Verify Error:', e.message);
        return false;
    }
}

// ============================================================================
// 5. CHANNEL VERIFICATION
// ============================================================================

async function checkChannelMembership(userId, channelUsername) {
    try {
        const member = await bot.telegram.getChatMember(channelUsername, parseInt(userId));
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (e) {
        console.error('Channel check error:', e.message);
        return false;
    }
}

// ============================================================================
// 6. BOT SETUP
// ============================================================================

const bot = new Telegraf(BOT_TOKEN);
bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

const adminSessions = new Map();

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const startParam = ctx.startPayload;
    const userName = ctx.from.first_name || 'User';
    const userHandle = ctx.from.username || '';

    let user = await getUser(userId);
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
});

// ============================================================================
// 7. ADMIN PANEL
// ============================================================================

bot.command('admin', async (ctx) => {
    const userId = String(ctx.from.id);
    if (userId !== String(ADMIN_ID)) return ctx.reply('⛔ Access Denied');

    const usersSnap = await db.collection('users').get();
    const pendingSnap = await db.collection('withdrawals').where('status', '==', 'pending').get();

    let totalBalance = 0;
    usersSnap.forEach(doc => totalBalance += doc.data().balance || 0);

    const msg = `
👑 <b>Admin Panel</b>

👥 <b>Total Users:</b> ${usersSnap.size}
💰 <b>Total Balance:</b> ${totalBalance.toLocaleString()} $GROYP
📤 <b>Pending Withdrawals:</b> ${pendingSnap.size}
    `;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📋 Pending Withdrawals', 'admin_withdrawals')],
        [Markup.button.callback('📝 Manage Tasks', 'admin_tasks')],
        [Markup.button.callback('📢 Broadcast', 'admin_broadcast')]
    ]);

    await ctx.replyWithHTML(msg, keyboard);
});

bot.action('admin_withdrawals', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();

    const snap = await db.collection('withdrawals').where('status', '==', 'pending').limit(10).get();

    if (snap.empty) return ctx.reply('✅ No pending withdrawals');

    for (const doc of snap.docs) {
        const w = doc.data();
        const msg = `
💸 <b>Withdrawal Request</b>

👤 User: @${w.username}
🆔 ID: <code>${w.userId}</code>
💰 Amount: <b>${w.amount} $GROYP</b>
💳 Wallet: <code>${w.walletAddress}</code>
📅 Date: ${new Date(w.createdAt).toLocaleString()}
        `;

        const kb = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Approve', `approve_${doc.id}`),
                Markup.button.callback('❌ Reject', `reject_${doc.id}`)
            ]
        ]);

        await ctx.replyWithHTML(msg, kb);
    }
});

bot.action(/approve_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery('✅ Approved');
    const id = ctx.match[1];

    const doc = await db.collection('withdrawals').doc(id).get();
    if (doc.exists) {
        const w = doc.data();
        const user = await getUser(w.userId);
        await updateUser(w.userId, {
            totalWithdrawn: (user.totalWithdrawn || 0) + w.amount
        });
        await db.collection('withdrawals').doc(id).update({
            status: 'approved',
            approvedAt: new Date().toISOString()
        });
        await bot.telegram.sendMessage(w.userId, `✅ Your withdrawal of ${w.amount} $GROYP has been approved! Funds will be sent to your wallet shortly.`).catch(() => {});
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.action(/reject_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery('❌ Rejected');
    const id = ctx.match[1];

    const doc = await db.collection('withdrawals').doc(id).get();
    if (doc.exists) {
        const w = doc.data();
        const user = await getUser(w.userId);
        await updateUser(w.userId, { balance: (user.balance || 0) + w.amount });
        await db.collection('withdrawals').doc(id).update({
            status: 'rejected',
            rejectedAt: new Date().toISOString()
        });
        await bot.telegram.sendMessage(w.userId, `❌ Your withdrawal of ${w.amount} $GROYP was rejected. Funds returned to your balance.`).catch(() => {});
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.action('admin_tasks', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();

    const tasks = await getTasks();
    let msg = '📝 <b>Current Tasks:</b>\n\n';
    tasks.forEach((t, i) => {
        msg += `${i + 1}. <b>${t.name}</b>\n   Reward: ${t.reward} $GROYP\n   URL: ${t.url}\n\n`;
    });

    const kb = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Task', 'task_add')],
        [Markup.button.callback('🗑️ Delete Task', 'task_delete_menu')],
        [Markup.button.callback('🔙 Back', 'admin_back')]
    ]);

    await ctx.replyWithHTML(msg, kb);
});

bot.action('task_add', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();
    adminSessions.set(String(ctx.from.id), { step: 'add_task_name' });
    await ctx.reply('Send the task name:');
});

bot.action('task_delete_menu', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();

    const tasks = await getTasks();
    const buttons = tasks.map(t => [Markup.button.callback(`🗑️ ${t.name}`, `task_del_${t.id}`)]);
    buttons.push([Markup.button.callback('🔙 Back', 'admin_tasks')]);

    await ctx.reply('Select task to delete:', Markup.inlineKeyboard(buttons));
});

bot.action(/task_del_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery('Deleted');
    const taskId = ctx.match[1];

    const tasks = await getTasks();
    const filtered = tasks.filter(t => t.id !== taskId);
    await db.collection('settings').doc('tasks').set({ list: filtered });

    await ctx.editMessageText(`✅ Task deleted. Remaining tasks: ${filtered.length}`);
});

bot.action('admin_back', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();
    adminSessions.delete(String(ctx.from.id));
    await ctx.editMessageText('👑 Admin Panel - use /admin to reopen');
});

bot.action('admin_broadcast', async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return;
    await ctx.answerCbQuery();
    adminSessions.set(String(ctx.from.id), { step: 'broadcast' });
    await ctx.reply('📢 Send the broadcast message now:');
});

// Admin state machine (text messages)
bot.on('text', async (ctx) => {
    const userId = String(ctx.from.id);
    if (userId !== String(ADMIN_ID)) return;
    const session = adminSessions.get(userId);
    if (!session) return;

    if (session.step === 'add_task_name') {
        adminSessions.set(userId, { step: 'add_task_url', name: ctx.message.text });
        await ctx.reply('Now send the task URL:');
        return;
    }

    if (session.step === 'add_task_url') {
        adminSessions.set(userId, { step: 'add_task_reward', name: session.name, url: ctx.message.text });
        await ctx.reply('Now send the reward amount (number):');
        return;
    }

    if (session.step === 'add_task_reward') {
        const reward = parseInt(ctx.message.text);
        if (isNaN(reward)) return ctx.reply('❌ Invalid number. Send again:');

        const tasks = await getTasks();
        const newTask = {
            id: `task_${Date.now()}`,
            name: session.name,
            url: session.url,
            reward,
            icon: 'fa-link',
            verify: 'none'
        };
        tasks.push(newTask);
        await db.collection('settings').doc('tasks').set({ list: tasks });

        adminSessions.delete(userId);
        await ctx.reply(`✅ Task "${session.name}" added successfully!`);
        return;
    }

    if (session.step === 'broadcast') {
        const usersSnap = await db.collection('users').get();
        let sent = 0, failed = 0;
        for (const doc of usersSnap.docs) {
            try {
                await bot.telegram.sendMessage(doc.id, `📢 <b>Announcement</b>\n\n${ctx.message.text}`, { parse_mode: 'HTML' });
                sent++;
                await new Promise(r => setTimeout(r, 50));
            } catch (e) { failed++; }
        }
        adminSessions.delete(userId);
        await ctx.reply(`✅ Broadcast sent to ${sent} users (${failed} failed).`);
        return;
    }
});

// ============================================================================
// 8. API ROUTES
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/tonconnect-manifest.json', (req, res) => {
    res.json({
        url: APP_URL,
        name: 'Groyper Mine',
        iconUrl: 'https://assets.coingecko.com/coins/images/102172192/standard/Untitled_design__12_-removebg-preview.png'
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

    const wSnap = await db.collection('withdrawals')
        .where('userId', '==', req.params.userId)
        .orderBy('createdAt', 'desc')
        .limit(10).get();

    user.withdrawals = wSnap.docs.map(d => d.data());
    user.tasks = await getTasks();

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
        return res.json({ success: false, error: 'Not ready yet' });
    }

    const reward = CONFIG.MINING_REWARD * (user.boostMultiplier || 1);
    const wasInactive = !user.isActive;

    await updateUser(userId, {
        balance: (user.balance || 0) + reward,
        totalEarned: (user.totalEarned || 0) + reward,
        lastMiningClaim: now,
        isActive: true
    });

    if (wasInactive && user.referredBy) {
        const referrer = await getUser(user.referredBy);
        if (referrer) {
            const refs = referrer.referrals || [];
            const updatedRefs = refs.map(r =>
                r.userId === String(userId) ? { ...r, isActive: true } : r
            );
            await updateUser(user.referredBy, {
                activeReferrals: (referrer.activeReferrals || 0) + 1,
                inactiveReferrals: Math.max(0, (referrer.inactiveReferrals || 0) - 1),
                balance: (referrer.balance || 0) + CONFIG.REFERRAL_REWARD,
                totalEarned: (referrer.totalEarned || 0) + CONFIG.REFERRAL_REWARD,
                referrals: updatedRefs
            });
            await bot.telegram.sendMessage(
                user.referredBy,
                `🎉 +${CONFIG.REFERRAL_REWARD} $GROYP from your referral @${user.username} (now active!)`
            ).catch(() => {});
        }
    }

    res.json({ success: true, reward });
});

app.post('/api/ads/claim', async (req, res) => {
    const { userId } = req.body;
    const user = await getUser(userId);
    if (!user || (user.adsWatched || 0) < CONFIG.MAX_ADS) {
        return res.json({ success: false, error: 'Not enough ads watched' });
    }

    await updateUser(userId, {
        balance: (user.balance || 0) + CONFIG.ADS_BATCH_REWARD,
        totalEarned: (user.totalEarned || 0) + CONFIG.ADS_BATCH_REWARD,
        adsWatched: 0,
        adsAccumulated: 0,
        adsCooldownUntil: Date.now() + CONFIG.ADS_COOLDOWN
    });

    res.json({ success: true, reward: CONFIG.ADS_BATCH_REWARD });
});

app.post('/api/boost/verify', async (req, res) => {
    const { userId, boostType, boc } = req.body;
    const boost = CONFIG.BOOSTS[boostType];
    if (!boost) return res.json({ success: false, error: 'Invalid boost' });

    const verified = await verifyTonPayment(boc, boost.price, OWNER_WALLET);
    if (!verified) return res.json({ success: false, error: 'Payment verification failed' });

    await updateUser(userId, {
        boostMultiplier: boost.multiplier,
        boostType,
        boostExpiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000)
    });

    res.json({ success: true });
});

app.post('/api/tasks/verify', async (req, res) => {
    const { userId, taskId } = req.body;
    const user = await getUser(userId);
    if (!user) return res.json({ success: false });

    const tasks = await getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return res.json({ success: false, error: 'Task not found' });

    const completed = user.completedTasks || [];
    if (completed.includes(taskId)) return res.json({ success: false, error: 'Already completed' });

    if (task.verify === 'channel') {
        const isMember = await checkChannelMembership(userId, CONFIG.channelUsername);
        if (!isMember) return res.json({ success: false, error: 'Please join the channel first' });
    }
    if (task.verify === 'group') {
        const isMember = await checkChannelMembership(userId, CONFIG.groupUsername);
        if (!isMember) return res.json({ success: false, error: 'Please join the group first' });
    }

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
    if (!verified) return res.json({ success: false, error: 'Fee verification failed' });

    await updateUser(userId, { withdrawFeePaid: true });
    res.json({ success: true });
});

app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount, walletAddress } = req.body;
    const user = await getUser(userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    if (!user.withdrawFeePaid) return res.json({ success: false, error: 'Pay the anti-bot fee first' });
    if (amount < CONFIG.MIN_WITHDRAW) return res.json({ success: false, error: `Minimum ${CONFIG.MIN_WITHDRAW}` });
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
        await bot.telegram.sendMessage(ADMIN_ID,
            `💸 <b>New Withdrawal Request</b>\n\n👤 @${user.username}\n💰 ${amount} $GROYP\n💳 <code>${walletAddress}</code>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }

    res.json({ success: true, requestId: wRef.id });
});

// ============================================================================
// 9. LAUNCH
// ============================================================================

async function initSettings() {
    if (!db) return;
    const doc = await db.collection('settings').doc('tasks').get();
    if (!doc.exists) {
        await db.collection('settings').doc('tasks').set({ list: CONFIG.DEFAULT_TASKS });
        console.log('✅ Default tasks initialized');
    }
}

bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🚀 Bot started'))
    .catch(err => console.error('❌ Bot error:', err));

app.listen(PORT, async () => {
    await initSettings();
    console.log(`
╔══════════════════════════════════════════════════════╗
║         GROYPER MINE - EMBER VAULT v1.0              ║
╠══════════════════════════════════════════════════════╣
║  📍 Port: ${PORT}
║  🔥 Firebase: ${db ? '✅' : '❌'}
║  👑 Admin: ${ADMIN_ID ? '✅' : '❌'}
║  🤖 Bot: ${BOT_TOKEN ? '✅' : '❌'}
║  💰 Owner: ${OWNER_WALLET ? '✅' : '❌'}
╚══════════════════════════════════════════════════════╝
    `);
});
