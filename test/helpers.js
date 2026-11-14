// Shared test helpers: start a throwaway server and talk to it.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function startServer(port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir + '/d', UPLOAD_DIR: dir + '/u', TICK_MS: 200, ALLOW_TEST_CLOCK: '1', ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  const BASE = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/healthz'); break; } catch { await wait(150); } }
  async function api(p, { token, body, form, method } = {}) {
    const o = { method: method || (body || form ? 'POST' : 'GET'), headers: { 'x-token': token || '' } };
    if (form) { const fd = new FormData(); for (const [k, v] of Object.entries(form)) k === 'photo' ? fd.append(k, new Blob([JPG], { type: 'image/jpeg' }), 'p.jpg') : fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)); o.body = fd; }
    else if (body) { o.body = JSON.stringify(body); o.headers['content-type'] = 'application/json'; }
    const r = await fetch(BASE + p, o); return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }
  const advance = ms => api('/api/test/clock', { body: { advanceMs: ms } });
  return { BASE, api, advance, dir, kill: () => srv.kill() };
}
function reporter() {
  let pass = 0, fail = 0;
  return { ok: (c, m) => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${m}`); }, done: () => { console.log(`\n${pass} passed, ${fail} failed`); return fail; } };
}
const once = (s, ev, ms = 8000, pred = () => true) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error('timeout waiting for ' + ev)); }, ms);
  const h = d => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
module.exports = { startServer, reporter, once, wait, JPG };
