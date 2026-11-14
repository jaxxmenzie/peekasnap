// Social layer: usernames, friends, snaps (view once + one replay), stories (24h), chat (DM + group, typing, read receipts), Snap Map ghost mode.
const fs = require('fs'), path = require('path');
const { io } = require('socket.io-client');
const { startServer, reporter, once } = require('./helpers');
(async () => {
  const S = await startServer(3995); const { api, advance } = S; const { ok, done } = reporter();
  try {
    const a = await api('/api/signup', { body: { name: 'Ava', username: 'ava_snaps' } });
    const b = await api('/api/signup', { body: { name: 'Ben', username: 'ben.b' } });
    const c = await api('/api/signup', { body: { name: 'Cat' } });
    ok(a.user.username === 'ava_snaps' && /^cat\d+$/.test(c.user.username), `sign up with a username (auto-generated when blank: @${c.user.username})`);
    ok((await api('/api/signup', { body: { name: 'Ava 2', username: 'AVA_SNAPS' } })).status === 409, 'usernames are unique (case-insensitive)');
    ok((await api('/api/signup', { body: { name: 'X', username: 'a b' } })).status === 400, 'invalid username rejected');
    ok(a.user.shareLocation === false, 'new users start in ghost mode (location sharing off)');

    // friends
    const sa = io(S.BASE, { auth: { token: a.token } }), sb = io(S.BASE, { auth: { token: b.token } });
    await Promise.all([once(sa, 'connect'), once(sb, 'connect')]);
    const found = await api('/api/users/search?q=ben', { token: a.token });
    ok(found.users.length === 1 && found.users[0].username === 'ben.b', 'search users by username');
    const reqEvt = once(sb, 'friends', 5000, d => d.type === 'request');
    ok((await api('/api/friends/request', { token: a.token, body: { username: '@ben.b' } })).status === 'outgoing', 'Ava sends Ben a friend request');
    ok((await reqEvt).user.username === 'ava_snaps', 'Ben gets a realtime friend-request event');
    const bf = await api('/api/friends', { token: b.token });
    ok(bf.incoming.length === 1 && bf.friends.length === 0, 'Ben sees 1 incoming request');
    ok((await api('/api/chats/dm_x/messages', { token: a.token, body: { text: 'hi' } })).status === 404, 'unknown chat rejected');
    const dm = 'dm_' + [a.user.id, b.user.id].sort().join('_');
    ok((await api(`/api/chats/${dm}/messages`, { token: a.token, form: { text: 'hi' } })).status === 403, 'cannot DM before being friends');
    ok((await api('/api/friends/accept', { token: b.token, body: { userId: a.user.id } })).status === 'friends', 'Ben accepts');
    ok((await api('/api/friends', { token: a.token })).friends[0].user.id === b.user.id, 'they are in each other\'s friend list');
    ok((await api('/api/snaps', { token: a.token, form: { photo: 1, to: [c.user.id], timer: 3 } })).status === 403, 'cannot snap a non-friend');

    // DM chat: typing + read receipts
    const typingEvt = once(sb, 'typing', 4000, d => d.chatId === dm);
    sa.emit('typing', { chatId: dm });
    ok((await typingEvt).user.name === 'Ava', 'typing indicator reaches the other person');
    const msgEvt = once(sb, 'message', 4000, m => m.chatId === dm);
    await api(`/api/chats/${dm}/messages`, { token: a.token, form: { text: 'yo Ben 👋' } });
    ok((await msgEvt).text === 'yo Ben 👋', 'DM text delivered in realtime');
    await api(`/api/chats/${dm}/messages`, { token: a.token, form: { photo: 1, text: 'look' } });
    let chats = await api('/api/chats', { token: b.token });
    ok(chats.chats.find(x => x.chatId === dm).unread === 2, 'chat list shows 2 unread for Ben');
    const readEvt = once(sa, 'read', 4000, d => d.chatId === dm);
    await api(`/api/chats/${dm}/read`, { token: b.token, body: {} });
    ok((await readEvt).userId === b.user.id, 'read receipt sent to Ava');
    chats = await api('/api/chats', { token: b.token });
    ok(chats.chats.find(x => x.chatId === dm).unread === 0, 'unread cleared after reading');
    const thread = await api(`/api/chats/${dm}`, { token: a.token });
    ok(thread.messages.length === 2 && thread.messages[1].photo && thread.reads[b.user.id], 'thread has text + photo message and Ben\'s read time');

    // snaps: view once, one replay, sender sees "opened"
    const snapEvt = once(sb, 'message', 4000, m => m.type === 'snap');
    const sent = await api('/api/snaps', { token: a.token, form: { photo: 1, to: [b.user.id], timer: 5 } });
    ok(sent.snaps.length === 1, 'Ava sends Ben a 5 s snap');
    const sm = await snapEvt;
    ok(sm.snap.state === 'new' && !sm.photo, 'Ben sees an unopened snap (no photo URL leaked in chat)');
    const inbox = await api('/api/snaps/inbox', { token: b.token });
    ok(inbox.snaps.length === 1 && inbox.snaps[0].timer === 5, 'snap inbox lists it with its timer');
    ok((await api(`/api/snaps/${sent.snaps[0]}/open`, { token: c.token, body: {} })).status === 404, 'someone else cannot open it');
    const openedEvt = once(sa, 'snap-opened', 4000);
    const op = await api(`/api/snaps/${sent.snaps[0]}/open`, { token: b.token, body: {} }); if (!op.image) console.log('open resp', op);
    ok(op.image?.startsWith('data:image/jpeg;base64,') && op.timer === 5, 'Ben opens it once (image + timer)');
    ok((await openedEvt).by.id === b.user.id, 'Ava is told it was opened');
    ok((await api(`/api/snaps/${sent.snaps[0]}/open`, { token: b.token, body: {} })).status === 410, 'opening again is refused (view once)');
    ok((await api(`/api/snaps/${sent.snaps[0]}/replay`, { token: b.token, body: {} })).image, 'one replay allowed');
    ok((await api(`/api/snaps/${sent.snaps[0]}/replay`, { token: b.token, body: {} })).status === 410, 'second replay refused');
    ok((await api(`/api/chats/${dm}`, { token: a.token })).messages.find(m => m.type === 'snap').snap.state === 'opened', 'Ava\'s chat shows the snap as Opened');
    await new Promise(r => setTimeout(r, 500));
    const snapFiles = () => fs.readdirSync(path.join(S.dir, 'd', 'snaps')).length;
    ok(snapFiles() === 0, 'snap photo deleted from the server once viewed + replayed');
    // unopened snap with no time limit; replay window expiry
    const s2 = await api('/api/snaps', { token: b.token, form: { photo: 1, to: [a.user.id], timer: 0 } });
    await api(`/api/snaps/${s2.snaps[0]}/open`, { token: a.token, body: {} });
    await advance(11 * 60e3);
    ok((await api(`/api/snaps/${s2.snaps[0]}/replay`, { token: a.token, body: {} })).status === 410 && snapFiles() === 0, 'replay window closes after 10 min and the file is purged');
    const s3 = await api('/api/snaps', { token: b.token, form: { photo: 1, to: [a.user.id], timer: 3 } });
    await advance(31 * 24 * 3600e3);
    ok((await api(`/api/snaps/${s3.snaps[0]}/open`, { token: a.token, body: {} })).status === 404, 'unopened snaps expire after 30 days');
    // streaks: both send snaps on a day
    await api('/api/snaps', { token: a.token, form: { photo: 1, to: [b.user.id], timer: 1 } });
    await api('/api/snaps', { token: b.token, form: { photo: 1, to: [a.user.id], timer: 1 } });
    ok((await api('/api/friends', { token: a.token })).friends[0].streak === 1, 'snap streak starts at 1 after both snap the same day 🔥');

    // group chat + group snap
    const g = (await api('/api/groups', { token: a.token, body: { name: 'Squad' } })).group;
    await api('/api/groups/join', { token: b.token, body: { code: g.code } });
    await api('/api/groups/join', { token: c.token, body: { code: g.code } });
    const gm = once(sb, 'message', 4000, m => m.chatId === g.id && m.userId === c.user.id);
    await api(`/api/chats/${g.id}/messages`, { token: c.token, form: { text: 'hey squad' } });
    ok((await gm).text === 'hey squad', 'group chat message delivered');
    const gs = await api('/api/snaps', { token: a.token, form: { photo: 1, groups: [g.id], timer: 4 } });
    ok((await api(`/api/snaps/${gs.snaps[0]}/open`, { token: b.token, body: {} })).image && (await api(`/api/snaps/${gs.snaps[0]}/open`, { token: c.token, body: {} })).image, 'group snap: each member can open it once');

    // stories
    const st = await api('/api/snaps', { token: a.token, form: { photo: 1, story: '1', timer: 4 } });
    ok(st.storyId, 'post a snap to My Story');
    let stories = await api('/api/stories', { token: b.token });
    ok(stories.friends.length === 1 && stories.friends[0].user.id === a.user.id && !stories.friends[0].allSeen, 'Ben\'s story bar shows Ava\'s new story');
    ok((await api('/api/stories', { token: c.token })).friends.length === 0, 'non-friends do not see the story');
    await api(`/api/stories/${st.storyId}/view`, { token: b.token, body: {} });
    const mine = await api('/api/stories', { token: a.token });
    ok(mine.mine.length === 1 && mine.mine[0].views[0].user.id === b.user.id, 'Ava sees Ben viewed her story');
    ok((await api('/api/stories', { token: b.token })).friends[0].allSeen, 'story marked seen for Ben');
    const photoUrl = mine.mine[0].photo;
    ok((await fetch(S.BASE + photoUrl)).status === 200, 'story photo served while live');
    await advance(23 * 3600e3);
    ok((await api('/api/stories', { token: b.token })).friends.length === 1, 'still there after 23 h');
    await advance(1.1 * 3600e3);
    ok((await api('/api/stories', { token: b.token })).friends.length === 0 && (await fetch(S.BASE + photoUrl)).status === 404, 'story gone after 24 h, photo deleted');

    // Snap Map ghost mode
    ok((await api('/api/me/location', { token: a.token, body: { lat: 37.77, lng: -122.48 } })).stored === false, 'ghost mode: location not stored');
    ok((await api('/api/map', { token: b.token })).friends.length === 0, 'friends cannot see a ghost');
    await api('/api/me', { token: a.token, method: 'PATCH', body: { shareLocation: true } });
    const locEvt = once(sb, 'friend-loc', 4000);
    await api('/api/me/location', { token: a.token, body: { lat: 37.77, lng: -122.48 } });
    ok((await locEvt).userId === a.user.id, 'sharing on: friends get live location');
    ok((await api('/api/map', { token: b.token })).friends[0].lat === 37.77 && (await api('/api/map', { token: c.token })).friends.length === 0, 'Snap Map shows Ava to friends only');
    await api('/api/me', { token: a.token, method: 'PATCH', body: { shareLocation: false } });
    ok((await api('/api/map', { token: b.token })).friends.length === 0, 'back to ghost mode: location removed');
    // deleting: unsend (for everyone), delete for me, delete whole conversation, group chats
    const msgsOf = async (tok, id) => (await api(`/api/chats/${id}`, { token: tok })).messages || [];
    const oops = (await api(`/api/chats/${dm}/messages`, { token: a.token, form: { text: 'oops wrong chat' } })).message;
    const delEvt = once(sb, 'message-deleted', 4000, d => d.id === oops.id);
    const un = await api(`/api/chats/${dm}/messages/${oops.id}`, { token: a.token, method: 'DELETE' });
    ok(un.scope === 'everyone' && (await delEvt).forEveryone === true, 'sender unsends a message: deleted for everyone (realtime event)');
    ok(!(await msgsOf(b.token, dm)).some(m => m.id === oops.id) && !(await msgsOf(a.token, dm)).some(m => m.id === oops.id), 'unsent message is gone for both people');
    const avaMsg = (await msgsOf(b.token, dm)).find(m => m.userId === a.user.id && m.type === 'chat');
    const dme = await api(`/api/chats/${dm}/messages/${avaMsg.id}`, { token: b.token, method: 'DELETE' });
    ok(dme.scope === 'me' && !(await msgsOf(b.token, dm)).some(m => m.id === avaMsg.id) && (await msgsOf(a.token, dm)).some(m => m.id === avaMsg.id), "deleting someone else's message hides it only for me");
    ok((await api(`/api/chats/${dm}/messages/${avaMsg.id}`, { token: b.token, method: 'DELETE' })).status === 404, 'already-deleted message -> 404');
    await api(`/api/snaps`, { token: a.token, form: { photo: 1, to: [b.user.id], timer: 5 } });
    const snapMsg = (await msgsOf(a.token, dm)).filter(m => m.type === 'snap').pop();
    await api(`/api/chats/${dm}/messages/${snapMsg.id}`, { token: a.token, method: 'DELETE' });
    ok(!(await api('/api/snaps/inbox', { token: b.token })).snaps.some(x => x.id === snapMsg.snapId) && (await api(`/api/snaps/${snapMsg.snapId}/open`, { token: b.token, body: {} })).status === 404, 'unsending an unopened Snap removes it from their inbox');
    ok((await api(`/api/chats/${dm}`, { token: c.token, method: 'DELETE' })).status === 404, "can't delete a chat you're not in");
    const chDel = once(sb, 'chat-deleted', 4000, d => d.chatId === dm);
    ok((await api(`/api/chats/${dm}`, { token: b.token, method: 'DELETE' })).ok && (await chDel).chatId === dm, 'Ben deletes the whole conversation');
    ok(!(await api('/api/chats', { token: b.token })).chats.some(x => x.chatId === dm) && (await msgsOf(b.token, dm)).length === 0, 'deleted conversation leaves his chat list and history');
    ok((await msgsOf(a.token, dm)).length > 0 && (await api('/api/chats', { token: a.token })).chats.some(x => x.chatId === dm), 'Ava still has her copy');
    await api(`/api/chats/${dm}/messages`, { token: a.token, form: { text: 'you there?' } });
    const back = await msgsOf(b.token, dm);
    ok(back.length === 1 && back[0].text === 'you there?' && (await api('/api/chats', { token: b.token })).chats.some(x => x.chatId === dm), 'a new message brings the chat back with only the new message');
    await api(`/api/chats/${g.id}`, { token: c.token, method: 'DELETE' });
    ok(!(await api('/api/chats', { token: c.token })).chats.some(x => x.chatId === g.id) && (await api('/api/chats', { token: a.token })).chats.some(x => x.chatId === g.id), 'deleting a group chat removes it from my list only');
    await api(`/api/chats/${g.id}/messages`, { token: a.token, form: { text: 'squad meeting' } });
    ok((await api('/api/chats', { token: c.token })).chats.some(x => x.chatId === g.id), 'group chat returns when someone posts');
    await api(`/api/groups/${g.id}/leave`, { token: c.token, body: {} });
    ok(!(await api('/api/chats', { token: c.token })).chats.some(x => x.chatId === g.id) && (await api(`/api/chats/${g.id}`, { token: c.token })).status === 404, 'leaving the group removes its chat for good');

    await api('/api/friends/remove', { token: b.token, body: { userId: a.user.id } });
    ok((await api('/api/friends', { token: a.token })).friends.length === 0, 'unfriend works');
    sa.close(); sb.close();
  } catch (e) { console.error(e); ok(false, 'exception: ' + e.message); }
  S.kill(); process.exit(done() ? 1 : 0);
})();
