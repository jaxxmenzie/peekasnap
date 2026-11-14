/* PeekaSnap client - vanilla JS, no build step */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = {
  token: localStorage.getItem('ps_token'), user: null, groups: [],
  groupId: localStorage.getItem('ps_group'), group: null, hides: [], messages: [], leaderboard: [],
  view: 'camera', snap: null, myLoc: null, socket: null,
};

// ---------- api ----------
async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'x-token': S.token || '' } };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body) { o.body = JSON.stringify(opts.body); o.headers['content-type'] = 'application/json'; }
  const r = await fetch(path, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
  return j;
}

// ---------- feedback: toast, sound, notification ----------
function toast(msg, cls = '') {
  const t = document.createElement('div'); t.className = 'toast ' + cls; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3500);
}
let audioCtx;
function sonar() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((d, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(1100 - i * 150, audioCtx.currentTime + d);
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.4, audioCtx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + d + 0.3);
      o.connect(g).connect(audioCtx.destination); o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + 0.32);
    });
  } catch (_) {}
}
// System notification. Installed apps (Android, and iOS 16.4+ Home Screen apps) need the service worker
// to show it; plain new Notification() is the fallback for desktop browsers.
async function notify(title, body, url = '/') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return; // the in-app banner already shows it
  const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', tag: 'peekasnap-' + title, vibrate: [200, 100, 200], data: { url } };
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) return reg.showNotification(title, opts); } catch (_) {}
  try { new Notification(title, opts); } catch (_) {}
}

// ---------- installed app: service worker, Web Push, Home Screen prompt ----------
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
// subscribe this device to Web Push so pings arrive even when the app is closed (where the platform allows)
async function ensurePush() {
  try {
    if (!S.token || !('PushManager' in window) || Notification.permission !== 'granted') return false;
    const reg = swReg || await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
    }
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
    return true;
  } catch (_) { return false; }
}
async function enableAlerts() {
  sonar(); // also unlocks audio on iOS
  if (!('Notification' in window)) {
    if (isIOS && !isStandalone()) { showInstallCard(true); return toast('On iPhone, add PeekaSnap to your Home Screen first to get alerts'); }
    return toast('This browser only supports in-app alerts');
  }
  const p = await Notification.requestPermission();
  if (p !== 'granted') return toast('Alerts blocked - you will still get in-app pings');
  const pushed = await ensurePush();
  toast(pushed ? 'Ping alerts on 🔔 (even when the app is closed)' : 'Ping alerts on 🔔 while the app is open', 'y');
  hideInstallCard(); renderGroups();
}

let deferredPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (S.user) maybeShowInstallCard(); renderInstallBtn(); });
addEventListener('appinstalled', () => { deferredPrompt = null; hideInstallCard(); toast('Installed! Open PeekaSnap from your Home Screen 📲', 'y'); });
const canInstall = () => !isStandalone() && (deferredPrompt || isIOSSafari);
function renderInstallBtn() { $('#install-btn')?.classList.toggle('hidden', !canInstall()); }
function maybeShowInstallCard() {
  const snooze = +localStorage.getItem('ps_install_snooze') || 0;
  if (Date.now() < snooze) return;
  if (canInstall()) return showInstallCard();
  // already on the Home Screen but alerts are off: offer to turn them on (iOS requires a tap for this)
  if (isStandalone() && 'Notification' in window && Notification.permission === 'default') showAlertsCard();
}
function showInstallCard(force) {
  if (!canInstall() && !force) return;
  const ios = isIOS && !deferredPrompt;
  $('#install-title').textContent = 'Add PeekaSnap to your Home Screen';
  $('#install-body').textContent = ios ? 'Opens full-screen like an app and lets PeekaSnap send ping alerts:' : 'Full-screen, one tap to open, and ping alerts like a real app.';
  $('#install-ios').classList.toggle('hidden', !ios);
  $('#install-card').classList.toggle('ios-arrow', ios && !/ipad/i.test(navigator.userAgent));
  $('#install-go').classList.toggle('hidden', ios);
  $('#install-go').textContent = 'Install';
  $('#install-go').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
    deferredPrompt = null; hideInstallCard(); renderInstallBtn();
    if (outcome !== 'accepted') toast('No problem - it\'s in the Groups menu any time');
  };
  $('#install-card').classList.remove('hidden');
}
function showAlertsCard() {
  $('#install-title').textContent = 'Turn on ping alerts 🔔';
  $('#install-body').textContent = 'Get a buzz when a ping fires, someone moves the object, or it gets found, even when PeekaSnap is closed.';
  $('#install-ios').classList.add('hidden'); $('#install-card').classList.remove('ios-arrow');
  $('#install-go').classList.remove('hidden'); $('#install-go').textContent = 'Turn on';
  $('#install-go').onclick = enableAlerts;
  $('#install-card').classList.remove('hidden');
}
function hideInstallCard() { $('#install-card').classList.add('hidden'); }
$('#install-later').onclick = $('#install-x').onclick = () => { localStorage.setItem('ps_install_snooze', Date.now() + 3 * 864e5); hideInstallCard(); };
$('#install-btn').onclick = () => { closeSheets(); showInstallCard(true); };
let bannerTimer;
function banner(html, ms = 6000) {
  const b = $('#ping-banner'); b.innerHTML = html; b.classList.remove('hidden');
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  b.onclick = () => b.classList.add('hidden');
}

// ---------- geolocation ----------
function getLoc(timeout = 12000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('No GPS on this device'));
    // the live GPS watch only reports when you move, so its latest fix is current (cap at 2 min to be safe)
    if (watchId != null && S.myLoc && Date.now() - S.myLoc.t < 120000) return res(S.myLoc);
    navigator.geolocation.getCurrentPosition(p => {
      S.myLoc = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      updateMeMarker(); res(S.myLoc);
    }, e => {
      if (e.code !== 1 && S.myLoc && Date.now() - S.myLoc.t < 60000) return res(S.myLoc);
      rej(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location'));
    }, { enableHighAccuracy: true, timeout, maximumAge: 5000 });
  });
}
let watchId = null;
function startWatch() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(p => {
    S.myLoc = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; updateMeMarker();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}

// ---------- boot / auth ----------
S.minPingDelayMs = 5 * 60000;
fetch('/api/config').then(r => r.json()).then(c => { S.minPingDelayMs = c.minPingDelayMs; }).catch(() => {});
async function boot() {
  if (!S.token) return showOnboard();
  try {
    const me = await api('/api/me');
    S.user = me.user; S.groups = me.groups;
  } catch (e) { if (e.status === 401) { localStorage.removeItem('ps_token'); return showOnboard(); } toast(e.message); return; }
  $('#onboard').classList.add('hidden'); $('#app').classList.remove('hidden');
  const me = $('#me-btn'); me.textContent = S.user.name[0].toUpperCase(); me.style.background = S.user.color;
  connectSocket();
  if (!S.groups.find(g => g.id === S.groupId)) S.groupId = S.groups[0]?.id || null;
  if (S.groupId) await loadGroup(); else { renderAll(); openSheet('groups'); }
  setView(location.hash.slice(1) || 'camera');
  startWatch();
  ensurePush();
  setTimeout(maybeShowInstallCard, 2500);
}
function showOnboard() { $('#onboard').classList.remove('hidden'); $('#app').classList.add('hidden'); setTimeout(() => $('#signup-name').focus(), 50); }
$('#signup-form').onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await api('/api/signup', { body: { name: $('#signup-name').value } });
    S.token = r.token; localStorage.setItem('ps_token', r.token);
    const code = new URLSearchParams(location.search).get('join');
    if (code) { try { const j = await api('/api/groups/join', { body: { code } }); S.groupId = j.group.id; localStorage.setItem('ps_group', S.groupId); } catch (_) {} }
    boot();
  } catch (err) { toast(err.message); }
};

function connectSocket() {
  if (S.socket) return;
  const s = S.socket = io({ auth: { token: S.token } });
  s.on('connect', () => { if (S.groupId) loadGroup(); });
  s.on('message', m => {
    if (m.groupId !== S.groupId) return;
    S.messages.push(m); renderChat();
    if (S.view !== 'chat') $('#chat-dot').classList.remove('hidden');
  });
  s.on('hide', h => {
    if (h.groupId !== S.groupId) return;
    const i = S.hides.findIndex(x => x.id === h.id);
    if (i >= 0) S.hides[i] = h; else S.hides.unshift(h);
    renderStories(); renderMapHides(); if (openStoryId === h.id) renderStory();
    refreshBoard();
  });
  s.on('ping', p => {
    const g = S.groups.find(x => x.id === (S.hides.find(h => h.id === p.hideId)?.groupId)) ;
    const mine = p.hider?.id === S.user.id;
    sonar(); navigator.vibrate?.([200, 100, 200, 100, 400]);
    banner(`<div class="radar">📡</div><div class="grow">PING ${p.n}/${p.of} · ${esc(p.object)}<div class="muted">${mine ? 'Seekers got a new hint. You can move or rename it once before the next ping!' : `Hint circle shrank to ${p.hint.radius} m. Hot/cold unlocked!`}</div></div>${mine ? '<button class="banner-btn" id="banner-move">🔀 Move it</button>' : ''}`, mine ? 12000 : 6000);
    if (mine) $('#banner-move').onclick = ev => { ev.stopPropagation(); $('#ping-banner').classList.add('hidden'); openMoveSheet(p.hideId); };
    notify(`📡 Ping ${p.n}/${p.of}: ${p.object}`, mine ? 'Seekers got a new hint. Move or rename it before the next ping!' : `It's within ${p.hint.radius} m of the new circle. Tap to hunt!`, '/#map');
    if (!mine && S.view === 'map') focusHide(p.hideId);
  });
  s.on('found', f => {
    banner(`<div class="radar">🏆</div><div class="grow">${esc(f.finder.name)} found the ${esc(f.object)}!</div>`);
    notify('🏆 Found!', `${f.finder.name} found the ${f.object}`);
  });
  s.on('moved', m => {
    if (m.hider.id === S.user.id) return;
    const bits = [m.moved && `moved the ${esc(m.renamed ? m.oldName : m.object)}`, m.renamed && `renamed it to "${esc(m.object)}"`, m.newPhoto && 'posted a new photo'].filter(Boolean).join(' and ');
    sonar(); navigator.vibrate?.([100, 60, 100]);
    banner(`<div class="radar">🔀</div><div class="grow">${esc(m.hider.name)} ${bits}!<div class="muted">${m.moved ? 'The old hint circle is out of date. Wait for the next ping.' : 'Same spot, new name.'}</div></div>`);
    notify('🔀 It moved!', `${m.hider.name} ${bits.replace(/&quot;/g, '"')}`);
  });
  s.on('claim', c => { toast(`${c.user.name} says they found your ${c.object}! Review it 👀`, 'y'); notify('Find claim', `${c.user.name} says they found your ${c.object}`); });
}

async function loadGroup() {
  if (!S.groupId) return;
  try {
    const r = await api('/api/groups/' + S.groupId);
    S.group = r.group; S.hides = r.hides; S.messages = r.messages; S.leaderboard = r.leaderboard;
    localStorage.setItem('ps_group', S.groupId);
  } catch (e) { toast(e.message); S.groupId = null; S.group = null; }
  renderAll();
}
async function refreshMe() { const me = await api('/api/me'); S.groups = me.groups; S.socket?.emit('refresh-groups'); }
let boardT; function refreshBoard() { clearTimeout(boardT); boardT = setTimeout(async () => { if (!S.groupId) return; const r = await api('/api/groups/' + S.groupId); S.leaderboard = r.leaderboard; renderBoard(); }, 400); }

// ---------- views ----------
function setView(v) {
  if (!['map', 'camera', 'chat'].includes(v)) v = 'camera';
  S.view = v; history.replaceState(null, '', '#' + v);
  ['map', 'camera', 'chat'].forEach(x => $('#view-' + x).classList.toggle('hidden', x !== v));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'camera') startCamera(); else stopCamera();
  if (v === 'map') { initMap(); setTimeout(() => { map.invalidateSize(); fitGroup(); }, 50); }
  if (v === 'chat') { $('#chat-dot').classList.add('hidden'); scrollChat(); }
}
$$('.nav-btn').forEach(b => b.onclick = () => setView(b.dataset.view));

function renderAll() {
  $('#group-name').textContent = S.group ? S.group.name : 'Join or create a group';
  $('#group-pill').firstChild.textContent = (S.group?.emoji || '👀') + ' ';
  renderStories(); renderChat(); renderMapHides(); renderBoard(); renderGroups();
}
const activeHides = () => S.hides.filter(h => h.status === 'active');
function fmtIn(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000); if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function renderStories() {
  const act = activeHides(), recent = S.hides.filter(h => h.status !== 'active').slice(0, 6);
  const card = h => `<button class="story-card" data-hide="${h.id}"><div class="story-ring ${h.status !== 'active' ? 'done' : ''}"><img src="${h.photo}" alt=""></div>
    <div class="lbl">${esc(h.isHider ? 'Your ' + h.object : h.object)}</div><div class="cd" data-cd="${h.id}">${cdText(h)}</div></button>`;
  const html = act.map(card).join('');
  $('#cam-stories').innerHTML = html;
  $('#map-stories').innerHTML = html;
  $('#chat-stories').innerHTML = S.group ? `<button class="story-card" id="new-hide-story"><div class="story-new">＋</div><div class="lbl">Hide one</div></button>` + html + recent.map(card).join('') : '';
  $$('[data-hide]').forEach(b => b.onclick = () => openStory(b.dataset.hide));
  const nh = $('#new-hide-story'); if (nh) nh.onclick = () => setView('camera');
}
function cdText(h) {
  if (h.status === 'found') return '✅ found';
  if (h.status !== 'active') return h.status === 'escaped' ? '🏃 escaped' : 'ended';
  return h.nextPingAt ? '📡 ' + fmtIn(h.nextPingAt - Date.now()) : '⏳ last call';
}
setInterval(() => {
  $$('[data-cd]').forEach(el => { const h = S.hides.find(x => x.id === el.dataset.cd); if (h) el.textContent = cdText(h); });
  if (openStoryId) renderCountdown();
}, 1000);

// ---------- camera ----------
let stream = null, facing = 'environment';
async function startCamera() {
  if (stream || !navigator.mediaDevices?.getUserMedia) { if (!stream) $('#cam-fallback').classList.remove('hidden'); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    if (S.view !== 'camera') return stopCamera();
    $('#cam-video').srcObject = stream; $('#cam-fallback').classList.add('hidden');
  } catch (_) { $('#cam-fallback').classList.remove('hidden'); }
}
function stopCamera() { stream?.getTracks().forEach(t => t.stop()); stream = null; }
$('#cam-flip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; stopCamera(); startCamera(); };
$('#shutter').onclick = () => {
  const v = $('#cam-video');
  if (!stream || !v.videoWidth) return $('#file-capture').click(); // native camera fallback
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  c.toBlob(b => setSnap(b), 'image/jpeg', 0.85);
};
$('#cam-upload').onclick = () => $('#file-pick').click();
['#file-capture', '#file-pick'].forEach(s => $(s).onchange = e => { const f = e.target.files[0]; if (f) setSnap(f); e.target.value = ''; });

async function shrink(blob, max = 1600) { // resize big phone photos before upload
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && blob.size < 1.5e6) return blob;
    const c = document.createElement('canvas'); c.width = bmp.width * k; c.height = bmp.height * k;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  } catch (_) { return blob; }
}
function setSnap(blob) {
  S.snap = blob;
  const url = URL.createObjectURL(blob);
  $('#preview-img').src = url; $('#hide-thumb').src = url;
  $('#preview').classList.remove('hidden');
}
$('#preview-close').onclick = $('#preview-retake').onclick = () => { $('#preview').classList.add('hidden'); S.snap = null; };
$('#preview-hide').onclick = () => {
  if (!S.group) { toast('Join or create a group first'); return openSheet('groups'); }
  $('#preview').classList.add('hidden'); openHideSheet();
};

// ---------- sheets ----------
function openSheet(name) { $('#' + name + '-sheet').classList.remove('hidden'); if (name === 'groups') renderGroups(); if (name === 'board') renderBoard(); }
function closeSheets() { $$('.sheet-wrap').forEach(s => s.classList.add('hidden')); }
$$('[data-close]').forEach(b => b.onclick = closeSheets);
$$('.sheet-wrap').forEach(w => w.onclick = e => { if (e.target === w) closeSheets(); });
$('#group-pill').onclick = () => openSheet('groups');
$('#board-btn').onclick = () => openSheet('board');
$('#me-btn').onclick = () => { if (confirm(`Signed in as ${S.user.name}. Sign out on this device?`)) { localStorage.clear(); location.reload(); } };

function renderGroups() {
  $('#group-list').innerHTML = S.groups.length ? S.groups.map(g => `<button class="group-item ${g.id === S.groupId ? 'active' : ''}" data-g="${g.id}">
    <span class="ge">${esc(g.emoji)}</span><span class="grow"><b>${esc(g.name)}</b><small>${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · code ${g.code}</small></span>${g.id === S.groupId ? '✓' : ''}</button>`).join('')
    : '<div class="empty">You\'re not in any groups yet. Create one or join with a code from a friend.</div>';
  $$('[data-g]').forEach(b => b.onclick = async () => { S.groupId = b.dataset.g; closeSheets(); await loadGroup(); toast('Switched to ' + S.group.name); });
  const nb = $('#notif-btn');
  renderInstallBtn();
  if (!('Notification' in window)) nb.textContent = isIOS && !isStandalone() ? '🔔 Alerts: add to Home Screen first' : '🔔 Alerts: in-app only on this browser';
  else if (Notification.permission === 'granted') nb.textContent = '🔔 Ping alerts are on';
}
$('#join-form').onsubmit = async e => {
  e.preventDefault(); $('#groups-err').textContent = '';
  try { const r = await api('/api/groups/join', { body: { code: $('#join-code').value } }); S.groupId = r.group.id; $('#join-code').value = '';
    await refreshMe(); await loadGroup(); closeSheets(); toast('Joined ' + r.group.name + ' 🎉', 'y'); }
  catch (err) { $('#groups-err').textContent = err.message; }
};
$('#create-form').onsubmit = async e => {
  e.preventDefault(); $('#groups-err').textContent = '';
  try { const r = await api('/api/groups', { body: { name: $('#create-name').value, emoji: $('#create-emoji').value } }); S.groupId = r.group.id; $('#create-name').value = '';
    await refreshMe(); await loadGroup(); closeSheets(); toast(`Group created! Invite code: ${r.group.code}`, 'y'); setView('chat'); }
  catch (err) { $('#groups-err').textContent = err.message; }
};
$('#notif-btn').onclick = enableAlerts;

function renderBoard() {
  $('#board-list').innerHTML = S.leaderboard.length ? S.leaderboard.map((r, i) => `<div class="board-row"><span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
    <span class="avatar" style="background:${r.user.color}">${esc(r.user.name[0].toUpperCase())}</span>
    <span class="grow"><b>${esc(r.user.name)}</b><br><small>${r.finds} found · ${r.hides} hidden · ${r.escapes} escaped</small></span><span class="pts">${r.points}</span></div>`).join('')
    : '<div class="empty">No players yet</div>';
}

// ---------- chat ----------
function renderChat() {
  $('#chat-title').textContent = S.group ? `${S.group.emoji} ${S.group.name}` : 'No group';
  $('#chat-sub').textContent = S.group ? `${S.group.members.length} players · code ${S.group.code}` : '';
  const f = $('#chat-feed');
  if (!S.group) { f.innerHTML = '<div class="empty">Create or join a group to start playing.</div>'; return; }
  f.innerHTML = S.messages.map(m => {
    if (m.type === 'system') return `<div class="sys">${esc(m.text)}</div>`;
    if (m.type === 'hide' || m.type === 'ping' || m.type === 'found' || m.type === 'move') {
      const h = S.hides.find(x => x.id === m.hideId);
      const img = m.photo || h?.photo;
      const sub = m.type === 'hide' && m.firstPingAt ? `First ping at ${fmtTime(m.firstPingAt)} · tap to view` : fmtTime(m.createdAt);
      return `<button class="card ${m.type}" data-hide="${m.hideId}">${img ? `<img src="${img}" alt="">` : ''}<div class="grow" style="text-align:left"><div class="t">${esc(m.text)}</div><div class="s">${sub}</div></div></button>`;
    }
    const me = m.userId === S.user.id;
    return `<div class="msg ${me ? 'me' : ''}" style="color:${me ? 'var(--accent)' : m.user?.color || '#4FB7FF'}"><div class="who">${me ? 'Me' : esc(m.user?.name)}</div>
      <div class="bubble">${esc(m.text)}${m.photo ? `<img class="chat-photo" src="${m.photo}" alt="">` : ''}</div></div>`;
  }).join('') || '<div class="empty">Say hi 👋</div>';
  $$('#chat-feed [data-hide]').forEach(b => b.onclick = () => openStory(b.dataset.hide));
  scrollChat();
}
const scrollChat = () => { const f = $('#chat-feed'); f.scrollTop = f.scrollHeight; };
$('#chat-form').onsubmit = async e => {
  e.preventDefault(); const t = $('#chat-input').value.trim(); if (!t || !S.groupId) return;
  $('#chat-input').value = '';
  const fd = new FormData(); fd.append('text', t);
  try { await api(`/api/groups/${S.groupId}/messages`, { body: fd }); } catch (err) { toast(err.message); }
};
$('#chat-cam').onclick = () => $('#chat-file').click();
$('#chat-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S.groupId) return;
  const fd = new FormData(); fd.append('photo', await shrink(f), 'snap.jpg'); fd.append('text', $('#chat-input').value.trim()); $('#chat-input').value = '';
  try { await api(`/api/groups/${S.groupId}/messages`, { body: fd }); } catch (err) { toast(err.message); }
};
$('#share-code').onclick = async () => {
  if (!S.group) return;
  const url = `${location.origin}/?join=${S.group.code}`;
  const text = `Join my PeekaSnap group "${S.group.name}"! Code: ${S.group.code}`;
  if (navigator.share) { try { await navigator.share({ title: 'PeekaSnap', text, url }); return; } catch (_) {} }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Invite link copied 📋', 'y'); } catch (_) { prompt('Share this invite:', `${text} ${url}`); }
};

// ---------- main map ----------
let map, meMarker, hideLayer;
// OpenStreetMap tiles, darkened with a CSS filter (.leaflet-tile-pane) to match the black theme
const tiles = () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
const AREA_STYLE = { color: '#FF2D46', weight: 2, dashArray: '6 8', fillColor: '#FF2D46', fillOpacity: 0.08 };
const emojiIcon = (e, size = 30) => L.divIcon({ className: '', html: `<div class="emoji-marker">${e}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView([37.7749, -122.4194], 13);
  tiles().addTo(map);
  hideLayer = L.layerGroup().addTo(map);
  renderMapHides(); updateMeMarker();
}
function updateMeMarker() {
  if (!map || !S.myLoc) return;
  const ll = [S.myLoc.lat, S.myLoc.lng];
  if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng(ll);
}
function renderMapHides() {
  if (!map) return;
  hideLayer.clearLayers();
  for (const h of S.hides) {
    const active = h.status === 'active';
    if (!active && Date.now() - h.createdAt > 864e5) continue;
    L.circle([h.center.lat, h.center.lng], { ...AREA_STYLE, radius: h.radius, color: active ? '#FF2D46' : '#666', fillOpacity: active ? 0.08 : 0.03 }).addTo(hideLayer);
    const last = h.pings[h.pings.length - 1];
    if (last && active && h.hintOutdated) L.circle([last.center.lat, last.center.lng], { radius: last.radius, color: '#888', weight: 2, dashArray: '3 6', fill: false }).addTo(hideLayer)
      .bindTooltip('Old hint - the object was moved!', { permanent: false });
    else if (last && active) L.circle([last.center.lat, last.center.lng], { radius: last.radius, color: '#FFFFFF', weight: 4, fillColor: '#FF1A3C', fillOpacity: 0.38, className: 'hint-pulse' }).addTo(hideLayer)
      .bindTooltip(`Ping ${last.n}: it's in here!`, { permanent: false });
    const m = L.marker([h.center.lat, h.center.lng], { icon: L.divIcon({ className: '', html: `<div class="hide-marker"><img src="${h.photo}"></div>`, iconSize: [46, 46], iconAnchor: [23, 23] }) }).addTo(hideLayer);
    m.on('click', () => openStory(h.id));
    if (h.spot) L.marker([h.spot.lat, h.spot.lng], { icon: emojiIcon(h.status === 'found' ? '✅' : '🫣') }).addTo(hideLayer).bindTooltip(h.isHider && active ? 'Your hiding spot (only you see this)' : 'Hiding spot');
  }
}
function fitGroup() {
  const act = activeHides();
  if (act.length) {
    const b = L.latLngBounds([]); act.forEach(h => b.extend(L.latLng(h.center.lat, h.center.lng).toBounds(h.radius * 2)));
    map.fitBounds(b, { padding: [30, 30] });
  } else if (S.myLoc) map.setView([S.myLoc.lat, S.myLoc.lng], 16);
  else getLoc().then(l => map.setView([l.lat, l.lng], 16)).catch(() => {});
}
function focusHide(hid) {
  const h = S.hides.find(x => x.id === hid); if (!h) return;
  setView('map'); closeStory();
  const last = h.pings[h.pings.length - 1];
  const c = last || { center: h.center, radius: h.radius };
  setTimeout(() => map.fitBounds(L.latLng(c.center.lat, c.center.lng).toBounds(c.radius * 2.4)), 80);
}
$('#locate-btn').onclick = () => getLoc().then(l => map.setView([l.lat, l.lng], 17)).catch(e => toast(e.message));

// ---------- create hide ----------
let hmap, centerM, spotM, areaC;
function openHideSheet() {
  $('#hide-sheet').classList.remove('hidden'); $('#hide-err').textContent = '';
  $('#hide-group-name').textContent = `${S.group.emoji} ${S.group.name}`;
  const start = S.myLoc || { lat: 37.7749, lng: -122.4194 };
  if (!hmap) {
    hmap = L.map('hide-map', { zoomControl: false, attributionControl: false }).setView([start.lat, start.lng], 16);
    tiles().addTo(hmap);
    centerM = L.marker([start.lat, start.lng], { draggable: true, icon: emojiIcon('🎯') }).addTo(hmap);
    spotM = L.marker([start.lat, start.lng], { draggable: true, icon: emojiIcon('🫣', 34), zIndexOffset: 500 }).addTo(hmap);
    areaC = L.circle([start.lat, start.lng], { ...AREA_STYLE, radius: +$('#hide-radius').value, fillOpacity: 0.18 }).addTo(hmap);
    centerM.on('drag', () => areaC.setLatLng(centerM.getLatLng()));
    hmap.on('click', e => spotM.setLatLng(e.latlng));
  } else {
    centerM.setLatLng([start.lat, start.lng]); spotM.setLatLng([start.lat, start.lng]); areaC.setLatLng([start.lat, start.lng]);
    hmap.setView([start.lat, start.lng], 16);
  }
  setTimeout(() => { hmap.invalidateSize(); fitArea(); }, 120);
  if (!S.myLoc) getLoc().then(l => { centerM.setLatLng([l.lat, l.lng]); spotM.setLatLng([l.lat, l.lng]); areaC.setLatLng([l.lat, l.lng]); fitArea(); }).catch(e => $('#hide-err').textContent = e.message + ' - drag the markers to set the area.');
}
const fitArea = () => hmap.fitBounds(areaC.getBounds(), { padding: [10, 10] });
$('#hide-radius').oninput = e => { const r = +e.target.value; areaC.setRadius(r); $('#radius-val').textContent = r >= 1000 ? (r / 1000).toFixed(1) + ' km' : r + ' m'; };
$('#hide-radius').onchange = fitArea;
$('#hz-center-me').onclick = () => getLoc().then(l => { centerM.setLatLng([l.lat, l.lng]); areaC.setLatLng([l.lat, l.lng]); fitArea(); }).catch(e => toast(e.message));
$('#hz-spot-me').onclick = () => getLoc().then(l => { spotM.setLatLng([l.lat, l.lng]); toast(`Spot saved (±${Math.round(l.acc)} m) 🫣`); }).catch(e => toast(e.message));
$('#first-ping').onchange = e => $('#first-ping-at').classList.toggle('hidden', e.target.value !== 'custom');
$('#hide-form').onsubmit = async e => {
  e.preventDefault(); $('#hide-err').textContent = '';
  const c = centerM.getLatLng(), s = spotM.getLatLng(), r = +$('#hide-radius').value;
  if (c.distanceTo(s) > r) return $('#hide-err').textContent = 'The 🫣 hiding spot has to be inside the red play area.';
  let first = $('#first-ping').value;
  const minAt = Date.now() + S.minPingDelayMs;
  const firstPingAt = first === 'custom' ? new Date($('#first-ping-at').value).getTime() : Date.now() + first * 60000;
  if (!Number.isFinite(firstPingAt) || firstPingAt < minAt - 1000) return $('#hide-err').textContent = `The first ping has to be at least ${Math.round(S.minPingDelayMs / 60000)} min from now.`;
  const fd = new FormData();
  fd.append('photo', await shrink(S.snap), 'object.jpg');
  Object.entries({ object: $('#hide-object').value, centerLat: c.lat, centerLng: c.lng, radius: r, spotLat: s.lat, spotLng: s.lng,
    firstPingAt, intervalMin: $('#ping-interval').value, pingCount: $('#ping-count').value }).forEach(([k, v]) => fd.append(k, v));
  const btn = $('#hide-submit'); btn.disabled = true; btn.textContent = 'Hiding…';
  try {
    const r2 = await api(`/api/groups/${S.groupId}/hides`, { body: fd });
    closeSheets(); S.snap = null; $('#hide-object').value = '';
    toast('Hidden! Your friends have been notified 🫣', 'y'); openStory(r2.hide.id);
  } catch (err) { $('#hide-err').textContent = err.message; }
  btn.disabled = false; btn.textContent = 'Hide it & start the hunt';
};

// ---------- move / rename (hider, once per ping) ----------
let mmap, mSpot, mArea, mOrig, moveId = null, moveBlob = null;
function openMoveSheet(hid) {
  const h = S.hides.find(x => x.id === hid);
  if (!h || !h.canMove) return toast('You can move it once after each ping');
  moveId = hid; moveBlob = null; closeStory();
  $('#move-sheet').classList.remove('hidden'); $('#move-err').textContent = '';
  $('#move-ping-n').textContent = `${h.pings.length}/${h.pingCount}`;
  $('#move-deadline').textContent = h.nextPingAt ? ` (${fmtTime(h.nextPingAt)})` : ' (the hunt ends at ' + fmtTime(h.endsAt) + ')';
  $('#move-object').value = h.object; $('#move-thumb').src = h.photo;
  mOrig = L.latLng(h.spot.lat, h.spot.lng);
  if (!mmap) {
    mmap = L.map('move-map', { zoomControl: false, attributionControl: false }).setView([h.center.lat, h.center.lng], 16);
    tiles().addTo(mmap);
    mArea = L.circle([h.center.lat, h.center.lng], { ...AREA_STYLE, radius: h.radius, fillOpacity: 0.15, interactive: false }).addTo(mmap);
    mSpot = L.marker(mOrig, { draggable: true, icon: emojiIcon('🫣', 34), zIndexOffset: 500 }).addTo(mmap);
    mmap.on('click', e => mSpot.setLatLng(e.latlng));
  }
  mArea.setLatLng([h.center.lat, h.center.lng]); mArea.setRadius(h.radius); mSpot.setLatLng(mOrig);
  setTimeout(() => { mmap.invalidateSize(); mmap.fitBounds(mArea.getBounds(), { padding: [10, 10] }); }, 120);
}
$('#mv-reset').onclick = () => mSpot.setLatLng(mOrig);
$('#mv-spot-me').onclick = () => getLoc().then(l => { mSpot.setLatLng([l.lat, l.lng]); toast(`New spot set (±${Math.round(l.acc)} m) 📍`); }).catch(e => toast(e.message));
$('#move-photo-btn').onclick = () => $('#move-file').click();
$('#move-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) { moveBlob = f; $('#move-thumb').src = URL.createObjectURL(f); } };
$('#move-form').onsubmit = async e => {
  e.preventDefault(); $('#move-err').textContent = '';
  const s2 = mSpot.getLatLng(), c = mArea.getLatLng();
  if (c.distanceTo(s2) > mArea.getRadius()) return $('#move-err').textContent = 'The new spot has to be inside the play area.';
  const fd = new FormData();
  if (s2.distanceTo(mOrig) > 1) { fd.append('spotLat', s2.lat); fd.append('spotLng', s2.lng); }
  fd.append('object', $('#move-object').value);
  if (moveBlob) fd.append('photo', await shrink(moveBlob), 'object.jpg');
  const b = $('#move-submit'); b.disabled = true; b.textContent = 'Saving…';
  try { const r = await api(`/api/hides/${moveId}/move`, { body: fd }); closeSheets(); toast('Updated! Seekers were told it changed 🔀', 'y'); openStory(r.hide.id); }
  catch (err) { $('#move-err').textContent = err.message; }
  b.disabled = false; b.textContent = 'Save changes';
};

// ---------- story viewer (hide detail) ----------
let openStoryId = null;
function openStory(id) { openStoryId = id; stopCamera(); $('#story').classList.remove('hidden'); renderStory(); }
function closeStory() { openStoryId = null; $('#story').classList.add('hidden'); if (S.view === 'camera') startCamera(); }
$('#story-close').onclick = closeStory;
function renderStory() {
  const h = S.hides.find(x => x.id === openStoryId); if (!h) return closeStory();
  $('#story-img').src = h.photo;
  $('#story-bars').innerHTML = Array.from({ length: h.pingCount }, (_, i) => `<i class="${i < h.pings.length ? 'on' : ''}"></i>`).join('');
  const a = $('#story-avatar'); a.textContent = h.hider.name[0].toUpperCase(); a.style.background = h.hider.color;
  $('#story-hider').textContent = h.isHider ? 'You hid this' : `${h.hider.name} hid this`;
  $('#story-time').textContent = `${fmtTime(h.createdAt)} · area ${h.radius >= 1000 ? (h.radius / 1000).toFixed(1) + ' km' : h.radius + ' m'} · ${h.pings.length}/${h.pingCount} pings${h.moveCount ? ` · moved/renamed ${h.moveCount}×` : ''}${h.hintOutdated && h.status === 'active' ? ' · ⚠️ hint out of date' : ''}`;
  $('#story-object').textContent = h.object;
  const st = $('#story-status');
  st.className = 'story-status ' + (h.status === 'found' ? 'found' : h.status === 'active' ? '' : 'over');
  st.textContent = h.status === 'found' ? `🏆 Found by ${h.foundBy?.name}` : h.status === 'escaped' ? '🏃 Nobody found it' : h.status === 'cancelled' ? 'Hunt ended' : '🔍 Hunt is on';
  renderCountdown();
  const claims = $('#story-claims');
  claims.innerHTML = (h.claims || []).map(c => `<div class="claim"><img src="${c.photo}"><div class="grow"><b>${esc(c.user.name)}</b> says they found it<div class="muted">${c.distance == null ? 'no GPS' : c.distance + ' m from your spot'}</div></div>
    <button class="ok" data-acc="${c.id}">✓</button><button class="no" data-rej="${c.id}">✕</button></div>`).join('');
  if (h.myClaim && h.myClaim.status === 'pending') claims.innerHTML = '<div class="claim"><div class="grow">⏳ Waiting for the hider to confirm your find…</div></div>';
  $$('[data-acc]').forEach(b => b.onclick = () => reviewClaim(h.id, b.dataset.acc, true));
  $$('[data-rej]').forEach(b => b.onclick = () => reviewClaim(h.id, b.dataset.rej, false));
  const act = $('#story-actions'); act.innerHTML = '';
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; act.appendChild(b); };
  btn('🗺️ Map', 'btn-glass', () => focusHide(h.id));
  if (h.status === 'active' && !h.isHider) {
    btn('🌡️ Hot/Cold', 'btn-glass', () => heatCheck(h));
    btn('🙌 I found it!', 'btn-red', () => { findTarget = h.id; $('#find-file').click(); });
  }
  if (h.canMove) btn('🔀 Move / rename', 'btn-red', () => openMoveSheet(h.id));
  if (h.status === 'active' && h.isHider) btn('End hunt', 'btn-glass', async () => { if (confirm('End this hunt now?')) { try { await api(`/api/hides/${h.id}/end`, { body: {} }); } catch (e) { toast(e.message); } } });
  if (h.foundPhoto) btn('📸 Proof', 'btn-glass', () => { $('#story-img').src = h.foundPhoto; });
}
function renderCountdown() {
  const h = S.hides.find(x => x.id === openStoryId); if (!h) return;
  const el = $('#story-countdown');
  if (h.status !== 'active') el.textContent = h.foundAt ? `Found at ${fmtTime(h.foundAt)}` : '';
  else if (h.nextPingAt) el.textContent = `📡 Ping ${h.pings.length + 1} in ${fmtIn(h.nextPingAt - Date.now())} (${fmtTime(h.nextPingAt)})${h.canMove ? ' · 🔀 you can move it until then' : ''}`;
  else el.textContent = `⏳ Last chance! Hunt ends in ${fmtIn(h.endsAt - Date.now())}`;
}
async function reviewClaim(hid, cid, accept) {
  try { await api(`/api/hides/${hid}/claims/${cid}`, { body: { accept } }); toast(accept ? 'Confirmed! 🏆' : 'Rejected - they keep hunting'); } catch (e) { toast(e.message); }
}
async function heatCheck(h) {
  try {
    const l = await getLoc();
    const r = await api(`/api/hides/${h.id}/heat`, { body: { lat: l.lat, lng: l.lng } });
    banner(`<div class="radar">${r.emoji}</div><div class="grow">You're ${r.band.toUpperCase()}!<div class="muted">One check per ping - use it wisely.</div></div>`);
  } catch (e) { toast(e.message); }
}
let findTarget = null;
$('#find-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !findTarget) return;
  toast('Checking your location… 📍');
  const fd = new FormData(); fd.append('photo', await shrink(f), 'found.jpg');
  try { const l = await getLoc(); fd.append('lat', l.lat); fd.append('lng', l.lng); fd.append('accuracy', l.acc); } catch (err) { toast(err.message); }
  try { const r = await api(`/api/hides/${findTarget}/find`, { body: fd }); r.result === 'accepted' ? (sonar(), banner(`<div class="radar">🏆</div><div class="grow">${esc(r.message)}</div>`)) : toast(r.message, 'y'); }
  catch (err) { toast(err.message); }
};

boot();
