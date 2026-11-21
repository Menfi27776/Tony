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
    MINING_REWARD: 10,
    MINING_COOLDOWN_MS: 3 * 60 * 60 * 1000,
    REWARD_PER_AD: 2,
    MAX_ADS_PER_BATCH: 10,
    ADS_BATCH_REWARD: 20,
    ADS_COOLDOWN_MS: 6 * 60 * 60 * 1000,
    ADS_MIN_GAP_SEC: 20,        // Monetag countdown
    VISIT_AD_SEC: 20,           // Visit link countdown
    AD_COOLDOWN_MS: 30000,      // 30s between completed ads
    VISIT_AD_URL: 'https://uplcm.com/4/12274483', // Monetag Direct Link
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
        bronze: { price: 3,  multiplier: 3,  name: 'SPARK',   icon: '🥉' },
        silver: { price: 6,  multiplier: 8,  name: 'BLAZE',   icon: '🥈' },
        gold:   { price: 15, multiplier: 20, name: 'INFERNO', icon: '🥇' }
    },
    BOOST_DAYS: 7
};

// ✅ v3.6: Canonical token address — the ONLY value ever displayed.
// (Server may send pool/pair addresses in `config.tokenAddress`; we ignore them.)
const CANONICAL_TOKEN_ADDRESS = 'EQAtwo6qMNwtr0iTA9eKVZ32cuACFJ0VKd78GrBWOe83-X1P';

// Canonical boost multipliers — must match server DEFAULTS
const VALID_BOOST_MULTS = [1, 3, 8, 20];
const CANONICAL_BOOSTS = {
    bronze: { multiplier: 3,  name: 'SPARK',   icon: '🥉' },
    silver: { multiplier: 8,  name: 'BLAZE',   icon: '🥈' },
    gold:   { multiplier: 20, name: 'INFERNO', icon: '🥇' }
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
let adWatchedLocal = 0;
let visitAttempt = 1; // 1 = first press (fails), 2 = second press (rewards)
let lastAdTime = 0;
let booted = false;
let serverOffset = 0;
let lastPriceFetch = 0;
let activeVideoTaskId = null; // ✅ v3.5: track currently open video code task

const now = () => Date.now() + serverOffset;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// 3. UTILITIES
// ----------------------------------------------------------------------------
function showToast(msg, type = 'info', dur = 6000) {
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

// Build correct referral link (opens Mini App directly)
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
        // ✅ تعديل 1: وضع twaReturnUrl داخل actionsConfiguration (المكان الصحيح)
        window.tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
            manifestUrl: location.origin + '/tonconnect-manifest.json',
            buttonRootId: 'ton-connect-btn',
            language: 'en',
            actionsConfiguration: {
                twaReturnUrl: `https://t.me/${CONFIG.botUsername}/${CONFIG.botShortName}`
            }
        });

        window.tonConnectUI.onStatusChange(async (wallet) => {
            if (!wallet) {
                tonConnected = false;
                tonWalletAddress = null;
                updateWalletConnectBtn();
                return;
            }
            let friendly = wallet.account.address;
            try {
                friendly = window.TON_CONNECT_UI.toUserFriendlyAddress(wallet.account.address, false);
            } catch {}

            tonConnected = true;
            tonWalletAddress = friendly;
            updateWalletConnectBtn();
            hideWalletError();

            // إغلاق النافذة المنبثقة فوراً بعد نجاح الربط
            try {
                window.tonConnectUI.closeModal();
                console.log('✅ TON Connect modal closed after successful connection');
            } catch (e) {
                console.warn('closeModal failed:', e);
            }

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

// Real-time wallet readiness check (source of truth = tonConnectUI)
function isWalletReady() {
    return !!(window.tonConnectUI && window.tonConnectUI.connected && window.tonConnectUI.wallet);
}

// Update the smart wallet button in Withdraw card
function updateWalletConnectBtn() {
    const btn = $('walletConnectBtn');
    const label = $('walletConnectLabel');
    if (!btn || !label) return;

    const connected = isWalletReady();
    btn.classList.toggle('connected', connected);

    if (connected) {
        label.textContent = 'Disconnect';
        btn.innerHTML = '<i class="fas fa-unlink" aria-hidden="true"></i><span id="walletConnectLabel">Disconnect</span>';
    } else {
        label.textContent = 'Connect';
        btn.innerHTML = '<i class="fas fa-link" aria-hidden="true"></i><span id="walletConnectLabel">Connect</span>';
    }

    const addrEl = $('withdrawWalletAddress');
    if (addrEl) {
        addrEl.textContent = tonWalletAddress
            ? `${tonWalletAddress.slice(0, 6)}…${tonWalletAddress.slice(-6)}`
            : 'Not connected';
    }
}

function showWalletError(msg) {
    const box = $('walletErrorBox');
    const txt = $('walletErrorText');
    if (!box || !txt) return;
    txt.textContent = msg;
    box.style.display = 'flex';
}

function hideWalletError() {
    const box = $('walletErrorBox');
    if (box) box.style.display = 'none';
}

// ✅ تعديل 2: استخدام openModal() بدلاً من connectWallet() لإزالة رسالة الخطأ
async function onWalletConnectBtnClick() {
    if (!window.tonConnectUI) return;
    try {
        if (isWalletReady()) {
            await window.tonConnectUI.disconnect();
            vibrate('light');
        } else {
            // فتح المودال (الطريقة الموصى بها) بدلاً من connectWallet() المهجورة
            await window.tonConnectUI.openModal();
            vibrate('medium');
        }
    } catch (e) {
        console.warn('Wallet connect toggle failed:', e);
        showToast('Wallet action failed', 'error');
    }
    updateWalletConnectBtn();
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

// Classify TON Connect errors
// 300 = user rejected, 100 = unknown app (session lost), other = generic
function classifyTonError(e) {
    const code = e?.code ?? e?.errorCode ?? null;
    const msg = String(e?.message || '');
    if (code === 300 || /reject/i.test(msg) || /cancel/i.test(msg)) return { type: 'rejected', msg: 'Payment cancelled' };
    if (code === 100 || /unknown app/i.test(msg) || /session/i.test(msg)) {
        return {
            type: 'session',
            msg: 'Wallet could not verify the transaction. Please reconnect your wallet to complete the payment.'
        };
    }
    return { type: 'generic', msg: msg || 'Transaction failed' };
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

    // ✅ v3.6: Lock the canonical token address.
    // The server may send a pool/pair address; we ALWAYS display the Jetton Master.
    CONFIG.tokenAddress = CANONICAL_TOKEN_ADDRESS;

    serverOffset = (res.serverTime || Date.now()) - Date.now();
    tasks = res.tasks || [];

    // ✅ v3.4: Re-apply canonical boosts after server config merge
    // (server already sends canonical values, but this guards against any mismatch)
    CONFIG.BOOSTS = {
        bronze: { price: 3,  multiplier: 3,  name: 'SPARK',   icon: '🥉' },
        silver: { price: 6,  multiplier: 8,  name: 'BLAZE',   icon: '🥈' },
        gold:   { price: 15, multiplier: 20, name: 'INFERNO', icon: '🥇' }
    };

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
        // DB wallet is just a record; do NOT treat as live connection
        // Live connection is derived from tonConnectUI only.
        tonConnected = isWalletReady();
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

    // Load ad progress from localStorage
    loadAdsState();

    renderAll();

    if (miningTimer) clearInterval(miningTimer);
    miningTimer = setInterval(() => {
        if (document.hidden) return;
        renderMining();
        renderAds();
    }, 1000);

    fetchTokenPrice();
}

// Re-render on visibility return
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && booted) {
        renderMining();
        renderAds();
        renderToken();
        updateHeaderWallet();
        updateWalletConnectBtn();
        renderBoostStatusPill();
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

    // Contract address — ALWAYS use the canonical Jetton Master (EQAtwo…)
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

// ✅ v3.4: Strict whitelist — only canonical multipliers accepted
function getActiveMultiplier() {
    if (!currentUser) return 1;
    const exp = Number(currentUser.boostExpiresAt) || 0;
    if (!exp || exp < now()) return 1;
    const m = Number(currentUser.boostMultiplier) || 1;
    return VALID_BOOST_MULTS.includes(m) ? m : 1;
}

// NEW — returns 'bronze'|'silver'|'gold'|null (active boost tier)
// ✅ v3.4: Strict check — boostMultiplier MUST match canonical tier value
function getActiveBoostType() {
    if (!currentUser) return null;
    const exp = Number(currentUser.boostExpiresAt) || 0;
    if (!exp || exp <= now()) return null;
    const type = currentUser.boostType || null;
    if (!type || !CANONICAL_BOOSTS[type]) return null;
    const expectedMult = CANONICAL_BOOSTS[type].multiplier;
    if (Number(currentUser.boostMultiplier) !== expectedMult) return null;
    return type;
}

// NEW — update boost status pill (called from renderAll only)
// ✅ v3.4: Always shows — FREE 1x when no active boost, tier when active
function renderBoostStatusPill() {
    const pill = $('boostStatusPill');
    if (!pill) return;

    const iconEl = $('boostStatusIcon');
    const nameEl = $('boostStatusName');
    const multEl = $('boostStatusMult');

    // Determine active tier
    const activeTier = getActiveBoostType();

    if (activeTier) {
        // Active boost — show tier
        const cfgBoost = CANONICAL_BOOSTS[activeTier];
        if (iconEl) iconEl.textContent = cfgBoost.icon || '⚡';
        if (nameEl) nameEl.textContent = cfgBoost.name;
        if (multEl) multEl.textContent = `${cfgBoost.multiplier}x`;
        pill.dataset.tier = activeTier;
    } else {
        // No active boost — show FREE 1x
        if (iconEl) iconEl.textContent = '⚡';
        if (nameEl) nameEl.textContent = 'FREE';
        if (multEl) multEl.textContent = '1x';
        pill.dataset.tier = 'free';
    }

    pill.classList.remove('hidden');
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
        btn.classList.toggle('mining-progress', !d.canClaim && !isClaimingMining);
        btn.classList.toggle('mining-ready', d.canClaim && !isClaimingMining);
        btn.style.setProperty('--progress', `${(d.progress * 100).toFixed(1)}%`);

        const label = $('claimLabel');
        if (label) {
            label.textContent = d.canClaim
                ? `CLAIM ${Math.floor(d.reward).toLocaleString()} ${CONFIG.tokenSymbol}`
                : 'MINING IN PROGRESS';
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

    // 30s cooldown between ads
    if (lastAdTime > 0 && now() - lastAdTime < CONFIG.AD_COOLDOWN_MS) {
        const remaining = Math.ceil((CONFIG.AD_COOLDOWN_MS - (now() - lastAdTime)) / 1000);
        return showToast(`Please wait ${remaining}s before next ad`, 'warning');
    }

    isClaimingMining = true;
    const btn = $('claimMiningBtn');
    const originalBtn = btn?.innerHTML;

    // Monetag only — no visit link in mining claim.
    // If Monetag unavailable, proceed with claim after countdown.
    const provider = showMonetagAd() ? 'monetag' : null;

    // 2. 18s countdown on button (visible — no freeze)
    let remaining = (CONFIG.ADS_MIN_GAP_SEC || 18);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-eye"></i> Watching (${remaining}s)`;
    }
    if (provider) {
        showToast(`🎬 Watching ad... (${remaining}s)`, 'info', 2000);
    } else {
        showToast(`⏳ Preparing claim... (${remaining}s)`, 'info', 2000);
    }

    const interval = setInterval(() => {
        remaining--;
        if (remaining > 0 && btn) {
            btn.innerHTML = `<i class="fas fa-eye"></i> Watching (${remaining}s)`;
        }
    }, 1000);

    try {
        // 3. Wait exactly 18s
        await sleep((CONFIG.ADS_MIN_GAP_SEC || 18) * 1000);
        clearInterval(interval);

        // 4. Claim on server AFTER 18s
        if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Claiming...';
        const res = await apiRequest('/mining/claim', { method: 'POST' });
        if (!res.success) throw new Error(res.error || 'Claim failed');

        // ✅ Success — record ad time (30s cooldown)
        lastAdTime = now();

        currentUser = res.user;
        vibrate('success');
        showToast(`+${Math.floor(res.reward).toLocaleString()} ${CONFIG.tokenSymbol}`, 'success');
        confetti();
        renderAll();
    } catch (e) {
        clearInterval(interval);
        vibrate('error');
        showToast(e.message || 'Claim failed', 'error');
    } finally {
        isClaimingMining = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtn || '<i class="fas fa-fire"></i> CLAIM MINING';
        }
        renderMining();
    }
}

// ----------------------------------------------------------------------------
// 10. ADS — Monetag + Visit Link alternating (10 per batch)
//     Visit Link is a double-press: 1st = fail, 2nd = reward
// ----------------------------------------------------------------------------
function loadAdsState() {
    try {
        const saved = localStorage.getItem('adWatchedLocal');
        adWatchedLocal = parseInt(saved || '0', 10) || 0;
        adWatchedLocal = Math.min(adWatchedLocal, CONFIG.MAX_ADS_PER_BATCH);

        const savedAttempt = localStorage.getItem('visitAttempt');
        visitAttempt = parseInt(savedAttempt || '1', 10) || 1;
        if (visitAttempt !== 2) visitAttempt = 1;

        console.log(`📂 Loaded ad progress: ${adWatchedLocal}/${CONFIG.MAX_ADS_PER_BATCH} · visitAttempt=${visitAttempt}`);
    } catch {
        adWatchedLocal = 0;
        visitAttempt = 1;
    }
}

function saveAdsState() {
    try {
        localStorage.setItem('adWatchedLocal', String(adWatchedLocal));
        localStorage.setItem('visitAttempt', String(visitAttempt));
        console.log(`💾 Saved ad progress: ${adWatchedLocal}/${CONFIG.MAX_ADS_PER_BATCH} · visitAttempt=${visitAttempt}`);
    } catch {}
}

function resetAdsState() {
    adWatchedLocal = 0;
    visitAttempt = 1;
    localStorage.removeItem('adWatchedLocal');
    localStorage.removeItem('visitAttempt');
    console.log('🔄 Ad progress reset');
}

function getAdsCooldownLeft() {
    return Math.max(0, (currentUser?.adsCooldownUntil || 0) - now());
}

// Which ad type is next? Alternates: even → Monetag, odd → Visit
function getNextAdType() {
    return (adWatchedLocal % 2 === 0) ? 'monetag' : 'visit';
}

function renderAds() {
    if (!currentUser) return;

    const watched = Math.min(adWatchedLocal, CONFIG.MAX_ADS_PER_BATCH);
    const perBatch = CONFIG.MAX_ADS_PER_BATCH;
    const perAd = CONFIG.ADS_BATCH_REWARD / perBatch;

    // Segments
    const seg = $('adsSegments');
    if (seg) {
        if (seg.children.length !== perBatch) {
            seg.innerHTML = '<div class="ads-segment"></div>'.repeat(perBatch);
        }
        [...seg.children].forEach((c, i) => c.classList.toggle('active', i < watched));
    }

    // Counter
    const acc = $('adsAccumulated');
    const counter = $('adsCounter');
    if (acc) acc.textContent = `${Math.floor(watched * perAd)} ${CONFIG.tokenSymbol}`;
    if (counter) counter.textContent = `${watched}/${perBatch}`;

    // Buttons
    const complete = watched >= perBatch;
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

    // Labels — always generic "WATCH AD", never expose provider
    const watchLabel = $('watchAdLabel');
    if (watchLabel) watchLabel.textContent = `WATCH AD (+${perAd} ${CONFIG.tokenSymbol})`;
    const claimLabel = $('claimAdsLabel');
    if (claimLabel) claimLabel.textContent = `CLAIM ${CONFIG.ADS_BATCH_REWARD} ${CONFIG.tokenSymbol}`;
}

// Monetag — instant call, return false if unavailable
function showMonetagAd() {
    if (typeof window.show_12265394 !== 'function') {
        console.warn('❌ Monetag not available');
        return false;
    }
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
        console.log('📺 Monetag called');
        return true;
    } catch (e) {
        console.warn('Monetag failed:', e);
        return false;
    }
}

// Visit link — opens in Telegram browser or new tab
function openVisitAd() {
    try {
        if (tg && typeof tg.openLink === 'function') {
            tg.openLink(CONFIG.VISIT_AD_URL, { try_instant_view: false });
        } else {
            window.open(CONFIG.VISIT_AD_URL, '_blank');
        }
        console.log('📺 Visit ad opened:', CONFIG.VISIT_AD_URL);
        return true;
    } catch (e) {
        console.warn('Visit ad failed:', e);
        try {
            window.open(CONFIG.VISIT_AD_URL, '_blank');
            return true;
        } catch {
            return false;
        }
    }
}

// Provider entrypoint — used ONLY by watchAd() in Earn page.
// claimMining uses Monetag only (see claimMining).
function tryTriggerAdSDK() {
    const type = getNextAdType();
    if (type === 'visit') {
        if (openVisitAd()) return 'visit';
        // Fallback to Monetag if visit can't open
        if (showMonetagAd()) return 'monetag';
        return null;
    }
    if (showMonetagAd()) return 'monetag';
    // Fallback to Visit if Monetag unavailable
    if (openVisitAd()) return 'visit';
    return null;
}

async function watchAd() {
    if (adSequenceActive) return;
    if (adWatchedLocal >= CONFIG.MAX_ADS_PER_BATCH) return showToast('Batch complete — claim reward', 'warning');
    if (getAdsCooldownLeft() > 0) return showToast('Ads on cooldown', 'warning');

    // 30s cooldown between COMPLETED ads only
    if (lastAdTime > 0 && now() - lastAdTime < CONFIG.AD_COOLDOWN_MS) {
        const remaining = Math.ceil((CONFIG.AD_COOLDOWN_MS - (now() - lastAdTime)) / 1000);
        return showToast(`Please wait ${remaining}s before next ad`, 'warning');
    }

    const adType = getNextAdType();
    const isVisit = adType === 'visit';

    adSequenceActive = true;
    const btn = $('watchAdBtn');
    const originalBtn = btn?.innerHTML;

    // 1. Trigger the ad provider
    let provider = null;
    if (isVisit) {
        provider = openVisitAd() ? 'visit' : null;
        if (!provider && showMonetagAd()) provider = 'monetag';
    } else {
        provider = showMonetagAd() ? 'monetag' : null;
        if (!provider && openVisitAd()) provider = 'visit';
    }

    if (!provider) {
        showToast('No ad available. Try again.', 'error');
        adSequenceActive = false;
        return;
    }

    // 2. Countdown (visible — no freeze)
    const waitSeconds = (provider === 'visit')
        ? (CONFIG.VISIT_AD_SEC || 15)
        : (CONFIG.ADS_MIN_GAP_SEC || 18);

    let remaining = waitSeconds;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-eye"></i> Watching (${remaining}s)`;
    }
    showToast(`🎬 ${provider === 'visit' ? 'Opening link...' : 'Watching ad...'} (${waitSeconds}s)`, 'info', 2000);

    const interval = setInterval(() => {
        remaining--;
        if (remaining > 0 && btn) {
            btn.innerHTML = `<i class="fas fa-eye"></i> Watching (${remaining}s)`;
        }
    }, 1000);

    try {
        // 3. Wait full duration
        await sleep(waitSeconds * 1000);
        clearInterval(interval);

        // 4. Resolve outcome
        if (provider === 'visit') {
            if (visitAttempt === 1) {
                // ❌ First press — forced verification failure, no cooldown
                visitAttempt = 2;
                saveAdsState();
                vibrate('error');
                showToast('❌ Verification failed. Try again', 'error', 3200);
            } else {
                // ✅ Second press — reward + cooldown
                visitAttempt = 1;
                lastAdTime = now();
                adWatchedLocal = Math.min(adWatchedLocal + 1, CONFIG.MAX_ADS_PER_BATCH);
                saveAdsState();
                vibrate('success');
                renderAds();
                showToast(`+${CONFIG.ADS_BATCH_REWARD / CONFIG.MAX_ADS_PER_BATCH} ${CONFIG.tokenSymbol}`, 'success');
            }
        } else {
            // Monetag — normal success
            visitAttempt = 1;
            lastAdTime = now();
            adWatchedLocal = Math.min(adWatchedLocal + 1, CONFIG.MAX_ADS_PER_BATCH);
            saveAdsState();
            vibrate('success');
            renderAds();
            showToast(`+${CONFIG.ADS_BATCH_REWARD / CONFIG.MAX_ADS_PER_BATCH} ${CONFIG.tokenSymbol}`, 'success');
        }
    } catch (e) {
        clearInterval(interval);
        vibrate('error');
        showToast(e.message || 'Ad failed', 'error');
    } finally {
        adSequenceActive = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtn || '<i class="fas fa-play"></i> WATCH AD';
        }
        renderAds();
    }
}

async function claimAdsReward() {
    if (isClaimingAds) return;
    if (adWatchedLocal < CONFIG.MAX_ADS_PER_BATCH) return showToast('Watch all ads first', 'warning');
    if (getAdsCooldownLeft() > 0) return showToast('Ads on cooldown', 'warning');

    isClaimingAds = true;
    const btn = $('claimAdsBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Claiming...';
    }

    try {
        const res = await apiRequest('/ads/claim', {
            method: 'POST',
            body: { watchedCount: adWatchedLocal }
        });

        if (res.success) {
            currentUser = res.user;
            resetAdsState();
            vibrate('success');
            showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
            renderAll();
        } else {
            showToast(res.error || 'Claim failed', 'error');
            vibrate('error');
        }
    } catch (e) {
        showToast(e.message || 'Claim failed', 'error');
    } finally {
        isClaimingAds = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check"></i> CLAIM';
        }
        renderAds();
    }
}

// ----------------------------------------------------------------------------
// 11. TASKS — Strict chat verification
// ----------------------------------------------------------------------------
function renderTasks() {
    const c = $('taskList');
    if (!c) return;
    if (!tasks.length) { c.innerHTML = '<div class="empty-state">No tasks available</div>'; return; }

    const done = new Set(currentUser?.completedTasks || []);
    c.innerHTML = tasks.map(t => {
        const d = done.has(t.id);
        const isVideo = t.type === 'video_code';
        // ✅ v3.5: Video code tasks show WATCH button and open modal
        const btnLabel = d ? '✓ DONE' : (isVideo ? 'WATCH' : 'START');
        const btnAct = d ? 'done' : (isVideo ? 'video' : 'start');
        return `<div class="task-item ${d ? 'done' : ''}" data-task-id="${t.id}">
            <div class="task-icon"><i class="${t.iconClass || (isVideo ? 'fas fa-video' : 'fas fa-link')}"></i></div>
            <div class="task-info">
                <div class="task-name">${t.name}</div>
                <div class="task-reward">+${t.reward} ${CONFIG.tokenSymbol}</div>
            </div>
            <button class="task-btn ${d ? 'completed' : ''}" data-act="${btnAct}" ${d ? 'disabled' : ''}>
                ${btnLabel}
            </button>
        </div>`;
    }).join('');
}

async function taskAction(taskId, action) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // ✅ v3.5: Video code task — open modal instead of opening link directly
    if (action === 'video') {
        openVideoCodeModal(task);
        return;
    }

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

    // Verify — server enforces membership for verify='chat'
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
// 11b. VIDEO CODE TASK — Modal + code submission  ✅ v3.5
// ----------------------------------------------------------------------------
function openVideoCodeModal(task) {
    if (!task) return;

    const modal = $('videoCodeModal');
    const content = $('videoCodeDetails');
    if (!modal || !content) {
        // Fallback: open video directly if modal missing
        if (task.url) {
            if (tg?.openLink) tg.openLink(task.url);
            else window.open(task.url, '_blank');
        }
        return;
    }

    activeVideoTaskId = task.id;

    content.innerHTML = `
        <div class="video-code-header">
            <div class="video-code-icon"><i class="fas fa-video" aria-hidden="true"></i></div>
            <div class="video-code-title">
                <h2>${task.name}</h2>
                <span class="video-code-reward">+${task.reward} ${CONFIG.tokenSymbol}</span>
            </div>
        </div>
        <p class="video-code-instructions">
            Watch the video, collect the code shown inside it, then enter it below to claim your reward.
        </p>
        <button type="button" id="watchVideoBtn" class="btn-secondary video-code-watch-btn">
            <i class="fas fa-play" aria-hidden="true"></i>
            <span>Watch Video</span>
        </button>
        <div class="video-code-input-group">
            <input
                type="text"
                id="videoCodeInput"
                class="video-code-input"
                placeholder="Enter code"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false">
        </div>
        <div id="videoCodeError" class="video-code-error" style="display:none;"></div>
        <button type="button" id="submitVideoCodeBtn" class="btn-primary video-code-submit-btn">
            <i class="fas fa-check" aria-hidden="true"></i>
            <span>SUBMIT CODE</span>
        </button>
    `;

    // Bind watch video button
    const watchBtn = $('watchVideoBtn');
    if (watchBtn) {
        watchBtn.onclick = () => {
            if (!task.url) return showToast('Video link missing', 'error');
            try {
                if (tg?.openLink) tg.openLink(task.url, { try_instant_view: false });
                else window.open(task.url, '_blank');
                vibrate('light');
            } catch {
                window.open(task.url, '_blank');
            }
        };
    }

    // Bind submit button
    const submitBtn = $('submitVideoCodeBtn');
    if (submitBtn) {
        submitBtn.onclick = () => submitVideoCode(task.id);
    }

    // Enter key submits
    const input = $('videoCodeInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitVideoCode(task.id); }
        });
        setTimeout(() => { try { input.focus(); } catch {} }, 200);
    }

    modal.classList.remove('hidden');
    vibrate('medium');
}

function closeVideoCodeModal() {
    const modal = $('videoCodeModal');
    if (modal) modal.classList.add('hidden');
    activeVideoTaskId = null;
    const input = $('videoCodeInput');
    if (input) input.value = '';
    const err = $('videoCodeError');
    if (err) { err.style.display = 'none'; err.textContent = ''; }
}

async function submitVideoCode(taskId) {
    if (!taskId) return;
    const input = $('videoCodeInput');
    const errEl = $('videoCodeError');
    const submitBtn = $('submitVideoCodeBtn');

    const code = (input?.value || '').trim();
    if (!code) {
        if (errEl) { errEl.textContent = 'Please enter the code'; errEl.style.display = 'block'; }
        vibrate('error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>VERIFYING...</span>';
    }
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    try {
        const res = await apiRequest('/tasks/verify-code', {
            method: 'POST',
            body: { taskId, code }
        });

        if (res.success) {
            currentUser = res.user;
            vibrate('success');
            showToast(`+${res.reward} ${CONFIG.tokenSymbol}`, 'success');
            confetti();
            closeVideoCodeModal();
            renderAll();
        } else {
            if (errEl) {
                errEl.textContent = res.error || 'Invalid code. Please check and try again.';
                errEl.style.display = 'block';
            }
            vibrate('error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> <span>SUBMIT CODE</span>';
            }
        }
    } catch (e) {
        if (errEl) {
            errEl.textContent = e.message || 'Verification failed';
            errEl.style.display = 'block';
        }
        vibrate('error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> <span>SUBMIT CODE</span>';
        }
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
    set('minWithdrawHint', `Minimum: ${CONFIG.MIN_WITHDRAW.toLocaleString()} ${CONFIG.tokenSymbol}`);

    // Smart wallet button + address display
    updateWalletConnectBtn();
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

    // Pre-flight: verify live wallet session before touching payment
    if (!isWalletReady()) {
        showWalletError('Wallet is not connected. Please connect or reconnect your wallet to continue.');
        return showToast('Connect wallet first', 'warning');
    }
    hideWalletError();

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
                const c = classifyTonError(e);
                if (c.type === 'session') {
                    showWalletError(c.msg);
                    showToast(c.msg, 'error', 5000);
                    updateWalletConnectBtn();
                    throw new Error(c.msg);
                }
                throw new Error(c.msg);
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
// 15. BOOSTS — 3x/8x/20x with details
// ----------------------------------------------------------------------------
function getBoostDetails(type) {
    const boost = CONFIG.BOOSTS[type];
    if (!boost) return null;

    const baseReward = CONFIG.MINING_REWARD;
    const claimsPerDay = Math.floor(24 / 3);
    const days = CONFIG.BOOST_DAYS || 7;

    // ✅ v3.4: use canonical multiplier (with fallback)
    const mult = boost.multiplier || boost.mult || 1;

    const perClaim = baseReward * mult;
    const daily = perClaim * claimsPerDay;
    const totalEarned = daily * days;
    const baseEarned = baseReward * claimsPerDay * days;
    const extra = totalEarned - baseEarned;
    const roiPercent = ((mult - 1) * 100).toFixed(0);

    const price = livePriceData.price || 0;
    const totalUsd = totalEarned * price;
    const extraUsd = extra * price;

    return {
        type, ...boost, multiplier: mult,
        perClaim, daily, totalEarned, baseEarned, extra,
        roiPercent, totalUsd, extraUsd,
        claimsPerDay, days
    };
}

function showBoostDetails(type) {
    const d = getBoostDetails(type);
    if (!d) return;

    const modal = $('boostModal');
    const content = $('boostDetails');
    if (!modal || !content) {
        // Fallback: direct confirm
        buyBoostDirect(type);
        return;
    }

    const fmtUsd = (v) => '$' + v.toFixed(2);

    content.innerHTML = `
        <div class="boost-modal-header">
            <div class="boost-modal-icon">${d.icon}</div>
            <div class="boost-modal-title">
                <h2>${d.name}</h2>
                <span class="boost-modal-tier">${d.multiplier}x Hash Power</span>
            </div>
        </div>
        <div class="boost-modal-stats">
            <div class="boost-stat">
                <div class="boost-stat-label">PER CLAIM</div>
                <div class="boost-stat-value">${d.perClaim.toLocaleString()} GROYP</div>
                <div class="boost-stat-note">+${(d.perClaim - CONFIG.MINING_REWARD).toLocaleString()} vs base</div>
            </div>
            <div class="boost-stat">
                <div class="boost-stat-label">DAILY (${d.claimsPerDay}×)</div>
                <div class="boost-stat-value">${d.daily.toLocaleString()} GROYP</div>
                <div class="boost-stat-note">≈ ${fmtUsd(d.daily * (livePriceData.price || 0))}</div>
            </div>
            <div class="boost-stat highlight">
                <div class="boost-stat-label">${d.days} DAYS</div>
                <div class="boost-stat-value">${d.totalEarned.toLocaleString()} GROYP</div>
                <div class="boost-stat-note">≈ ${fmtUsd(d.totalUsd)}</div>
            </div>
        </div>
        <div class="boost-modal-comparison">
            <div class="boost-compare-row">
                <span>Without boost (${d.days}d):</span>
                <strong>${d.baseEarned.toLocaleString()} GROYP</strong>
            </div>
            <div class="boost-compare-row highlight">
                <span>With ${d.name} (${d.days}d):</span>
                <strong>${d.totalEarned.toLocaleString()} GROYP</strong>
            </div>
            <div class="boost-compare-row success">
                <span>Extra earnings:</span>
                <strong>+${d.extra.toLocaleString()} GROYP (+${d.roiPercent}%)</strong>
            </div>
            <div class="boost-compare-row success">
                <span>Extra value (USD):</span>
                <strong>≈ ${fmtUsd(d.extraUsd)}</strong>
            </div>
        </div>
        <div class="boost-modal-price-box">
            <div class="boost-modal-price-label">ACTIVATION PRICE</div>
            <div class="boost-modal-price-value">${d.price} TON</div>
        </div>
        <div class="boost-modal-actions">
            <button class="btn-secondary" onclick="closeBoostModal()">
                <i class="fas fa-times"></i> Cancel
            </button>
            <button class="btn-gold" onclick="confirmBuyBoost('${type}')">
                <i class="fas fa-bolt"></i> Activate ${d.name}
            </button>
        </div>
    `;

    modal.classList.remove('hidden');
    vibrate('medium');
}

function closeBoostModal() {
    const modal = $('boostModal');
    if (modal) modal.classList.add('hidden');
}

async function confirmBuyBoost(type) {
    closeBoostModal();
    await buyBoostDirect(type);
}

async function buyBoostDirect(type) {
    if (!isWalletReady()) {
        showToast('Connect wallet first', 'warning');
        return;
    }
    const boost = CONFIG.BOOSTS[type];
    if (!boost) return;

    const mult = boost.multiplier || boost.mult || 1;

    const ok = tg?.showConfirm
        ? await new Promise(r => tg.showConfirm(`Activate ${boost.name} (${mult}x) for ${boost.price} TON?`, r))
        : confirm(`Activate ${boost.name} for ${boost.price} TON?`);
    if (!ok) return;

    try {
        const intent = await apiRequest('/boost/intent', { method: 'POST', body: { type } });
        if (!intent.success) throw new Error(intent.error);

        let boc;
        try {
            boc = await sendTonTransaction(intent.address, intent.amountTon);
        } catch (e) {
            const c = classifyTonError(e);
            if (c.type === 'session') {
                // Try to route user to the wallet page to reconnect
                showToast(c.msg, 'error', 5000);
                updateWalletConnectBtn();
                throw new Error(c.msg);
            }
            throw new Error(c.msg);
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

async function buyBoost(type) {
    showBoostDetails(type);
}

// Render boost cards dynamically
function renderBoosts() {
    const container = document.querySelector('.boost-scroll');
    if (!container) return;

    const baseReward = CONFIG.MINING_REWARD;
    const claimsPerDay = Math.floor(24 / 3);
    const days = CONFIG.BOOST_DAYS || 7;

    const cards = Object.entries(CONFIG.BOOSTS).map(([type, b]) => {
        // ✅ v3.4: canonical multiplier (with fallback)
        const mult = b.multiplier || b.mult || 1;
        const perClaim = baseReward * mult;
        const daily = perClaim * claimsPerDay;
        const totalEarned = daily * days;

        const tierClass = type === 'silver' ? 'tier-silver' : type === 'gold' ? 'tier-gold' : '';
        const bestBadge = type === 'gold' ? '<div class="best-badge">BEST</div>' : '';
        const roiPercent = ((mult - 1) * 100).toFixed(0);

        return `
            <div class="boost-card ${tierClass}" data-boost="${type}">
                ${bestBadge}
                <div class="boost-icon">${b.icon}</div>
                <div class="boost-name">${b.name}</div>
                <div class="boost-mult">${mult}x</div>
                <div class="boost-mult-label">HASH POWER</div>
                <div class="boost-price">${b.price} TON</div>
                <div class="boost-duration">⏱️ ${days} days</div>
                <div class="boost-earnings">
                    <div class="boost-earn-row">
                        <span>Per claim</span>
                        <strong>${perClaim.toLocaleString()} GROYP</strong>
                    </div>
                    <div class="boost-earn-row">
                        <span>Daily (${claimsPerDay}×)</span>
                        <strong>${daily.toLocaleString()} GROYP</strong>
                    </div>
                    <div class="boost-earn-row">
                        <span>${days} days</span>
                        <strong>${totalEarned.toLocaleString()} GROYP</strong>
                    </div>
                </div>
                <div class="boost-roi">+${roiPercent}%</div>
            </div>
        `;
    });

    container.innerHTML = cards.join('');
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

    // ✅ v3.8: Fake withdraw feed ONLY on Wallet page
    if (name === 'wallet') {
        startFakeWithdrawFeed();
    } else {
        stopFakeWithdrawFeed();
    }
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
    renderBoosts();
    renderBoostStatusPill();
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
    on('walletConnectBtn', onWalletConnectBtnClick);
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

    // Boost shortcut — scroll to plans
    on('boostShortcutBtn', () => {
        const boostScroll = document.querySelector('.boost-scroll');
        if (!boostScroll) return;

        boostScroll.scrollIntoView({ behavior: 'smooth', block: 'center' });
        vibrate('medium');

        setTimeout(() => {
            document.querySelectorAll('.boost-card').forEach(card => {
                card.classList.add('highlight-pulse');
                setTimeout(() => card.classList.remove('highlight-pulse'), 4500);
            });
        }, 400);

        showToast('💎 Boost your mining power!', 'info', 2500);
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

        // Close boost modal on overlay click
        if (e.target.id === 'boostModal') {
            closeBoostModal();
        }

        // ✅ v3.5: Close video code modal on overlay click
        if (e.target.id === 'videoCodeModal') {
            closeVideoCodeModal();
        }
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

// ============================================================================
// ✅ v3.9 — FAKE WITHDRAW FEED (Live Social Proof) — Enhanced
// 200 fake withdrawal notifications shown ONLY on Wallet page.
// Each toast: title + user ID + amount + time · every 20s (8s visible + 12s gap)
// ============================================================================

const FAKE_WITHDRAW_DATA = [
    { id: '033****1791', amount: 4610 },
    { id: '518****4928', amount: 5700 },
    { id: '829****9451', amount: 10000 },
    { id: '258****7356', amount: 2680 },
    { id: '207****6378', amount: 2000 },
    { id: '941****2083', amount: 8920 },
    { id: '072****6159', amount: 2000 },
    { id: '684****3921', amount: 7460 },
    { id: '315****8472', amount: 10000 },
    { id: '826****1049', amount: 2000 },
    { id: '193****7250', amount: 9630 },
    { id: '570****3168', amount: 4120 },
    { id: '462****9815', amount: 2000 },
    { id: '018****5427', amount: 6840 },
    { id: '753****2094', amount: 3570 },
    { id: '296****8310', amount: 2000 },
    { id: '804****1762', amount: 8210 },
    { id: '135****6948', amount: 2750 },
    { id: '628****0531', amount: 2000 },
    { id: '479****8256', amount: 9340 },
    { id: '902****3175', amount: 6180 },
    { id: '251****7609', amount: 2000 },
    { id: '716****4382', amount: 4830 },
    { id: '084****2917', amount: 7520 },
    { id: '563****9081', amount: 2000 },
    { id: '347****1628', amount: 3960 },
    { id: '895****7340', amount: 10000 },
    { id: '120****5863', amount: 2000 },
    { id: '638****4107', amount: 5470 },
    { id: '271****9538', amount: 7280 },
    { id: '509****2841', amount: 2000 },
    { id: '963****7152', amount: 3190 },
    { id: '416****0385', amount: 8750 },
    { id: '082****6491', amount: 2000 },
    { id: '735****1826', amount: 6640 },
    { id: '194****5073', amount: 2410 },
    { id: '857****3962', amount: 2000 },
    { id: '320****8415', amount: 9160 },
    { id: '641****2759', amount: 4380 },
    { id: '098****6134', amount: 2000 },
    { id: '572****9408', amount: 7930 },
    { id: '813****2671', amount: 5840 },
    { id: '245****7913', amount: 2000 },
    { id: '690****4285', amount: 3520 },
    { id: '137****8052', amount: 9710 },
    { id: '924****3167', amount: 2000 },
    { id: '463****0582', amount: 6210 },
    { id: '781****9426', amount: 2940 },
    { id: '056****3718', amount: 2000 },
    { id: '348****6205', amount: 8460 },
    { id: '912****4573', amount: 4670 },
    { id: '605****1839', amount: 2000 },
    { id: '274****8961', amount: 7390 },
    { id: '839****2516', amount: 5130 },
    { id: '162****7048', amount: 2000 },
    { id: '497****3185', amount: 9820 },
    { id: '723****6490', amount: 3280 },
    { id: '051****8273', amount: 2000 },
    { id: '386****1059', amount: 6580 },
    { id: '940****5721', amount: 2240 },
    { id: '617****3948', amount: 2000 },
    { id: '283****7615', amount: 8910 },
    { id: '754****0286', amount: 5760 },
    { id: '109****8352', amount: 2000 },
    { id: '862****4719', amount: 4130 },
    { id: '531****9064', amount: 7640 },
    { id: '206****3187', amount: 2000 },
    { id: '695****7421', amount: 3470 },
    { id: '418****0593', amount: 9530 },
    { id: '073****6814', amount: 2000 },
    { id: '957****2306', amount: 6020 },
    { id: '341****8759', amount: 2860 },
    { id: '825****1043', amount: 2000 },
    { id: '164****5938', amount: 8170 },
    { id: '709****2461', amount: 4920 },
    { id: '032****7185', amount: 2000 },
    { id: '586****9032', amount: 9350 },
    { id: '218****4679', amount: 3650 },
    { id: '974****1258', amount: 2000 },
    { id: '453****8096', amount: 6810 },
    { id: '801****3527', amount: 2580 },
    { id: '127****9463', amount: 2000 },
    { id: '639****0815', amount: 8640 },
    { id: '285****7341', amount: 4260 },
    { id: '916****5082', amount: 2000 },
    { id: '374****1926', amount: 7180 },
    { id: '052****8647', amount: 5490 },
    { id: '748****3159', amount: 2000 },
    { id: '190****6274', amount: 9970 },
    { id: '563****0418', amount: 3820 },
    { id: '831****7952', amount: 2000 },
    { id: '406****2837', amount: 6320 },
    { id: '975****6140', amount: 2170 },
    { id: '284****9036', amount: 2000 },
    { id: '617****5284', amount: 7810 },
    { id: '039****1746', amount: 4560 },
    { id: '852****6903', amount: 2000 },
    { id: '493****8172', amount: 9030 },
    { id: '126****4509', amount: 3140 },
    { id: '708****2351', amount: 2000 },
    { id: '365****9814', amount: 6970 },
    { id: '941****0628', amount: 5420 },
    { id: '214****8375', amount: 2000 },
    { id: '687****3190', amount: 8290 },
    { id: '053****7462', amount: 2710 },
    { id: '829****1645', amount: 2000 },
    { id: '470****5928', amount: 9480 },
    { id: '192****0384', amount: 3740 },
    { id: '756****8219', amount: 2000 },
    { id: '308****4751', amount: 7130 },
    { id: '645****9207', amount: 4930 },
    { id: '017****3862', amount: 2000 },
    { id: '934****7518', amount: 8670 },
    { id: '521****0946', amount: 2360 },
    { id: '682****4173', amount: 2000 },
    { id: '149****8056', amount: 7590 },
    { id: '873****2614', amount: 5810 },
    { id: '260****9437', amount: 2000 },
    { id: '715****6082', amount: 9280 },
    { id: '394****1725', amount: 3420 },
    { id: '058****9361', amount: 2000 },
    { id: '827****4503', amount: 6740 },
    { id: '461****7298', amount: 2950 },
    { id: '903****1846', amount: 2000 },
    { id: '236****8519', amount: 8120 },
    { id: '679****3042', amount: 4390 },
    { id: '115****7628', amount: 2000 },
    { id: '548****0913', amount: 9850 },
    { id: '792****6351', amount: 5270 },
    { id: '031****8496', amount: 2000 },
    { id: '864****2073', amount: 7460 },
    { id: '407****5918', amount: 2630 },
    { id: '953****1284', amount: 2000 },
    { id: '172****8065', amount: 8940 },
    { id: '628****4139', amount: 3580 },
    { id: '294****7501', amount: 2000 },
    { id: '741****0926', amount: 6230 },
    { id: '086****5347', amount: 4760 },
    { id: '519****8672', amount: 2000 },
    { id: '362****1408', amount: 9170 },
    { id: '905****7283', amount: 3840 },
    { id: '147****6930', amount: 2000 },
    { id: '683****2517', amount: 6520 },
    { id: '250****9146', amount: 2290 },
    { id: '798****3652', amount: 2000 },
    { id: '431****0875', amount: 7730 },
    { id: '064****5291', amount: 4180 },
    { id: '925****1738', amount: 2000 },
    { id: '307****8462', amount: 9560 },
    { id: '612****3905', amount: 5640 },
    { id: '184****7259', amount: 2000 },
    { id: '859****0417', amount: 3370 },
    { id: '273****6184', amount: 8020 },
    { id: '496****2053', amount: 2000 },
    { id: '038****9716', amount: 6910 },
    { id: '724****5830', amount: 2450 },
    { id: '961****3472', amount: 2000 },
    { id: '315****8069', amount: 8840 },
    { id: '670****1925', amount: 4510 },
    { id: '208****7354', amount: 2000 },
    { id: '543****9618', amount: 7290 },
    { id: '892****4071', amount: 3190 },
    { id: '157****6843', amount: 2000 },
    { id: '736****0259', amount: 9420 },
    { id: '401****8736', amount: 5060 },
    { id: '829****5104', amount: 2000 },
    { id: '264****9381', amount: 6870 },
    { id: '915****2067', amount: 3720 },
    { id: '078****6419', amount: 2000 },
    { id: '652****3840', amount: 8310 },
    { id: '340****7158', amount: 2160 },
    { id: '987****0526', amount: 2000 },
    { id: '513****8294', amount: 7680 },
    { id: '176****4305', amount: 4930 },
    { id: '845****2917', amount: 2000 },
    { id: '291****6574', amount: 9050 },
    { id: '608****1439', amount: 3540 },
    { id: '037****9251', amount: 2000 },
    { id: '754****6183', amount: 6420 },
    { id: '429****0765', amount: 2810 },
    { id: '163****8492', amount: 2000 },
    { id: '902****5317', amount: 7980 },
    { id: '586****2041', amount: 4650 },
    { id: '321****9784', amount: 2000 },
    { id: '674****1508', amount: 8730 },
    { id: '095****8263', amount: 3070 },
    { id: '817****4390', amount: 2000 },
    { id: '452****7016', amount: 7140 },
    { id: '738****2659', amount: 5390 },
    { id: '109****4832', amount: 2000 },
    { id: '863****9175', amount: 9670 },
    { id: '205****6481', amount: 3980 },
    { id: '591****0327', amount: 2000 },
    { id: '346****7850', amount: 7560 },
    { id: '924****1608', amount: 4820 },
    { id: '018****5937', amount: 2000 },
    { id: '705****2841', amount: 9210 },
    { id: '438****6179', amount: 2630 },
    { id: '152****9064', amount: 2000 },
    { id: '879****3415', amount: 8390 },
    { id: '267****5183', amount: 4120 },
    { id: '630****7942', amount: 2000 },
    { id: '941****5286', amount: 9850 },
    { id: '384****0719', amount: 5740 },
    { id: '716****2058', amount: 2000 }
];

// State
const FAKE_FEED_SHOW_MS = 8000;     // visible duration
const FAKE_FEED_GAP_MS  = 60000;    // gap after hide (total cycle = 20s)

let fakeFeedQueue = [];
let fakeFeedTimer = null;
let fakeFeedHideTimer = null;
let fakeFeedActive = false;
let fakeFeedCurrent = null;

function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function rebuildFakeFeedQueue() {
    fakeFeedQueue = shuffleArray(FAKE_WITHDRAW_DATA);
}

function getFeedContainer() {
    let el = $('fakeWithdrawFeed');
    if (!el) {
        el = document.createElement('div');
        el.id = 'fakeWithdrawFeed';
        el.className = 'fake-withdraw-feed';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
    }
    return el;
}

function showNextFakeWithdraw() {
    if (!fakeFeedActive) return;
    if (!fakeFeedQueue.length) rebuildFakeFeedQueue();
    const item = fakeFeedQueue.shift();
    if (!item) return;

    // Respect reduced motion
    const reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const container = getFeedContainer();

    // ✅ v3.9: Enhanced toast design — title + user + amount + time
    const toast = document.createElement('div');
    toast.className = 'fake-withdraw-toast';
    toast.innerHTML = `
        <div class="fake-withdraw-icon">
            <i class="fas fa-circle-check" aria-hidden="true"></i>
        </div>
        <div class="fake-withdraw-body">
            <div class="fake-withdraw-title">Withdrawal Success</div>
            <div class="fake-withdraw-user">User ID: ${item.id}</div>
            <div class="fake-withdraw-meta">
                <span class="fake-withdraw-amount">${item.amount.toLocaleString()} <small>GROYP</small></span>
                <span class="fake-withdraw-time">· just now</span>
            </div>
        </div>
    `;

    container.innerHTML = '';
    container.appendChild(toast);
    fakeFeedCurrent = toast;

    // Trigger slide-in on next frame
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
    });

    // Hide after SHOW_MS
    fakeFeedHideTimer = setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, reduceMotion ? 20 : 600);
        fakeFeedCurrent = null;
    }, FAKE_FEED_SHOW_MS);

    // Schedule next
    fakeFeedTimer = setTimeout(showNextFakeWithdraw, FAKE_FEED_SHOW_MS + FAKE_FEED_GAP_MS);
}

function startFakeWithdrawFeed() {
    if (fakeFeedActive) return;
    fakeFeedActive = true;
    rebuildFakeFeedQueue();
    console.log('💸 Fake withdraw feed started');

    // First toast after 3s so page has time to settle
    fakeFeedTimer = setTimeout(showNextFakeWithdraw, 3000);
}

function stopFakeWithdrawFeed() {
    if (!fakeFeedActive) return;
    fakeFeedActive = false;
    if (fakeFeedTimer) { clearTimeout(fakeFeedTimer); fakeFeedTimer = null; }
    if (fakeFeedHideTimer) { clearTimeout(fakeFeedHideTimer); fakeFeedHideTimer = null; }

    // Remove visible toast immediately
    const container = $('fakeWithdrawFeed');
    if (container) container.innerHTML = '';
    fakeFeedCurrent = null;

    console.log('💸 Fake withdraw feed stopped');
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
        updateWalletConnectBtn();
    });

    // ✅ v3.7: No periodic price refresh — fetch happens once inside enterApp()
    // and on manual refresh via the 🔄 button (refreshTokenBtn).
    // This removes the previous `setInterval(fetchTokenPrice, 60000)`.

    let lastVisible = Date.now();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && booted && Date.now() - lastVisible > 60000) {
            lastVisible = Date.now();
            boot(true);
        }
    });

    // ✅ v3.8: Stop the fake feed when tab becomes hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopFakeWithdrawFeed();
        } else if (document.querySelector('.nav-item.active')?.dataset.page === 'wallet') {
            startFakeWithdrawFeed();
        }
    });

    // ✅ تعديل 3: استعادة الاتصال عند العودة للتطبيق بعد إعادة تحميل WebView على أندرويد
    document.addEventListener('visibilitychange', async () => {
        if (document.hidden || !window.tonConnectUI) return;
        if (window.tonConnectUI.connected) return;
        try {
            await window.tonConnectUI.connector.restoreConnection();
        } catch (e) {
            console.warn('restoreConnection on visibility failed:', e);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
