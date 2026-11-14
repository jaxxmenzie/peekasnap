// Phone-size browser test: profile pages, Memories, Peak history in chat, and a real WebRTC video + voice call
// between two browser contexts (Chrome fake camera/mic).
// node test/calls-ui.js                      -> local throwaway server (also writes screenshots 37-42)
// node test/calls-ui.js https://example.com  -> a live deploy
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const { startServer, reporter } = require('./helpers');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const wait = ms => new Promise(r => setTimeout(r, ms));
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const FIX = f => path.join(__dirname, 'fixtures', f), SHOT = f => path.join(__dirname, '..', 'screenshots', f);
(async () => {
  const { ok, done } = reporter();
  let BASE = process.argv[2], S;
  if (!BASE) { S = await startServer(3990); BASE = S.BASE; }
  const tag = Date.now().toString(36).slice(-5);
  const api = async (p, token, body, method) => { const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'x-token': token || '', ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }); return r.json(); };
  const mk = (name, u) => api('/api/signup', null, { name, username: u + tag, password: 'secret123' });
  const pic = (token, f) => { const fd = new FormData(); fd.append('avatar', new Blob([fs.readFileSync(FIX(f))], { type: 'image/jpeg' }), 'a.jpg'); return api('/api/me/avatar', token, fd); };
  const befriend = async (a, b) => { await api('/api/friends/request', a.token, { userId: b.user.id }); await api('/api/friends/accept', b.token, { userId: a.user.id }); };
  const peak = (token, to, f, extra = {}) => { const fd = new FormData(); const buf = fs.readFileSync(FIX(f)); fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'p.jpg'); fd.append('thumb', new Blob([fs.readFileSync(FIX('face-c.jpg'))], { type: 'image/jpeg' }), 't.jpg'); fd.append('to', JSON.stringify(to)); fd.append('timer', '3'); for (const [k, v] of Object.entries(extra)) fd.append(k, v); return api('/api/snaps', token, fd); };
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA, permissions: ['camera', 'microphone'] };
  const open = async who => {
    const ctx = await browser.newContext(phone); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_install_snooze', Date.now() + 864e5); }, who.token);
    await page.goto(BASE + '/?u=' + who.user.username + '#chat', { waitUntil: 'networkidle' }); await page.waitForSelector('#app:not(.hidden)', { timeout: 60000 }); await wait(600);
    return page;
  };
  try {
    const A = await mk('Ava Stone', 'ava'), B = await mk('Ben Park', 'ben'), C = await mk('Cleo Ray', 'cleo'), D = await mk('Dex Moon', 'dex');
    for (const [x, y] of [[A, B], [A, C], [B, C], [B, D]]) await befriend(x, y);
    await pic(A.token, 'face-a.jpg'); await pic(B.token, 'face-d.jpg'); await pic(C.token, 'face-c.jpg'); await pic(D.token, 'face-d.jpg');
    ok(A.token && B.token, 'test accounts + friendships');
    // Peaks from Ben to Ava: one with replay (default) and one view-once
    const p1 = await peak(B.token, [A.user.id], 'face-d.jpg');
    const p2 = await peak(B.token, [A.user.id], 'face-c.jpg', { replay: '0' });
    await api(`/api/snaps/${p1.snaps[0]}/open`, A.token, {}); await api(`/api/snaps/${p2.snaps[0]}/open`, A.token, {});
    const pa = await open(A), pb = await open(B);

    // ---- Memories: Ben sends a Peak from the UI (camera roll → editor → Send To) ----
    await pb.evaluate(() => setView('camera')); await wait(300);
    await pb.setInputFiles('#file-pick', FIX('face-a.jpg')); await pb.waitForSelector('#editor:not(.hidden)');
    await pb.click('#ed-send'); await pb.waitForSelector('#send-sheet:not(.hidden)');
    ok(await pb.isChecked('#send-replay'), 'Send To has "Allow replay", on by default');
    await pb.locator('#send-friends .send-row', { hasText: 'Ava Stone' }).click(); await pb.click('#send-go');
    await pb.waitForSelector('#send-sheet.hidden', { state: 'attached', timeout: 30000 }); await wait(500);
    await pb.click('#cam-memories'); await pb.waitForSelector('#memories:not(.hidden)'); await wait(600);
    ok(await pb.locator('.mem-cell img').count() === 3 && (await pb.textContent('.mem-day')) === 'Today', 'Memories: all 3 sent Peaks in a grid under "Today", with thumbnails');
    if (S) await pb.screenshot({ path: SHOT('39-memories.png') });
    await pb.locator('.mem-cell').first().click(); await pb.waitForSelector('#mem-viewer:not(.hidden)');
    ok(await pb.$eval('#mem-img', i => i.complete && i.naturalWidth > 200), 'tap a Memory to view it full size');
    await pb.click('#mem-del'); await pb.click('#ask-actions >> text=Delete Memory'); await wait(800);
    ok(await pb.locator('.mem-cell').count() === 2, 'delete a Memory');
    await pb.click('#mem-close');

    // ---- Ava: chat history with Ben ----
    for (const sn of (await api('/api/snaps/inbox', A.token)).snaps) await api(`/api/snaps/${sn.id}/open`, A.token, {}); // Ava opens the new one
    await pa.evaluate(() => { setView('chat'); refreshChats(); refreshInbox(); }); await wait(800);
    await pa.locator('.chat-row', { hasText: 'Ben Park' }).locator('.grow').click(); await pa.waitForSelector('#thread:not(.hidden)'); await wait(600);
    const hist = pa.locator('#thread-feed .snap-hist');
    ok(await hist.count() >= 1 && await hist.first().locator('img').count() === 1, 'opened Peaks stay in the chat as entries with a thumbnail');
    ok(await pa.locator('#thread-feed .snap-bubble').count() === 1 && await pa.locator('#thread-feed .snap-bubble img').count() === 0, 'the view-once Peak (Allow replay off) has no saved thumbnail entry');
    if (S) await pa.screenshot({ path: SHOT('40-chat-replayable-peak.png') });
    await hist.first().click(); await pa.waitForSelector('#snap-viewer:not(.hidden)'); await wait(400);
    ok(await pa.$eval('#sv-snap-img', i => i.naturalWidth > 100) && /saved in your chat/.test(await pa.textContent('#snap-hint')), 'tap to view it again');
    await pa.dispatchEvent('#snap-viewer', 'click'); await wait(300);
    await pa.click('#thread-back'); await wait(300);

    // ---- profile pages ----
    await pa.locator('.chat-row', { hasText: 'Ben Park' }).locator('.avatar').click();
    await pa.waitForSelector('#person-sheet:not(.hidden) .pp-top', { timeout: 15000 }); await wait(500);
    const pt = await pa.textContent('#person-body');
    ok(pt.includes('Ben Park') && pt.includes('@ben' + tag) && /Friends since/.test(pt), 'tap an avatar → friend profile: name, @username, friends since');
    ok(/1 mutual friend/.test(pt) && await pa.locator('.pp-mutual .avatar').count() === 1, 'mutual friends (Cleo)');
    ok(await pa.locator('[data-pppeak]').count() >= 1 && /Peak score/.test(pt) && /Manhunts/.test(pt), 'Peaks between you + Peak score + game stats');
    ok(await pa.locator('[data-pp=call]').count() === 1 && await pa.locator('[data-pp=video]').count() === 1 && await pa.locator('[data-pp=nick]').count() === 1, 'actions: Chat, Call, Video, Nickname, Remove');
    if (S) await pa.screenshot({ path: SHOT('41-friend-profile.png') });
    await pa.click('#person-sheet [data-close]'); await wait(300);
    // non-friend (Dex is Ben's friend, not Ava's): find via search
    await pa.click('#add-friend-btn'); await pa.fill('#friend-search', 'dex' + tag); await pa.waitForSelector('#friend-results .send-row');
    await pa.locator('#friend-results .avatar').first().click(); await pa.waitForSelector('#person-sheet:not(.hidden) .pp-top'); await wait(500);
    const nt = await pa.textContent('#person-body');
    ok(nt.includes('Dex Moon') && await pa.locator('[data-pp=add]').count() === 1 && /Not friends yet/.test(nt), 'non-friend profile: limited view with Add Friend');
    ok(await pa.locator('.pp-thumbs, .pp-stats, .pp-mutual, [data-pp=call]').count() === 0, '…no stories, Peaks, stats, mutuals or call buttons');
    if (S) await pa.screenshot({ path: SHOT('42-non-friend-profile.png') });
    await pa.click('[data-pp=add]'); await wait(1000);
    ok(/Requested/.test(await pa.textContent('#person-body')), 'Add Friend from their profile');
    await pa.click('#person-sheet [data-close]'); await pa.click('#friends-sheet [data-close]'); await wait(300);

    // ---- video call: Ben calls Ava from the chat header ----
    await pb.evaluate(() => setView('chat')); await wait(300);
    await pb.locator('.chat-row', { hasText: 'Ava Stone' }).locator('.grow').click(); await pb.waitForSelector('#thread:not(.hidden)');
    ok(await pb.isVisible('#thread-call') && await pb.isVisible('#thread-video'), 'call + video buttons in the chat header');
    await pb.click('#thread-video');
    await pa.waitForSelector('#call:not(.hidden) #call-incoming:not(.hidden)', { timeout: 20000 }); await wait(S ? 3600 : 500);
    ok((await pa.textContent('#call-name')) === 'Ben Park' && /Incoming video call/.test(await pa.textContent('#call-status')) && await pa.locator('#call-av img').count() === 1, 'Ava sees the incoming call: avatar, name, Accept/Decline');
    if (S) await pa.screenshot({ path: SHOT('37-incoming-call.png') });
    await pa.click('#call-accept');
    // WebRTC negotiation over Socket.IO: offer/answer applied on both sides, remote audio+video tracks arrive
    const neg = p => p.waitForFunction(() => C.pc && C.pc.signalingState === 'stable' && C.pc.remoteDescription && C.pc.getReceivers().filter(r => r.track).length === 2, null, { timeout: 20000 });
    await Promise.all([neg(pa), neg(pb)]);
    ok(true, 'WebRTC offer/answer negotiated through the server; both sides receive remote audio + video tracks');
    await Promise.all([pa.waitForFunction(() => C.pc?.iceGatheringState === 'complete', null, { timeout: 15000 }), pb.waitForFunction(() => C.pc?.iceGatheringState === 'complete', null, { timeout: 15000 })]).catch(() => {});
    const localCands = await pa.evaluate(async () => { let n = 0; (await C.pc.getStats()).forEach(r => { if (r.type === 'local-candidate' && !['0.0.0.0', '::'].includes(r.address)) n++; }); return n; }); // ignore placeholder TCP-active candidates
    let connected = false;
    if (!localCands) {
      console.log('⚠️  This browser produced no ICE candidates (the test machine\'s Chrome policy disables WebRTC UDP), so the media connection itself cannot be checked here.');
    } else {
      await Promise.all([pa.waitForSelector('#call.connected', { timeout: 30000 }), pb.waitForSelector('#call.connected', { timeout: 30000 })]); connected = true;
      await wait(2500);
      const vid = p => p.$eval('#call-remote', v => [v.videoWidth, v.videoHeight, v.srcObject?.getAudioTracks().length || 0]);
      const [va, vb] = [await vid(pa), await vid(pb)];
      ok(va[0] > 0 && vb[0] > 0 && va[2] === 1 && vb[2] === 1, `WebRTC call connected: both see remote video (${va[0]}x${va[1]}, ${vb[0]}x${vb[1]}) + audio`);
      ok(/^0:0[1-9]$/.test(await pa.textContent('#call-status')), `call timer running (${await pa.textContent('#call-status')})`);
    }
    ok(await pa.isVisible('#call-controls') && await pa.isVisible('#call-mute') && await pa.isVisible('#call-flip') && await pa.isVisible('#call-end'), 'in-call controls: mute, camera, flip, end');
    await pa.click('#call-mute'); ok(await pa.evaluate(() => C.local.getAudioTracks().every(t => !t.enabled)), 'mute works');
    await pa.click('#call-cam'); ok(await pa.evaluate(() => C.local.getVideoTracks().every(t => !t.enabled)), 'camera off works'); await pa.click('#call-cam'); await pa.click('#call-mute');
    await pa.click('#call-flip'); await wait(500); ok(await pa.evaluate(() => C.local.getVideoTracks().length === 1 && C.local.getVideoTracks()[0].readyState === 'live'), 'flip camera swaps the video track');
    if (S) {
      await wait(800); await pb.screenshot({ path: SHOT('38-in-call-video.png') });
      if (!connected) { // layout preview only: show the other side's camera feed as if connected (clearly a simulation)
        await pb.evaluate(async () => { const st = await navigator.mediaDevices.getUserMedia({ video: true }); $('#call-remote').srcObject = st; $('#call').classList.add('connected'); $('#call-status').textContent = '1:24'; });
        await wait(1200); await pb.screenshot({ path: SHOT('38b-in-call-video-layout-simulated.png') });
      }
    }
    await wait(1200);
    await pb.click('#call-end');
    await Promise.all([pa.waitForSelector('#call.hidden', { state: 'attached', timeout: 10000 }), pb.waitForSelector('#call.hidden', { state: 'attached', timeout: 10000 })]); await wait(1200);
    const log = await pb.locator('#thread-feed .call-log').last().textContent();
    ok(/Video call 0:0\d/.test(log), `chat entry: "${log.trim().replace(/\s+/g, ' ')}"`);
    // ---- voice call, declined ----
    await pb.click('#thread-call'); await pa.waitForSelector('#call-incoming:not(.hidden)', { timeout: 20000 });
    ok(/Incoming voice call/.test(await pa.textContent('#call-status')), 'voice call rings');
    await pa.click('#call-decline'); await pb.waitForSelector('#call.hidden', { state: 'attached', timeout: 10000 }); await wait(1200);
    ok(/Declined voice call/.test(await pb.locator('#thread-feed .call-log').last().textContent()), 'declined → "Declined voice call"');
    // ---- voice call: answer + hang up ----
    await pb.click('#thread-call'); await pa.waitForSelector('#call-incoming:not(.hidden)', { timeout: 20000 }); await pa.click('#call-accept');
    await pa.waitForFunction(() => C.pc && C.pc.signalingState === 'stable' && C.pc.getReceivers().filter(r => r.track).length === 1, null, { timeout: 20000 });
    ok(await pa.evaluate(() => C.local.getVideoTracks().length === 0) && !(await pa.isVisible('#call-local')), 'voice call negotiates audio only (no camera)');
    await wait(1500); await pa.click('#call-end'); await pb.waitForSelector('#call.hidden', { state: 'attached', timeout: 10000 }); await wait(1000);
    ok(/Voice call 0:0\d/.test(await pb.locator('#thread-feed .call-log').last().textContent()), 'voice call logged with its length');
    ok(!pa.errors.length && !pb.errors.length, 'no page errors' + (pa.errors.length + pb.errors.length ? ': ' + [...pa.errors, ...pb.errors].join('; ') : ''));
  } catch (e) { ok(false, 'crashed: ' + e.stack.split('\n').slice(0, 6).join('\n')); for (const [i, p] of browser.contexts().flatMap(c => c.pages()).entries()) await p.screenshot({ path: '/tmp/fail' + i + '.png' }).catch(() => {}); }
  await browser.close(); S?.kill(); process.exit(done() ? 1 : 0);
})();
