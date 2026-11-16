// Durable storage in Postgres (Neon) so data survives Render free-plan restarts and deploys.
// The app keeps working on its in-memory `db` object + files on local disk (exactly as before);
// this module mirrors both into Postgres:
//   ps_records(coll, id, data jsonb)  - one row per record (user, session, message, peak, ...), write-through on every save()
//   ps_files(path, data bytea)        - every photo (avatars, peaks, memories, stories, hide photos) + vapid keys
// On boot (start.js) everything is restored to disk before server.js loads, so the rest of the code is unchanged.
// Only rows that actually changed are written (diffed against the last synced JSON), inside one transaction.
// When DATABASE_URL is unset (tests, local dev) every function here is a no-op and the JSON file is the store.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const URL = (process.env.DATABASE_URL || '').replace(/([?&]sslmode=)(require|prefer)\b/, '$1verify-full'); // same as pg's current behaviour, minus the warning
const CAP_BYTES = Number(process.env.STORAGE_CAP_MB || 700) * 1024 * 1024; // Neon free plan: 1 GB per project
const MERGE_MS = Number(process.env.STORE_MERGE_MS || 180000); // pick up writes from the old instance during a deploy overlap
const bootId = crypto.randomBytes(6).toString('hex');
let pool = null, db = null, dirs = null;
const prev = new Map();   // "coll\0id" -> JSON last written/read
const known = new Map();  // file key -> "size:mtime" last written/read
const mergedFiles = new Map(); // file key -> updated_at already pulled in by merge()
let fileBytes = 0, recordBytes = 0;
let flushing = null, again = false, timer = null, mergeSince = null, mergeUntil = 0, mergeTimer = null, lastError = null, lastFlushAt = null;

const active = () => !!pool;
const K = (c, i) => c + '\0' + i;
const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
const arrayById = v => Array.isArray(v) && v.every(x => isPlain(x) && (typeof x.id === 'string' || typeof x.id === 'number'))
  && new Set(v.map(x => String(x.id))).size === v.length;

// db object -> Map of "coll\0id" -> [coll, id, json]
function snapshot() {
  const out = new Map(); let bytes = 0;
  const put = (c, i, v) => { if (v === undefined) return; const s = JSON.stringify(v); bytes += s.length; out.set(K(c, i), [c, i, s]); };
  for (const [key, val] of Object.entries(db)) {
    if (isPlain(val)) for (const [i, v] of Object.entries(val)) put(key, i, v);
    else if (arrayById(val)) for (const v of val) put('[]' + key, String(v.id), v);
    else put('$', key, val);
  }
  recordBytes = bytes;
  return out;
}
function applyRecord(target, coll, id, data) {
  if (coll === '$') target[id] = data;
  else if (coll.startsWith('[]')) { const k = coll.slice(2); target[k] ||= []; const a = target[k]; const ix = a.findIndex(x => String(x.id) === id); if (ix >= 0) a[ix] = data; else a.push(data); }
  else { target[coll] ||= {}; target[coll][id] = data; }
}
function currentJson(coll, id) {
  let v;
  if (coll === '$') v = db[id];
  else if (coll.startsWith('[]')) v = (db[coll.slice(2)] || []).find(x => x && String(x.id) === id);
  else v = (db[coll] || {})[id];
  return v === undefined ? undefined : JSON.stringify(v);
}

// ---------- files ----------
function roots() { return [['u', dirs.UPLOAD_DIR], ['d', dirs.DATA_DIR]]; }
const skipFile = rel => /^db\.json(\.tmp)?$/.test(rel) || rel.endsWith('.tmp');
function keyToPath(key) {
  const [r, ...rest] = key.split('/'); const root = roots().find(x => x[0] === r);
  if (!root) return null;
  const p = path.resolve(root[1], rest.join('/'));
  return p.startsWith(path.resolve(root[1]) + path.sep) ? p : null;
}
function walk() { // -> Map key -> {abs, sig, size}
  const out = new Map(); let total = 0;
  for (const [r, base] of roots()) {
    const visit = (dir, rel) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const relp = rel ? rel + '/' + e.name : e.name, abs = path.join(dir, e.name);
        if (e.isDirectory()) { visit(abs, relp); continue; }
        if (!e.isFile() || (r === 'd' && skipFile(relp))) continue;
        try { const st = fs.statSync(abs); out.set(r + '/' + relp, { abs, sig: st.size + ':' + st.mtimeMs, size: st.size }); total += st.size; } catch (_) {}
      }
    };
    visit(base, '');
  }
  fileBytes = total;
  return out;
}
function writeLocal(key, buf) {
  const p = keyToPath(key); if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', buf); fs.renameSync(p + '.tmp', p);
  const st = fs.statSync(p); known.set(key, st.size + ':' + st.mtimeMs);
}
async function downloadFiles(client, list) { // list of {path,size}; batches keep memory low on a 512 MB instance
  let batch = [], size = 0;
  const go = async () => { if (!batch.length) return; const r = await client.query('SELECT path, data FROM ps_files WHERE path = ANY($1)', [batch]); for (const row of r.rows) writeLocal(row.path, row.data); batch = []; size = 0; };
  for (const f of list) { batch.push(f.path); size += f.size; if (size > 8 * 1024 * 1024 || batch.length >= 50) await go(); }
  await go();
}

// ---------- boot: restore Postgres -> disk (called from start.js before server.js loads) ----------
async function restore({ DATA_DIR, UPLOAD_DIR }) {
  if (!URL) return { restored: false };
  const { Pool } = require('pg');
  dirs = { DATA_DIR, UPLOAD_DIR };
  fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  pool = new Pool({ connectionString: URL, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 30000 });
  pool.on('error', e => console.error('[store] pool error', e.message));
  const t0 = Date.now();
  let client;
  for (let i = 0; ; i++) { // Neon may need a moment to wake up from scale-to-zero
    try { client = await pool.connect(); break; } catch (e) { if (i >= 5) throw e; console.log('[store] waiting for database…', e.message); await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    await client.query(`CREATE TABLE IF NOT EXISTS ps_records (coll text NOT NULL, id text NOT NULL, seq bigserial, data jsonb NOT NULL,
      writer text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (coll, id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS ps_files (path text PRIMARY KEY, data bytea NOT NULL, size integer NOT NULL,
      writer text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await client.query('CREATE INDEX IF NOT EXISTS ps_records_updated ON ps_records (updated_at)');
    await client.query('CREATE INDEX IF NOT EXISTS ps_files_updated ON ps_files (updated_at)');
    await client.query('COMMIT');
    mergeSince = (await client.query('SELECT clock_timestamp() - interval \'5 seconds\' AS t')).rows[0].t;
    const recs = await client.query('SELECT coll, id, data FROM ps_records ORDER BY coll, seq');
    const DB_FILE = path.join(DATA_DIR, 'db.json');
    if (recs.rows.length) {
      const restored = {};
      for (const r of recs.rows) applyRecord(restored, r.coll, r.id, r.data);
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(restored)); fs.renameSync(DB_FILE + '.tmp', DB_FILE);
      for (const r of recs.rows) prev.set(K(r.coll, r.id), JSON.stringify(r.data));
    }
    const files = (await client.query('SELECT path, size FROM ps_files ORDER BY path')).rows;
    await downloadFiles(client, files);
    if (recs.rows.length) for (const [k, f] of walk()) if (!known.has(k)) known.set(k, f.sig); // Postgres is the source of truth
    console.log(`[store] restored ${recs.rows.length} records + ${files.length} files from Postgres in ${Date.now() - t0} ms (boot ${bootId})`);
    mergeUntil = Date.now() + MERGE_MS;
    return { restored: true, records: recs.rows.length, files: files.length };
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

// ---------- server.js hands us the live db object ----------
function attach(liveDb) {
  if (!pool) return;
  db = liveDb;
  timer = setInterval(() => changed(), 60000); timer.unref?.(); // backstop: catches changes that skipped save(); no DB traffic if nothing changed
  if (MERGE_MS > 0) { mergeTimer = setInterval(() => merge().catch(e => console.error('[store] merge', e.message)), 4000); mergeTimer.unref?.(); }
  changed();
}
let debounce = null;
function changed() { if (!pool || !db) return; clearTimeout(debounce); debounce = setTimeout(() => flush().catch(() => {}), 250); }

async function flush() {
  if (!pool || !db) return;
  if (flushing) { again = true; return flushing; }
  flushing = (async () => {
    do {
      again = false;
      const cur = snapshot(), files = walk();
      const up = [], del = [], fup = [], fdel = [];
      for (const [k, v] of cur) if (prev.get(k) !== v[2]) up.push(v);
      for (const k of prev.keys()) if (!cur.has(k)) del.push(k.split('\0'));
      for (const [k, f] of files) if (known.get(k) !== f.sig) fup.push([k, f]);
      for (const k of known.keys()) if (!files.has(k)) fdel.push(k);
      if (!up.length && !del.length && !fup.length && !fdel.length) continue;
      const client = await pool.connect();
      const wroteFiles = [];
      try {
        await client.query('BEGIN');
        for (let i = 0; i < up.length; i += 500) {
          const ch = up.slice(i, i + 500);
          await client.query(`INSERT INTO ps_records (coll, id, data, writer) SELECT c, i, d::jsonb, $4 FROM unnest($1::text[], $2::text[], $3::text[]) AS t(c, i, d)
            ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, writer = EXCLUDED.writer, updated_at = clock_timestamp()`,
            [ch.map(x => x[0]), ch.map(x => x[1]), ch.map(x => x[2]), bootId]);
        }
        for (let i = 0; i < del.length; i += 1000) {
          const ch = del.slice(i, i + 1000);
          await client.query('DELETE FROM ps_records r USING unnest($1::text[], $2::text[]) AS t(c, i) WHERE r.coll = t.c AND r.id = t.i', [ch.map(x => x[0]), ch.map(x => x[1])]);
        }
        for (const [k, f] of fup) {
          let buf; try { buf = fs.readFileSync(f.abs); } catch (_) { continue; }
          await client.query(`INSERT INTO ps_files (path, data, size, writer) VALUES ($1, $2, $3, $4)
            ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, size = EXCLUDED.size, writer = EXCLUDED.writer, updated_at = clock_timestamp()`, [k, buf, buf.length, bootId]);
          wroteFiles.push([k, f.sig]);
        }
        if (fdel.length) await client.query('DELETE FROM ps_files WHERE path = ANY($1)', [fdel]);
        await client.query('COMMIT');
        for (const [c, i, s] of up) prev.set(K(c, i), s);
        for (const [c, i] of del) prev.delete(K(c, i));
        for (const [k, sig] of wroteFiles) known.set(k, sig);
        for (const k of fdel) known.delete(k);
        lastError = null; lastFlushAt = Date.now();
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        lastError = e.message; console.error('[store] save to Postgres failed, retrying in 5 s:', e.message);
        setTimeout(changed, 5000);
        break;
      } finally { client.release(); }
    } while (again);
  })();
  try { await flushing; } finally { flushing = null; }
}

// During a deploy the old instance can still be serving for a short while after this one booted.
// For the first few minutes, pull in anything it wrote that this instance hasn't touched itself.
async function merge() {
  if (!pool || !db || Date.now() > mergeUntil) { clearInterval(mergeTimer); return; }
  const since = mergeSince;
  const nowDb = (await pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
  const r = await pool.query('SELECT coll, id, data FROM ps_records WHERE writer IS DISTINCT FROM $1 AND updated_at > $2 ORDER BY seq', [bootId, since]);
  const f = await pool.query('SELECT path, size, updated_at FROM ps_files WHERE writer IS DISTINCT FROM $1 AND updated_at > $2', [bootId, since]);
  let n = 0;
  for (const row of r.rows) {
    const k = K(row.coll, row.id), s = JSON.stringify(row.data), mine = currentJson(row.coll, row.id);
    if (mine === s) { prev.set(k, s); continue; }   // already have it
    if (mine !== prev.get(k)) continue;             // changed here too: keep ours
    applyRecord(db, row.coll, row.id, row.data); prev.set(k, s); n++;
  }
  const newFiles = f.rows.filter(x => mergedFiles.get(x.path) !== +x.updated_at);
  if (newFiles.length) {
    const c = await pool.connect();
    try { await downloadFiles(c, newFiles); } finally { c.release(); }
    for (const x of newFiles) mergedFiles.set(x.path, +x.updated_at);
  }
  if (n || newFiles.length) { console.log(`[store] merged ${n} records + ${newFiles.length} files written by the previous instance`); fs.writeFileSync(path.join(dirs.DATA_DIR, 'db.json'), JSON.stringify(db)); }
  mergeSince = new Date(+nowDb - 3000); // small overlap for transactions that were still committing
}

async function close() { // SIGTERM: Render restart/deploy/spin-down -> write everything out first
  if (!pool) return;
  clearTimeout(debounce);
  try { await flush(); if (again || flushing) await flush(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
}

const overCap = () => !!pool && fileBytes + recordBytes > CAP_BYTES;
const status = () => ({ storage: pool ? 'postgres' : 'file', ...(pool ? { usedMB: +((fileBytes + recordBytes) / 1048576).toFixed(1), capMB: Math.round(CAP_BYTES / 1048576), synced: !lastError } : {}) });
module.exports = { restore, attach, changed, flush, close, active, overCap, status };
