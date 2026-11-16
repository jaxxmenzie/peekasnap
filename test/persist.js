// Postgres persistence: data must survive restarts (SIGTERM, crash/SIGKILL, fresh disk) and deploy overlaps.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { reporter, wait, JPG } = require('./helpers');
// Uses TEST_DATABASE_URL if set (a throwaway Postgres such as a Neon "tests" branch; its ps_* tables get wiped),
// otherwise a local in-process Postgres (PGlite) started just for this test.
let URL = process.env.TEST_DATABASE_URL, pglite = null;
const { ok, done } = reporter();
const ROOT = path.join(__dirname, '..');

function boot(port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-persist-')); // brand-new empty disk every time, like Render
  let log = '';
  const p = spawn(process.execPath, [path.join(ROOT, 'start.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir + '/d', UPLOAD_DIR: dir + '/u', DATABASE_URL: URL, TICK_MS: 500, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  const BASE = `http://localhost:${port}`;
  const ready = (async () => { for (let i = 0; i < 300; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await wait(200); } throw new Error('server did not start: ' + log); })();
  const exited = new Promise(r => p.on('exit', (code, sig) => r({ code, sig })));
  async function api(pth, { token, body, form, method, file } = {}) {
    const o = { method: method || (body || form ? 'POST' : 'GET'), headers: { 'x-token': token || '' } };
    if (form) { const fd = new FormData(); for (const [k, v] of Object.entries(form)) k === 'photo' || k === 'avatar' ? fd.append(k, new Blob([file || JPG], { type: 'image/jpeg' }), 'p.jpg') : fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)); o.body = fd; }
    else if (body) { o.body = JSON.stringify(body); o.headers['content-type'] = 'application/json'; }
    const r = await fetch(BASE + pth, o); return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }
  return { BASE, api, ready, exited, proc: p, log: () => log, dir };
}

(async () => {
  if (!URL) {
    const port = 5499;
    pglite = spawn(process.execPath, [path.join(ROOT, 'node_modules/@electric-sql/pglite-socket/dist/scripts/server.js'), '--port=' + port, '--max-connections=20'], { stdio: 'ignore' });
    URL = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    for (let i = 0; i < 100; i++) { try { await new Promise((res, rej) => require('net').connect(port, '127.0.0.1').on('connect', function () { this.end(); res(); }).on('error', rej)); break; } catch { await wait(150); } }
    process.on('exit', () => pglite.kill());
    console.log('(using a local in-process Postgres: PGlite)');
  }
  const { Client } = require('pg');
  const c = new Client({ connectionString: URL }); await c.connect();
  await c.query('DROP TABLE IF EXISTS ps_records, ps_files'); await c.end();
  const face = fs.readFileSync(path.join(__dirname, 'fixtures', 'face-a.jpg'));
  let A, B, C, D;
  try {
    // ---- first boot on an empty database ----
    A = boot(4801); await A.ready;
    ok(/restored 0 records/.test(A.log()), 'first boot: schema created, nothing to restore');
    ok((await (await fetch(A.BASE + '/healthz')).json()).storage === 'postgres', 'healthz reports Postgres storage');
    const pat = await A.api('/api/signup', { body: { name: 'Pat', username: 'pat', password: 'hunter22' } });
    const sam = await A.api('/api/signup', { body: { name: 'Sam', username: 'sam', password: 'secret99' } });
    await A.api('/api/friends/request', { token: pat.token, body: { userId: sam.user.id } });
    await A.api('/api/friends/accept', { token: sam.token, body: { userId: pat.user.id } });
    const av = await A.api('/api/me/avatar', { token: pat.token, form: { avatar: 1 }, file: face });
    ok(/^\/uploads\/av-/.test(av.user?.avatar || ''), 'avatar uploaded');
    const peak = await A.api('/api/snaps', { token: pat.token, form: { photo: 1, to: [sam.user.id], timer: 5 }, file: face });
    ok(peak.snaps?.length === 1, 'Peak sent');
    const dm = 'dm_' + [pat.user.id, sam.user.id].sort().join('_');
    await A.api(`/api/chats/${dm}/messages`, { token: sam.token, body: { text: 'see you at 6' } });
    await A.api('/api/nicknames/' + sam.user.id, { token: pat.token, method: 'PUT', body: { nickname: 'Sammy' } });
    await wait(1200);
    // ---- graceful restart (Render restart / deploy / spin-down send SIGTERM) onto a brand-new empty disk ----
    A.proc.kill('SIGTERM'); const ex = await A.exited;
    ok(ex.code === 0 && /SIGTERM: saving/.test(A.log()), 'SIGTERM: saves to Postgres and exits cleanly');
    B = boot(4802); await B.ready;
    ok(/restored \d+ records \+ \d+ files/.test(B.log()), 'restart on an empty disk restores from Postgres: ' + (B.log().match(/restored [^(]+/) || [''])[0].trim());
    const li = await B.api('/api/login', { body: { username: 'pat', password: 'hunter22' } });
    ok(li.status === 200 && li.user.id === pat.user.id, 'account + password survive: log in works');
    ok((await B.api('/api/login', { body: { username: 'pat', password: 'nope1234' } })).status === 401, 'wrong password still rejected');
    ok((await B.api('/api/me', { token: sam.token })).user?.username === 'sam', 'old session token still valid (no forced log-out)');
    const me = await B.api('/api/me', { token: pat.token });
    ok(me.user.avatar === av.user.avatar, 'avatar setting survives');
    const img = await fetch(B.BASE + av.user.avatar);
    ok(img.status === 200 && Buffer.from(await img.arrayBuffer()).equals(fs.readFileSync(path.join(A.dir, 'u', path.basename(av.user.avatar)))), 'avatar photo file survives byte-for-byte');
    ok(me.nicknames?.[sam.user.id] === 'Sammy', 'nickname survives');
    const fl = await B.api('/api/friends', { token: pat.token });
    ok(fl.friends?.some(f => f.user.id === sam.user.id), 'friendship survives');
    const inbox = await B.api('/api/snaps/inbox', { token: sam.token });
    ok(inbox.snaps?.length === 1, 'unopened Peak survives in the inbox');
    const op = await B.api(`/api/snaps/${peak.snaps[0]}/open`, { token: sam.token, body: {} });
    ok(op.image?.startsWith('data:image/jpeg;base64,') && Buffer.from(op.image.split(',')[1], 'base64').equals(face), 'Peak photo survives and opens');
    const chat = await B.api(`/api/chats/${dm}`, { token: pat.token });
    ok(chat.messages?.some(m => m.text === 'see you at 6'), 'chat message survives');
    const mem = await B.api('/api/memories', { token: pat.token });
    ok(mem.memories?.length === 1 && mem.memories[0].thumb !== undefined, 'Memories survive');
    const memFull = await B.api('/api/memories/' + mem.memories[0].id, { token: pat.token });
    ok(memFull.image?.startsWith('data:image/jpeg'), 'Memory photo survives');
    // ---- crash (no chance to save on exit) ----
    const m2 = await B.api(`/api/chats/${dm}/messages`, { token: pat.token, body: { text: 'written right before a crash' } });
    await wait(1500); // write-through: saved within ~0.5 s of the change
    B.proc.kill('SIGKILL'); await B.exited;
    C = boot(4803); await C.ready;
    const chat2 = await C.api(`/api/chats/${dm}`, { token: sam.token });
    ok(chat2.messages?.some(m => m.id === m2.message?.id || m.text === 'written right before a crash'), 'crash (SIGKILL): changes already saved (write-through)');
    ok((await C.api(`/api/snaps/${peak.snaps[0]}/open`, { token: sam.token, body: {} })).status === 410, 'opened Peak stays opened after restart (view-state persisted)');
    // ---- deploy overlap: new instance boots while the old one still serves for a bit ----
    D = boot(4804); await D.ready;
    const late = await C.api('/api/signup', { body: { name: 'Lee', username: 'lee', password: 'leepass1' } });
    const lateMsg = await C.api(`/api/chats/${dm}/messages`, { token: pat.token, body: { text: 'sent to the old instance' } });
    await C.api('/api/me/avatar', { token: late.token, form: { avatar: 1 }, file: face });
    await wait(7000);
    ok((await D.api('/api/login', { body: { username: 'lee', password: 'leepass1' } })).status === 200, 'deploy overlap: account created on the old instance appears on the new one');
    const chat3 = await D.api(`/api/chats/${dm}`, { token: sam.token });
    ok(chat3.messages?.some(m => m.text === 'sent to the old instance'), 'deploy overlap: message sent to the old instance appears on the new one');
    const leeMe = await D.api('/api/me', { token: late.token });
    ok(leeMe.user?.avatar && (await fetch(D.BASE + leeMe.user.avatar)).status === 200, 'deploy overlap: photo uploaded to the old instance is served by the new one');
    C.proc.kill('SIGTERM'); await C.exited;
    // ---- deletes persist too ----
    const del = await D.api(`/api/chats/${dm}/messages/${lateMsg.message?.id}`, { token: pat.token, method: 'DELETE' });
    const rmAv = await D.api('/api/me/avatar', { token: pat.token, method: 'DELETE' });
    await wait(1200);
    D.proc.kill('SIGTERM'); await D.exited;
    const E = boot(4805, { STORAGE_CAP_MB: '0' }); await E.ready;
    const chat4 = await E.api(`/api/chats/${dm}`, { token: pat.token });
    ok(del.status === 200 && !chat4.messages?.some(m => m.text === 'sent to the old instance'), 'unsent message stays deleted after restart');
    ok(rmAv.user?.avatar === null && (await fetch(E.BASE + av.user.avatar)).status === 404 && (await E.api('/api/me', { token: pat.token })).user.avatar === null, 'removed avatar stays removed (file deleted from Postgres too)');
    // ---- storage cap ----
    const full = await E.api('/api/snaps', { token: pat.token, form: { photo: 1, to: [sam.user.id], timer: 5 }, file: face });
    ok(full.status === 507 && /storage is full/i.test(full.error), 'storage cap: new photo uploads refused with a clear message');
    ok((await E.api(`/api/chats/${dm}/messages`, { token: pat.token, body: { text: 'text still works' } })).status === 200, 'storage cap: text messages still work');
    E.proc.kill('SIGTERM'); await E.exited;
  } catch (e) { console.error(e); ok(false, 'exception: ' + e.message.split('\n')[0]); for (const s of [A, B, C, D]) s?.proc.kill('SIGKILL'); }
  pglite?.kill(); process.exit(done() ? 1 : 0);
})();
