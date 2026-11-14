// Call signaling + call state: ring, accept, relay offers/ICE, hang up, decline, timeout -> missed, busy, friends only, call log in chat
const { io } = require('socket.io-client');
const { startServer, reporter, once, wait } = require('./helpers');
(async () => {
  const { ok, done } = reporter();
  const S = await startServer(3995, { CALL_RING_MS: 1500 }); const { api, BASE } = S;
  const emit = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
  try {
    const mk = n => api('/api/signup', { body: { name: n, username: n.toLowerCase(), password: 'secret123' } });
    const [a, b, c, d] = [await mk('Ava'), await mk('Ben'), await mk('Cleo'), await mk('Dex')];
    const fr = async (x, y) => { await api('/api/friends/request', { token: x.token, body: { userId: y.user.id } }); await api('/api/friends/accept', { token: y.token, body: { userId: x.user.id } }); };
    await fr(a, b); await fr(c, b); await fr(a, c);
    const conn = async t => { const s = io(BASE, { auth: { token: t } }); await once(s, 'connect'); return s; };
    const [sa, sb, sb2, sc, sd] = [await conn(a.token), await conn(b.token), await conn(b.token), await conn(c.token), await conn(d.token)];
    const dm = 'dm_' + [a.user.id, b.user.id].sort().join('_');
    const cfg = await api('/api/calls/config', { token: a.token });
    ok(cfg.iceServers[0].urls.some(u => u.startsWith('stun:stun.l.google.com')), 'ICE config: public Google STUN');
    ok((await emit(sd, 'call:start', { to: a.user.id, kind: 'audio' })).error === 'You can only call friends', 'non-friends cannot call');
    // ring + accept
    const inc = once(sb, 'call:incoming'), inc2 = once(sb2, 'call:incoming');
    const st = await emit(sa, 'call:start', { to: b.user.id, kind: 'video' });
    ok(st.call && st.call.state === 'ringing' && st.call.kind === 'video', 'Ava starts a video call (ringing)');
    const ic = await inc; await inc2;
    ok(ic.callId === st.call.callId && ic.from.id === a.user.id, 'Ben gets the incoming call on every device, with caller info');
    const busy = await emit(sc, 'call:start', { to: b.user.id, kind: 'audio' });
    ok(busy.busy && /another call/.test(busy.error), 'busy: Cleo calling Ben during the call is told he is on another call');
    const elsewhere = once(sb2, 'call:answered-elsewhere'), accepted = once(sa, 'call:accepted');
    const acc = await emit(sb, 'call:accept', { callId: ic.callId });
    ok(acc.call?.state === 'active' && (await accepted).callId === ic.callId, 'Ben accepts; Ava is told');
    ok((await elsewhere).callId === ic.callId, "Ben's other device stops ringing");
    ok((await emit(sb2, 'call:accept', { callId: ic.callId })).error, 'a second device cannot also answer');
    // signaling relay
    const sig = once(sb, 'call:signal'); sa.emit('call:signal', { callId: ic.callId, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
    ok((await sig).data.sdp.type === 'offer', 'offer relayed caller → callee');
    const sig2 = once(sa, 'call:signal'); sb.emit('call:signal', { callId: ic.callId, data: { candidate: { candidate: 'x' } } });
    ok((await sig2).data.candidate.candidate === 'x', 'ICE candidate relayed callee → caller');
    let leaked = false; sb2.once('call:signal', () => (leaked = true)); sc.once('call:signal', () => (leaked = true));
    sa.emit('call:signal', { callId: ic.callId, data: { x: 1 } }); sc.emit('call:signal', { callId: ic.callId, data: { x: 1 } }); await wait(300);
    ok(!leaked, 'signals only reach the answering device; outsiders cannot inject');
    await wait(1100);
    const endA = once(sa, 'call:ended'), endB = once(sb, 'call:ended'), logMsg = once(sa, 'message', 4000, m => m.type === 'call');
    sb.emit('call:end', { callId: ic.callId });
    const e1 = await endA; await endB;
    ok(e1.status === 'ended' && e1.duration >= 1, `hang up ends it for both (${e1.duration}s)`);
    const lm = await logMsg;
    ok(/^Video call \d+:\d\d$/.test(lm.text) && lm.call.duration >= 1, `chat entry "${lm.text}"`);
    // the busy attempt left a missed call for Ben from Cleo
    const cb = await api('/api/chats/dm_' + [b.user.id, c.user.id].sort().join('_'), { token: b.token });
    ok(cb.messages.some(m => m.type === 'call' && m.text === 'Missed voice call'), 'busy attempt shows as "Missed voice call"');
    // decline
    const r2 = once(sb, 'call:incoming'); await emit(sa, 'call:start', { to: b.user.id, kind: 'audio' }); const ic2 = await r2;
    const dEnd = once(sa, 'call:ended'); sb.emit('call:decline', { callId: ic2.callId });
    ok((await dEnd).status === 'declined', 'decline → caller told "declined"');
    // timeout -> missed
    const r3 = once(sb, 'call:incoming'); await emit(sa, 'call:start', { to: b.user.id, kind: 'audio' }); await r3;
    const tEnd = once(sb, 'call:ended', 5000);
    ok((await tEnd).status === 'missed', 'no answer → missed after the ring timeout');
    // caller cancels while ringing
    const r4 = once(sb, 'call:incoming'); const st4 = await emit(sa, 'call:start', { to: b.user.id, kind: 'video' }); await r4;
    const cEnd = once(sb, 'call:ended'); sa.emit('call:end', { callId: st4.call.callId });
    ok((await cEnd).status === 'missed', 'caller hangs up before answer → missed for Ben');
    // late device gets the ringing call on connect
    await emit(sa, 'call:start', { to: b.user.id, kind: 'audio' });
    const late = io(BASE, { auth: { token: b.token } }); const lateInc = await once(late, 'call:incoming');
    ok(lateInc.from.id === a.user.id, 'a device that opens the app while it rings (e.g. from the push) still sees the call');
    // caller disconnects mid-call
    const accd = once(sa, 'call:accepted'); late.emit('call:accept', { callId: lateInc.callId }, () => {}); await accd;
    const dcEnd = once(late, 'call:ended'); sa.close();
    ok((await dcEnd).reason === 'disconnected', 'call ends if a device drops');
    const msgs = (await api('/api/chats/' + dm, { token: a.token })).messages.filter(m => m.type === 'call').map(m => m.text);
    ok(msgs.includes('Declined voice call') && msgs.filter(t => /^Missed/.test(t)).length >= 2, 'call log: ' + msgs.join(' | '));
    const again = await emit(sb, 'call:start', { to: c.user.id, kind: 'audio' }); ok(again.call?.state === 'ringing', 'state cleaned up after calls (can call again)'); sb.emit('call:end', { callId: again.call?.callId });
    [sb, sb2, sc, sd, late].forEach(s => s.close());
  } catch (e) { ok(false, 'crashed: ' + e.stack); }
  S.kill(); process.exit(done() ? 1 : 0);
})();
