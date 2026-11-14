// 1:1 voice / video calls between friends: WebRTC in the browsers, signaling over Socket.IO.
// Call state lives in memory (a restart ends any call). Each call leaves an entry in the DM ("Missed voice call", "Video call 3:12").
module.exports = function calls(ctx) {
  const { app, io, db, now, id, auth, publicUser, pushToUsers, userRoom, social } = ctx;
  const RING_MS = +process.env.CALL_RING_MS || 30000;
  const calls = new Map();        // callId -> call
  const inCall = new Map();       // userId -> callId (ringing or active)
  const emitTo = (uid, ev, d) => io.to(userRoom(uid)).emit(ev, d);
  const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');
  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const label = k => (k === 'video' ? 'video' : 'voice');

  // STUN only by default. A TURN relay can be added with env vars (no free account-less TURN exists any more).
  function iceServers() {
    const list = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
    if (process.env.TURN_URLS) list.push({ urls: process.env.TURN_URLS.split(','), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    return list;
  }
  app.get('/api/calls/config', auth, (req, res) => res.json({ iceServers: iceServers(), ringMs: RING_MS, turn: !!process.env.TURN_URLS }));

  const view = c => ({ callId: c.id, kind: c.kind, from: publicUser(db.users[c.from]), to: publicUser(db.users[c.to]), state: c.state, startedAt: c.startedAt, answeredAt: c.answeredAt || null });

  function logCall(c, status) {
    const dur = c.answeredAt ? Math.max(0, Math.round((now() - c.answeredAt) / 1000)) : 0;
    const k = label(c.kind), K = k[0].toUpperCase() + k.slice(1);
    const text = status === 'ended' ? `${K} call ${fmt(dur)}` : status === 'declined' ? `Declined ${k} call` : `Missed ${k} call`;
    social.postChat(dmId(c.from, c.to), { userId: c.from, type: 'call', text, call: { kind: c.kind, status, duration: dur } });
    return dur;
  }
  function finish(c, reason) {
    if (!calls.has(c.id)) return;
    clearTimeout(c.timer); calls.delete(c.id);
    for (const u of [c.from, c.to]) if (inCall.get(u) === c.id) inCall.delete(u);
    const status = c.state === 'active' ? 'ended' : reason === 'declined' ? 'declined' : 'missed';
    const duration = logCall(c, status);
    for (const u of [c.from, c.to]) emitTo(u, 'call:ended', { callId: c.id, reason, status, duration });
    if (status === 'missed') pushToUsers([c.to], { title: db.users[c.from]?.name || 'PeekaSnap', body: `📞 Missed ${label(c.kind)} call`, tag: 'call-' + c.id, url: '/#chat' });
  }
  const other = (c, uid) => (c.from === uid ? c.to : c.from);
  const party = (socket, callId) => { const c = calls.get(callId); return c && (c.from === socket.data.userId || c.to === socket.data.userId) ? c : null; };

  io.on('connection', socket => {
    const me = socket.data.userId;
    // a ringing call still reaches a phone that opens the app late (e.g. from the push notification)
    const pending = calls.get(inCall.get(me));
    if (pending && pending.state === 'ringing' && pending.to === me) socket.emit('call:incoming', view(pending));

    socket.on('call:start', (d, ack = () => {}) => {
      const to = d && d.to, kind = d && d.kind === 'video' ? 'video' : 'audio';
      if (!db.users[to] || to === me) return ack({ error: 'User not found' });
      if (!social.areFriends(me, to)) return ack({ error: 'You can only call friends' });
      if (inCall.has(me)) return ack({ error: "You're already in a call" });
      const c = { id: id(), from: me, to, kind, state: 'ringing', startedAt: now(), callerSocket: socket.id, calleeSocket: null };
      if (inCall.has(to)) { // busy: the caller hears "busy", the callee gets a missed-call entry
        calls.set(c.id, c); finish(c, 'busy'); return ack({ error: `${db.users[to].name} is on another call`, busy: true });
      }
      calls.set(c.id, c); inCall.set(me, c.id); inCall.set(to, c.id);
      c.timer = setTimeout(() => finish(c, 'timeout'), RING_MS);
      emitTo(to, 'call:incoming', view(c));
      pushToUsers([to], { title: db.users[me].name, body: kind === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call', tag: 'call-' + c.id, url: '/#call', call: true });
      ack({ call: view(c) });
    });
    socket.on('call:accept', (d, ack = () => {}) => {
      const c = party(socket, d && d.callId);
      if (!c || c.to !== me || c.state !== 'ringing') return ack({ error: 'Call ended' });
      clearTimeout(c.timer); c.state = 'active'; c.answeredAt = now(); c.calleeSocket = socket.id;
      io.to(c.callerSocket).emit('call:accepted', view(c));
      socket.to(userRoom(me)).emit('call:answered-elsewhere', { callId: c.id }); // stop ringing on my other devices
      ack({ call: view(c) });
    });
    socket.on('call:decline', d => { const c = party(socket, d && d.callId); if (c && c.state === 'ringing') finish(c, c.to === me ? 'declined' : 'cancelled'); });
    socket.on('call:end', d => { const c = party(socket, d && d.callId); if (c) finish(c, c.state === 'ringing' ? (c.to === me ? 'declined' : 'cancelled') : 'hangup'); });
    socket.on('call:signal', d => { // SDP offers/answers + ICE candidates, relayed only between the two connected devices
      const c = party(socket, d && d.callId); if (!c || c.state !== 'active') return;
      const target = socket.id === c.callerSocket ? c.calleeSocket : socket.id === c.calleeSocket ? c.callerSocket : null;
      if (target) io.to(target).emit('call:signal', { callId: c.id, data: d.data });
    });
    socket.on('disconnect', () => { // the device in the call went away: end it
      for (const c of [...calls.values()]) if (c.callerSocket === socket.id || c.calleeSocket === socket.id) finish(c, 'disconnected');
    });
  });
  return { iceServers, active: () => calls.size };
};
