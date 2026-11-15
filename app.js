// ============================================================================
// GROYPER MINE - EMBER VAULT EDITION (app.js)
// ============================================================================

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#0A0B10'); tg.setBackgroundColor('#0A0B10'); }

const CONFIG = {
    tokenSymbol: 'GROYP',
    tokenAddress: 'EQBvcsqG7hqsw-HQ8bemIYrO8I_GLDTSbNiro4WOC7jAG_CH',
    botUsername: 'GroyperMinebot',
    MINING_REWARD: 20,
    MINING_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    REWARD_PER_AD: 2,
    MAX_ADS_PER_BATCH: 10,
    ADS_BATCH_REWARD: 20,
    ADS_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    REFERRAL_REWARD: 75,
    MILESTONES: [{ count: 100, reward: 2500 }, { count: 250, reward: 5000 }, { count: 500, reward: 10000 }],
    MIN_WITHDRAW: 2000,
    WITHDRAW_FEE_TON: 0.1,
    BOOSTS: {
        bronze: { price: 1, multiplier: 2, name: 'BRONZE', icon: '🥉' },
        silver: { price: 5, multiplier: 5, name: 'SILVER', icon: '🥈' },
        gold: { price: 10, multiplier: 12, name: 'GOLD', icon: '🥇' }
    }
};

let currentUser = null;
let userId = null;
let tonConnected = false;
let tonWalletAddress = null;
let isClaimingMining = false;
let isClaimingAds = false;
let isProcessingWithdraw = false;
let adSequenceActive = false;
let miningTimer = null;
let livePriceData = { price: 0, change24h: 0 };
let adsState = { watched: 0, accumulated: 0 };

// ============================================================================
// UTILITIES
// ============================================================================
function showToast(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    toast.classList.remove('hidden');
    toast.style.borderColor = type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--border-light)';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatTimeLeft(ms) {
    if (ms <= 0) return '00:00:00';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function vibrate(type = 'light') {
    if (tg?.HapticFeedback) {
        if (type === 'light') tg.HapticFeedback.impactOccurred('light');
        if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
        if (type === 'error') tg.HapticFeedback.notificationOccurred('error');
    }
}

async function apiRequest(endpoint, options = {}) {
    try {
        const res = await fetch(endpoint, { headers: { 'Content-Type': 'application/json' }, ...options });
        return await res.json();
    } catch (e) {
        console.error('API Error:', e);
        return { success: false, error: 'Network error' };
    }
}

// ============================================================================
// TON CONNECT (Fixed)
// ============================================================================
function initTonConnect() {
    const container = document.getElementById('ton-connect-btn');
    if (!container || typeof TON_CONNECT_UI === 'undefined') return;

    try {
        window.tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
            manifestUrl: window.location.origin + '/tonconnect-manifest.json',
            buttonRootId: 'ton-connect-btn'
        });
        
        window.tonConnectUI.onStatusChange(async wallet => {
            if (wallet) {
                tonConnected = true;
                tonWalletAddress = wallet.account.address;
                updateHeaderWallet();
                await checkAndProceed(); // الانتقال للتطبيق
            } else {
                tonConnected = false;
                tonWalletAddress = null;
            }
        });
    } catch(e) {
        console.error('TON Connect Error:', e);
    }
}

// ============================================================================
// USER DATA
// ============================================================================
async function fetchUserData() {
    if (!userId) return;
    const res = await apiRequest(`/api/user/${userId}`);
    if (res.success) {
        currentUser = res.user;
        updateHeaderWallet();
        updateMiningUI();
        initAdsState();
        renderTasks(res.user.tasks || [], res.user.completedTasks || []);
        renderReferral();
        renderWallet();
    }
}

async function checkAndProceed() {
    if (!tonConnected || !tonWalletAddress) return;
    
    const res = await apiRequest('/api/user/register', {
        method: 'POST',
        body: JSON.stringify({
            userId,
            username: tg?.initDataUnsafe?.user?.username || 'user',
            firstName: tg?.initDataUnsafe?.user?.first_name || 'User',
            avatar: tg?.initDataUnsafe?.user?.photo_url || '',
            walletAddress: tonWalletAddress,
            startParam: tg?.initDataUnsafe?.start_param || null
        })
    });
    
    if (res.success) {
        document.getElementById('onboardingScreen').classList.remove('active');
        document.getElementById('mainApp').style.display = 'block';
        
        document.getElementById('userAvatar').src = tg?.initDataUnsafe?.user?.photo_url || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff';
        document.getElementById('userName').textContent = tg?.initDataUnsafe?.user?.first_name || 'User';
        document.getElementById('userHandle').textContent = `@${tg?.initDataUnsafe?.user?.username || 'user'}`;

        await fetchTokenPrice();
        await fetchUserData();
        startMiningTimer();
    } else {
        showToast('Registration failed. Please try again.', 'error');
    }
}

// ============================================================================
// DEXSCREENER
// ============================================================================
async function fetchTokenPrice() {
    try {
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/ton/${CONFIG.tokenAddress}`);
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            const pair = data[0];
            livePriceData = { price: parseFloat(pair.priceUsd) || 0, change24h: parseFloat(pair.priceChange?.h24) || 0 };
            renderTokenCard(pair);
            updateHeaderWallet();
        }
    } catch(e) { console.error(e); }
}

function renderTokenCard(pair) {
    document.getElementById('tokenPrice').textContent = `$${livePriceData.price.toFixed(8)}`;
    document.getElementById('tokenMarketCap').textContent = `$${(parseFloat(pair.marketCap) || 0).toLocaleString()}`;
    document.getElementById('tokenFdv').textContent = `$${(parseFloat(pair.fdv) || 0).toLocaleString()}`;
    document.getElementById('tokenLiquidity').textContent = `$${(parseFloat(pair.liquidity?.usd) || 0).toLocaleString()}`;
    document.getElementById('tokenVolume').textContent = `$${(parseFloat(pair.volume?.h24) || 0).toLocaleString()}`;
    
    const changeEl = document.getElementById('tokenChange');
    changeEl.textContent = `${livePriceData.change24h >= 0 ? '+' : ''}${livePriceData.change24h.toFixed(2)}%`;
    changeEl.className = `token-change ${livePriceData.change24h >= 0 ? 'positive' : 'negative'}`;
}

// ============================================================================
// UI UPDATES
// ============================================================================
function updateHeaderWallet() {
    if (currentUser) {
        document.getElementById('headerBalance').textContent = `${(currentUser.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
        document.getElementById('headerValue').textContent = `≈ $${((currentUser.balance || 0) * livePriceData.price).toFixed(2)}`;
    }
    if (tonWalletAddress) {
        document.getElementById('headerAddress').innerHTML = `<i class="fas fa-wallet"></i> ${tonWalletAddress.slice(0, 4)}...${tonWalletAddress.slice(-4)}`;
    }
}

// ============================================================================
// MINING
// ============================================================================
function getMiningData() {
    if (!currentUser) return { canClaim: false, remainingMs: 0, progress: 0, reward: 0 };
    const elapsed = Date.now() - (currentUser.lastMiningClaim || 0);
    const remaining = Math.max(0, CONFIG.MINING_COOLDOWN_MS - elapsed);
    return {
        canClaim: remaining <= 0,
        remainingMs: remaining,
        progress: Math.min(100, (elapsed / CONFIG.MINING_COOLDOWN_MS) * 100),
        reward: CONFIG.MINING_REWARD * (currentUser.boostMultiplier || 1)
    };
}

function updateMiningUI() {
    if (!currentUser) return;
    const data = getMiningData();
    const ring = document.getElementById('ringProgress');
    
    if (ring) {
        const circ = 2 * Math.PI * 90;
        ring.style.strokeDashoffset = circ - (data.progress / 100) * circ;
        ring.style.strokeDasharray = circ;
        ring.classList.toggle('active', data.canClaim);
    }
    
    document.getElementById('minedAmount').textContent = data.reward;
    document.getElementById('minedUsd').textContent = `≈ $${(data.reward * livePriceData.price).toFixed(2)}`;
    document.getElementById('miningTimer').textContent = data.canClaim ? 'READY' : formatTimeLeft(data.remainingMs);
    document.getElementById('hashPower').textContent = `${currentUser.boostMultiplier || 1}x`;
    
    const btn = document.getElementById('claimMiningBtn');
    btn.disabled = !data.canClaim;
    btn.innerHTML = data.canClaim ? `<i class="fas fa-fire"></i> CLAIM ${data.reward} ${CONFIG.tokenSymbol}` : `<i class="fas fa-fire"></i> CLAIM MINING`;
}

function startMiningTimer() {
    if (miningTimer) clearInterval(miningTimer);
    miningTimer = setInterval(updateMiningUI, 1000);
}

async function claimMining() {
    if (isClaimingMining) return;
    const data = getMiningData();
    if (!data.canClaim) return showToast('Not ready', 'warning');
    
    isClaimingMining = true;
    const res = await apiRequest('/api/mining/claim', { method: 'POST', body: JSON.stringify({ userId }) });
    
    if (res.success) {
        showToast(`✅ +${res.reward} claimed!`, 'success');
        vibrate('success');
        await fetchUserData();
    } else {
        showToast(res.error, 'error');
    }
    isClaimingMining = false;
}

// ============================================================================
// ADS & TASKS
// ============================================================================
function initAdsState() {
    if (!currentUser) return;
    adsState.watched = currentUser.adsWatched || 0;
    adsState.accumulated = currentUser.adsAccumulated || 0;
    renderAdsUI();
}

function renderAdsUI() {
    const container = document.getElementById('adsSegments');
    let html = '';
    for (let i = 0; i < CONFIG.MAX_ADS_PER_BATCH; i++) {
        html += `<div class="ads-segment ${i < adsState.watched ? 'active' : ''}"></div>`;
    }
    container.innerHTML = html;
    
    document.getElementById('adsAccumulated').textContent = `${adsState.accumulated} ${CONFIG.tokenSymbol}`;
    document.getElementById('adsCounter').textContent = `${adsState.watched}/${CONFIG.MAX_ADS_PER_BATCH}`;
    
    const isComplete = adsState.watched >= CONFIG.MAX_ADS_PER_BATCH;
    document.getElementById('watchAdBtn').style.display = isComplete ? 'none' : 'flex';
    document.getElementById('claimAdsBtn').style.display = isComplete ? 'flex' : 'none';
}

async function watchAd() {
    if (adSequenceActive || adsState.watched >= CONFIG.MAX_ADS_PER_BATCH) return;
    adSequenceActive = true;
    showToast('Loading ad...', 'info');
    
    let success = false;
    try {
        if (typeof window.show_12265394 === 'function') {
            await window.show_12265394();
            success = true;
        }
    } catch(e) {}

    if (!success && window.TelegramAdsController) {
        try {
            await new Promise((res, rej) => {
                new TelegramAdsController().showRewardedVideo({ onReward: () => { success = true; res(); }, onError: rej });
            });
        } catch(e) {}
    }
    
    if (success) {
        adsState.watched += 1;
        adsState.accumulated += CONFIG.REWARD_PER_AD;
        vibrate('light');
        await apiRequest('/api/user/update', { method: 'POST', body: JSON.stringify({ userId, updates: { adsWatched: adsState.watched, adsAccumulated: adsState.accumulated } }) });
        renderAdsUI();
        showToast(`+${CONFIG.REWARD_PER_AD} ${CONFIG.tokenSymbol}!`, 'success');
    } else {
        showToast('No ad available', 'error');
    }
    adSequenceActive = false;
}

async function claimAdsReward() {
    if (isClaimingAds || adsState.watched < CONFIG.MAX_ADS_PER_BATCH) return;
    isClaimingAds = true;
    const res = await apiRequest('/api/ads/claim', { method: 'POST', body: JSON.stringify({ userId }) });
    if (res.success) {
        showToast(`✅ +${res.reward} added!`, 'success');
        await fetchUserData();
    }
    isClaimingAds = false;
}

function renderTasks(tasks, completed) {
    const container = document.getElementById('taskList');
    if (!container) return;
    if (tasks.length === 0) return container.innerHTML = '<div class="empty-state">No tasks</div>';
    
    container.innerHTML = tasks.map(t => {
        const done = completed.includes(t.id);
        return `
            <div class="task-item">
                <div class="task-icon"><i class="fas ${t.icon}"></i></div>
                <div class="task-info">
                    <div class="task-name">${t.name}</div>
                    <div class="task-reward">+${t.reward} ${CONFIG.tokenSymbol}</div>
                </div>
                <button class="task-btn ${done ? 'completed' : ''}" onclick="window.startTask('${t.id}')" ${done ? 'disabled' : ''}>
                    ${done ? '✓ DONE' : 'START'}
                </button>
            </div>`;
    }).join('');
}

window.startTask = async (taskId) => {
    const task = currentUser.tasks.find(t => t.id === taskId);
    if (task) {
        window.open(task.url, '_blank');
        showToast('Complete task, then click Verify', 'info');
        // Replace button with Verify
        const items = document.querySelectorAll('.task-item');
        items.forEach(item => {
            if (item.innerHTML.includes(task.name)) {
                const btn = item.querySelector('.task-btn');
                btn.textContent = 'VERIFY';
                btn.onclick = async () => {
                    const res = await apiRequest('/api/tasks/verify', { method: 'POST', body: JSON.stringify({ userId, taskId }) });
                    if (res.success) {
                        showToast(`✅ +${res.reward} earned!`, 'success');
                        vibrate('success');
                        await fetchUserData();
                    } else {
                        showToast(res.error, 'error');
                    }
                };
            }
        });
    }
};

// ============================================================================
// REFERRAL & WALLET
// ============================================================================
function renderReferral() {
    if (!currentUser) return;
    document.getElementById('activeReferrals').textContent = currentUser.activeReferrals || 0;
    document.getElementById('inactiveReferrals').textContent = currentUser.inactiveReferrals || 0;
    
    const milestoneList = document.getElementById('milestoneList');
    const claimed = currentUser.claimedMilestones || [];
    milestoneList.innerHTML = CONFIG.MILESTONES.map(m => `
        <div class="milestone-item ${claimed.includes(m.count) ? 'completed' : ''}">
            <div class="milestone-icon">${claimed.includes(m.count) ? '✅' : '🔒'}</div>
            <div class="milestone-info"><div class="milestone-count">${m.count} Referrals</div><div class="milestone-reward">+${m.reward} ${CONFIG.tokenSymbol}</div></div>
        </div>`).join('');
    
    const list = document.getElementById('referralList');
    if ((currentUser.referrals || []).length === 0) {
        list.innerHTML = '<div class="empty-state">No referrals yet</div>';
    } else {
        list.innerHTML = currentUser.referrals.map(r => `
            <div class="referral-item">
                <img src="https://ui-avatars.com/api/?name=${r.username}&background=FF4D00&color=fff">
                <span class="referral-item-name">@${r.username}</span>
                <span class="referral-status ${r.isActive ? 'active' : 'inactive'}">${r.isActive ? 'ACTIVE' : 'INACTIVE'}</span>
            </div>`).join('');
    }
}

function renderWallet() {
    if (!currentUser) return;
    document.getElementById('walletUserName').textContent = currentUser.username || 'User';
    document.getElementById('walletUserHandle').textContent = `@${currentUser.username || 'user'}`;
    document.getElementById('walletAvatar').src = tg?.initDataUnsafe?.user?.photo_url || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff';
    document.getElementById('totalWithdrawn').textContent = `${(currentUser.totalWithdrawn || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
    document.getElementById('availableToWithdraw').textContent = `${(currentUser.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
    document.getElementById('withdrawWalletAddress').textContent = tonWalletAddress ? `${tonWalletAddress.slice(0, 6)}...${tonWalletAddress.slice(-6)}` : 'Not connected';
    
    const history = document.getElementById('withdrawHistory');
    if ((currentUser.withdrawals || []).length === 0) {
        history.innerHTML = '<div class="empty-state">No withdrawals</div>';
    } else {
        history.innerHTML = currentUser.withdrawals.map(w => `
            <div class="history-item">
                <span class="history-amount">${w.amount} ${CONFIG.tokenSymbol}</span>
                <span class="history-status ${w.status}">${w.status.toUpperCase()}</span>
            </div>`).join('');
    }
}

async function submitWithdraw() {
    if (isProcessingWithdraw || !currentUser) return;
    const amount = parseFloat(document.getElementById('withdrawAmount').value) || 0;
    if (amount < CONFIG.MIN_WITHDRAW) return showToast(`Minimum ${CONFIG.MIN_WITHDRAW}`, 'error');
    if (amount > currentUser.balance) return showToast('Insufficient balance', 'error');
    
    isProcessingWithdraw = true;
    const btn = document.getElementById('withdrawBtn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> PROCESSING...';
    
    try {
        if (!currentUser.withdrawFeePaid) {
            const configRes = await apiRequest('/api/config');
            if (!configRes.ownerWallet) throw new Error('Config error');
            
            const result = await window.tonConnectUI.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 600,
                messages: [{ address: configRes.ownerWallet, amount: (CONFIG.WITHDRAW_FEE_TON * 1e9).toString() }]
            });
            
            const verify = await apiRequest('/api/withdraw/fee-verify', { method: 'POST', body: JSON.stringify({ userId, boc: result.boc }) });
            if (!verify.success) throw new Error('Fee verification failed');
            await fetchUserData();
        }
        
        const res = await apiRequest('/api/withdraw/request', { method: 'POST', body: JSON.stringify({ userId, amount, walletAddress: tonWalletAddress }) });
        if (res.success) {
            showToast('✅ Withdrawal submitted!', 'success');
            document.getElementById('withdrawAmount').value = '';
            await fetchUserData();
        } else {
            showToast(res.error, 'error');
        }
    } catch(e) {
        showToast(e.message || 'Failed', 'error');
    } finally {
        isProcessingWithdraw = false;
        btn.innerHTML = '<i class="fas fa-lock"></i> WITHDRAW';
    }
}

// ============================================================================
// NAVIGATION & INIT
// ============================================================================
function switchPage(pageName) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page${pageName.charAt(0).toUpperCase() + pageName.slice(1)}`).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === pageName));
    vibrate('light');
}

function init() {
    userId = tg?.initDataUnsafe?.user?.id?.toString() || new URLSearchParams(window.location.search).get('userId');
    if (!userId) return showToast('Open from Telegram', 'error');
    
    initTonConnect();
    
    document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => switchPage(item.dataset.page)));
    document.getElementById('claimMiningBtn').onclick = claimMining;
    document.getElementById('watchAdBtn').onclick = watchAd;
    document.getElementById('claimAdsBtn').onclick = claimAdsReward;
    document.getElementById('withdrawBtn').onclick = submitWithdraw;
    
    document.getElementById('copyReferralBtn').onclick = () => {
        navigator.clipboard.writeText(`https://t.me/GroyperMinebot/Mine?startapp=${userId}`);
        showToast('Link copied!', 'success');
    };
    document.getElementById('shareReferralBtn').onclick = () => {
        const link = `https://t.me/GroyperMinebot/Mine?startapp=${userId}`;
        window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=Join Groyper Mine!`);
    };
    document.getElementById('refreshTokenBtn').onclick = fetchTokenPrice;
    document.getElementById('copyContractBtn').onclick = () => {
        navigator.clipboard.writeText(CONFIG.tokenAddress);
        showToast('Contract copied!', 'success');
    };
    document.getElementById('maxWithdrawBtn').onclick = () => {
        document.getElementById('withdrawAmount').value = Math.floor(currentUser?.balance || 0);
    };
    
    window.buyBoost = async (type) => {
        if (!tonConnected) return showToast('Connect wallet first', 'warning');
        const boost = CONFIG.BOOSTS[type];
        if (!confirm(`Activate ${boost.name} Boost for ${boost.price} TON?`)) return;
        
        try {
            const configRes = await apiRequest('/api/config');
            const result = await window.tonConnectUI.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 600,
                messages: [{ address: configRes.ownerWallet, amount: (boost.price * 1e9).toString() }]
            });
            const verify = await apiRequest('/api/boost/verify', { method: 'POST', body: JSON.stringify({ userId, boostType: type, boc: result.boc }) });
            if (verify.success) {
                showToast(`🔥 ${boost.name} Boost activated!`, 'success');
                await fetchUserData();
            } else {
                showToast(verify.error, 'error');
            }
        } catch(e) { showToast('Payment failed', 'error'); }
    };
    
    // Check if already connected
    if (window.tonConnectUI?.wallet) {
        tonConnected = true;
        tonWalletAddress = window.tonConnectUI.wallet.account.address;
        checkAndProceed();
    }
}

init();
