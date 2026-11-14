// Snapchat-style layer: usernames, friends, disappearing snaps, chats (DM + group), stories, Snap-Map-style location sharing.
const fs = require('fs');
const path = require('path');
const multer = require('multer');

module.exports = function social(ctx) {
  const { app, io, db, save, now, id, auth, bad, upload, publicUser, pushToUsers, postMessage, validPoint, pt, UPLOAD_DIR, DATA_DIR, userRoom } = ctx;
  for (const k of ['friends', 'snaps', 'stories', 'reads', 'locs', 'streaks', 'cleared', 'hiddenMsgs']) db[k] ||= {};
  const SNAP_DIR = path.join(DATA_DIR, 'snaps'); // NOT publicly served: snap photos only go out through /open and /replay
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const H24 = 24 * 3600e3;
  const SNAP_UNOPENED_TTL = 30 * H24, GROUP_SNAP_TTL = H24, REPLAY_WINDOW = 10 * 60e3, LOC_TTL = 8 * 3600e3;
  const snapUpload = multer({
    storage: multer.diskStorage({ destination: SNAP_DIR, filename: (req, f, cb) => cb(null, id(12) + '.jpg') }),
    limits: { fileSize: 12 * 1024 * 1024 }, fileFilter: (req, f, cb) => cb(null, /^image\//.test(f.mimetype)),
  });
  const rm = f => fs.promises.unlink(f).catch(() => {});

  // ---------- friends ----------
  const rel = (a, b) => (db.friends[a] || {})[b] || null; // 'friends' | 'outgoing' | 'incoming'
  const setRel = (a, b, v) => { db.friends[a] ||= {}; if (v) db.friends[a][b] = v; else delete db.friends[a][b]; };
  const areFriends = (a, b) => rel(a, b) === 'friends';
  const friendIds = uid => Object.entries(db.friends[uid] || {}).filter(([, v]) => v === 'friends').map(([k]) => k);
  const emitTo = (uid, ev, data) => io.to(userRoom(uid)).emit(ev, data);
  const today = (t = now()) => new Date(t).toISOString().slice(0, 10);
  const pairKey = (a, b) => [a, b].sort().join('_');
  function streakOf(a, b) {
    const s = db.streaks[pairKey(a, b)];
    if (!s || !s.count) return 0;
    return s.lastDay >= today(now() - H24) ? s.count : 0; // broken if a full day was missed
  }
  function bumpStreak(from, to) {
    const k = pairKey(from, to); const s = (db.streaks[k] ||= { count: 0, lastDay: null, sent: {} });
    s.sent[from] = today();
    if (s.sent[to] === today() && s.lastDay !== today()) {
      s.count = s.lastDay === today(now() - H24) ? s.count + 1 : 1;
      s.lastDay = today();
    }
  }

  app.get('/api/users/search', auth, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
    if (q.length < 2) return res.json({ users: [] });
    const users = Object.values(db.users).filter(u => u.id !== req.user.id && (u.username || '').startsWith(q)).slice(0, 10)
      .map(u => ({ ...publicUser(u), relation: rel(req.user.id, u.id) }));
    res.json({ users });
  });
  app.get('/api/friends', auth, (req, res) => {
    const me = req.user.id, list = Object.entries(db.friends[me] || {});
    const pick = v => list.filter(([, r]) => r === v).map(([uid]) => db.users[uid]).filter(Boolean);
    res.json({
      friends: pick('friends').map(u => ({ user: publicUser(u), streak: streakOf(me, u.id), sharing: !!u.shareLocation })).sort((a, b) => a.user.name.localeCompare(b.user.name)),
      incoming: pick('incoming').map(publicUser), outgoing: pick('outgoing').map(publicUser),
    });
  });
  app.post('/api/friends/request', auth, (req, res) => {
    const uname = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
    const other = Object.values(db.users).find(u => u.username === uname) || db.users[req.body.userId];
    if (!other) return res.status(404).json({ error: 'No one with that username' });
    const me = req.user.id;
    if (other.id === me) return bad(res, "That's you 😄");
    const r = rel(me, other.id);
    if (r === 'friends') return res.json({ status: 'friends' });
    if (r === 'incoming') { setRel(me, other.id, 'friends'); setRel(other.id, me, 'friends'); }
    else { setRel(me, other.id, 'outgoing'); setRel(other.id, me, 'incoming'); }
    save();
    const status = rel(me, other.id);
    emitTo(other.id, 'friends', { type: status === 'friends' ? 'accepted' : 'request', user: publicUser(req.user) });
    emitTo(me, 'friends', { type: 'changed' });
    pushToUsers([other.id], status === 'friends'
      ? { title: '🤝 New friend', body: `You and ${req.user.name} are now friends`, url: '/#chat' }
      : { title: '👋 Friend request', body: `${req.user.name} (@${req.user.username}) added you`, url: '/#chat' });
    res.json({ status });
  });
  app.post('/api/friends/accept', auth, (req, res) => {
    const me = req.user.id, o = req.body.userId;
    if (rel(me, o) !== 'incoming') return res.status(404).json({ error: 'No request from them' });
    setRel(me, o, 'friends'); setRel(o, me, 'friends'); save();
    emitTo(o, 'friends', { type: 'accepted', user: publicUser(req.user) }); emitTo(me, 'friends', { type: 'changed' });
    pushToUsers([o], { title: '🤝 Request accepted', body: `${req.user.name} accepted your friend request`, url: '/#chat' });
    res.json({ status: 'friends' });
  });
  app.post('/api/friends/remove', auth, (req, res) => { // decline / cancel / unfriend
    const me = req.user.id, o = req.body.userId;
    const wasFriend = areFriends(me, o);
    setRel(me, o, null); setRel(o, me, null); save();
    emitTo(o, 'friends', { type: wasFriend ? 'removed' : 'changed' }); emitTo(me, 'friends', { type: 'changed' });
    if (wasFriend) { emitTo(o, 'friend-loc', { userId: me, gone: true }); emitTo(me, 'friend-loc', { userId: o, gone: true }); } // drop off each other's map
    res.json({ ok: true });
  });

  // ---------- chats ----------
  const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');
  function chatInfo(chatId, uid) {
    if (chatId.startsWith('dm_')) {
      const [a, b] = chatId.slice(3).split('_');
      if (uid !== a && uid !== b) return null;
      const other = uid === a ? b : a;
      if (!db.users[other]) return null;
      return { chatId, type: 'dm', members: [a, b], other, canSend: areFriends(uid, other) };
    }
    if (chatId.startsWith('hunt_')) {
      const h = db.hunts && db.hunts[chatId.slice(5)];
      const g = h && db.groups[h.groupId];
      if (!g || !g.members.includes(uid)) return null;
      return { chatId, type: 'hunt', members: g.members, groupId: g.id, canSend: true };
    }
    const g = db.groups[chatId];
    if (!g || !g.members.includes(uid)) return null;
    return { chatId, type: 'group', members: g.members, groupId: g.id, canSend: true };
  }
  const chatOf = m => m.chatId || m.groupId;
  // "delete for me": a cleared chat hides everything up to the clear time; single messages can be hidden too
  const visibleTo = (m, uid) => !((db.cleared[uid] || {})[chatOf(m)] >= m.createdAt) && !(db.hiddenMsgs[uid] || {})[m.id];
  function snapState(m, viewer) {
    const s = db.snaps[m.snapId]; if (!s) return { state: 'expired' };
    if (s.from === viewer) {
      const r = Object.values(s.recipients);
      return { state: r.length && r.every(x => x.openedAt) ? 'opened' : r.some(x => x.openedAt) ? 'some-opened' : 'delivered', replays: r.filter(x => x.replayed).length };
    }
    const mine = s.recipients[viewer]; if (!mine) return { state: 'none' };
    if (mine.expired) return { state: 'expired' };
    if (!mine.openedAt) return { state: 'new', timer: s.timer };
    return { state: !mine.replayed && now() - mine.openedAt < REPLAY_WINDOW ? 'replayable' : 'opened' };
  }
  const viewMsg = (m, viewer) => ({ ...m, chatId: chatOf(m), user: publicUser(db.users[m.userId]), ...(m.type === 'snap' ? { snap: snapState(m, viewer) } : {}) });
  function postChat(chatId, msg) {
    if (!chatId.startsWith('dm_')) {
      const groupId = chatId.startsWith('hunt_') ? db.hunts[chatId.slice(5)].groupId : chatId;
      const m = postMessage(groupId, { ...msg, chatId });
      return m;
    }
    const m = { id: id(), chatId, createdAt: now(), type: 'chat', ...msg };
    db.messages.push(m);
    if (db.messages.length > 20000) db.messages.splice(0, db.messages.length - 20000);
    save();
    const [a, b] = chatId.slice(3).split('_');
    for (const uid of [a, b]) emitTo(uid, 'message', viewMsg(m, uid));
    return m;
  }
  ctx.postChat = postChat;

  app.get('/api/chats', auth, (req, res) => {
    const me = req.user.id, reads = id => (db.reads[id] || {});
    const lastOf = new Map(), unread = new Map();
    for (const m of db.messages) {
      if (!visibleTo(m, me)) continue;
      const c = chatOf(m); lastOf.set(c, m);
      if (m.userId && m.userId !== me && m.createdAt > (reads(c)[me] || 0)) unread.set(c, (unread.get(c) || 0) + 1);
    }
    const out = [];
    for (const f of friendIds(me)) {
      const c = dmId(me, f), u = db.users[f]; if (!u) continue;
      if ((db.cleared[me] || {})[c] && !lastOf.get(c)) continue; // deleted conversation stays off the list until a new message
      out.push({ chatId: c, type: 'dm', title: u.name, user: publicUser(u), streak: streakOf(me, f), last: lastOf.get(c) ? viewMsg(lastOf.get(c), me) : null, unread: unread.get(c) || 0, theirRead: reads(c)[f] || 0 });
    }
    // ex-friends: the old conversation stays (read-only) until you delete it
    for (const [c, m] of lastOf) {
      if (!c.startsWith('dm_') || out.some(x => x.chatId === c)) continue;
      const [x, y] = c.slice(3).split('_'); if (x !== me && y !== me) continue;
      const o = x === me ? y : x, u = db.users[o]; if (!u) continue;
      out.push({ chatId: c, type: 'dm', title: u.name, user: publicUser(u), streak: 0, notFriends: true, last: viewMsg(m, me), unread: unread.get(c) || 0, theirRead: reads(c)[o] || 0 });
    }
    for (const g of Object.values(db.groups).filter(g => g.members.includes(me))) {
      if ((db.cleared[me] || {})[g.id] && !lastOf.get(g.id)) continue;
      out.push({ chatId: g.id, type: 'group', title: g.name, group: { id: g.id, name: g.name, emoji: g.emoji, code: g.code, memberCount: g.members.length }, last: lastOf.get(g.id) ? viewMsg(lastOf.get(g.id), me) : null, unread: unread.get(g.id) || 0 });
    }
    out.sort((a, b) => (b.last?.createdAt || 0) - (a.last?.createdAt || 0));
    res.json({ chats: out });
  });
  app.get('/api/chats/:chatId', auth, (req, res) => {
    const c = chatInfo(req.params.chatId, req.user.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    const msgs = db.messages.filter(m => chatOf(m) === c.chatId && visibleTo(m, req.user.id)).slice(-150).map(m => viewMsg(m, req.user.id));
    res.json({ chat: { ...c, members: c.members.map(u => publicUser(db.users[u])).filter(Boolean), other: c.other && publicUser(db.users[c.other]), streak: c.other ? streakOf(req.user.id, c.other) : undefined },
      messages: msgs, reads: db.reads[c.chatId] || {} });
  });
  app.post('/api/chats/:chatId/messages', auth, upload.single('photo'), (req, res) => {
    const c = chatInfo(req.params.chatId, req.user.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    if (!c.canSend) return res.status(403).json({ error: 'You can only chat with friends' });
    const text = String(req.body.text || '').trim().slice(0, 1000);
    if (!text && !req.file) return bad(res, 'Empty message');
    const m = postChat(c.chatId, { userId: req.user.id, text, photo: req.file ? '/uploads/' + req.file.filename : undefined });
    markRead(c, req.user.id);
    const others = c.members.filter(u => u !== req.user.id);
    pushToUsers(others, { title: c.type === 'dm' ? req.user.name : `${req.user.name} in ${db.groups[c.groupId]?.name || 'Manhunt'}`, body: text || '📷 Photo', tag: 'chat-' + c.chatId, url: '/#chat' });
    res.json({ message: viewMsg(m, req.user.id) });
  });
  // ---------- deleting ----------
  // delete a whole conversation for me (Snapchat-style "Clear conversation"); others keep their copy
  app.delete('/api/chats/:chatId', auth, (req, res) => {
    const c = chatInfo(req.params.chatId, req.user.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    (db.cleared[req.user.id] ||= {})[c.chatId] = now();
    const hm = db.hiddenMsgs[req.user.id]; // per-message hides in this chat are no longer needed
    if (hm) for (const m of db.messages) if (chatOf(m) === c.chatId) delete hm[m.id];
    save(); emitTo(req.user.id, 'chat-deleted', { chatId: c.chatId });
    res.json({ ok: true });
  });
  // delete one message: the sender unsends it for everyone; anyone else deletes it just for themselves
  app.delete('/api/chats/:chatId/messages/:mid', auth, (req, res) => {
    const c = chatInfo(req.params.chatId, req.user.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    const i = db.messages.findIndex(m => m.id === req.params.mid && chatOf(m) === c.chatId);
    if (i < 0 || !visibleTo(db.messages[i], req.user.id)) return res.status(404).json({ error: 'Message not found' });
    const m = db.messages[i];
    if (m.userId === req.user.id && ['chat', 'snap'].includes(m.type || 'chat')) {
      db.messages.splice(i, 1);
      if (m.type === 'snap' && db.snaps[m.snapId]) { const sn = db.snaps[m.snapId]; rm(path.join(SNAP_DIR, sn.file)); delete db.snaps[m.snapId]; }
      if (m.photo && m.photo.startsWith('/uploads/')) rm(path.join(UPLOAD_DIR, path.basename(m.photo)));
      save();
      for (const u of c.members) emitTo(u, 'message-deleted', { chatId: c.chatId, id: m.id, by: req.user.id, forEveryone: true });
      return res.json({ ok: true, scope: 'everyone' });
    }
    (db.hiddenMsgs[req.user.id] ||= {})[m.id] = 1; save();
    emitTo(req.user.id, 'message-deleted', { chatId: c.chatId, id: m.id, by: req.user.id, forEveryone: false });
    res.json({ ok: true, scope: 'me' });
  });
  function markRead(c, uid) {
    (db.reads[c.chatId] ||= {})[uid] = now(); save();
    for (const u of c.members) if (u !== uid) emitTo(u, 'read', { chatId: c.chatId, userId: uid, at: db.reads[c.chatId][uid] });
  }
  app.post('/api/chats/:chatId/read', auth, (req, res) => {
    const c = chatInfo(req.params.chatId, req.user.id);
    if (!c) return res.status(404).json({ error: 'Chat not found' });
    markRead(c, req.user.id); res.json({ ok: true });
  });
  function typing(uid, chatId) {
    if (typeof chatId !== 'string') return;
    const c = chatInfo(chatId, uid); if (!c) return;
    for (const u of c.members) if (u !== uid) emitTo(u, 'typing', { chatId, user: publicUser(db.users[uid]) });
  }

  // ---------- snaps (disappearing photos) ----------
  const parseList = v => { if (!v) return []; if (Array.isArray(v)) return v.map(String); try { const j = JSON.parse(v); return Array.isArray(j) ? j.map(String) : [String(j)]; } catch (_) { return String(v).split(',').filter(Boolean); } };
  app.post('/api/snaps', auth, snapUpload.single('photo'), async (req, res) => {
    const me = req.user.id;
    if (!req.file) return bad(res, 'Take a photo first');
    const timer = Math.max(0, Math.min(10, Math.round(+req.body.timer || 0))); // 0 = no limit
    const to = [...new Set(parseList(req.body.to))], groups = [...new Set(parseList(req.body.groups))];
    const story = req.body.story === '1' || req.body.story === 'true';
    if (to.some(u => !areFriends(me, u))) { rm(req.file.path); return res.status(403).json({ error: 'You can only send Peaks to friends' }); }
    if (groups.some(g => !db.groups[g] || !db.groups[g].members.includes(me))) { rm(req.file.path); return res.status(403).json({ error: 'Not in that group' }); }
    if (!to.length && !groups.length && !story) { rm(req.file.path); return bad(res, 'Pick who to send it to'); }
    let storyId = null;
    if (story) { // stories are viewable by friends for 24h, so they get a public copy
      const fname = id(12) + '.jpg';
      await fs.promises.copyFile(req.file.path, path.join(UPLOAD_DIR, fname));
      storyId = addStory(req.user, '/uploads/' + fname, timer).id;
    }
    const sent = [];
    const mk = (recips, via) => {
      const s = { id: id(), from: me, file: path.basename(req.file.path), timer, createdAt: now(), via: via || null, recipients: {} };
      recips.forEach(u => (s.recipients[u] = { openedAt: null, replayed: false }));
      db.snaps[s.id] = s; return s;
    };
    for (const u of to) {
      const s = mk([u]); bumpStreak(me, u);
      postChat(dmId(me, u), { userId: me, type: 'snap', snapId: s.id, text: '' });
      pushToUsers([u], { title: req.user.name, body: '📸 sent you a Peak', tag: 'snap-' + me, url: '/#chat' });
      sent.push(s.id);
    }
    for (const g of groups) {
      const recips = db.groups[g].members.filter(u => u !== me);
      const s = mk(recips, g);
      postChat(g, { userId: me, type: 'snap', snapId: s.id, text: '' });
      pushToUsers(recips, { title: `${req.user.name} in ${db.groups[g].name}`, body: '📸 sent a Peak', tag: 'snap-g-' + g, url: '/#chat' });
      sent.push(s.id);
    }
    if (!sent.length) rm(req.file.path); // story only: the private copy isn't needed
    save();
    res.json({ snaps: sent, storyId });
  });
  app.get('/api/snaps/inbox', auth, (req, res) => {
    const me = req.user.id;
    const list = Object.values(db.snaps).filter(s => s.recipients[me] && !s.recipients[me].openedAt && !s.recipients[me].expired)
      .sort((a, b) => a.createdAt - b.createdAt).map(s => ({ id: s.id, from: publicUser(db.users[s.from]), timer: s.timer, createdAt: s.createdAt, via: s.via }));
    res.json({ snaps: list });
  });
  async function sendImage(s, res, extra) {
    try {
      const buf = await fs.promises.readFile(path.join(SNAP_DIR, s.file));
      res.set('Cache-Control', 'no-store');
      res.json({ image: 'data:image/jpeg;base64,' + buf.toString('base64'), timer: s.timer, from: publicUser(db.users[s.from]), ...extra });
    } catch (_) { res.status(410).json({ error: 'This Peak has expired' }); }
  }
  function openedNotice(s, uid, replay) {
    emitTo(s.from, 'snap-opened', { snapId: s.id, by: publicUser(db.users[uid]), replay });
    const chat = s.via || dmId(s.from, uid);
    for (const u of [s.from, uid]) emitTo(u, 'snap-state', { chatId: chat, snapId: s.id });
  }
  app.post('/api/snaps/:id/open', auth, (req, res) => {
    const s = db.snaps[req.params.id], r = s && s.recipients[req.user.id];
    if (!r || r.expired) return res.status(404).json({ error: 'Peak not found or expired' });
    if (r.openedAt) return res.status(410).json({ error: r.replayed ? 'Already viewed' : 'Already viewed - you can replay it once', canReplay: !r.replayed && now() - r.openedAt < REPLAY_WINDOW });
    r.openedAt = now(); save(); openedNotice(s, req.user.id, false);
    sendImage(s, res, { canReplay: true });
  });
  app.post('/api/snaps/:id/replay', auth, (req, res) => {
    const s = db.snaps[req.params.id], r = s && s.recipients[req.user.id];
    if (!r || r.expired || !r.openedAt) return res.status(404).json({ error: 'Nothing to replay' });
    if (r.replayed || now() - r.openedAt >= REPLAY_WINDOW) return res.status(410).json({ error: 'Replay already used' });
    r.replayed = true; save(); openedNotice(s, req.user.id, true);
    sendImage(s, res, { canReplay: false });
  });

  // ---------- stories (24h) ----------
  function addStory(user, photo, timer) {
    const st = { id: id(), userId: user.id, photo, timer: timer || 5, createdAt: now(), expiresAt: now() + H24, views: {} };
    db.stories[st.id] = st; save();
    for (const f of friendIds(user.id)) emitTo(f, 'story', { userId: user.id });
    return st;
  }
  const liveStory = s => s.expiresAt > now();
  const viewStory = (s, viewer) => ({ id: s.id, photo: s.photo, timer: s.timer, createdAt: s.createdAt, expiresAt: s.expiresAt, seen: !!s.views[viewer],
    ...(s.userId === viewer ? { views: Object.entries(s.views).map(([u, t]) => ({ user: publicUser(db.users[u]), at: t })) } : {}) });
  app.post('/api/stories', auth, upload.single('photo'), (req, res) => {
    if (!req.file) return bad(res, 'Take a photo first');
    const st = addStory(req.user, '/uploads/' + req.file.filename, Math.max(1, Math.min(10, +req.body.timer || 5)));
    res.json({ story: viewStory(st, req.user.id) });
  });
  app.get('/api/stories', auth, (req, res) => {
    const me = req.user.id, all = Object.values(db.stories).filter(liveStory).sort((a, b) => a.createdAt - b.createdAt);
    const mine = all.filter(s => s.userId === me).map(s => viewStory(s, me));
    const friends = friendIds(me).map(f => {
      const ss = all.filter(s => s.userId === f).map(s => viewStory(s, me));
      return ss.length ? { user: publicUser(db.users[f]), stories: ss, allSeen: ss.every(s => s.seen), latest: ss[ss.length - 1].createdAt } : null;
    }).filter(Boolean).sort((a, b) => (a.allSeen - b.allSeen) || (b.latest - a.latest));
    res.json({ mine, friends });
  });
  app.post('/api/stories/:id/view', auth, (req, res) => {
    const s = db.stories[req.params.id];
    if (!s || !liveStory(s) || (s.userId !== req.user.id && !areFriends(s.userId, req.user.id))) return res.status(404).json({ error: 'Story not found' });
    if (s.userId !== req.user.id && !s.views[req.user.id]) { s.views[req.user.id] = now(); save(); }
    res.json({ ok: true });
  });
  app.delete('/api/stories/:id', auth, (req, res) => {
    const s = db.stories[req.params.id];
    if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Story not found' });
    delete db.stories[s.id]; rm(path.join(UPLOAD_DIR, path.basename(s.photo))); save(); res.json({ ok: true });
  });

  // ---------- Snap Map: opt-in location sharing (ghost mode by default) ----------
  app.patch('/api/me', auth, (req, res) => {
    const u = req.user;
    if (typeof req.body.name === 'string' && req.body.name.trim().length >= 2) u.name = req.body.name.trim().slice(0, 24);
    if (typeof req.body.shareLocation === 'boolean') {
      u.shareLocation = req.body.shareLocation;
      if (!u.shareLocation) { delete db.locs[u.id]; for (const f of friendIds(u.id)) emitTo(f, 'friend-loc', { userId: u.id, gone: true }); }
    }
    save(); res.json({ user: { ...publicUser(u), shareLocation: !!u.shareLocation } });
  });
  app.post('/api/me/location', auth, (req, res) => {
    if (!req.user.shareLocation) return res.json({ stored: false, ghost: true }); // ghost mode: never stored
    if (!validPoint(req.body)) return bad(res, 'Bad location');
    const l = { ...pt(req.body), t: now() }; db.locs[req.user.id] = l; save();
    for (const f of friendIds(req.user.id)) emitTo(f, 'friend-loc', { userId: req.user.id, user: publicUser(req.user), ...l });
    res.json({ stored: true });
  });
  app.get('/api/map', auth, (req, res) => {
    const friends = friendIds(req.user.id).map(f => db.users[f]).filter(u => u && u.shareLocation && db.locs[u.id] && now() - db.locs[u.id].t < LOC_TTL)
      .map(u => ({ user: publicUser(u), ...db.locs[u.id] }));
    res.json({ friends, me: req.user.shareLocation ? db.locs[req.user.id] || null : null });
  });

  // ---------- housekeeping: expire snaps and stories ----------
  function tick() {
    const t = now(); let dirty = false;
    for (const s of Object.values(db.snaps)) {
      const ttl = s.via ? GROUP_SNAP_TTL : SNAP_UNOPENED_TTL;
      for (const r of Object.values(s.recipients)) if (!r.openedAt && !r.expired && t - s.createdAt > ttl) { r.expired = true; dirty = true; }
      const done = Object.values(s.recipients).every(r => r.expired || (r.openedAt && (r.replayed || t - r.openedAt >= REPLAY_WINDOW)));
      if (done && !s.purged) { s.purged = true; rm(path.join(SNAP_DIR, s.file)); dirty = true; }
      if (s.purged && t - s.createdAt > SNAP_UNOPENED_TTL + H24) { delete db.snaps[s.id]; dirty = true; }
    }
    for (const s of Object.values(db.stories)) if (s.expiresAt <= t) { delete db.stories[s.id]; rm(path.join(UPLOAD_DIR, path.basename(s.photo))); dirty = true; }
    if (dirty) save();
  }
  return { tick, typing, areFriends, friendIds, postChat, emitTo, snapFile: s => path.join(SNAP_DIR, s.file) };
};
