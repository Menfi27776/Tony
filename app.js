
// ============================================================================
// GROYPER MINE - EMBER VAULT EDITION
// Front-End Application Logic (app.js)
// Version: 1.0.0
// ============================================================================

const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor('#0A0B10');
    tg.setBackgroundColor('#0A0B10');
    console.log('🔥 Groyper Mine Ready');
}

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const CONFIG = {
    tokenName: 'Groyper',
    tokenSymbol: 'GROYP',
    tokenAddress: 'EQBvcsqG7hqsw-HQ8bemIYrO8I_GLDTSbNiro4WOC7jAG_CH',
    botUsername: 'GroyperMinebot',
    appUrl: 'https://t.me/GroyperMinebot/Mine',
    tokenLogo: 'https://assets.coingecko.com/coins/images/102172192/standard/Untitled_design__12_-removebg-preview.png?1772078553',
    
    // Mining
    MINING_REWARD: 20,
    MINING_COOLDOWN_MS: 6 * 60 * 60 * 1000, // 6 hours
    
    // Ads
    REWARD_PER_AD: 2,
    MAX_ADS_PER_BATCH: 10,
    ADS_COOLDOWN_MS: 6 * 60 * 60 * 1000, // 6 hours
    ADS_BATCH_REWARD: 20, // 2 * 10
    
    // Referral
    REFERRAL_REWARD: 75,
    MILESTONES: [
        { count: 100, reward: 2500 },
        { count: 250, reward: 5000 },
        { count: 500, reward: 10000 }
    ],
    
    // Withdraw
    MIN_WITHDRAW: 2000,
    WITHDRAW_FEE_TON: 0.1, // One-time anti-bot fee
    
    // Boosts
    BOOSTS: {
        bronze: { price: 1, multiplier: 2, name: 'BRONZE', icon: '🥉' },
        silver: { price: 5, multiplier: 5, name: 'SILVER', icon: '🥈' },
        gold: { price: 10, multiplier: 12, name: 'GOLD', icon: '🥇' }
    }
};

const CMC_ICONS = {
    TON: 'https://s2.coinmarketcap.com/static/img/coins/64x64/11419.png'
};

// ============================================================================
// 2. GLOBAL STATE
// ============================================================================

let currentUser = null;
let userId = null;
let userData = null;
let livePrices = {};
let tonConnected = false;
let tonWalletAddress = null;
let isClaimingMining = false;
let isClaimingAds = false;
let isProcessingWithdraw = false;
let adSequenceActive = false;
let miningTimer = null;
let adsState = {
    watched: 0,
    accumulated: 0
};
let pendingWithdrawAmount = 0;
let priceRefreshTimer = null;

// ============================================================================
// 3. UTILITIES
// ============================================================================

function showToast(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMessage');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    toast.classList.remove('hidden');
    
    // Reset color
    toast.style.borderColor = 'var(--border-light)';
    if (type === 'success') toast.style.borderColor = 'var(--success)';
    if (type === 'error') toast.style.borderColor = 'var(--danger)';
    if (type === 'warning') toast.style.borderColor = 'var(--warning)';
    
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatNumber(num) {
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

function formatTimeLeft(ms) {
    if (ms <= 0) return '00:00:00';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

function getHaptic() {
    if (tg?.HapticFeedback) return tg.HapticFeedback;
    return null;
}

function vibrate(type = 'light') {
    const haptic = getHaptic();
    if (!haptic) return;
    if (type === 'light') haptic.impactOccurred('light');
    if (type === 'medium') haptic.impactOccurred('medium');
    if (type === 'success') haptic.notificationOccurred('success');
    if (type === 'error') haptic.notificationOccurred('error');
}

// ============================================================================
// 4. API HELPERS (No secrets, server handles logic)
// ============================================================================

async function apiRequest(endpoint, options = {}) {
    try {
        const res = await fetch(endpoint, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        });
        return await res.json();
    } catch (e) {
        console.error('API Error:', e);
        return { success: false, error: 'Network error' };
    }
}

async function fetchUserData() {
    if (!userId) return null;
    const res = await apiRequest(`/api/user/${userId}`);
    if (res.success) {
        currentUser = res.user;
        userData = res.user;
        return res.user;
    }
    return null;
}

async function saveUserProgress(updates) {
    return apiRequest('/api/user/update', {
        method: 'POST',
        body: JSON.stringify({ userId, updates })
    });
}

// ============================================================================
// 5. TON CONNECT
// ============================================================================

function initTonConnect() {
    const container = document.getElementById('ton-connect-btn');
    if (!container || typeof TON_CONNECT_UI === 'undefined') {
        console.warn('TON Connect unavailable');
        return;
    }
    
    try {
        window.tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
            manifestUrl: window.location.origin + '/tonconnect-manifest.json',
            buttonRootId: 'ton-connect-btn'
        });
        
        window.tonConnectUI.onStatusChange(wallet => {
            if (wallet) {
                tonConnected = true;
                tonWalletAddress = wallet.account.address;
                updateHeaderWallet();
                checkAndProceed();
            } else {
                tonConnected = false;
                tonWalletAddress = null;
            }
        });
    } catch(e) {
        console.error('TON Connect error:', e);
    }
}

async function sendTonPayment(amount, comment = '') {
    if (!window.tonConnectUI || !tonConnected) {
        showToast('Connect wallet first', 'warning');
        return false;
    }
    try {
        const transaction = {
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: [{
                address: 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Replaced by server response
                amount: (amount * 1e9).toString()
            }]
        };
        const result = await window.tonConnectUI.sendTransaction(transaction);
        return result?.boc || null;
    } catch(e) {
        console.error('Payment error:', e);
        return null;
    }
}

// ============================================================================
// 6. HEADER & UI UPDATES
// ============================================================================

function updateHeaderWallet() {
    const addrEl = document.getElementById('headerAddress');
    const balEl = document.getElementById('headerBalance');
    const valEl = document.getElementById('headerValue');
    
    if (addrEl) {
        if (tonWalletAddress) {
            addrEl.innerHTML = `<i class="fas fa-wallet"></i> ${tonWalletAddress.slice(0, 4)}...${tonWalletAddress.slice(-4)}`;
        } else {
            addrEl.innerHTML = `<i class="fas fa-wallet"></i> Connect`;
        }
    }
    
    if (balEl && userData) {
        balEl.textContent = `${(userData.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
    }
    
    if (valEl && userData && livePrices?.price) {
        const usd = (userData.balance || 0) * livePrices.price;
        valEl.textContent = `≈ $${usd.toFixed(2)}`;
    }
}

// ============================================================================
// 7. DEXSCREENER INTEGRATION
// ============================================================================

async function fetchTokenPrice() {
    try {
        const url = `https://api.dexscreener.com/tokens/v1/ton/${CONFIG.tokenAddress}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
            const pair = data[0];
            livePrices = {
                price: parseFloat(pair.priceUsd) || 0,
                change24h: parseFloat(pair.priceChange?.h24) || 0,
                marketCap: parseFloat(pair.marketCap) || 0,
                fdv: parseFloat(pair.fdv) || 0,
                liquidity: parseFloat(pair.liquidity?.usd) || 0,
                volume24h: parseFloat(pair.volume?.h24) || 0,
                pairAddress: pair.pairAddress
            };
            renderTokenCard();
            updateHeaderWallet();
            return true;
        }
        return false;
    } catch (e) {
        console.error('DexScreener error:', e);
        return false;
    }
}

function renderTokenCard() {
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    
    setText('tokenPrice', `$${livePrices.price?.toFixed(8) || '0.00000000'}`);
    setText('tokenMarketCap', `$${formatNumber(livePrices.marketCap || 0)}`);
    setText('tokenFdv', `$${formatNumber(livePrices.fdv || 0)}`);
    setText('tokenLiquidity', `$${formatNumber(livePrices.liquidity || 0)}`);
    setText('tokenVolume', `$${formatNumber(livePrices.volume24h || 0)}`);
    
    const changeEl = document.getElementById('tokenChange');
    if (changeEl) {
        const change = livePrices.change24h || 0;
        changeEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.className = `token-change ${change >= 0 ? 'positive' : 'negative'}`;
    }
    
    const contractEl = document.getElementById('contractAddress');
    if (contractEl) {
        contractEl.innerHTML = `<i class="fas fa-file-contract"></i> ${CONFIG.tokenAddress.slice(0, 6)}...${CONFIG.tokenAddress.slice(-6)}`;
    }
}

async function refreshTokenPrice() {
    const btn = document.getElementById('refreshTokenBtn');
    if (btn) btn.style.opacity = '0.5';
    showToast('Refreshing price...', 'info', 1500);
    const ok = await fetchTokenPrice();
    if (btn) btn.style.opacity = '1';
    if (ok) vibrate('light');
}

// ============================================================================
// 8. MINING SYSTEM
// ============================================================================

function getMiningData() {
    if (!userData) return { canClaim: false, remainingMs: 0, progress: 0, reward: 0 };
    
    const lastClaim = userData.lastMiningClaim || 0;
    const elapsed = Date.now() - lastClaim;
    const cooldown = CONFIG.MINING_COOLDOWN_MS;
    const remaining = Math.max(0, cooldown - elapsed);
    const progress = Math.min(100, (elapsed / cooldown) * 100);
    
    const baseReward = CONFIG.MINING_REWARD;
    const multiplier = userData.boostMultiplier || 1;
    const reward = baseReward * multiplier;
    
    return {
        canClaim: remaining <= 0,
        remainingMs: remaining,
        progress,
        reward
    };
}

function updateMiningUI() {
    if (!userData) return;
    
    const data = getMiningData();
    const ringEl = document.getElementById('ringProgress');
    const amountEl = document.getElementById('minedAmount');
    const usdEl = document.getElementById('minedUsd');
    const timerEl = document.getElementById('miningTimer');
    const claimBtn = document.getElementById('claimMiningBtn');
    const hashEl = document.getElementById('hashPower');
    
    if (ringEl) {
        const circumference = 2 * Math.PI * 90;
        const offset = circumference - (data.progress / 100) * circumference;
        ringEl.style.strokeDashoffset = offset;
        ringEl.style.strokeDasharray = circumference;
        ringEl.classList.toggle('active', data.canClaim);
    }
    
    if (amountEl) amountEl.textContent = data.reward.toLocaleString();
    
    if (usdEl && livePrices.price) {
        usdEl.textContent = `≈ $${(data.reward * livePrices.price).toFixed(2)}`;
    }
    
    if (timerEl) {
        timerEl.textContent = data.canClaim ? 'READY' : formatTimeLeft(data.remainingMs);
    }
    
    if (claimBtn) {
        if (data.canClaim) {
            claimBtn.disabled = false;
            claimBtn.innerHTML = `<i class="fas fa-fire"></i> CLAIM ${data.reward} ${CONFIG.tokenSymbol}`;
        } else {
            claimBtn.disabled = true;
            claimBtn.innerHTML = `<i class="fas fa-fire"></i> CLAIM MINING`;
        }
    }
    
    if (hashEl) {
        hashEl.textContent = `${userData.boostMultiplier || 1}x`;
    }
}

function startMiningTimer() {
    if (miningTimer) clearInterval(miningTimer);
    miningTimer = setInterval(() => {
        updateMiningUI();
    }, 1000);
}

async function claimMining() {
    if (isClaimingMining) return;
    const data = getMiningData();
    if (!data.canClaim) {
        showToast('Mining not ready yet', 'warning');
        return;
    }
    
    isClaimingMining = true;
    const btn = document.getElementById('claimMiningBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> CLAIMING...';
    }
    
    try {
        const res = await apiRequest('/api/mining/claim', {
            method: 'POST',
            body: JSON.stringify({ userId })
        });
        
        if (res.success) {
            showToast(`✅ +${res.reward} ${CONFIG.tokenSymbol} claimed!`, 'success');
            vibrate('success');
            await fetchUserData();
            updateMiningUI();
            updateHeaderWallet();
            
            if (!userData.isActive && userData.referredBy) {
                // First claim = active
                await apiRequest('/api/user/activate', {
                    method: 'POST',
                    body: JSON.stringify({ userId })
                });
            }
        } else {
            showToast(res.error || 'Claim failed', 'error');
            vibrate('error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        isClaimingMining = false;
        updateMiningUI();
    }
}

// ============================================================================
// 9. BOOST SYSTEM
// ============================================================================

async function buyBoost(type) {
    const boost = CONFIG.BOOSTS[type];
    if (!boost) return;
    
    if (!tonConnected) {
        showToast('Connect wallet first', 'warning');
        return;
    }
    
    const confirmMsg = `Activate ${boost.name} Boost for ${boost.price} TON?`;
    if (!confirm(confirmMsg)) return;
    
    try {
        // Get owner wallet from server
        const configRes = await apiRequest('/api/config');
        if (!configRes.success || !configRes.ownerWallet) {
            showToast('Server configuration error', 'error');
            return;
        }
        
        const result = await window.tonConnectUI.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: [{
                address: configRes.ownerWallet,
                amount: (boost.price * 1e9).toString()
            }]
        });
        
        const boc = result?.boc;
        if (!boc) {
            showToast('Payment cancelled', 'error');
            return;
        }
        
        showToast('Verifying payment...', 'info');
        
        const verify = await apiRequest('/api/boost/verify', {
            method: 'POST',
            body: JSON.stringify({ userId, boostType: type, boc })
        });
        
        if (verify.success) {
            showToast(`🔥 ${boost.name} Boost activated!`, 'success');
            vibrate('success');
            await fetchUserData();
            updateMiningUI();
        } else {
            showToast(verify.error || 'Verification failed', 'error');
        }
    } catch (e) {
        console.error('Boost error:', e);
        showToast('Payment failed', 'error');
    }
}

// ============================================================================
// 10. ADS SYSTEM
// ============================================================================

function initAdsState() {
    if (!userData) return;
    adsState.watched = userData.adsWatched || 0;
    adsState.accumulated = userData.adsAccumulated || 0;
    renderAdsUI();
}

function renderAdsUI() {
    const segmentsContainer = document.getElementById('adsSegments');
    if (segmentsContainer) {
        let html = '';
        for (let i = 0; i < CONFIG.MAX_ADS_PER_BATCH; i++) {
            html += `<div class="ads-segment ${i < adsState.watched ? 'active' : ''}"></div>`;
        }
        segmentsContainer.innerHTML = html;
    }
    
    const accEl = document.getElementById('adsAccumulated');
    if (accEl) accEl.textContent = `${adsState.accumulated} ${CONFIG.tokenSymbol}`;
    
    const counterEl = document.getElementById('adsCounter');
    if (counterEl) counterEl.textContent = `${adsState.watched}/${CONFIG.MAX_ADS_PER_BATCH}`;
    
    const watchBtn = document.getElementById('watchAdBtn');
    const claimBtn = document.getElementById('claimAdsBtn');
    const cooldownEl = document.getElementById('adsCooldown');
    
    const isComplete = adsState.watched >= CONFIG.MAX_ADS_PER_BATCH;
    const cooldownActive = userData?.adsCooldownUntil && Date.now() < userData.adsCooldownUntil;
    
    if (watchBtn) watchBtn.style.display = (isComplete || cooldownActive) ? 'none' : 'flex';
    if (claimBtn) {
        claimBtn.style.display = isComplete ? 'flex' : 'none';
        if (isComplete) {
            claimBtn.innerHTML = `<i class="fas fa-check"></i> CLAIM ${CONFIG.ADS_BATCH_REWARD} ${CONFIG.tokenSymbol}`;
        }
    }
    if (cooldownEl) {
        cooldownEl.style.display = cooldownActive ? 'block' : 'none';
        if (cooldownActive) {
            updateAdsCooldownTimer();
        }
    }
}

function updateAdsCooldownTimer() {
    const timerEl = document.getElementById('adsTimer');
    if (!timerEl || !userData?.adsCooldownUntil) return;
    const remaining = Math.max(0, userData.adsCooldownUntil - Date.now());
    timerEl.textContent = formatTimeLeft(remaining);
}

async function watchAd() {
    if (adSequenceActive) {
        showToast('Ad is loading...', 'warning');
        return;
    }
    
    if (adsState.watched >= CONFIG.MAX_ADS_PER_BATCH) {
        showToast('Batch complete! Claim your reward', 'warning');
        return;
    }
    
    adSequenceActive = true;
    const btn = document.getElementById('watchAdBtn');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> LOADING AD...';
    }
    
    let success = false;
    
    // Try Monetag first
    try {
        if (typeof window.show_12265394 === 'function') {
            await window.show_12265394();
            success = true;
        }
    } catch(e) {
        console.warn('Monetag failed:', e);
    }
    
    // Fallback to RichAds
    if (!success) {
        try {
            if (window.TelegramAdsController) {
                await new Promise((resolve, reject) => {
                    const controller = new TelegramAdsController();
                    controller.showRewardedVideo({
                        onReward: () => { success = true; resolve(); },
                        onError: () => reject()
                    });
                });
            }
        } catch(e) {
            console.warn('RichAds failed:', e);
        }
    }
    
    if (success) {
        adsState.watched += 1;
        adsState.accumulated += CONFIG.REWARD_PER_AD;
        vibrate('light');
        
        // Save locally (no server call to save DB costs)
        await saveUserProgress({
            adsWatched: adsState.watched,
            adsAccumulated: adsState.accumulated
        });
        
        renderAdsUI();
        showToast(`✅ +${CONFIG.REWARD_PER_AD} ${CONFIG.tokenSymbol} (${adsState.watched}/${CONFIG.MAX_ADS_PER_BATCH})`, 'success');
    } else {
        showToast('No ad available. Try again later.', 'error');
    }
    
    adSequenceActive = false;
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function claimAdsReward() {
    if (isClaimingAds) return;
    if (adsState.watched < CONFIG.MAX_ADS_PER_BATCH) {
        showToast('Complete all 10 ads first', 'warning');
        return;
    }
    
    isClaimingAds = true;
    const btn = document.getElementById('claimAdsBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> CLAIMING...';
    }
    
    try {
        const res = await apiRequest('/api/ads/claim', {
            method: 'POST',
            body: JSON.stringify({ userId })
        });
        
        if (res.success) {
            showToast(`✅ +${res.reward} ${CONFIG.tokenSymbol} added!`, 'success');
            vibrate('success');
            adsState.watched = 0;
            adsState.accumulated = 0;
            await fetchUserData();
            initAdsState();
            updateHeaderWallet();
        } else {
            showToast(res.error || 'Claim failed', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        isClaimingAds = false;
        renderAdsUI();
    }
}

// ============================================================================
// 11. TASKS SYSTEM
// ============================================================================

async function renderTasks() {
    const container = document.getElementById('taskList');
    if (!container || !userData) return;
    
    const tasks = userData.tasks || [];
    const completed = userData.completedTasks || [];
    
    if (tasks.length === 0) {
        container.innerHTML = '<div class="empty-state">No tasks available</div>';
        return;
    }
    
    container.innerHTML = tasks.map(task => {
        const isDone = completed.includes(task.id);
        return `
            <div class="task-item" data-task-id="${task.id}">
                <div class="task-icon"><i class="fas ${task.icon || 'fa-link'}"></i></div>
                <div class="task-info">
                    <div class="task-name">${escapeHtml(task.name)}</div>
                    <div class="task-reward">+${task.reward} ${CONFIG.tokenSymbol}</div>
                </div>
                <button class="task-btn ${isDone ? 'completed' : ''}" 
                        onclick="window.startTask('${task.id}')" 
                        ${isDone ? 'disabled' : ''}>
                    ${isDone ? '✓ DONE' : 'START'}
                </button>
            </div>
        `;
    }).join('');
}

async function startTask(taskId) {
    if (!userData) return;
    const tasks = userData.tasks || [];
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const completed = userData.completedTasks || [];
    if (completed.includes(taskId)) {
        showToast('Task already completed', 'warning');
        return;
    }
    
    // Open link
    if (task.url) {
        window.open(task.url, '_blank');
    }
    
    showToast('Complete the task then click Verify', 'info');
    
    // Replace button with verify
    const taskItem = document.querySelector(`[data-task-id="${taskId}"]`);
    if (taskItem) {
        const btn = taskItem.querySelector('.task-btn');
        if (btn) {
            btn.textContent = 'VERIFY';
            btn.onclick = () => verifyTask(taskId);
        }
    }
}

async function verifyTask(taskId) {
    showToast('Verifying...', 'info');
    const res = await apiRequest('/api/tasks/verify', {
        method: 'POST',
        body: JSON.stringify({ userId, taskId })
    });
    
    if (res.success) {
        showToast(`✅ +${res.reward} ${CONFIG.tokenSymbol} earned!`, 'success');
        vibrate('success');
        await fetchUserData();
        renderTasks();
        updateHeaderWallet();
    } else {
        showToast(res.error || 'Verification failed', 'error');
        vibrate('error');
    }
}

// ============================================================================
// 12. REFERRAL SYSTEM
// ============================================================================

function renderReferral() {
    if (!userData) return;
    
    const active = userData.activeReferrals || 0;
    const inactive = userData.inactiveReferrals || 0;
    
    const activeEl = document.getElementById('activeReferrals');
    const inactiveEl = document.getElementById('inactiveReferrals');
    if (activeEl) activeEl.textContent = active;
    if (inactiveEl) inactiveEl.textContent = inactive;
    
    renderMilestones();
    renderReferralList();
}

function renderMilestones() {
    const container = document.getElementById('milestoneList');
    if (!container || !userData) return;
    
    const active = userData.activeReferrals || 0;
    const claimed = userData.claimedMilestones || [];
    
    container.innerHTML = CONFIG.MILESTONES.map(m => {
        const isCompleted = claimed.includes(m.count);
        return `
            <div class="milestone-item ${isCompleted ? 'completed' : ''}">
                <div class="milestone-icon">${isCompleted ? '✅' : '🔒'}</div>
                <div class="milestone-info">
                    <div class="milestone-count">${m.count} Referrals</div>
                    <div class="milestone-reward">+${m.reward} ${CONFIG.tokenSymbol}</div>
                </div>
            </div>
        `;
    }).join('');
}

function renderReferralList() {
    const container = document.getElementById('referralList');
    if (!container || !userData) return;
    
    const refs = userData.referrals || [];
    if (refs.length === 0) {
        container.innerHTML = '<div class="empty-state">No referrals yet</div>';
        return;
    }
    
    container.innerHTML = refs.map(r => `
        <div class="referral-item">
            <img src="${r.avatar || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff'}" alt="${r.username}">
            <span class="referral-item-name">@${r.username || 'user'}</span>
            <span class="referral-status ${r.isActive ? 'active' : 'inactive'}">
                ${r.isActive ? 'ACTIVE' : 'INACTIVE'}
            </span>
        </div>
    `).join('');
}

async function copyReferralLink() {
    if (!userId) return;
    const link = `https://t.me/${CONFIG.botUsername}/Mine?startapp=${userId}`;
    try {
        await navigator.clipboard.writeText(link);
        showToast('✅ Link copied!', 'success');
        vibrate('light');
    } catch(e) {
        showToast(link, 'info', 5000);
    }
}

async function shareReferralLink() {
    if (!userId) return;
    const link = `https://t.me/${CONFIG.botUsername}/Mine?startapp=${userId}`;
    const text = `🔥 Join Groyper Mine and start earning GROYP!\n${link}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    window.open(shareUrl, '_blank');
}

// ============================================================================
// 13. WALLET & WITHDRAW
// ============================================================================

function renderWallet() {
    if (!userData) return;
    
    const nameEl = document.getElementById('walletUserName');
    const handleEl = document.getElementById('walletUserHandle');
    const avatarEl = document.getElementById('walletAvatar');
    const totalEl = document.getElementById('totalWithdrawn');
    const availEl = document.getElementById('availableToWithdraw');
    const addrEl = document.getElementById('withdrawWalletAddress');
    
    if (nameEl) nameEl.textContent = userData.username || 'User';
    if (handleEl) handleEl.textContent = `@${userData.username || 'user'}`;
    if (avatarEl) avatarEl.src = userData.avatar || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff';
    if (totalEl) totalEl.textContent = `${(userData.totalWithdrawn || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
    if (availEl) availEl.textContent = `${(userData.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
    if (addrEl) addrEl.textContent = tonWalletAddress ? `${tonWalletAddress.slice(0, 6)}...${tonWalletAddress.slice(-6)}` : 'Not connected';
    
    renderWithdrawHistory();
}

function renderWithdrawHistory() {
    const container = document.getElementById('withdrawHistory');
    if (!container || !userData) return;
    
    const withdrawals = userData.withdrawals || [];
    if (withdrawals.length === 0) {
        container.innerHTML = '<div class="empty-state">No withdrawals yet</div>';
        return;
    }
    
    container.innerHTML = withdrawals.slice(0, 20).map(w => {
        const status = w.status || 'pending';
        return `
            <div class="history-item">
                <span class="history-amount">${w.amount} ${CONFIG.tokenSymbol}</span>
                <span class="history-status ${status}">${status.toUpperCase()}</span>
            </div>
        `;
    }).join('');
}

function validateWithdrawAmount() {
    const input = document.getElementById('withdrawAmount');
    if (!input || !userData) return 0;
    const amount = parseFloat(input.value) || 0;
    
    input.classList.remove('invalid', 'valid');
    if (amount > 0) {
        if (amount >= CONFIG.MIN_WITHDRAW && amount <= (userData.balance || 0)) {
            input.classList.add('valid');
        } else {
            input.classList.add('invalid');
        }
    }
    return amount;
}

async function submitWithdraw() {
    if (isProcessingWithdraw) return;
    if (!userData) return;
    
    const amount = validateWithdrawAmount();
    if (amount < CONFIG.MIN_WITHDRAW) {
        showToast(`Minimum withdrawal is ${CONFIG.MIN_WITHDRAW} ${CONFIG.tokenSymbol}`, 'error');
        return;
    }
    if (amount > (userData.balance || 0)) {
        showToast('Insufficient balance', 'error');
        return;
    }
    if (!tonWalletAddress) {
        showToast('Connect wallet first', 'error');
        return;
    }
    
    isProcessingWithdraw = true;
    const btn = document.getElementById('withdrawBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> PROCESSING...';
    }
    
    try {
        // Check if anti-bot fee paid
        if (!userData.withdrawFeePaid) {
            const configRes = await apiRequest('/api/config');
            if (!configRes.success || !configRes.ownerWallet) {
                throw new Error('Config error');
            }
            
            showToast('Pay 0.1 TON one-time fee', 'info');
            const result = await window.tonConnectUI.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 600,
                messages: [{
                    address: configRes.ownerWallet,
                    amount: (CONFIG.WITHDRAW_FEE_TON * 1e9).toString()
                }]
            });
            
            const boc = result?.boc;
            if (!boc) throw new Error('Payment cancelled');
            
            const verify = await apiRequest('/api/withdraw/fee-verify', {
                method: 'POST',
                body: JSON.stringify({ userId, boc })
            });
            
            if (!verify.success) throw new Error(verify.error || 'Fee verification failed');
            
            await fetchUserData();
        }
        
        // Submit withdrawal request
        const res = await apiRequest('/api/withdraw/request', {
            method: 'POST',
            body: JSON.stringify({ userId, amount, walletAddress: tonWalletAddress })
        });
        
        if (res.success) {
            showToast('✅ Withdrawal request submitted!', 'success');
            vibrate('success');
            document.getElementById('withdrawAmount').value = '';
            await fetchUserData();
            renderWallet();
            updateHeaderWallet();
        } else {
            showToast(res.error || 'Withdrawal failed', 'error');
            vibrate('error');
        }
    } catch(e) {
        console.error('Withdraw error:', e);
        showToast(e.message || 'Withdrawal failed', 'error');
    } finally {
        isProcessingWithdraw = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-lock"></i> WITHDRAW';
        }
    }
}

// ============================================================================
// 14. PAGE NAVIGATION
// ============================================================================

function switchPage(pageName) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page${pageName.charAt(0).toUpperCase() + pageName.slice(1)}`);
    if (target) target.classList.add('active');
    
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });
    
    vibrate('light');
    
    // Refresh relevant data
    if (pageName === 'home') {
        updateMiningUI();
        updateHeaderWallet();
    }
    if (pageName === 'earn') {
        initAdsState();
        renderTasks();
    }
    if (pageName === 'referral') {
        renderReferral();
    }
    if (pageName === 'wallet') {
        renderWallet();
    }
}

// ============================================================================
// 15. ONBOARDING FLOW
// ============================================================================

async function checkAndProceed() {
    if (!tonConnected || !tonWalletAddress) return;
    
    // Save wallet to server
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
    
    if (!res.success) {
        showToast('Registration failed', 'error');
        return;
    }
    
    // Hide onboarding, show app
    document.getElementById('onboardingScreen').classList.remove('active');
    document.getElementById('mainApp').style.display = 'block';
    
    // Load data
    await fetchUserData();
    await fetchTokenPrice();
    updateHeaderWallet();
    updateMiningUI();
    initAdsState();
    renderTasks();
    renderReferral();
    renderWallet();
    
    startMiningTimer();
    
    // Update header avatar
    const avatarEl = document.getElementById('userAvatar');
    const nameEl = document.getElementById('userName');
    const handleEl = document.getElementById('userHandle');
    if (avatarEl) avatarEl.src = tg?.initDataUnsafe?.user?.photo_url || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff';
    if (nameEl) nameEl.textContent = tg?.initDataUnsafe?.user?.first_name || 'User';
    if (handleEl) handleEl.textContent = `@${tg?.initDataUnsafe?.user?.username || 'user'}`;
}

// ============================================================================
// 16. INIT
// ============================================================================

function init() {
    console.log('🚀 Groyper Mine Initializing...');
    
    // Get user ID
    userId = tg?.initDataUnsafe?.user?.id?.toString();
    if (!userId) {
        const urlParams = new URLSearchParams(window.location.search);
        userId = urlParams.get('userId');
    }
    
    if (!userId) {
        showToast('Please open from Telegram', 'error');
        return;
    }
    
    console.log('📱 User ID:', userId);
    
    // Init TON Connect
    initTonConnect();
    
    // Bind events
    document.getElementById('connectWalletBtn')?.addEventListener('click', async () => {
        if (window.tonConnectUI) {
            await window.tonConnectUI.openModal();
        }
    });
    
    document.getElementById('refreshTokenBtn')?.addEventListener('click', refreshTokenPrice);
    document.getElementById('claimMiningBtn')?.addEventListener('click', claimMining);
    document.getElementById('watchAdBtn')?.addEventListener('click', watchAd);
    document.getElementById('claimAdsBtn')?.addEventListener('click', claimAdsReward);
    document.getElementById('copyReferralBtn')?.addEventListener('click', copyReferralLink);
    document.getElementById('shareReferralBtn')?.addEventListener('click', shareReferralLink);
    document.getElementById('withdrawBtn')?.addEventListener('click', submitWithdraw);
    document.getElementById('withdrawAmount')?.addEventListener('input', validateWithdrawAmount);
    
    document.getElementById('maxWithdrawBtn')?.addEventListener('click', () => {
        const input = document.getElementById('withdrawAmount');
        if (input && userData) {
            input.value = Math.floor(userData.balance || 0);
            validateWithdrawAmount();
        }
    });
    
    document.getElementById('copyContractBtn')?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(CONFIG.tokenAddress);
        showToast('Contract copied!', 'success');
    });
    
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => switchPage(item.dataset.page));
    });
    
    // Expose to window
    window.buyBoost = buyBoost;
    window.startTask = startTask;
    window.verifyTask = verifyTask;
    window.switchPage = switchPage;
    
    // Ads cooldown ticker (only when needed)
    setInterval(() => {
        if (userData?.adsCooldownUntil && Date.now() < userData.adsCooldownUntil) {
            updateAdsCooldownTimer();
        }
    }, 1000);
    
    console.log('✅ Groyper Mine Ready');
}

// Start
init();
