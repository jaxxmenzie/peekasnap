// Camera screen on an iPhone-size browser (Chrome with a fake camera), incl. Home Screen (standalone) mode.
// Simulates the iOS behaviours that break web cameras: camera taken away (track ended), app backgrounded,
// permission denied, camera busy, autoplay refused, rapid front/back flips, tab switches, calls.
// node test/camera-ui.js [https://live.example]
const { chromium } = require('playwright-core');
const path = require('path');
const { startServer, reporter } = require('./helpers');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const wait = ms => new Promise(r => setTimeout(r, ms));
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const SHOTS = path.join(__dirname, '..', 'screenshots');
// records every camera stream the page opens, lets the test make getUserMedia / play() fail like iOS does
const HOOKS = () => {
  window.__streams = []; window.__gumFail = null; window.__playFail = false; window.__gumCalls = 0;
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async c => {
    window.__gumCalls++;
    if (window.__gumFail) { const e = new Error('fake ' + window.__gumFail); e.name = window.__gumFail; throw e; }
    const s = await orig(c); window.__streams.push(s); return s;
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { if (window.__playFail) { const e = new Error('play() needs a tap'); e.name = 'NotAllowedError'; return Promise.reject(e); } return play.call(this); };
  window.__live = () => window.__streams.flatMap(s => s.getVideoTracks()).filter(t => t.readyState === 'live').length;
  let vis = 'visible'; Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => vis === 'hidden', configurable: true });
  window.__setVis = v => { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
  const st = document.createElement('style'); st.textContent = '#install-card{display:none!important}';
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
};
const STANDALONE = () => {
  Object.defineProperty(navigator, 'standalone', { get: () => true });
  const mm = window.matchMedia.bind(window);
  window.matchMedia = q => /display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q);
};

(async () => {
  const { ok, done } = reporter();
  let BASE = process.argv[2], S;
  if (!BASE) { S = await startServer(3994); BASE = S.BASE; }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA, permissions: ['camera', 'microphone'] };
  const signup = async n => (await (await fetch(BASE + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n, username: n.toLowerCase() + Date.now().toString(36).slice(-6), password: 'secret123' }) })).json());
  const open = async (standalone, token) => {
    const ctx = await browser.newContext(phone);
    await ctx.addInitScript(HOOKS); if (standalone) await ctx.addInitScript(STANDALONE);
    await ctx.addInitScript(t => localStorage.setItem('ps_token', t), token);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/#camera', { waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    return { ctx, page, errors };
  };
  const state = p => p.evaluate(() => ({ cam: document.querySelector('#view-camera').dataset.cam, live: window.__live(), w: document.querySelector('#cam-video').videoWidth, paused: document.querySelector('#cam-video').paused, fb: !document.querySelector('#cam-fallback').classList.contains('hidden'), mirror: document.querySelector('#cam-video').classList.contains('mirror'), msg: document.querySelector('#cam-fb-msg').textContent }));
  const until = async (p, fn, ms = 6000) => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await state(p); if (fn(s)) return s; await wait(100); } return s; };
  const liveOk = s => s.cam === 'live' && s.live === 1 && s.w > 0 && !s.paused && !s.fb;
  try {
    const head = await fetch(BASE + '/');
    ok(/camera=\(self\)/.test(head.headers.get('permissions-policy') || ''), 'Permissions-Policy allows the camera for PeekaSnap itself');
    const me = await signup('Cammy');
    for (const standalone of [false, true]) {
      const L = standalone ? '[Home Screen app] ' : '[Safari] ';
      const { ctx, page, errors } = await open(standalone, me.token);
      let s = await until(page, liveOk);
      ok(liveOk(s), L + `camera starts and plays (live tracks: ${s.live}, ${s.w}px wide)`);
      const vattr = await page.$eval('#cam-video', v => v.hasAttribute('playsinline') && v.muted && v.autoplay);
      ok(vattr, L + 'video is playsinline + muted + autoplay (required on iPhone)');
      const box = await page.$eval('#cam-video', v => { const r = v.getBoundingClientRect(); return [r.top, r.left, r.width, r.height, getComputedStyle(v).objectFit]; });
      ok(box[0] <= 0 && box[1] === 0 && box[2] === 390 && box[3] >= 844 && box[4] === 'cover', L + `preview fills the screen (${box.slice(2, 4).join('×')}, ${box[4]})`);
      const sh = await page.$eval('#shutter', b => { const r = b.getBoundingClientRect(); return { bottom: r.bottom, top: r.top, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b }; });
      ok(sh.hit && sh.bottom < 844 - 60, L + 'shutter is on screen above the tab bar and tappable');
      if (!standalone) await page.screenshot({ path: path.join(SHOTS, '46-camera-live.png') });
      // rapid flips
      for (let i = 0; i < 7; i++) { await page.click('#cam-flip'); await wait(i % 2 ? 30 : 120); }
      s = await until(page, liveOk);
      ok(liveOk(s), L + `7 rapid front/back flips: exactly one camera open afterwards (live tracks: ${s.live})`);
      ok(s.mirror === (await page.evaluate(() => localStorage.getItem('ps_facing'))) .includes('user'), L + 'front camera preview is mirrored, back camera is not');
      // capture
      await page.click('#shutter');
      await page.waitForSelector('#editor:not(.hidden)', { timeout: 5000 });
      const img = await page.$eval('#ed-img', async im => { await im.decode?.().catch(() => {}); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 4 * 97) sum += d[i] + d[i + 1] + d[i + 2]; return { w: im.naturalWidth, h: im.naturalHeight, avg: sum / (d.length / (4 * 97)) / 3 }; });
      ok(img.w > 0 && img.avg > 8, L + `shutter takes a real photo (${img.w}×${img.h}, not black: avg ${img.avg.toFixed(0)})`);
      ok((await state(page)).live === 0, L + 'camera released while editing the Peak');
      await page.click('#ed-close').catch(() => page.evaluate(() => closeEditor()));
      s = await until(page, liveOk); ok(liveOk(s), L + 'camera comes back after closing the editor');
      // re-enter the camera over and over (Jaxx: "works the first time, black the next time")
      const leaves = [
        async () => page.click('.nav-btn[data-view="chat"]'), async () => page.click('.nav-btn[data-view="stories"]'),
        async () => page.click('.nav-btn[data-view="map"]'), async () => page.click('.nav-btn[data-view="play"]'),
        async () => page.click('#cam-memories'),
      ];
      let reentryOk = 0, quickOk = true;
      for (let i = 0; i < 12; i++) {
        await leaves[i % leaves.length]();
        await wait(i % 3 === 0 ? 40 : 250); // sometimes come back really quickly
        if ((await state(page)).live !== 0 && i % 3) quickOk = false;
        if (i % leaves.length === 4) await page.click('#mem-close'); else await page.click('.nav-btn[data-view="camera"]');
        const r = await until(page, liveOk);
        const frames = await page.evaluate(() => new Promise(res => { const v = document.querySelector('#cam-video'); const t0 = v.currentTime; setTimeout(() => res(v.currentTime > t0), 400); }));
        if (liveOk(r) && frames) reentryOk++;
      }
      ok(reentryOk === 12, L + `left and re-entered the camera 12× (tabs + Memories): live and moving every time (${reentryOk}/12)`);
      ok(quickOk, L + 'camera is off every time it is left');
      // watchdog: preview stuck black / track died silently
      await page.evaluate(() => { document.querySelector('#cam-video').srcObject = new MediaStream(); });
      s = await until(page, x => liveOk(x) && x.w > 0, 6000); ok(liveOk(s), L + 'watchdog: preview stuck black → camera restarted by itself');
      await page.evaluate(() => { window.__streams.flatMap(s => s.getVideoTracks()).filter(t => t.readyState === 'live').forEach(t => t.stop()); }); // no 'ended' event, like some iOS versions
      s = await until(page, liveOk, 6000); ok(liveOk(s), L + 'watchdog: track died silently → camera restarted by itself');
      // other places that use the camera
      await page.evaluate(() => { const i = document.querySelector('#av-camera'); i.addEventListener('click', e => e.preventDefault(), { once: true }); i.click(); });
      await wait(200); ok((await state(page)).live === 0, L + 'profile "Take photo" (native camera) gets the camera released');
      await page.evaluate(() => document.querySelector('#av-camera').dispatchEvent(new Event('cancel')));
      s = await until(page, liveOk); ok(liveOk(s), L + 'back from profile "Take photo": camera live again');
      // tabs
      await page.click('.nav-btn[data-view="chat"]'); await wait(300);
      ok((await state(page)).live === 0, L + 'leaving the Camera tab turns the camera off');
      await page.click('.nav-btn[data-view="camera"]');
      s = await until(page, liveOk); ok(liveOk(s), L + 'back on the Camera tab: camera on again');
      // app backgrounded / returned (iOS kills the camera in the background) — several times
      let bgOk = 0;
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.__setVis('hidden')); await wait(150);
        const off = (await state(page)).live === 0;
        await page.evaluate(() => window.__setVis('visible'));
        if (off && liveOk(await until(page, liveOk))) bgOk++;
      }
      ok(bgOk === 4, L + `app backgrounded and reopened 4×: camera released each time, restarts by itself (${bgOk}/4)`);
      // iOS takes the camera away (e.g. native camera / Siri) -> track ends
      await page.evaluate(() => { const t = window.__streams.flatMap(s => s.getVideoTracks()).find(t => t.readyState === 'live'); t.stop(); t.dispatchEvent(new Event('ended')); });
      s = await until(page, liveOk); ok(liveOk(s), L + 'camera taken away by iOS (track ended): restarts by itself');
      // a call holds the camera
      await page.evaluate(() => { C.call = { pending: true, kind: 'video', peer: { id: 'x', name: 'X' } }; showCallScreen({ id: 'x', name: 'X', username: 'x' }, 'video', 'outgoing'); });
      await wait(300); ok((await state(page)).live === 0, L + 'during a call the Peak camera is off (call gets the camera)');
      await page.evaluate(() => endLocal());
      s = await until(page, liveOk); ok(liveOk(s), L + 'after the call: Peak camera back on');
      await page.click('.nav-btn[data-view="chat"]'); await wait(200); await page.click('.nav-btn[data-view="camera"]');
      s = await until(page, liveOk); ok(liveOk(s), L + 'after the call: leaving and re-entering the camera still works');
      ok(!errors.length, L + 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
      await ctx.close();
    }
    // failures, each with a clear message and a way out
    const { ctx, page } = await open(true, me.token);
    await until(page, liveOk);
    await page.evaluate(() => { window.__gumFail = 'NotAllowedError'; }); await page.click('#cam-flip');
    let s = await until(page, x => x.cam === 'error');
    ok(s.fb && /camera access/i.test(s.msg) && /Settings/.test(s.msg), `permission denied: clear message "${s.msg.slice(0, 70)}…"`);
    ok(await page.isVisible('#cam-enable') && await page.isVisible('#cam-native'), 'permission denied: "Enable camera" + "Use iPhone camera instead" buttons');
    await page.screenshot({ path: path.join(SHOTS, '47-camera-permission-denied.png') });
    const picked = page.evaluate(() => new Promise(r => document.querySelector('#file-capture').addEventListener('click', e => { e.preventDefault(); r(document.querySelector('#file-capture').getAttribute('capture')); }, { once: true })));
    await page.click('#cam-native'); ok(await picked === 'environment', '"Use iPhone camera instead" opens the phone camera (file input, capture=environment)');
    const picked2 = page.evaluate(() => new Promise(r => document.querySelector('#file-capture').addEventListener('click', e => { e.preventDefault(); r(true); }, { once: true })));
    await page.click('#shutter'); ok(await picked2, 'shutter with no live camera still takes a photo via the phone camera');
    await page.evaluate(() => { window.__gumFail = null; }); await page.click('#cam-enable');
    s = await until(page, liveOk); ok(liveOk(s), 'allowed again + "Enable camera" → live camera');
    await page.evaluate(() => { window.__gumFail = 'NotReadableError'; }); await page.click('#cam-flip');
    s = await until(page, x => x.cam === 'error'); ok(/busy/i.test(s.msg), `camera busy: "${s.msg.slice(0, 60)}…"`);
    await page.evaluate(() => { window.__gumFail = null; window.__playFail = true; }); await page.click('#cam-enable');
    s = await until(page, x => x.cam === 'tap'); ok(s.cam === 'tap' && await page.isVisible('#cam-enable') && /tap to start/i.test(await page.textContent('#cam-enable')), 'autoplay refused (iOS): "Tap to start camera" shown');
    await page.evaluate(() => { window.__playFail = false; }); await page.click('#cam-enable');
    s = await until(page, liveOk); ok(liveOk(s), 'tap → camera plays');
    const calls = await page.evaluate(() => window.__gumCalls);
    await page.evaluate(() => { startCamera(); startCamera(); startCamera(); }); await wait(500);
    ok((await page.evaluate(() => window.__gumCalls)) === calls && (await state(page)).live === 1, 'repeated start calls while live don\'t reopen the camera');
    await page.evaluate(() => { stopCamera(); startCamera(); startCamera(); startCamera(); });
    s = await until(page, liveOk); ok(liveOk(s), `overlapping starts never leak a second camera (live tracks: ${s.live})`);
    await ctx.close();
  } catch (e) { console.error(e); ok(false, 'exception: ' + e.message.split('\n')[0]); }
  await browser.close(); S?.kill(); process.exit(done() ? 1 : 0);
})();
