/* PeekaSnap - Game mode 1: photo Hide & Seek (pings, 5-min delay, move/rename on ping, hot/cold, GPS find check, points) */
H.socket.push(s => {
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
    notify(`📡 Ping ${p.n}/${p.of}: ${p.object}`, mine ? 'Seekers got a new hint. Move or rename it before the next ping!' : `It's within ${p.hint.radius} m of the new circle. Tap to hunt!`, '/#play');
    if (!mine && !$('#game-map').classList.contains('hidden')) focusHide(p.hideId);
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
});
H.groupLoaded.push(() => { renderPlay(); renderStories(); renderMapHides(); renderBoard(); });
H.view.push(v => { if (v === 'play') { renderPlay(); renderStories(); } });
const activeHides = () => S.hides.filter(h => h.status === 'active');
function renderPlay() {
  $('#group-name').textContent = S.group ? `${S.group.emoji} ${S.group.name}` : 'Pick a group';
}
$('#group-pill').onclick = () => openSheet('groups');
$('#board-btn').onclick = () => openSheet('board');
function startHideFlow() {
  if (!S.group) { toast('Join or create a group first'); return openSheet('groups'); }
  setHideMode(true); setView('camera');
}
$('#hide-new').onclick = startHideFlow;
$('#mode-hide').onclick = startHideFlow;
$('#game-map-btn').onclick = () => openGameMap();

// ---------- game map (overlay) ----------
let gmap, hideLayer;
function openGameMap(noFit) {
  if (!S.group) { toast('Join or create a group first'); return openSheet('groups'); }
  stopCamera(); $('#game-map').classList.remove('hidden'); $('#gmap-group').textContent = S.group.name;
  if (!gmap) { gmap = L.map('gmap', { zoomControl: false }).setView([37.7749, -122.4194], 13); tiles().addTo(gmap); hideLayer = L.layerGroup().addTo(gmap); }
  setTimeout(() => { gmap.invalidateSize(); renderMapHides(); if (!noFit) fitGroup(); }, 60);
}
$('#gmap-close').onclick = () => { $('#game-map').classList.add('hidden'); if (S.view === 'camera') startCamera(); };
$('#gmap-locate').onclick = () => getLoc().then(l => gmap.setView([l.lat, l.lng], 17)).catch(e => toast(e.message));
let gMe;
H.loc.push(l => { if (!gmap) return; if (!gMe) gMe = L.marker([l.lat, l.lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(gmap); else gMe.setLatLng([l.lat, l.lng]); });

let boardT; function refreshBoard() { clearTimeout(boardT); boardT = setTimeout(async () => { if (!S.groupId) return; const r = await api('/api/groups/' + S.groupId); S.leaderboard = r.leaderboard; renderBoard(); }, 400); }
function renderStories() {
  const act = activeHides(), recent = S.hides.filter(h => h.status !== 'active').slice(0, 6);
  const card = h => `<button class="story-card" data-hide="${h.id}"><div class="story-ring ${h.status !== 'active' ? 'done' : ''}"><img src="${h.photo}" alt=""></div>
    <div class="lbl">${esc(h.isHider ? 'Your ' + h.object : h.object)}</div><div class="cd" data-cd="${h.id}">${cdText(h)}</div></button>`;
  const html = act.map(card).join('');
  $('#map-stories').innerHTML = html;
  $('#story-games').innerHTML = html || '<div class="empty small">No active hides. Start one from Play!</div>';
  $('#cam-stories').innerHTML = S.group ? `<button class="story-card" id="new-hide-story"><div class="story-new">＋</div><div class="lbl">Hide one</div></button>` + html + recent.map(card).join('') : '<div class="empty small">Pick or create a group to play</div>';
  $$('[data-hide]').forEach(b => b.onclick = () => openStory(b.dataset.hide));
  const nh = $('#new-hide-story'); if (nh) nh.onclick = startHideFlow;
  updatePlayDot();
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

function renderBoard() {
  $('#board-list').innerHTML = S.leaderboard.length ? S.leaderboard.map((r, i) => `<div class="board-row"><span class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
    <span class="avatar" style="background:${r.user.color}">${esc(r.user.name[0].toUpperCase())}</span>
    <span class="grow"><b>${esc(r.user.name)}</b><br><small>${r.finds} found · ${r.hides} hidden · ${r.escapes} escaped</small></span><span class="pts">${r.points}</span></div>`).join('')
    : '<div class="empty">No players yet</div>';
}

function renderMapHides() {
  if (!gmap) return;
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
    gmap.fitBounds(b, { padding: [30, 30] });
  } else if (S.myLoc) gmap.setView([S.myLoc.lat, S.myLoc.lng], 16);
  else getLoc().then(l => gmap.setView([l.lat, l.lng], 16)).catch(() => {});
}
function focusHide(hid) {
  const h = S.hides.find(x => x.id === hid); if (!h) return;
  closeStory(); openGameMap(true);
  const last = h.pings[h.pings.length - 1];
  const c = last || { center: h.center, radius: h.radius };
  setTimeout(() => gmap.fitBounds(L.latLng(c.center.lat, c.center.lng).toBounds(c.radius * 2.4)), 80);
}
// ---------- create hide ----------
let hmap, centerM, spotM, areaC;
function openHideSheet(blob) {
  S.snap = blob; $('#hide-thumb').src = URL.createObjectURL(blob);
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

