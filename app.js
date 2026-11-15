// ============================================================================
// GROYPER MINE - EMBER VAULT v2 - app.js (client)
// Rules: no userId from client (server reads Telegram initData), 1 read on
// open (/api/init), 1 write per action, live mining computed from time only.
// ============================================================================
'use strict';

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#0A0B10'); tg.setBackgroundColor('#0A0B10'); tg.disableVerticalSwipes?.(); } catch {} }

// ---------- Defaults (overridden by server config from /api/init) ----------
const CFG = {
  symbol: 'GROYP', bot: 'GroyperMinebot', app: 'Mine',
  miningReward: 20, cooldownMs: 6 * 3600e3,
  adsPerBatch: 10, adsReward: 20, adsCooldownMs: 6 * 3600e3,
  minWithdraw: 2000, feeTon: 0.1,
  milestones: [{ count: 50, reward: 1000 }, { count: 100, reward: 2500 }, { count: 250, reward: 5000 }, { count: 500, reward: 10000 }, { count: 1000, reward: 25000 }],
  boosts: { bronze: { price: 1, mult: 2, name: 'SPARK' }, silver: { price: 2.5, mult: 5, name: 'BLAZE' }, gold: { price: 10, mult: 12, name: 'INFERNO' } },
  referralReward: 75
};

// ---------- i18n ----------
const I18N = {
  en: { ready: 'READY', claim: 'CLAIM', claimed: 'Claimed', notReady: 'Not ready yet', netErr: 'Network error', openTg: 'Open from Telegram', copied: 'Copied!', connect: 'Connect wallet first', watch: 'WATCH AD', noAd: 'No ad available', verifying: 'Verifying...', done: 'DONE', start: 'START', verify: 'VERIFY', min: 'Minimum', insufficient: 'Insufficient balance', processing: 'PROCESSING...', withdraw: 'WITHDRAW', submitted: 'Withdrawal submitted!', noTasks: 'No tasks available', noRefs: 'No referrals yet', noWd: 'No withdrawals yet', active: 'ACTIVE', inactive: 'INACTIVE', next: 'Next batch in', offline: 'Offline', more: 'Load more', checkin: 'Daily check-in', streak: 'Day streak', payFail: 'Payment cancelled', boostOk: 'Boost activated!', pending: 'PENDING', approved: 'APPROVED', paid: 'PAID', rejected: 'REJECTED', maint: 'Under maintenance', invite: 'Join Groyper Mine and start mining!', confirmBoost: 'Activate boost for' },
  ar: { ready: 'جاهز', claim: 'استلام', claimed: 'تم الاستلام', notReady: 'غير جاهز بعد', netErr: 'خطأ في الشبكة', openTg: 'افتح من تيليجرام', copied: 'تم النسخ!', connect: 'اربط المحفظة أولاً', watch: 'شاهد إعلانًا', noAd: 'لا يوجد إعلان متاح', verifying: 'جارٍ التحقق...', done: 'تم', start: 'ابدأ', verify: 'تحقق', min: 'الحد الأدنى', insufficient: 'الرصيد غير كافٍ', processing: 'جارٍ المعالجة...', withdraw: 'سحب', submitted: 'تم إرسال طلب السحب!', noTasks: 'لا توجد مهام', noRefs: 'لا توجد إحالات بعد', noWd: 'لا توجد سحوبات بعد', active: 'نشط', inactive: 'غير نشط', next: 'الدفعة التالية بعد', offline: 'غير متصل', more: 'عرض المزيد', checkin: 'الحضور اليومي', streak: 'أيام متتالية', payFail: 'تم إلغاء الدفع', boostOk: 'تم تفعيل الترقية!', pending: 'معلق', approved: 'مقبول', paid: 'مدفوع', rejected: 'مرفوض', maint: 'التطبيق تحت الصيانة', invite: 'انضم إلى Groyper Mine وابدأ التعدين!', confirmBoost: 'تفعيل الترقية مقابل' }
};
const lang = (tg?.initDataUnsafe?.user?.language_code || 'en').startsWith('ar') ? 'ar' : 'en';
const t = k => I18N[lang][k] || I18N.en[k] || k;
if (lang === 'ar') { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'ar'; }

// ---------- State ----------
const S = {
  user: null, tasks: [], price: { usd: 0, change: 0, mcap: 0, fdv: 0, liq: 0, vol: 0 },
  wallet: null, serverOffset: 0, busy: {}, refs: { items: [], cursor: null, loaded: false },
  wd: { items: [], cursor: null, loaded: false }, shownBalance: 0, booted: false
};
const $ = id => document.getElementById(id);
const setText = (id, v) => { const e = $(id); if (e && e.textContent !== String(v)) e.textContent = v; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowMs = () => Date.now() + S.serverOffset;
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
const usd = n => { const v = n * (S.price.usd || 0); return '≈ $' + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)); };
const clock = ms => { if (ms <= 0) return '00:00:00'; const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(x => String(x).padStart(2, '0')).join(':'); };
const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function haptic(type = 'light') {
  const h = tg?.HapticFeedback; if (!h) return;
  if (type === 'success' || type === 'error' || type === 'warning') h.notificationOccurred(type); else h.impactOccurred(type);
}

function toast(msg, type = 'info', dur = 3000) {
  const el = $('toast'), m = $('toastMessage'); if (!el || !m) return;
  m.textContent = msg; el.classList.remove('hidden');
  el.style.borderColor = type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--border-light)';
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), dur);
}

// ---------- Local cache (instant paint, then refresh from server) ----------
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem('gm_' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('gm_' + k, JSON.stringify(v)); } catch {} }
};

// ---------- API (auth = Telegram initData, verified on server) ----------
async function api(path, { method = 'GET', body } = {}) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 45000); // Render free cold start can take ~30-50s
  try {
    const res = await fetch('/api' + path, {
      method,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'tma ' + (tg?.initData || '') },
      body: body ? JSON.stringify(body) : undefined
    });
    clearTimeout(to);
    const data = await res.json().catch(() => ({}));
    setOffline(false);
    if (res.status === 503) { showMaintenance(); return { ok: false, error: t('maint') }; }
    if (!res.ok || data.success === false) return { ok: false, error: data.error || t('netErr'), data };
    return { ok: true, data };
  } catch { setOffline(true); return { ok: false, error: t('netErr') }; }
}

function setOffline(off) {
  let b = $('offlineBadge');
  if (!b) { b = document.createElement('div'); b.id = 'offlineBadge'; b.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0);left:50%;transform:translateX(-50%);background:#FF4D00;color:#fff;font:600 11px Inter,sans-serif;padding:3px 12px;border-radius:0 0 10px 10px;z-index:9999;display:none'; document.body.appendChild(b); }
  b.textContent = '● ' + t('offline'); b.style.display = off ? 'block' : 'none';
}

function showMaintenance() {
  document.body.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#F2F3F7;font:600 18px Inter,sans-serif;text-align:center;padding:24px">🔧<br>${esc(t('maint'))}</div>`;
}

// ---------- Single guard against double taps ----------
async function once(key, fn) {
  if (S.busy[key]) return; S.busy[key] = true;
  try { return await fn(); } finally { S.busy[key] = false; }
}

// ============================================================================
// MINING (live, computed from time only - zero DB writes while mining)
// ============================================================================
const mult = () => S.user?.boostMultiplier && (!S.user.boostExpiresAt || S.user.boostExpiresAt > nowMs()) ? S.user.boostMultiplier : 1;

function miningState() {
  if (!S.user) return { elapsed: 0, progress: 0, accrued: 0, ready: false, remaining: CFG.cooldownMs, full: 0 };
  const elapsed = Math.max(0, nowMs() - (S.user.lastMiningClaim || 0));
  const capped = Math.min(elapsed, CFG.cooldownMs);
  const full = CFG.miningReward * mult();
  return { elapsed, progress: capped / CFG.cooldownMs, accrued: full * (capped / CFG.cooldownMs), ready: elapsed >= CFG.cooldownMs, remaining: CFG.cooldownMs - capped, full };
}

const RING_C = 2 * Math.PI * 90;
function renderMining() {
  if (!S.user) return;
  const m = miningState(), ring = $('ringProgress');
  if (ring) { ring.style.strokeDasharray = RING_C; ring.style.strokeDashoffset = RING_C * (1 - m.progress); ring.classList.toggle('active', m.ready); }
  setText('minedAmount', m.accrued.toFixed(m.ready ? 0 : 3));
  setText('minedUsd', usd(m.accrued));
  setText('miningTimer', m.ready ? t('ready') : clock(m.remaining));
  setText('hashPower', mult() + 'x');
  const b = $('claimMiningBtn');
  if (b) { b.disabled = !m.ready; b.classList.toggle('ready', m.ready); b.innerHTML = `<i class="fas fa-fire"></i> ${t('claim')}${m.ready ? ' ' + fmt(m.full) + ' ' + CFG.symbol : ''}`; }
}

async function claimMining() {
  const m = miningState(); if (!m.ready) return toast(t('notReady'), 'error');
  return once('mine', async () => {
    // Optimistic UI
    const prev = { ...S.user };
    S.user.balance += m.full; S.user.lastMiningClaim = nowMs();
    renderAll(); sparks($('claimMiningBtn')); haptic('success');
    const r = await api('/mining/claim', { method: 'POST' });
    if (r.ok) { merge(r.data.user); toast(`✅ +${fmt(r.data.reward)} ${CFG.symbol}`, 'success'); }
    else { S.user = prev; toast(r.error, 'error'); haptic('error'); }
    renderAll();
  });
}

// ============================================================================
// ADS (server issues ymid, ad network postbacks to server, server counts)
// ============================================================================
const adsCooldownLeft = () => Math.max(0, (S.user?.adsCooldownUntil || 0) - nowMs());

function renderAds() {
  if (!S.user) return;
  const w = S.user.adsWatched || 0, full = w >= CFG.adsPerBatch, cd = adsCooldownLeft();
  const seg = $('adsSegments');
  if (seg) {
    if (seg.children.length !== CFG.adsPerBatch) seg.innerHTML = '<div class="ads-segment"></div>'.repeat(CFG.adsPerBatch);
    [...seg.children].forEach((c, i) => c.classList.toggle('active', i < w));
  }
  setText('adsAccumulated', `${fmt(w * (CFG.adsReward / CFG.adsPerBatch))} ${CFG.symbol}`);
  setText('adsCounter', `${w}/${CFG.adsPerBatch}`);
  const wb = $('watchAdBtn'), cb = $('claimAdsBtn'), cdEl = $('adsCooldown');
  if (wb) { wb.style.display = !full && cd <= 0 ? 'flex' : 'none'; wb.innerHTML = `<i class="fas fa-play"></i> ${t('watch')} (+${CFG.adsReward / CFG.adsPerBatch})`; }
  if (cb) { cb.style.display = full && cd <= 0 ? 'flex' : 'none'; cb.innerHTML = `<i class="fas fa-check"></i> ${t('claim')} ${CFG.adsReward} ${CFG.symbol}`; }
  if (cdEl) { cdEl.style.display = cd > 0 ? 'block' : 'none'; setText('adsTimer', clock(cd)); }
}

async function watchAd() {
  if (!S.user || (S.user.adsWatched || 0) >= CFG.adsPerBatch || adsCooldownLeft() > 0) return;
  return once('ad', async () => {
    const s = await api('/ads/start', { method: 'POST', body: { token: S.user.adsToken } });
    if (!s.ok) return toast(s.error, 'error');
    let ok = false;
    try { if (typeof window.show_12265394 === 'function') { await window.show_12265394({ ymid: s.data.ymid }); ok = true; } } catch {}
    if (!ok) return toast(t('noAd'), 'error');
    const r = await api('/ads/watch', { method: 'POST', body: { ymid: s.data.ymid, token: s.data.token } });
    if (r.ok) { S.user.adsWatched = r.data.watched; S.user.adsToken = r.data.token; haptic('light'); renderAds(); persist(); }
    else toast(r.error, 'error');
  });
}

async function claimAds() {
  return once('adsClaim', async () => {
    const r = await api('/ads/claim', { method: 'POST', body: { token: S.user.adsToken } });
    if (r.ok) { merge(r.data.user); toast(`✅ +${r.data.reward} ${CFG.symbol}`, 'success'); haptic('success'); sparks($('claimAdsBtn')); }
    else { toast(r.error, 'error'); if (/expired|Watch all/i.test(r.error)) { S.user.adsToken = null; S.user.adsWatched = 0; } }
    renderAll();
  });
}

// ============================================================================
// DAILY CHECK-IN / STREAK (needs optional #checkinBtn, #streakCount)
// ============================================================================
function renderCheckin() {
  const b = $('checkinBtn'); if (!b || !S.user) return;
  const today = Math.floor(nowMs() / 86400e3), done = (S.user.lastCheckinDay || 0) === today;
  b.disabled = done; b.textContent = done ? '✓ ' + t('done') : t('checkin');
  setText('streakCount', `${S.user.streak || 0} ${t('streak')}`);
}
async function checkin() {
  return once('checkin', async () => {
    const r = await api('/checkin', { method: 'POST' });
    if (r.ok) { merge(r.data.user); toast(`🔥 +${r.data.reward} ${CFG.symbol}`, 'success'); haptic('success'); }
    else toast(r.error, 'error');
    renderAll();
  });
}

// ============================================================================
// TASKS (server-side verification mandatory)
// ============================================================================
const taskState = {}; // taskId -> 'opened'
function renderTasks() {
  const c = $('taskList'); if (!c) return;
  if (!S.tasks.length) return void (c.innerHTML = `<div class="empty-state">${t('noTasks')}</div>`);
  const done = new Set(S.user?.completedTasks || []);
  c.innerHTML = S.tasks.map(k => {
    const d = done.has(k.id), opened = taskState[k.id];
    return `<div class="task-item ${d ? 'done' : ''}" data-task-id="${esc(k.id)}">
      <div class="task-icon"><i class="${esc(k.iconClass || 'fas fa-link')}"></i></div>
      <div class="task-info"><div class="task-name">${esc(k.name)}</div><div class="task-reward">+${fmt(k.reward)} ${CFG.symbol}</div></div>
      <button class="task-btn ${d ? 'completed' : ''}" data-act="${opened ? 'verify' : 'start'}" ${d ? 'disabled' : ''}>${d ? '✓ ' + t('done') : opened ? t('verify') : t('start')}</button></div>`;
  }).join('');
}

async function taskAction(id, act) {
  const k = S.tasks.find(x => x.id === id); if (!k) return;
  if (act === 'start') {
    if (/^https:\/\/t\.me\//.test(k.url)) tg?.openTelegramLink ? tg.openTelegramLink(k.url) : window.open(k.url, '_blank');
    else tg?.openLink ? tg.openLink(k.url) : window.open(k.url, '_blank');
    taskState[id] = 'opened'; renderTasks(); return;
  }
  return once('task' + id, async () => {
    toast(t('verifying'));
    const r = await api('/tasks/verify', { method: 'POST', body: { taskId: id } });
    if (r.ok) { merge(r.data.user); toast(`✅ +${fmt(r.data.reward)} ${CFG.symbol}`, 'success'); haptic('success'); }
    else { toast(r.error, 'error'); haptic('error'); }
    renderAll();
  });
}

// ============================================================================
// REFERRALS (lazy + paginated)
// ============================================================================
function refLink() { return `https://t.me/${CFG.bot}/${CFG.app}?startapp=${S.user?.userId || ''}`; }

function renderReferral() {
  if (!S.user) return;
  const act = S.user.activeReferrals || 0, ina = S.user.inactiveReferrals || 0, total = act;
  setText('activeReferrals', act); setText('inactiveReferrals', ina);
  const claimed = new Set(S.user.claimedMilestones || []);
  const next = CFG.milestones.find(m => total < m.count);
  const ml = $('milestoneList');
  if (ml) ml.innerHTML = CFG.milestones.map(m => {
    const reached = total >= m.count, got = claimed.has(m.count), pct = Math.min(100, total / m.count * 100);
    return `<div class="milestone-item ${got ? 'completed' : ''} ${next === m ? 'current' : ''}">
      <div class="milestone-icon">${got ? '✅' : reached ? '🎁' : '🔒'}</div>
      <div class="milestone-info"><div class="milestone-count">${fmt(m.count)}</div><div class="milestone-reward">+${fmt(m.reward)} ${CFG.symbol}</div>
      <div class="milestone-bar"><i style="width:${pct}%"></i></div></div>
      ${reached && !got ? `<button class="task-btn" data-ms="${m.count}">${t('claim')}</button>` : ''}</div>`;
  }).join('');
  renderRefList();
}

function renderRefList() {
  const rl = $('referralList'); if (!rl) return;
  if (!S.refs.items.length) return void (rl.innerHTML = `<div class="empty-state">${t('noRefs')}</div>`);
  rl.innerHTML = S.refs.items.map(r => `<div class="referral-item"><img loading="lazy" alt="" src="https://ui-avatars.com/api/?name=${encodeURIComponent(r.username || 'U')}&background=FF4D00&color=fff&size=64">
    <span class="referral-item-name">@${esc(r.username)}</span><span class="referral-status ${r.active ? 'active' : 'inactive'}">${r.active ? t('active') : t('inactive')}</span></div>`).join('')
    + (S.refs.cursor ? `<button class="btn-secondary" id="moreRefs">${t('more')}</button>` : '');
}

async function loadRefs(more = false) {
  if (S.refs.loaded && !more) return;
  return once('refs', async () => {
    const r = await api('/referrals' + (more && S.refs.cursor ? '?cursor=' + encodeURIComponent(S.refs.cursor) : ''));
    if (!r.ok) return;
    S.refs.items = more ? S.refs.items.concat(r.data.items) : r.data.items; S.refs.cursor = r.data.cursor || null; S.refs.loaded = true;
    renderRefList();
  });
}

async function claimMilestone(count) {
  return once('ms' + count, async () => {
    const r = await api('/referrals/milestone', { method: 'POST', body: { count: +count } });
    if (r.ok) { merge(r.data.user); toast(`🎉 +${fmt(r.data.reward)} ${CFG.symbol}`, 'success'); haptic('success'); confetti(); }
    else toast(r.error, 'error');
    renderAll();
  });
}

// ============================================================================
// WALLET / WITHDRAW
// ============================================================================
function renderWallet() {
  if (!S.user) return;
  const u = tg?.initDataUnsafe?.user || {};
  const av = $('walletAvatar'); if (av && !av.src.includes('http')) av.src = u.photo_url || 'https://ui-avatars.com/api/?name=U&background=FF4D00&color=fff';
  setText('walletUserName', u.first_name || S.user.firstName || 'User');
  setText('walletUserHandle', '@' + (u.username || S.user.username || 'user'));
  setText('totalWithdrawn', `${fmt(S.user.totalWithdrawn)} ${CFG.symbol}`);
  setText('availableToWithdraw', `${fmt(S.user.balance)} ${CFG.symbol}`);
  setText('withdrawWalletAddress', S.wallet ? short(S.wallet, 6) : '—');
  const inp = $('withdrawAmount'), hint = document.querySelector('.input-hint');
  if (hint) hint.textContent = `${t('min')}: ${fmt(CFG.minWithdraw)} ${CFG.symbol}`;
  if (inp) { const v = parseFloat(inp.value); inp.classList.toggle('invalid', !!inp.value && (v < CFG.minWithdraw || v > S.user.balance)); inp.classList.toggle('valid', !!inp.value && v >= CFG.minWithdraw && v <= S.user.balance); }
  renderWdList();
}

function renderWdList() {
  const h = $('withdrawHistory'); if (!h) return;
  if (!S.wd.items.length) return void (h.innerHTML = `<div class="empty-state">${t('noWd')}</div>`);
  h.innerHTML = S.wd.items.map(w => `<div class="history-item"><div><span class="history-amount">${fmt(w.amount)} ${CFG.symbol}</span><small style="display:block;opacity:.6">${new Date(w.createdAt).toLocaleDateString()}</small></div>
    <span class="history-status ${esc(w.status)}">${t(w.status)}</span></div>`).join('')
    + (S.wd.cursor ? `<button class="btn-secondary" id="moreWd">${t('more')}</button>` : '');
}

async function loadWithdrawals(more = false) {
  if (S.wd.loaded && !more) return;
  return once('wd', async () => {
    const r = await api('/withdrawals' + (more && S.wd.cursor ? '?cursor=' + encodeURIComponent(S.wd.cursor) : ''));
    if (!r.ok) return;
    S.wd.items = more ? S.wd.items.concat(r.data.items) : r.data.items; S.wd.cursor = r.data.cursor || null; S.wd.loaded = true;
    renderWdList();
  });
}

// Anti-bot flow: server creates request + payload(comment) -> user pays fee -> server verifies on-chain.
async function sendTon(intent) {
  const res = await window.tonConnectUI.sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 600,
    messages: [{ address: intent.address, amount: String(Math.round(intent.amountTon * 1e9)), payload: intent.payload }]
  });
  return res.boc;
}

async function submitWithdraw() {
  if (!S.user) return;
  const amount = Math.floor(parseFloat($('withdrawAmount')?.value) || 0);
  if (amount < CFG.minWithdraw) return toast(`${t('min')} ${fmt(CFG.minWithdraw)}`, 'error');
  if (amount > S.user.balance) return toast(t('insufficient'), 'error');
  if (!S.wallet) return toast(t('connect'), 'error');
  return once('withdraw', async () => {
    const btn = $('withdrawBtn'); btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('processing')}`;
    try {
      const it = await api('/withdraw/intent', { method: 'POST', body: { amount } });
      if (!it.ok) throw new Error(it.error);
      if (it.data.feeRequired) {
        let boc; try { boc = await sendTon(it.data); } catch { throw new Error(t('payFail')); }
        const cf = await api('/withdraw/confirm', { method: 'POST', body: { requestId: it.data.requestId, boc } });
        if (!cf.ok) throw new Error(cf.error);
        merge(cf.data.user);
      } else {
        const cf = await api('/withdraw/confirm', { method: 'POST', body: { requestId: it.data.requestId } });
        if (!cf.ok) throw new Error(cf.error); merge(cf.data.user);
      }
      $('withdrawAmount').value = ''; S.wd.loaded = false; await loadWithdrawals();
      toast('✅ ' + t('submitted'), 'success'); haptic('success'); confetti();
    } catch (e) { toast(e.message || t('netErr'), 'error'); haptic('error'); }
    finally { btn.disabled = false; btn.innerHTML = `<i class="fas fa-lock"></i> ${t('withdraw')}`; renderAll(); }
  });
}

// ============================================================================
// BOOSTS (on-chain payment with unique comment, verified by server)
// ============================================================================
window.buyBoost = async type => {
  if (!S.wallet) return toast(t('connect'), 'warning');
  const b = CFG.boosts[type]; if (!b) return;
  if (!(tg?.showConfirm ? await new Promise(r => tg.showConfirm(`${t('confirmBoost')} ${b.price} TON?`, r)) : confirm(`${t('confirmBoost')} ${b.price} TON?`))) return;
  return once('boost', async () => {
    try {
      const it = await api('/boost/intent', { method: 'POST', body: { type } });
      if (!it.ok) throw new Error(it.error);
      let boc; try { boc = await sendTon(it.data); } catch { throw new Error(t('payFail')); }
      const cf = await api('/boost/confirm', { method: 'POST', body: { requestId: it.data.requestId, boc } });
      if (!cf.ok) throw new Error(cf.error);
      merge(cf.data.user); toast('🔥 ' + t('boostOk'), 'success'); haptic('success'); confetti();
    } catch (e) { toast(e.message, 'error'); haptic('error'); }
    renderAll();
  });
};

// ============================================================================
// TOKEN PRICE (served from server cache; DexScreener hit once/min for ALL users)
// ============================================================================
function renderToken() {
  const p = S.price; if (!p) return;
  setText('tokenPrice', '$' + (p.usd < 0.01 ? p.usd.toFixed(8) : p.usd.toFixed(4)));
  setText('tokenMarketCap', '$' + fmt(p.mcap)); setText('tokenFdv', '$' + fmt(p.fdv));
  setText('tokenLiquidity', '$' + fmt(p.liq)); setText('tokenVolume', '$' + fmt(p.vol));
  const ch = $('tokenChange'); if (ch) { ch.textContent = (p.change >= 0 ? '+' : '') + Number(p.change || 0).toFixed(2) + '%'; ch.className = 'token-change ' + (p.change >= 0 ? 'positive' : 'negative'); }
}
async function refreshPrice() {
  const r = await api('/price'); if (r.ok) { S.price = r.data.price; renderToken(); renderHeader(); }
}

// ============================================================================
// HEADER + RENDER ALL
// ============================================================================
const short = (a, n = 4) => a ? `${a.slice(0, n)}...${a.slice(-n)}` : '';

function renderHeader() {
  if (!S.user) return;
  const u = tg?.initDataUnsafe?.user || {};
  const av = $('userAvatar'); if (av && !av.dataset.set) { av.src = u.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.first_name || 'U') + '&background=FF4D00&color=fff'; av.dataset.set = 1; }
  setText('userName', u.first_name || S.user.firstName || 'User');
  setText('userHandle', '@' + (u.username || S.user.username || 'user'));
  setText('headerBalance', `${fmt(S.user.balance, 2)} ${CFG.symbol}`);
  setText('headerValue', usd(S.user.balance));
  const a = $('headerAddress'); if (a && S.wallet) { const h = `<i class="fas fa-wallet"></i> ${short(S.wallet)}`; if (a.innerHTML !== h) a.innerHTML = h; }
}

function renderAll() { renderHeader(); renderMining(); renderAds(); renderTasks(); renderReferral(); renderWallet(); renderCheckin(); renderToken(); persist(); }

function merge(patch) { if (patch) S.user = { ...S.user, ...patch }; }
function persist() { if (S.user) LS.set('user', { u: S.user, t: S.tasks, p: S.price, w: S.wallet }); }

// ============================================================================
// EFFECTS (lightweight: transform/opacity only)
// ============================================================================
function sparks(el) {
  if (prefersReduced || !el) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 14; i++) {
    const d = document.createElement('i'), a = Math.random() * Math.PI * 2, dist = 40 + Math.random() * 60;
    d.style.cssText = `position:fixed;left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;width:6px;height:6px;border-radius:50%;background:#FF9500;pointer-events:none;z-index:9999;transition:transform .7s ease-out,opacity .7s`;
    document.body.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = `translate(${Math.cos(a) * dist}px,${Math.sin(a) * dist}px) scale(.2)`; d.style.opacity = 0; });
    setTimeout(() => d.remove(), 750);
  }
}
function confetti() {
  if (prefersReduced) return;
  const c = ['#FF4D00', '#FF9500', '#FFD84D', '#F5C451'];
  for (let i = 0; i < 40; i++) {
    const d = document.createElement('i'), x = Math.random() * innerWidth;
    d.style.cssText = `position:fixed;top:-10px;left:${x}px;width:7px;height:10px;background:${c[i % 4]};z-index:9999;pointer-events:none;transition:transform ${1.2 + Math.random()}s ease-in,opacity 1.8s`;
    document.body.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = `translate(${(Math.random() - .5) * 160}px,${innerHeight + 20}px) rotate(${Math.random() * 720}deg)`; d.style.opacity = 0; });
    setTimeout(() => d.remove(), 2400);
  }
}
function startEmbers() {
  const cv = $('embersCanvas'); if (!cv || prefersReduced || (navigator.hardwareConcurrency || 4) <= 2) return;
  const ctx = cv.getContext('2d'); const size = () => { cv.width = innerWidth; cv.height = innerHeight; }; size(); addEventListener('resize', size);
  const P = Array.from({ length: 10 }, () => ({ x: Math.random() * cv.width, y: Math.random() * cv.height, r: 1 + Math.random() * 2, v: .2 + Math.random() * .5 }));
  let raf; const loop = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    P.forEach(p => { p.y -= p.v; p.x += Math.sin(p.y / 40) * .3; if (p.y < -5) { p.y = cv.height + 5; p.x = Math.random() * cv.width; } ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fillStyle = 'rgba(255,140,0,.55)'; ctx.fill(); });
    raf = requestAnimationFrame(loop);
  };
  loop(); document.addEventListener('visibilitychange', () => { cancelAnimationFrame(raf); if (!document.hidden) loop(); });
}

// ============================================================================
// TON CONNECT + BOOT
// ============================================================================
function friendly(raw) { try { return TON_CONNECT_UI.toUserFriendlyAddress(raw, false); } catch { return raw; } }

function initTon() {
  if (typeof TON_CONNECT_UI === 'undefined') return toast(t('netErr'), 'error');
  const ui = window.tonConnectUI = new TON_CONNECT_UI.TonConnectUI({ manifestUrl: location.origin + '/tonconnect-manifest.json', buttonRootId: 'ton-connect-btn', language: lang });
  // ton_proof: ask the wallet to sign a server-issued challenge (proves ownership)
  ui.setConnectRequestParameters({ state: 'loading' });
  api('/proof-payload').then(r => ui.setConnectRequestParameters(r.ok ? { state: 'ready', value: { tonProof: r.data.payload } } : null));
  ui.onStatusChange(async w => {
    if (!w) { S.wallet = null; if (S.booted && !S.user?.wallet) showOnboarding(); return; }
    if (S.user?.walletRaw === w.account.address) { S.wallet = S.user.wallet; renderHeader(); return; }
    const proof = w.connectItems?.tonProof?.proof;
    if (!proof) { if (S.booted && !S.user?.wallet) ui.disconnect(); return; }   // restored session without proof
    const r = await api('/register', { method: 'POST', body: { address: w.account.address, publicKey: w.account.publicKey, stateInit: w.account.walletStateInit, proof } });
    if (r.ok) { S.user = r.data.user; S.wallet = S.user.wallet; enterApp(); }
    else { toast(r.error, 'error', 5000); ui.disconnect(); }
  });
}

function showOnboarding() { $('onboardingScreen')?.classList.add('active'); const m = $('mainApp'); if (m) m.style.display = 'none'; }
function enterApp() {
  $('onboardingScreen')?.classList.remove('active'); const m = $('mainApp'); if (m) m.style.display = 'block';
  renderAll();
  if (!S.tick) S.tick = setInterval(() => { if (document.hidden) return; renderMining(); renderAds(); renderCheckin(); }, 1000);
}

function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('page' + name[0].toUpperCase() + name.slice(1))?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === name));
  haptic('light'); scrollTo({ top: 0 });
  if (name === 'referral') loadRefs(); if (name === 'wallet') loadWithdrawals();
}

function bind() {
  document.querySelectorAll('.nav-item').forEach(i => i.addEventListener('click', () => switchPage(i.dataset.page)));
  const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
  on('claimMiningBtn', claimMining); on('watchAdBtn', watchAd); on('claimAdsBtn', claimAds);
  on('withdrawBtn', submitWithdraw); on('checkinBtn', checkin); on('refreshTokenBtn', refreshPrice);
  on('maxWithdrawBtn', () => { $('withdrawAmount').value = Math.floor(S.user?.balance || 0); renderWallet(); });
  on('copyReferralBtn', () => { navigator.clipboard?.writeText(refLink()); toast(t('copied'), 'success'); haptic('light'); });
  on('shareReferralBtn', () => { const u = `https://t.me/share/url?url=${encodeURIComponent(refLink())}&text=${encodeURIComponent(t('invite'))}`; tg?.openTelegramLink ? tg.openTelegramLink(u) : window.open(u); });
  on('copyContractBtn', () => { navigator.clipboard?.writeText(CFG.tokenAddress || ''); toast(t('copied'), 'success'); });
  $('withdrawAmount')?.addEventListener('input', renderWallet);
  document.addEventListener('click', e => {   // event delegation
    const tb = e.target.closest('.task-btn[data-act]'); if (tb) return taskAction(tb.closest('[data-task-id]').dataset.taskId, tb.dataset.act);
    const ms = e.target.closest('[data-ms]'); if (ms) return claimMilestone(ms.dataset.ms);
    if (e.target.closest('#moreRefs')) return loadRefs(true);
    if (e.target.closest('#moreWd')) return loadWithdrawals(true);
  });
  // Resync when the app returns to foreground (no polling)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.booted && Date.now() - (S.lastSync || 0) > 60e3) boot(true); });
}

async function boot(silent = false) {
  let r = await api('/init');
  for (let i = 0; i < 3 && !r.ok && r.error === t('netErr'); i++) {   // server may be waking up
    if (!silent) toast(lang === 'ar' ? '⏳ جارٍ تشغيل الخادم...' : '⏳ Waking up server...', 'info', 6000);
    await new Promise(res => setTimeout(res, 4000 * (i + 1)));
    r = await api('/init');
  }
  if (!r.ok) { if (!silent && !S.user) showOnboarding(); return; }
  const d = r.data; S.lastSync = Date.now();
  Object.assign(CFG, d.config || {});
  S.serverOffset = (d.serverTime || Date.now()) - Date.now();
  S.tasks = d.tasks || []; S.price = d.price || S.price;
  if (d.user && d.user.wallet) {
    const keep = S.user?.adsToken && (S.user.adsCooldownUntil || 0) === (d.user.adsCooldownUntil || 0) ? { adsToken: S.user.adsToken, adsWatched: S.user.adsWatched || 0 } : { adsToken: null, adsWatched: 0 };
    S.user = { ...d.user, ...keep }; S.wallet = d.user.wallet; enterApp();
  }
  else showOnboarding();
  if (d.banner) toast(d.banner, 'info', 5000);
}

function init() {
  if (!tg?.initData) { document.body.insertAdjacentHTML('afterbegin', `<div style="padding:40px;text-align:center;color:#fff">${t('openTg')}</div>`); return; }
  bind(); startEmbers();
  // 1) instant paint from local cache
  const c = LS.get('user');
  if (c?.u) { S.user = c.u; S.tasks = c.t || []; S.price = c.p || S.price; S.wallet = c.w; if (c.u.wallet) enterApp(); }
  // 2) wallet SDK + 3) fresh data from the server
  initTon();
  boot().then(() => { S.booted = true; });
  setInterval(() => { if (!document.hidden) refreshPrice(); }, 120e3);
}

init();
