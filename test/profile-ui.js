// Browser end-to-end test of profile pictures + nicknames on a phone-size iPhone-like browser.
// node test/profile-ui.js                      -> local throwaway server (also writes screenshots 33-36)
// node test/profile-ui.js https://example.com  -> a live deploy
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
  if (!BASE) { S = await startServer(3991); BASE = S.BASE; }
  const tag = Date.now().toString(36).slice(-5);
  const api = async (p, token, body, method) => { const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'x-token': token || '', ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }); return r.json(); };
  const mk = (name, u) => api('/api/signup', null, { name, username: u + tag, password: 'secret123' });
  const pic = (token, f) => { const fd = new FormData(); fd.append('avatar', new Blob([fs.readFileSync(FIX(f))], { type: 'image/jpeg' }), 'a.jpg'); return api('/api/me/avatar', token, fd); };
  const befriend = async (a, b) => { await api('/api/friends/request', a.token, { userId: b.user.id }); await api('/api/friends/accept', b.token, { userId: a.user.id }); };
  const dm = (a, b, text) => api(`/api/chats/dm_${[a.user.id, b.user.id].sort().join('_')}/messages`, a.token, { text });
  const browser = await chromium.launch({ executablePath: CHROME });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA };
  const open = async who => {
    const ctx = await browser.newContext(phone); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => { localStorage.setItem('ps_token', t); localStorage.setItem('ps_install_snooze', Date.now() + 864e5); }, who.token);
    await page.goto(BASE + '/?u=' + who.user.username + '#chat', { waitUntil: 'networkidle' }); await page.waitForSelector('#app:not(.hidden)', { timeout: 60000 }); await wait(600);
    return page;
  };
  try {
    const A = await mk('Ava Stone', 'ava'), B = await mk('Ben Park', 'ben'), C = await mk('Cleo Ray', 'cleo'), D = await mk('Dex Moon', 'dex');
    ok(A.token && B.token && C.token && D.token, 'test accounts created');
    for (const x of [A, C, D]) await befriend(B, x);
    await pic(C.token, 'face-c.jpg');
    await dm(D, B, 'race you to the park 🏃'); await dm(C, B, 'peak me the sunset!'); await dm(A, B, 'you up? 👀');

    // ---- A: add a profile picture from the "library", crop it, save ----
    const pa = await open(A);
    ok(await pa.$eval('#me-btn', el => !el.querySelector('img') && el.textContent.trim() === 'AS' && getComputedStyle(el).backgroundColor === 'rgb(255, 45, 70)'), 'no picture yet: initials "AS" in a red circle');
    await pa.click('#me-btn'); await pa.waitForSelector('#profile-sheet:not(.hidden)');
    await pa.click('#av-change'); await pa.waitForSelector('#ask-sheet:not(.hidden)');
    ok(await pa.isVisible('text=Take photo') && await pa.isVisible('text=Choose from library'), 'picture menu offers camera + library');
    ok(await pa.$eval('#av-camera', el => el.getAttribute('capture') === 'user' && el.accept === 'image/*'), 'camera option opens the front camera');
    const [fc] = await Promise.all([pa.waitForEvent('filechooser'), pa.click('text=Choose from library')]);
    await fc.setFiles(FIX('face-a.jpg'));
    await pa.waitForSelector('#crop-sheet:not(.hidden)'); await wait(300);
    const box = await pa.$eval('#crop-stage', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await pa.$eval('#crop-zoom', el => { el.value = 1.6; el.dispatchEvent(new Event('input')); });
    await pa.mouse.move(box.x, box.y); await pa.mouse.down(); await pa.mouse.move(box.x - 40, box.y + 30, { steps: 5 }); await pa.mouse.up();
    ok(await pa.isVisible('.crop-mask'), 'crop screen with a circle mask, zoom + drag');
    if (S) await pa.screenshot({ path: SHOT('34-crop-profile-picture.png') });
    const upReq = pa.waitForRequest(r => r.url().endsWith('/api/me/avatar') && r.method() === 'POST');
    await pa.click('#crop-save');
    await upReq;
    await pa.waitForSelector('#crop-sheet.hidden', { state: 'attached', timeout: 30000 });
    const me = await api('/api/me', A.token);
    ok(/^\/uploads\/av-/.test(me.user.avatar || ''), 'picture saved on the server');
    const size = (await (await fetch(BASE + me.user.avatar)).arrayBuffer()).byteLength;
    const dims = await pa.evaluate(async u => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, me.user.avatar);
    ok(dims[0] === 256 && dims[1] === 256 && size < 60000, `resized + compressed in the browser: ${dims.join('x')} JPEG, ${Math.round(size / 1024)} KB (original ${Math.round(fs.statSync(FIX('face-a.jpg')).size / 1024)} KB)`);
    ok(await pa.$eval('#me-btn img', el => el.complete && el.naturalWidth === 256) && await pa.$eval('#profile-av img', el => !!el.src), 'picture shows on the profile + top-left button');
    ok(await pa.isVisible('#av-remove'), 'Remove picture option appears');
    if (S) { await wait(400); await pa.screenshot({ path: SHOT('33-profile-with-picture.png') }); }

    // ---- B: sees pictures, sets a private nickname for Ava ----
    const pb = await open(B);
    const row = name => pb.locator('.chat-row', { hasText: name });
    ok(await row('Ava Stone').locator('.avatar img').count() === 1 && await row('Cleo Ray').locator('.avatar img').count() === 1, 'chat list shows friends\' pictures');
    ok(await row('Dex Moon').locator('.avatar').textContent() === 'DM', 'friend without a picture gets initials');
    await pb.click('#add-friend-btn'); await pb.waitForSelector('#friends-sheet:not(.hidden)');
    await pb.locator('#friend-list .send-row', { hasText: 'Ava Stone' }).locator('[data-fmenu]').click();
    await pb.click('text=Set Nickname'); await pb.waitForSelector('#text-sheet:not(.hidden)');
    ok((await pb.textContent('#text-body')).includes('Only you see this'), 'Set Nickname dialog says only you see it');
    await pb.fill('#text-input', 'Bestie 💖');
    if (S) { await wait(800); await pb.screenshot({ path: SHOT('35-set-nickname.png'), animations: 'disabled' }); }
    await pb.press('#text-input', 'Enter'); await wait(1200);
    ok(await pb.locator('#friend-list .send-row', { hasText: 'Bestie 💖' }).count() === 1, 'friends list shows the nickname');
    ok((await pb.locator('#friend-list .send-row', { hasText: 'Bestie' }).textContent()).includes('@ava' + tag), '…with @username underneath');
    await pb.click('#friends-sheet [data-close]'); await wait(300);
    ok(await row('Bestie 💖').count() === 1 && await row('Ava Stone').count() === 0, 'chat list shows the nickname instead of the display name');
    ok((await row('Bestie 💖').textContent()).includes('@ava' + tag), 'chat list shows @username subtly');
    // nickname for Dex too, via the thread ⋯ menu
    await row('Dex Moon').locator('.grow').click(); await pb.waitForSelector('#thread:not(.hidden)');
    await pb.click('#thread-info'); await pb.click('text=Set Nickname'); await pb.fill('#text-input', 'Dexy'); await pb.click('#text-save'); await wait(1200);
    ok((await pb.textContent('#thread-title')) === 'Dexy' && (await pb.textContent('#thread-sub')).includes('Dex Moon'), 'chat header shows the nickname (real name underneath)');
    await pb.click('#thread-back'); await wait(600);
    if (S) await pb.screenshot({ path: SHOT('36-chat-list-avatars-nicknames.png') });
    // search by nickname
    await pb.fill('#chat-search', 'besti'); await wait(200);
    ok(await pb.locator('.chat-row').count() === 1 && await row('Bestie').count() === 1, 'chat list search finds a nickname');
    await pb.fill('#chat-search', 'ava'); await wait(200);
    ok(await row('Bestie').count() === 1, '…and still finds the real name / username');
    await pb.fill('#chat-search', '');
    await pb.evaluate(() => openSendSheet()); await pb.fill('#send-search', 'dexy'); await wait(200);
    ok(await pb.locator('#send-friends .send-row').count() === 1 && (await pb.textContent('#send-friends')).includes('Dexy'), 'Send To search finds a nickname');
    await pb.click('#send-sheet [data-close]');
    // A never sees B's nickname for her
    ok(!(await (await fetch(BASE + '/api/friends', { headers: { 'x-token': A.token } })).text()).includes('Bestie'), 'nickname stays private to Ben');
    // clear nickname
    await pb.click('#add-friend-btn'); await pb.locator('#friend-list .send-row', { hasText: 'Bestie' }).locator('[data-fmenu]').click();
    await pb.click('text=Edit Nickname'); await pb.click('#text-clear'); await wait(1200); await pb.click('#friends-sheet [data-close]');
    ok(await row('Ava Stone').count() === 1, 'Clear Nickname goes back to the display name');

    // ---- A changes her own display name; removes the picture ----
    await pa.click('#name-btn'); await pa.fill('#text-input', 'Ava ✨'); await pa.press('#text-input', 'Enter'); await wait(1500);
    ok((await pa.textContent('#profile-name')) === 'Ava ✨', 'set your own display name (nickname) on your profile');
    ok(await row('Ava ✨').count() === 1, 'friends see the new display name live');
    await pa.click('#av-remove'); await pa.click('#ask-actions >> text=Remove picture'); await wait(1500);
    ok(await pa.$eval('#me-btn', el => !el.querySelector('img') && el.textContent.trim().startsWith('A') && getComputedStyle(el).backgroundColor === 'rgb(255, 45, 70)'), 'remove picture → initials again');
    ok(await row('Ava ✨').locator('.avatar img').count() === 0, 'friends see the picture removed live');
    ok(!pa.errors.length && !pb.errors.length, 'no page errors' + (pa.errors.length + pb.errors.length ? ': ' + [...pa.errors, ...pb.errors].join('; ') : ''));
  } catch (e) { ok(false, 'crashed: ' + e.stack); }
  await browser.close(); S?.kill(); process.exit(done() ? 1 : 0);
})();
