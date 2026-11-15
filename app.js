// ============================================================================
// GROYPER MINE — EMBER VAULT v2.4
// Full rewrite with all fixes and new integrations.
// Fixes:    referral link format (/Mine?startapp=), ad loading freeze
// Adds:     Adexium (interstitial, manual only), Monetag + Adexium rotation,
//           removed RichAds (does not support manual show)
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
    tokenAddress: 'EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P',
    botUsername: 'GroyperMinebot',
    botShortName: 'Mine',
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
let adSequenceActive = false;
let miningTimer = null;
let livePriceData = { price: 0, change24h: 0, mcap: 0, fdv: 0, liq: 0, vol: 0 };
let adsState = { watched: 0, accumulated: 0, token: null };
let booted = false;
let serverOffset = 0;
let lastPriceFetch = 0;

const now = () => Date.now() + serverOffset;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// 3. UTILITIES
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

// Build the correct referral link (opens Mini App directly)
function buildReferralLink(uid) {
    if (!uid) return '';
    return `https://t.me/${CONFIG.botUsername}/${CONFIG.botShortName}?startapp=${uid}`;
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
                updateHeaderWallet();
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

    if (res.price) {
        livePriceData = {
            price:     Number(res.price.usd || res.price.price) || 0,
            change24h: Number(res.price.change || res.price.change24h) || 0,
            mcap:      Number(res.price.mcap) || 0,
            fdv:       Number(res.price.fdv) || 0,
            liq:       Number(res.price.liq) || 0,
            vol:       Number(res.price.vol) || 0
        };
        lastPriceFetch = Date.now();
    }

    if (res.banner) showToast(res.banner, 'info', 5000);

    const tgUser = tg?.initDataUnsafe?.user;
    if (tgUser?.id) userId = String(tgUser.id);
    if (res.user?.userId) userId = String(res.user.userId);

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

    const u = tg?.initDataUnsafe?.user || {};
    const avatarUrl = u.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.first_name || 'U') + '&background=FF4D00&color=fff';
    if ($('userAvatar')) $('userAvatar').src = avatarUrl;
    if ($('walletAvatar')) $('walletAvatar').src = avatarUrl;
    if ($('userName')) $('userName').textContent = u.first_name || currentUser?.firstName || 'User';
    if ($('walletUserName')) $('walletUserName').textContent = u.first_name || currentUser?.firstName || 'User';
    if ($('userHandle')) $('userHandle').textContent = '@' + (u.username || currentUser?.username || 'user');
    if ($('walletUserHandle')) $('walletUserHandle').textContent = '@' + (u.username || currentUser?.username || 'user');

    renderAll();

    if (miningTimer) clearInterval(miningTimer);
    miningTimer = setInterval(() => {
        if (document.hidden) return;
        renderMining();
        renderAds();
    }, 1000);

    fetchTokenPrice();
}

// Re-render immediately when the app becomes visible again
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && booted) {
        renderMining();
        renderAds();
        renderToken();
        updateHeaderWallet();
    }
});

// ----------------------------------------------------------------------------
// 7. TOKEN PRICE
// ----------------------------------------------------------------------------
async function fetchTokenPrice(force = false) {
    if (!force && Date.now() - lastPriceFetch < 60000 && livePriceData.price > 0) {
        renderToken();
        return;
    }

    // 1) DexScreener
    try {
        const r = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${CONFIG.tokenAddress}`,
            { signal: AbortSignal.timeout(8000) }
        );
        if (r.ok) {
            const data = await r.json();
            const best = (data?.pairs || [])
                .sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0))[0];
            if (best && parseFloat(best.priceUsd) > 0) {
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
                updateHeaderWallet();
                renderMining();
                return;
            }
        }
    } catch (e) {
        console.warn('DexScreener failed:', e.message);
    }

    // 2) Server fallback
    try {
        const res = await apiRequest('/price');
        if (res.success && res.price) {
            livePriceData = {
                price:     Number(res.price.usd || res.price.price) || 0,
                change24h: Number(res.price.change || res.price.change24h) || 0,
                mcap:      Number(res.price.mcap) || 0,
                fdv:       Number(res.price.fdv) || 0,
                liq:       Number(res.price.liq) || 0,
                vol:       Number(res.price.vol) || 0
            };
            lastPriceFetch = Date.now();
            renderToken();
            updateHeaderWallet();
            renderMining();
        }
    } catch (e) {
        console.warn('Server price fallback failed:', e.message);
    }
}

function renderToken() {
    const price = livePriceData.price || 0;
    const hasData = price > 0 || livePriceData.mcap > 0 || livePriceData.liq > 0;

    const priceEl = $('tokenPrice');
    if (priceEl) {
        if (price > 0) {
            priceEl.textContent = '$' + (price < 0.01 ? price.toFixed(8) : price.toFixed(4));
            priceEl.style.opacity = '1';
        } else {
            priceEl.textContent = '—';
            priceEl.style.opacity = '0.5';
        }
    }

    const ch = $('tokenChange');
    if (ch) {
        const c = livePriceData.change24h || 0;
        if (hasData && c !== 0) {
            ch.textContent = (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
            ch.className = 'token-change ' + (c >= 0 ? 'positive' : 'negative');
        } else {
            ch.textContent = '—';
            ch.className = 'token-change';
        }
    }

    const fmtMoney = (v) => {
        const n = Number(v) || 0;
        if (n >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
        if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
        if (n > 0) return '$' + n.toFixed(2);
        return '—';
    };
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('tokenMarketCap', fmtMoney(livePriceData.mcap));
    set('tokenFdv',       fmtMoney(livePriceData.fdv));
    set('tokenLiquidity', fmtMoney(livePriceData.liq));
    set('tokenVolume',    fmtMoney(livePriceData.vol));

    // Contract address — MUST use innerHTML
    const ca = $('contractAddress');
    if (ca) {
        const shortAddr = CONFIG.tokenAddress.slice(0, 6) + '…' + CONFIG.tokenAddress.slice(-6);
        ca.innerHTML = '<i class="fas fa-file-contract" aria-hidden="true"></i> ' + shortAddr;
    }
}

// ----------------------------------------------------------------------------
// 8. HEADER
// ----------------------------------------------------------------------------
function updateHeaderWallet() {
    if (currentUser) {
        const bal = $('headerBalance');
        const val = $('headerValue');
        const balance = Number(currentUser.balance) || 0;
        const price = Number(livePriceData.price) || 0;

        if (bal) bal.textContent = `${Math.floor(balance).toLocaleString()} ${CONFIG.tokenSymbol}`;
        if (val) val.textContent = `≈ ${price > 0 ? formatUsd(balance * price) : '$0.00'}`;
    }
    if (tonWalletAddress) {
        const addr = $('headerAddress');
        if (addr) {
            addr.innerHTML = `<i class="fas fa-wallet" aria-hidden="true"></i> ${tonWalletAddress.slice(0, 4)}…${tonWalletAddress.slice(-4)}`;
        }
    }
}

// ----------------------------------------------------------------------------
// 9. MINING
// ----------------------------------------------------------------------------
function getMiningData() {
    if (!currentUser) return { canClaim: false, remainingMs: 0, progress: 0, reward: 0, liveAccrued: 0, multiplier: 1 };

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
    if (amt) {
        amt.textContent = d.canClaim
            ? Math.floor(d.reward).toLocaleString()
            : d.liveAccrued.toFixed(3);
    }

    const usd = $('minedUsd');
    if (usd) {
        const value = (d.canClaim ? d.reward : d.liveAccrued) * (livePriceData.price || 0);
        usd.textContent = `≈ ${formatUsd(value)}`;
    }

    const timer = $('miningTimer');
    if (timer) timer.textContent = d.canClaim ? 'READY' : formatTimeLeft(d.remainingMs);

    const power = $('hashPower');
    if (power) power.textContent = `${d.multiplier}x`;

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
// 10. ADS — Monetag + Adexium (manual only)
// ----------------------------------------------------------------------------
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

    const w = currentUser.adsWatched || 0;
    const perAd = CONFIG.ADS_BATCH_REWARD / CONFIG.MAX_ADS_PER_BATCH;
    const acc = $('adsAccumulated');
    const counter = $('adsCounter');
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

// Adexium — try every known show method safely
function showAdexiumAd() {
    const w = window.adexiumWidget;
    if (!w) return false;

    const methods = ['show', 'showAd', 'showInterstitial', 'display', 'open'];
    for (const m of methods) {
        if (typeof w[m] === 'function') {
            try {
                w[m]();
                console.log(`📺 Ad provider: Adexium (${m})`);
                return true;
            } catch (e) {
                console.warn(`Adexium.${m} failed:`, e);
            }
        }
    }
    return false;
}

// Monetag
function showMonetagAd() {
    if (typeof window.show_12265394 !== 'function') return false;
    try {
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
        console.log('📺 Ad provider: Monetag');
        return true;
    } catch (e) {
        console.warn('Monetag failed:', e);
        return false;
    }
}

// Random provider: 50% Monetag, 50% Adexium
function tryTriggerAdSDK() {
    const providers = [];

    if (typeof window.show_12265394 === 'function') providers.push('monetag');
    if (window.adexiumWidget) providers.push('adexium');

    if (!providers.length) {
        console.warn('❌ No ad providers available');
        return null;
    }

    const provider = providers[Math.floor(Math.random() * providers.length)];

    if (provider === 'monetag') {
        if (showMonetagAd()) return 'monetag';
        // Fallback to Adexium
        if (showAdexiumAd()) return 'adexium';
    } else {
        if (showAdexiumAd()) return 'adexium';
        // Fallback to Monetag
        if (showMonetagAd()) return 'monetag';
    }

    return null;
}

async function watchAd() {
    if (adSequenceActive) return;
    if ((currentUser.adsWatched || 0) >= CONFIG.MAX_ADS_PER_BATCH) return showToast('Batch complete — claim reward', 'warning');
    if (getAdsCooldownLeft() > 0) return showToast('Ads on cooldown', 'warning');

    adSequenceActive = true;
    const btn = $('watchAdBtn');
    if (btn) btn.disabled = true;

    try {
        const start = await apiRequest('/ads/start', { method: 'POST', body: { token: adsState.token || null } });
        if (!start.success) {
            showToast(start.error || 'Failed to start ad', 'error');
            return;
        }

        const { ymid, token } = start;

        const provider = tryTriggerAdSDK();
        if (!provider) {
            showToast('No ad available. Try again.', 'error');
            return;
        }

        showToast('🎬 Watching ad...', 'info', 2000);

        const gapMs = (CONFIG.ADS_MIN_GAP_SEC || 15) * 1000;
        await sleep(gapMs);

        const confirm = await apiRequest('/ads/watch', { method: 'POST', body: { ymid, token } });
        if (confirm.success) {
            adsState.token = confirm.token;
            if (currentUser) currentUser.adsWatched = confirm.watched;
            adsState.watched = confirm.watched;
            adsState.accumulated = confirm.watched * (CONFIG.ADS_BATCH_REWARD / CONFIG.MAX_ADS_PER_BATCH);
            vibrate('light');
            renderAds();
            showToast(`+${CONFIG.ADS_BATCH_REWARD / CONFIG.MAX_ADS_PER_BATCH} ${CONFIG.tokenSymbol}`, 'success');
        } else {
            showToast(confirm.error || 'Ad not verified', 'error');
        }
    } catch (e) {
        vibrate('error');
        showToast(e.message || 'Ad failed', 'error');
    } finally {
        adSequenceActive = false;
        if (btn) btn.disabled = false;
        renderAds();
    }
}

async function claimAdsReward() {
    if (isClaimingAds) return;
    if ((currentUser.adsWatched || 0) < CONFIG.MAX_ADS_PER_BATCH) return showToast('Watch all ads first', 'warning');

    isClaimingAds = true;
    try {
        const res = await apiRequest('/ads/claim', { method: 'POST', body: { token: adsState.token } });
        if (res.success) {
            currentUser = res.user;
            adsState.token = null;
            vibrate('success');
            showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
            renderAll();
        } else {
            showToast(res.error || 'Claim failed', 'error');
        }
    } finally {
        isClaimingAds = false;
        renderAds();
    }
}

// ----------------------------------------------------------------------------
// 11. TASKS
// ----------------------------------------------------------------------------
function renderTasks() {
    const c = $('taskList');
    if (!c) return;
    if (!tasks.length) { c.innerHTML = '<div class="empty-state">No tasks available</div>'; return; }

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

        const item = document.querySelector(`[data-task-id="${taskId}"]`);
        if (item) {
            const btn = item.querySelector('.task-btn');
            if (btn) { btn.textContent = 'VERIFY'; btn.dataset.act = 'verify'; }
        }
        return;
    }

    const res = await apiRequest('/tasks/verify', { method: 'POST', body: { taskId } });
    if (res.success) {
        currentUser = res.user;
        vibrate('success');
        showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } else {
        showToast(res.error || 'Verification failed', 'error');
        vibrate('error');
    }
}

// ----------------------------------------------------------------------------
// 12. CHECK-IN
// ----------------------------------------------------------------------------
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
        showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        renderAll();
    } else {
        showToast(res.error || 'Check-in failed', 'error');
    }
}

// ----------------------------------------------------------------------------
// 13. REFERRAL — Mini App direct link
// ----------------------------------------------------------------------------
function renderReferral() {
    if (!currentUser) return;

    const active   = currentUser.activeReferrals || 0;
    const inactive = currentUser.inactiveReferrals || 0;
    const earnings = (typeof currentUser.referralEarnings === 'number')
        ? currentUser.referralEarnings
        : active * CONFIG.REFERRAL_REWARD;

    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('activeReferrals', active);
    set('inactiveReferrals', inactive);
    set('refRewardText', `${CONFIG.REFERRAL_REWARD} ${CONFIG.tokenSymbol}`);
    set('referralEarnings', Math.floor(earnings).toLocaleString());

    const claimed = new Set(currentUser.claimedMilestones || []);
    const total = active;
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

    // Referral link — Mini App direct format
    const linkInput = $('referralLinkInput');
    if (linkInput) {
        const tgUser = tg?.initDataUnsafe?.user;
        const uid =
            (currentUser && currentUser.userId) ? String(currentUser.userId) :
            (tgUser && tgUser.id)              ? String(tgUser.id) :
            (userId)                           ? String(userId) :
            null;

        if (uid) {
            linkInput.value = buildReferralLink(uid);
            if (!userId) userId = uid;
        } else if (!linkInput.value || linkInput.value === 'Loading…') {
            linkInput.value = 'Open inside Telegram to generate link';
        }
    }

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
            <span class="referral-item-name">@${r.username || 'user'}</span>
            <span class="referral-status ${r.active ? 'active' : 'inactive'}">${r.active ? 'ACTIVE' : 'INACTIVE'}</span>
        </div>
    `).join('');
}

async function claimMilestone(count) {
    const res = await apiRequest('/referrals/milestone', { method: 'POST', body: { count: +count } });
    if (res.success) {
        currentUser = res.user;
        vibrate('success');
        showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
        confetti();
        renderAll();
    } else {
        showToast(res.error || 'Claim failed', 'error');
    }
}

async function copyReferral() {
    const uid = currentUser?.userId || userId;
    if (!uid) return showToast('Cannot build link', 'error');
    const link = buildReferralLink(uid);
    const ok = await copyToClipboard(link);
    vibrate(ok ? 'success' : 'error');
    showToast(ok ? 'Link copied!' : 'Copy failed', ok ? 'success' : 'error');
}

function shareReferral() {
    const uid = currentUser?.userId || userId;
    if (!uid) return showToast('Cannot build link', 'error');
    const link = buildReferralLink(uid);
    const text = `🔥 Join Groyper Mine and start mining $${CONFIG.tokenSymbol}!`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    try {
        if (tg?.openTelegramLink) { tg.openTelegramLink(url); return; }
    } catch {}
    window.open(url, '_blank');
}

// ----------------------------------------------------------------------------
// 14. WALLET & WITHDRAW
// ----------------------------------------------------------------------------
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
        const intent = await apiRequest('/withdraw/intent', { method: 'POST', body: { amount } });
        if (!intent.success) throw new Error(intent.error);

        let boc = null;
        if (intent.feeRequired) {
            try {
                boc = await sendTonTransaction(intent.address, intent.amountTon);
            } catch (e) {
                throw new Error('Payment cancelled');
            }
        }

        const confirm = await apiRequest('/withdraw/confirm', {
            method: 'POST',
            body: { requestId: intent.requestId, boc }
        });
        if (!confirm.success) throw new Error(confirm.error);

        currentUser = confirm.user;
        const inp = $('withdrawAmount');
        if (inp) inp.value = '';
        vibrate('success');
        showToast('Withdrawal submitted!', 'success');
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

// ----------------------------------------------------------------------------
// 15. BOOSTS
// ----------------------------------------------------------------------------
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
            boc = await sendTonTransaction(intent.address, intent.amountTon);
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
        showToast(`${boost.name} activated!`, 'success');
        confetti();
        renderAll();
    } catch (e) {
        showToast(e.message || 'Boost failed', 'error');
        vibrate('error');
    }
}

// ----------------------------------------------------------------------------
// 16. EFFECTS
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 17. NAVIGATION
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 18. RENDER ALL
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 19. EVENT BINDING
// ----------------------------------------------------------------------------
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
    on('copyContractBtn', async () => {
        const ok = await copyToClipboard(CONFIG.tokenAddress);
        vibrate(ok ? 'success' : 'error');
        showToast(ok ? 'Contract copied!' : 'Copy failed', ok ? 'success' : 'error');
    });
    on('copyRefLinkBtn', async () => {
        const input = $('referralLinkInput');
        const text = input?.value;
        if (!text || text === 'Loading…' || text.startsWith('Open inside')) {
            return showToast('Link not ready yet', 'warning');
        }
        const ok = await copyToClipboard(text);
        vibrate(ok ? 'success' : 'error');
        showToast(ok ? 'Link copied!' : 'Copy failed', ok ? 'success' : 'error');
    });

    $('withdrawAmount')?.addEventListener('input', validateWithdrawInput);

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

// ----------------------------------------------------------------------------
// 20. BACKGROUND EMBERS (light animation, no DB)
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
// 21. INIT
// ----------------------------------------------------------------------------
function init() {
    console.log('Groyper Mine starting…');

    userId = tg?.initDataUnsafe?.user?.id?.toString() || new URLSearchParams(location.search).get('userId');
    if (!userId) {
        console.error('No userId found');
        showToast('Please open from Telegram', 'error');
        return;
    }

    initTonConnect();
    bindEvents();
    startEmbers();

    boot().then(() => {
        booted = true;
        if (window.tonConnectUI?.wallet && !currentUser) {
            tonConnected = true;
            tonWalletAddress = window.tonConnectUI.wallet.account.address;
        }
    });

    setInterval(() => {
        if (!document.hidden && booted) fetchTokenPrice();
    }, 120000);

    let lastVisible = Date.now();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && booted && Date.now() - lastVisible > 60000) {
            lastVisible = Date.now();
            boot(true);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
