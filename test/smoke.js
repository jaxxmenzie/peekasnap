// End-to-end smoke test: spins up a throwaway server and plays a full round with two players.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { io } = require('socket.io-client');
const PORT = 3999, BASE = `http://localhost:${PORT}`, MIN = 4000; // MIN = ping delay after marking a spot (5 min in prod, shortened here)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekasnap-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, DATA_DIR: dir, UPLOAD_DIR: path.join(dir, 'up'), TICK_MS: 300, MIN_PING_DELAY_MS: MIN }, stdio: 'inherit' });
let srv2;
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${m}`); };
async function api(p, { token, body, form } = {}) {
  const o = { method: body || form ? 'POST' : 'GET', headers: { 'x-token': token || '' } };
  if (form) { const fd = new FormData(); for (const [k, v] of Object.entries(form)) k === 'photo' ? fd.append(k, new Blob([JPG], { type: 'image/jpeg' }), 'p.jpg') : fd.append(k, String(v)); o.body = fd; }
  else if (body) { o.body = JSON.stringify(body); o.headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, o); return { status: r.status, ...(await r.json()) };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 10000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
// a spot in Golden Gate Park and a point ~10 m / ~150 m away
const CENTER = { lat: 37.7694, lng: -122.4862 }, SPOT = { lat: 37.7700, lng: -122.4850 };
const NEAR = { lat: SPOT.lat + 0.00009, lng: SPOT.lng }, FAR = { lat: SPOT.lat + 0.00135, lng: SPOT.lng };

(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/healthz'); break; } catch { await wait(150); } }
  const a = await api('/api/signup', { body: { name: 'Hider Hana' } });
  const b = await api('/api/signup', { body: { name: 'Seeker Sam' } });
  ok(a.token && b.token, 'sign up two players with just a name');
  const g = (await api('/api/groups', { token: a.token, body: { name: 'Park Crew', emoji: '🌳' } })).group;
  ok(g && /^[A-Z0-9]{6}$/.test(g.code), `create group -> join code ${g.code}`);
  const g2 = (await api('/api/groups', { token: a.token, body: { name: 'School Squad' } })).group;
  const j = await api('/api/groups/join', { token: b.token, body: { code: g.code.toLowerCase() } });
  ok(j.group?.id === g.id, 'seeker joins by code');
  ok((await api('/api/groups/join', { token: b.token, body: { code: 'ZZZZZZ' } })).status === 404, 'bad join code rejected');
  ok((await api('/api/me', { token: a.token })).groups.length === 2, 'hider has two groups to switch between');
  ok((await api('/api/groups/' + g2.id, { token: b.token })).status === 403, 'non-member cannot read another group');

  const sb = io(BASE, { auth: { token: b.token } }); await once(sb, 'connect');
  const hideEvt = once(sb, 'hide');
  const bad = await api(`/api/groups/${g.id}/hides`, { token: a.token, form: { photo: 1, object: 'Duck', centerLat: CENTER.lat, centerLng: CENTER.lng, radius: 50, spotLat: FAR.lat, spotLng: FAR.lng, intervalMin: 1, pingCount: 2 } });
  ok(bad.status === 400, 'spot outside play area rejected: ' + bad.error);
  const tReq = Date.now();
  const created = await api(`/api/groups/${g.id}/hides`, { token: a.token, form: { photo: 1, object: 'Red rubber duck', centerLat: CENTER.lat, centerLng: CENTER.lng, radius: 400, spotLat: SPOT.lat, spotLng: SPOT.lng, firstPingAt: Date.now() + 1500, intervalMin: 0.05, pingCount: 3 } });
  const hid = created.hide?.id;
  ok(hid && created.hide.spot, 'hider creates a hide (photo + area + spot + ping schedule) and sees the spot');
  ok(created.hide.firstPingAt >= tReq + MIN, `first ping asked for +1.5 s is pushed to >= ${MIN} ms after the spot is marked (got +${created.hide.firstPingAt - tReq} ms)`);
  const seen = await hideEvt;
  ok(seen.id === hid && seen.spot === undefined, 'seeker gets realtime hide event WITHOUT the secret spot');
  ok((await api(`/api/hides/${hid}/heat`, { token: b.token, body: NEAR })).status === 400, 'hot/cold locked before first ping');

  const t0 = Date.now(); const ping = await once(sb, 'ping', 10000);
  ok(ping.hideId === hid && ping.n === 1, `ping #1 fired on schedule (+${Date.now() - t0} ms), hint circle r=${ping.hint.radius} m`);
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dist = (p, q) => 2 * R * Math.asin(Math.sqrt(Math.sin(toR(q.lat - p.lat) / 2) ** 2 + Math.cos(toR(p.lat)) * Math.cos(toR(q.lat)) * Math.sin(toR(q.lng - p.lng) / 2) ** 2));
  ok(dist(ping.hint.center, SPOT) <= ping.hint.radius, 'hint circle contains the hidden spot');
  const heat = await api(`/api/hides/${hid}/heat`, { token: b.token, body: FAR });
  ok(heat.band === 'warm', `hot/cold from ~150 m away -> ${heat.band} ${heat.emoji}`);
  ok((await api(`/api/hides/${hid}/heat`, { token: b.token, body: FAR })).status === 429, 'only one hot/cold check per ping');
  const ping2 = await once(sb, 'ping', 8000);
  ok(ping2.n === 2 && ping2.hint.radius < ping.hint.radius, `ping #2 fired, circle shrank ${ping.hint.radius} -> ${ping2.hint.radius} m`);

  const far = await api(`/api/hides/${hid}/find`, { token: b.token, form: { photo: 1, lat: FAR.lat, lng: FAR.lng } });
  ok(far.result === 'pending', 'find claim 150 m away -> pending hider review');
  const hv = (await api(`/api/hides/${hid}`, { token: a.token })).hide;
  ok(hv.claims.length === 1 && hv.claims[0].distance > 100, `hider sees claim (${hv.claims[0].distance} m away)`);
  await api(`/api/hides/${hid}/claims/${hv.claims[0].id}`, { token: a.token, body: { accept: false } });
  ok((await api(`/api/hides/${hid}`, { token: b.token })).hide.status === 'active', 'hider rejects -> hunt continues');

  const foundEvt = once(sb, 'found');
  const near = await api(`/api/hides/${hid}/find`, { token: b.token, form: { photo: 1, lat: NEAR.lat, lng: NEAR.lng } });
  ok(near.result === 'accepted', 'find claim ~10 m away -> auto-accepted (within 25 m)');
  ok((await foundEvt).finder.name === 'Seeker Sam', 'everyone gets realtime "found" event');
  const grp = await api('/api/groups/' + g.id, { token: b.token });
  const hb = grp.hides[0];
  ok(hb.status === 'found' && hb.spot, 'round over -> spot revealed to seekers');
  ok(grp.leaderboard[0].user.name === 'Seeker Sam' && grp.leaderboard[0].points === 15, `leaderboard: ${grp.leaderboard.map(r => r.user.name + ' ' + r.points).join(', ')}`);
  ok(grp.messages.some(m => m.type === 'ping') && grp.messages.some(m => m.type === 'found'), 'chat feed has ping + found entries');
  const chat = await api(`/api/groups/${g.id}/messages`, { token: b.token, form: { text: 'gg 🦆' } });
  ok(chat.message?.text === 'gg 🦆', 'group chat message');

  // ---- move / rename on ping ----
  const SPOT2 = { lat: CENTER.lat - 0.0015, lng: CENTER.lng - 0.0005 }; // ~170 m from center, ~280 m from SPOT
  const OUTSIDE = { lat: CENTER.lat + 0.01, lng: CENTER.lng };
  const mv = (await api(`/api/groups/${g.id}/hides`, { token: a.token, form: { photo: 1, object: 'Lucky sock', centerLat: CENTER.lat, centerLng: CENTER.lng, radius: 400, spotLat: SPOT.lat, spotLng: SPOT.lng, intervalMin: 0.05, pingCount: 3 } })).hide;
  ok(mv.firstPingAt - mv.createdAt >= MIN, 'default first ping = ping delay after the spot is marked');
  ok((await api(`/api/hides/${mv.id}/move`, { token: a.token, form: { object: 'x' } })).status === 400, 'cannot move before the first ping');
  const p1 = await (async () => { for (;;) { const p = await once(sb, 'ping', 12000); if (p.hideId === mv.id) return p; } })();
  ok(p1.n === 1, 'move-test hide: ping #1 fired');
  ok((await api(`/api/hides/${mv.id}/move`, { token: b.token, form: { spotLat: SPOT2.lat, spotLng: SPOT2.lng } })).status === 403, 'a seeker cannot move the object');
  ok((await api(`/api/hides/${mv.id}/move`, { token: a.token, form: { spotLat: OUTSIDE.lat, spotLng: OUTSIDE.lng } })).status === 400, 'new spot outside the play area rejected');
  const movedEvt = once(sb, 'moved'); const hideEvt2 = once(sb, 'hide');
  const tMove = Date.now();
  const moved = await api(`/api/hides/${mv.id}/move`, { token: a.token, form: { spotLat: SPOT2.lat, spotLng: SPOT2.lng, object: 'Blue sock', photo: 1 } });
  ok(moved.hide?.object === 'Blue sock' && Math.abs(moved.hide.spot.lat - SPOT2.lat) < 1e-9, 'hider moves the spot + renames + new photo during the ping window');
  const me = await movedEvt;
  ok(me.moved && me.renamed && me.newPhoto && me.oldName === 'Lucky sock' && !JSON.stringify(me).includes(String(SPOT2.lat).slice(0, 8)), 'seekers get a "moved/renamed" alert with no coordinates');
  const he = await hideEvt2;
  ok(he.spot === undefined && he.object === 'Blue sock' && he.hintOutdated === true, 'seeker realtime update: renamed, old hint flagged outdated, spot still hidden');
  const sv = (await api(`/api/hides/${mv.id}`, { token: b.token })).hide;
  ok(sv.spot === undefined && !JSON.stringify(sv).includes(String(SPOT2.lat).slice(0, 8)), 'seeker API view never contains the new spot');
  ok(sv.nextPingAt >= tMove + MIN, `next ping pushed to >= ${MIN} ms after the new spot was marked (+${sv.nextPingAt - tMove} ms; original schedule was +3 s after ping #1)`);
  ok((await api(`/api/hides/${mv.id}/move`, { token: a.token, form: { object: 'Green sock' } })).status === 409, 'only one move per ping');
  ok((await api(`/api/hides/${mv.id}/heat`, { token: b.token, body: SPOT2 })).band === 'on fire', 'hot/cold resets after a move and tracks the NEW spot');
  const p2 = await (async () => { for (;;) { const p = await once(sb, 'ping', 12000); if (p.hideId === mv.id) return p; } })();
  ok(Date.now() - tMove >= MIN - 400, `ping #2 waited ${Date.now() - tMove} ms after the move`);
  ok(dist(p2.hint.center, SPOT2) <= p2.hint.radius && p2.hint.radius === 240, `ping #2 hint circle contains the NEW spot, shrink reset to ${p2.hint.radius} m`);
  ok(p2.object === 'Blue sock', 'ping uses the new name');
  const renameOnly = await api(`/api/hides/${mv.id}/move`, { token: a.token, form: { object: 'Purple sock' } });
  ok(renameOnly.hide?.object === 'Purple sock' && renameOnly.hide.nextPingAt - Date.now() < MIN, 'rename-only on ping #2 allowed and does not delay the next ping');
  await api(`/api/hides/${mv.id}/end`, { token: a.token, body: {} });

  // default delay in production config is 5 minutes
  srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: 3997, DATA_DIR: dir + '/d2', UPLOAD_DIR: dir + '/u2', MIN_PING_DELAY_MS: '' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch('http://localhost:3997/healthz'); break; } catch { await wait(150); } }
  const cfg = await (await fetch('http://localhost:3997/api/config')).json();
  const u = await (await fetch('http://localhost:3997/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Default Dee' }) })).json();
  const gg = await (await fetch('http://localhost:3997/api/groups', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': u.token }, body: JSON.stringify({ name: 'D' }) })).json();
  const fd = new FormData(); fd.append('photo', new Blob([JPG], { type: 'image/jpeg' }), 'p.jpg');
  Object.entries({ object: 'Cup', centerLat: CENTER.lat, centerLng: CENTER.lng, radius: 400, spotLat: SPOT.lat, spotLng: SPOT.lng, firstPingAt: Date.now() + 60000, intervalMin: 1, pingCount: 2 }).forEach(([k, v]) => fd.append(k, String(v)));
  const t5 = Date.now();
  const dh = await (await fetch(`http://localhost:3997/api/groups/${gg.group.id}/hides`, { method: 'POST', headers: { 'x-token': u.token }, body: fd })).json();
  ok(cfg.minPingDelayMs === 300000 && dh.hide.firstPingAt >= t5 + 300000, `default config: 5 min minimum (asked for 1 min -> first ping in ${Math.round((dh.hide.firstPingAt - t5) / 1000)} s)`);
  srv2.kill();

  // escape path: short hide nobody finds
  const e = await api(`/api/groups/${g.id}/hides`, { token: a.token, form: { photo: 1, object: 'Sock', centerLat: CENTER.lat, centerLng: CENTER.lng, radius: 400, spotLat: SPOT.lat, spotLng: SPOT.lng, firstPingAt: Date.now() + 1000, intervalMin: 0.05, pingCount: 1 } });
  await wait(MIN + 4000);
  ok((await api(`/api/hides/${e.hide.id}`, { token: b.token })).hide.status === 'escaped', 'unfound hide escapes after last ping + one interval');

  // ---- installable PWA + push plumbing ----
  const man = await fetch(BASE + '/manifest.json');
  const mj = await man.json();
  ok(/manifest\+json/.test(man.headers.get('content-type')) && mj.display === 'standalone' && mj.orientation === 'portrait' && mj.background_color === '#000000' && mj.theme_color === '#000000', 'manifest: standalone, portrait, black theme, served as application/manifest+json');
  ok(mj.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable') && mj.icons.some(i => i.sizes === '192x192' && i.purpose === 'any'), 'manifest: 192/512 icons incl. maskable');
  const iconOk = (await Promise.all(mj.icons.map(i => fetch(BASE + i.src).then(r => r.ok && r.headers.get('content-type') === 'image/png')))).every(Boolean);
  ok(iconOk, `all ${mj.icons.length} manifest icons are served as PNG`);
  const html = await (await fetch(BASE + '/')).text();
  ok(['apple-mobile-web-app-capable', 'black-translucent', 'apple-mobile-web-app-title', 'apple-touch-icon', 'viewport-fit=cover'].every(x => html.includes(x)), 'iOS meta tags + apple-touch-icon + viewport-fit=cover present');
  const splashes = [...html.matchAll(/apple-touch-startup-image"[^>]*href="([^"]+)"/g)].map(m => m[1]);
  ok(splashes.length >= 10 && (await Promise.all(splashes.map(u => fetch(BASE + u).then(r => r.ok)))).every(Boolean), `${splashes.length} iOS splash screens linked and served`);
  const sw = await fetch(BASE + '/sw.js');
  const swText = await sw.text();
  ok(sw.ok && sw.headers.get('cache-control') === 'no-cache' && /offline\.html/.test(swText) && /addEventListener\('push'/.test(swText), 'service worker served (no-cache) with offline fallback + push handler');
  ok((await fetch(BASE + '/offline.html')).ok, 'offline fallback page served');
  const key = await (await fetch(BASE + '/api/push/key')).json();
  ok(/^[A-Za-z0-9_-]{80,}$/.test(key.publicKey), 'VAPID public key available for Web Push');
  ok((await api('/api/push/subscribe', { token: b.token, body: { subscription: { endpoint: 'http://evil', keys: {} } } })).status === 400, 'bad push subscription rejected');
  ok((await api('/api/push/subscribe', { token: b.token, body: { subscription: { endpoint: 'https://push.invalid/abc', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } } } })).ok === true, 'push subscription saved');

  sb.close(); srv.kill();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); srv.kill(); srv2?.kill(); process.exit(1); });
