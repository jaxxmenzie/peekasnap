// Renders phone-size screenshots of the UI against a throwaway demo server (node test/screenshots.js)
const { chromium } = require('playwright-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3998, BASE = `http://localhost:${PORT}`, OUT = path.join(__dirname, '..', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shots-'));
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const wait = ms => new Promise(r => setTimeout(r, ms));
const C = { lat: 37.7694, lng: -122.4862 }; // Golden Gate Park
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;

async function api(p, token, body, photo, method) {
  const o = { method: method || (body ? 'POST' : 'GET'), headers: { 'x-token': token || '' } };
  if (photo) { const fd = new FormData(); fd.append('photo', new Blob([fs.readFileSync(photo)], { type: 'image/jpeg' }), 'p.jpg'); for (const [k, v] of Object.entries(body)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)); o.body = fd; }
  else if (body) { o.body = JSON.stringify(body); o.headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, o); const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j;
}
const photoHtml = (emoji, bg) => `<html><body style="margin:0;width:600px;height:800px;background:${bg};display:grid;place-items:center;overflow:hidden">
  <div style="font-size:300px;filter:drop-shadow(0 30px 25px rgba(0,0,0,.45));transform:rotate(-8deg)">${emoji}</div></body></html>`;
const near = (dLat, dLng) => ({ lat: C.lat + dLat, lng: C.lng + dLng });

(async () => {
  // 1) demo "photos" + a fake camera feed
  const b0 = await chromium.launch({ executablePath: CHROME });
  const p0 = await b0.newPage({ viewport: { width: 600, height: 800 } });
  const pics = { duck: ['🦆', 'radial-gradient(circle at 50% 70%,#7cbf5a,#3f7d2c 70%,#2c5a1e)'], pizza: ['🍕', 'radial-gradient(circle,#ffcf7a,#d9822b)'], dog: ['🐶', 'linear-gradient(#ffd6e0,#ff8fab)'], sunset: ['🌇', 'linear-gradient(#ff7a3c,#ff2d46 55%,#3b0f17)'], scene: ['🌳', 'linear-gradient(#8ecdf5,#cfeaff 45%,#6fb04f 46%,#3e7a2a)'], skate: ['🛹', 'linear-gradient(#222,#555)'] };
  for (const [k, [e, bg]] of Object.entries(pics)) { await p0.setContent(photoHtml(e, bg)); await p0.screenshot({ path: `${tmp}/${k}.jpg`, type: 'jpeg', quality: 85 }); }
  await b0.close();
  execSync(`ffmpeg -y -loglevel error -loop 1 -i ${tmp}/scene.jpg -t 2 -r 10 -vf scale=600:800 -pix_fmt yuv420p ${tmp}/cam.y4m`);

  // 2) demo server + seed data
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: tmp + '/data', UPLOAD_DIR: tmp + '/up', TICK_MS: 300, MIN_PING_DELAY_MS: 1000, ALLOW_TEST_CLOCK: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/healthz'); break; } catch { await wait(150); } }
  const su = (name, username) => api('/api/signup', null, { name, username, password: 'secret123' });
  const jaxx = await su('Jaxx', 'jaxx'), maya = await su('Maya', 'maya.b'), leo = await su('Leo', 'leo_skates'), zoe = await su('Zoe', 'zoe');
  const friend = async (a, b) => { await api('/api/friends/request', a.token, { username: b.user.username }); await api('/api/friends/accept', b.token, { userId: a.user.id }); };
  await friend(jaxx, maya); await friend(jaxx, leo); await friend(maya, leo); await friend(zoe, maya);
  await api('/api/friends/request', zoe.token, { username: 'jaxx' }); // incoming request for Jaxx
  const g = (await api('/api/groups', jaxx.token, { name: 'Park Crew', emoji: '🌳' })).group;
  for (const u of [maya, leo, zoe]) await api('/api/groups/join', u.token, { code: g.code });
  const dm = (a, b) => 'dm_' + [a.user.id, b.user.id].sort().join('_');
  // snaps + chats (streak: both snapped today)
  await api('/api/snaps', jaxx.token, { timer: '5', to: [maya.user.id] }, `${tmp}/skate.jpg`);
  await api(`/api/chats/${dm(jaxx, maya)}/messages`, maya.token, { text: 'where are you rn?? 👀' });
  await api(`/api/chats/${dm(jaxx, maya)}/messages`, jaxx.token, { text: 'skate park, come thru' });
  const mInbox = await api('/api/snaps/inbox', maya.token); await api(`/api/snaps/${mInbox.snaps[0].id}/open`, maya.token, {});
  await api('/api/snaps', maya.token, { timer: '7', to: [jaxx.user.id] }, `${tmp}/dog.jpg`);
  await api('/api/snaps', leo.token, { timer: '3', to: [jaxx.user.id] }, `${tmp}/pizza.jpg`);
  await api(`/api/chats/${dm(jaxx, leo)}/messages`, jaxx.token, { text: 'manhunt tonight?' });
  await api(`/api/chats/${g.id}/messages`, zoe.token, { text: 'who is hiding next 😈' });
  // stories
  await api('/api/stories', maya.token, {}, `${tmp}/sunset.jpg`);
  await api('/api/stories', leo.token, {}, `${tmp}/skate.jpg`);
  await api('/api/stories', zoe.token, {}, `${tmp}/pizza.jpg`);
  // Snap Map: Maya + Leo share location
  for (const [u, l] of [[maya, near(0.003, -0.004)], [leo, near(-0.002, 0.003)]]) { await api('/api/me', u.token, { shareLocation: true }, null, 'PATCH'); await api('/api/me/location', u.token, l); }
  // Hide & Seek: Maya hides a duck, first ping fires quickly
  const duck = await api(`/api/groups/${g.id}/hides`, maya.token, { object: 'Red rubber duck', centerLat: C.lat, centerLng: C.lng, radius: 450, spotLat: C.lat + 0.0011, spotLng: C.lng + 0.0016, firstPingAt: Date.now() + 1200, intervalMin: 10, pingCount: 4 }, `${tmp}/duck.jpg`);
  await wait(1800);

  // 3) phone screenshots
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${tmp}/cam.y4m`, '--autoplay-policy=no-user-gesture-required'] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: C.lat + 0.0006, longitude: C.lng + 0.0004, accuracy: 8 }, permissions: ['geolocation', 'camera', 'notifications'] };
  fs.mkdirSync(OUT, { recursive: true });
  const T0 = Date.now(); const step = m => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', m);
  const shot = async (page, name) => { step('shot ' + name); if (ONLY && !ONLY.test(name)) return; await page.screenshot({ path: path.join(OUT, name) }); console.log('saved', name); };
  const login = async (u, hash = 'camera') => {
    const ctx = await browser.newContext(phone);
    await ctx.addInitScript(([t, gid]) => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_group', gid); localStorage.setItem('ps_install_snooze', Date.now() + 864e5); }, [u.token, g.id]);
    const page = await ctx.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => console.log('pageerror', e.message));
    await page.goto(BASE + '/#' + hash); await wait(2200); return page;
  };

  const anon = await (await browser.newContext(phone)).newPage();
  await anon.goto(BASE); await anon.fill('#signup-name', 'Jaxx'); await anon.fill('#signup-username', 'jaxx_m'); await anon.fill('#signup-password', 'secret123'); await wait(500); await shot(anon, '01-sign-in.png');
  await anon.click('#tab-login'); await anon.fill('#login-username', 'jaxx'); await anon.fill('#login-password', 'secret123'); await wait(400); await shot(anon, '28-log-in.png');

  const page = await login(jaxx);
  await shot(page, '02-camera-home.png');
  // editor: caption + sticker + doodle
  step('shutter'); await page.click('#shutter'); await wait(900); step('editor open');
  await page.click('#ed-text'); step('text'); await page.keyboard.type('skate sesh later? 🛹'); await page.click('#ed-pen'); step('pen');
  const st = await page.locator('#ed-stage').boundingBox();
  await page.mouse.move(st.x + 60, st.y + 200); await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(st.x + 60 + i * 6, st.y + 200 + Math.sin(i / 3) * 30);
  await page.mouse.up(); await page.click('#ed-pen');
  await page.click('#ed-sticker'); await page.click('#ed-stickers button:nth-child(2)'); await wait(500);
  await shot(page, '03-peak-editor.png');
  await page.click('#ed-send'); await wait(600);
  await page.locator(`label.send-row:has(input[data-to="${maya.user.id}"])`).click();
  await page.locator('label.story-row').click();
  await wait(400); await shot(page, '04-send-to.png');
  await page.click('#send-go'); await wait(1200);
  // chat
  await page.click('.nav-btn[data-view=chat]'); await wait(1000); await shot(page, '05-chat-list.png');
  await page.click(`.chat-row[data-chat="${dm(jaxx, maya)}"]`); await wait(1300); await shot(page, '06-peak-viewer.png'); // tapping a New Snap opens it (Snapchat-style)
  await page.click('#snap-viewer'); await wait(500);
  await page.click(`.chat-row[data-chat="${dm(jaxx, maya)}"]`); await wait(900);
  await api(`/api/chats/${dm(jaxx, maya)}/messages`, maya.token, { text: 'omw!! 🏃‍♀️' });
  const ms = await import('socket.io-client'); const io = ms.io || ms.default;
  const msock = io(BASE, { auth: { token: maya.token }, transports: ['websocket'] }); await wait(600);
  msock.emit('typing', { chatId: dm(jaxx, maya) }); await wait(600);
  await shot(page, '07-chat-thread.png');
  await page.click('#thread-back'); await wait(300);
  // stories
  await page.click('.nav-btn[data-view=stories]'); await wait(1200); await shot(page, '08-stories.png');
  await page.click('#story-bar [data-fs="0"]'); await wait(900); await shot(page, '09-friend-story.png');
  await page.click('#sv-close');
  // map
  await page.click('.nav-btn[data-view=map]'); await page.waitForLoadState('networkidle'); await wait(1500);
  await page.evaluate(() => map.fitBounds([[37.7724, -122.4902], [37.7674, -122.4832]])); await wait(1800); await shot(page, '10-peak-map.png');
  // friends + profile
  await page.click('#add-friend-btn'); await wait(400); await page.fill('#friend-search', 'zo'); await wait(900); await shot(page, '11-add-friends.png');
  await page.click('#friends-sheet [data-close]');
  await page.click('#me-btn'); await wait(500); await shot(page, '12-profile.png'); await page.click('#profile-sheet [data-close]');
  // play tab + hide & seek
  await page.click('.nav-btn[data-view=play]'); await wait(900); await shot(page, '13-play-tab.png');
  await page.click('#game-map-btn'); await page.waitForLoadState('networkidle'); await wait(2500); await shot(page, '14-hide-seek-map.png');
  await page.click('#gmap-close');
  await page.click(`#cam-stories [data-hide="${duck.hide.id}"]`); await wait(900); await shot(page, '15-hide-story.png');
  await page.click('#story-close'); await wait(300);

  // 4) Manhunt: Jaxx hosts, picks teams; Maya + Leo run
  const mloc = near(0.0009, 0.0006), lloc = near(-0.0012, -0.0011);
  const mpage = await login(maya, 'play'); await mpage.context().setGeolocation({ latitude: mloc.lat, longitude: mloc.lng, accuracy: 6 });
  await page.bringToFront();
  await page.click('#mode-hunt'); await wait(1500);
  await page.selectOption('#hunt-lobby select[data-k="teamMode"]', 'pick'); await wait(500);
  for (const u of [maya, leo]) await api(`/api/hunts/${(await api(`/api/groups/${g.id}/hunt`, u.token)).hunt.id}/join`, u.token, {});
  const hid = (await api(`/api/groups/${g.id}/hunt`, jaxx.token)).hunt.id;
  await api(`/api/hunts/${hid}/teams`, jaxx.token, { roles: { [jaxx.user.id]: 'hunter', [maya.user.id]: 'runner', [leo.user.id]: 'runner' } });
  await page.selectOption('#hunt-lobby select[data-k="radius"]', '300'); await wait(1500);
  await shot(page, '16-manhunt-lobby.png');
  await page.click('#hl-start'); await wait(2500);
  await api(`/api/hunts/${hid}/location`, maya.token, mloc); await api(`/api/hunts/${hid}/location`, leo.token, lloc);
  await page.click('#ping-banner').catch(() => {}); await wait(1500);
  await shot(page, '17-manhunt-headstart.png');
  await mpage.bringToFront(); await wait(1500); await mpage.click('#ping-banner').catch(() => {}); await wait(800); await shot(mpage, '18-manhunt-runner-view.png');
  await page.bringToFront();
  await api('/api/test/clock', null, { advanceMs: 2 * 60000 + 500 }); await wait(1500);
  await api(`/api/hunts/${hid}/location`, maya.token, mloc); await api(`/api/hunts/${hid}/location`, leo.token, lloc);
  await api('/api/test/clock', null, { advanceMs: 3 * 60000 }); await wait(400);
  await page.waitForSelector('#ping-banner:not(.hidden)', { timeout: 8000 }); await wait(1500);
  await shot(page, '19-manhunt-ping.png');
  // Jaxx catches up to Maya (same spot) and tags her
  await page.context().setGeolocation({ latitude: mloc.lat + 0.00004, longitude: mloc.lng + 0.00003, accuracy: 5 });
  await api(`/api/hunts/${hid}/location`, maya.token, mloc); await wait(4500);
  await page.click('#ping-banner').catch(() => {});
  await page.click('#hunt-tag'); await page.waitForSelector('#ping-banner:not(.hidden)', { timeout: 8000 }).catch(async () => console.log('NO TAG BANNER', await page.textContent('#toasts'), await page.textContent('#hunt-banner'))); await wait(1200);
  await shot(page, '20-manhunt-tag.png');
  await page.click('#hunt-board-btn'); await wait(700); await shot(page, '21-manhunt-scoreboard.png');
  await page.click('#hunt-board [data-close]');
  await page.click('#hunt-chat-btn'); await wait(900); await shot(page, '22-manhunt-game-chat.png');


  // 5) deleting chats + unsending a message
  await page.click('#hunt-chat [data-close]'); await page.click('#hunt-close'); await page.click('.nav-btn[data-view=chat]'); await wait(1200);
  const row = await page.locator(`.chat-row[data-chat="${dm(jaxx, leo)}"]`).boundingBox();
  await page.mouse.move(row.x + row.width - 60, row.y + row.height / 2); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(row.x + row.width - 60 - i * 9, row.y + row.height / 2); await wait(20); }
  await wait(300); await shot(page, '23-chat-swipe-delete.png');
  await page.mouse.up(); await page.waitForSelector('#ask-sheet:not(.hidden)'); await wait(500); await shot(page, '24-delete-chat-confirm.png');
  await page.click('#ask-actions [data-act="0"]'); await wait(3800);
  await page.click(`.chat-row[data-chat="${dm(jaxx, maya)}"]`); await wait(1000);
  await page.locator('#thread-feed .mrow', { hasText: 'skate park, come thru' }).click({ button: 'right' });
  await page.waitForSelector('#ask-sheet:not(.hidden)'); await wait(500); await shot(page, '25-unsend-message-confirm.png');
  await page.click('#ask-actions [data-act="0"]'); await wait(800);

  // 6) remove a friend + change password
  await page.click('#thread-back').catch(() => {}); await wait(300);
  await page.click('#add-friend-btn'); await wait(700);
  await page.click(`#friend-list [data-fmenu="${leo.user.id}"]`); await wait(400);
  await page.click('#ask-actions [data-act="1"]'); await page.waitForSelector('#ask-sheet:not(.hidden)'); await wait(500); await shot(page, '29-remove-friend-confirm.png');
  await page.click('#ask-actions [data-act="0"]'); await wait(3800);
  await page.click('#friends-sheet [data-close]').catch(() => {});
  await page.click('#me-btn'); await wait(400); await page.click('#password-btn'); await wait(300);
  await page.fill('#pw-current', 'secret123'); await page.fill('#pw-new', 'newpass99'); await page.fill('#pw-confirm', 'newpass99'); await wait(300);
  await shot(page, '30-change-password.png');

  msock.close(); await browser.close(); srv.kill(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
