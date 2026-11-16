/* PeekaSnap client - core Snapchat-style app (camera, snaps, chat, friends, stories, map). Games live in game.js and hunt.js. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = {
  token: localStorage.getItem('ps_token'), user: null, groups: [],
  groupId: localStorage.getItem('ps_group'), group: null, hides: [], messages: [], leaderboard: [],
  view: 'camera', snap: null, myLoc: null, socket: null,
  friends: { friends: [], incoming: [], outgoing: [] }, chats: [], nicks: {}, inbox: [], stories: { mine: [], friends: [] },
  thread: null, threadMsgs: [], threadReads: {}, hideMode: false, minPingDelayMs: 5 * 60000,
};
const H = { socket: [], groupLoaded: [], view: [], loc: [], message: [] }; // hooks for game.js / hunt.js
fetch('/api/config').then(r => r.json()).then(c => { S.minPingDelayMs = c.minPingDelayMs; }).catch(() => {});

// ---------- api ----------
async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'x-token': S.token || '' } };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body) { o.body = JSON.stringify(opts.body); o.headers['content-type'] = 'application/json'; }
  let r;
  try { r = await fetch(path, o); }
  catch (_) { const e = new Error(navigator.onLine === false ? "You're offline. Check your connection and try again." : "Can't reach PeekaSnap right now. Check your connection and try again."); e.status = 0; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error && r.status >= 500) j.error = 'PeekaSnap had a problem. Try again in a moment.';
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; e.data = j; throw e; }
  if (j.nicknames) S.nicks = j.nicknames;
  return decorate(j);
}

// ---------- names & avatars ----------
// Every person object coming from the server ({id, name, username, ...}) gets its display name resolved here:
// my private nickname for them > their display name > username. The original is kept in .realName.
function decorate(o) {
  if (!o || typeof o !== 'object') return o;
  if (Array.isArray(o)) { o.forEach(decorate); return o; }
  if (typeof o.username === 'string' && typeof o.id === 'string' && 'name' in o) {
    if (!('realName' in o)) o.realName = o.name;
    const nick = o.id !== S.user?.id ? S.nicks[o.id] || null : null;
    o.nick = nick; o.name = nick || o.realName || o.username;
  }
  for (const k in o) if (o[k] && typeof o[k] === 'object') decorate(o[k]);
  return o;
}
const initials = u => { const w = String(u?.name || u?.username || '?').trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const avInner = u => u?.avatar ? `<img src="${esc(u.avatar)}" alt="" loading="lazy" draggable="false">` : esc(initials(u));
const AV_RED = '#FF2D46';
function setAvatar(el, u) { el.innerHTML = avInner(u); el.style.background = u?.avatar ? '#111' : AV_RED; el.classList.toggle('has-pic', !!u?.avatar); }
const matches = (q, ...xs) => !q || xs.some(x => String(x || '').toLowerCase().includes(q));
const personMatch = (q, u) => matches(q, u?.name, u?.realName, u?.nick, u?.username, u && '@' + u.username);

// ---------- feedback ----------
function toast(msg, cls = '') {
  const t = document.createElement('div'); t.className = 'toast ' + cls; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3500);
}
let audioCtx;
function sonar(kind = 'ping') {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'pop' ? [[0, 880]] : [[0, 1100], [0.35, 950], [0.7, 800]];
    notes.forEach(([d, f]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f, audioCtx.currentTime + d);
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + d + 0.3);
      o.connect(g).connect(audioCtx.destination); o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + 0.32);
    });
  } catch (_) {}
}
async function notify(title, body, url = '/') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', tag: 'peekasnap-' + title, vibrate: [200, 100, 200], data: { url } };
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) return reg.showNotification(title, opts); } catch (_) {}
  try { new Notification(title, opts); } catch (_) {}
}
let bannerTimer;
function banner(html, ms = 6000) {
  const b = $('#ping-banner'); b.innerHTML = html; b.classList.remove('hidden');
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  b.onclick = () => b.classList.add('hidden');
}
const avatarHtml = (u, cls = '') => u ? `<span class="avatar ${u.avatar ? 'has-pic' : ''} ${cls}" data-person="${esc(u.id)}" style="background:${u.avatar ? '#111' : AV_RED}">${avInner(u)}</span>` : '';
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function fmtIn(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000); if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// ---------- geolocation ----------
let watchId = null, lastShare = 0;
function getLoc(timeout = 12000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No GPS on this device'));
    if (watchId != null && S.myLoc && Date.now() - S.myLoc.t < 120000) return res(S.myLoc);
    navigator.geolocation.getCurrentPosition(p => { setMyLoc(p); res(S.myLoc); }, e => {
      if (e.code !== 1 && S.myLoc && Date.now() - S.myLoc.t < 60000) return res(S.myLoc);
      rej(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location'));
    }, { enableHighAccuracy: true, timeout, maximumAge: 5000 });
  });
}
function setMyLoc(p) {
  S.myLoc = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
  updateMeMarker(); H.loc?.forEach(f => f(S.myLoc));
  if (S.user?.shareLocation && Date.now() - lastShare > 30000) { lastShare = Date.now(); api('/api/me/location', { body: { lat: S.myLoc.lat, lng: S.myLoc.lng } }).catch(() => {}); }
}
H.loc = [];
function startWatch() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(setMyLoc, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}

// ---------- installed app: service worker, push, Home Screen prompt ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOS && /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios|opios|gsa\//i.test(navigator.userAgent);
document.documentElement.classList.toggle('standalone', isStandalone());
let swReg = null;
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').then(r => { swReg = r; if (S.token) ensurePush(); }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open') { const h = new URL(e.data.url, location.origin).hash.slice(1); if (h && S.user) setView(h); }
  });
}
const b64ToU8 = b => { const p = '='.repeat((4 - b.length % 4) % 4); const r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
async function ensurePush() {
  try {
    if (!S.token || !('PushManager' in window) || Notification.permission !== 'granted') return false;
    const reg = swReg || await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) { const { publicKey } = await api('/api/push/key'); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) }); }
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
    return true;
  } catch (_) { return false; }
}
async function enableAlerts() {
  sonar('pop');
  if (!('Notification' in window)) {
    if (isIOS && !isStandalone()) { showInstallCard(true); return toast('On iPhone, add PeekaSnap to your Home Screen first to get alerts'); }
    return toast('This browser only supports in-app alerts');
  }
  const p = await Notification.requestPermission();
  if (p !== 'granted') return toast('Alerts blocked - you will still get in-app alerts');
  const pushed = await ensurePush();
  toast(pushed ? 'Alerts on 🔔 (even when the app is closed)' : 'Alerts on 🔔 while the app is open', 'y');
  hideInstallCard(); renderProfile();
}
let deferredPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (S.user) maybeShowInstallCard(); renderInstallBtn(); });
addEventListener('appinstalled', () => { deferredPrompt = null; hideInstallCard(); toast('Installed! Open PeekaSnap from your Home Screen 📲', 'y'); });
const canInstall = () => !isStandalone() && (deferredPrompt || isIOSSafari);
function renderInstallBtn() { $('#install-btn')?.classList.toggle('hidden', !canInstall()); }
function maybeShowInstallCard() {
  if (Date.now() < (+localStorage.getItem('ps_install_snooze') || 0)) return;
  if (canInstall()) return showInstallCard();
  if (isStandalone() && 'Notification' in window && Notification.permission === 'default') showAlertsCard();
}
function showInstallCard(force) {
  if (!canInstall() && !force) return;
  const ios = isIOS && !deferredPrompt;
  $('#install-title').textContent = 'Add PeekaSnap to your Home Screen';
  $('#install-body').textContent = ios ? 'Opens full-screen like an app and lets PeekaSnap send alerts:' : 'Full-screen, one tap to open, and Peak + game alerts like a real app.';
  $('#install-ios').classList.toggle('hidden', !ios);
  $('#install-card').classList.toggle('ios-arrow', ios && !/ipad/i.test(navigator.userAgent));
  $('#install-go').classList.toggle('hidden', ios);
  $('#install-go').textContent = 'Install';
  $('#install-go').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
    deferredPrompt = null; hideInstallCard(); renderInstallBtn();
    if (outcome !== 'accepted') toast("No problem - it's in your Profile any time");
  };
  $('#install-card').classList.remove('hidden');
}
function showAlertsCard() {
  $('#install-title').textContent = 'Turn on alerts 🔔';
  $('#install-body').textContent = 'Get a buzz for new Peaks, chats, friend requests and game pings, even when PeekaSnap is closed.';
  $('#install-ios').classList.add('hidden'); $('#install-card').classList.remove('ios-arrow');
  $('#install-go').classList.remove('hidden'); $('#install-go').textContent = 'Turn on';
  $('#install-go').onclick = enableAlerts;
  $('#install-card').classList.remove('hidden');
}
function hideInstallCard() { $('#install-card').classList.add('hidden'); }
$('#install-later').onclick = $('#install-x').onclick = () => { localStorage.setItem('ps_install_snooze', Date.now() + 3 * 864e5); hideInstallCard(); };
$('#install-btn').onclick = () => { closeSheets(); showInstallCard(true); };

// ---------- boot / auth ----------
let bootTries = 0;
async function boot() {
  if (!S.token) return showOnboard();
  try { const me = await api('/api/me'); S.user = me.user; S.groups = me.groups; }
  catch (e) {
    if (e.status === 401) { // saved login no longer valid (logged out elsewhere, or the free server was reset and lost accounts)
      localStorage.removeItem('ps_token'); S.token = null;
      const last = localStorage.getItem('ps_last_user');
      showOnboard('login', last ? `You were signed out of @${last}. Log in again, or if PeekaSnap says the account doesn't exist, sign up again with the same username.` : 'You were signed out. Log in again.');
      if (last) $('#login-username').value = last;
      return;
    }
    bootTries = (bootTries || 0) + 1; toast(bootTries > 1 ? e.message : 'Connecting to PeekaSnap…'); // e.g. server waking up
    if (bootTries < 8) setTimeout(boot, 3000); return;
  }
  if (S.user.needsPassword) return showOnboard('setpw'); // accounts from before passwords must set one
  $('#onboard').classList.add('hidden'); $('#app').classList.remove('hidden');
  renderMe();
  connectSocket();
  if (!S.groups.find(g => g.id === S.groupId)) S.groupId = S.groups[0]?.id || null;
  await Promise.all([loadGroup(), refreshFriends(), refreshChats(), refreshInbox(), refreshStories()]);
  setView(location.hash.slice(1) || 'camera');
  startWatch(); ensurePush();
  setTimeout(maybeShowInstallCard, 2500);
}
function showOnboard(mode = 'signup', note = '') {
  $('#auth-note').textContent = note; $('#auth-note').classList.toggle('hidden', !note || mode === 'setpw');
  $('#login-to-signup').classList.add('hidden');
  $('#onboard').classList.remove('hidden'); $('#app').classList.add('hidden');
  ['signup', 'login', 'setpw'].forEach(m => $('#' + m + '-form').classList.toggle('hidden', m !== mode));
  $('.auth-tabs').classList.toggle('hidden', mode === 'setpw');
  $('#tab-signup').classList.toggle('on', mode === 'signup'); $('#tab-login').classList.toggle('on', mode === 'login');
  if (mode === 'setpw') $('#setpw-user').textContent = '@' + S.user.username;
  setTimeout(() => $(mode === 'signup' ? '#signup-name' : mode === 'login' ? '#login-username' : '#setpw-password').focus(), 50);
}
$('#tab-signup').onclick = () => showOnboard('signup');
$('#tab-login').onclick = () => showOnboard('login');
// "No account with that username": jump to Sign up with the username (and password) already filled in
$('#login-to-signup').onclick = () => {
  const u = $('#login-username').value.trim().toLowerCase().replace(/^@/, ''), pw = $('#login-password').value;
  showOnboard('signup');
  const su = $('#signup-username'); su.value = u; su.dataset.touched = 1; $('#signup-password').value = pw;
  setTimeout(() => $('#signup-name').focus(), 60);
};
async function afterAuth(token) {
  S.token = token; localStorage.setItem('ps_token', token); if (S.socket) S.socket.auth.token = token;
  const q = new URLSearchParams(location.search);
  if (q.get('join')) { try { const j = await api('/api/groups/join', { body: { code: q.get('join') } }); S.groupId = j.group.id; localStorage.setItem('ps_group', S.groupId); } catch (_) {} }
  if (q.get('add')) { try { await api('/api/friends/request', { body: { username: q.get('add') } }); } catch (_) {} }
  boot();
}
$('#signup-name').oninput = e => { const u = $('#signup-username'); if (!u.dataset.touched) u.value = e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20); };
$('#signup-username').oninput = e => { e.target.dataset.touched = 1; e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''); };
// auth forms: our own validation (same on iOS Safari), visible red errors, a loading state; Enter/Go submits the form
function formErr(id, msg) { const el = $('#' + id); if (!el) return; el.textContent = msg || ''; el.classList.toggle('show', !!msg); if (msg) navigator.vibrate?.(40); }
async function runAuthForm(form, errId, validate, action) {
  const btn = form.querySelector('button[type=submit]');
  if (btn.disabled) return;
  formErr(errId, '');
  const problem = validate(); if (problem) { formErr(errId, problem.msg); problem.el?.classList.add('bad'); problem.el?.focus(); return; }
  const label = btn.textContent; btn.disabled = true; btn.classList.add('loading'); btn.textContent = 'One sec…';
  const slow = setTimeout(() => { btn.textContent = 'Waking up the server…'; }, 4000); // free hosting sleeps when idle
  try { await action(); }
  catch (err) { formErr(errId, err.message || 'Something went wrong. Try again.'); }
  finally { clearTimeout(slow); btn.disabled = false; btn.classList.remove('loading'); btn.textContent = label; }
}
$$('.onboard-form input, #password-form input').forEach(i => i.addEventListener('input', () => { i.classList.remove('bad'); const err = i.closest('form').querySelector('.form-err'); if (err) formErr(err.id, ''); }));
const USER_RE = /^[a-z0-9_.]{3,20}$/;
$('#signup-form').onsubmit = e => {
  e.preventDefault();
  const name = $('#signup-name'), user = $('#signup-username'), pw = $('#signup-password');
  runAuthForm(e.target, 'signup-err', () =>
    name.value.trim().length < 2 ? { el: name, msg: 'Pick a display name with at least 2 characters.' }
    : !USER_RE.test(user.value) ? { el: user, msg: 'Usernames are 3-20 letters, numbers, _ or .' }
    : pw.value.length < 6 ? { el: pw, msg: 'Password must be at least 6 characters.' } : null,
  async () => {
    const r = await api('/api/signup', { body: { name: name.value.trim(), username: user.value, password: pw.value } });
    pw.value = ''; localStorage.setItem('ps_last_user', r.user.username); await afterAuth(r.token);
  });
};
$('#login-form').onsubmit = e => {
  e.preventDefault();
  const user = $('#login-username'), pw = $('#login-password');
  runAuthForm(e.target, 'login-err', () =>
    !user.value.trim() ? { el: user, msg: 'Enter your username.' } : !pw.value ? { el: pw, msg: 'Enter your password.' } : null,
  async () => {
    $('#login-to-signup').classList.add('hidden');
    let r;
    try { r = await api('/api/login', { body: { username: user.value, password: pw.value } }); }
    catch (err) {
      if (err.data?.noAccount) { $('#login-to-signup-user').textContent = '@' + err.data.username; $('#login-to-signup').classList.remove('hidden'); user.classList.add('bad'); }
      throw err;
    }
    pw.value = ''; localStorage.setItem('ps_last_user', r.user.username); await afterAuth(r.token);
  });
};
$('#setpw-form').onsubmit = e => {
  e.preventDefault();
  const pw = $('#setpw-password'), pw2 = $('#setpw-confirm');
  runAuthForm(e.target, 'setpw-err', () =>
    pw.value.length < 6 ? { el: pw, msg: 'Password must be at least 6 characters.' } : pw.value !== pw2.value ? { el: pw2, msg: "Passwords don't match." } : null,
  async () => {
    const r = await api('/api/me/password', { body: { password: pw.value } });
    pw.value = pw2.value = ''; toast('Password saved 🔒', 'y'); await afterAuth(r.token);
  });
};
$('#setpw-logout').onclick = () => { localStorage.removeItem('ps_token'); S.token = null; showOnboard('login'); };
function renderMe() { setAvatar($('#me-btn'), S.user); }

function connectSocket() {
  if (S.socket) return;
  const s = S.socket = io({ auth: { token: S.token } });
  s.onAny((ev, ...args) => args.forEach(decorate)); // runs before the handlers below, so names/nicknames are resolved
  s.on('connect', () => { loadGroup(); refreshChats(); refreshInbox(); });
  s.on('nicknames', d => { S.nicks = d.nicknames || {}; reloadPeople(); });
  s.on('profile', d => { if (d.user.id === S.user.id) { Object.assign(S.user, { name: d.user.realName, avatar: d.user.avatar }); renderMe(); renderProfile(); } else reloadPeople(); });
  s.on('message', m => {
    if (S.thread && m.chatId === S.thread.chatId) {
      if (!S.threadMsgs.some(x => x.id === m.id)) S.threadMsgs.push(m);
      if (m.type === 'snap' && !m.snap) return openThread(S.thread.chatId, true); // group snaps need per-viewer state
      renderThread(); if (m.userId !== S.user.id) markThreadRead();
    }
    if (m.groupId && m.groupId === S.groupId && m.chatId === S.groupId) { S.messages.push(m); }
    if (m.userId && m.userId !== S.user.id) {
      if ((!S.thread || S.thread.chatId !== m.chatId) && !String(m.chatId).startsWith('hunt_')) { $('#chat-dot').classList.remove('hidden'); if (m.type === 'snap') sonar('pop'); }
      if (m.type === 'snap') refreshInbox();
    }
    H.message?.forEach(f => f(m));
    debounceChats();
  });
  s.on('message-deleted', d => {
    if (S.thread?.chatId === d.chatId) { S.threadMsgs = S.threadMsgs.filter(x => x.id !== d.id); renderThread(); }
    S.messages = S.messages.filter(x => x.id !== d.id); if (d.forEveryone) refreshInbox(); debounceChats();
  });
  s.on('chat-deleted', d => { if (S.thread?.chatId === d.chatId) closeThread(); else debounceChats(); });
  s.on('typing', d => { if (S.thread?.chatId === d.chatId) showTyping(d.user); });
  s.on('read', d => { if (S.thread?.chatId === d.chatId) { S.threadReads[d.userId] = d.at; renderThread(); } debounceChats(); });
  s.on('snap-opened', d => { toast(`${d.by.name} ${d.replay ? 'replayed' : 'opened'} your Peak 👀`); debounceChats(); });
  s.on('snap-state', d => { if (S.thread?.chatId === d.chatId) openThread(d.chatId, true); debounceChats(); });
  s.on('friends', d => {
    refreshFriends(); refreshChats();
    if (d.type === 'removed') { refreshStories(); if (S.thread?.type === 'dm') openThread(S.thread.chatId, true); }
    if (d.type === 'request') { toast(`👋 ${d.user.name} added you!`, 'y'); notify('👋 Friend request', `${d.user.name} added you`); }
    if (d.type === 'accepted') toast(`🤝 You and ${d.user.name} are friends`, 'y');
  });
  s.on('story', () => { refreshStories(); $('#story-dot').classList.remove('hidden'); });
  s.on('friend-loc', d => updateFriendMarker(d));
  H.socket.forEach(f => f(s));
}
let chatsT; function debounceChats() { clearTimeout(chatsT); chatsT = setTimeout(() => { refreshChats(); refreshInbox(); }, 300); }

async function loadGroup() {
  if (!S.groupId) { S.group = null; S.hides = []; S.messages = []; S.leaderboard = []; H.groupLoaded.forEach(f => f()); return; }
  try {
    const r = await api('/api/groups/' + S.groupId);
    S.group = r.group; S.hides = r.hides; S.messages = r.messages; S.leaderboard = r.leaderboard;
    localStorage.setItem('ps_group', S.groupId);
  } catch (e) { S.groupId = null; S.group = null; }
  H.groupLoaded.forEach(f => f());
}
async function refreshMe() { const me = await api('/api/me'); S.groups = me.groups; S.socket?.emit('refresh-groups'); }

// ---------- views ----------
const VIEWS = ['map', 'chat', 'camera', 'stories', 'play'];
const TITLES = { map: 'Peak Map', chat: 'Chat', camera: '', stories: 'Stories', play: 'Play' };
function setView(v) {
  if (!VIEWS.includes(v)) v = 'camera';
  S.view = v; history.replaceState(null, '', '#' + v);
  VIEWS.forEach(x => $('#view-' + x).classList.toggle('hidden', x !== v));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#app').dataset.view = v;
  $('#top-title').textContent = TITLES[v];
  $('#cam-flip').classList.toggle('hidden', v !== 'camera');
  if (v === 'camera') startCamera(); else stopCamera();
  if (v === 'map') initMap();
  if (v === 'chat') { $('#chat-dot').classList.add('hidden'); refreshChats(); }
  if (v === 'stories') { $('#story-dot').classList.add('hidden'); refreshStories(); }
  H.view.forEach(f => f(v));
}
$$('.nav-btn').forEach(b => b.onclick = () => setView(b.dataset.view));

// ---------- camera ----------
// iPhone notes: iOS ends/mutes the camera track whenever the app goes to the background, the native camera opens
// (file inputs with capture), or a call grabs the camera; autoplay can be refused in Home Screen mode; only one
// camera can be open at a time. So: every start gets a generation number (late results are stopped, never leaked),
// the old stream is always stopped before a new one is requested, play() is awaited, the camera restarts on
// return / on track end, and failures show a clear message with "Enable camera" + "Use iPhone camera" buttons.
let stream = null, facing = localStorage.getItem('ps_facing') === 'user' ? 'user' : 'environment', camGen = 0, camMirror = false, camPending = null;
const camVideo = () => $('#cam-video');
const anyOverlayOpen = () => $$('.overlay').some(o => !o.classList.contains('hidden'));
const camWanted = () => S.view === 'camera' && !$('#app').classList.contains('hidden') && !anyOverlayOpen() && document.visibilityState !== 'hidden' && !(typeof C !== 'undefined' && C.call);
const camLive = () => !!stream && stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
function camShow(state, msg = '') { // state: live | starting | tap | error
  const fb = $('#cam-fallback'); $('#view-camera').dataset.cam = state;
  fb.classList.toggle('hidden', state === 'live' || state === 'starting');
  $('#cam-fb-msg').textContent = msg || 'Tap the shutter to take a Peak';
  $('#cam-enable').classList.toggle('hidden', !(state === 'tap' || state === 'error'));
  $('#cam-enable').textContent = state === 'tap' ? 'Tap to start camera' : 'Enable camera';
  $('#cam-native').classList.toggle('hidden', state !== 'error');
}
function camError(e) {
  const n = e?.name || e;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (n === 'NotAllowedError' || n === 'SecurityError') return camShow('error', ios
    ? 'PeekaSnap needs camera access. Tap Enable camera and choose Allow. No prompt? iPhone Settings → Apps → Safari → Camera → Ask, then try again.'
    : 'PeekaSnap needs camera access. Tap Enable camera and allow it (or allow the camera in your browser’s site settings).');
  if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return camShow('error', 'Your camera is busy (a call or another app is using it). Close it, then tap Enable camera.');
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return camShow('error', 'No camera found on this device. You can still take a photo with your phone’s camera app.');
  if (n === 'unsupported') return camShow('error', 'This browser can’t show a live camera. You can still take a photo with your phone’s camera.');
  camShow('error', n === 'stuck' ? 'The camera preview stayed black. Tap Enable camera to try again.' : 'The camera didn’t start. Tap Enable camera to try again.');
}
async function camPlay(v) {
  try { await v.play(); } catch (_) { /* autoplay refused (e.g. iOS Low Power Mode): needs a tap */ }
  if (v.paused) return camShow('tap', 'Camera is ready — tap to start it.');
  if (!v.videoWidth) await new Promise(r => { const t = setTimeout(r, 1500); v.addEventListener('loadedmetadata', () => { clearTimeout(t); r(); }, { once: true }); });
  camShow('live');
}
function startCamera() {
  if (!camWanted()) return Promise.resolve();
  if (camLive()) { const v = camVideo(); return v.paused ? camPlay(v) : Promise.resolve(); }
  if (camPending && camPending.facing === facing && camPending.gen === camGen) return camPending.promise;
  if (!navigator.mediaDevices?.getUserMedia) { camError('unsupported'); return Promise.resolve(); }
  stopCamera(); // iOS: only one camera at a time, release the old one first
  const gen = ++camGen, want = facing;
  camShow('starting');
  const promise = (async () => {
    let s;
    try {
      try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
      catch (e) { if (e.name !== 'OverconstrainedError') throw e; s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
    } catch (e) { if (gen === camGen) camError(e); return; }
    finally { if (camPending?.gen === gen) camPending = null; }
    if (gen !== camGen || !camWanted()) { s.getTracks().forEach(t => t.stop()); return; } // superseded (flip / left the tab / call)
    stream = s;
    const tr = s.getVideoTracks()[0];
    const real = tr.getSettings?.().facingMode; camMirror = real ? real === 'user' : want === 'user';
    tr.addEventListener('ended', () => { if (stream === s) { stream = null; startCamera(); } }); // iOS: camera taken away
    tr.addEventListener('mute', () => setTimeout(() => { if (stream === s && tr.muted && camWanted()) { stopCamera(); startCamera(); } }, 1500));
    const v = freshVideo(); v.srcObject = s; // brand-new <video> each time: iOS can keep a re-used one black
    v.classList.toggle('mirror', camMirror);
    camStartedAt = Date.now();
    await camPlay(v);
  })();
  camPending = { gen, facing: want, promise };
  return promise;
}
// A fresh <video> for every stream. Re-using one whose old stream was stopped is the classic iOS
// "camera works the first time, black the second time" bug.
function freshVideo() {
  const old = camVideo(), v = document.createElement('video');
  v.id = 'cam-video'; v.className = old.className;
  for (const a of ['autoplay', 'playsinline', 'muted']) v.setAttribute(a, '');
  v.muted = true; v.playsInline = true; v.autoplay = true;
  try { old.pause(); old.srcObject = null; } catch (_) {}
  old.replaceWith(v); return v;
}
// Watchdog: if the preview is still blank (no frames) or the track died without telling us, start over.
let camStartedAt = 0, camRetries = 0;
setInterval(() => {
  if (!camWanted() || !stream || camPending || Date.now() - camStartedAt < 1500) return;
  const v = camVideo(), tr = stream.getVideoTracks()[0];
  const dead = !tr || tr.readyState === 'ended', blank = !v.videoWidth || v.readyState < 2 || v.srcObject !== stream;
  if ($('#view-camera').dataset.cam === 'tap' && !dead) return; // waiting for the user's tap
  if (dead || blank || (v.paused && !dead)) {
    if (camRetries++ >= 3) { stopCamera(); camRetries = 0; return camError('stuck'); }
    stopCamera(); startCamera();
  } else camRetries = 0;
}, 700);
function stopCamera() {
  camGen++; camPending = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  const v = camVideo(); if (v.srcObject) { v.pause(); v.srcObject = null; } // frees the camera (green dot) on iOS
}
$('#cam-flip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; localStorage.setItem('ps_facing', facing); stopCamera(); startCamera(); };
$('#cam-enable').onclick = e => { e.stopPropagation(); const v = camVideo(); if (camLive() && v.paused) return camPlay(v); stopCamera(); startCamera(); }; // inside a tap, so iOS can show its prompt
$('#cam-native').onclick = e => { e.stopPropagation(); $('#file-capture').click(); };
$('#cam-fallback').onclick = () => { if ($('#view-camera').dataset.cam === 'tap') $('#cam-enable').click(); };
// restart when coming back to the app / closing a native picker; release it when the app is hidden
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopCamera(); else if (camWanted()) startCamera(); });
window.addEventListener('pageshow', () => { if (camWanted()) startCamera(); });
window.addEventListener('focus', () => { if (camWanted() && !camLive()) startCamera(); });
document.addEventListener('click', e => { if (e.target.matches?.('input[type=file][capture]')) stopCamera(); }, true); // native camera needs it free
document.addEventListener('change', e => { if (e.target.matches?.('input[type=file]')) setTimeout(() => camWanted() && startCamera(), 300); }, true);
document.addEventListener('cancel', e => { if (e.target.matches?.('input[type=file]')) setTimeout(() => camWanted() && startCamera(), 300); }, true);
$('#shutter').onclick = () => {
  const v = camVideo();
  if (camLive() && v.paused) return camPlay(v); // first tap after autoplay was refused just starts the preview
  if (!camLive() || !v.videoWidth || v.readyState < 2) return $('#file-capture').click(); // no live preview: use the phone's camera
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d'); if (camMirror) { g.translate(c.width, 0); g.scale(-1, 1); } // selfie saved the way it looked
  g.drawImage(v, 0, 0, c.width, c.height);
  $('#view-camera').classList.add('flash'); setTimeout(() => $('#view-camera').classList.remove('flash'), 180);
  c.toBlob(b => b ? openEditor(b) : toast("Couldn't take the photo, try again"), 'image/jpeg', 0.9);
};
$('#cam-upload').onclick = () => $('#file-pick').click();
['#file-capture', '#file-pick'].forEach(s => $(s).onchange = e => { const f = e.target.files[0]; if (f) openEditor(f); e.target.value = ''; });
$('#cam-inbox').onclick = () => { if (S.inbox.length) openSnap(S.inbox[0].id); else toast('No new Peaks'); };
$('#hide-mode-x').onclick = () => setHideMode(false);
function setHideMode(on) { S.hideMode = on; $('#hide-mode-pill').classList.toggle('hidden', !on); }
async function shrink(blob, max = 1600) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && blob.size < 1.5e6) return blob;
    const c = document.createElement('canvas'); c.width = bmp.width * k; c.height = bmp.height * k;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  } catch (_) { return blob; }
}

// ---------- snap editor: caption, drawing, stickers, timer ----------
const ED = { blob: null, strokes: [], drawing: false, pen: false, color: '#FF2D46', timer: 5, caption: null, stickers: [] };
const COLORS = ['#FF2D46', '#FFFFFF', '#000000', '#FFD400', '#22D37F', '#4FB7FF', '#B15CFF', '#FF8A00'];
const STICKERS = ['😂', '🔥', '👀', '🫣', '💀', '😎', '❤️', '🏃', '🎯', '📍', '🦆', '👻', '💯', '🙈', '⭐', '🎉'];
const TIMERS = [1, 2, 3, 5, 7, 10, 0];
function openEditor(blob) {
  ED.blob = blob; ED.strokes = []; ED.caption = null; ED.stickers = []; ED.pen = false;
  $('#ed-img').src = URL.createObjectURL(blob);
  $('#ed-layer').innerHTML = ''; $('#ed-colors').classList.add('hidden'); $('#ed-stickers').classList.add('hidden');
  $('#ed-undo').classList.add('hidden'); $('#ed-pen').classList.remove('on');
  $('#ed-hide').classList.toggle('pulse', S.hideMode);
  $('#ed-timer-val').textContent = ED.timer || '∞';
  stopCamera(); $('#editor').classList.remove('hidden');
  requestAnimationFrame(sizeDrawCanvas);
}
function closeEditor() { $('#editor').classList.add('hidden'); if (S.view === 'camera') startCamera(); }
$('#ed-close').onclick = closeEditor;
function sizeDrawCanvas() {
  const st = $('#ed-stage'), c = $('#ed-draw'), r = st.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr; redraw();
}
function redraw() {
  const c = $('#ed-draw'), g = c.getContext('2d'), dpr = devicePixelRatio || 1;
  g.clearRect(0, 0, c.width, c.height); g.lineCap = g.lineJoin = 'round';
  for (const s of ED.strokes) { g.strokeStyle = s.color; g.lineWidth = 7 * dpr; g.beginPath(); s.pts.forEach(([x, y], i) => i ? g.lineTo(x * c.width, y * c.height) : g.moveTo(x * c.width, y * c.height)); g.stroke(); }
}
$('#ed-colors').innerHTML = COLORS.map(c => `<button data-c="${c}" style="background:${c}"></button>`).join('');
$$('#ed-colors button').forEach(b => b.onclick = () => { ED.color = b.dataset.c; $$('#ed-colors button').forEach(x => x.classList.toggle('on', x === b)); });
$('#ed-pen').onclick = () => { ED.pen = !ED.pen; $('#ed-pen').classList.toggle('on', ED.pen); $('#ed-colors').classList.toggle('hidden', !ED.pen); $('#ed-stickers').classList.add('hidden'); };
$('#ed-undo').onclick = () => { ED.strokes.pop(); redraw(); $('#ed-undo').classList.toggle('hidden', !ED.strokes.length); };
const dc = $('#ed-draw');
const relPt = e => { const r = dc.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
dc.addEventListener('pointerdown', e => { if (!ED.pen) return; ED.drawing = true; ED.strokes.push({ color: ED.color, pts: [relPt(e)] }); dc.setPointerCapture(e.pointerId); });
dc.addEventListener('pointermove', e => { if (!ED.drawing) return; ED.strokes[ED.strokes.length - 1].pts.push(relPt(e)); redraw(); });
dc.addEventListener('pointerup', () => { if (ED.drawing) { ED.drawing = false; $('#ed-undo').classList.remove('hidden'); } });
function makeDraggable(el, item) {
  let sy, sx, oy, ox, moved;
  el.addEventListener('pointerdown', e => { if (ED.pen) return; e.stopPropagation(); sy = e.clientY; sx = e.clientX; oy = item.y; ox = item.x; moved = false; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (sy == null) return; const r = $('#ed-stage').getBoundingClientRect();
    item.y = Math.min(0.95, Math.max(0.05, oy + (e.clientY - sy) / r.height)); if (item.x != null) item.x = Math.min(0.95, Math.max(0.05, ox + (e.clientX - sx) / r.width));
    if (Math.abs(e.clientY - sy) + Math.abs(e.clientX - sx) > 4) moved = true; place(el, item);
  });
  el.addEventListener('pointerup', () => { sy = null; if (!moved) el.dispatchEvent(new Event('tapped')); });
}
function place(el, item) { el.style.top = item.y * 100 + '%'; if (item.x != null) el.style.left = item.x * 100 + '%'; }
$('#ed-text').onclick = () => {
  if (ED.caption) { ED.caption.el.querySelector('input').focus(); return; }
  const item = ED.caption = { y: 0.62, text: '' };
  const el = item.el = document.createElement('div'); el.className = 'caption-bar';
  el.innerHTML = '<input maxlength="80" placeholder="" enterkeyhint="done">';
  const inp = el.querySelector('input');
  inp.oninput = () => (item.text = inp.value);
  inp.onblur = () => { if (!inp.value.trim()) { el.remove(); ED.caption = null; } };
  inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
  el.addEventListener('tapped', () => inp.focus());
  makeDraggable(el, item); place(el, item); $('#ed-layer').appendChild(el); inp.focus();
};
$('#ed-stickers').innerHTML = STICKERS.map(s => `<button>${s}</button>`).join('');
$('#ed-sticker').onclick = () => { $('#ed-stickers').classList.toggle('hidden'); ED.pen = false; $('#ed-pen').classList.remove('on'); $('#ed-colors').classList.add('hidden'); };
$$('#ed-stickers button').forEach(b => b.onclick = () => {
  const item = { e: b.textContent, x: 0.5, y: 0.4 }; ED.stickers.push(item);
  const el = item.el = document.createElement('div'); el.className = 'sticker'; el.textContent = item.e;
  el.addEventListener('tapped', () => { el.remove(); ED.stickers = ED.stickers.filter(s => s !== item); }); // tap a sticker to remove it
  makeDraggable(el, item); place(el, item); $('#ed-layer').appendChild(el); $('#ed-stickers').classList.add('hidden');
});
$('#ed-timer').onclick = () => { ED.timer = TIMERS[(TIMERS.indexOf(ED.timer) + 1) % TIMERS.length]; $('#ed-timer-val').textContent = ED.timer || '∞'; toast(ED.timer ? `Peak shows for ${ED.timer}s` : 'No time limit'); };
// flatten photo + drawing + caption + stickers (what you see on screen, cropped like the stage) into one JPEG
async function composeSnap() {
  const st = $('#ed-stage').getBoundingClientRect();
  const bmp = await createImageBitmap(ED.blob);
  const W = Math.min(1080, Math.round(st.width * 3)), Hh = Math.round(W * st.height / st.width);
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, Hh);
  const k = Math.max(W / bmp.width, Hh / bmp.height); // object-fit: cover
  g.drawImage(bmp, (W - bmp.width * k) / 2, (Hh - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  g.drawImage($('#ed-draw'), 0, 0, W, Hh);
  const u = W / st.width;
  if (ED.caption && ED.caption.text.trim()) {
    const bh = 44 * u, y = ED.caption.y * Hh;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, y - bh / 2, W, bh);
    g.fillStyle = '#fff'; g.font = `600 ${19 * u}px -apple-system, Roboto, Helvetica, Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(ED.caption.text, W / 2, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `${64 * u}px "Noto Color Emoji", "Apple Color Emoji", sans-serif`;
  ED.stickers.forEach(s => g.fillText(s.e, s.x * W, s.y * Hh));
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
}
// small thumbnail for chat history, Memories and profiles (~5 KB)
async function makeThumb(blob, w = 200) {
  try {
    const bmp = await createImageBitmap(blob), h = Math.round(w * bmp.height / bmp.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.7));
  } catch (_) { return null; }
}
$('#ed-story').onclick = async () => {
  const composed = await composeSnap(), th = await makeThumb(composed);
  const fd = new FormData(); fd.append('photo', composed, 'snap.jpg'); if (th) fd.append('thumb', th, 'thumb.jpg'); fd.append('story', '1'); fd.append('timer', ED.timer || 10);
  try { await api('/api/snaps', { body: fd }); toast('Added to My Story ✨', 'y'); closeEditor(); refreshStories(); } catch (e) { toast(e.message); }
};
$('#ed-hide').onclick = async () => {
  if (!S.group) { toast('Join or create a group first'); return openSheet('groups'); }
  const blob = await composeSnap(); $('#editor').classList.add('hidden'); setHideMode(false); openHideSheet(blob);
};
$('#ed-send').onclick = async () => { ED.composed = await composeSnap(); openSendSheet(); };

// ---------- send to ----------
const SEL = { to: new Set(), groups: new Set() };
function openSendSheet() {
  SEL.to.clear(); SEL.groups.clear(); $('#send-story').checked = false; $('#send-search').value = ''; $('#send-replay').checked = true;
  renderSendRows(); renderSendSummary(); $('#send-sheet').classList.remove('hidden');
}
function renderSendRows() {
  const q = $('#send-search').value.trim().toLowerCase().replace(/^@/, '');
  const fr = [...S.friends.friends].sort((a, b) => a.user.name.localeCompare(b.user.name)).filter(f => personMatch(q, f.user));
  const gr = S.groups.filter(g => matches(q, g.name));
  $('#send-groups-title').classList.toggle('hidden', !!q && !gr.length);
  $('#send-friends').innerHTML = fr.length ? fr.map(f => `<label class="send-row"><input type="checkbox" data-to="${f.user.id}">${avatarHtml(f.user)}<span class="grow"><b>${esc(f.user.name)}</b> ${f.streak ? `<span class="streak">🔥${f.streak}</span>` : ''}<br><small>@${esc(f.user.username)}${f.user.nick ? ' · ' + esc(f.user.realName) : ''}</small></span><i class="check"></i></label>`).join('')
    : q ? `<div class="empty dark">No friends match “${esc(q)}”</div>` : '<div class="empty dark">Add friends to send them Peaks. <button class="link-btn" id="send-add">Add friends</button></div>';
  $('#send-groups').innerHTML = gr.length ? gr.map(g => `<label class="send-row"><input type="checkbox" data-g="${g.id}"><span class="avatar ge">${esc(g.emoji)}</span><span class="grow"><b>${esc(g.name)}</b><br><small>${g.memberCount} members</small></span><i class="check"></i></label>`).join('') : '<div class="empty dark">No groups yet</div>';
  $$('#send-sheet input[data-to]').forEach(cb => cb.checked = SEL.to.has(cb.dataset.to));
  $$('#send-sheet input[data-g]').forEach(cb => cb.checked = SEL.groups.has(cb.dataset.g));
  $$('#send-sheet input[data-to], #send-sheet input[data-g]').forEach(cb => cb.onchange = () => {
    if (cb.dataset.to) cb.checked ? SEL.to.add(cb.dataset.to) : SEL.to.delete(cb.dataset.to);
    if (cb.dataset.g) cb.checked ? SEL.groups.add(cb.dataset.g) : SEL.groups.delete(cb.dataset.g);
    renderSendSummary();
  });
  $('#send-add')?.addEventListener('click', () => { closeSheets(); openFriends(); });
}
$('#send-search').oninput = renderSendRows;
function renderSendSummary() {
  const names = [...($('#send-story').checked ? ['My Story'] : []), ...[...SEL.groups].map(id => S.groups.find(g => g.id === id)?.name), ...[...SEL.to].map(id => S.friends.friends.find(f => f.user.id === id)?.user.name)];
  $('#send-summary').textContent = names.length ? names.join(', ') : 'Pick friends, groups or My Story';
  $('#send-go').disabled = !names.length;
}
$('#send-story').onchange = renderSendSummary;
$('#send-go').onclick = async () => {
  const fd = new FormData(); fd.append('photo', ED.composed, 'snap.jpg'); fd.append('timer', ED.timer);
  const th = await makeThumb(ED.composed); if (th) fd.append('thumb', th, 'thumb.jpg');
  fd.append('replay', $('#send-replay').checked ? '1' : '0');
  fd.append('to', JSON.stringify([...SEL.to])); fd.append('groups', JSON.stringify([...SEL.groups])); if ($('#send-story').checked) fd.append('story', '1');
  $('#send-go').disabled = true;
  try { await api('/api/snaps', { body: fd }); closeSheets(); closeEditor(); toast('Sent! ➤', 'y'); sonar('pop'); refreshChats(); refreshStories(); }
  catch (e) { toast(e.message); $('#send-go').disabled = false; }
};

// ---------- snap viewer ----------
let snapTimer = null;
async function openSnap(id, replay = false) {
  try {
    const r = await api(`/api/snaps/${id}/${replay ? 'replay' : 'open'}`, { body: {} });
    $('#sv-snap-img').src = r.image; $('#snap-from').innerHTML = `${avatarHtml(r.from)} <b>${esc(r.from.name)}</b>${replay ? ' <small>replay</small>' : ''}`;
    stopCamera(); $('#snap-viewer').classList.remove('hidden');
    clearInterval(snapTimer);
    const ring = $('#snap-ring'); ring.classList.toggle('hidden', !r.timer);
    if (r.timer) {
      const end = Date.now() + r.timer * 1000; ring.style.setProperty('--dur', r.timer + 's'); ring.classList.remove('run'); void ring.offsetWidth; ring.classList.add('run');
      const tickFn = () => { const left = end - Date.now(); $('#snap-secs').textContent = Math.max(0, Math.ceil(left / 1000)); if (left <= 0) closeSnap(); };
      tickFn(); snapTimer = setInterval(tickFn, 200);
    }
    $('#snap-hint').textContent = r.canReplay ? 'Tap to close · you can replay once' : 'Tap to close';
    S.inbox = S.inbox.filter(s => s.id !== id); renderInboxCount();
  } catch (e) {
    if (e.data?.canReplay) return openSnap(id, true);
    toast(e.message); refreshInbox();
  }
}
// Re-open a Peak from chat history / a profile (no timer)
async function openSnapHistory(id) {
  try {
    const r = await api(`/api/snaps/${id}/view`, { body: {} });
    $('#sv-snap-img').src = r.image; $('#snap-from').innerHTML = `${avatarHtml(r.from)} <b>${esc(r.from.name)}</b> <small>${new Date(r.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${fmtTime(r.createdAt)}</small>`;
    stopCamera(); clearInterval(snapTimer); $('#snap-ring').classList.add('hidden');
    $('#snap-hint').textContent = 'Tap to close · saved in your chat';
    $('#snap-viewer').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}
function closeSnap() {
  clearInterval(snapTimer); $('#snap-viewer').classList.add('hidden'); $('#sv-snap-img').src = '';
  debounceChats(); if (S.thread) openThread(S.thread.chatId, true);
  if (S.view === 'camera' && !anyOverlayOpen()) startCamera();
}
$('#snap-viewer').onclick = closeSnap;
async function refreshInbox() { if (!S.token) return; try { S.inbox = (await api('/api/snaps/inbox')).snaps; } catch (_) {} renderInboxCount(); }
function renderInboxCount() { const c = $('#inbox-count'); c.textContent = S.inbox.length; c.classList.toggle('hidden', !S.inbox.length); }

// ---------- chat list ----------
async function refreshChats() { if (!S.token) return; try { S.chats = (await api('/api/chats')).chats; } catch (_) {} renderChatList(); }
function statusLine(c) {
  const newSnaps = S.inbox.filter(s => (s.via ? s.via === c.chatId : c.user && s.from.id === c.user.id));
  if (newSnaps.length) return `<span class="st snap-new">■</span> <b class="red">New Peak${newSnaps.length > 1 ? 's' : ''}</b>`;
  const m = c.last; if (!m) return '<span class="muted">Tap to chat</span>';
  const mine = m.userId === S.user.id, t = ` · ${ago(m.createdAt)}`;
  if (m.type === 'snap') {
    if (mine) return `<span class="st snap-sent">➤</span> ${m.snap?.state === 'opened' ? 'Opened' : 'Delivered'}${t}`;
    return `<span class="st snap-open">□</span> Received${t}`;
  }
  if (m.type === 'call') return `<span class="st ${m.call?.status === 'ended' ? 'chat-sent' : 'snap-new'}">${m.call?.kind === 'video' ? '📹' : '📞'}</span> ${esc(m.text)}${t}`;
  if (!m.userId) return `<span class="muted">${esc(m.text).slice(0, 48)}</span>${t}`;
  if (c.unread) return `<span class="st chat-new">■</span> <b class="blue">New Chat</b>${t}`;
  if (mine) return `<span class="st chat-sent">➤</span> ${c.type === 'dm' && c.theirRead >= m.createdAt ? 'Opened' : 'Delivered'}${t}`;
  return `<span class="st chat-open">□</span> ${esc((m.text || '📷 Photo').slice(0, 40))}${t}`;
}
function renderChatList() {
  const el = $('#chat-list');
  if (!S.chats.length) { el.innerHTML = '<div class="empty">No chats yet. <button class="link-btn" id="cl-add">Add friends</button> or create a group.</div>'; $('#cl-add').onclick = openFriends; return; }
  const q = $('#chat-search').value.trim().toLowerCase().replace(/^@/, '');
  const list = S.chats.filter(c => c.type === 'dm' ? personMatch(q, c.user) : matches(q, c.title));
  if (!list.length) { el.innerHTML = `<div class="empty">No chats match “${esc(q)}”</div>`; return; }
  el.innerHTML = list.map(c => `<div class="chat-row" data-chat="${c.chatId}">
    ${c.type === 'dm' ? avatarHtml(c.user) : `<span class="avatar ge">${esc(c.group.emoji)}</span>`}
    <div class="grow"><b>${esc(c.type === 'dm' ? c.user.name : c.title)}</b>${c.type === 'dm' ? ` <small class="handle">@${esc(c.user.username)}</small>` : ''}<div class="cl-status">${statusLine(c)}</div></div>
    ${c.streak ? `<span class="streak">🔥${c.streak}</span>` : ''}
    <button class="cl-cam" data-snapto="${c.chatId}" title="Peak back">📷</button></div>`).join('');
  $$('.chat-row').forEach(r => {
    const c = S.chats.find(x => x.chatId === r.dataset.chat);
    onLongPress(r, () => deleteChatFlow(c));
    onSwipeLeft(r, () => deleteChatFlow(c));
  });
  $$('.chat-row').forEach(r => r.onclick = e => {
    if (r.dataset.lp) { delete r.dataset.lp; return; }
    if (e.target.closest('.cl-cam')) { setView('camera'); return; }
    const c = S.chats.find(x => x.chatId === r.dataset.chat);
    const snap = S.inbox.find(s => (s.via ? s.via === c.chatId : c.user && s.from.id === c.user.id));
    if (snap) openSnap(snap.id); else openThread(c.chatId);
  });
}
$('#new-group-btn').onclick = () => openSheet('groups');
$('#chat-search').oninput = renderChatList;

// ---------- chat thread ----------
async function openThread(chatId, silent) {
  try {
    const r = await api('/api/chats/' + encodeURIComponent(chatId));
    S.thread = r.chat; S.threadMsgs = r.messages; S.threadReads = r.reads;
    if (!silent || $('#thread').classList.contains('hidden')) { stopCamera(); $('#thread').classList.remove('hidden'); }
    const c = r.chat;
    const t = $('#thread-av');
    t.classList.remove('has-pic');
    if (c.type === 'dm') { setAvatar(t, c.other); $('#thread-title').textContent = c.other.name; $('#thread-sub').textContent = `@${c.other.username}${c.other.nick ? ` · ${c.other.realName}` : ''}${c.streak ? ` · 🔥${c.streak}` : ''}`; }
    else { const g = S.groups.find(x => x.id === c.groupId) || {}; t.textContent = g.emoji || '👥'; t.style.background = '#2a2a2e'; $('#thread-title').textContent = g.name || 'Group'; $('#thread-sub').textContent = `${c.members.length} members${g.code ? ' · code ' + g.code : ''}`; }
    $('#thread-call').classList.toggle('hidden', c.type !== 'dm' || c.canSend === false);
    $('#thread-video').classList.toggle('hidden', c.type !== 'dm' || c.canSend === false);
    $('#thread-form').classList.toggle('hidden', c.canSend === false);
    $('#thread-locked').classList.toggle('hidden', c.canSend !== false);
    renderThread(); markThreadRead();
  } catch (e) { toast(e.message); }
}
function markThreadRead() { if (S.thread) api(`/api/chats/${encodeURIComponent(S.thread.chatId)}/read`, { body: {} }).then(debounceChats).catch(() => {}); }
function closeThread() { S.thread = null; $('#thread').classList.add('hidden'); refreshChats(); if (S.view === 'camera') startCamera(); }
$('#thread-back').onclick = closeThread;
$('#thread-call').onclick = () => S.thread?.other && startCall(S.thread.other, 'audio');
$('#thread-video').onclick = () => S.thread?.other && startCall(S.thread.other, 'video');
$$('#thread-av, #thread-title').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); if (S.thread?.type === 'dm') openPerson(S.thread.other.id); }));
$('#thread-info').onclick = () => {
  const c = S.thread; if (!c) return;
  const g = S.groups.find(x => x.id === c.groupId);
  const acts = [{ label: '🗑 Delete conversation', danger: true, fn: () => deleteChatFlow({ chatId: c.chatId, type: c.type, title: c.type === 'dm' ? c.other.name : g?.name, group: g }) }];
  if (c.type === 'dm') acts.unshift({ label: c.other.nick ? '✏️ Edit Nickname' : '✏️ Set Nickname', fn: () => nicknameFlow(c.other) });
  if (c.type === 'dm' && c.canSend !== false) acts.push({ label: '🚫 Remove Friend', danger: true, fn: () => removeFriendFlow(c.other) });
  if (g) { acts.unshift({ label: '🔗 Share invite', fn: () => shareGroup(g) }); acts.push({ label: '🚪 Leave group', danger: true, fn: () => leaveGroupFlow(g) }); }
  askAction(c.type === 'dm' ? c.other.name : (g?.name || 'Chat'), '', acts);
};

// ---------- deleting chats & messages ----------
function onLongPress(el, cb, ms = 550) {
  let t = null, x0, y0;
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener('pointerdown', e => { if (e.button > 0) return; x0 = e.clientX; y0 = e.clientY; cancel(); t = setTimeout(() => { t = null; el.dataset.lp = '1'; navigator.vibrate?.(30); cb(); setTimeout(() => delete el.dataset.lp, 800); }, ms); });
  el.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => el.addEventListener(ev, cancel));
  el.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); el.dataset.lp = '1'; cb(); setTimeout(() => delete el.dataset.lp, 800); }); // right-click on desktop
}
function onSwipeLeft(el, cb) {
  let x0 = null, y0, dx = 0;
  el.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; dx = 0; el.style.transition = 'none'; });
  el.addEventListener('pointermove', e => {
    if (x0 == null) return; dx = Math.min(0, e.clientX - x0);
    if (Math.abs(e.clientY - y0) > 30 && dx > -20) { x0 = null; el.style.transform = ''; return; }
    el.style.transform = `translateX(${Math.max(dx, -110)}px)`; el.classList.toggle('swiping', dx < -20);
  });
  const end = () => { if (x0 == null) return; x0 = null; el.style.transition = ''; el.style.transform = ''; el.classList.remove('swiping'); if (dx < -70) { el.dataset.lp = '1'; cb(); setTimeout(() => delete el.dataset.lp, 800); } };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
function askAction(title, body, actions) {
  $('#ask-title').textContent = title; $('#ask-body').textContent = body || ''; $('#ask-body').classList.toggle('hidden', !body);
  $('#ask-actions').innerHTML = actions.map((a, i) => `<button class="${a.danger ? 'btn-red' : 'btn-glass dark'} wide" data-act="${i}">${esc(a.label)}</button>`).join('');
  return new Promise(res => {
    const done = v => { $('#ask-sheet').classList.add('hidden'); res(v); };
    $$('#ask-actions [data-act]').forEach(b => b.onclick = () => { done(true); actions[+b.dataset.act].fn?.(); });
    $('#ask-cancel').onclick = () => done(false);
    $('#ask-sheet').onclick = e => { if (e.target.id === 'ask-sheet') done(false); };
    $('#ask-sheet').classList.remove('hidden');
  });
}
function askConfirm(title, body, okLabel = 'Delete') {
  return new Promise(res => {
    askAction(title, body, [{ label: okLabel, danger: true, fn: () => res(true) }]).then(v => { if (!v) res(false); });
  });
}
async function deleteChatFlow(c) {
  if (!c) return;
  const name = (c.type === 'dm' && c.user?.name) || c.title || 'this chat';
  const ok = await askConfirm(`Delete conversation with ${name}?`, c.type === 'dm'
    ? `This clears the chat for you only. ${name} still keeps their copy. Unopened Peaks stay in your inbox.`
    : 'This clears the group chat for you only. It comes back to your list when someone sends something new. Leave the group to stop getting messages.', 'Delete conversation');
  if (!ok) return;
  try {
    await api('/api/chats/' + encodeURIComponent(c.chatId), { method: 'DELETE' });
    toast('Conversation deleted 🗑', 'y');
    if (S.thread?.chatId === c.chatId) closeThread(); else refreshChats();
  } catch (e) { toast(e.message); }
}
async function leaveGroupFlow(g) {
  if (!await askConfirm(`Leave ${g.name}?`, 'The group chat disappears from your list and you stop getting its messages and games.', 'Leave group')) return;
  try { await api(`/api/groups/${g.id}/leave`, { body: {} }); toast(`Left ${g.name}`, 'y'); closeThread(); await refreshMe(); if (S.groupId === g.id) { S.groupId = S.groups[0]?.id || null; localStorage.setItem('ps_group', S.groupId || ''); loadGroup(); } refreshChats(); }
  catch (e) { toast(e.message); }
}
async function deleteMsgFlow(m) {
  if (!m || !S.thread) return;
  const mine = m.userId === S.user.id && ['chat', 'snap'].includes(m.type || 'chat');
  const ok = await askConfirm(mine ? 'Unsend this message?' : 'Delete this message?', mine ? 'It will be deleted for everyone in this chat.' : 'It will be deleted for you only. Others still see it.', mine ? 'Delete for everyone' : 'Delete for me');
  if (!ok) return;
  try {
    await api(`/api/chats/${encodeURIComponent(S.thread.chatId)}/messages/${m.id}`, { method: 'DELETE' });
    S.threadMsgs = S.threadMsgs.filter(x => x.id !== m.id); renderThread(); debounceChats();
  } catch (e) { toast(e.message); }
}
function msgHtml(m) {
  if (m.type === 'system') return `<div class="sys">${esc(m.text)}</div>`;
  if (['hide', 'ping', 'found', 'move'].includes(m.type)) {
    const h = S.hides.find(x => x.id === m.hideId);
    const img = m.photo || h?.photo;
    const sub = m.type === 'hide' && m.firstPingAt ? `First ping at ${fmtTime(m.firstPingAt)} · tap to view` : fmtTime(m.createdAt);
    return `<button class="card ${m.type}" data-hide="${m.hideId}">${img ? `<img src="${img}" alt="">` : ''}<div class="grow" style="text-align:left"><div class="t">${esc(m.text)}</div><div class="s">${sub}</div></div></button>`;
  }
  if (m.type === 'hunt') return `<div class="card hunt-card"><div class="grow"><div class="t">${esc(m.text)}</div><div class="s">${fmtTime(m.createdAt)}</div></div></div>`;
  const me = m.userId === S.user.id, color = me ? 'var(--accent)' : m.user?.color || '#4FB7FF';
  let inner;
  if (m.type === 'call') {
    const c = m.call || {}, vid = c.kind === 'video', other = S.thread?.other;
    const missed = c.status !== 'ended', who = me ? 'You called' : '';
    return `<div class="call-log ${missed ? 'missed' : ''}"><span class="ci">${vid ? '📹' : '📞'}</span><div class="grow"><b>${esc(m.text)}</b><small>${who ? who + ' · ' : ''}${fmtTime(m.createdAt)}</small></div>${other && S.thread.canSend !== false ? `<button class="chip" data-callback="${vid ? 'video' : 'audio'}">Call back</button>` : ''}</div>`;
  }
  if (m.type === 'snap' && m.snap?.thumb) { // history entry: thumbnail you can tap to view again
    const st = m.snap.state;
    const label = me ? (st === 'opened' ? '➤ Opened' : st === 'some-opened' ? '➤ Opened by some' : '➤ Delivered') : '□ Opened';
    inner = `<button class="snap-hist ${me ? 'mine' : ''}" data-snapview="${m.snapId}"><img src="${m.snap.thumb}" alt=""><span><b>${label}</b><small>${me && !m.snap.allowReplay ? 'View-once · tap to view' : 'Tap to view again'}</small></span></button>`;
    return `<div class="msg ${me ? 'me' : ''}" style="color:${color}"><div class="who">${me ? 'Me' : esc(m.user?.name)}</div>${inner}</div>`;
  }
  if (m.type === 'snap') {
    const st = m.snap?.state || 'delivered';
    const label = me ? (st === 'opened' ? '➤ Opened' : st === 'some-opened' ? '➤ Opened by some' : '➤ Delivered') + (m.snap?.replays ? ` · replayed` : '')
      : st === 'new' ? '■ Tap to view Peak' : st === 'replayable' ? '↻ Tap to replay' : st === 'expired' ? '□ Expired' : '□ Opened';
    inner = `<button class="snap-bubble ${st} ${me ? 'mine' : ''}" data-snap="${m.snapId}" data-st="${st}" ${me ? 'disabled' : ''}>${label}</button>`;
  } else inner = `<div class="bubble">${esc(m.text)}${m.photo ? `<img class="chat-photo" src="${m.photo}" alt="">` : ''}</div>`;
  return `<div class="msg ${me ? 'me' : ''}" style="color:${color}"><div class="who">${me ? 'Me' : esc(m.user?.name)}</div>${inner}</div>`;
}
function renderThread() {
  const f = $('#thread-feed'), c = S.thread; if (!c) return;
  let html = S.threadMsgs.map(m => `<div class="mrow" data-mid="${m.id}">${msgHtml(m)}</div>`).join('') || '<div class="empty">Say hi 👋</div>';
  const lastMine = [...S.threadMsgs].reverse().find(m => m.userId === S.user.id && m.type === 'chat');
  if (lastMine && c.type === 'dm') html += `<div class="receipt">${(S.threadReads[c.other.id] || 0) >= lastMine.createdAt ? 'Opened ' + ago(S.threadReads[c.other.id]) : 'Delivered'}</div>`;
  f.innerHTML = html;
  $$('#thread-feed .mrow').forEach(r => onLongPress(r, () => deleteMsgFlow(S.threadMsgs.find(m => m.id === r.dataset.mid))));
  $$('#thread-feed [data-snap]').forEach(b => b.onclick = () => { if (b.closest('.mrow').dataset.lp) return; const st = b.dataset.st; if (st === 'new') openSnap(b.dataset.snap); else if (st === 'replayable') openSnap(b.dataset.snap, true); });
  $$('#thread-feed [data-snapview]').forEach(b => b.onclick = () => { if (!b.closest('.mrow').dataset.lp) openSnapHistory(b.dataset.snapview); });
  $$('#thread-feed [data-callback]').forEach(b => b.onclick = () => startCall(S.thread.other, b.dataset.callback));
  $$('#thread-feed [data-hide]').forEach(b => b.onclick = () => { if (!b.closest('.mrow').dataset.lp) openStory(b.dataset.hide); });
  f.scrollTop = f.scrollHeight;
}
let typingT, lastTypingSent = 0;
function showTyping(u) { $('#typing-who').textContent = `${u.name} is typing…`; $('#typing').classList.remove('hidden'); clearTimeout(typingT); typingT = setTimeout(() => $('#typing').classList.add('hidden'), 3000); }
$('#thread-input').oninput = () => { if (S.thread && Date.now() - lastTypingSent > 1500) { lastTypingSent = Date.now(); S.socket?.emit('typing', { chatId: S.thread.chatId }); } };
$('#thread-form').onsubmit = async e => {
  e.preventDefault(); const t = $('#thread-input').value.trim(); if (!t || !S.thread) return;
  $('#thread-input').value = '';
  const fd = new FormData(); fd.append('text', t);
  try { await api(`/api/chats/${encodeURIComponent(S.thread.chatId)}/messages`, { body: fd }); } catch (err) { toast(err.message); }
};
$('#thread-cam').onclick = () => $('#thread-file').click();
$('#thread-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S.thread) return;
  const fd = new FormData(); fd.append('photo', await shrink(f), 'photo.jpg'); fd.append('text', $('#thread-input').value.trim()); $('#thread-input').value = '';
  try { await api(`/api/chats/${encodeURIComponent(S.thread.chatId)}/messages`, { body: fd }); } catch (err) { toast(err.message); }
};

// ---------- friends ----------
async function refreshFriends() {
  if (!S.token) return;
  try { S.friends = await api('/api/friends'); } catch (_) {}
  $('#req-dot').classList.toggle('hidden', !S.friends.incoming.length);
  if (!$('#friends-sheet').classList.contains('hidden')) renderFriends();
}
function openFriends() { renderFriends(); $('#friends-sheet').classList.remove('hidden'); setTimeout(() => $('#friend-search').focus(), 200); }
$('#add-friend-btn').onclick = openFriends;
function renderFriends() {
  const F = S.friends;
  $('#friend-requests').innerHTML = (F.incoming.length ? `<div class="section-title dark">Added Me</div>` + F.incoming.map(u => `<div class="send-row">${avatarHtml(u)}<span class="grow"><b>${esc(u.name)}</b><br><small>@${esc(u.username)}</small></span><button class="chip red" data-accept="${u.id}">Accept</button><button class="chip" data-remove="${u.id}">✕</button></div>`).join('') : '')
    + (F.outgoing.length ? `<div class="section-title dark">Pending</div>` + F.outgoing.map(u => `<div class="send-row">${avatarHtml(u)}<span class="grow"><b>${esc(u.name)}</b><br><small>@${esc(u.username)} · requested</small></span><button class="chip" data-remove="${u.id}">Cancel</button></div>`).join('') : '');
  F.friends.sort((a, b) => a.user.name.localeCompare(b.user.name));
  $('#friend-list').innerHTML = F.friends.length ? F.friends.map(f => `<div class="send-row">${avatarHtml(f.user)}<span class="grow"><b>${esc(f.user.name)}</b> ${f.streak ? `<span class="streak">🔥${f.streak}</span>` : ''}<br><small>@${esc(f.user.username)}${f.user.nick ? ' · ' + esc(f.user.realName) : ''}</small></span><button class="chip" data-dm="${f.user.id}">💬</button><button class="chip" data-fmenu="${f.user.id}" title="More">⋯</button></div>`).join('')
    : '<div class="empty dark">No friends yet. Search a username above, or share yours from your Profile.</div>';
  bindFriendButtons('#friends-sheet');
  $$('#friend-list [data-fmenu]').forEach(b => {
    const f = F.friends.find(x => x.user.id === b.dataset.fmenu);
    b.onclick = () => friendMenu(f.user);
    onLongPress(b.closest('.send-row'), () => friendMenu(f.user));
  });
}
function friendMenu(u) {
  askAction(u.name, '@' + u.username + (u.nick ? ' · ' + u.realName : ''), [
    { label: '👤 View Profile', fn: () => openPerson(u.id) },
    { label: '💬 Chat', fn: () => { closeSheets(); openThread('dm_' + [S.user.id, u.id].sort().join('_')); } },
    { label: '📞 Call', fn: () => startCall(u, 'audio') },
    { label: '📹 Video call', fn: () => startCall(u, 'video') },
    { label: u.nick ? '✏️ Edit Nickname' : '✏️ Set Nickname', fn: () => nicknameFlow(u) },
    { label: '🚫 Remove Friend', danger: true, fn: () => removeFriendFlow(u) },
  ]);
}
// Private nicknames: only I see them (stored on my account, synced to my other devices)
async function nicknameFlow(u) {
  const v = await askText({ title: u.nick ? 'Edit Nickname' : 'Set Nickname', body: `Only you see this. Shows instead of “${u.realName || u.name}” (@${u.username}) everywhere in PeekaSnap.`,
    value: u.nick || '', placeholder: u.realName || u.username, save: 'Save Nickname', clear: u.nick ? 'Clear Nickname' : null, avatar: u });
  if (v === null) return;
  try {
    const r = await api('/api/nicknames/' + u.id, { method: 'PUT', body: { nickname: v } });
    S.nicks = r.nicknames; toast(v ? `Nickname saved: ${v}` : 'Nickname cleared', 'y'); reloadPeople();
  } catch (e) { toast(e.message); }
}
// Re-fetch everything that shows people after a nickname / profile picture change
let reloadT;
function reloadPeople() {
  clearTimeout(reloadT);
  reloadT = setTimeout(async () => {
    await Promise.all([refreshFriends(), refreshChats(), refreshStories(), refreshInbox(), loadGroup()].map(p => Promise.resolve(p).catch(() => {})));
    if (S.thread) openThread(S.thread.chatId, true);
    if (!$('#send-sheet').classList.contains('hidden')) renderSendRows();
    if (map) { Object.keys(friendMarkers).forEach(k => { friendMarkers[k].remove(); delete friendMarkers[k]; }); if (S.view === 'map') initMap(); }
  }, 150);
}
async function removeFriendFlow(u) {
  const ok = await askConfirm(`Remove ${u.name} as a friend?`, `You'll stop seeing each other in Send To, on the Peak Map, and in Stories, and your streak ends. Your chat stays until you delete it. You can add them again later.`, 'Remove Friend');
  if (!ok) return;
  try {
    await api('/api/friends/remove', { body: { userId: u.id } });
    toast(`Removed ${u.name}`, 'y');
    updateFriendMarker({ userId: u.id, gone: true });
    await refreshFriends(); refreshStories(); refreshChats();
    if (S.thread?.other?.id === u.id) openThread(S.thread.chatId, true);
  } catch (e) { toast(e.message); }
}
function bindFriendButtons(scope) {
  $$(scope + ' [data-accept]').forEach(b => b.onclick = async () => { await api('/api/friends/accept', { body: { userId: b.dataset.accept } }).catch(e => toast(e.message)); refreshFriends(); refreshChats(); });
  $$(scope + ' [data-remove]').forEach(b => b.onclick = async () => { await api('/api/friends/remove', { body: { userId: b.dataset.remove } }); refreshFriends(); });
  $$(scope + ' [data-add]').forEach(b => b.onclick = async () => { try { const r = await api('/api/friends/request', { body: { userId: b.dataset.add } }); toast(r.status === 'friends' ? 'You are now friends 🤝' : 'Request sent 👋', 'y'); b.textContent = r.status === 'friends' ? 'Friends' : 'Added'; b.disabled = true; refreshFriends(); } catch (e) { toast(e.message); } });
  $$(scope + ' [data-dm]').forEach(b => b.onclick = () => { closeSheets(); openThread('dm_' + [S.user.id, b.dataset.dm].sort().join('_')); });
}
let searchT;
$('#friend-search').oninput = e => {
  clearTimeout(searchT); const q = e.target.value.trim();
  searchT = setTimeout(async () => {
    if (q.length < 2) { $('#friend-results').innerHTML = ''; return; }
    const r = await api('/api/users/search?q=' + encodeURIComponent(q)).catch(() => ({ users: [] }));
    const btn = u => u.relation === 'friends' ? '<button class="chip" disabled>Friends</button>' : u.relation === 'outgoing' ? '<button class="chip" disabled>Added</button>' : u.relation === 'incoming' ? `<button class="chip red" data-accept="${u.id}">Accept</button>` : `<button class="chip red" data-add="${u.id}">＋ Add</button>`;
    $('#friend-results').innerHTML = r.users.length ? r.users.map(u => `<div class="send-row">${avatarHtml(u)}<span class="grow"><b>${esc(u.name)}</b><br><small>@${esc(u.username)}</small></span>${btn(u)}</div>`).join('') : '<div class="empty dark">No one found</div>';
    bindFriendButtons('#friend-results');
  }, 250);
};

// ---------- profile ----------
$('#me-btn').onclick = () => { renderProfile(); $('#profile-sheet').classList.remove('hidden'); };
function renderProfile() {
  setAvatar($('#profile-av'), S.user); $('#av-remove').classList.toggle('hidden', !S.user.avatar);
  $('#profile-name').textContent = S.user.name; $('#profile-user').textContent = '@' + S.user.username;
  $('#ghost-switch').checked = !S.user.shareLocation;
  renderInstallBtn();
  const nb = $('#notif-btn');
  if (!('Notification' in window)) nb.textContent = isIOS && !isStandalone() ? '🔔 Alerts: add to Home Screen first' : '🔔 Alerts: in-app only on this browser';
  else nb.textContent = Notification.permission === 'granted' ? '🔔 Alerts are on' : '🔔 Turn on alerts';
}
// Text prompt sheet: resolves to the entered text, '' for "clear", or null if cancelled
let textDone = null;
function askText({ title, body = '', value = '', placeholder = '', save = 'Save', clear = null, avatar = null, required = false }) {
  textDone?.(null);
  $('#text-title').textContent = title; $('#text-body').textContent = body; $('#text-body').classList.toggle('hidden', !body);
  const inp = $('#text-input'); inp.value = value; inp.placeholder = placeholder; inp.classList.remove('bad'); formErr('text-err', '');
  $('#text-save').textContent = save; $('#text-clear').textContent = clear || ''; $('#text-clear').classList.toggle('hidden', !clear);
  $('#text-av').classList.toggle('hidden', !avatar); if (avatar) setAvatar($('#text-av'), avatar);
  $('#text-sheet').classList.remove('hidden'); setTimeout(() => { inp.focus(); inp.select(); }, 120);
  return new Promise(res => {
    textDone = v => { textDone = null; $('#text-sheet').classList.add('hidden'); res(v); };
    $('#text-form').onsubmit = e => {
      e.preventDefault(); const v = inp.value.replace(/\s+/g, ' ').trim();
      if (required && !v) { inp.classList.add('bad'); return formErr('text-err', 'This can\'t be empty.'); }
      textDone(v);
    };
    $('#text-clear').onclick = () => textDone('');
    $('#text-cancel').onclick = () => textDone(null);
    $('#text-sheet').onclick = e => { if (e.target.id === 'text-sheet') textDone(null); };
  });
}

// ---------- profile picture: pick (camera / library) -> crop to circle -> 256px JPEG -> upload ----------
$('#name-btn').onclick = async () => {
  const v = await askText({ title: 'Display name', body: 'Your nickname on PeekaSnap. Friends see it unless they set their own nickname for you.', value: S.user.name, placeholder: S.user.username, save: 'Save', required: true });
  if (!v || v === S.user.name) return;
  try { const r = await api('/api/me', { method: 'PATCH', body: { name: v } }); Object.assign(S.user, { name: r.user.realName }); renderMe(); renderProfile(); toast('Display name saved', 'y'); } catch (e) { toast(e.message); }
};
const pickAvatar = () => askAction('Profile picture', '', [
  { label: '📸 Take photo', fn: () => $('#av-camera').click() },
  { label: '🖼 Choose from library', fn: () => $('#av-library').click() },
  ...(S.user.avatar ? [{ label: '🗑 Remove picture', danger: true, fn: removeAvatar }] : []),
]);
$('#profile-av-btn').onclick = pickAvatar; $('#av-change').onclick = pickAvatar;
$('#av-remove').onclick = removeAvatar;
async function removeAvatar() {
  if (!await askConfirm('Remove profile picture?', 'Friends will see your initials instead.', 'Remove picture')) return;
  try { const r = await api('/api/me/avatar', { method: 'DELETE' }); S.user.avatar = r.user.avatar; renderMe(); renderProfile(); toast('Picture removed', 'y'); } catch (e) { toast(e.message); }
}
const CROP = { img: null, w: 0, h: 0, base: 1, zoom: 1, x: 0, y: 0, size: 0 };
['#av-camera', '#av-library'].forEach(sel => $(sel).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openCrop(f); });
function openCrop(file) {
  const url = URL.createObjectURL(file), img = $('#crop-img');
  img.onerror = () => { URL.revokeObjectURL(url); toast("Couldn't open that picture. Try a JPEG or PNG."); };
  img.onload = () => {
    $('#crop-sheet').classList.remove('hidden'); formErr('crop-err', '');
    requestAnimationFrame(() => {
      CROP.size = $('#crop-stage').clientWidth; CROP.w = img.naturalWidth; CROP.h = img.naturalHeight;
      CROP.base = CROP.size / Math.min(CROP.w, CROP.h); CROP.zoom = 1; $('#crop-zoom').value = 1;
      CROP.x = (CROP.size - CROP.w * CROP.base) / 2; CROP.y = (CROP.size - CROP.h * CROP.base) / 2; applyCrop();
    });
  };
  img.src = url;
}
function applyCrop() {
  const sc = CROP.base * CROP.zoom, S0 = CROP.size;
  CROP.x = Math.min(0, Math.max(S0 - CROP.w * sc, CROP.x)); CROP.y = Math.min(0, Math.max(S0 - CROP.h * sc, CROP.y)); // always cover the circle
  $('#crop-img').style.transform = `translate(${CROP.x}px, ${CROP.y}px) scale(${sc})`;
}
$('#crop-zoom').oninput = e => { // zoom around the center
  const c = CROP.size / 2, old = CROP.base * CROP.zoom; CROP.zoom = +e.target.value; const nw = CROP.base * CROP.zoom;
  CROP.x = c - (c - CROP.x) * nw / old; CROP.y = c - (c - CROP.y) * nw / old; applyCrop();
};
{
  const st = $('#crop-stage'), pts = new Map(); let last = null, pinch0 = null;
  st.addEventListener('pointerdown', e => { st.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = [e.clientX, e.clientY]; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: CROP.zoom }; } });
  st.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2 && pinch0) { const [a, b] = [...pts.values()]; const z = Math.min(4, Math.max(1, pinch0.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0.d)); $('#crop-zoom').value = z; $('#crop-zoom').oninput({ target: { value: z } }); return; }
    CROP.x += e.clientX - last[0]; CROP.y += e.clientY - last[1]; last = [e.clientX, e.clientY]; applyCrop();
  });
  const up = e => { pts.delete(e.pointerId); pinch0 = null; const r = [...pts.values()][0]; if (r) last = r; };
  st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
  st.addEventListener('wheel', e => { e.preventDefault(); const z = Math.min(4, Math.max(1, CROP.zoom * (e.deltaY < 0 ? 1.08 : 0.93))); $('#crop-zoom').value = z; $('#crop-zoom').oninput({ target: { value: z } }); }, { passive: false });
}
function cropBlob(px = 256) {
  const c = document.createElement('canvas'); c.width = c.height = px; const g = c.getContext('2d');
  const sc = CROP.base * CROP.zoom, k = px / CROP.size;
  g.fillStyle = '#000'; g.fillRect(0, 0, px, px); g.imageSmoothingQuality = 'high';
  g.drawImage($('#crop-img'), CROP.x * k, CROP.y * k, CROP.w * sc * k, CROP.h * sc * k);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}
$('#crop-save').onclick = async () => {
  const b = $('#crop-save'); if (b.disabled) return;
  b.disabled = true; b.classList.add('loading'); const label = b.textContent; b.textContent = 'Saving…'; formErr('crop-err', '');
  try {
    const fd = new FormData(); fd.append('avatar', await cropBlob(), 'avatar.jpg');
    const r = await api('/api/me/avatar', { body: fd });
    S.user.avatar = r.user.avatar; renderMe(); renderProfile(); $('#crop-sheet').classList.add('hidden');
    URL.revokeObjectURL($('#crop-img').src); toast('Profile picture saved 📸', 'y');
  } catch (e) { formErr('crop-err', e.message); }
  finally { b.disabled = false; b.classList.remove('loading'); b.textContent = label; }
};
$('#notif-btn').onclick = enableAlerts;
$('#profile-memories').onclick = () => { closeSheets(); openMemories(); };
$('#groups-btn').onclick = () => { closeSheets(); openSheet('groups'); };
$('#signout-btn').onclick = async () => {
  if (!await askConfirm(`Log out @${S.user.username}?`, 'You can log back in with your username and password.', 'Log out')) return;
  try { await api('/api/logout', { body: {} }); } catch (_) {}
  localStorage.clear(); location.reload();
};
$('#password-btn').onclick = () => { closeSheets(); $('#password-form').reset(); formErr('password-err', ''); $('#password-sheet').classList.remove('hidden'); };
$('#password-form').onsubmit = e => {
  e.preventDefault();
  const cur = $('#pw-current'), pw = $('#pw-new'), pw2 = $('#pw-confirm');
  runAuthForm(e.target, 'password-err', () =>
    !cur.value ? { el: cur, msg: 'Enter your current password.' } : pw.value.length < 6 ? { el: pw, msg: 'New password must be at least 6 characters.' } : pw.value !== pw2.value ? { el: pw2, msg: "New passwords don't match." } : null,
  async () => {
    const r = await api('/api/me/password', { body: { current: cur.value, password: pw.value } });
    S.token = r.token; localStorage.setItem('ps_token', r.token); if (S.socket) S.socket.auth.token = r.token;
    closeSheets(); toast('Password changed 🔒 Other devices were logged out', 'y');
  });
};
$('#share-username').onclick = async () => {
  const url = `${location.origin}/?add=${S.user.username}`, text = `Add me on PeekaSnap: @${S.user.username}`;
  if (navigator.share) { try { await navigator.share({ title: 'PeekaSnap', text, url }); return; } catch (_) {} }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Link copied 📋', 'y'); } catch (_) { prompt('Share this:', `${text} ${url}`); }
};
$('#ghost-switch').onchange = e => setGhost(e.target.checked);
async function setGhost(ghost) {
  try {
    const r = await api('/api/me', { method: 'PATCH', body: { shareLocation: !ghost } }); S.user = { ...S.user, ...r.user };
    if (!ghost) { lastShare = 0; getLoc().then(l => setMyLoc({ coords: { latitude: l.lat, longitude: l.lng, accuracy: l.acc } })).catch(e => toast(e.message)); }
    toast(ghost ? '👻 Ghost Mode on: friends can\'t see you' : '📍 Friends can now see you on the Map', 'y'); renderGhost(); renderProfile();
  } catch (e) { toast(e.message); }
}

// ---------- stories ----------
async function refreshStories() { if (!S.token) return; try { S.stories = await api('/api/stories'); } catch (_) {} renderStoriesTab(); }
function renderStoriesTab() {
  const F = S.stories.friends;
  $('#story-bar').innerHTML = F.length ? F.map((f, i) => `<button class="story-card" data-fs="${i}"><div class="story-ring ${f.allSeen ? 'done' : ''}"><img src="${f.stories[f.stories.length - 1].photo}" alt=""></div>${avatarHtml(f.user, 'story-mini')}<div class="lbl">${esc(f.user.name)}</div><div class="cd">${ago(f.latest)}</div></button>`).join('')
    : '<div class="empty small">No stories from friends yet</div>';
  const M = S.stories.mine;
  $('#my-story').innerHTML = `<button class="my-story-card" id="my-story-open">${M.length ? `<img src="${M[M.length - 1].photo}" alt="">` : '<span class="story-new">＋</span>'}<div class="grow"><b>My Story</b><div class="muted">${M.length ? `${M.length} Peak${M.length > 1 ? 's' : ''} · 👁 ${new Set(M.flatMap(s => s.views.map(v => v.user.id))).size} viewers` : 'Tap to add a Peak · lasts 24h'}</div></div></button>`;
  $$('[data-fs]').forEach(b => b.onclick = () => openStoryViewer(S.stories.friends[+b.dataset.fs]));
  $('#my-story-open').onclick = () => M.length ? openStoryViewer({ user: S.user, stories: M }, true) : setView('camera');
}
let SV = null, svTimer = null;
function openStoryViewer(entry, mine) { SV = { entry, i: Math.max(0, mine ? 0 : entry.stories.findIndex(s => !s.seen)), mine }; stopCamera(); $('#sv').classList.remove('hidden'); showStory(); }
function showStory() {
  clearTimeout(svTimer);
  const { entry, i, mine } = SV, s = entry.stories[i]; if (!s) return closeStoryViewer();
  $('#sv-img').src = s.photo;
  $('#sv-bars').innerHTML = entry.stories.map((_, k) => `<i class="${k < i ? 'on' : ''}">${k === i ? `<b style="animation-duration:${s.timer}s"></b>` : ''}</i>`).join('');
  setAvatar($('#sv-av'), entry.user);
  $('#sv-name').textContent = mine ? 'My Story' : entry.user.name; $('#sv-time').textContent = ago(s.createdAt) + ' ago';
  $('#sv-views').classList.toggle('hidden', !mine);
  if (mine) $('#sv-views').innerHTML = `👁 ${s.views.length}${s.views.length ? ' · ' + s.views.map(v => esc(v.user.name)).join(', ') : ''} <button class="chip" id="sv-del">🗑</button>`;
  $('#sv-del')?.addEventListener('click', async e => { e.stopPropagation(); await api('/api/stories/' + s.id, { method: 'DELETE' }); toast('Deleted'); closeStoryViewer(); refreshStories(); });
  if (!mine && !s.seen) api(`/api/stories/${s.id}/view`, { body: {} }).catch(() => {});
  s.seen = true;
  svTimer = setTimeout(nextStory, s.timer * 1000);
}
function nextStory() { SV.i++; if (SV.i >= SV.entry.stories.length) return closeStoryViewer(); showStory(); }
function closeStoryViewer() { clearTimeout(svTimer); SV = null; $('#sv').classList.add('hidden'); refreshStories(); if (S.view === 'camera') startCamera(); }
$('#sv-next').onclick = nextStory;
$('#sv-prev').onclick = () => { SV.i = Math.max(0, SV.i - 1); showStory(); };
$('#sv-close').onclick = closeStoryViewer;

// ---------- Snap Map ----------
let map, meMarker; const friendMarkers = {};
const tiles = () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const emojiIcon = (e, size = 30) => L.divIcon({ className: '', html: `<div class="emoji-marker">${e}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
const AREA_STYLE = { color: '#FF2D46', weight: 2, dashArray: '6 8', fillColor: '#FF2D46', fillOpacity: 0.08 };
const personIcon = (u, cls = '') => L.divIcon({ className: '', html: `<div class="person-marker ${cls}"><span style="background:${u.avatar ? '#111' : AV_RED}">${avInner(u)}</span><em>${esc(u.name)}</em></div>`, iconSize: [44, 60], iconAnchor: [22, 22] });
async function initMap() {
  if (!map) {
    map = L.map('map', { zoomControl: false }).setView([37.7749, -122.4194], 13);
    tiles().addTo(map); updateMeMarker();
    getLoc().then(l => map.setView([l.lat, l.lng], 15)).catch(() => {});
  }
  setTimeout(() => map.invalidateSize(), 50);
  renderGhost();
  try {
    const r = await api('/api/map');
    Object.keys(friendMarkers).forEach(k => { if (!r.friends.some(f => f.user.id === k)) { friendMarkers[k].remove(); delete friendMarkers[k]; } });
    r.friends.forEach(f => updateFriendMarker({ userId: f.user.id, user: f.user, lat: f.lat, lng: f.lng, t: f.t }));
  } catch (_) {}
}
function updateFriendMarker(d) {
  if (!map) return;
  if (d.gone) { friendMarkers[d.userId]?.remove(); delete friendMarkers[d.userId]; return; }
  const u = d.user || S.friends.friends.find(f => f.user.id === d.userId)?.user; if (!u) return;
  if (friendMarkers[d.userId]) friendMarkers[d.userId].setLatLng([d.lat, d.lng]);
  else friendMarkers[d.userId] = L.marker([d.lat, d.lng], { icon: personIcon(u) }).addTo(map).on('click', () => openPerson(d.userId));
}
function updateMeMarker() {
  if (!map || !S.myLoc) return;
  const ll = [S.myLoc.lat, S.myLoc.lng];
  if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng(ll);
}
function renderGhost() {
  const ghost = !S.user?.shareLocation;
  $('#ghost-status').innerHTML = ghost ? '👻 <b>Ghost Mode</b> · friends can\'t see you' : '📍 <b>Sharing</b> your location with friends';
  $('#ghost-toggle').textContent = ghost ? '📍 Share my location' : '👻 Go ghost';
  $('#ghost-toggle').classList.toggle('red', ghost);
}
$('#ghost-toggle').onclick = () => setGhost(!!S.user.shareLocation);
$('#locate-btn').onclick = () => getLoc().then(l => map.setView([l.lat, l.lng], 16)).catch(e => toast(e.message));

// ---------- sheets & groups ----------
function openSheet(name) { $('#' + name + '-sheet').classList.remove('hidden'); if (name === 'groups') renderGroups(); if (name === 'board') renderBoard(); }
function closeSheets() { $$('.sheet-wrap').forEach(s => s.classList.add('hidden')); }
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) e.target.closest('.sheet-wrap').classList.add('hidden'); });
$$('.sheet-wrap').forEach(w => w.addEventListener('click', e => { if (e.target === w) w.classList.add('hidden'); }));
function renderGroups() {
  $('#group-list').innerHTML = S.groups.length ? S.groups.map(g => `<div class="group-item ${g.id === S.groupId ? 'active' : ''}" data-g="${g.id}">
    <span class="ge">${esc(g.emoji)}</span><span class="grow"><b>${esc(g.name)}</b><small>${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · code ${g.code}</small></span>
    <button class="chip" data-gchat="${g.id}">💬</button><button class="chip" data-gshare="${g.id}">Invite</button></div>`).join('')
    : '<div class="empty dark">No groups yet. Create one, or join with a code from a friend.</div>';
  $$('[data-g]').forEach(b => b.onclick = async e => {
    if (e.target.closest('[data-gchat]')) { closeSheets(); return openThread(b.dataset.g); }
    if (e.target.closest('[data-gshare]')) return shareGroup(S.groups.find(g => g.id === b.dataset.g));
    S.groupId = b.dataset.g; closeSheets(); await loadGroup(); toast('Playing in ' + S.group.name);
  });
}
async function shareGroup(g) {
  const url = `${location.origin}/?join=${g.code}`, text = `Join my PeekaSnap group "${g.name}"! Code: ${g.code}`;
  if (navigator.share) { try { await navigator.share({ title: 'PeekaSnap', text, url }); return; } catch (_) {} }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Invite link copied 📋', 'y'); } catch (_) { prompt('Share this invite:', `${text} ${url}`); }
}
$('#join-form').onsubmit = async e => {
  e.preventDefault(); $('#groups-err').textContent = '';
  try { const r = await api('/api/groups/join', { body: { code: $('#join-code').value } }); S.groupId = r.group.id; $('#join-code').value = '';
    await refreshMe(); await loadGroup(); closeSheets(); refreshChats(); toast('Joined ' + r.group.name + ' 🎉', 'y'); }
  catch (err) { $('#groups-err').textContent = err.message; }
};
$('#create-form').onsubmit = async e => {
  e.preventDefault(); $('#groups-err').textContent = '';
  try { const r = await api('/api/groups', { body: { name: $('#create-name').value, emoji: $('#create-emoji').value } }); S.groupId = r.group.id; $('#create-name').value = '';
    await refreshMe(); await loadGroup(); closeSheets(); refreshChats(); toast(`Group created! Invite code: ${r.group.code}`, 'y'); }
  catch (err) { $('#groups-err').textContent = err.message; }
};

document.addEventListener('DOMContentLoaded', boot);


// ---------- tap any person -> their profile page ----------
document.addEventListener('click', e => {
  const el = e.target.closest('[data-person]');
  if (!el || el.classList.contains('story-mini') || el.closest('#send-sheet, #person-sheet .pp-top, #call, #text-sheet')) return;
  e.preventDefault(); e.stopPropagation(); openPerson(el.dataset.person);
}, true);
$('#sv-av').addEventListener('click', e => { e.stopPropagation(); });
async function openPerson(uid) {
  if (!uid) return;
  if (uid === S.user.id) { closeSheets(); renderProfile(); $('#profile-sheet').classList.remove('hidden'); return; }
  const body = $('#person-body');
  body.innerHTML = '<div class="empty dark">Loading…</div>'; $('#person-sheet').classList.remove('hidden');
  try { renderPerson(await api(`/api/users/${uid}/profile`)); }
  catch (e) { body.innerHTML = `<div class="form-err show">${esc(e.message)}</div>`; }
}
function renderPerson(p) {
  const u = p.user, fr = p.relation === 'friends';
  const since = p.friendsSince ? new Date(p.friendsSince).toLocaleDateString([], { month: 'short', year: 'numeric' }) : null;
  const btn = (id, label, cls = 'btn-glass dark') => `<button class="${cls}" data-pp="${id}">${label}</button>`;
  const actions = fr ? btn('chat', '💬<small>Chat</small>') + btn('call', '📞<small>Call</small>') + btn('video', '📹<small>Video</small>') + btn('nick', '✏️<small>Nickname</small>')
    : p.relation === 'incoming' ? btn('accept', '✅<small>Accept</small>', 'btn-red') : p.relation === 'outgoing' ? btn('none', '⏳<small>Requested</small>') : btn('add', '＋<small>Add Friend</small>', 'btn-red');
  const thumbs = (list, attr) => list.map(x => `<button class="pp-thumb" ${attr(x)}>${x.thumb || x.photo ? `<img src="${x.thumb || x.photo}" alt="">` : '<span>📸</span>'}${x.mine ? '<i>➤ sent</i>' : ''}</button>`).join('');
  $('#person-body').innerHTML = `
    <div class="pp-top">${avatarHtml(u, 'xxl')}
      <h2>${esc(u.name)}</h2>
      <div class="muted">@${esc(u.username)}${u.nick ? ' · ' + esc(u.realName) : ''}</div>
      ${p.nickname ? `<div class="pp-nick">✏️ Your nickname for them: <b>${esc(p.nickname)}</b> <small>(only you see it)</small></div>` : ''}
      ${fr ? `<div class="pp-badges"><span>🤝 Friends${since ? ' since ' + since : ''}</span>${p.streak ? `<span>🔥 ${p.streak}</span>` : ''}<span>⭐ ${p.score} Peak score</span></div>` : ''}
    </div>
    <div class="pp-actions">${actions}</div>
    ${p.limited ? `<div class="pp-locked">🔒 ${p.relation === 'outgoing' ? 'Friend request sent.' : 'Not friends yet.'} Add each other as friends to see their stories, Peaks and game stats.</div>` : `
      ${p.mutual.length ? `<div class="section-title dark">${p.mutual.length} mutual friend${p.mutual.length === 1 ? '' : 's'}</div><div class="pp-mutual">${p.mutual.map(m => `<div>${avatarHtml(m)}<small>${esc(m.name)}</small></div>`).join('')}</div>` : ''}
      ${p.stories.length ? `<div class="section-title dark">Story</div><div class="pp-thumbs">${thumbs(p.stories, () => 'data-ppstory="1"')}</div>` : ''}
      <div class="section-title dark">Peaks between you</div>
      ${p.peaks.length ? `<div class="pp-thumbs">${thumbs(p.peaks, x => `data-pppeak="${x.id}"`)}</div>` : '<div class="muted pp-empty">No saved Peaks yet. Peaks with Allow replay stay here after they\'re opened.</div>'}
      <div class="section-title dark">Games</div>
      <div class="pp-stats"><div><b>${p.stats.hideSeek.hides}</b><small>hid</small></div><div><b>${p.stats.hideSeek.finds}</b><small>found</small></div><div><b>${p.stats.hideSeek.escapes}</b><small>escaped</small></div>
        <div><b>${p.stats.manhunt.games}</b><small>Manhunts</small></div><div><b>${p.stats.manhunt.tags}</b><small>tags</small></div><div><b>${p.stats.manhunt.survived}</b><small>survived</small></div></div>
      <button class="btn-glass dark wide danger-text" data-pp="remove">🚫 Remove Friend</button>`}`;
  const act = {
    chat: () => { closeSheets(); openThread('dm_' + [S.user.id, u.id].sort().join('_')); },
    call: () => startCall(u, 'audio'), video: () => startCall(u, 'video'),
    nick: async () => { await nicknameFlow(u); openPerson(u.id); },
    add: async () => { try { const r = await api('/api/friends/request', { body: { userId: u.id } }); toast(r.status === 'friends' ? 'You are now friends 🤝' : 'Request sent 👋', 'y'); refreshFriends(); openPerson(u.id); } catch (e) { toast(e.message); } },
    accept: async () => { try { await api('/api/friends/accept', { body: { userId: u.id } }); toast('You are now friends 🤝', 'y'); refreshFriends(); refreshChats(); openPerson(u.id); } catch (e) { toast(e.message); } },
    remove: async () => { await removeFriendFlow(u); openPerson(u.id); },
  };
  $$('#person-body [data-pp]').forEach(b => b.onclick = () => act[b.dataset.pp]?.());
  $$('#person-body [data-ppstory]').forEach(b => b.onclick = () => { closeSheets(); openStoryViewer({ user: u, stories: p.stories }); });
  $$('#person-body [data-pppeak]').forEach(b => b.onclick = () => openSnapHistory(b.dataset.pppeak));
}

// ---------- Memories: every Peak you've sent ----------
let MEM = [], memOpen = null;
$('#cam-memories').onclick = openMemories;
$('#mem-close').onclick = () => { $('#memories').classList.add('hidden'); if (S.view === 'camera' && !anyOverlayOpen()) startCamera(); };
async function openMemories() {
  stopCamera(); $('#memories').classList.remove('hidden'); $('#mem-grid').innerHTML = '<div class="empty">Loading…</div>';
  try { MEM = (await api('/api/memories')).memories; } catch (e) { $('#mem-grid').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  renderMemories();
}
function renderMemories() {
  $('#mem-count').textContent = MEM.length ? `${MEM.length} Peak${MEM.length === 1 ? '' : 's'}` : '';
  if (!MEM.length) { $('#mem-grid').innerHTML = '<div class="empty">No Memories yet.<br>Every Peak you send is saved here, just for you.</div>'; return; }
  const day = t => { const d = new Date(t), today = new Date(); const y = new Date(Date.now() - 864e5);
    return d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }); };
  let html = '', last = '';
  for (const m of MEM) {
    const d = day(m.createdAt); if (d !== last) { if (last) html += '</div>'; html += `<div class="mem-day">${d}</div><div class="mem-row">`; last = d; }
    html += `<button class="mem-cell" data-mem="${m.id}">${m.thumb ? `<img src="${m.thumb}" alt="" loading="lazy">` : '<span>📸</span>'}${m.story ? '<i>Story</i>' : ''}</button>`;
  }
  $('#mem-grid').innerHTML = html + '</div>';
  $$('#mem-grid [data-mem]').forEach(b => b.onclick = () => viewMemory(b.dataset.mem));
}
async function viewMemory(id) {
  try {
    const m = await api('/api/memories/' + id); memOpen = m;
    $('#mem-img').src = m.image;
    $('#mem-when').innerHTML = `<b>${new Date(m.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</b> <small>${fmtTime(m.createdAt)}${m.sentTo ? ` · sent to ${m.sentTo}` : ''}${m.story ? ' · My Story' : ''}</small>`;
    $('#mem-viewer').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}
$('#mem-x').onclick = () => { $('#mem-viewer').classList.add('hidden'); $('#mem-img').src = ''; };
$('#mem-del').onclick = async () => {
  if (!memOpen || !await askConfirm('Delete this Memory?', 'It is removed from your Memories. Copies you already sent stay in those chats.', 'Delete Memory')) return;
  try { await api('/api/memories/' + memOpen.id, { method: 'DELETE' }); MEM = MEM.filter(x => x.id !== memOpen.id); $('#mem-x').onclick(); renderMemories(); toast('Memory deleted 🗑', 'y'); } catch (e) { toast(e.message); }
};
