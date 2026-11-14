// Renders phone-size screenshots of the UI against a throwaway demo server (node test/screenshots.js)
const { chromium } = require('playwright-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3998, BASE = `http://localhost:${PORT}`, OUT = path.join(__dirname, '..', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shots-'));
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const wait = ms => new Promise(r => setTimeout(r, ms));
const C = { lat: 37.7694, lng: -122.4862 }; // Golden Gate Park

async function api(p, token, body, photo) {
  const o = { method: body ? 'POST' : 'GET', headers: { 'x-token': token || '' } };
  if (photo) { const fd = new FormData(); fd.append('photo', new Blob([fs.readFileSync(photo)], { type: 'image/jpeg' }), 'p.jpg'); for (const [k, v] of Object.entries(body)) fd.append(k, String(v)); o.body = fd; }
  else if (body) { o.body = JSON.stringify(body); o.headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, o); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
}
const photoHtml = (emoji, bg) => `<html><body style="margin:0;width:600px;height:800px;background:${bg};display:grid;place-items:center;overflow:hidden">
  <div style="font-size:300px;filter:drop-shadow(0 30px 25px rgba(0,0,0,.45));transform:rotate(-8deg)">${emoji}</div></body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${tmp}/cam.y4m`] }).catch(() => null);
  // 1) make demo "photos" + a fake camera feed
  const b0 = await chromium.launch({ executablePath: CHROME });
  const p0 = await b0.newPage({ viewport: { width: 600, height: 800 } });
  const shots = { duck: ['🦆', 'radial-gradient(circle at 50% 70%,#7cbf5a,#3f7d2c 70%,#2c5a1e)'], bottle: ['🧴', 'linear-gradient(#b9d7ef,#e9e2d0 60%,#a68b6b)'], gnome: ['🍄', 'radial-gradient(circle,#c9a36b,#6b4a2b)'], scene: ['🌳', 'linear-gradient(#8ecdf5,#cfeaff 45%,#6fb04f 46%,#3e7a2a)'] };
  for (const [k, [e, bg]] of Object.entries(shots)) { await p0.setContent(photoHtml(e, bg)); await p0.screenshot({ path: `${tmp}/${k}.jpg`, type: 'jpeg', quality: 85 }); }
  await b0.close();
  execSync(`ffmpeg -y -loglevel error -loop 1 -i ${tmp}/scene.jpg -t 2 -r 10 -vf scale=600:800 -pix_fmt yuv420p ${tmp}/cam.y4m`);
  await browser?.close();

  // 2) demo server + seed data
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: tmp + '/data', UPLOAD_DIR: tmp + '/up', TICK_MS: 300, MIN_PING_DELAY_MS: 1000 }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/healthz'); break; } catch { await wait(150); } }
  const jaxx = await api('/api/signup', null, { name: 'Jaxx' });
  const maya = await api('/api/signup', null, { name: 'Maya' });
  const leo = await api('/api/signup', null, { name: 'Leo' });
  const g = (await api('/api/groups', jaxx.token, { name: 'Park Crew', emoji: '🌳' })).group;
  await api('/api/groups', jaxx.token, { name: 'School Squad', emoji: '🎒' });
  await api('/api/groups/join', maya.token, { code: g.code }); await api('/api/groups/join', leo.token, { code: g.code });
  const spot = { lat: C.lat + 0.0011, lng: C.lng + 0.0016 };
  const old = await api(`/api/groups/${g.id}/hides`, jaxx.token, { object: 'Mini gnome', centerLat: C.lat, centerLng: C.lng, radius: 300, spotLat: C.lat - 0.001, spotLng: C.lng, firstPingAt: Date.now() + 800, intervalMin: 30, pingCount: 3 }, `${tmp}/gnome.jpg`);
  await wait(1500);
  await api(`/api/hides/${old.hide.id}/find`, leo.token, { lat: C.lat - 0.001, lng: C.lng }, `${tmp}/gnome.jpg`);
  await api(`/api/groups/${g.id}/messages`, leo.token, { text: 'too easy 😎' }, null);
  const duck = await api(`/api/groups/${g.id}/hides`, maya.token, { object: 'Red rubber duck', centerLat: C.lat, centerLng: C.lng, radius: 450, spotLat: spot.lat, spotLng: spot.lng, firstPingAt: Date.now() + 800, intervalMin: 10, pingCount: 4 }, `${tmp}/duck.jpg`);
  await wait(1500);
  await api(`/api/groups/${g.id}/messages`, maya.token, { text: 'good luck finding this one 🦆' }, null);
  await api(`/api/groups/${g.id}/messages`, jaxx.token, { text: 'omw to the lake rn' }, null);

  // 3) phone screenshots
  const browser2 = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${tmp}/cam.y4m`, '--autoplay-policy=no-user-gesture-required'] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: C.lat + 0.0006, longitude: C.lng + 0.0004, accuracy: 8 }, permissions: ['geolocation', 'camera', 'notifications'] };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) }).then(() => console.log('saved', name));
  fs.mkdirSync(OUT, { recursive: true });

  const anon = await (await browser2.newContext(phone)).newPage();
  await anon.goto(BASE); await anon.fill('#signup-name', 'Jaxx'); await wait(600); await shot(anon, '01-sign-in.png');

  const ctx = await browser2.newContext(phone);
  await ctx.addInitScript(([t, gid]) => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_group', gid); localStorage.setItem('ps_install_snooze', Date.now() + 864e5); }, [jaxx.token, g.id]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.goto(BASE + '/#camera'); await wait(2500); await shot(page, '02-camera-home.png');
  await page.click('.nav-btn[data-view=map]'); await page.waitForLoadState('networkidle'); await wait(2500); await shot(page, '03-map-hint-circle.png');
  await page.click('.nav-btn[data-view=chat]'); await wait(800); await shot(page, '04-group-chat.png');
  await page.click(`#chat-stories [data-hide="${duck.hide.id}"]`); await wait(800); await shot(page, '05-hide-story-seeker.png');
  await page.click('#story-close');
  await page.click('.nav-btn[data-view=map]'); await wait(500);
  await api(`/api/groups/${g.id}/hides`, leo.token, { object: 'Water bottle', centerLat: C.lat + 0.002, centerLng: C.lng - 0.002, radius: 250, spotLat: C.lat + 0.0025, spotLng: C.lng - 0.0022, firstPingAt: Date.now() + 1500, intervalMin: 15, pingCount: 3 }, `${tmp}/bottle.jpg`);
  await page.waitForSelector('#ping-banner:not(.hidden)', { timeout: 10000 }); await wait(1800); await shot(page, '06-ping-alert.png');
  await page.click('#ping-banner');
  await page.click('#board-btn'); await wait(600); await shot(page, '07-leaderboard.png'); await page.click('#board-sheet [data-close]');
  await page.click('#group-pill'); await wait(500); await shot(page, '08-groups.png'); await page.click('#groups-sheet [data-close]');
  await page.click('.nav-btn[data-view=camera]'); await wait(2000);
  await page.click('#shutter'); await wait(700); await shot(page, '09-snap-preview.png');
  await page.click('#preview-hide'); await page.fill('#hide-object', 'Lucky sock'); await page.selectOption('#first-ping', '10');
  await page.waitForLoadState('networkidle'); await wait(2000); await shot(page, '10-hide-setup.png');
  await page.click('#hide-submit'); await wait(4500); await shot(page, '11-hide-story-hider.png');
  await page.click('#story-close');

  // move / rename on ping: Maya watches the map as a seeker while Jaxx's hide pings
  const mctx = await browser2.newContext(phone);
  await mctx.addInitScript(([t, gid]) => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_group', gid); localStorage.setItem('ps_install_snooze', Date.now() + 864e5); }, [maya.token, g.id]);
  const mp = await mctx.newPage(); await mp.goto(BASE + '/#map'); await wait(2500);
  await page.bringToFront(); await page.click('.nav-btn[data-view=map]'); await wait(500);
  await api(`/api/groups/${g.id}/hides`, jaxx.token, { object: 'Toy dino', centerLat: C.lat, centerLng: C.lng, radius: 300, spotLat: C.lat - 0.0012, spotLng: C.lng - 0.001, firstPingAt: Date.now() + 1000, intervalMin: 10, pingCount: 3 }, `${tmp}/gnome.jpg`);
  await page.waitForSelector('#banner-move', { timeout: 10000 }); await wait(1200); await shot(page, '12-hider-ping-move-prompt.png');
  await page.click('#banner-move'); await wait(600);
  await page.fill('#move-object', 'Toy T-rex'); await page.click('#mv-spot-me');
  await page.waitForLoadState('networkidle'); await wait(2000); await shot(page, '13-move-rename.png');
  await mp.click('#ping-banner').catch(() => {});
  await page.click('#move-submit');
  await mp.bringToFront(); await mp.waitForSelector('#ping-banner:not(.hidden)', { timeout: 10000 }); await wait(1500); await shot(mp, '14-seeker-moved-alert.png');
  await mp.click('.nav-btn[data-view=chat]'); await wait(800); await shot(mp, '15-chat-after-move.png');

  await browser2.close(); srv.kill(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
