// Manhunt mode: hunters vs runners inside a map circle, with timed location pings.
module.exports = function manhunt(ctx) {
  const { app, io, db, save, now, id, auth, member, bad, publicUser, pushToUsers, distanceM, validPoint, pt, userRoom } = ctx;
  db.hunts ||= {};
  const TAG_RADIUS_M = Number(process.env.TAG_RADIUS_M || 15);
  const FRESH_MS = 60e3; // a location older than this can't be used for an automatic GPS tag
  const MIN = 60e3;
  const DEFAULTS = { radius: 400, durationMin: 20, pingIntervalMin: 5, firstPingMin: 5, headStartMin: 2, revealHunters: false, taggedBecome: 'hunter', teamMode: 'random', hunterCount: 1 };
  const emitTo = (uid, ev, d) => io.to(userRoom(uid)).emit(ev, d);
  const players = h => Object.keys(h.players);
  const withRole = (h, role) => players(h).filter(u => h.players[u].role === role);
  const sys = (h, text, type = 'hunt') => ctx.postChat('hunt_' + h.id, { type, text, huntId: h.id });

  function view(h, uid) {
    const me = h.players[uid]; const role = me ? me.role : 'viewer'; const over = h.status === 'ended';
    const seeRunners = over || role === 'hunter' || role === 'spectator';
    const seeHunters = over || role !== 'runner' || h.settings.revealHunters;
    const locs = {};
    if (h.locs && !over) for (const [u, l] of Object.entries(h.locs)) {
      const r = h.players[u]?.role;
      // live positions are only shared with teammates (and spectators see everyone); enemies only learn them at pings
      if (u === uid || (role !== 'spectator' && r === role) || role === 'spectator') locs[u] = l;
    }
    return {
      id: h.id, groupId: h.groupId, host: publicUser(db.users[h.hostId]), isHost: h.hostId === uid, status: h.status, settings: h.settings,
      createdAt: h.createdAt, startedAt: h.startedAt, huntStartAt: h.huntStartAt, nextPingAt: h.status === 'ended' ? null : h.nextPingAt, endsAt: h.endsAt,
      endedAt: h.endedAt, winner: h.winner, myRole: role, serverNow: now(),
      players: players(h).map(u => ({ user: publicUser(db.users[u]), role: h.players[u].role, taggedBy: publicUser(db.users[h.players[u].taggedBy]), taggedAt: h.players[u].taggedAt,
        outOfBounds: (seeRunners || u === uid) ? !!h.players[u].outOfBounds : undefined, stats: h.players[u].stats })),
      pings: h.pings.map(p => ({ n: p.n, at: p.at, runners: seeRunners ? p.runners : (role === 'runner' && p.runners[uid] ? { [uid]: p.runners[uid] } : {}), hunters: seeHunters ? p.hunters : {} })),
      reveals: seeRunners ? h.reveals.filter(r => now() - r.at < 10 * MIN) : [],
      locs,
      tags: h.tags.map(t => ({ ...t, hunter: publicUser(db.users[t.hunterId]), runner: publicUser(db.users[t.runnerId]) })),
      scoreboard: scoreboard(h),
    };
  }
  function scoreboard(h) {
    return players(h).map(u => {
      const p = h.players[u], s = p.stats;
      return { user: publicUser(db.users[u]), role: p.role, points: s.tags * 10 + s.pingsSurvived * 3 + (s.survived ? 20 : 0), ...s };
    }).sort((a, b) => b.points - a.points);
  }
  function broadcast(h) { for (const u of db.groups[h.groupId]?.members || []) emitTo(u, 'hunt', view(h, u)); }
  const current = gid => Object.values(db.hunts).filter(h => h.groupId === gid).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  const huntAccess = (req, res, next) => {
    const h = db.hunts[req.params.id];
    if (!h) return res.status(404).json({ error: 'Game not found' });
    if (!db.groups[h.groupId]?.members.includes(req.user.id)) return res.status(403).json({ error: 'Not in this group' });
    req.hunt = h; next();
  };
  const hostOnly = (req, res, next) => req.hunt.hostId === req.user.id ? next() : res.status(403).json({ error: 'Only the host can do that' });
  const newPlayer = role => ({ role, joinedAt: now(), stats: { tags: 0, pingsSurvived: 0, survived: false } });

  function applySettings(h, b) {
    const s = { ...h.settings };
    if (b.center !== undefined) { if (!validPoint(b.center)) throw new Error('Set the play area center'); s.center = pt(b.center); }
    const num = (k, lo, hi, label) => { if (b[k] === undefined) return; const v = +b[k]; if (!(v >= lo && v <= hi)) throw new Error(`${label} must be ${lo}-${hi}`); s[k] = v; };
    num('radius', 50, 5000, 'Radius (m)'); num('durationMin', 0.5, 240, 'Game length (min)'); num('pingIntervalMin', 0.05, 60, 'Ping interval (min)');
    num('firstPingMin', 0.05, 60, 'First ping (min)'); num('headStartMin', 0, 30, 'Head start (min)'); num('hunterCount', 1, 20, 'Hunters');
    if (b.revealHunters !== undefined) s.revealHunters = !!b.revealHunters;
    if (b.taggedBecome !== undefined) { if (!['hunter', 'spectator'].includes(b.taggedBecome)) throw new Error('Tagged runners become hunter or spectator'); s.taggedBecome = b.taggedBecome; }
    if (b.teamMode !== undefined) { if (!['random', 'pick'].includes(b.teamMode)) throw new Error('Teams are random or pick'); s.teamMode = b.teamMode; }
    h.settings = s;
  }

  app.get('/api/groups/:gid/hunt', auth, member, (req, res) => { const h = current(req.group.id); res.json({ hunt: h ? view(h, req.user.id) : null }); });
  app.post('/api/groups/:gid/hunts', auth, member, (req, res) => {
    const cur = current(req.group.id);
    if (cur && cur.status !== 'ended') return res.status(409).json({ error: 'A manhunt is already set up in this group', hunt: view(cur, req.user.id) });
    const h = { id: id(), groupId: req.group.id, hostId: req.user.id, status: 'lobby', settings: { ...DEFAULTS, center: null }, players: { [req.user.id]: newPlayer('runner') },
      pings: [], reveals: [], tags: [], locs: {}, createdAt: now() };
    try { applySettings(h, req.body || {}); } catch (e) { return bad(res, e.message); }
    db.hunts[h.id] = h; save();
    ctx.postMessage(h.groupId, { type: 'system', text: `🏃 ${req.user.name} opened a Manhunt lobby. Open Play to join!` });
    pushToUsers(req.group.members.filter(u => u !== req.user.id), { title: '🏃 Manhunt lobby open', body: `${req.user.name} started a Manhunt lobby in ${req.group.name}`, url: '/#play' });
    broadcast(h); res.json({ hunt: view(h, req.user.id) });
  });
  app.get('/api/hunts/:id', auth, huntAccess, (req, res) => res.json({ hunt: view(req.hunt, req.user.id) }));
  app.post('/api/hunts/:id/join', auth, huntAccess, (req, res) => {
    const h = req.hunt; if (h.status !== 'lobby') return bad(res, 'This game already started');
    h.players[req.user.id] ||= newPlayer('runner'); save(); broadcast(h); res.json({ hunt: view(h, req.user.id) });
  });
  app.post('/api/hunts/:id/leave', auth, huntAccess, (req, res) => {
    const h = req.hunt;
    if (h.status === 'lobby') { delete h.players[req.user.id]; if (req.user.id === h.hostId) { h.status = 'ended'; h.winner = 'cancelled'; h.endedAt = now(); } }
    else if (h.players[req.user.id] && h.status !== 'ended') { h.players[req.user.id].role = 'spectator'; delete h.locs[req.user.id]; checkWin(h); }
    save(); broadcast(h); res.json({ ok: true });
  });
  app.post('/api/hunts/:id/settings', auth, huntAccess, hostOnly, (req, res) => {
    const h = req.hunt; if (h.status !== 'lobby') return bad(res, 'Settings are locked once the game starts');
    try { applySettings(h, req.body || {}); } catch (e) { return bad(res, e.message); }
    save(); broadcast(h); res.json({ hunt: view(h, req.user.id) });
  });
  app.post('/api/hunts/:id/teams', auth, huntAccess, hostOnly, (req, res) => { // { roles: { userId: 'hunter'|'runner' } }
    const h = req.hunt; if (h.status !== 'lobby') return bad(res, 'Teams are locked once the game starts');
    for (const [u, r] of Object.entries(req.body.roles || {})) if (h.players[u] && ['hunter', 'runner'].includes(r)) h.players[u].role = r;
    h.settings.teamMode = 'pick'; save(); broadcast(h); res.json({ hunt: view(h, req.user.id) });
  });
  app.post('/api/hunts/:id/start', auth, huntAccess, hostOnly, (req, res) => {
    const h = req.hunt; const s = h.settings;
    if (h.status !== 'lobby') return bad(res, 'Already started');
    if (!s.center) return bad(res, 'Set the play area first');
    const ids = players(h);
    if (ids.length < 2) return bad(res, 'Need at least 2 players');
    if (s.teamMode === 'random') {
      const shuffled = ids.sort(() => Math.random() - 0.5), n = Math.min(s.hunterCount, ids.length - 1);
      shuffled.forEach((u, i) => (h.players[u].role = i < n ? 'hunter' : 'runner'));
    }
    if (!withRole(h, 'hunter').length || !withRole(h, 'runner').length) return bad(res, 'Need at least one hunter and one runner');
    const t = now();
    h.status = s.headStartMin > 0 ? 'headstart' : 'active';
    h.startedAt = t; h.huntStartAt = t + s.headStartMin * MIN; h.nextPingAt = t + s.firstPingMin * MIN; h.endsAt = t + s.durationMin * MIN;
    save(); broadcast(h);
    sys(h, `🏁 Manhunt started! ${withRole(h, 'runner').length} runner(s) vs ${withRole(h, 'hunter').length} hunter(s). Runners have a ${s.headStartMin} min head start.`);
    for (const u of ids) pushToUsers([u], { title: '🏁 Manhunt started!', body: h.players[u].role === 'hunter' ? `You're a HUNTER. Wait ${s.headStartMin} min, then go!` : `You're a RUNNER. Go go go! ${s.headStartMin} min head start.`, url: '/#play', tag: 'hunt-' + h.id });
    for (const u of ids) emitTo(u, 'hunt:start', { huntId: h.id, role: h.players[u].role });
    res.json({ hunt: view(h, req.user.id) });
  });
  app.post('/api/hunts/:id/end', auth, huntAccess, hostOnly, (req, res) => {
    const h = req.hunt; if (h.status === 'ended') return bad(res, 'Already over');
    endGame(h, h.status === 'lobby' ? 'cancelled' : 'cancelled'); res.json({ hunt: view(h, req.user.id) });
  });

  // live location: only accepted while a game is running, and only from players in it
  app.post('/api/hunts/:id/location', auth, huntAccess, (req, res) => {
    const h = req.hunt, p = h.players[req.user.id];
    if (!p || !['headstart', 'active'].includes(h.status)) return res.status(409).json({ error: 'Location is only shared during an active manhunt' });
    if (!validPoint(req.body)) return bad(res, 'Bad location');
    const l = { ...pt(req.body), t: now() }; h.locs[req.user.id] = l;
    let oob = false;
    if (p.role === 'runner') {
      oob = distanceM(l, h.settings.center) > h.settings.radius;
      if (oob) { // out of the play area: runner is warned and revealed to hunters immediately (on every update while outside)
        const r = { userId: req.user.id, user: publicUser(req.user), lat: l.lat, lng: l.lng, at: l.t, reason: 'out-of-bounds' };
        h.reveals.push(r); if (h.reveals.length > 200) h.reveals.shift();
        for (const u of players(h)) if (h.players[u].role !== 'runner') emitTo(u, 'hunt:reveal', { huntId: h.id, ...r });
        if (!p.outOfBounds) {
          emitTo(req.user.id, 'hunt:oob', { huntId: h.id });
          pushToUsers([req.user.id], { title: '⚠️ Out of bounds!', body: 'Get back inside the play area. Hunters can see you!', url: '/#play', tag: 'hunt-oob' });
          sys(h, `⚠️ ${req.user.name} left the play area and was revealed!`);
        }
      }
      p.outOfBounds = oob;
    }
    for (const u of players(h)) if (u !== req.user.id && (h.players[u].role === p.role || h.players[u].role === 'spectator')) emitTo(u, 'hunt:loc', { huntId: h.id, userId: req.user.id, ...l });
    save(); res.json({ ok: true, outOfBounds: oob });
  });

  // Tag: hunter must be within TAG_RADIUS_M of the runner's last fresh GPS fix; otherwise the runner is asked to confirm
  app.post('/api/hunts/:id/tag', auth, huntAccess, (req, res) => {
    const h = req.hunt, me = h.players[req.user.id];
    if (!me || me.role !== 'hunter') return res.status(403).json({ error: 'Only hunters can tag' });
    if (h.status === 'headstart') return res.status(409).json({ error: 'Runners still have their head start!' });
    if (h.status !== 'active') return bad(res, 'The game is not running');
    if (!validPoint(req.body)) return bad(res, 'Need your location to tag');
    const at = pt(req.body); h.locs[req.user.id] = { ...at, t: now() };
    const runners = withRole(h, 'runner');
    const fresh = u => h.locs[u] && now() - h.locs[u].t <= FRESH_MS;
    let target = req.body.runnerId;
    if (target && !runners.includes(target)) return bad(res, 'That player is not a runner');
    const dist = u => fresh(u) ? distanceM(at, h.locs[u]) : Infinity;
    if (!target) { // "tag nearest"
      const near = runners.filter(u => dist(u) <= TAG_RADIUS_M).sort((a, b) => dist(a) - dist(b))[0];
      if (!near) return res.status(400).json({ error: `No runner within ${TAG_RADIUS_M} m. Get closer!` });
      target = near;
    }
    const d = dist(target);
    const tag = { id: id(), hunterId: req.user.id, runnerId: target, at: now(), status: 'pending', gps: d <= TAG_RADIUS_M };
    h.tags.push(tag);
    if (d <= TAG_RADIUS_M) { confirmTag(h, tag); save(); return res.json({ result: 'tagged', message: `Tagged ${db.users[target].name}! 🎯` }); }
    save(); broadcast(h);
    emitTo(target, 'hunt:tag-claim', { huntId: h.id, tagId: tag.id, hunter: publicUser(req.user) });
    pushToUsers([target], { title: '🎯 Were you tagged?', body: `${req.user.name} says they tagged you. Confirm or deny.`, url: '/#play', tag: 'hunt-tag' });
    res.json({ result: 'pending', message: `GPS can't confirm you're within ${TAG_RADIUS_M} m. Asked ${db.users[target].name} to confirm.` });
  });
  app.post('/api/hunts/:id/tags/:tid', auth, huntAccess, (req, res) => { // runner confirms / denies a tag claim
    const h = req.hunt, t = h.tags.find(x => x.id === req.params.tid);
    if (!t || t.status !== 'pending') return res.status(404).json({ error: 'Tag not found' });
    if (t.runnerId !== req.user.id) return res.status(403).json({ error: 'Only the tagged runner can confirm' });
    if (h.status !== 'active') return bad(res, 'The game is not running');
    if (req.body.accept) confirmTag(h, t);
    else { t.status = 'denied'; sys(h, `🙅 ${req.user.name} says ${db.users[t.hunterId].name} missed!`); broadcast(h); }
    save(); res.json({ hunt: view(h, req.user.id) });
  });
  function confirmTag(h, t) {
    const r = h.players[t.runnerId];
    if (!r || r.role !== 'runner') { t.status = 'void'; return; }
    t.status = 'confirmed';
    h.tags.filter(x => x.runnerId === t.runnerId && x.status === 'pending' && x !== t).forEach(x => (x.status = 'void'));
    h.players[t.hunterId].stats.tags++;
    r.role = h.settings.taggedBecome; r.taggedBy = t.hunterId; r.taggedAt = now(); r.outOfBounds = false;
    const hn = db.users[t.hunterId].name, rn = db.users[t.runnerId].name;
    sys(h, `🎯 ${hn} tagged ${rn}! ${h.settings.taggedBecome === 'hunter' ? `${rn} is now a hunter.` : `${rn} is out.`} ${withRole(h, 'runner').length} runner(s) left.`);
    for (const u of players(h)) emitTo(u, 'hunt:tagged', { huntId: h.id, hunter: publicUser(db.users[t.hunterId]), runner: publicUser(db.users[t.runnerId]), left: withRole(h, 'runner').length });
    pushToUsers(players(h).filter(u => u !== t.hunterId), { title: '🎯 Tagged!', body: `${hn} tagged ${rn}. ${withRole(h, 'runner').length} runner(s) left.`, url: '/#play', tag: 'hunt-' + h.id });
    if (!checkWin(h)) broadcast(h);
  }
  function checkWin(h) {
    if (['headstart', 'active'].includes(h.status) && !withRole(h, 'runner').length) { endGame(h, 'hunters'); return true; }
    return false;
  }
  function endGame(h, winner) {
    h.status = 'ended'; h.winner = winner; h.endedAt = now();
    if (winner === 'runners') withRole(h, 'runner').forEach(u => (h.players[u].stats.survived = true));
    h.locs = {}; // location sharing stops when the game ends
    h.tags.filter(t => t.status === 'pending').forEach(t => (t.status = 'void'));
    save(); broadcast(h);
    const msg = winner === 'hunters' ? '🏆 Hunters win! Every runner was caught.' : winner === 'runners' ? `🏆 Time's up, runners win! Survivors: ${withRole(h, 'runner').map(u => db.users[u].name).join(', ')}` : 'Manhunt cancelled.';
    sys(h, msg);
    for (const u of players(h)) emitTo(u, 'hunt:end', { huntId: h.id, winner, scoreboard: scoreboard(h) });
    if (winner !== 'cancelled') pushToUsers(players(h), { title: '🏁 Manhunt over', body: msg, url: '/#play', tag: 'hunt-' + h.id });
  }
  function firePing(h) {
    const n = h.pings.length + 1, runners = {}, hunters = {};
    for (const u of withRole(h, 'runner')) { if (h.locs[u]) runners[u] = { lat: h.locs[u].lat, lng: h.locs[u].lng, t: h.locs[u].t }; h.players[u].stats.pingsSurvived++; }
    for (const u of withRole(h, 'hunter')) if (h.locs[u]) hunters[u] = { lat: h.locs[u].lat, lng: h.locs[u].lng, t: h.locs[u].t };
    h.pings.push({ n, at: now(), runners, hunters });
    h.nextPingAt = now() + h.settings.pingIntervalMin * MIN;
    save(); broadcast(h);
    for (const u of players(h)) {
      const role = h.players[u].role;
      emitTo(u, 'hunt:ping', { huntId: h.id, n, role, runners: role !== 'runner' ? runners : {}, hunters: role !== 'runner' || h.settings.revealHunters ? hunters : {} });
    }
    pushToUsers(withRole(h, 'hunter').concat(withRole(h, 'spectator')), { title: `📡 Ping ${n}: runners revealed!`, body: `${Object.keys(runners).length} runner location(s) on the map. Go!`, url: '/#play', tag: 'hunt-ping' });
    pushToUsers(withRole(h, 'runner'), { title: `📡 Ping ${n}: you were revealed!`, body: h.settings.revealHunters ? 'Hunters saw where you are. See where they are and move!' : 'Hunters saw where you are. Move!', url: '/#play', tag: 'hunt-ping' });
    sys(h, `📡 Ping ${n}: ${Object.keys(runners).length} runner(s) revealed to hunters.`);
  }
  function tick() {
    const t = now();
    for (const h of Object.values(db.hunts)) {
      if (h.status === 'headstart' && t >= h.huntStartAt) {
        h.status = 'active'; save(); broadcast(h);
        sys(h, '🔓 Head start over. Hunters, go!');
        for (const u of players(h)) emitTo(u, 'hunt:go', { huntId: h.id });
        pushToUsers(players(h), { title: '🔓 Hunters released!', body: 'The head start is over. Hunters are coming!', url: '/#play', tag: 'hunt-' + h.id });
      }
      if (!['headstart', 'active'].includes(h.status)) continue;
      if (t >= h.endsAt) { endGame(h, 'runners'); continue; }
      if (t >= h.nextPingAt) firePing(h);
    }
  }
  return { tick, view };
};
