/* PeekaSnap calls: 1:1 voice/video between friends. WebRTC media goes peer-to-peer; Socket.IO only carries signaling. */
const C = { call: null, pc: null, local: null, role: null, timer: null, ring: null, ice: null, pendingIce: [], facing: 'user', muted: false, camOff: false, speaker: false };
const callView = () => $('#call');
async function iceConfig() {
  if (!C.ice) { try { C.ice = (await api('/api/calls/config')).iceServers; } catch (_) { C.ice = [{ urls: ['stun:stun.l.google.com:19302'] }]; } }
  return C.ice;
}
const fmtDur = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function callStatus(t) { $('#call-status').textContent = t; }

// ---- ringtone / ringback (Web Audio; vibrate where allowed) ----
function startRing(kind) {
  stopRing();
  const beep = () => {
    if (kind === 'in') { sonar('ping'); navigator.vibrate?.([400, 200, 400]); }
    else { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 440; g.gain.value = 0.05; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 1.2); } catch (_) {} }
  };
  beep(); C.ring = setInterval(beep, kind === 'in' ? 2200 : 3000);
}
function stopRing() { clearInterval(C.ring); C.ring = null; navigator.vibrate?.(0); }

// ---- media ----
async function getMedia(kind) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a browser with camera/mic access (open PeekaSnap over https).');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: kind === 'video' ? { facingMode: C.facing, width: { ideal: 720 }, height: { ideal: 1280 } } : false });
  } catch (e) {
    throw new Error(e.name === 'NotAllowedError' ? `Allow ${kind === 'video' ? 'camera and microphone' : 'microphone'} access to call.` : "Couldn't start your " + (kind === 'video' ? 'camera/mic' : 'mic') + '.');
  }
}

// ---- UI ----
function showCallScreen(peer, kind, mode) {
  stopCamera(); setAvatar($('#call-av'), peer); $('#call-name').textContent = peer.name;
  const v = callView(); v.classList.remove('hidden'); v.classList.toggle('video', kind === 'video'); v.classList.remove('connected');
  $('#call-incoming').classList.toggle('hidden', mode !== 'incoming');
  $('#call-controls').classList.toggle('hidden', mode === 'incoming');
  $('#call-cam').classList.toggle('hidden', kind !== 'video'); $('#call-flip').classList.toggle('hidden', kind !== 'video');
  $('#call-speaker').classList.toggle('hidden', !('setSinkId' in HTMLMediaElement.prototype));
  ['#call-mute', '#call-cam', '#call-speaker'].forEach(s => $(s).classList.remove('on'));
  callStatus(mode === 'incoming' ? (kind === 'video' ? 'Incoming video call…' : 'Incoming voice call…') : 'Calling…');
}
function hideCallScreen() {
  callView().classList.add('hidden'); $('#call-remote').srcObject = null; $('#call-local').srcObject = null; $('#call-local').classList.remove('live'); $('#call-audio').srcObject = null;
  if (S.view === 'camera' && !anyOverlayOpen()) startCamera();
}

// ---- outgoing ----
async function startCall(peer, kind = 'audio') {
  if (!peer) return;
  if (C.call) return toast("You're already in a call");
  closeSheets();
  C.call = { pending: true, kind, peer }; C.role = 'caller'; C.muted = C.camOff = false;
  showCallScreen(peer, kind, 'outgoing'); callStatus('Starting…');
  try { C.local = await getMedia(kind); } catch (e) { toast(e.message); C.call = null; return hideCallScreen(); }
  if (kind === 'video') { $('#call-local').srcObject = C.local; $('#call-local').classList.add('live'); }
  if (!C.call) return cleanupMedia(); // hung up meanwhile
  S.socket.emit('call:start', { to: peer.id, kind }, r => {
    if (r.error) { toast(r.error, r.busy ? 'y' : ''); callStatus(r.busy ? 'Busy' : r.error); setTimeout(endLocal, r.busy ? 1500 : 0); return; }
    C.call = { ...r.call, peer, kind }; callStatus('Ringing…'); startRing('out');
  });
}

// ---- incoming ----
function onIncoming(c) {
  if (C.call && C.call.callId !== c.callId) return; // busy on this device: server already handles busy
  C.call = { ...c, peer: c.from }; C.role = 'callee'; C.muted = C.camOff = false;
  showCallScreen(c.from, c.kind, 'incoming'); startRing('in');
  notify(c.kind === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call', c.from.name, '/#call');
}
$('#call-accept').onclick = async () => {
  const c = C.call; if (!c || C.role !== 'callee') return;
  stopRing(); callStatus('Connecting…'); $('#call-incoming').classList.add('hidden'); $('#call-controls').classList.remove('hidden');
  try { C.local = await getMedia(c.kind); } catch (e) { toast(e.message); S.socket.emit('call:decline', { callId: c.callId }); return endLocal(); }
  if (c.kind === 'video') { $('#call-local').srcObject = C.local; $('#call-local').classList.add('live'); }
  await makePC(); // ready before accepting: the caller sends its offer as soon as it hears we picked up
  S.socket.emit('call:accept', { callId: c.callId }, r => { if (r.error) { toast(r.error); endLocal(); } });
};
$('#call-decline').onclick = () => { if (C.call) S.socket.emit('call:decline', { callId: C.call.callId }); endLocal(); };
$('#call-end').onclick = () => { if (C.call?.callId) S.socket.emit('call:end', { callId: C.call.callId }); endLocal(); };

// ---- WebRTC ----
async function makePC() {
  const pc = C.pc = new RTCPeerConnection({ iceServers: await iceConfig() });
  C.local.getTracks().forEach(t => pc.addTrack(t, C.local));
  setTimeout(() => { const q = C.early || []; C.early = null; q.forEach(d => onSignal(d).catch(() => {})); });
  pc.onicecandidate = e => { if (e.candidate) S.socket.emit('call:signal', { callId: C.call.callId, data: { candidate: e.candidate } }); };
  pc.ontrack = e => {
    const st = e.streams[0];
    if (C.call?.kind === 'video') $('#call-remote').srcObject = st; else $('#call-audio').srcObject = st;
    $('#call-audio').srcObject ||= st;
  };
  clearTimeout(C.connT);
  C.connT = setTimeout(() => { // no media path found (strict NAT / firewall without a TURN relay)
    if (C.pc === pc && pc.connectionState !== 'connected') { callStatus("Couldn't connect. This network may block calls."); toast("Call couldn't connect on this network"); setTimeout(() => $('#call-end').onclick(), 2000); }
  }, 25000);
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') onConnected();
    else if (s === 'failed') { callStatus("Couldn't connect. Your network may block calls."); toast("Call couldn't connect on this network"); setTimeout(() => $('#call-end').onclick(), 2500); }
    else if (s === 'disconnected') callStatus('Reconnecting…');
  };
  return pc;
}
async function onSignal({ callId, data }) {
  if (!C.call || C.call.callId !== callId) return;
  if (!C.pc) { (C.early ||= []).push({ callId, data }); return; } // arrived before our connection object: replay later
  const pc = C.pc;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    for (const c of C.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (data.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); S.socket.emit('call:signal', { callId, data: { sdp: pc.localDescription } }); }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {}); else C.pendingIce.push(data.candidate);
  }
}
async function onAccepted(c) {
  if (!C.call || C.call.callId !== c.callId) return;
  stopRing(); callStatus('Connecting…'); C.call.answeredAt = c.answeredAt;
  const pc = await makePC();
  await pc.setLocalDescription(await pc.createOffer());
  S.socket.emit('call:signal', { callId: c.callId, data: { sdp: pc.localDescription } });
}
function onConnected() {
  if (!C.call || C.timer) { if (C.call) callStatus(fmtDur(Math.round((Date.now() - C.call.t0) / 1000))); return; }
  clearTimeout(C.connT); callView().classList.add('connected'); C.call.t0 = Date.now();
  const tick = () => callStatus(fmtDur(Math.round((Date.now() - C.call.t0) / 1000)));
  tick(); C.timer = setInterval(tick, 1000);
}
function onEnded(d) {
  if (!C.call || (C.call.callId && C.call.callId !== d.callId)) return;
  const msg = d.status === 'declined' ? (C.role === 'caller' ? 'Call declined' : '') : d.status === 'missed' ? (C.role === 'caller' ? 'No answer' : 'Missed call') : d.reason === 'disconnected' ? 'Call dropped' : 'Call ended';
  if (msg) { callStatus(msg); toast(msg + (d.status === 'ended' && d.duration ? ' · ' + fmtDur(d.duration) : '')); }
  endLocal(); refreshChats?.(); if (S.thread) openThread(S.thread.chatId, true);
}
function cleanupMedia() { C.local?.getTracks().forEach(t => t.stop()); C.local = null; }
function endLocal() {
  stopRing(); clearInterval(C.timer); clearTimeout(C.connT); C.timer = null;
  try { C.pc?.close(); } catch (_) {}
  C.pc = null; C.pendingIce = []; C.early = null; cleanupMedia(); C.call = null; C.role = null;
  hideCallScreen();
}

// ---- in-call controls ----
$('#call-mute').onclick = () => { C.muted = !C.muted; C.local?.getAudioTracks().forEach(t => (t.enabled = !C.muted)); $('#call-mute').classList.toggle('on', C.muted); $('#call-mute small').textContent = C.muted ? 'Unmute' : 'Mute'; };
$('#call-cam').onclick = () => { C.camOff = !C.camOff; C.local?.getVideoTracks().forEach(t => (t.enabled = !C.camOff)); $('#call-cam').classList.toggle('on', C.camOff); $('#call-local').classList.toggle('off', C.camOff); };
$('#call-flip').onclick = async () => {
  if (!C.local) return; C.facing = C.facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: C.facing } }), nt = s.getVideoTracks()[0];
    const old = C.local.getVideoTracks()[0]; await C.pc?.getSenders().find(x => x.track?.kind === 'video')?.replaceTrack(nt);
    if (old) { C.local.removeTrack(old); old.stop(); } C.local.addTrack(nt); nt.enabled = !C.camOff; $('#call-local').srcObject = C.local;
  } catch (_) { toast("Couldn't switch camera"); }
};
$('#call-speaker').onclick = async () => { // only where the browser lets a page pick the audio output
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    if (outs.length < 2) return toast('Use your phone\'s volume / audio controls to switch speaker');
    C.speaker = !C.speaker; const dev = C.speaker ? outs.find(d => /speaker/i.test(d.label)) || outs[1] : outs[0];
    for (const el of [$('#call-remote'), $('#call-audio')]) await el.setSinkId?.(dev.deviceId);
    $('#call-speaker').classList.toggle('on', C.speaker);
  } catch (_) { toast("Can't switch speaker in this browser"); }
};

// ---- wire up ----
H.socket.push(s => {
  s.on('call:incoming', onIncoming);
  s.on('call:accepted', onAccepted);
  s.on('call:signal', d => onSignal(d).catch(e => console.warn('signal', e)));
  s.on('call:ended', onEnded);
  s.on('call:answered-elsewhere', d => { if (C.call?.callId === d.callId && C.role === 'callee' && !C.pc) { toast('Answered on another device'); endLocal(); } });
});
