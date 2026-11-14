// Installable-PWA check in real Chrome + install-prompt screenshots (node test/pwa-check.js [baseUrl])
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT = path.join(__dirname, '..', 'screenshots');
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${m}`); };

(async () => {
  let BASE = process.argv[2], srv;
  if (!BASE) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-pwa-'));
    BASE = 'http://localhost:3996';
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: 3996, DATA_DIR: tmp + '/d', UPLOAD_DIR: tmp + '/u' }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/healthz'); break; } catch { await wait(150); } }
  }
  const signup = async name => (await (await fetch(BASE + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json());
  const u = await signup('PWA Pat');
  const g = await (await fetch(BASE + '/api/groups', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': u.token }, body: JSON.stringify({ name: 'Park Crew', emoji: '🌳' }) })).json();
  const b = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: 37.7694, longitude: -122.4862 } };

  // Android Chrome
  // persistent (non-incognito) profile, because Chrome never offers install in incognito
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-prof-')), { ...phone, executablePath: CHROME, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
  await ctx.addInitScript(([t, gid]) => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_group', gid); }, [u.token, g.group.id]);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(BASE + '/#camera');
  const swOk = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  ok(swOk, 'service worker installs and activates');
  await page.reload(); await wait(800);
  ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page is controlled by the service worker after reload');
  const cdp = await ctx.newCDPSession(page);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  ok(inst.installabilityErrors.length === 0, `Chrome installability errors: ${JSON.stringify(inst.installabilityErrors)}`);
  const man = await cdp.send('Page.getAppManifest');
  ok(man.errors.length === 0, `manifest parses cleanly in Chrome (${man.errors.length} errors)`);
  const cached = await page.evaluate(async () => (await caches.keys()).length && (await (await caches.open((await caches.keys()).find(k => k.startsWith('peekasnap-v')))).keys()).length);
  ok(cached >= 10, `app shell cached (${cached} files)`);
  // simulate Chrome's install offer
  await page.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  await page.waitForSelector('#install-card:not(.hidden)', { timeout: 6000 });
  ok(await page.isVisible('#install-go'), 'Android: Install button shown after beforeinstallprompt');
  await wait(600); await page.screenshot({ path: path.join(OUT, '26-install-prompt-android.png') }); console.log('saved 26-install-prompt-android.png');
  await page.click('#install-go'); await wait(300);
  ok(await page.evaluate(() => window.__prompted === true) && await page.isHidden('#install-card'), 'Install button triggers the native prompt and hides the card');
  // offline
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await wait(800);
  ok(await page.evaluate(() => !!document.querySelector('.bottomnav')), 'offline reload still opens the cached app shell');
  const p2 = await ctx.newPage(); await p2.goto(BASE + '/some/deep/link').catch(() => {}); await wait(500);
  ok(/PeekaSnap|offline/i.test(await p2.title()), 'offline navigation falls back (shell/offline page)');
  await ctx.setOffline(false);
  await ctx.close();

  // iPhone Safari (not installed)
  const ictx = await b.newContext({ ...phone, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1' });
  await ictx.addInitScript(([t, gid]) => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_group', gid); }, [u.token, g.group.id]);
  const ip = await ictx.newPage(); await ip.goto(BASE + '/#camera');
  await ip.waitForSelector('#install-card:not(.hidden)', { timeout: 8000 });
  ok(await ip.isVisible('#install-ios') && await ip.isHidden('#install-go'), 'iPhone Safari: shows "Share → Add to Home Screen" guide (no Install button)');
  await wait(600); await ip.screenshot({ path: path.join(OUT, '27-install-guide-iphone.png') }); console.log('saved 27-install-guide-iphone.png');
  await ip.click('#install-later'); await ip.reload(); await wait(3500);
  ok(await ip.isHidden('#install-card'), '"Not now" snoozes the prompt');
  await ictx.close();

  // iPhone, launched from the Home Screen (standalone): no install prompt, offers alerts instead
  const sctx = await b.newContext({ ...phone, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
  await sctx.addInitScript(([t, gid]) => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_group', gid); Object.defineProperty(navigator, 'standalone', { get: () => true }); }, [u.token, g.group.id]);
  const sp = await sctx.newPage(); await sp.goto(BASE + '/#camera'); await wait(3500);
  const st = await sp.evaluate(() => ({ cls: document.documentElement.classList.contains('standalone'), card: !document.querySelector('#install-card').classList.contains('hidden'), title: document.querySelector('#install-title').textContent, ios: !document.querySelector('#install-ios').classList.contains('hidden') }));
  ok(st.cls && !st.ios && (!st.card || /alerts/i.test(st.title)), `standalone: install guide hidden${st.card ? ', offers "Turn on ping alerts" instead' : ''}`);
  if (st.card) { await sp.screenshot({ path: path.join(OUT, '18-installed-alerts-prompt.png') }); console.log('saved 18-installed-alerts-prompt.png'); }
  await sctx.close();

  await b.close(); srv?.kill();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
