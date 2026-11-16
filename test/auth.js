// Password accounts: scrypt hashes, sessions, login, rate limit, change password, upgrading old username-only accounts
const fs = require('fs'), os = require('os'), path = require('path');
const { io } = require('socket.io-client');
const { startServer, reporter, once } = require('./helpers');
(async () => {
  const { ok, done } = reporter();
  // seed an "old" account (made before passwords) so we can test the upgrade path
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-auth-'));
  fs.mkdirSync(dir + '/d');
  fs.writeFileSync(dir + '/d/db.json', JSON.stringify({ users: { old1: { id: 'old1', name: 'Olive', username: 'olive', token: 'legacytoken123', color: '#FF3B5C', createdAt: 1 } } }));
  const S = await startServer(3993, { DATA_DIR: dir + '/d' }); const { api } = S;
  try {
    ok((await api('/api/signup', { body: { name: 'Pat', username: 'pat' } })).status === 400, 'sign up without a password is rejected');
    ok((await api('/api/signup', { body: { name: 'Pat', username: 'pat', password: '12345' } })).status === 400, 'password under 6 characters is rejected');
    const p = await api('/api/signup', { body: { name: 'Pat', username: 'pat', password: 'hunter22' } });
    ok(p.token && p.token.length >= 40 && p.user.username === 'pat' && !('passHash' in p.user), 'sign up with username + password returns a long random session token');
    ok((await api('/api/me', { token: p.token })).user.needsPassword === false, 'session token works');
    await new Promise(r => setTimeout(r, 1500)); const raw = fs.readFileSync(dir + '/d/db.json', 'utf8');
    ok(!raw.includes('hunter22') && /scrypt\$/.test(raw) && !raw.includes(p.token), 'stored as a scrypt hash; raw password and token never saved');
    ok((await api('/api/login', { body: { username: 'pat', password: 'wrongpass' } })).status === 401, 'wrong password rejected');
    { const r = await api('/api/login', { body: { username: '@Nobody', password: 'hunter22' } });
      ok(r.status === 404 && r.noAccount === true && r.username === 'nobody', 'unknown username: 404 noAccount with the username');
      ok(/no account with the username @nobody/i.test(r.error) && /sign up/i.test(r.error), 'unknown username: clear "No account… Sign up?" message'); }
    { const r = await api('/api/login', { body: { username: 'pat', password: 'wrongpass2' } });
      ok(r.status === 401 && !r.noAccount && /wrong password/i.test(r.error), 'wrong password for a real account: says wrong password, not "no account"'); }
    const l = await api('/api/login', { body: { username: '@PAT', password: 'hunter22' } });
    ok(l.token && l.token !== p.token, 'log in with password (case-insensitive username) creates a new session');
    const sk = io(S.BASE, { auth: { token: l.token } }); await once(sk, 'connect', 5000); ok(sk.connected, 'realtime socket accepts the session token'); sk.close();
    const bad = io(S.BASE, { auth: { token: 'nope' }, reconnection: false });
    ok(await new Promise(r => { bad.on('connect_error', () => r(true)); bad.on('connect', () => r(false)); }), 'socket rejects a bad token'); bad.close();
    ok((await api('/api/logout', { token: l.token, body: {} })).ok && (await api('/api/me', { token: l.token })).status === 401, 'log out kills that session');
    ok((await api('/api/me', { token: p.token })).status !== 401, '…but not the other device');
    // change password
    ok((await api('/api/me/password', { token: p.token, body: { current: 'nope123', password: 'newpass99' } })).status === 401, 'change password needs the current password');
    const ch = await api('/api/me/password', { token: p.token, body: { current: 'hunter22', password: 'newpass99' } });
    ok(ch.ok && ch.token, 'change password works');
    ok((await api('/api/me', { token: p.token })).status === 401 && (await api('/api/me', { token: ch.token })).status === 200, 'old sessions are signed out; the new token works');
    ok((await api('/api/login', { body: { username: 'pat', password: 'hunter22' } })).status === 401 && (await api('/api/login', { body: { username: 'pat', password: 'newpass99' } })).token, 'old password stops working, new one logs in');
    // rate limit
    let codes = [];
    for (let i = 0; i < 9; i++) codes.push((await api('/api/login', { body: { username: 'pat', password: 'guess' + i } })).status);
    ok(codes.slice(0, 8).every(c => c === 401) && codes[8] === 429, `login is rate-limited after 8 failures (${codes.join(',')})`);
    ok((await api('/api/login', { body: { username: 'pat', password: 'newpass99' } })).status === 429, 'even the right password waits out the lockout');
    // old username-only account
    const om = await api('/api/me', { token: 'legacytoken123' });
    ok(om.user && om.user.needsPassword === true, 'old account still opens on its device, flagged needsPassword');
    const ol = await api('/api/login', { body: { username: 'olive', password: 'whatever1' } });
    ok(ol.status === 403 && ol.needsPassword, "old account can't be claimed from another device without a password");
    const set = await api('/api/me/password', { token: 'legacytoken123', body: { password: 'olive1234' } });
    ok(set.ok && set.token, 'old account sets a password (no current password needed)');
    ok((await api('/api/me', { token: 'legacytoken123' })).status === 401 && (await api('/api/me', { token: set.token })).user.needsPassword === false, 'legacy token retired once a password exists');
    ok((await api('/api/login', { body: { username: 'olive', password: 'olive1234' } })).token, 'old account logs in with its new password');
    ok(!JSON.stringify(await api('/api/users/search?q=oli', { token: set.token })).includes('passHash'), 'password hashes never leave the server');
  } catch (e) { console.error(e); ok(false, 'exception: ' + e.message); }
  S.kill(); process.exit(done() ? 1 : 0);
})();
