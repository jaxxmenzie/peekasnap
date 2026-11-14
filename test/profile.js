// Profile pictures (upload / replace / remove, shown everywhere a person appears) and nicknames (display name + private nicknames)
const fs = require('fs'), path = require('path');
const { io } = require('socket.io-client');
const { startServer, reporter, once, JPG } = require('./helpers');
(async () => {
  const { ok, done } = reporter();
  const S = await startServer(3994); const { api, BASE } = S;
  const up = async (token, buf = JPG, type = 'image/jpeg') => {
    const fd = new FormData(); fd.append('avatar', new Blob([buf], { type }), 'a.jpg');
    const r = await fetch(BASE + '/api/me/avatar', { method: 'POST', headers: { 'x-token': token }, body: fd }); return { status: r.status, ...(await r.json()) };
  };
  try {
    const a = await api('/api/signup', { body: { name: 'Ava Stone', username: 'ava', password: 'secret123' } });
    const b = await api('/api/signup', { body: { name: 'Ben', username: 'ben', password: 'secret123' } });
    const c = await api('/api/signup', { body: { name: 'Cy', username: 'cyd', password: 'secret123' } });
    ok(a.user.avatar === null, 'new accounts have no picture (app falls back to initials)');
    await api('/api/friends/request', { token: a.token, body: { userId: b.user.id } }); await api('/api/friends/accept', { token: b.token, body: { userId: a.user.id } });
    const sb = io(BASE, { auth: { token: b.token } }); await once(sb, 'connect');
    // --- profile picture ---
    const got = once(sb, 'profile', 5000, d => d.user.id === a.user.id && d.user.avatar);
    const u1 = await up(a.token);
    ok(u1.user && /^\/uploads\/av-\w+\.jpg$/.test(u1.user.avatar), 'upload a profile picture → stored on the server');
    const img = await fetch(BASE + u1.user.avatar); ok(img.status === 200 && (await img.arrayBuffer()).byteLength === JPG.length, 'picture is served');
    ok((await got).user.avatar === u1.user.avatar, 'friends get a live "profile" update');
    ok((await api('/api/me', { token: a.token })).user.avatar === u1.user.avatar, '/api/me has the picture');
    const fl = await api('/api/friends', { token: b.token });
    ok(fl.friends[0].user.avatar === u1.user.avatar, 'friends list carries the picture');
    const chats = await api('/api/chats', { token: b.token });
    ok(chats.chats.find(x => x.type === 'dm')?.user.avatar === u1.user.avatar, 'chat list carries the picture');
    const sr = await api('/api/users/search?q=av', { token: c.token });
    ok(sr.users[0]?.avatar === u1.user.avatar, 'search results carry the picture');
    await api('/api/stories', { token: a.token, form: { photo: 1 } }).catch(() => {});
    const st = await api('/api/stories', { token: b.token });
    ok(!st.friends?.length || st.friends[0].user.avatar === u1.user.avatar, 'stories carry the picture');
    const g = await api('/api/groups', { token: a.token, body: { name: 'Crew' } });
    const gr = await api('/api/groups/' + g.group.id, { token: a.token });
    ok(gr.group.members[0].avatar === u1.user.avatar, 'group members / game lobbies carry the picture');
    const u2 = await up(a.token);
    ok(u2.user.avatar !== u1.user.avatar, 'change picture → new file');
    await new Promise(r => setTimeout(r, 200));
    ok((await fetch(BASE + u1.user.avatar)).status === 404, 'old picture file is deleted');
    ok((await up(a.token, Buffer.alloc(1100 * 1024, 1))).status === 400, 'oversized upload (>1 MB) rejected');
    ok((await up(a.token, Buffer.from('hi'), 'text/plain')).status === 400, 'non-image upload rejected');
    const rm = await api('/api/me/avatar', { token: a.token, method: 'DELETE' });
    ok(rm.user.avatar === null && (await fetch(BASE + u2.user.avatar)).status === 404, 'remove picture → back to initials, file deleted');
    ok((await up('nope')).status === 401, 'upload needs to be logged in');
    // --- display name (your own nickname) ---
    const pr = once(sb, 'profile', 5000, d => d.user.name === 'Ava ✨');
    ok((await api('/api/me', { token: a.token, method: 'PATCH', body: { name: '  Ava   ✨ ' } })).user.name === 'Ava ✨', 'set your own display name (trimmed)');
    ok((await pr).user.id === a.user.id, 'friends get the new display name live');
    ok((await api('/api/me', { token: a.token, method: 'PATCH', body: { name: '   ' } })).status === 400, 'empty display name rejected');
    ok((await api('/api/users/search?q=ava ✨', { token: c.token })).users.length === 1, 'people are searchable by display name too');
    // --- private nicknames ---
    const nk = once(sb, 'nicknames', 5000);
    const n1 = await api('/api/nicknames/' + a.user.id, { token: b.token, method: 'PUT', body: { nickname: '  Bestie 💖  ' } });
    ok(n1.nicknames?.[a.user.id] === 'Bestie 💖', 'set a private nickname for a friend');
    ok((await nk).nicknames[a.user.id] === 'Bestie 💖', 'nickname syncs to my other devices');
    ok((await api('/api/me', { token: b.token })).nicknames[a.user.id] === 'Bestie 💖', '/api/me returns my nicknames');
    ok(!JSON.stringify(await api('/api/me', { token: a.token })).includes('Bestie'), 'the friend never sees the nickname');
    ok(!JSON.stringify(await api('/api/friends', { token: a.token })).includes('Bestie') && !JSON.stringify(await api('/api/chats', { token: a.token })).includes('Bestie'), '…not in their friends or chats either');
    ok((await api('/api/nicknames/' + a.user.id, { token: b.token, method: 'PUT', body: { nickname: 'x'.repeat(40) } })).nicknames[a.user.id].length === 24, 'nicknames are capped at 24 characters');
    ok((await api('/api/nicknames/' + b.user.id, { token: b.token, method: 'PUT', body: { nickname: 'me' } })).status === 404, "can't nickname yourself");
    ok((await api('/api/nicknames/nobody', { token: b.token, method: 'PUT', body: { nickname: 'x' } })).status === 404, 'unknown user rejected');
    const cl = await api('/api/nicknames/' + a.user.id, { token: b.token, method: 'PUT', body: { nickname: '' } });
    ok(!(a.user.id in cl.nicknames), 'clear a nickname');
    sb.close();
  } catch (e) { ok(false, 'crashed: ' + e.stack); }
  S.kill(); process.exit(done() ? 1 : 0);
})();
