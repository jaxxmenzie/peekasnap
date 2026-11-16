// PeekaSnap - photo hide-and-seek game server
// Express (REST + static) + Socket.IO (realtime) + JSON-file storage + photos on disk,
// mirrored to Postgres by lib/store.js when DATABASE_URL is set (see start.js).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const webpush = require('web-push');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Clock (tests can move it forward when ALLOW_TEST_CLOCK=1 to check 24h expiry, game timers, etc.)
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
const FIND_RADIUS_M = Number(process.env.FIND_RADIUS_M || 25); // GPS distance that auto-accepts a find
const TICK_MS = Number(process.env.TICK_MS || 2000);
// Pings never fire sooner than this after the hiding spot is marked (on hide AND after each move). Default 5 min.
const MIN_PING_DELAY_MS = Number(process.env.MIN_PING_DELAY_MS || 5 * 60000);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- storage ----------
let db = { users: {}, groups: {}, hides: {}, messages: [], subs: {}, friends: {}, snaps: {}, stories: {}, reads: {}, locs: {}, streaks: {}, hunts: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) {}
store.attach(db); // no-op without DATABASE_URL
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    store.changed();
  }, 200);
}
// ---------- Web Push (VAPID keys from env, or generated once and kept in DATA_DIR) ----------
let vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!vapid.publicKey || !vapid.privateKey) {
  const f = path.join(DATA_DIR, 'vapid.json');
  try { vapid = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(f, JSON.stringify(vapid)); }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:peekasnap@example.com', vapid.publicKey, vapid.privateKey);
// send a push to group members (optionally only some of them); stale subscriptions are dropped
function pushToGroup(groupId, payload, { only, except } = {}) {
  const g = db.groups[groupId]; if (!g) return;
  pushToUsers(g.members.filter(uid => !(except && uid === except) && !(only && uid !== only)), payload);
}
function pushToUsers(uids, payload) {
  for (const uid of uids) {
    for (const sub of (db.subs[uid] || [])) {
      webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' }).catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) { db.subs[uid] = (db.subs[uid] || []).filter(x => x.endpoint !== sub.endpoint); save(); }
      });
    }
  }
}

const id = (n = 8) => crypto.randomBytes(n).toString('hex');
function joinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (Object.values(db.groups).some(g => g.code === c));
  return c;
}

// ---------- geo helpers ----------
const toRad = d => (d * Math.PI) / 180;
function distanceM(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function offsetPoint(p, meters, bearingRad) {
  const dLat = (meters * Math.cos(bearingRad)) / 111320;
  const dLng = (meters * Math.sin(bearingRad)) / (111320 * Math.cos(toRad(p.lat)));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}
const validPoint = p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && Math.abs(+p.lat) <= 90 && Math.abs(+p.lng) <= 180;
const pt = p => ({ lat: +p.lat, lng: +p.lng });

// Hint for ping #k (1-based): a circle that always contains the hidden spot, shrinking each ping.
// If the hider moved the object, shrinking restarts from the move so the new circle is fair.
function makeHint(hide, k) {
  const steps = Math.max(1, k - (hide.movedAtPing || 0));
  const r = Math.max(30, Math.round(hide.radius * Math.pow(0.6, steps)));
  const off = Math.random() * r * 0.7; // spot stays inside the circle, but not at the center
  return { center: offsetPoint(hide.spot, off, Math.random() * 2 * Math.PI), radius: r };
}
function heatBand(d) {
  if (d <= FIND_RADIUS_M) return { band: 'on fire', emoji: '🔥🔥' };
  if (d <= 75) return { band: 'hot', emoji: '🔥' };
  if (d <= 200) return { band: 'warm', emoji: '☀️' };
  if (d <= 500) return { band: 'cool', emoji: '🌥️' };
  return { band: 'cold', emoji: '🧊' };
}

// ---------- serialization (never leak the hidden spot to seekers) ----------
const publicUser = u => u && { id: u.id, name: u.name, username: u.username, color: u.color, avatar: u.avatar || null };
function publicHide(h, viewerId) {
  const isHider = h.hiderId === viewerId;
  const done = h.status !== 'active';
  return {
    id: h.id, groupId: h.groupId, object: h.object, photo: h.photo,
    hider: publicUser(db.users[h.hiderId]), center: h.center, radius: h.radius,
    firstPingAt: h.firstPingAt, intervalMin: h.intervalMin, pingCount: h.pingCount,
    pings: h.pings, nextPingAt: nextPingAt(h), status: h.status, createdAt: h.createdAt,
    endsAt: endsAt(h),
    foundBy: publicUser(db.users[h.foundBy]), foundAt: h.foundAt, foundPhoto: h.foundPhoto,
    spot: isHider || done ? h.spot : undefined, // revealed once the round is over
    isHider,
    moveCount: (h.moves || []).length, movedAtPing: h.movedAtPing || 0,
    hintOutdated: !!h.pings.length && (h.movedAtPing || 0) >= h.pings.length && (h.moves || []).some(m => m.moved && m.atPing === h.pings.length),
    canMove: isHider && canMove(h),
    claims: isHider ? h.claims.filter(c => c.status === 'pending').map(c => ({ ...c, user: publicUser(db.users[c.userId]) })) : undefined,
    myClaim: !isHider ? (h.claims.filter(c => c.userId === viewerId).slice(-1)[0] || null) : undefined,
  };
}
// Relocate window: after each ping the hider may move/rename once, until the next ping fires.
function canMove(h) {
  return h.status === 'active' && h.pings.length > 0 && (h.lastMovePing || 0) < h.pings.length;
}
function nextPingAt(h) {
  if (h.status !== 'active' || h.pings.length >= h.pingCount) return null;
  return h.nextAt ?? h.firstPingAt + h.pings.length * h.intervalMin * 60000;
}
function endsAt(h) { // one more interval after the last ping, then the hider "escapes"
  return h.endAt ?? h.firstPingAt + h.pingCount * h.intervalMin * 60000;
}

function leaderboard(groupId) {
  const g = db.groups[groupId];
  const pts = {}; g.members.forEach(m => (pts[m] = { points: 0, finds: 0, hides: 0, escapes: 0 }));
  for (const h of Object.values(db.hides)) {
    if (h.groupId !== groupId) continue;
    const hp = (pts[h.hiderId] ||= { points: 0, finds: 0, hides: 0, escapes: 0 });
    hp.hides++;
    hp.points += 3 * h.pings.length; // hider earns 3 per ping survived
    if (h.status === 'found' && h.foundBy) {
      const fp = (pts[h.foundBy] ||= { points: 0, finds: 0, hides: 0, escapes: 0 });
      fp.finds++;
      fp.points += 10 + 5 * Math.max(0, h.pingCount - h.pings.length); // faster find = bonus
    } else if (h.status === 'escaped') { hp.escapes++; hp.points += 10; }
  }
  return Object.entries(pts).map(([uid, s]) => ({ user: publicUser(db.users[uid]), ...s }))
    .filter(r => r.user).sort((a, b) => b.points - a.points);
}

// ---------- app ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.set('trust proxy', 1); // Render terminates TLS in front of us; req.ip = real client
app.use(express.json({ limit: '200kb' }));
// PWA files: correct manifest type, and never let browsers cache an old service worker
app.get('/manifest.json', (req, res) => { res.type('application/manifest+json'); res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'manifest.json')); });
app.get('/sw.js', (req, res) => { res.type('application/javascript'); res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); res.sendFile(path.join(__dirname, 'public', 'sw.js')); });
// index.html is served with versioned asset URLs (?v=<build>) so phones never run an old cached app.js against a new page
const BUILD = (process.env.RENDER_GIT_COMMIT || '').slice(0, 8) || String(Date.now());
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace(/(src|href)="\/(app\.js|game\.js|hunt\.js|call\.js|styles\.css)"/g, `$1="/$2?v=${BUILD}"`);
const sendIndex = (req, res) => { res.type('html'); res.set('Cache-Control', 'no-cache'); res.send(INDEX_HTML); };
app.get(['/', '/index.html'], sendIndex);
app.get('/api/version', (req, res) => res.json({ build: BUILD }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, f) => { if (/\.(html|js|css)$/.test(f)) res.set('Cache-Control', 'no-cache'); } }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.get('/healthz', (req, res) => res.json({ ok: true, ...store.status() }));
// keep under the Neon free plan's 1 GB: refuse new photo uploads once storage is nearly full
app.use((req, res, next) => (req.method === 'POST' && /multipart/i.test(req.headers['content-type'] || '') && store.overCap())
  ? res.status(507).json({ error: 'PeekaSnap storage is full right now. Delete some Memories and try again.' }) : next());
app.get('/api/config', (req, res) => res.json({ minPingDelayMs: MIN_PING_DELAY_MS, findRadiusM: FIND_RADIUS_M }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, id(12) + (path.extname(file.originalname || '').toLowerCase().match(/^\.(jpe?g|png|webp|gif|heic)$/) ? path.extname(file.originalname).toLowerCase() : '.jpg')),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- accounts: scrypt password hashes + random session tokens (only their SHA-256 is stored) ----------
db.sessions ||= {};
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hex] = stored.split('$');
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32, SCRYPT);
  return crypto.timingSafeEqual(h, Buffer.from(hex, 'hex'));
}
const pwError = pw => (typeof pw !== 'string' || pw.length < 6 ? 'Password must be at least 6 characters' : pw.length > 200 ? 'Password is too long' : null);
function newSession(u) {
  const tok = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(tok)] = { uid: u.id, createdAt: now() };
  return tok;
}
function userByToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const s = db.sessions[sha(tok)];
  if (s && db.users[s.uid]) return db.users[s.uid];
  // accounts made before passwords existed keep their device token until they set a password
  return Object.values(db.users).find(x => x.token && !x.passHash && x.token === tok) || null;
}
function auth(req, res, next) {
  const tok = req.get('x-token') || req.query.token;
  const u = userByToken(tok);
  if (!u) return res.status(401).json({ error: 'Sign in first' });
  req.user = u; req.token = tok; next();
}
// light brute-force protection: 8 failed logins per username+IP per 15 min
const loginFails = new Map();
const failKey = (req, username) => `${req.ip}|${username}`;
function loginBlocked(key) {
  const f = loginFails.get(key); if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { loginFails.delete(key); return false; }
  return f.count >= 8;
}
function noteFail(key) { const f = loginFails.get(key); if (!f || Date.now() - f.first > 15 * 60e3) loginFails.set(key, { first: Date.now(), count: 1 }); else f.count++; }
setInterval(() => { for (const [k, f] of loginFails) if (Date.now() - f.first > 15 * 60e3) loginFails.delete(k); }, 60e3).unref();
function member(req, res, next) {
  const g = db.groups[req.params.gid || req.body.groupId];
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (!g.members.includes(req.user.id)) return res.status(403).json({ error: 'Not in this group' });
  req.group = g; next();
}
function hideAccess(req, res, next) {
  const h = db.hides[req.params.hid];
  if (!h) return res.status(404).json({ error: 'Hide not found' });
  const g = db.groups[h.groupId];
  if (!g || !g.members.includes(req.user.id)) return res.status(403).json({ error: 'Not in this group' });
  req.hide = h; req.group = g; next();
}
const bad = (res, msg) => res.status(400).json({ error: msg });

function postMessage(groupId, msg) {
  const m = { id: id(), groupId, chatId: groupId, createdAt: now(), type: 'chat', ...msg };
  db.messages.push(m);
  if (db.messages.length > 20000) db.messages.splice(0, db.messages.length - 20000);
  save();
  io.to('g:' + groupId).emit('message', serializeMsg(m));
  return m;
}
const serializeMsg = m => ({ ...m, user: publicUser(db.users[m.userId]) });
function broadcastHide(h) {
  // each socket gets its own view (hider sees spot + claims)
  io.in('g:' + h.groupId).fetchSockets().then(socks => socks.forEach(s => s.emit('hide', publicHide(h, s.data.userId))));
}

const COLORS = ['#FF3B5C', '#00C2FF', '#9B5CFF', '#00D27A', '#FF8A00', '#FF4FD8', '#1E90FF'];
app.post('/api/signup', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (name.length < 2) return bad(res, 'Pick a name with at least 2 characters');
  const pe = pwError(req.body.password); if (pe) return bad(res, pe);
  let username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
  if (username) {
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) return bad(res, 'Usernames are 3-20 letters, numbers, _ or .');
    if (Object.values(db.users).some(x => x.username === username)) return res.status(409).json({ error: 'That username is taken' });
  } else {
    const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14) || 'player';
    do { username = base + crypto.randomInt(100, 9999); } while (Object.values(db.users).some(x => x.username === username));
  }
  const u = { id: id(), name, username, passHash: hashPassword(req.body.password), color: COLORS[crypto.randomInt(COLORS.length)], shareLocation: false, createdAt: now() };
  db.users[u.id] = u; const token = newSession(u); save();
  res.json({ user: { ...publicUser(u), shareLocation: false }, token });
});
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
  const key = failKey(req, username);
  if (loginBlocked(key)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  const u = Object.values(db.users).find(x => x.username === username);
  if (u && !u.passHash) return res.status(403).json({ error: 'This account has no password yet. Open PeekaSnap on the device you signed up on and it will ask you to set one.', needsPassword: true });
  if (!u) { noteFail(key); return res.status(404).json({ error: `No account with the username @${username.slice(0, 20)}. Sign up?`, noAccount: true, username: username.slice(0, 20) }); }
  if (!checkPassword(req.body.password || '', u.passHash)) { noteFail(key); return res.status(401).json({ error: 'Wrong password for @' + username + '. Try again.' }); }
  loginFails.delete(key);
  const token = newSession(u); save();
  res.json({ user: { ...publicUser(u), shareLocation: !!u.shareLocation }, token });
});
app.post('/api/logout', auth, (req, res) => { delete db.sessions[sha(req.token)]; save(); res.json({ ok: true }); });
// set a password (old accounts) or change it (needs the current one); signs out every other device
app.post('/api/me/password', auth, (req, res) => {
  const u = req.user;
  if (u.passHash) {
    const key = failKey(req, 'pw:' + u.id);
    if (loginBlocked(key)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
    if (!checkPassword(req.body.current || '', u.passHash)) { noteFail(key); return res.status(401).json({ error: 'Current password is wrong' }); }
  }
  const pe = pwError(req.body.password); if (pe) return bad(res, pe);
  u.passHash = hashPassword(req.body.password); delete u.token;
  for (const [k, sess] of Object.entries(db.sessions)) if (sess.uid === u.id) delete db.sessions[k];
  const token = newSession(u); save();
  res.json({ ok: true, token });
});
app.get('/api/push/key', (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return bad(res, 'Bad subscription');
  db.subs ||= {};
  const list = (db.subs[req.user.id] ||= []).filter(x => x.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  db.subs[req.user.id] = list.slice(-5); save();
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, (req, res) => {
  db.subs ||= {};
  db.subs[req.user.id] = (db.subs[req.user.id] || []).filter(x => x.endpoint !== (req.body && req.body.endpoint)); save();
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => {
  const groups = Object.values(db.groups).filter(g => g.members.includes(req.user.id))
    .map(g => ({ id: g.id, name: g.name, code: g.code, emoji: g.emoji, memberCount: g.members.length }));
  res.json({ user: { ...publicUser(req.user), shareLocation: !!req.user.shareLocation, needsPassword: !req.user.passHash }, groups, nicknames: req.user.nicknames || {} });
});
app.post('/api/groups', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 32);
  if (!name) return bad(res, 'Group needs a name');
  const g = { id: id(), name, code: joinCode(), emoji: String(req.body.emoji || '👀').slice(0, 4), ownerId: req.user.id, members: [req.user.id], createdAt: now() };
  db.groups[g.id] = g; save();
  io.in('u:' + req.user.id).socketsJoin('g:' + g.id);
  postMessage(g.id, { type: 'system', text: `${req.user.name} created the group. Share code ${g.code} to invite friends!` });
  res.json({ group: g });
});
app.post('/api/groups/join', auth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const g = Object.values(db.groups).find(x => x.code === code);
  if (!g) return res.status(404).json({ error: 'No group with that code' });
  if (!g.members.includes(req.user.id)) {
    g.members.push(req.user.id); save();
    io.in('u:' + req.user.id).socketsJoin('g:' + g.id);
    postMessage(g.id, { type: 'system', text: `${req.user.name} joined the group 👋` });
  }
  res.json({ group: g });
});
app.post('/api/groups/:gid/leave', auth, member, (req, res) => {
  req.group.members = req.group.members.filter(m => m !== req.user.id); save();
  io.in('u:' + req.user.id).socketsLeave('g:' + req.group.id);
  postMessage(req.group.id, { type: 'system', text: `${req.user.name} left the group` });
  res.json({ ok: true });
});
app.get('/api/groups/:gid', auth, member, (req, res) => {
  const g = req.group;
  res.json({
    group: { id: g.id, name: g.name, code: g.code, emoji: g.emoji, members: g.members.map(m => publicUser(db.users[m])).filter(Boolean) },
    hides: Object.values(db.hides).filter(h => h.groupId === g.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(h => publicHide(h, req.user.id)),
    messages: db.messages.filter(m => (m.chatId || m.groupId) === g.id).slice(-100).map(serializeMsg),
    leaderboard: leaderboard(g.id),
  });
});
app.post('/api/groups/:gid/messages', auth, member, upload.single('photo'), (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text && !req.file) return bad(res, 'Empty message');
  const m = postMessage(req.group.id, { userId: req.user.id, text, photo: req.file ? '/uploads/' + req.file.filename : undefined });
  res.json({ message: serializeMsg(m) });
});

// Create a hide: photo + object + play area (center, radius) + hidden spot + ping schedule
app.post('/api/groups/:gid/hides', auth, member, upload.single('photo'), (req, res) => {
  const b = req.body;
  const object = String(b.object || '').trim().slice(0, 60);
  if (!object) return bad(res, 'What object are you hiding?');
  if (!req.file) return bad(res, 'Take a photo of the object');
  const center = { lat: b.centerLat, lng: b.centerLng }, spot = { lat: b.spotLat, lng: b.spotLng };
  if (!validPoint(center)) return bad(res, 'Set the play area center');
  if (!validPoint(spot)) return bad(res, 'Set where the object is hidden');
  const radius = Math.round(+b.radius);
  if (!(radius >= 30 && radius <= 5000)) return bad(res, 'Play area radius must be 30 m - 5 km');
  if (distanceM(pt(center), pt(spot)) > radius) return bad(res, 'The hiding spot must be inside the play area');
  const intervalMin = +b.intervalMin;
  if (!(intervalMin >= 0.05 && intervalMin <= 1440)) return bad(res, 'Ping interval must be between 3 seconds and 24 hours');
  const pingCount = Math.round(+b.pingCount || 3);
  if (!(pingCount >= 1 && pingCount <= 20)) return bad(res, 'Pings must be 1-20');
  let firstPingAt = b.firstPingAt ? (isNaN(+b.firstPingAt) ? Date.parse(b.firstPingAt) : +b.firstPingAt) : now() + intervalMin * 60000;
  if (!Number.isFinite(firstPingAt)) return bad(res, 'Bad first ping time');
  firstPingAt = Math.max(firstPingAt, now() + MIN_PING_DELAY_MS); // at least 5 min after the spot is marked
  const h = {
    id: id(), groupId: req.group.id, hiderId: req.user.id, object, photo: '/uploads/' + req.file.filename,
    center: pt(center), radius, spot: pt(spot), firstPingAt, nextAt: firstPingAt, intervalMin, pingCount,
    pings: [], claims: [], heatChecks: {}, moves: [], lastMovePing: 0, movedAtPing: 0, status: 'active', createdAt: now(),
  };
  db.hides[h.id] = h; save();
  broadcastHide(h);
  postMessage(h.groupId, { type: 'hide', hideId: h.id, userId: req.user.id, photo: h.photo,
    firstPingAt, text: `${req.user.name} hid a ${object}! 🫣 Can you find it?` });
  pushToGroup(h.groupId, { title: `🫣 ${req.user.name} hid a ${object}!`, body: `First ping in ${Math.max(1, Math.round((firstPingAt - now()) / 60000))} min. Go hunt!`, tag: 'hide-' + h.id, url: '/#chat' }, { except: req.user.id });
  res.json({ hide: publicHide(h, req.user.id) });
});
app.get('/api/hides/:hid', auth, hideAccess, (req, res) => res.json({ hide: publicHide(req.hide, req.user.id) }));

// Hot/cold: after each ping, every seeker may ask once how close they are.
app.post('/api/hides/:hid/heat', auth, hideAccess, (req, res) => {
  const h = req.hide;
  if (h.hiderId === req.user.id) return bad(res, "You hid it - you know where it is 😉");
  if (h.status !== 'active') return bad(res, 'This round is over');
  if (!h.pings.length) return bad(res, 'Hot/cold unlocks at the first ping');
  if (!validPoint(req.body)) return bad(res, 'Need your location');
  const key = req.user.id;
  if ((h.heatChecks[key] || 0) >= h.pings.length) return res.status(429).json({ error: 'You used your hot/cold check for this ping. Wait for the next one!' });
  h.heatChecks[key] = h.pings.length; save();
  res.json(heatBand(distanceM(pt(req.body), h.spot)));
});

function markFound(h, userId, photo) {
  h.status = 'found'; h.foundBy = userId; h.foundAt = now(); h.foundPhoto = photo;
  h.claims.forEach(c => { if (c.status === 'pending') c.status = c.userId === userId && c.photo === photo ? 'accepted' : 'closed'; });
  save();
  broadcastHide(h);
  const u = db.users[userId];
  postMessage(h.groupId, { type: 'found', hideId: h.id, userId, photo, text: `🏆 ${u.name} found ${db.users[h.hiderId].name}'s ${h.object}!` });
  io.to('g:' + h.groupId).emit('found', { hideId: h.id, object: h.object, finder: publicUser(u) });
  pushToGroup(h.groupId, { title: '🏆 Found!', body: `${u.name} found ${db.users[h.hiderId].name}'s ${h.object}`, tag: 'hide-' + h.id, url: '/#chat' }, { except: userId });
}

// "I found it": confirm photo + GPS. Auto-accept within FIND_RADIUS_M, otherwise the hider reviews it.
app.post('/api/hides/:hid/find', auth, hideAccess, upload.single('photo'), (req, res) => {
  const h = req.hide;
  if (h.hiderId === req.user.id) return bad(res, "You can't find your own object");
  if (h.status !== 'active') return bad(res, 'This round is over');
  if (!req.file) return bad(res, 'Take a photo of the object you found');
  const photo = '/uploads/' + req.file.filename;
  const loc = { lat: req.body.lat, lng: req.body.lng };
  const d = validPoint(loc) ? distanceM(pt(loc), h.spot) : null;
  const claim = { id: id(), userId: req.user.id, photo, at: now(), distance: d == null ? null : Math.round(d), status: 'pending' };
  h.claims.push(claim);
  if (d != null && d <= FIND_RADIUS_M) {
    markFound(h, req.user.id, photo);
    return res.json({ result: 'accepted', message: 'You found it! 🎉' });
  }
  save(); broadcastHide(h);
  io.in('g:' + h.groupId).fetchSockets().then(s => s.filter(x => x.data.userId === h.hiderId).forEach(x =>
    x.emit('claim', { hideId: h.id, object: h.object, user: publicUser(req.user) })));
  pushToGroup(h.groupId, { title: '👀 Find claim', body: `${req.user.name} says they found your ${h.object}. Tap to review.`, tag: 'claim-' + h.id, url: '/#chat' }, { only: h.hiderId });
  res.json({ result: 'pending', message: d == null
    ? 'No GPS fix - sent to the hider to confirm your photo.'
    : "GPS says you're not quite there yet - sent to the hider to confirm your photo." });
});
// Hider confirms or rejects a pending claim
app.post('/api/hides/:hid/claims/:cid', auth, hideAccess, (req, res) => {
  const h = req.hide;
  if (h.hiderId !== req.user.id) return res.status(403).json({ error: 'Only the hider can review claims' });
  const c = h.claims.find(x => x.id === req.params.cid);
  if (!c || c.status !== 'pending') return res.status(404).json({ error: 'Claim not found' });
  if (req.body.accept) { c.status = 'accepted'; markFound(h, c.userId, c.photo); }
  else { c.status = 'rejected'; save(); broadcastHide(h);
    postMessage(h.groupId, { type: 'system', text: `❌ ${req.user.name} says ${db.users[c.userId].name} hasn't found the ${h.object} yet. Keep looking!` }); }
  res.json({ hide: publicHide(h, req.user.id) });
});
// Hider moves the object and/or renames it (and optionally re-snaps it) during the relocate window.
app.post('/api/hides/:hid/move', auth, hideAccess, upload.single('photo'), (req, res) => {
  const h = req.hide, b = req.body;
  if (h.hiderId !== req.user.id) return res.status(403).json({ error: 'Only the hider can move it' });
  if (h.status !== 'active') return bad(res, 'This round is over');
  if (!h.pings.length) return bad(res, 'You can move it after the first ping');
  if (!canMove(h)) return res.status(409).json({ error: 'You already moved it this ping. Wait for the next ping!' });
  const change = { atPing: h.pings.length, at: now(), moved: false, renamed: false, newPhoto: false };
  if (b.spotLat != null && b.spotLat !== '') {
    const spot = { lat: b.spotLat, lng: b.spotLng };
    if (!validPoint(spot)) return bad(res, 'Bad new spot');
    if (distanceM(pt(spot), h.center) > h.radius) return bad(res, 'The new spot must be inside the play area');
    if (distanceM(pt(spot), h.spot) > 1) { change.from = h.spot; h.spot = pt(spot); change.moved = true; }
  }
  const object = String(b.object || '').trim().slice(0, 60);
  const oldName = h.object;
  if (object && object !== h.object) { h.object = object; change.renamed = true; change.oldName = oldName; }
  if (req.file) { h.photo = '/uploads/' + req.file.filename; change.newPhoto = true; }
  if (!change.moved && !change.renamed && !change.newPhoto) return bad(res, 'Nothing changed - drag the spot, rename it, or take a new photo');
  (h.moves ||= []).push(change); h.lastMovePing = h.pings.length;
  if (change.moved) {
    h.movedAtPing = h.pings.length; h.heatChecks = {}; // old hint is stale; fresh hot/cold check
    // the next ping (or the end of the hunt, after the last ping) waits at least 5 min after the new spot is marked
    if (h.pings.length < h.pingCount) h.nextAt = Math.max(nextPingAt(h), now() + MIN_PING_DELAY_MS);
    else h.endAt = Math.max(endsAt(h), now() + MIN_PING_DELAY_MS);
  }
  save(); broadcastHide(h);
  const what = [change.moved && 'moved it 🔀', change.renamed && `renamed it to "${h.object}"`, change.newPhoto && 'snapped a new photo'].filter(Boolean).join(', ');
  pushToGroup(h.groupId, { title: '🔀 It moved!', body: `${req.user.name} ${what.replace(' 🔀', '')}${change.renamed ? '' : ` (the ${h.object})`}`, tag: 'hide-' + h.id, url: '/#play' }, { except: req.user.id });
  io.to('g:' + h.groupId).emit('moved', { hideId: h.id, object: h.object, oldName, moved: change.moved, renamed: change.renamed, newPhoto: change.newPhoto, hider: publicUser(req.user) });
  postMessage(h.groupId, { type: 'move', hideId: h.id, photo: h.photo, text: `🔀 ${req.user.name} ${what}${change.renamed ? '' : ` (the ${h.object})`}!${change.moved ? ` The old hint circle is out of date. Next ping (pointing to the new spot) at the earliest in ${MIN_PING_DELAY_MS >= 60000 ? Math.round(MIN_PING_DELAY_MS / 60000) + ' min' : Math.round(MIN_PING_DELAY_MS / 1000) + ' s'}.` : ''}` });
  res.json({ hide: publicHide(h, req.user.id) });
});

// Hider ends the round early
app.post('/api/hides/:hid/end', auth, hideAccess, (req, res) => {
  const h = req.hide;
  if (h.hiderId !== req.user.id) return res.status(403).json({ error: 'Only the hider can end it' });
  if (h.status !== 'active') return bad(res, 'Already over');
  h.status = 'cancelled'; save(); broadcastHide(h);
  postMessage(h.groupId, { type: 'system', text: `${req.user.name} ended the hunt for the ${h.object}.` });
  res.json({ hide: publicHide(h, req.user.id) });
});

// ---------- ping scheduler ----------
function firePing(h) {
  const k = h.pings.length + 1;
  const hint = makeHint(h, k);
  const p = { n: k, at: now(), ...hint };
  h.pings.push(p);
  h.nextAt = p.at + h.intervalMin * 60000;
  if (k >= h.pingCount) h.endAt = p.at + h.intervalMin * 60000;
  save();
  broadcastHide(h);
  io.to('g:' + h.groupId).emit('ping', { hideId: h.id, object: h.object, n: k, of: h.pingCount, hint, hider: publicUser(db.users[h.hiderId]), canMove: true });
  pushToGroup(h.groupId, { title: `📡 Ping ${k}/${h.pingCount}: ${h.object}`, body: `It's within ${hint.radius} m of the new circle. Hot/cold unlocked!`, tag: 'hide-' + h.id, url: '/#play' }, { except: h.hiderId });
  pushToGroup(h.groupId, { title: `📡 Ping ${k}/${h.pingCount}: your ${h.object}`, body: 'Seekers got a new hint. Open now to move or rename it before the next ping!', tag: 'hide-' + h.id, url: '/#play' }, { only: h.hiderId });
  postMessage(h.groupId, { type: 'ping', hideId: h.id, text: `📡 PING ${k}/${h.pingCount} for the ${h.object}! It's within ${hint.radius} m of the new circle. Hot/cold check unlocked.` });
}
function tick() {
  const t = now();
  for (const h of Object.values(db.hides)) {
    if (h.status !== 'active') continue;
    const due = nextPingAt(h);
    if (due && t >= due) firePing(h);
    else if (!due && t >= endsAt(h)) {
      h.status = 'escaped'; save(); broadcastHide(h);
      postMessage(h.groupId, { type: 'system', text: `⏰ Time's up! Nobody found ${db.users[h.hiderId].name}'s ${h.object}. +10 for the hider. Spot revealed on the map.` });
    }
  }
}
setInterval(tick, TICK_MS);

// ---------- sockets ----------
io.use((socket, next) => {
  const u = userByToken(socket.handshake.auth?.token);
  if (!u) return next(new Error('unauthorized'));
  socket.data.userId = u.id; next();
});
const userRoom = uid => 'u:' + uid;
io.on('connection', socket => {
  const join = () => Object.values(db.groups).filter(g => g.members.includes(socket.data.userId)).forEach(g => socket.join('g:' + g.id));
  join();
  socket.join(userRoom(socket.data.userId));
  socket.on('refresh-groups', join);
  socket.on('typing', d => social.typing(socket.data.userId, d && d.chatId));
});

// ---------- Snapchat-style social layer + Manhunt mode ----------
const ctx = { app, io, db, save, now, id, auth, member, bad, upload, publicUser, serializeMsg, pushToUsers, postMessage, distanceM, offsetPoint, validPoint, pt,
  UPLOAD_DIR, DATA_DIR, userRoom };
const social = require('./lib/social')(ctx);
ctx.social = social;
const manhunt = require('./lib/manhunt')(ctx);
require('./lib/calls')(ctx);
setInterval(() => { social.tick(); manhunt.tick(); }, TICK_MS);
if (process.env.ALLOW_TEST_CLOCK === '1') {
  app.post('/api/test/clock', (req, res) => { clockOffset += Number(req.body.advanceMs) || 0; social.tick(); manhunt.tick(); tick(); res.json({ now: now() }); });
}

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error' }); });
server.listen(PORT, () => console.log(`PeekaSnap running on http://localhost:${PORT}`));
module.exports = { server, distanceM, makeHint };
