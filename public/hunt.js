/* PeekaSnap - Game mode 2: Manhunt (hunters vs runners, timed location pings, GPS tags) */
const HS = { hunt: null, skew: 0, unread: 0, claim: null, layers: null, pingMarkers: [], locTimer: null, ticker: null };
const sNow = () => Date.now() + HS.skew;
const ROLE = { hunter: '🎯 Hunter', runner: '🏃 Runner', spectator: '👀 Spectator', viewer: '👀 Not playing' };
const liveStatus = h => h && ['headstart', 'active'].includes(h.status);
const meIn = h => h && h.players.some(p => p.user.id === S.user.id);

async function loadHunt() {
  if (!S.groupId) return setHunt(null);
  try { const r = await api(`/api/groups/${S.groupId}/hunt`); setHunt(r.hunt); } catch (_) {}
}
function setHunt(h) {
  const prev = HS.hunt; HS.hunt = h;
  if (h?.serverNow) HS.skew = h.serverNow - Date.now();
  if (prev && h && prev.id !== h.id) HS.unread = 0;
  renderHuntCard(); syncLocLoop();
  if (!$('#hunt').classList.contains('hidden')) renderHunt();
  if (!$('#hunt-board').classList.contains('hidden')) renderHuntBoard();
}
H.groupLoaded.push(loadHunt);
H.view.push(v => { if (v === 'play') renderHuntCard(); });

// ---------- Play tab card ----------
function renderHuntCard() {
  const el = $('#play-hunt-card'), h = HS.hunt; if (!el) return;
  if (!S.group) { el.innerHTML = ''; return; }
  const runners = h ? h.players.filter(p => p.role === 'runner').length : 0;
  let body;
  if (!h || h.status === 'ended') {
    body = `<div class="grow"><b>🏃 Manhunt</b><div class="muted">${h ? (h.winner === 'cancelled' ? 'Last game was cancelled' : `Last game: ${h.winner === 'hunters' ? 'hunters' : 'runners'} won`) : 'Hunters vs runners with live map pings'}</div></div><button class="btn-red small" id="hc-new">Start lobby</button>`;
  } else if (h.status === 'lobby') {
    body = `<div class="grow"><b>🏃 Manhunt lobby</b><div class="muted">${h.players.length} player${h.players.length === 1 ? '' : 's'} · host ${esc(h.host.name)}</div></div><button class="btn-red small" id="hc-open">${meIn(h) ? 'Open' : 'Join'}</button>`;
  } else {
    body = `<div class="grow"><b><span class="live-dot"></span> Manhunt LIVE</b><div class="muted">${ROLE[h.myRole]} · ${runners} runner${runners === 1 ? '' : 's'} left · ends in ${fmtIn(h.endsAt - sNow())}</div></div><button class="btn-red small" id="hc-open">Open map</button>`;
  }
  el.innerHTML = `<div class="hunt-card-play ${liveStatus(h) ? 'live' : ''}">${body}</div>`;
  $('#hc-new')?.addEventListener('click', createHunt);
  $('#hc-open')?.addEventListener('click', openHunt);
  updatePlayDot();
}
$('#mode-hunt').onclick = () => {
  if (!S.group) { toast('Join or create a group first'); return openSheet('groups'); }
  HS.hunt && HS.hunt.status !== 'ended' ? openHunt() : createHunt();
};
async function createHunt() {
  const body = {};
  if (S.myLoc) body.center = { lat: S.myLoc.lat, lng: S.myLoc.lng };
  try { const r = await api(`/api/groups/${S.groupId}/hunts`, { body }); setHunt(r.hunt); openHunt(); }
  catch (e) { toast(e.message); loadHunt(); }
}

function updatePlayDot() {
  const h = HS.hunt, on = (liveStatus(h) && meIn(h)) || (h?.status === 'lobby' && !meIn(h)) || activeHides().some(x => !x.isHider);
  $('#play-dot').classList.toggle('hidden', !on || S.view === 'play');
}
H.view.push(updatePlayDot);

// ---------- overlay & map ----------
let huntMap;
function openHunt() {
  if (!HS.hunt) return;
  stopCamera(); $('#hunt').classList.remove('hidden');
  if (!huntMap) {
    huntMap = L.map('hmap', { zoomControl: false }).setView([37.7749, -122.4194], 15); tiles().addTo(huntMap);
    HS.layers = { area: L.layerGroup().addTo(huntMap), people: L.layerGroup().addTo(huntMap), pings: L.layerGroup().addTo(huntMap), me: null };
    huntMap.on('click', e => { const h = HS.hunt; if (h?.status === 'lobby' && h.isHost) saveSettings({ center: { lat: e.latlng.lat, lng: e.latlng.lng } }); });
  }
  if (HS.hunt.status !== 'lobby' && meIn(HS.hunt)) startWatch();
  setTimeout(() => { huntMap.invalidateSize(); renderHunt(true); }, 60);
  clearInterval(HS.ticker); HS.ticker = setInterval(tickHunt, 1000);
}
$('#hunt-close').onclick = () => { $('#hunt').classList.add('hidden'); clearInterval(HS.ticker); if (S.view === 'camera') startCamera(); };
$('#hunt-locate').onclick = () => getLoc().then(l => huntMap.setView([l.lat, l.lng], 17)).catch(e => toast(e.message));
H.loc.push(l => {
  if (!huntMap) return;
  if (!HS.layers.me) HS.layers.me = L.marker([l.lat, l.lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(huntMap);
  else HS.layers.me.setLatLng([l.lat, l.lng]);
});

function renderHunt(fit) {
  const h = HS.hunt; if (!h || !huntMap) return;
  const s = h.settings;
  HS.layers.area.clearLayers();
  if (s.center) {
    const c = L.circle([s.center.lat, s.center.lng], { ...AREA_STYLE, radius: s.radius, dashArray: h.status === 'lobby' ? '6 8' : null, weight: 3, fillOpacity: 0.06 }).addTo(HS.layers.area);
    if (fit) huntMap.fitBounds(c.getBounds(), { padding: [20, 20] });
  } else if (fit) getLoc().then(l => huntMap.setView([l.lat, l.lng], 16)).catch(() => {});
  renderPeople(); renderPings();
  const lobby = h.status === 'lobby';
  $('#hunt-lobby').classList.toggle('hidden', !lobby);
  $('#hunt-live').classList.toggle('hidden', lobby);
  if (lobby) renderLobby(); else renderLive();
  tickHunt();
}
function renderPeople() {
  const h = HS.hunt; HS.layers.people.clearLayers();
  for (const [uid, l] of Object.entries(h.locs || {})) {
    if (uid === S.user.id) continue;
    const p = h.players.find(x => x.user.id === uid); if (!p) continue;
    L.marker([l.lat, l.lng], { icon: personIcon(p.user, p.role) }).addTo(HS.layers.people);
  }
}
function renderPings() {
  const h = HS.hunt; HS.layers.pings.clearLayers();
  const fadeMs = Math.max(60000, h.settings.pingIntervalMin * 60000 * 1.5);
  const who = id => h.players.find(p => p.user.id === id)?.user || { name: '?', color: '#555' };
  const dot = (l, u, cls, label) => {
    const age = sNow() - (l.at || l.t);
    const op = Math.max(0.25, 1 - age / fadeMs);
    L.marker([l.lat, l.lng], { icon: L.divIcon({ className: '', html: `<div class="ping-marker ${cls}" style="opacity:${op.toFixed(2)}"><span style="background:${u.color}">${esc(u.name[0].toUpperCase())}</span><em>${esc(label)}</em></div>`, iconSize: [44, 60], iconAnchor: [22, 22] }) }).addTo(HS.layers.pings);
  };
  // newest fix per player only
  const latest = {};
  for (const p of h.pings) {
    for (const [u, l] of Object.entries(p.runners || {})) latest['r' + u] = { ...l, at: p.at, u, cls: 'runner', label: `${who(u).name} · ping ${p.n}` };
    for (const [u, l] of Object.entries(p.hunters || {})) latest['h' + u] = { ...l, at: p.at, u, cls: 'hunter', label: `${who(u).name} · ping ${p.n}` };
  }
  for (const r of h.reveals || []) latest['r' + r.userId] = { lat: r.lat, lng: r.lng, at: r.at, u: r.userId, cls: 'runner oob', label: `${r.user.name} · OUT!` };
  for (const v of Object.values(latest)) if (v.u !== S.user.id) dot(v, who(v.u), v.cls, v.label);
}

// ---------- lobby ----------
const SETTINGS_UI = [
  ['radius', 'Play area radius (m)', [100, 200, 300, 400, 600, 800, 1200, 2000]],
  ['durationMin', 'Game length', [10, 15, 20, 30, 45, 60, 90], 'min'],
  ['pingIntervalMin', 'Ping every', [1, 2, 3, 5, 10, 15], 'min'],
  ['firstPingMin', 'First ping after start', [1, 2, 3, 5, 10], 'min'],
  ['headStartMin', 'Runner head start', [0, 1, 2, 3, 5, 10], 'min'],
  ['hunterCount', 'Starting hunters', [1, 2, 3, 4, 5]],
];
function renderLobby() {
  const h = HS.hunt, s = h.settings, host = h.isHost, inGame = meIn(h);
  const opts = (k, vals, unit) => { const all = vals.includes(s[k]) ? vals : [...vals, s[k]].sort((a, b) => a - b); return all.map(v => `<option value="${v}" ${v === s[k] ? 'selected' : ''}>${v}${unit ? ' ' + unit : ''}</option>`).join(''); };
  const settings = host
    ? `<div class="hl-grid">${SETTINGS_UI.map(([k, label, vals, unit]) => `<label>${label}<select data-k="${k}">${opts(k, vals, unit)}</select></label>`).join('')}
        <label>Teams<select data-k="teamMode"><option value="random" ${s.teamMode === 'random' ? 'selected' : ''}>Random</option><option value="pick" ${s.teamMode === 'pick' ? 'selected' : ''}>Host picks</option></select></label>
        <label>Tagged runners become<select data-k="taggedBecome"><option value="hunter" ${s.taggedBecome === 'hunter' ? 'selected' : ''}>Hunters</option><option value="spectator" ${s.taggedBecome === 'spectator' ? 'selected' : ''}>Spectators</option></select></label>
        <label class="hl-check"><input type="checkbox" data-k="revealHunters" ${s.revealHunters ? 'checked' : ''}> Show hunters to runners at pings</label></div>
        <div class="map-tools"><button class="chip red" id="hl-center">🎯 Center area on me</button><span class="hint-text">or tap the map</span></div>`
    : `<div class="hl-summary">⭕ ${s.radius} m area · ⏱ ${s.durationMin} min · 📡 every ${s.pingIntervalMin} min (first at ${s.firstPingMin} min) · 🏁 ${s.headStartMin} min head start · ${s.teamMode === 'random' ? '🎲 random teams' : '👆 host picks teams'} · tagged → ${s.taggedBecome}s${s.revealHunters ? ' · hunters shown at pings' : ''}</div>`;
  const pick = host && s.teamMode === 'pick';
  const players = h.players.map(p => `<div class="hl-player">${avatarHtml(p.user)}<b class="grow">${esc(p.user.name)}${p.user.id === h.host.id ? ' <small>host</small>' : ''}</b>${
    s.teamMode === 'pick' ? (pick ? `<button class="chip ${p.role === 'hunter' ? 'red' : ''}" data-flip="${p.user.id}">${ROLE[p.role]}</button>` : `<span class="chip">${ROLE[p.role]}</span>`) : '<span class="chip">🎲</span>'}</div>`).join('');
  $('#hunt-lobby').innerHTML = `<div class="grab"></div><div class="hl-head"><h2>🏃 Manhunt lobby</h2><span class="muted">${h.players.length} player${h.players.length === 1 ? '' : 's'}</span></div>
    ${settings}
    <div class="section-title dark">Players</div><div class="hl-players">${players}</div>
    ${!s.center ? '<div class="hint-text warn">The host needs to set the play area.</div>' : ''}
    <div class="hl-actions">${inGame ? `<button class="btn-glass dark" id="hl-leave">${host ? 'Cancel game' : 'Leave'}</button>` : `<button class="btn-red" id="hl-join">Join game</button>`}
    ${host ? `<button class="btn-red" id="hl-start" ${h.players.length < 2 || !s.center ? 'disabled' : ''}>🏁 Start</button>` : (inGame ? '<span class="muted">Waiting for the host to start…</span>' : '')}</div>
    <div class="hint-text">📍 Your location is only shared while a manhunt is running.</div>`;
  $$('#hunt-lobby [data-k]').forEach(el => el.onchange = () => saveSettings({ [el.dataset.k]: el.type === 'checkbox' ? el.checked : (el.tagName === 'SELECT' && !isNaN(+el.value) ? +el.value : el.value) }));
  $('#hl-center')?.addEventListener('click', () => getLoc().then(l => saveSettings({ center: { lat: l.lat, lng: l.lng } }), e => toast(e.message)));
  $$('#hunt-lobby [data-flip]').forEach(b => b.onclick = () => {
    const p = h.players.find(x => x.user.id === b.dataset.flip);
    huntPost('teams', { roles: { [p.user.id]: p.role === 'hunter' ? 'runner' : 'hunter' } });
  });
  $('#hl-join')?.addEventListener('click', () => huntPost('join'));
  $('#hl-leave')?.addEventListener('click', async () => { await huntPost('leave'); if (h.isHost) $('#hunt').classList.add('hidden'); loadHunt(); });
  $('#hl-start')?.addEventListener('click', () => huntPost('start'));
}
async function huntPost(path, body = {}) {
  try { const r = await api(`/api/hunts/${HS.hunt.id}/${path}`, { body }); if (r.hunt) setHunt(r.hunt); return r; }
  catch (e) { toast(e.message); }
}
const saveSettings = b => huntPost('settings', b);

// ---------- live game ----------
function renderLive() {
  const h = HS.hunt, s = h.settings;
  const runners = h.players.filter(p => p.role === 'runner').length, hunters = h.players.filter(p => p.role === 'hunter').length;
  const me = h.players.find(p => p.user.id === S.user.id);
  let html = '';
  if (h.status === 'ended') {
    const top = h.scoreboard[0];
    html = `<div class="hb-big">${h.winner === 'hunters' ? '🎯 Hunters win!' : h.winner === 'runners' ? '🏃 Runners win!' : 'Game cancelled'}</div>${top ? `<div class="muted">MVP: ${esc(top.user.name)} · ${top.points} pts</div>` : ''}`;
  } else {
    html = `<div class="hb-row"><span>🏃 ${runners} runner${runners === 1 ? '' : 's'}</span><span>🎯 ${hunters} hunter${hunters === 1 ? '' : 's'}</span><span>📡 ${h.pings.length} ping${h.pings.length === 1 ? '' : 's'}</span></div>`;
    if (me?.outOfBounds) html += `<div class="hb-warn">⚠️ You're OUTSIDE the play area. Hunters can see you!</div>`;
    if (me?.role === 'spectator') html += `<div class="muted">You're spectating${me.taggedBy ? ` (tagged by ${esc(me.taggedBy.name)})` : ''}.</div>`;
  }
  const pend = h.tags.filter(t => t.status === 'pending' && t.runner?.id === S.user.id && h.status === 'active')[0];
  if (pend) html += `<div class="hb-claim">🎯 <b>${esc(pend.hunter.name)}</b> says they tagged you.<div><button class="chip red" data-claim="1">Yes, I'm tagged</button><button class="chip" data-claim="0">No, missed</button></div></div>`;
  $('#hunt-banner').innerHTML = html;
  $$('#hunt-banner [data-claim]').forEach(b => b.onclick = () => huntPost('tags/' + pend.id, { accept: b.dataset.claim === '1' }));
  const tag = $('#hunt-tag');
  tag.classList.toggle('hidden', h.myRole !== 'hunter' || h.status === 'ended');
  tag.disabled = h.status !== 'active';
  $('#hunt-chat-dot').classList.toggle('hidden', !HS.unread);
}
function tickHunt() {
  const h = HS.hunt; if (!h) return;
  const st = $('#hunt-status');
  const role = `<span class="role-badge ${h.myRole}">${ROLE[h.myRole]}</span>`;
  let line = '';
  if (h.status === 'lobby') line = 'Lobby · waiting to start';
  else if (h.status === 'headstart') line = `${h.myRole === 'hunter' ? 'Hunters released in' : 'Head start'} <b>${fmtClock(h.huntStartAt - sNow())}</b>`;
  else if (h.status === 'active') line = `📡 Ping in <b>${fmtClock(h.nextPingAt - sNow())}</b> · ⏱ <b>${fmtClock(h.endsAt - sNow())}</b>`;
  else line = 'Game over';
  st.innerHTML = `${role}<span class="hs-line">${line}</span>`;
  if (h.status === 'headstart') $('#hunt-tag').textContent = `🔒 ${fmtClock(h.huntStartAt - sNow())}`;
  else $('#hunt-tag').textContent = '🎯 TAG';
}
const fmtClock = ms => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000), m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`; };
setInterval(() => { if (liveStatus(HS.hunt) && S.view === 'play') renderHuntCard(); if (huntMap && !$('#hunt').classList.contains('hidden') && HS.hunt?.pings.length) renderPings(); }, 15000);

// tags need the freshest fix we can get (the cached watch position can lag a few seconds)
function freshLoc() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return getLoc(8000).then(res, rej);
    navigator.geolocation.getCurrentPosition(p => { setMyLoc(p); res(S.myLoc); }, () => getLoc(8000).then(res, rej), { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 });
  });
}
$('#hunt-tag').onclick = async () => {
  const btn = $('#hunt-tag'); btn.disabled = true;
  try {
    const l = await freshLoc();
    try {
      const r = await api(`/api/hunts/${HS.hunt.id}/tag`, { body: { lat: l.lat, lng: l.lng } });
      sonar(); navigator.vibrate?.([80, 40, 200]); toast(r.message, 'y');
    } catch (e) {
      if (/No runner within/.test(e.message)) return openClaimPicker(l, e.message);
      toast(e.message);
    }
  } catch (e) { toast(e.message); }
  finally { btn.disabled = HS.hunt?.status !== 'active'; }
};
function openClaimPicker(l, why) {
  const runners = HS.hunt.players.filter(p => p.role === 'runner');
  $('#hunt-banner').innerHTML = `<div class="hb-claim">${esc(why)}<div class="muted">Tagged someone GPS missed? Ask them to confirm:</div><div class="claim-list">${runners.map(p => `<button class="chip" data-rid="${p.user.id}">${avatarHtml(p.user)} ${esc(p.user.name)}</button>`).join('')}<button class="chip" data-rid="">Cancel</button></div></div>`;
  $$('#hunt-banner [data-rid]').forEach(b => b.onclick = async () => {
    if (!b.dataset.rid) return renderLive();
    try { const r = await api(`/api/hunts/${HS.hunt.id}/tag`, { body: { lat: l.lat, lng: l.lng, runnerId: b.dataset.rid } }); toast(r.message, 'y'); } catch (e) { toast(e.message); }
    renderLive();
  });
}

// location: sent only while a manhunt is in head start / active and I'm playing
function syncLocLoop() {
  const h = HS.hunt, on = liveStatus(h) && meIn(h) && h.myRole !== 'spectator';
  if (on && !HS.locTimer) { startWatch(); sendLoc(); HS.locTimer = setInterval(sendLoc, 4000); }
  if (!on && HS.locTimer) { clearInterval(HS.locTimer); HS.locTimer = null; }
}
async function sendLoc() {
  const h = HS.hunt; if (!liveStatus(h)) return;
  const l = S.myLoc && Date.now() - S.myLoc.t < 20000 ? S.myLoc : await getLoc(6000).catch(() => null);
  if (!l) return;
  try { await api(`/api/hunts/${h.id}/location`, { body: { lat: l.lat, lng: l.lng } }); } catch (_) {}
}

// ---------- scoreboard & host tools ----------
$('#hunt-board-btn').onclick = () => { $('#hunt-board').classList.remove('hidden'); renderHuntBoard(); };
function renderHuntBoard() {
  const h = HS.hunt; if (!h) return;
  $('#hunt-board-list').innerHTML = h.scoreboard.map((r, i) => `<div class="board-row"><span class="rank">${i + 1}</span>${avatarHtml(r.user)}<span class="grow"><b>${esc(r.user.name)}</b><br><small>${ROLE[r.role]} · ${r.tags} tag${r.tags === 1 ? '' : 's'} · ${r.pingsSurvived} ping${r.pingsSurvived === 1 ? '' : 's'} survived${r.survived ? ' · survived 🏅' : ''}</small></span><b class="pts">${r.points}</b></div>`).join('');
  $('#hunt-host-tools').innerHTML = h.isHost && h.status !== 'ended' ? '<button class="btn-glass dark" id="hunt-end">⏹ End game for everyone</button>' : (h.status === 'ended' ? '<button class="btn-red" id="hunt-again">🔁 New game</button>' : '');
  $('#hunt-end')?.addEventListener('click', () => { if (confirm('End this manhunt for everyone?')) huntPost('end'); });
  $('#hunt-again')?.addEventListener('click', () => { $('#hunt-board').classList.add('hidden'); createHunt(); });
}

// ---------- game chat ----------
$('#hunt-chat-btn').onclick = async () => {
  $('#hunt-chat').classList.remove('hidden'); HS.unread = 0; $('#hunt-chat-dot').classList.add('hidden');
  try { const r = await api('/api/chats/hunt_' + HS.hunt.id); HS.feed = r.messages; renderHuntFeed(); } catch (e) { toast(e.message); }
};
function renderHuntFeed() {
  const el = $('#hunt-feed');
  el.innerHTML = (HS.feed || []).map(m => m.type === 'chat'
    ? `<div class="msg ${m.userId === S.user.id ? 'mine' : ''}">${m.userId === S.user.id ? '' : `<div class="who" style="color:${m.user?.color}">${esc(m.user?.name)}</div>`}<div class="bubble">${esc(m.text)}</div></div>`
    : `<div class="sys">${esc(m.text)}</div>`).join('') || '<div class="empty dark">Talk trash here 😈</div>';
  el.scrollTop = el.scrollHeight;
}
$('#hunt-chat-form').onsubmit = async e => {
  e.preventDefault(); const i = $('#hunt-chat-input'), text = i.value.trim(); if (!text) return; i.value = '';
  try { await api(`/api/chats/hunt_${HS.hunt.id}/messages`, { body: { text } }); } catch (err) { toast(err.message); }
};
H.message.push(m => {
  if (!HS.hunt || m.chatId !== 'hunt_' + HS.hunt.id) return;
  if (!$('#hunt-chat').classList.contains('hidden')) { HS.feed = [...(HS.feed || []).filter(x => x.id !== m.id), m]; renderHuntFeed(); }
  else if (m.userId && m.userId !== S.user.id) { HS.unread++; $('#hunt-chat-dot').classList.remove('hidden'); }
});

// ---------- realtime ----------
H.socket.push(s => {
  s.on('connect', loadHunt);
  s.on('hunt', h => { if (h.groupId === S.groupId) setHunt(h); });
  s.on('hunt:start', d => {
    sonar(); navigator.vibrate?.([200, 100, 200]);
    banner(`<div class="radar">🏁</div><div class="grow">Manhunt started!<div class="muted">You're a ${d.role === 'hunter' ? 'HUNTER. Wait for the head start to end.' : 'RUNNER. Run!'}</div></div>`, 8000);
    notify('🏁 Manhunt started!', d.role === 'hunter' ? "You're a hunter" : "You're a runner. Go!", '/#play');
    openHunt();
  });
  s.on('hunt:go', () => { sonar(); navigator.vibrate?.([300, 100, 300]); banner(`<div class="radar">🔓</div><div class="grow">Hunters released!</div>`); notify('🔓 Hunters released!', 'The head start is over', '/#play'); });
  s.on('hunt:ping', d => {
    sonar(); navigator.vibrate?.([200, 100, 200, 100, 400]);
    const n = Object.keys(d.runners || {}).length;
    const msg = d.role === 'runner' ? 'Hunters just saw your location. Move!' : `${n} runner location${n === 1 ? '' : 's'} on the map`;
    banner(`<div class="radar">📡</div><div class="grow">PING ${d.n}<div class="muted">${msg}</div></div>`, 7000);
    notify(`📡 Manhunt ping ${d.n}`, msg, '/#play');
    if (d.role !== 'runner' && n && huntMap && !$('#hunt').classList.contains('hidden')) {
      const b = L.latLngBounds(Object.values(d.runners).map(l => [l.lat, l.lng])); if (S.myLoc) b.extend([S.myLoc.lat, S.myLoc.lng]);
      huntMap.fitBounds(b.pad(0.4), { maxZoom: 18 });
    }
  });
  s.on('hunt:reveal', r => { if (!HS.hunt) return; HS.hunt.reveals = [...(HS.hunt.reveals || []), r]; renderPings(); toast(`⚠️ ${r.user.name} is out of bounds. Revealed!`, 'y'); });
  s.on('hunt:oob', () => { sonar(); navigator.vibrate?.([500, 100, 500]); banner(`<div class="radar">⚠️</div><div class="grow">OUT OF BOUNDS!<div class="muted">Get back inside the circle. Hunters can see you.</div></div>`, 8000); });
  s.on('hunt:loc', d => { if (!HS.hunt) return; HS.hunt.locs = { ...HS.hunt.locs, [d.userId]: d }; if (huntMap) renderPeople(); });
  s.on('hunt:tag-claim', d => { sonar(); navigator.vibrate?.([200, 80, 200]); notify('🎯 Were you tagged?', `${d.hunter.name} says they tagged you`, '/#play'); openHunt(); });
  s.on('hunt:tagged', d => {
    const meR = d.runner.id === S.user.id, meH = d.hunter.id === S.user.id;
    sonar(); navigator.vibrate?.([100, 50, 300]);
    banner(`<div class="radar">🎯</div><div class="grow">${meH ? 'You tagged' : esc(d.hunter.name) + ' tagged'} ${meR ? 'YOU' : esc(d.runner.name)}!<div class="muted">${d.left} runner${d.left === 1 ? '' : 's'} left</div></div>`);
  });
  s.on('hunt:end', d => {
    sonar(); banner(`<div class="radar">🏆</div><div class="grow">${d.winner === 'hunters' ? 'Hunters win!' : d.winner === 'runners' ? 'Runners win!' : 'Manhunt cancelled'}</div>`, 9000);
    if (d.winner !== 'cancelled') { $('#hunt-board').classList.remove('hidden'); setTimeout(renderHuntBoard, 300); }
  });
});
