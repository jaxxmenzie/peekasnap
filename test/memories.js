// Memories (your sent Peaks), Peak history in chats (Allow replay), and profile pages (full for friends, limited for others)
const fs = require('fs'), path = require('path');
const { startServer, reporter, JPG } = require('./helpers');
(async () => {
  const { ok, done } = reporter();
  const S = await startServer(3996); const { api, BASE, advance } = S;
  const send = async (token, fields, withThumb = true) => {
    const fd = new FormData(); fd.append('photo', new Blob([JPG], { type: 'image/jpeg' }), 'p.jpg');
    if (withThumb) fd.append('thumb', new Blob([JPG], { type: 'image/jpeg' }), 't.jpg');
    for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    const r = await fetch(BASE + '/api/snaps', { method: 'POST', headers: { 'x-token': token }, body: fd }); return { status: r.status, ...(await r.json()) };
  };
  try {
    const mk = n => api('/api/signup', { body: { name: n, username: n.toLowerCase(), password: 'secret123' } });
    const [a, b, c, d] = [await mk('Ava'), await mk('Ben'), await mk('Cleo'), await mk('Dex')];
    const fr = async (x, y) => { await api('/api/friends/request', { token: x.token, body: { userId: y.user.id } }); await api('/api/friends/accept', { token: y.token, body: { userId: x.user.id } }); };
    await fr(a, b); await fr(a, c); await fr(b, c);
    const dm = 'dm_' + [a.user.id, b.user.id].sort().join('_');
    // --- Memories ---
    const s1 = await send(a.token, { to: [b.user.id, c.user.id], timer: 3 });
    ok(s1.snaps.length === 2 && s1.memoryId, 'sending a Peak saves it to your Memories');
    const s2 = await send(a.token, { to: [b.user.id], timer: 0, replay: '0' });
    const mem = await api('/api/memories', { token: a.token });
    ok(mem.memories.length === 2 && mem.memories[0].createdAt >= mem.memories[1].createdAt && mem.memories[0].thumb?.startsWith('data:image/jpeg'), 'Memories list: newest first, with thumbnails');
    ok((await api('/api/memories', { token: b.token })).memories.length === 0, "recipients don't get your Memories");
    const full = await api('/api/memories/' + s1.memoryId, { token: a.token });
    ok(full.image?.startsWith('data:image/jpeg;base64,'), 'open a Memory full size');
    ok((await api('/api/memories/' + s1.memoryId, { token: b.token })).status === 404, "others can't open your Memories");
    // --- chat history with Allow replay ---
    const before = (await api('/api/chats/' + dm, { token: b.token })).messages.find(m => m.snapId === s1.snaps[0]);
    ok(before.snap.state === 'new' && !before.snap.thumb, 'unopened Peak: no thumbnail leaked before opening');
    ok((await api(`/api/snaps/${s1.snaps[0]}/view`, { token: b.token, body: {} })).status === 404, "can't use history view before opening");
    await api(`/api/snaps/${s1.snaps[0]}/open`, { token: b.token, body: {} });
    await advance(2 * 3600e3); await new Promise(r => setTimeout(r, 400));
    const after = (await api('/api/chats/' + dm, { token: b.token })).messages.find(m => m.snapId === s1.snaps[0]);
    ok(after.snap.state === 'history' && after.snap.thumb, 'opened Peak stays in the chat as an "Opened" entry with a thumbnail (Allow replay on)');
    const again = await api(`/api/snaps/${s1.snaps[0]}/view`, { token: b.token, body: {} });
    ok(again.image && again.history && again.timer === 0, 'tap to view it again, hours later');
    ok((await api(`/api/snaps/${s1.snaps[0]}/view`, { token: a.token, body: {} })).image, 'sender can view what they sent too');
    const mine = (await api('/api/chats/' + dm, { token: a.token })).messages.find(m => m.snapId === s1.snaps[0]);
    ok(mine.snap.state === 'opened' && mine.snap.thumb && mine.snap.allowReplay, 'sender sees Opened + thumbnail');
    ok((await api(`/api/snaps/${s1.snaps[0]}/view`, { token: d.token, body: {} })).status === 404, 'outsiders cannot view');
    // Cleo's copy of the same Peak still works after Ben's was opened
    ok((await api(`/api/snaps/${s1.snaps[1]}/open`, { token: c.token, body: {} })).image, "one upload sent to two friends: the 2nd friend's copy still opens");
    // replay off: vanishes like before
    await api(`/api/snaps/${s2.snaps[0]}/open`, { token: b.token, body: {} });
    await advance(11 * 60e3); await new Promise(r => setTimeout(r, 400));
    const off = (await api('/api/chats/' + dm, { token: b.token })).messages.find(m => m.snapId === s2.snaps[0]);
    ok(off.snap.state === 'opened' && !off.snap.thumb, 'Allow replay off: no history entry image');
    ok((await api(`/api/snaps/${s2.snaps[0]}/view`, { token: b.token, body: {} })).status === 404, '…and it cannot be re-opened');
    ok((await api('/api/memories/' + mem.memories[0].id, { token: a.token })).image, '…but it is still in the sender\'s Memories');
    // delete memory
    ok((await api('/api/memories/' + s1.memoryId, { token: a.token, method: 'DELETE' })).ok && (await api('/api/memories/' + s1.memoryId, { token: a.token })).status === 404, 'delete a Memory');
    ok((await api(`/api/snaps/${s1.snaps[0]}/view`, { token: b.token, body: {} })).image, "deleting a Memory doesn't touch the chat copy");
    // --- profiles ---
    await send(b.token, { to: [a.user.id], timer: 3 }); await send(a.token, { story: '1', timer: 5 });
    const pf = await api('/api/users/' + a.user.id + '/profile', { token: b.token });
    ok(pf.relation === 'friends' && !pf.limited && pf.user.username === 'ava', 'friend profile: full view');
    ok(pf.mutual.length === 1 && pf.mutual[0].id === c.user.id, 'mutual friends listed (Cleo)');
    ok(pf.stories.length === 1, "their live story shows");
    ok(pf.peaks.some(p => !p.mine && p.thumb) && pf.peaks.some(p => p.mine), 'recent Peaks shared between you (both ways, viewable ones only)');
    ok(pf.score >= 3 && pf.stats.hideSeek && pf.stats.manhunt, `Peak score (${pf.score}) and game stats`);
    ok(pf.friendsSince > 0, 'friends since date');
    await api('/api/nicknames/' + a.user.id, { token: b.token, method: 'PUT', body: { nickname: 'Avs' } });
    ok((await api('/api/users/' + a.user.id + '/profile', { token: b.token })).nickname === 'Avs', 'your private nickname shows on their profile');
    const lim = await api('/api/users/' + a.user.id + '/profile', { token: d.token });
    ok(lim.limited && lim.relation === 'none' && lim.user.username === 'ava', 'non-friend: limited view');
    ok(!('stories' in lim) && !('mutual' in lim) && !('peaks' in lim) && !('score' in lim) && !('sharingLocation' in lim), '…no stories, Peaks, mutuals, stats or location');
    await api('/api/friends/request', { token: d.token, body: { userId: a.user.id } });
    ok((await api('/api/users/' + a.user.id + '/profile', { token: d.token })).relation === 'outgoing', 'relation updates after Add Friend (requested)');
    ok((await api('/api/users/' + a.user.id + '/profile', { token: a.token })).relation === 'self', 'your own profile');
    ok((await api('/api/users/nobody/profile', { token: a.token })).status === 404, 'unknown user → 404');
  } catch (e) { ok(false, 'crashed: ' + e.stack); }
  S.kill(); process.exit(done() ? 1 : 0);
})();
