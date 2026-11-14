// Manhunt mode end to end: lobby, settings, teams, head start, pings, out-of-bounds reveal, tags in/out of range, both win conditions.
const { io } = require('socket.io-client');
const { startServer, reporter, once } = require('./helpers');
const MIN = 60e3;
const C = { lat: 37.7694, lng: -122.4862 };
const off = (m, dLatM, dLngM = 0) => ({ lat: m.lat + dLatM / 111320, lng: m.lng + dLngM / (111320 * Math.cos(m.lat * Math.PI / 180)) });
(async () => {
  const S = await startServer(3993); const { api, advance } = S; const { ok, done } = reporter();
  try {
    const su = async (name) => api('/api/signup', { body: { name, password: 'secret123' } });
    const [host, r1, r2, hx, outsider] = await Promise.all(['Hana', 'Rio', 'Remy', 'Hex', 'Otto'].map(su));
    const g = (await api('/api/groups', { token: host.token, body: { name: 'Hunt Club' } })).group;
    for (const u of [r1, r2, hx]) await api('/api/groups/join', { token: u.token, body: { code: g.code } });
    const sock = async u => { const s = io(S.BASE, { auth: { token: u.token } }); await once(s, 'connect'); return s; };
    const [sHost, sR1, sR2, sHx] = await Promise.all([host, r1, r2, hx].map(sock));

    // lobby + settings
    const created = await api(`/api/groups/${g.id}/hunts`, { token: host.token, body: { center: C, radius: 300 } });
    const hid = created.hunt.id;
    ok(created.hunt.status === 'lobby' && created.hunt.settings.pingIntervalMin === 5 && created.hunt.settings.firstPingMin === 5 && created.hunt.settings.headStartMin === 2,
      'host opens a lobby: defaults ping every 5 min, first ping 5 min after start, 2 min head start');
    ok((await api(`/api/groups/${g.id}/hunts`, { token: r1.token, body: {} })).status === 409, 'only one open manhunt per group');
    ok((await api(`/api/hunts/${hid}`, { token: outsider.token })).status === 403, 'non-members cannot see the game');
    for (const u of [r1, r2, hx]) await api(`/api/hunts/${hid}/join`, { token: u.token, body: {} });
    ok((await api(`/api/hunts/${hid}/settings`, { token: r1.token, body: { radius: 1000 } })).status === 403, 'only the host can change settings');
    ok((await api(`/api/hunts/${hid}/settings`, { token: host.token, body: { radius: 10 } })).status === 400, 'invalid radius rejected');
    const set = await api(`/api/hunts/${hid}/settings`, { token: host.token, body: { durationMin: 30, revealHunters: false, taggedBecome: 'hunter' } });
    ok(set.hunt.settings.durationMin === 30, 'host sets game length 30 min');
    ok((await api(`/api/hunts/${hid}/location`, { token: r1.token, body: C })).status === 409, 'no location sharing before the game starts');
    const teams = await api(`/api/hunts/${hid}/teams`, { token: host.token, body: { roles: { [host.user.id]: 'hunter', [hx.user.id]: 'hunter', [r1.user.id]: 'runner', [r2.user.id]: 'runner' } } });
    ok(teams.hunt.players.filter(p => p.role === 'hunter').length === 2 && teams.hunt.settings.teamMode === 'pick', 'host picks teams: 2 hunters vs 2 runners');

    // start: head start
    const startEvt = once(sR1, 'hunt:start');
    const st = await api(`/api/hunts/${hid}/start`, { token: host.token, body: {} });
    ok(st.hunt.status === 'headstart' && st.hunt.huntStartAt - st.hunt.startedAt === 2 * MIN && st.hunt.nextPingAt - st.hunt.startedAt === 5 * MIN && st.hunt.endsAt - st.hunt.startedAt === 30 * MIN, 'game starts in head-start phase (hunters released at +2 min, first ping +5 min, ends +30 min)');
    ok((await startEvt).role === 'runner', 'runner told their role');
    const R1POS = off(C, 50), R2POS = off(C, -80, 40), HXPOS = off(C, 150, -100);
    await api(`/api/hunts/${hid}/location`, { token: r1.token, body: R1POS });
    await api(`/api/hunts/${hid}/location`, { token: r2.token, body: R2POS });
    await api(`/api/hunts/${hid}/location`, { token: hx.token, body: HXPOS });
    await api(`/api/hunts/${hid}/location`, { token: host.token, body: off(C, -150) });
    ok((await api(`/api/hunts/${hid}/tag`, { token: hx.token, body: R1POS })).status === 409, 'hunters cannot tag during the head start');
    let hv = (await api(`/api/hunts/${hid}`, { token: hx.token })).hunt;
    ok(!hv.locs[r1.user.id] && hv.locs[host.user.id] && hv.pings.length === 0, 'hunter sees teammates live but NOT runners before a ping');
    let rv = (await api(`/api/hunts/${hid}`, { token: r1.token })).hunt;
    ok(!rv.locs[hx.user.id] && rv.locs[r2.user.id], 'runner sees fellow runner, not hunters');

    const goEvt = once(sHx, 'hunt:go');
    await advance(2 * MIN + 1000);
    await goEvt;
    ok((await api(`/api/hunts/${hid}`, { token: hx.token })).hunt.status === 'active', 'after 2 min the hunters are released');

    // ping reveal
    const pingH = once(sHx, 'hunt:ping'), pingR = once(sR1, 'hunt:ping');
    await api(`/api/hunts/${hid}/location`, { token: r1.token, body: R1POS });
    await api(`/api/hunts/${hid}/location`, { token: r2.token, body: R2POS });
    await advance(3 * MIN);
    const ph = await pingH, pr = await pingR;
    ok(ph.n === 1 && Math.abs(ph.runners[r1.user.id].lat - R1POS.lat) < 1e-9 && ph.runners[r2.user.id], 'ping #1 at +5 min reveals every runner\'s location to hunters');
    ok(Object.keys(pr.runners).length === 0 && Object.keys(pr.hunters).length === 0, 'runners get the ping alert but see no hunters (reveal hunters is off)');
    hv = (await api(`/api/hunts/${hid}`, { token: hx.token })).hunt;
    ok(hv.pings[0].runners[r1.user.id] && hv.nextPingAt - hv.pings[0].at === 5 * MIN, 'ping stored for the hunters\' map; next ping in 5 min');
    rv = (await api(`/api/hunts/${hid}`, { token: r2.token })).hunt;
    ok(Object.keys(rv.pings[0].runners).length === 1 && rv.pings[0].runners[r2.user.id], 'a runner only sees their own revealed position');

    // out of bounds
    const revealEvt = once(sHx, 'hunt:reveal'), oobEvt = once(sR2, 'hunt:oob');
    const OUT = off(C, 400);
    const oob = await api(`/api/hunts/${hid}/location`, { token: r2.token, body: OUT });
    ok(oob.outOfBounds === true, 'runner leaving the circle is flagged out of bounds');
    ok((await oobEvt).huntId === hid, 'runner gets an out-of-bounds alert');
    const rev = await revealEvt;
    ok(rev.userId === r2.user.id && Math.abs(rev.lat - OUT.lat) < 1e-9, 'hunters see the runner instantly (no waiting for a ping)');
    ok((await api(`/api/hunts/${hid}`, { token: host.token })).hunt.reveals.some(r => r.userId === r2.user.id), 'reveal is on the hunters\' map');
    ok((await api(`/api/hunts/${hid}`, { token: r1.token })).hunt.reveals.length === 0, 'other runners do not get the reveal');
    await api(`/api/hunts/${hid}/location`, { token: r2.token, body: R2POS });

    // tags
    ok((await api(`/api/hunts/${hid}/tag`, { token: r1.token, body: R1POS })).status === 403, 'runners cannot tag');
    ok((await api(`/api/hunts/${hid}/tag`, { token: hx.token, body: off(R1POS, 100) })).status === 400, '"Tag nearest" with nobody within 15 m fails');
    const claimEvt = once(sR1, 'hunt:tag-claim');
    const far = await api(`/api/hunts/${hid}/tag`, { token: hx.token, body: { ...off(R1POS, 60), runnerId: r1.user.id } });
    ok(far.result === 'pending', 'tag from 60 m away is NOT accepted by GPS; runner asked to confirm');
    const claim = await claimEvt;
    await api(`/api/hunts/${hid}/tags/${claim.tagId}`, { token: r1.token, body: { accept: false } });
    ok((await api(`/api/hunts/${hid}`, { token: hx.token })).hunt.players.find(p => p.user.id === r1.user.id).role === 'runner', 'runner denies -> still a runner');
    await api(`/api/hunts/${hid}/location`, { token: r1.token, body: R1POS });
    const tagEvt = once(sR2, 'hunt:tagged');
    const near = await api(`/api/hunts/${hid}/tag`, { token: hx.token, body: off(R1POS, 8) });
    ok(near.result === 'tagged', 'tag within 15 m (8 m) is confirmed by GPS');
    ok((await tagEvt).runner.id === r1.user.id, 'everyone gets the tag alert');
    hv = (await api(`/api/hunts/${hid}`, { token: host.token })).hunt;
    ok(hv.players.find(p => p.user.id === r1.user.id).role === 'hunter' && hv.scoreboard.find(s => s.user.id === hx.user.id).tags === 1, 'tagged runner becomes a hunter; scoreboard credits the tagger');

    // last runner: pending claim confirmed by the runner -> hunters win
    const claim2 = once(sR2, 'hunt:tag-claim');
    await api(`/api/hunts/${hid}/tag`, { token: host.token, body: { ...off(C, -150), runnerId: r2.user.id } });
    const c2 = await claim2;
    const endEvt = once(sHost, 'hunt:end');
    await api(`/api/hunts/${hid}/tags/${c2.tagId}`, { token: r2.token, body: { accept: true } });
    const end = await endEvt;
    ok(end.winner === 'hunters', 'runner confirms the last tag -> all runners caught -> HUNTERS WIN');
    hv = (await api(`/api/hunts/${hid}`, { token: r2.token })).hunt;
    ok(hv.status === 'ended' && Object.keys(hv.locs).length === 0, 'game over: live locations cleared');
    ok((await api(`/api/hunts/${hid}/location`, { token: r2.token, body: R2POS })).status === 409, 'location sharing stops after the game');
    const chat = await api(`/api/chats/hunt_${hid}`, { token: r1.token });
    ok(chat.messages.some(m => /Ping 1/.test(m.text)) && chat.messages.some(m => /Hunters win/.test(m.text)), 'game chat has ping / tag / win messages');
    const sent = await api(`/api/chats/hunt_${hid}/messages`, { token: r1.token, form: { text: 'gg' } });
    ok(sent.message?.text === 'gg', 'players can chat in the game chat');

    // game 2: runners win on time (random teams, no head start, tagged -> spectator)
    const g2 = (await api(`/api/groups/${g.id}/hunts`, { token: r1.token, body: { center: C, radius: 500, durationMin: 10, headStartMin: 0, teamMode: 'random', hunterCount: 1, taggedBecome: 'spectator' } })).hunt;
    for (const u of [r2, hx]) await api(`/api/hunts/${g2.id}/join`, { token: u.token, body: {} });
    const s2 = (await api(`/api/hunts/${g2.id}/start`, { token: r1.token, body: {} })).hunt;
    ok(s2.status === 'active' && s2.players.filter(p => p.role === 'hunter').length === 1 && s2.players.filter(p => p.role === 'runner').length === 2, 'random teams: 1 hunter, 2 runners; no head start -> active immediately');
    const survivors = s2.players.filter(p => p.role === 'runner').map(p => p.user.id);
    const end2 = once(sR2, 'hunt:end');
    await advance(10 * MIN + 1000);
    const e2 = await end2;
    ok(e2.winner === 'runners', 'timer runs out with runners left -> RUNNERS WIN');
    ok(e2.scoreboard.filter(s => survivors.includes(s.user.id)).every(s => s.survived && s.points >= 20), 'survivors get +20 on the scoreboard');
    [sHost, sR1, sR2, sHx].forEach(s => s.close());
  } catch (e) { console.error(e); ok(false, 'exception: ' + e.message); }
  S.kill(); process.exit(done() ? 1 : 0);
})();
