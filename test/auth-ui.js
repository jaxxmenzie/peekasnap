// Browser end-to-end test of sign up / log in / set password on a phone-size iPhone-like browser.
// node test/auth-ui.js                      -> local throwaway server (also tests old username-only accounts)
// node test/auth-ui.js https://example.com  -> a live deploy
const { chromium } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, reporter } = require('./helpers');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const wait = ms => new Promise(r => setTimeout(r, ms));
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
(async () => {
  const { ok, done } = reporter();
  let BASE = process.argv[2], S;
  if (!BASE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-authui-')); fs.mkdirSync(dir + '/d');
    fs.writeFileSync(dir + '/d/db.json', JSON.stringify({ users: { old1: { id: 'old1', name: 'Olive', username: 'olive', token: 'legacytoken123', color: '#FF3B5C', createdAt: 1 } } }));
    S = await startServer(3992, { DATA_DIR: dir + '/d' }); BASE = S.BASE;
  }
  const tag = Date.now().toString(36).slice(-6);
  const browser = await chromium.launch({ executablePath: CHROME });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA };
  const errText = async (page, id) => (await page.locator('#' + id).isVisible()) ? (await page.textContent('#' + id)).trim() : '';
  const errColor = (page, id) => page.$eval('#' + id, el => getComputedStyle(el).color);
  try {
    // taken username: make one through the API
    const taken = 'tk' + tag;
    await fetch(BASE + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Taken', username: taken, password: 'secret123' }) });

    const ctx = await browser.newContext(phone);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const assets = await page.$$eval('script[src], link[rel=stylesheet]', els => els.map(e => e.getAttribute('src') || e.getAttribute('href')).filter(u => /app\.js|styles\.css/.test(u)));
    ok(assets.length === 2 && assets.every(u => /\?v=/.test(u)), `index serves versioned app assets (${assets.join(', ')})`);
    await page.evaluate(() => navigator.serviceWorker.ready); 
    ok(await page.isVisible('#signup-form') && await page.isVisible('#signup-password'), 'sign-up form with password field shown');

    await page.fill('#signup-name', 'Phone Tester'); await page.fill('#signup-username', 'pt' + tag); await page.fill('#signup-password', '123');
    await page.press('#signup-password', 'Enter'); await wait(300);
    const e1 = await errText(page, 'signup-err');
    ok(/at least 6/.test(e1), `too-short password: visible error "${e1}"`);
    ok(/rgb\(255, 1[0-9]{2}/.test(await errColor(page, 'signup-err')), 'error text is red');
    if (S) await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', '31-sign-up-error.png') });

    await page.fill('#signup-username', taken); await page.fill('#signup-password', 'secret123');
    await page.click('#signup-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#signup-err').classList.contains('show'), null, { timeout: 60000 });
    ok(/taken/i.test(await errText(page, 'signup-err')), `taken username: visible error "${await errText(page, 'signup-err')}"`);

    // loading state: hold the request for a moment
    await page.route('**/api/signup', async r => { await wait(1500); r.continue(); });
    await page.fill('#signup-username', 'pt' + tag);
    await page.press('#signup-password', 'Enter'); await wait(400);
    ok(await page.$eval('#signup-form button[type=submit]', b => b.disabled && b.classList.contains('loading')), `loading state while signing up ("${(await page.textContent('#signup-form button[type=submit]')).trim()}")`);
    await page.waitForSelector('#app:not(.hidden)', { timeout: 60000 });
    ok(true, 'Enter/Go key submits; valid sign-up logs in to the app');
    await page.unroute('**/api/signup');

    // log out, then log in
    await page.click('#me-btn'); await page.click('#signout-btn'); await page.click('#ask-actions [data-act="0"]');
    await page.waitForSelector('#onboard:not(.hidden)'); await page.click('#tab-login');
    await page.fill('#login-username', 'pt' + tag); await page.fill('#login-password', 'wrongpass');
    await page.press('#login-password', 'Enter');
    await page.waitForFunction(() => document.querySelector('#login-err').classList.contains('show'), null, { timeout: 30000 });
    if (S) await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', '32-log-in-wrong-password.png') });
    ok(/wrong password/i.test(await errText(page, 'login-err')), `wrong password: visible error "${await errText(page, 'login-err')}"`);
    await ctx.setOffline(true);
    await page.fill('#login-password', 'secret123'); await page.press('#login-password', 'Enter');
    await page.waitForFunction(() => document.querySelector('#login-err').classList.contains('show'), null, { timeout: 15000 });
    ok(/offline|can't reach/i.test(await errText(page, 'login-err')), `network error: visible error "${await errText(page, 'login-err')}"`);
    await ctx.setOffline(false);
    await page.press('#login-password', 'Enter');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    ok(true, 'correct password logs in');
    ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await ctx.close();

    // account that doesn't exist (e.g. wiped by a free-server restart) -> clear message + Sign up shortcut with username filled in
    { const nctx = await browser.newContext(phone); const np = await nctx.newPage(); await np.goto(BASE + '/', { waitUntil: 'networkidle' });
      const ghost = 'gh' + tag;
      await np.click('#tab-login'); await np.fill('#login-username', ghost); await np.fill('#login-password', 'ghostpass1'); await np.press('#login-password', 'Enter');
      await np.waitForFunction(() => document.querySelector('#login-err').classList.contains('show'), null, { timeout: 30000 });
      const msg = await errText(np, 'login-err');
      ok(/no account with the username @/i.test(msg) && /sign up/i.test(msg), `no such account: clear error "${msg}"`);
      ok(await np.isVisible('#login-to-signup') && (await np.textContent('#login-to-signup')).includes('@' + ghost), 'no such account: "Sign up as @name" button shown');
      if (S) await np.screenshot({ path: path.join(__dirname, '..', 'screenshots', '43-login-no-account.png') });
      await np.click('#login-to-signup');
      ok(await np.isVisible('#signup-form') && await np.inputValue('#signup-username') === ghost && await np.inputValue('#signup-password') === 'ghostpass1', 'Sign up shortcut opens Sign up with username + password filled in');
      await np.fill('#signup-name', 'Ghost'); await np.press('#signup-name', 'Enter');
      await np.waitForSelector('#app:not(.hidden)', { timeout: 30000 }); ok(true, 'signing up from the shortcut works');
      // simulate the server losing accounts: saved token stops working -> signed-out note, username prefilled
      await np.evaluate(() => localStorage.setItem('ps_token', 'stale-token-from-wiped-server'));
      await np.reload({ waitUntil: 'networkidle' });
      await np.waitForSelector('#login-form:not(.hidden)', { timeout: 30000 });
      const note = await np.textContent('#auth-note');
      ok(await np.isVisible('#auth-note') && note.includes('@' + ghost), `stale saved login: explains sign-out "${note.trim().slice(0, 60)}…"`);
      ok(await np.inputValue('#login-username') === ghost, 'stale saved login: username prefilled on Log in');
      if (S) await np.screenshot({ path: path.join(__dirname, '..', 'screenshots', '44-signed-out-note.png') });
      await nctx.close(); }

    // installed Home Screen app (standalone)
    const sctx = await browser.newContext({ ...phone, userAgent: IOS_UA.replace(' Version/18.1', '').replace(' Safari/604.1', '') });
    await sctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    const sp = await sctx.newPage(); await sp.goto(BASE + '/', { waitUntil: 'networkidle' });
    await sp.click('#tab-login'); await sp.fill('#login-username', 'pt' + tag); await sp.fill('#login-password', 'secret123'); await sp.press('#login-password', 'Enter');
    await sp.waitForSelector('#app:not(.hidden)', { timeout: 30000 });
    ok(true, 'Home Screen (standalone) app: log in works');
    await sp.reload({ waitUntil: 'networkidle' }); await wait(1500);
    ok(await sp.isVisible('#app') && await sp.evaluate(() => !!navigator.serviceWorker.controller), 'after reload under the service worker: still logged in, fresh code');
    await sctx.close();

    if (S) { // old username-only account
      const octx = await browser.newContext(phone); const op = await octx.newPage(); await op.goto(BASE + '/');
      await op.click('#tab-login'); await op.fill('#login-username', 'olive'); await op.fill('#login-password', 'whatever1'); await op.press('#login-password', 'Enter');
      await op.waitForFunction(() => document.querySelector('#login-err').classList.contains('show'));
      ok(/no password yet/i.test(await errText(op, 'login-err')), `old account from another device: explained "${await errText(op, 'login-err')}"`);
      await octx.close();
      const lctx = await browser.newContext(phone); await lctx.addInitScript(() => localStorage.setItem('ps_token', 'legacytoken123'));
      const lp = await lctx.newPage(); await lp.goto(BASE + '/'); await lp.waitForSelector('#setpw-form:not(.hidden)');
      ok(/@olive/.test(await lp.textContent('#setpw-form')), 'old account on its own device is asked to set a password');
      await lp.fill('#setpw-password', 'abc'); await lp.press('#setpw-password', 'Enter'); await wait(200);
      ok(/at least 6/.test(await errText(lp, 'setpw-err')), 'set password: too short shown');
      await lp.fill('#setpw-password', 'olive1234'); await lp.fill('#setpw-confirm', 'olive9999'); await lp.press('#setpw-confirm', 'Enter'); await wait(200);
      ok(/match/.test(await errText(lp, 'setpw-err')), 'set password: mismatch shown');
      await lp.fill('#setpw-confirm', 'olive1234'); await lp.press('#setpw-confirm', 'Enter');
      await lp.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      ok(true, 'set password succeeds and opens the app');
      await lctx.close();
      const nctx = await browser.newContext(phone); const np = await nctx.newPage(); await np.goto(BASE + '/');
      await np.click('#tab-login'); await np.fill('#login-username', 'olive'); await np.fill('#login-password', 'olive1234'); await np.press('#login-password', 'Enter');
      await np.waitForSelector('#app:not(.hidden)', { timeout: 15000 }); ok(true, 'old account then logs in from a new device with its password');
      await nctx.close();
    }
  } catch (e) { console.error(e); ok(false, 'exception: ' + e.message.split('\n')[0]); }
  await browser.close(); S?.kill(); process.exit(done() ? 1 : 0);
})();
