// ============================================================================
// GROYPER MINE - EMBER VAULT v2 (Merged: working skeleton + secure features)
// ============================================================================

const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#07080D'); tg.setBackgroundColor('#07080D'); } catch {}
    try { tg.disableVerticalSwipes?.(); } catch {}
}

// ============================================================================
// CONFIG (defaults — server can override via /api/init)
// ============================================================================
const CONFIG = {
    tokenSymbol: 'GROYP',
    tokenAddress: 'EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    botUsername: 'GroyperMinebot',
    MINING_REWARD: 20,
    MINING_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    REWARD_PER_AD: 2,
    MAX_ADS_PER_BATCH: 10,
    ADS_BATCH_REWARD: 20,
    ADS_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    REFERRAL_REWARD: 75,
    MILESTONES: [
        { count: 50, reward: 1000 },
        { count: 100, reward: 2500 },
        { count: 250, reward: 5000 },
        { count: 500, reward: 10000 },
        { count: 1000, reward: 25000 }
    ],
    MIN_WITHDRAW: 2000,
    WITHDRAW_FEE_TON: 0.1,
    BOOSTS: {
        bronze: { price: 1, multiplier: 2, name: 'SPARK', icon: '🥉' },
        silver: { price: 2.5, multiplier: 5, name: 'BLAZE', icon: '🥈' },
        gold: { price: 10, multiplier: 12, name: 'INFERNO', icon: '🥇' }
    }
};

// ============================================================================
// STATE
// ============================================================================
let currentUser = null;
let userId = null;
let tasks = [];
let tonConnected = false;
let tonWalletAddress = null;
let isClaimingMining = false;
let isClaimingAds = false;
let isProcessingWithdraw = false;
let adSequenceActive = false;
let miningTimer = null;
let livePriceData = { price: 0, change24h: 0 };
let adsState = { watched: 0, accumulated: 0, token: null };
let booted = false;
let serverOffset = 0;

const now = () => Date.now() + serverOffset;
const $ = id => document.getElementById(id);

// ============================================================================
// UTILITIES
// ============================================================================
function showToast(msg, type = 'info', dur = 3000) {
    const t = $('toast'), m = $('toastMessage');
    if (!t || !m) return;
    m.textContent = msg;
    t.classList.remove('hidden');
    t.style.borderColor = type === 'success' ? 'var(--ok)' : type === 'error' ? 'var(--bad)' : 'var(--line-2)';
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add('hidden'), dur);
}

function formatTimeLeft(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
        .map(x => String(x).padStart(2, '0')).join(':');
}

function vibrate(type = 'light') {
    if (!tg?.HapticFeedback) return;
    if (type === 'light') tg.HapticFeedback.impactOccurred('light');
    if (type === 'medium') tg.HapticFeedback.impactOccurred('medium');
    if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
    if (type === 'error') tg.HapticFeedback.notificationOccurred('error');
}

// ============================================================================
// API — Authorization via Telegram initData
// ============================================================================
async function apiRequest(path, { method = 'GET', body } = {}) {
    try {
        const res = await fetch('/api' + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'tma ' + (tg?.initData || '')
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 503) { showMaintenance(); return { success: false }; }
        if (!res.ok || data.success === false) {
            return { success: false, error: data.error || 'Request failed' };
        }
        return { success: true, ...data };
    } catch (e) {
        console.error('API Error:', e);
        return { success: false, error: 'Network error' };
    }
}

function showMaintenance() {
    document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#F4F5F9;font:600 18px Inter;text-align:center;padding:24px">🔧<br>Under maintenance</div>';
}

// ============================================================================
// TON CONNECT — Initialize FIRST
// ============================================================================
function initTonConnect() {
    console.log('🔧 initTonConnect called');
    console.log('TON_CONNECT_UI:', typeof window.TON_CONNECT_UI);
    
    if (typeof TON_CONNECT_UI === 'undefined') {
        console.error('❌ TON_CONNECT_UI not loaded — check CDN');
        return;
    }
    
    const root = $('ton-connect-btn');
    if (!root) {
        console.error('❌ #ton-connect-btn not found');
        return;
    }
    
    try {
        window.tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
            manifestUrl: location.origin + '/tonconnect-manifest.json',
            buttonRootId: 'ton-connect-btn',
            language: 'en'
        });
        console.log('✅ TonConnectUI initialized');
        
        window.tonConnectUI.onStatusChange(async wallet => {
            console.log('🔗 Wallet:', wallet?.account?.address);
            
            if (!wallet) {
                tonConnected = false;
                tonWalletAddress = null;
                return;
            }
            
            // Convert raw to friendly (UQ...)
            let friendly = wallet.account.address;
            try {
                friendly = TON_CONNECT_UI.toUserFriendlyAddress(wallet.account.address, false);
            } catch (e) {
                console.warn('Address conversion failed, using raw');
            }
            
            tonConnected = true;
            tonWalletAddress = friendly;
            
            // If we're already in app and wallet matches, just update header
            if (booted && currentUser && currentUser.wallet === friendly) {
                updateHeaderWallet();
                return;
            }
            
            // Register via secure endpoint
            const res = await apiRequest('/register', {
                method: 'POST',
                body: {
                    wallet: friendly,
                    startParam: tg?.initDataUnsafe?.start_param || null
                }
            });
            
            if (res.success) {
                currentUser = res.user;
                enterApp();
            } else {
                showToast(res.error || 'Registration failed', 'error');
            }
        });
    } catch (e) {
        console.error('❌ TonConnectUI init error:', e);
    }
}

// ============================================================================
// USER / BOOT
// ============================================================================
async function fetchUserData() {
    const res = await apiRequest('/init');
    if (!res.success) return false;
    
    if (res.config) Object.assign(CONFIG, res.config);
    if (res.serverTime) serverOffset = res.serverTime - Date.now();
    if (res.tasks) tasks = res.tasks;
    if (res.price) livePriceData = res.price;
    if (res.user) currentUser = res.user;
    
    return true;
}

async function boot(silent = false) {
    const res = await apiRequest('/init');
    if (!res.success) {
        if (!silent) showToast(res.error || 'Connection failed', 'error');
        return;
    }
    
    Object.assign(CONFIG, res.config || {});
    serverOffset = (res.serverTime || Date.now()) - Date.now();
    tasks = res.tasks || [];
    livePriceData = res.price || livePriceData;
    
    if (res.banner) showToast(res.banner, 'info', 5000);
    
    if (res.user && res.user.wallet) {
        currentUser = res.user;
        tonWalletAddress = res.user.wallet;
        tonConnected = true;
        enterApp();
    } else {
        showOnboarding();
    }
}

function showOnboarding() {
    $('onboardingScreen')?.classList.add('active');
    const m = $('mainApp');
    if (m) m.style.display = 'none';
}

function enterApp() {
    $('onboardingScreen')?.classList.remove('active');
    const m = $('mainApp');
    if (m) m.style.display = 'block';
    booted = true;
    
    const u = tg?.initDataUnsafe?.user || {};
    if ($('userAvatar')) $('userAvatar').src = u.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.first_name || 'U') + '&background=FF4D00&color=fff';
    if ($('userName')) $('userName').textContent = u.first_name || currentUser?.firstName || 'User';
    if ($('userHandle')) $('userHandle').textContent = '@' + (u.username || currentUser?.username || 'user');
    
    renderAll();
    
    if (miningTimer) clearInterval(miningTimer);
    miningTimer = setInterval(() => {
        if (document.hidden) return;
        renderMining();
        renderAds();
    }, 1000);
    
    fetchTokenPrice();
}

// ============================================================================
// TOKEN PRICE (DexScreener — direct, cached client-side for 60s)
// ============================================================================
let lastPriceFetch = 0;
async function fetchTokenPrice(force = false) {
    if (!force && Date.now() - lastPriceFetch < 60000) {
        renderToken();
        return;
    }
    try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CONFIG.tokenAddress}`);
        const data = await res.json();
        if (data?.pairs?.length) {
            const best = data.pairs.sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0))[0];
            livePriceData = {
                price: parseFloat(best.priceUsd) || 0,
                change24h: parseFloat(best.priceChange?.h24) || 0,
                mcap: parseFloat(best.marketCap) || 0,
                fdv: parseFloat(best.fdv) || 0,
                liq: parseFloat(best.liquidity?.usd) || 0,
                vol: parseFloat(best.volume?.h24) || 0
            };
            lastPriceFetch = Date.now();
            renderToken();
            updateHeaderWallet();
        }
    } catch (e) {
        console.error('Price fetch error:', e);
    }
}

function renderToken() {
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('tokenPrice', '$' + (livePriceData.price < 0.01 ? livePriceData.price.toFixed(8) : livePriceData.price.toFixed(4)));
    set('tokenMarketCap', '$' + Math.round(livePriceData.mcap || 0).toLocaleString());
    set('tokenFdv', '$' + Math.round(livePriceData.fdv || 0).toLocaleString());
    set('tokenLiquidity', '$' + Math.round(livePriceData.liq || 0).toLocaleString());
    set('tokenVolume', '$' + Math.round(livePriceData.vol || 0).toLocaleString());
    set('contractAddress', '<i class="fas fa-file-contract"></i> ' + CONFIG.tokenAddress.slice(0, 6) + '…' + CONFIG.tokenAddress.slice(-6));
    
    const ch = $('tokenChange');
    if (ch) {
        const c = livePriceData.change24h || 0;
        ch.textContent = (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
        ch.className = 'token-change ' + (c >= 0 ? 'positive' : 'negative');
    }
}

// ============================================================================
// HEADER
// ============================================================================
function updateHeaderWallet() {
    if (currentUser) {
        const bal = $('headerBalance');
        const val = $('headerValue');
        if (bal) bal.textContent = `${Math.floor(currentUser.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`;
        if (val) val.textContent = `≈ $${((currentUser.balance || 0) * (livePriceData.price || 0)).toFixed(2)}`;
    }
    if (tonWalletAddress) {
        const addr = $('headerAddress');
        if (addr) addr.innerHTML = `<i class="fas fa-wallet"></i> ${tonWalletAddress.slice(0, 4)}…${tonWalletAddress.slice(-4)}`;
    }
}

// ============================================================================
// MINING — live computation from time only (zero DB writes)
// ============================================================================
function getMiningData() {
    if (!currentUser) return { canClaim: false, remainingMs: 0, progress: 0, reward: 0, liveAccrued: 0 };
    
    const lastClaim = currentUser.lastMiningClaim || 0;
    const elapsed = Math.max(0, now() - lastClaim);
    const capped = Math.min(elapsed, CONFIG.MINING_COOLDOWN_MS);
    const mult = getActiveMultiplier();
    const fullReward = CONFIG.MINING_REWARD * mult;
    
    return {
        canClaim: elapsed >= CONFIG.MINING_COOLDOWN_MS,
        remainingMs: Math.max(0, CONFIG.MINING_COOLDOWN_MS - capped),
        progress: capped / CONFIG.MINING_COOLDOWN_MS,
        reward: fullReward,
        liveAccrued: fullReward * (capped / CONFIG.MINING_COOLDOWN_MS)
    };
}

function getActiveMultiplier() {
    if (!currentUser) return 1;
    const exp = currentUser.boostExpiresAt || 0;
    if (exp && exp < now()) return 1;
    return currentUser.boostMultiplier || 1;
}

function renderMining() {
    if (!currentUser) return;
    
    const d = getMiningData();
    const ring = $('ringProgress');
    
    if (ring) {
        const c = 2 * Math.PI * 90;
        ring.style.strokeDasharray = c;
        ring.style.strokeDashoffset = c * (1 - d.progress);
        ring.classList.remove('loading');
        ring.classList.toggle('active', d.canClaim);
    }
    
    const amt = $('minedAmount');
    if (amt) amt.textContent = d.canClaim ? Math.floor(d.reward).toLocaleString() : d.liveAccrued.toFixed(3);
    
    const usd = $('minedUsd');
    if (usd) usd.textContent = `≈ $${(d.liveAccrued * (livePriceData.price || 0)).toFixed(2)}`;
    
    const timer = $('miningTimer');
    if (timer) timer.textContent = d.canClaim ? 'READY' : formatTimeLeft(d.remainingMs);
    
    const power = $('hashPower');
    if (power) power.textContent = `${getActiveMultiplier()}x`;
    
    const btn = $('claimMiningBtn');
    if (btn) {
        btn.disabled = !d.canClaim;
        const label = $('claimLabel');
        if (label) label.textContent = d.canClaim ? `CLAIM ${Math.floor(d.reward).toLocaleString()} ${CONFIG.tokenSymbol}` : 'CLAIM MINING';
    }
}

async function claimMining() {
    if (isClaimingMining) return;
    if (!getMiningData().canClaim) return showToast('Not ready yet', 'warning');
    
    isClaimingMining = true;
    const btn = $('claimMiningBtn');
    if (btn) btn.disabled = true;
    
    try {
        const res = await apiRequest('/mining/claim', { method: 'POST' });
        if (res.success) {
            currentUser = res.user;
            renderAll();
            vibrate('success');
            showToast(`✅ +${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        } else {
            showToast(res.error, 'error');
            vibrate('error');
        }
    } finally {
        isClaimingMining = false;
    }
}

// ============================================================================
// ADS — stateless tokens (server-issued ymid)
// ============================================================================
function getAdsCooldownLeft() {
    return Math.max(0, (currentUser?.adsCooldownUntil || 0) - now());
}

function renderAds() {
    if (!currentUser) return;
    
    const seg = $('adsSegments');
    if (seg) {
        const w = currentUser.adsWatched || 0;
        if (seg.children.length !== CONFIG.MAX_ADS_PER_BATCH) {
            seg.innerHTML = '<div class="ads-segment"></div>'.repeat(CONFIG.MAX_ADS_PER_BATCH);
        }
        [...seg.children].forEach((c, i) => c.classList.toggle('active', i < w));
    }
    
    const acc = $('adsAccumulated');
    const counter = $('adsCounter');
    const w = currentUser.adsWatched || 0;
    const perAd = CONFIG.ADS_BATCH_REWARD / CONFIG.MAX_ADS_PER_BATCH;
    if (acc) acc.textContent = `${Math.floor(w * perAd)} ${CONFIG.tokenSymbol}`;
    if (counter) counter.textContent = `${w}/${CONFIG.MAX_ADS_PER_BATCH}`;
    
    const complete = w >= CONFIG.MAX_ADS_PER_BATCH;
    const cd = getAdsCooldownLeft();
    const watchBtn = $('watchAdBtn');
    const claimBtn = $('claimAdsBtn');
    const cdEl = $('adsCooldown');
    
    if (watchBtn) watchBtn.style.display = (!complete && cd <= 0) ? 'flex' : 'none';
    if (claimBtn) claimBtn.style.display = (complete && cd <= 0) ? 'flex' : 'none';
    if (cdEl) {
        cdEl.style.display = cd > 0 ? 'block' : 'none';
        const t = $('adsTimer');
        if (t) t.textContent = formatTimeLeft(cd);
    }
}

async function watchAd() {
    if (adSequenceActive) return;
    if ((currentUser.adsWatched || 0) >= CONFIG.MAX_ADS_PER_BATCH) return showToast('Batch complete — claim reward', 'warning');
    if (getAdsCooldownLeft() > 0) return showToast('Ads on cooldown', 'warning');
    
    adSequenceActive = true;
    const btn = $('watchAdBtn');
    if (btn) btn.disabled = true;
    showToast('Loading ad...', 'info');
    
    try {
        // 1. Get stateless token + ymid from server
        const start = await apiRequest('/ads/start', { method: 'POST', body: { token: adsState.token || null } });
        if (!start.success) { showToast(start.error, 'error'); return; }
        
        const { ymid, token } = start;
        
        // 2. Show ad (try Monetag first, fallback to RichAds)
        let adShown = false;
        try {
            if (typeof window.show_12265394 === 'function') {
                await window.show_12265394({ ymid });
                adShown = true;
            }
        } catch (e) { console.warn('Monetag failed:', e); }
        
        if (!adShown && window.TelegramAdsController) {
            try {
                await new Promise((res, rej) => {
                    new TelegramAdsController().showRewardedVideo({ onReward: res, onError: rej });
                });
                adShown = true;
            } catch (e) { console.warn('RichAds failed:', e); }
        }
        
        if (!adShown) { showToast('No ad available. Try again.', 'error'); return; }
        
        // 3. Confirm with server
        const confirm = await apiRequest('/ads/watch', { method: 'POST', body: { ymid, token } });
        if (confirm.success) {
            adsState.token = confirm.token;
            currentUser.adsWatched = confirm.watched;
            vibrate('light');
            renderAds();
            showToast(`+${perAd} ${CONFIG.tokenSymbol}`, 'success');
        } else {
            showToast(confirm.error, 'error');
        }
    } finally {
        adSequenceActive = false;
        if (btn) btn.disabled = false;
    }
}

async function claimAdsReward() {
    if (isClaimingAds) return;
    if ((currentUser.adsWatched || 0) < CONFIG.MAX_ADS_PER_BATCH) return;
    
    isClaimingAds = true;
    try {
        const res = await apiRequest('/ads/claim', { method: 'POST', body: { token: adsState.token } });
        if (res.success) {
            currentUser = res.user;
            adsState.token = null;
            vibrate('success');
            showToast(`✅ +${res.reward} ${CONFIG.tokenSymbol}`, 'success');
            renderAll();
        } else {
            showToast(res.error, 'error');
        }
    } finally {
        isClaimingAds = false;
    }
}

// ============================================================================
// TASKS
// ============================================================================
function renderTasks() {
    const c = $('taskList');
    if (!c) return;
    if (!tasks.length) return c.innerHTML = '<div class="empty-state">No tasks available</div>';
    
    const done = new Set(currentUser?.completedTasks || []);
    c.innerHTML = tasks.map(t => {
        const d = done.has(t.id);
        return `<div class="task-item ${d ? 'done' : ''}" data-task-id="${t.id}">
            <div class="task-icon"><i class="${t.iconClass || 'fas fa-link'}"></i></div>
            <div class="task-info">
                <div class="task-name">${t.name}</div>
                <div class="task-reward">+${t.reward} ${CONFIG.tokenSymbol}</div>
            </div>
            <button class="task-btn ${d ? 'completed' : ''}" data-act="start" ${d ? 'disabled' : ''}>
                ${d ? '✓ DONE' : 'START'}
            </button>
        </div>`;
    }).join('');
}

async function taskAction(taskId, action) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    if (action === 'start') {
        if (/^https:\/\/t\.me\//.test(task.url)) tg?.openTelegramLink ? tg.openTelegramLink(task.url) : window.open(task.url, '_blank');
        else tg?.openLink ? tg.openLink(task.url) : window.open(task.url, '_blank');
        
        // Change button to VERIFY
        const item = document.querySelector(`[data-task-id="${taskId}"]`);
        if (item) {
            const btn = item.querySelector('.task-btn');
            btn.textContent = 'VERIFY';
            btn.dataset.act = 'verify';
        }
        return;
    }
    
    // Verify
    const res = await apiRequest('/tasks/verify', { method: 'POST', body: { taskId } });
    if (res.success) {
        currentUser = res.user;
        vibrate('success');
        showToast(`✅ +${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } else {
        showToast(res.error, 'error');
        vibrate('error');
    }
}

// ============================================================================
// CHECK-IN
// ============================================================================
function renderCheckin() {
    const btn = $('checkinBtn');
    if (!btn || !currentUser) return;
    const today = Math.floor(now() / 86400000);
    const done = currentUser.lastCheckinDay === today;
    btn.disabled = done;
    btn.textContent = done ? '✓ DONE' : 'CHECK IN';
    const streak = $('streakCount');
    if (streak) streak.textContent = `${currentUser.streak || 0} day streak`;
}

async function checkin() {
    const res = await apiRequest('/checkin', { method: 'POST' });
    if (res.success) {
        currentUser = res.user;
        vibrate('success');
        showToast(`🔥 +${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } else {
        showToast(res.error, 'error');
    }
}

// ============================================================================
// REFERRAL
// ============================================================================
function renderReferral() {
    if (!currentUser) return;
    
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('activeReferrals', currentUser.activeReferrals || 0);
    set('inactiveReferrals', currentUser.inactiveReferrals || 0);
    set('refRewardText', `${CONFIG.REFERRAL_REWARD} ${CONFIG.tokenSymbol}`);
    
    const claimed = new Set(currentUser.claimedMilestones || []);
    const total = currentUser.activeReferrals || 0;
    const ml = $('milestoneList');
    
    if (ml) {
        ml.innerHTML = CONFIG.MILESTONES.map(m => {
            const reached = total >= m.count;
            const got = claimed.has(m.count);
            const pct = Math.min(100, (total / m.count) * 100);
            return `<div class="milestone-item ${got ? 'completed' : reached ? 'current' : ''}">
                <div class="milestone-icon">${got ? '✅' : reached ? '🎁' : '🔒'}</div>
                <div class="milestone-info">
                    <div class="milestone-count">${m.count} Referrals</div>
                    <div class="milestone-reward">+${m.reward} ${CONFIG.tokenSymbol}</div>
                    <div class="milestone-bar"><i style="width:${pct}%"></i></div>
                </div>
                ${reached && !got ? `<button class="task-btn" data-ms="${m.count}">CLAIM</button>` : ''}
            </div>`;
        }).join('');
    }
    
    // Load referrals list
    loadReferralList();
}

async function loadReferralList() {
    const rl = $('referralList');
    if (!rl) return;
    
    const res = await apiRequest('/referrals');
    if (!res.success || !res.items?.length) {
        rl.innerHTML = '<div class="empty-state">No referrals yet</div>';
        return;
    }
    
    rl.innerHTML = res.items.map(r => `
        <div class="referral-item">
            <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(r.username || 'U')}&background=FF4D00&color=fff" alt="">
            <span class="referral-item-name">@${r.username}</span>
            <span class="referral-status ${r.active ? 'active' : 'inactive'}">${r.active ? 'ACTIVE' : 'INACTIVE'}</span>
        </div>
    `).join('');
}

async function claimMilestone(count) {
    const res = await apiRequest('/referrals/milestone', { method: 'POST', body: { count: +count } });
    if (res.success) {
        currentUser = res.user;
        vibrate('success');
        showToast(`🎉 +${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        confetti();
        renderAll();
    } else {
        showToast(res.error, 'error');
    }
}

function copyReferral() {
    const link = `https://t.me/${CONFIG.botUsername}/Mine?startapp=${currentUser?.userId || userId}`;
    navigator.clipboard?.writeText(link);
    showToast('Link copied!', 'success');
    vibrate('light');
}

function shareReferral() {
    const link = `https://t.me/${CONFIG.botUsername}/Mine?startapp=${currentUser?.userId || userId}`;
    const text = 'Join Groyper Mine and start mining!';
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    tg?.openTelegramLink ? tg.openTelegramLink(url) : window.open(url);
}

// ============================================================================
// WALLET & WITHDRAW
// ============================================================================
function renderWallet() {
    if (!currentUser) return;
    
    const u = tg?.initDataUnsafe?.user || {};
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    const img = (id, v) => { const e = $(id); if (e) e.src = v; };
    
    set('walletUserName', u.first_name || currentUser.firstName || 'User');
    set('walletUserHandle', '@' + (u.username || currentUser.username || 'user'));
    img('walletAvatar', u.photo_url || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff');
    
    set('totalWithdrawn', `${Math.floor(currentUser.totalWithdrawn || 0).toLocaleString()} ${CONFIG.tokenSymbol}`);
    set('availableToWithdraw', `${Math.floor(currentUser.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`);
    set('withdrawWalletAddress', tonWalletAddress ? `${tonWalletAddress.slice(0, 6)}…${tonWalletAddress.slice(-6)}` : 'Not connected');
    set('minWithdrawHint', `Minimum: ${CONFIG.MIN_WITHDRAW.toLocaleString()} ${CONFIG.tokenSymbol}`);
    
    renderWithdrawHistory();
}

async function renderWithdrawHistory() {
    const h = $('withdrawHistory');
    if (!h) return;
    
    const res = await apiRequest('/withdrawals');
    if (!res.success || !res.items?.length) {
        h.innerHTML = '<div class="empty-state">No withdrawals yet</div>';
        return;
    }
    
    h.innerHTML = res.items.map(w => `
        <div class="history-item">
            <div>
                <span class="history-amount">${w.amount.toLocaleString()} ${CONFIG.tokenSymbol}</span>
                <small style="display:block;opacity:.6;font-size:11px">${new Date(w.createdAt).toLocaleDateString()}</small>
            </div>
            <span class="history-status ${w.status}">${w.status.toUpperCase()}</span>
        </div>
    `).join('');
}

function validateWithdrawInput() {
    const inp = $('withdrawAmount');
    if (!inp || !currentUser) return;
    const v = parseFloat(inp.value);
    inp.classList.remove('valid', 'invalid');
    if (!inp.value) return;
    if (v < CONFIG.MIN_WITHDRAW || v > (currentUser.balance || 0)) inp.classList.add('invalid');
    else inp.classList.add('valid');
}

async function submitWithdraw() {
    if (isProcessingWithdraw || !currentUser) return;
    
    const amount = Math.floor(parseFloat($('withdrawAmount')?.value) || 0);
    if (amount < CONFIG.MIN_WITHDRAW) return showToast(`Minimum ${CONFIG.MIN_WITHDRAW}`, 'error');
    if (amount > currentUser.balance) return showToast('Insufficient balance', 'error');
    if (!tonWalletAddress) return showToast('Connect wallet first', 'error');
    
    isProcessingWithdraw = true;
    const btn = $('withdrawBtn');
    const original = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> PROCESSING...'; }
    
    try {
        // 1. Request intent from server
        const intent = await apiRequest('/withdraw/intent', { method: 'POST', body: { amount } });
        if (!intent.success) throw new Error(intent.error);
        
        // 2. If fee required, send payment
        let boc = null;
        if (intent.feeRequired) {
            try {
                const result = await window.tonConnectUI.sendTransaction({
                    validUntil: Math.floor(Date.now() / 1000) + 600,
                    messages: [{
                        address: intent.address,
                        amount: String(Math.round(intent.amountTon * 1e9)),
                        payload: intent.payload
                    }]
                });
                boc = result.boc;
            } catch (e) {
                throw new Error('Payment cancelled');
            }
        }
        
        // 3. Confirm
        const confirm = await apiRequest('/withdraw/confirm', {
            method: 'POST',
            body: { requestId: intent.requestId, boc }
        });
        if (!confirm.success) throw new Error(confirm.error);
        
        currentUser = confirm.user;
        $('withdrawAmount').value = '';
        vibrate('success');
        showToast('✅ Withdrawal submitted!', 'success');
        confetti();
        renderAll();
    } catch (e) {
        showToast(e.message || 'Withdrawal failed', 'error');
        vibrate('error');
    } finally {
        isProcessingWithdraw = false;
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}

// ============================================================================
// BOOSTS
// ============================================================================
async function buyBoost(type) {
    if (!tonConnected) return showToast('Connect wallet first', 'warning');
    const boost = CONFIG.BOOSTS[type];
    if (!boost) return;
    
    const ok = tg?.showConfirm
        ? await new Promise(r => tg.showConfirm(`Activate ${boost.name} (${boost.multiplier}x) for ${boost.price} TON?`, r))
        : confirm(`Activate ${boost.name} for ${boost.price} TON?`);
    if (!ok) return;
    
    try {
        const intent = await apiRequest('/boost/intent', { method: 'POST', body: { type } });
        if (!intent.success) throw new Error(intent.error);
        
        let boc;
        try {
            const result = await window.tonConnectUI.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 600,
                messages: [{
                    address: intent.address,
                    amount: String(Math.round(intent.amountTon * 1e9)),
                    payload: intent.payload
                }]
            });
            boc = result.boc;
        } catch (e) {
            throw new Error('Payment cancelled');
        }
        
        const confirm = await apiRequest('/boost/confirm', {
            method: 'POST',
            body: { requestId: intent.requestId, boc }
        });
        if (!confirm.success) throw new Error(confirm.error);
        
        currentUser = confirm.user;
        vibrate('success');
        showToast(`🔥 ${boost.name} activated!`, 'success');
        confetti();
        renderAll();
    } catch (e) {
        showToast(e.message || 'Boost failed', 'error');
        vibrate('error');
    }
}

// ============================================================================
// EFFECTS
// ============================================================================
function confetti() {
    const colors = ['#FF4D00', '#FF9500', '#FFD84D', '#F5C451'];
    for (let i = 0; i < 40; i++) {
        const el = document.createElement('i');
        el.style.cssText = `position:fixed;top:-10px;left:${Math.random() * innerWidth}px;width:7px;height:10px;background:${colors[i % 4]};z-index:9999;pointer-events:none;transition:transform ${1.2 + Math.random()}s ease-in,opacity 1.8s`;
        document.body.appendChild(el);
        requestAnimationFrame(() => {
            el.style.transform = `translate(${(Math.random() - .5) * 160}px,${innerHeight + 20}px) rotate(${Math.random() * 720}deg)`;
            el.style.opacity = 0;
        });
        setTimeout(() => el.remove(), 2400);
    }
}

// ============================================================================
// NAVIGATION
// ============================================================================
function switchPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = $('page' + name.charAt(0).toUpperCase() + name.slice(1));
    if (page) page.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === name));
    vibrate('light');
    scrollTo({ top: 0 });
    
    if (name === 'referral') loadReferralList();
    if (name === 'wallet') renderWithdrawHistory();
}

// ============================================================================
// RENDER ALL
// ============================================================================
function renderAll() {
    updateHeaderWallet();
    renderMining();
    renderAds();
    renderTasks();
    renderCheckin();
    renderReferral();
    renderWallet();
    renderToken();
}

// ============================================================================
// EVENT BINDING
// ============================================================================
function bindEvents() {
    document.querySelectorAll('.nav-item').forEach(i => {
        i.addEventListener('click', () => switchPage(i.dataset.page));
    });
    
    const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
    on('claimMiningBtn', claimMining);
    on('watchAdBtn', watchAd);
    on('claimAdsBtn', claimAdsReward);
    on('withdrawBtn', submitWithdraw);
    on('checkinBtn', checkin);
    on('refreshTokenBtn', () => fetchTokenPrice(true));
    on('copyReferralBtn', copyReferral);
    on('shareReferralBtn', shareReferral);
    on('maxWithdrawBtn', () => {
        const inp = $('withdrawAmount');
        if (inp && currentUser) { inp.value = Math.floor(currentUser.balance || 0); validateWithdrawInput(); }
    });
    on('copyContractBtn', () => {
        navigator.clipboard?.writeText(CONFIG.tokenAddress);
        showToast('Contract copied!', 'success');
    });
    
    $('withdrawAmount')?.addEventListener('input', validateWithdrawInput);
    
    // Delegation for tasks, milestones, boost cards
    document.addEventListener('click', e => {
        const boost = e.target.closest('[data-boost]');
        if (boost) { buyBoost(boost.dataset.boost); return; }
        
        const tb = e.target.closest('.task-btn[data-act]');
        if (tb) {
            const id = tb.closest('[data-task-id]')?.dataset.taskId;
            if (id) taskAction(id, tb.dataset.act);
            return;
        }
        
        const ms = e.target.closest('[data-ms]');
        if (ms) { claimMilestone(ms.dataset.ms); return; }
    });
}

// ============================================================================
// INIT
// ============================================================================
function init() {
    console.log('🚀 Groyper Mine starting...');
    
    userId = tg?.initDataUnsafe?.user?.id?.toString() || new URLSearchParams(location.search).get('userId');
    if (!userId) {
        console.error('❌ No userId found');
        showToast('Please open from Telegram', 'error');
        return;
    }
    console.log('📱 User ID:', userId);
    
    // Init TonConnect FIRST
    initTonConnect();
    
    // Bind UI events
    bindEvents();
    
    // Boot: fetch user, config, etc.
    boot().then(() => {
        booted = true;
        if (window.tonConnectUI?.wallet && !currentUser) {
            // Wallet already connected but not registered
            tonConnected = true;
            tonWalletAddress = window.tonConnectUI.wallet.account.address;
        }
    });
    
    // Refresh price every 2 minutes
    setInterval(() => {
        if (!document.hidden && booted) fetchTokenPrice();
    }, 120000);
    
    // Resync when visible after 60s
    let lastVisible = Date.now();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && booted && Date.now() - lastVisible > 60000) {
            lastVisible = Date.now();
            boot(true);
        }
    });
}

// Start when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
