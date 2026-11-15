// ============================================================================
// GROYPER MINE — EMBER VAULT v2.2
// Complete app.js — all features + all fixes + all additions
// Fixes:    BUG-3 (live mining timer), BUG-4 (token data display)
// Adds:     referral earnings card, referral link + copy, balance inside mining card
// ============================================================================
'use strict';

// ----------------------------------------------------------------------------
// 0. TELEGRAM WEBAPP
// ----------------------------------------------------------------------------
const tg = window.Telegram?.WebApp;
if (tg) {
    try { tg.ready(); } catch {}
    try { tg.expand(); } catch {}
    try { tg.setHeaderColor('#07080D'); tg.setBackgroundColor('#07080D'); } catch {}
    try { tg.disableVerticalSwipes?.(); } catch {}
}

// ----------------------------------------------------------------------------
// 1. CONFIG (defaults — server can override via /api/init)
// ----------------------------------------------------------------------------
const CONFIG = {
    tokenSymbol: 'GROYP',
    tokenAddress: 'EQBvcsqG7hqsw-HQ8bemIYrO8I_GLDTSbNiro4WOC7jAG_CH',
    botUsername: 'GroyperMinebot',
    channelUrl: 'https://t.me/GroyperMine',
    groupUrl: 'https://t.me/communityGROYP',
    dexUrl: 'https://dedust.io/swap/TON/EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    MINING_REWARD: 20,
    MINING_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    REWARD_PER_AD: 2,
    MAX_ADS_PER_BATCH: 10,
    ADS_BATCH_REWARD: 20,
    ADS_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    ADS_MIN_GAP_SEC: 15,
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

// ----------------------------------------------------------------------------
// 2. STATE
// ----------------------------------------------------------------------------
let currentUser = null;
let userId = null;
let tasks = [];
let tonConnected = false;
let tonWalletAddress = null;
let isClaimingMining = false;
let isClaimingAds = false;
let isProcessingWithdraw = false;
let isCheckingIn = false;
let adSequenceActive = false;
let miningTimer = null;
let livePriceData = { price: 0, change24h: 0, mcap: 0, fdv: 0, liq: 0, vol: 0 };
let adsState = { watched: 0, accumulated: 0 };
let booted = false;
let serverOffset = 0;
let lastPriceFetch = 0;
let uiInjected = false;

const now = () => Date.now() + serverOffset;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// 3. HELPERS
// ----------------------------------------------------------------------------
function showToast(msg, type = 'info', dur = 3000) {
    const t = $('toast');
    const m = $('toastMessage');
    if (!t || !m) { try { console.log('[toast]', msg); } catch {} return; }
    m.textContent = msg;
    t.classList.remove('hidden');
    t.style.borderColor =
        type === 'success' ? 'var(--ok)' :
        type === 'error'   ? 'var(--bad)' :
        type === 'warning' ? 'var(--warn)' :
        'var(--line-2)';
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add('hidden'), dur);
}

function formatTimeLeft(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map((x) => String(x).padStart(2, '0')).join(':');
}

function formatUsd(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return '$' + (v / 1000000).toFixed(2) + 'M';
    if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'K';
    return '$' + v.toFixed(2);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function vibrate(type = 'light') {
    if (!tg?.HapticFeedback) return;
    try {
        if (type === 'light') tg.HapticFeedback.impactOccurred('light');
        else if (type === 'medium') tg.HapticFeedback.impactOccurred('medium');
        else if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
        else if (type === 'error') tg.HapticFeedback.notificationOccurred('error');
    } catch {}
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {}
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch { return false; }
}

// ----------------------------------------------------------------------------
// 4. API
// ----------------------------------------------------------------------------
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
        if (res.status === 503) {
            showMaintenance();
            return { success: false };
        }
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
    document.body.innerHTML =
        '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#F4F5F9;font:600 18px Inter;text-align:center;padding:24px;background:#07080D">🔧<br><br>Under maintenance</div>';
}

// ----------------------------------------------------------------------------
// 5. TON CONNECT
// ----------------------------------------------------------------------------
function initTonConnect() {
    if (typeof window.TON_CONNECT_UI === 'undefined') {
        console.error('TON_CONNECT_UI not loaded');
        return;
    }
    const root = $('ton-connect-btn');
    if (!root) { console.error('#ton-connect-btn missing'); return; }
    try {
        window.tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
            manifestUrl: location.origin + '/tonconnect-manifest.json',
            buttonRootId: 'ton-connect-btn',
            language: 'en'
        });

        window.tonConnectUI.onStatusChange(async (wallet) => {
            if (!wallet) {
                tonConnected = false;
                tonWalletAddress = null;
                return;
            }
            let friendly = wallet.account.address;
            try {
                friendly = window.TON_CONNECT_UI.toUserFriendlyAddress(wallet.account.address, false);
            } catch {}

            tonConnected = true;
            tonWalletAddress = friendly;

            if (booted && currentUser && currentUser.wallet === friendly) {
                renderHeader();
                return;
            }

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
        console.error('TonConnectUI init error:', e);
    }
}

async function sendTonTransaction(address, amountTon) {
    if (!window.tonConnectUI) throw new Error('Wallet not connected');
    const tx = {
        validUntil: Math.floor(Date.now() / 1000) + 360,
        messages: [{
            address,
            amount: String(Math.floor(amountTon * 1e9))
        }]
    };
    const result = await window.tonConnectUI.sendTransaction(tx);
    if (!result?.boc) throw new Error('No signature');
    return result.boc;
}

// ----------------------------------------------------------------------------
// 6. BOOT / ONBOARDING / ENTER APP
// ----------------------------------------------------------------------------
async function boot(silent = false) {
    const res = await apiRequest('/init');
    if (!res.success) {
        if (!silent) showToast(res.error || 'Connection failed', 'error');
        return;
    }

    Object.assign(CONFIG, res.config || {});
    serverOffset = (res.serverTime || Date.now()) - Date.now();
    tasks = res.tasks || [];

    // BUG-4 FIX: set price data from server immediately
    if (res.price) {
        livePriceData = {
            price:     res.price.usd || res.price.price || 0,
            change24h: res.price.change || res.price.change24h || 0,
            mcap:      res.price.mcap || 0,
            fdv:       res.price.fdv || 0,
            liq:       res.price.liq || 0,
            vol:       res.price.vol || 0
        };
        lastPriceFetch = Date.now();
    }

    if (res.banner) showToast(res.banner, 'info', 5000);

    // Referral userId
    const tgUser = tg?.initDataUnsafe?.user;
    if (tgUser?.id) userId = String(tgUser.id);

    if (res.user && res.user.wallet) {
        currentUser = res.user;
        tonWalletAddress = res.user.wallet;
        tonConnected = true;
        if (!userId && currentUser.userId) userId = String(currentUser.userId);
        enterApp();
    } else {
        showOnboarding();
    }
}

function showOnboarding() {
    const ob = $('onboardingScreen');
    const m = $('mainApp');
    if (ob) ob.classList.add('active');
    if (m) m.style.display = 'none';
}

function enterApp() {
    const ob = $('onboardingScreen');
    const m = $('mainApp');
    if (ob) ob.classList.remove('active');
    if (m) m.style.display = 'block';
    booted = true;

    // user profile
    const u = tg?.initDataUnsafe?.user || {};
    const avatarUrl = u.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.first_name || 'U') + '&background=FF4D00&color=fff';
    if ($('userAvatar')) $('userAvatar').src = avatarUrl;
    if ($('walletAvatar')) $('walletAvatar').src = avatarUrl;
    if ($('userName')) $('userName').textContent = u.first_name || currentUser?.firstName || 'User';
    if ($('walletUserName')) $('walletUserName').textContent = u.first_name || currentUser?.firstName || 'User';
    if ($('userHandle')) $('userHandle').textContent = '@' + (u.username || currentUser?.username || 'user');
    if ($('walletUserHandle')) $('walletUserHandle').textContent = '@' + (u.username || currentUser?.username || 'user');

    // build new UI (referral earnings / link / mining vault) if missing
    injectNewUI();

    // first full render — this includes token data from boot()
    renderAll();

    // BUG-3 FIX: mining timer runs always, no `document.hidden` guard
    if (miningTimer) clearInterval(miningTimer);
    miningTimer = setInterval(() => {
        renderMining();
        renderAds();
    }, 1000);

    // BUG-4 FIX: refresh price from DexScreener (fallback already rendered)
    fetchTokenPrice();
}

// Re-render immediately when the app becomes visible again (BUG-3 related)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && booted) {
        renderMining();
        renderAds();
        renderToken();
        renderHeader();
    }
});

// ----------------------------------------------------------------------------
// 7. TOKEN PRICE (BUG-4 fixed)
// ----------------------------------------------------------------------------
async function fetchTokenPrice(force = false) {
    if (!force && Date.now() - lastPriceFetch < 60000 && livePriceData.price > 0) {
        renderToken();
        return;
    }

    // 1) Try DexScreener direct
    try {
        const r = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${CONFIG.tokenAddress}`,
            { signal: AbortSignal.timeout(8000) }
        );
        const data = await r.json();
        const best = (data?.pairs || [])
            .sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0))[0];
        if (best) {
            livePriceData = {
                price:     parseFloat(best.priceUsd) || 0,
                change24h: parseFloat(best.priceChange?.h24) || 0,
                mcap:      parseFloat(best.marketCap) || 0,
                fdv:       parseFloat(best.fdv) || 0,
                liq:       parseFloat(best.liquidity?.usd) || 0,
                vol:       parseFloat(best.volume?.h24) || 0
            };
            lastPriceFetch = Date.now();
            renderToken();
            renderHeader();
            renderMining();
            return;
        }
    } catch (e) {
        console.warn('DexScreener failed:', e.message);
    }

    // 2) Fallback — server endpoint
    try {
        const res = await apiRequest('/price');
        if (res.success && res.price) {
            livePriceData = {
                price:     res.price.usd || res.price.price || 0,
                change24h: res.price.change || res.price.change24h || 0,
                mcap:      res.price.mcap || 0,
                fdv:       res.price.fdv || 0,
                liq:       res.price.liq || 0,
                vol:       res.price.vol || 0
            };
            lastPriceFetch = Date.now();
            renderToken();
            renderHeader();
            renderMining();
        }
    } catch (e) {
        console.warn('Server price fallback failed:', e.message);
    }
}

function renderToken() {
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    const price = livePriceData.price || 0;

    set('tokenPrice', '$' + (price < 0.01 ? price.toFixed(8) : price.toFixed(4)));
    set('tokenMarketCap', '$' + Math.round(livePriceData.mcap || 0).toLocaleString());
    set('tokenFdv',       '$' + Math.round(livePriceData.fdv  || 0).toLocaleString());
    set('tokenLiquidity', '$' + Math.round(livePriceData.liq  || 0).toLocaleString());
    set('tokenVolume',    '$' + Math.round(livePriceData.vol  || 0).toLocaleString());

    const ca = $('contractAddress');
    if (ca) {
        ca.innerHTML = '<i class="fas fa-file-contract"></i> ' +
            CONFIG.tokenAddress.slice(0, 6) + '…' + CONFIG.tokenAddress.slice(-6);
    }

    const ch = $('tokenChange');
    if (ch) {
        const c = livePriceData.change24h || 0;
        ch.textContent = (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
        ch.className = 'token-change ' + (c >= 0 ? 'positive' : 'negative');
    }
}

// ----------------------------------------------------------------------------
// 8. HEADER
// ----------------------------------------------------------------------------
function renderHeader() {
    if (currentUser) {
        const bal = $('headerBalance');
        const val = $('headerValue');
        const balance = currentUser.balance || 0;
        if (bal) bal.textContent = `${Math.floor(balance).toLocaleString()} ${CONFIG.tokenSymbol}`;
        if (val) val.textContent = `≈ ${formatUsd(balance * (livePriceData.price || 0))}`;
    }
    if (tonWalletAddress) {
        const addr = $('headerAddress');
        if (addr) {
            addr.innerHTML = `<i class="fas fa-wallet"></i> ${tonWalletAddress.slice(0, 4)}…${tonWalletAddress.slice(-4)}`;
        }
    }
}

// ----------------------------------------------------------------------------
// 9. MINING (BUG-3 fixed)
// ----------------------------------------------------------------------------
function getActiveMultiplier() {
    if (!currentUser) return 1;
    const exp = currentUser.boostExpiresAt || 0;
    if (exp && exp < now()) return 1;
    return currentUser.boostMultiplier || 1;
}

function getMiningData() {
    if (!currentUser) {
        return { canClaim: false, remainingMs: 0, progress: 0, reward: 0, liveAccrued: 0, multiplier: 1 };
    }
    const lastClaim = Number(currentUser.lastMiningClaim || 0);
    const cooldown  = Number(CONFIG.MINING_COOLDOWN_MS);
    const elapsed   = Math.max(0, now() - lastClaim);
    const capped    = Math.min(elapsed, cooldown);
    const multiplier = getActiveMultiplier();
    const fullReward = CONFIG.MINING_REWARD * multiplier;

    return {
        canClaim:    elapsed >= cooldown,
        remainingMs: Math.max(0, cooldown - capped),
        progress:    cooldown > 0 ? capped / cooldown : 1,
        reward:      fullReward,
        liveAccrued: fullReward * (cooldown > 0 ? capped / cooldown : 1),
        multiplier
    };
}

function renderMining() {
    if (!currentUser) return;
    const d = getMiningData();

    // ring
    const ring = $('ringProgress');
    if (ring) {
        const c = 2 * Math.PI * 90;
        ring.style.strokeDasharray = c;
        ring.style.strokeDashoffset = c * (1 - d.progress);
        ring.classList.remove('loading');
        ring.classList.toggle('active', d.canClaim);
    }

    // core amount
    const amt = $('minedAmount');
    if (amt) {
        amt.textContent = d.canClaim
            ? Math.floor(d.reward).toLocaleString()
            : d.liveAccrued.toFixed(3);
    }

    // core USD
    const usd = $('minedUsd');
    if (usd) {
        const value = (d.canClaim ? d.reward : d.liveAccrued) * (livePriceData.price || 0);
        usd.textContent = `≈ ${formatUsd(value)}`;
    }

    // timer
    const timer = $('miningTimer');
    if (timer) timer.textContent = d.canClaim ? 'READY' : formatTimeLeft(d.remainingMs);

    // multiplier
    const power = $('hashPower');
    if (power) power.textContent = `${d.multiplier}x`;

    // claim button
    const btn = $('claimMiningBtn');
    if (btn) {
        btn.disabled = !d.canClaim || isClaimingMining;
        const label = $('claimLabel');
        if (label) {
            label.textContent = d.canClaim
                ? `CLAIM ${Math.floor(d.reward).toLocaleString()} ${CONFIG.tokenSymbol}`
                : 'CLAIM MINING';
        }
    }

    // ADD-3: vault inside mining card
    const vaultBal = $('collectedBalance');
    if (vaultBal) {
        const balance = currentUser.balance || 0;
        vaultBal.textContent = Math.floor(balance).toLocaleString();
    }
    const vaultUsd = $('collectedUsd');
    if (vaultUsd) {
        const balance = currentUser.balance || 0;
        vaultUsd.textContent = `≈ ${formatUsd(balance * (livePriceData.price || 0))}`;
    }
}

async function claimMining() {
    if (isClaimingMining) return;
    if (!getMiningData().canClaim) return showToast('Not ready yet', 'warning');

    isClaimingMining = true;
    renderMining();

    try {
        const res = await apiRequest('/mining/claim', { method: 'POST' });
        if (!res.success) throw new Error(res.error || 'Claim failed');

        currentUser = res.user;
        vibrate('success');
        showToast(`+${Math.floor(res.reward).toLocaleString()} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Claim failed', 'error');
    } finally {
        isClaimingMining = false;
        renderMining();
    }
}

// ----------------------------------------------------------------------------
// 10. ADS
// ----------------------------------------------------------------------------
function renderAds() {
    if (!currentUser) return;
    const watched = currentUser.adsWatched || 0;
    const perBatch = CONFIG.MAX_ADS_PER_BATCH;
    const perAd = CONFIG.REWARD_PER_AD;
    const batchReward = CONFIG.ADS_BATCH_REWARD;
    const cooldownUntil = Number(currentUser.adsCooldownUntil || 0);
    const onCooldown = now() < cooldownUntil;

    // segments
    const segWrap = $('adsSegments');
    if (segWrap && segWrap.children.length !== perBatch) {
        segWrap.innerHTML = '';
        for (let i = 0; i < perBatch; i++) {
            const s = document.createElement('div');
            s.className = 'ads-segment';
            segWrap.appendChild(s);
        }
    }
    if (segWrap) {
        [...segWrap.children].forEach((el, i) => {
            el.classList.toggle('active', i < watched);
        });
    }

    // counter
    const counter = $('adsCounter');
    if (counter) counter.textContent = `${watched}/${perBatch}`;

    // accumulated
    const accum = $('adsAccumulated');
    if (accum) accum.textContent = `${watched * perAd} ${CONFIG.tokenSymbol}`;

    // buttons
    const watchBtn = $('watchAdBtn');
    const claimBtn = $('claimAdsBtn');
    const watchLabel = $('watchAdLabel');
    const claimLabel = $('claimAdsLabel');
    const cooldownBox = $('adsCooldown');
    const cooldownTimer = $('adsTimer');

    if (onCooldown) {
        if (watchBtn) watchBtn.style.display = 'none';
        if (claimBtn) claimBtn.style.display = 'none';
        if (cooldownBox) cooldownBox.style.display = 'block';
        if (cooldownTimer) cooldownTimer.textContent = formatTimeLeft(cooldownUntil - now());
    } else if (watched >= perBatch) {
        if (watchBtn) watchBtn.style.display = 'none';
        if (claimBtn) {
            claimBtn.style.display = 'flex';
            claimBtn.disabled = isClaimingAds;
        }
        if (claimLabel) claimLabel.textContent = `CLAIM ${batchReward} ${CONFIG.tokenSymbol}`;
        if (cooldownBox) cooldownBox.style.display = 'none';
    } else {
        if (watchBtn) {
            watchBtn.style.display = 'flex';
            watchBtn.disabled = adSequenceActive;
        }
        if (watchLabel) {
            watchLabel.textContent = `WATCH AD (+${perAd} ${CONFIG.tokenSymbol})`;
        }
        if (claimBtn) claimBtn.style.display = 'none';
        if (cooldownBox) cooldownBox.style.display = 'none';
    }
}

function tryTriggerAdSDK() {
    try {
        if (typeof window.show_12265394 === 'function') {
            window.show_12265394({
                type: 'inApp',
                inAppSettings: {
                    frequency: 2,
                    capping: 0.1,
                    interval: 30,
                    timeout: 5,
                    everyPage: false
                }
            });
        }
    } catch (e) {
        console.warn('Ad SDK error:', e);
    }
}

async function watchAd() {
    if (!currentUser || adSequenceActive) return;

    const watched = currentUser.adsWatched || 0;
    if (watched >= CONFIG.MAX_ADS_PER_BATCH) {
        return showToast('Batch complete — claim your reward', 'info');
    }
    if (now() < (currentUser.adsCooldownUntil || 0)) {
        return showToast('Ads are on cooldown', 'warning');
    }

    adSequenceActive = true;
    renderAds();

    try {
        const start = await apiRequest('/ads/start', { method: 'POST' });
        if (!start.success) throw new Error(start.error || 'Failed to start ad');

        // Try ad SDK (best effort)
        tryTriggerAdSDK();

        // Wait min gap (server enforces too)
        const gapMs = (CONFIG.ADS_MIN_GAP_SEC || 15) * 1000;
        await sleep(gapMs);

        const watch = await apiRequest('/ads/watch', {
            method: 'POST',
            body: { ymid: start.token || start.ymid }
        });
        if (!watch.success) throw new Error(watch.error || 'Ad not verified');

        if (currentUser) currentUser.adsWatched = watch.watched;
        adsState.watched = watch.watched;
        adsState.accumulated = watch.watched * CONFIG.REWARD_PER_AD;

        vibrate('success');
        showToast(`+${CONFIG.REWARD_PER_AD} ${CONFIG.tokenSymbol}`, 'success');
        renderAds();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Ad failed', 'error');
    } finally {
        adSequenceActive = false;
        renderAds();
    }
}

async function claimAds() {
    if (!currentUser || isClaimingAds) return;
    if ((currentUser.adsWatched || 0) < CONFIG.MAX_ADS_PER_BATCH) {
        return showToast('Watch all ads first', 'warning');
    }

    isClaimingAds = true;
    renderAds();

    try {
        const res = await apiRequest('/ads/claim', { method: 'POST' });
        if (!res.success) throw new Error(res.error || 'Claim failed');

        currentUser = res.user;
        vibrate('success');
        showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Claim failed', 'error');
    } finally {
        isClaimingAds = false;
        renderAds();
    }
}

// ----------------------------------------------------------------------------
// 11. CHECK-IN
// ----------------------------------------------------------------------------
function renderCheckin() {
    if (!currentUser) return;
    const streak = currentUser.streak || 0;
    const el = $('streakCount');
    if (el) el.textContent = `${streak} day streak`;

    const btn = $('checkinBtn');
    if (btn) {
        const today = Math.floor(now() / 86400e3);
        const last = Number(currentUser.lastCheckinDay || 0);
        btn.disabled = last === today || isCheckingIn;
        btn.style.opacity = (last === today) ? '0.55' : '1';
    }
}

async function doCheckin() {
    if (isCheckingIn) return;
    isCheckingIn = true;
    renderCheckin();
    try {
        const res = await apiRequest('/checkin', { method: 'POST' });
        if (!res.success) throw new Error(res.error || 'Check-in failed');

        currentUser = res.user;
        vibrate('success');
        showToast(`+${res.reward} ${CONFIG.tokenSymbol} · Streak ${res.user?.streak || 0}`, 'success');
        renderAll();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Check-in failed', 'error');
    } finally {
        isCheckingIn = false;
        renderCheckin();
    }
}

// ----------------------------------------------------------------------------
// 12. TASKS
// ----------------------------------------------------------------------------
function renderTasks() {
    const container = $('taskList');
    if (!container) return;

    if (!tasks.length) {
        container.innerHTML = '<div class="empty-state">No tasks available</div>';
        return;
    }

    const completed = currentUser?.completedTasks || [];

    container.innerHTML = tasks.map((t) => {
        const done = completed.includes(t.id);
        return `
            <div class="task-item ${done ? 'done' : ''}" data-task="${escapeHtml(t.id)}">
                <div class="task-icon"><i class="${escapeHtml(t.iconClass || 'fas fa-link')}"></i></div>
                <div class="task-info">
                    <div class="task-name">${escapeHtml(t.name)}</div>
                    <div class="task-reward">+${t.reward} ${CONFIG.tokenSymbol}</div>
                </div>
                <button class="task-btn ${done ? 'completed' : ''}" data-task-btn="${escapeHtml(t.id)}" ${done ? 'disabled' : ''}>
                    ${done ? 'DONE' : 'START'}
                </button>
            </div>
        `;
    }).join('');

    // bind
    container.querySelectorAll('[data-task-btn]').forEach((btn) => {
        btn.addEventListener('click', () => startTask(btn.getAttribute('data-task-btn')));
    });
}

async function startTask(taskId) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (task.verify === 'chat' || task.verify === 'delay') {
        // open URL
        try {
            if (tg && task.url) {
                if (/^https?:\/\//.test(task.url)) {
                    tg.openLink(task.url, { try_instant_view: false });
                }
            } else if (task.url) {
                window.open(task.url, '_blank');
            }
        } catch (e) {
            console.warn('openLink failed:', e);
        }

        if (task.verify === 'delay') {
            showToast(`Opened link · come back after ${task.delaySec || 20}s`, 'info');
            return;
        }

        // For chat: user must join, then tap START again to verify
        // Auto-verify after a short delay
        setTimeout(() => verifyTask(taskId), 2000);
    }
}

async function verifyTask(taskId) {
    try {
        const res = await apiRequest('/tasks/verify', {
            method: 'POST',
            body: { taskId }
        });
        if (!res.success) throw new Error(res.error || 'Verification failed');

        currentUser = res.user;
        vibrate('success');
        showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Verification failed', 'error');
    }
}

// ----------------------------------------------------------------------------
// 13. REFERRALS
// ----------------------------------------------------------------------------
function renderReferral() {
    if (!currentUser) return;

    const active   = currentUser.activeReferrals || 0;
    const inactive = currentUser.inactiveReferrals || 0;
    const earnings = (typeof currentUser.referralEarnings === 'number')
        ? currentUser.referralEarnings
        : active * CONFIG.REFERRAL_REWARD;

    const aEl = $('activeReferrals');
    if (aEl) aEl.textContent = active;
    const iEl = $('inactiveReferrals');
    if (iEl) iEl.textContent = inactive;

    // ADD-1: referral earnings
    const rEarn = $('referralEarnings');
    if (rEarn) rEarn.textContent = Math.floor(earnings).toLocaleString();

    // ADD-2: referral link
    const linkInput = $('referralLinkInput');
    if (linkInput && !linkInput.value && userId) {
        linkInput.value = `https://t.me/${CONFIG.botUsername}?start=${userId}`;
    }

    const rewardText = $('refRewardText');
    if (rewardText) rewardText.textContent = `${CONFIG.REFERRAL_REWARD} ${CONFIG.tokenSymbol}`;

    renderMilestones();
}

async function fetchReferrals() {
    const res = await apiRequest('/referrals');
    const container = $('referralList');
    if (!container) return;

    if (!res.success) {
        container.innerHTML = '<div class="empty-state">Failed to load</div>';
        return;
    }
    const items = res.items || [];
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No referrals yet</div>';
        return;
    }

    container.innerHTML = items.map((r) => {
        const name = r.username || 'user';
        const status = r.active ? 'ACTIVE' : 'INACTIVE';
        const cls = r.active ? 'active' : 'inactive';
        const avatar = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=FF4D00&color=fff&size=40';
        return `
            <div class="referral-item">
                <img src="${avatar}" alt="">
                <span class="referral-item-name">@${escapeHtml(name)}</span>
                <span class="referral-status ${cls}">${status}</span>
            </div>
        `;
    }).join('');
}

function shareReferral() {
    const link = userId ? `https://t.me/${CONFIG.botUsername}?start=${userId}` : '';
    if (!link) return showToast('Cannot build link', 'error');

    const text = `🔥 Join Groyper Mine & start mining $${CONFIG.tokenSymbol}! ${link}`;
    try {
        if (tg && tg.openTelegramLink) {
            tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
            return;
        }
    } catch {}
    copyToClipboard(text).then((ok) => {
        showToast(ok ? 'Copied to clipboard' : 'Share failed', ok ? 'success' : 'error');
    });
}

// ----------------------------------------------------------------------------
// 14. MILESTONES
// ----------------------------------------------------------------------------
function renderMilestones() {
    const container = $('milestoneList');
    if (!container || !currentUser) return;

    const active = currentUser.activeReferrals || 0;
    const claimed = currentUser.claimedMilestones || [];

    container.innerHTML = CONFIG.MILESTONES.map((m) => {
        const isClaimed = claimed.includes(m.count);
        const canClaim = active >= m.count && !isClaimed;
        const progress = Math.min(100, (active / m.count) * 100);
        const cls = isClaimed ? 'completed' : (active >= m.count ? 'current' : '');

        return `
            <div class="milestone-item ${cls}">
                <div class="milestone-icon">${isClaimed ? '<i class="fas fa-check"></i>' : '🏆'}</div>
                <div class="milestone-info">
                    <div class="milestone-count">${m.count} referrals</div>
                    <div class="milestone-reward">+${m.reward} ${CONFIG.tokenSymbol}</div>
                    <div class="milestone-bar"><i style="width:${progress}%"></i></div>
                </div>
                ${canClaim ? `<button class="task-btn" data-claim-milestone="${m.count}">CLAIM</button>` : ''}
            </div>
        `;
    }).join('');

    container.querySelectorAll('[data-claim-milestone]').forEach((btn) => {
        btn.addEventListener('click', () => claimMilestone(Number(btn.getAttribute('data-claim-milestone'))));
    });
}

async function claimMilestone(count) {
    try {
        const res = await apiRequest('/referrals/milestone', {
            method: 'POST',
            body: { count }
        });
        if (!res.success) throw new Error(res.error || 'Claim failed');

        currentUser = res.user;
        vibrate('success');
        showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Claim failed', 'error');
    }
}

// ----------------------------------------------------------------------------
// 15. WALLET / WITHDRAW
// ----------------------------------------------------------------------------
function renderWallet() {
    if (!currentUser) return;

    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('totalWithdrawn', `${Math.floor(currentUser.totalWithdrawn || 0).toLocaleString()} ${CONFIG.tokenSymbol}`);
    set('availableToWithdraw', `${Math.floor(currentUser.balance || 0).toLocaleString()} ${CONFIG.tokenSymbol}`);

    const addrEl = $('withdrawWalletAddress');
    if (addrEl) addrEl.textContent = currentUser.wallet || '—';

    const minHint = $('minWithdrawHint');
    if (minHint) minHint.textContent = `Minimum: ${CONFIG.MIN_WITHDRAW.toLocaleString()} ${CONFIG.tokenSymbol}`;
}

function validateWithdrawAmount() {
    const input = $('withdrawAmount');
    if (!input) return;
    const val = Number(input.value);
    const bal = currentUser?.balance || 0;
    input.classList.remove('valid', 'invalid');
    if (!input.value) return;
    if (val >= CONFIG.MIN_WITHDRAW && val <= bal) input.classList.add('valid');
    else input.classList.add('invalid');
}

async function submitWithdraw() {
    if (!currentUser || isProcessingWithdraw) return;

    const input = $('withdrawAmount');
    const amount = Math.floor(Number(input?.value || 0));
    const balance = Math.floor(currentUser.balance || 0);

    if (!(amount >= CONFIG.MIN_WITHDRAW)) {
        return showToast(`Minimum withdrawal: ${CONFIG.MIN_WITHDRAW}`, 'warning');
    }
    if (amount > balance) {
        return showToast('Insufficient balance', 'warning');
    }
    if (!currentUser.wallet) {
        return showToast('Connect your wallet first', 'warning');
    }

    isProcessingWithdraw = true;
    try {
        const intent = await apiRequest('/withdraw/intent', {
            method: 'POST',
            body: { amount }
        });
        if (!intent.success) throw new Error(intent.error || 'Intent failed');

        let boc = null;
        if (intent.feeRequired) {
            showToast(`Confirm ${intent.amountTon} TON in wallet…`, 'info');
            boc = await sendTonTransaction(intent.address, intent.amountTon);
        }

        const confirm = await apiRequest('/withdraw/confirm', {
            method: 'POST',
            body: { requestId: intent.requestId, boc }
        });
        if (!confirm.success) throw new Error(confirm.error || 'Confirm failed');

        currentUser = confirm.user;
        if (input) input.value = '';
        vibrate('success');
        showToast('Withdrawal request submitted', 'success');
        renderAll();
        fetchWithdrawals();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Withdraw failed', 'error');
    } finally {
        isProcessingWithdraw = false;
    }
}

async function fetchWithdrawals() {
    const container = $('withdrawHistory');
    if (!container) return;

    const res = await apiRequest('/withdrawals');
    if (!res.success) {
        container.innerHTML = '<div class="empty-state">Failed to load</div>';
        return;
    }
    const items = res.items || [];
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No withdrawals yet</div>';
        return;
    }

    container.innerHTML = items.map((w) => {
        const date = new Date(w.createdAt || Date.now()).toLocaleString();
        return `
            <div class="history-item">
                <div>
                    <div class="history-amount">${Math.floor(w.amount).toLocaleString()} ${CONFIG.tokenSymbol}</div>
                    <div style="font-size:11px;color:var(--tx-3);margin-top:2px">${escapeHtml(date)}</div>
                </div>
                <span class="history-status ${escapeHtml(w.status || 'pending')}">${escapeHtml((w.status || 'pending').toUpperCase())}</span>
            </div>
        `;
    }).join('');
}

// ----------------------------------------------------------------------------
// 16. BOOSTS
// ----------------------------------------------------------------------------
async function purchaseBoost(type) {
    if (!currentUser) return;
    if (!currentUser.wallet) return showToast('Connect your wallet first', 'warning');

    const plan = CONFIG.BOOSTS[type];
    if (!plan) return;

    try {
        const intent = await apiRequest('/boost/intent', {
            method: 'POST',
            body: { type }
        });
        if (!intent.success) throw new Error(intent.error || 'Intent failed');

        showToast(`Confirm ${intent.amountTon} TON in wallet…`, 'info');
        const boc = await sendTonTransaction(intent.address, intent.amountTon);

        const confirm = await apiRequest('/boost/confirm', {
            method: 'POST',
            body: { requestId: intent.requestId, boc }
        });
        if (!confirm.success) throw new Error(confirm.error || 'Confirm failed');

        currentUser = confirm.user;
        vibrate('success');
        showToast(`${plan.name} activated!`, 'success');
        renderAll();
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Purchase failed', 'error');
    }
}

// ----------------------------------------------------------------------------
// 17. NAVIGATION
// ----------------------------------------------------------------------------
function switchPage(page) {
    const pages = ['home', 'earn', 'referral', 'wallet'];
    if (!pages.includes(page)) return;

    pages.forEach((p) => {
        const el = document.getElementById('page' + p.charAt(0).toUpperCase() + p.slice(1));
        if (el) el.classList.toggle('active', p === page);
    });

    document.querySelectorAll('.nav-item').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-page') === page);
    });

    if (page === 'wallet') fetchWithdrawals();
    if (page === 'referral') fetchReferrals();
}

// ----------------------------------------------------------------------------
// 18. EMBERS CANVAS (background animation)
// ----------------------------------------------------------------------------
function startEmbers() {
    const canvas = $('embersCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0, h = 0, dpr = 1, particles = [];
    const PCOUNT = 40;

    function resize() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function spawn() {
        particles = [];
        for (let i = 0; i < PCOUNT; i++) {
            particles.push({
                x: Math.random() * w,
                y: h + Math.random() * h * 0.5,
                r: Math.random() * 1.5 + 0.4,
                vy: -(Math.random() * 0.5 + 0.2),
                vx: (Math.random() - 0.5) * 0.15,
                a: Math.random() * 0.4 + 0.2,
                hue: 20 + Math.random() * 20
            });
        }
    }

    function frame() {
        ctx.clearRect(0, 0, w, h);
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.y < -10) {
                p.y = h + 10;
                p.x = Math.random() * w;
            }
            const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
            grad.addColorStop(0, `hsla(${p.hue}, 100%, 60%, ${p.a})`);
            grad.addColorStop(1, `hsla(${p.hue}, 100%, 60%, 0)`);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 6, 0, Math.PI * 2);
            ctx.fill();
        }
        requestAnimationFrame(frame);
    }

    resize();
    spawn();
    window.addEventListener('resize', () => { resize(); spawn(); });
    requestAnimationFrame(frame);
}

// ----------------------------------------------------------------------------
// 19. INJECT NEW UI (ADD-1, ADD-2, ADD-3)
// Called once after enterApp. Creates elements only if missing.
// ----------------------------------------------------------------------------
function injectNewUI() {
    if (uiInjected) return;
    uiInjected = true;

    // ADD-3: vault inside mining card
    const miningCard = document.querySelector('.mining-card');
    const claimBtn = $('claimMiningBtn');
    if (miningCard && claimBtn && !$('collectedBalance')) {
        const vault = document.createElement('div');
        vault.className = 'mining-collected';
        vault.innerHTML = `
            <div class="collected-label">YOUR VAULT</div>
            <div class="collected-amount">
                <span id="collectedBalance">0</span>
                <small>${escapeHtml(CONFIG.tokenSymbol)}</small>
            </div>
            <div class="collected-usd" id="collectedUsd">≈ $0.00</div>
        `;
        claimBtn.parentElement.insertBefore(vault, claimBtn);
    }

    // ADD-1 + ADD-2: inside pageReferral
    const pageRef = $('pageReferral');
    if (pageRef) {
        const inviteCard = pageRef.querySelector('.invite-card');

        // ADD-1: earnings
        if (!$('referralEarnings')) {
            const earn = document.createElement('div');
            earn.className = 'card referral-earnings-card';
            earn.innerHTML = `
                <div class="referral-earnings-inner">
                    <div class="earnings-icon"><i class="fas fa-coins"></i></div>
                    <div class="earnings-text">
                        <div class="earnings-label">EARNED FROM REFERRALS</div>
                        <div class="earnings-value">
                            <span id="referralEarnings">0</span>
                            <small>${escapeHtml(CONFIG.tokenSymbol)}</small>
                        </div>
                    </div>
                </div>
            `;
            if (inviteCard && inviteCard.parentElement) inviteCard.after(earn);
            else pageRef.insertBefore(earn, pageRef.firstChild);
        }

        // ADD-2: referral link + copy
        if (!$('referralLinkInput')) {
            const linkCard = document.createElement('div');
            linkCard.className = 'card referral-link-card';
            linkCard.innerHTML = `
                <h3 class="card-title">
                    <i class="fas fa-link"></i>
                    <span>Your Invite Link</span>
                </h3>
                <div class="referral-link-box">
                    <input type="text" id="referralLinkInput" readonly value="">
                    <button id="copyRefLinkBtn" class="btn-copy-link" aria-label="Copy link">
                        <i class="fas fa-copy"></i>
                    </button>
                </div>
            `;
            const earningsCard = document.querySelector('.referral-earnings-card');
            if (earningsCard && earningsCard.parentElement) earningsCard.after(linkCard);
            else if (inviteCard && inviteCard.parentElement) inviteCard.after(linkCard);
            else pageRef.insertBefore(linkCard, pageRef.firstChild);

            // bind copy
            const copyBtn = linkCard.querySelector('#copyRefLinkBtn');
            const input = linkCard.querySelector('#referralLinkInput');
            if (copyBtn && input) {
                copyBtn.addEventListener('click', async () => {
                    if (!input.value) return;
                    const ok = await copyToClipboard(input.value);
                    vibrate(ok ? 'success' : 'error');
                    showToast(ok ? 'Link copied!' : 'Copy failed', ok ? 'success' : 'error');
                });
            }
        }
    }
}

// ----------------------------------------------------------------------------
// 20. RENDER ALL
// ----------------------------------------------------------------------------
function renderAll() {
    renderHeader();
    renderToken();
    renderMining();
    renderAds();
    renderCheckin();
    renderTasks();
    renderReferral();
    renderWallet();
    fetchReferrals();
    fetchWithdrawals();
}

// ----------------------------------------------------------------------------
// 21. WIRE UP EVENTS (once)
// ----------------------------------------------------------------------------
function bindEvents() {
    // nav
    document.querySelectorAll('.nav-item').forEach((btn) => {
        btn.addEventListener('click', () => switchPage(btn.getAttribute('data-page') || 'home'));
    });

    // mining claim
    $('claimMiningBtn')?.addEventListener('click', claimMining);

    // ads
    $('watchAdBtn')?.addEventListener('click', watchAd);
    $('claimAdsBtn')?.addEventListener('click', claimAds);

    // check-in
    $('checkinBtn')?.addEventListener('click', doCheckin);

    // referral: copy + share (existing buttons in HTML)
    $('copyReferralBtn')?.addEventListener('click', async () => {
        if (!userId) return;
        const link = `https://t.me/${CONFIG.botUsername}?start=${userId}`;
        const ok = await copyToClipboard(link);
        vibrate(ok ? 'success' : 'error');
        showToast(ok ? 'Link copied!' : 'Copy failed', ok ? 'success' : 'error');
    });
    $('shareReferralBtn')?.addEventListener('click', shareReferral);

    // token refresh
    $('refreshTokenBtn')?.addEventListener('click', () => {
        vibrate('light');
        fetchTokenPrice(true);
    });

    // copy contract
    $('copyContractBtn')?.addEventListener('click', async () => {
        const ok = await copyToClipboard(CONFIG.tokenAddress);
        vibrate(ok ? 'success' : 'error');
        showToast(ok ? 'Contract copied!' : 'Copy failed', ok ? 'success' : 'error');
    });

    // boost cards
    document.querySelectorAll('.boost-card').forEach((card) => {
        card.addEventListener('click', () => {
            const type = card.getAttribute('data-boost');
            if (type) purchaseBoost(type);
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const type = card.getAttribute('data-boost');
                if (type) purchaseBoost(type);
            }
        });
    });

    // withdraw
    $('withdrawBtn')?.addEventListener('click', submitWithdraw);
    $('maxWithdrawBtn')?.addEventListener('click', () => {
        if (!currentUser) return;
        const input = $('withdrawAmount');
        if (!input) return;
        const max = Math.floor(currentUser.balance || 0);
        input.value = max >= CONFIG.MIN_WITHDRAW ? max : '';
        validateWithdrawAmount();
    });
    $('withdrawAmount')?.addEventListener('input', validateWithdrawAmount);
}

// ----------------------------------------------------------------------------
// 22. INIT
// ----------------------------------------------------------------------------
function init() {
    bindEvents();
    startEmbers();
    initTonConnect();
    boot();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
