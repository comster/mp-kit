// A room on top of a Transport: who's here (the roster), who's the host, and the messages a game
// needs. One player's browser is the host and owns the rules. If the host leaves, the oldest
// remaining player takes over and the game resumes from the last full state the old host sent.
//
// Players are keyed by `pid`, a stable id kept in sessionStorage, not by the transport's peer id.
// A reloaded tab comes back with the same pid and gets its seat back.
//
//   const room = createRoom({ transport, pid, name })
//   room.on('roster', roster => …)            every change to the player list
//   room.on('host', ({ isHost, migrated }) => …)
//   room.isHost / room.me / room.roster / room.hostPid
//
//   client → host:   room.sendInput(data)        latest wins, may be dropped      → host 'input' (pid, data)
//                    room.sendToHost(type, data) must arrive                      → host 'clientEvent' (pid, type, data)
//   host → clients:  room.sendSnapshot(data)     15–20 times a second             → 'snapshot' (data)
//                    room.broadcast(type, data)  must arrive, host hears it too   → 'event' (type, data)
//                    room.sendTo(pid, type, data)
//                    room.fullState = () => obj  sent to newcomers and every 2 s  → 'full' (obj)
//
// The host's own sendInput / sendToHost are delivered locally, so game code is the same on every
// machine. Bots are roster entries with `bot: true`; the host feeds their inputs in with
// room.injectInput(pid, data), through the same 'input' handler the humans use.

const BOT_NAMES = ['Biscuit', 'Pickle', 'Noodle', 'Waffle', 'Sprout', 'Mango', 'Pebble', 'Tater', 'Dumpling', 'Gizmo'];

export function createRoom({
  transport, pid, name = 'Player',
  maxPlayers = 8,
  settleMs = 1600,        // after the first peer shows up, how long to listen for an existing host
  aloneMs = 3500,         // with nobody else around, how long before we host the room ourselves
  holdMs = 30000,         // how long the host keeps a dropped player's seat
  fullEveryMs = 2000,
  now = Date.now,
}) {
  const selfId = transport.selfId;
  const since = now();
  const info = new Map();           // peerId -> { pid, name, since, host } from their latest hello
  const listeners = new Map();
  const banned = new Set();
  const stash = new Map();          // peerId -> { ros, full }: host messages that arrived before we knew the host
  let hostId = null;
  let phase = 'joining';
  let roster = [];
  let lastFull = null;
  let left = false;
  let botSeq = 0;
  let hadHost = false;
  const startedAt = now();
  let firstPeerAt = 0;
  const timers = new Set();

  const room = {
    selfId, since,
    get pid() { return pid; },
    get name() { return name; },
    get isHost() { return hostId === selfId; },
    get hostId() { return hostId; },
    get hostPid() { return roster.find(r => r.peer === hostId)?.pid ?? null; },
    get phase() { return phase; },
    get roster() { return roster; },
    get me() { return roster.find(r => r.pid === pid) || null; },
    get lastFull() { return lastFull; },
    get humans() { return roster.filter(r => !r.bot && r.peer).length; },
    fullState: null,
    holdMs, maxPlayers, replaceBotsAt: 0,
    on(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn); return room; },
    player: p => roster.find(r => r.pid === p) || null,
    peerOf: p => roster.find(r => r.pid === p)?.peer || null,
    pidOf: peer => roster.find(r => r.peer === peer)?.pid || null,

    setName(n) { name = String(n).slice(0, 16) || 'Player'; hello(); if (room.isHost) { const e = room.me; if (e) { e.name = name; pushRoster(); } } },
    setReady(ready) { room.sendToHost('_ready', !!ready); },

    sendInput(data) {
      if (room.isHost) emit('input', pid, data);
      else if (hostId) transport.send('in', data, hostId);
    },
    injectInput(botPid, data) { if (room.isHost) emit('input', botPid, data); },
    sendToHost(type, data) {
      if (room.isHost) defer(() => clientEvent(pid, type, data));
      else if (hostId) transport.send('ev', { t: type, d: data }, hostId);
    },
    sendSnapshot(data) { if (room.isHost) transport.send('st', data, memberPeers()); },
    broadcast(type, data) {
      if (!room.isHost) return;
      transport.send('ev', { t: type, d: data }, memberPeers());
      defer(() => emit('event', type, data));
    },
    sendTo(toPid, type, data) {
      if (!room.isHost) return;
      if (toPid === pid) return defer(() => emit('event', type, data));
      const peer = room.peerOf(toPid);
      if (peer) transport.send('ev', { t: type, d: data }, peer);
    },

    // host only
    addBot(botName) {
      if (!room.isHost || roster.length >= room.maxPlayers) return null;
      const used = new Set(roster.map(r => r.name));
      const nm = botName || BOT_NAMES.find(n => !used.has(n)) || 'Bot ' + (botSeq + 1);
      const entry = { pid: 'bot-' + (++botSeq) + '-' + Math.floor(Math.random() * 1e6).toString(36), name: nm, bot: true, ready: true, peer: null, since: now(), gone: 0 };
      roster.push(entry);
      pushRoster();
      return entry.pid;
    },
    removeBot(botPid) {
      if (!room.isHost) return;
      const i = botPid ? roster.findIndex(r => r.pid === botPid && r.bot) : roster.findLastIndex(r => r.bot);
      if (i >= 0) { roster.splice(i, 1); pushRoster(); }
    },
    fillBots(total) {
      if (!room.isHost) return;
      while (roster.length < Math.min(total, room.maxPlayers)) if (!room.addBot()) break;
    },
    kick(kickPid) {
      if (!room.isHost || kickPid === pid) return;
      const i = roster.findIndex(r => r.pid === kickPid);
      if (i < 0) return;
      const [entry] = roster.splice(i, 1);
      if (!entry.bot) { banned.add(kickPid); if (entry.peer) transport.send('kick', { reason: 'kicked' }, entry.peer); }
      pushRoster();
    },

    leave() {
      if (left) return;
      left = true;
      for (const t of timers) clearTimeout(t), clearInterval(t);
      timers.clear();
      return transport.leave();
    },
    // for tests and the debug overlay
    _debug: () => ({ selfId, hostId, phase, peers: transport.peers(), roster: roster.map(r => ({ ...r })) }),
  };

  function emit(ev, ...args) { for (const fn of listeners.get(ev) || []) fn(...args); }
  function defer(fn) { Promise.resolve().then(() => { if (!left) fn(); }); }
  function after(ms, fn) { const t = setTimeout(() => { timers.delete(t); if (!left) fn(); }, ms); timers.add(t); return t; }
  const older = (a, b) => a.since < b.since || (a.since === b.since && a.id < b.id);
  const memberPeers = () => roster.filter(r => r.peer && r.peer !== selfId).map(r => r.peer);

  // ---- hellos and host election ----

  function hello(to) {
    transport.send('hi', { pid, name, since, host: hostId }, to);
  }

  // Who is host? A peer only counts as host once it says so itself. Among those, the oldest wins
  // (two players who each opened an empty room at the same moment sort themselves out this way).
  // If nobody claims it and the settle time is over, the oldest peer we can see takes it.
  function decide() {
    if (left) return;
    const connected = new Set(transport.peers());
    const claims = [];
    if (hostId === selfId) claims.push({ id: selfId, since });
    for (const [id, i] of info) if (connected.has(id) && i.host === id) claims.push({ id, since: i.since });
    let next = null;
    if (claims.length) {
      next = claims.reduce((a, b) => (older(a, b) ? a : b)).id;
    } else {
      const t = now();
      const hinted = [...info.values()].some(i => i.host && i.host !== selfId);   // someone knows a host we haven't met yet
      const waited = t - startedAt;
      const settled = connected.size === 0
        ? waited >= aloneMs
        : (t - firstPeerAt >= settleMs && [...connected].every(id => info.has(id)) && (!hinted || waited >= 8000)) || t - firstPeerAt >= 8000;
      if (phase === 'joining' && !settled) return;
      const cands = [{ id: selfId, since }];
      for (const id of connected) if (info.has(id)) cands.push({ id, since: info.get(id).since });
      const best = cands.reduce((a, b) => (older(a, b) ? a : b)).id;
      if (best !== selfId) return;          // wait for the oldest to claim it
      next = selfId;
    }
    if (next !== hostId) setHost(next);
  }

  function setHost(next) {
    const wasHost = hostId === selfId;
    const migrated = hadHost;
    const prev = hostId;
    hostId = next;
    hadHost = true;
    phase = 'ready';
    if (next === selfId) {
      // Take over the list we last heard, or start one.
      if (!roster.some(r => r.pid === pid)) roster = [{ pid, name, bot: false, ready: false, peer: selfId, since, gone: 0 }, ...roster];
      const connected = new Set(transport.peers());
      const t = now();
      for (const r of roster) {
        if (r.bot) continue;
        if (r.pid === pid) { r.peer = selfId; r.gone = 0; continue; }
        if (!r.peer || !connected.has(r.peer)) { r.peer = null; r.gone = r.gone || t; scheduleDrop(r.pid); }
      }
      // Anyone connected who said hello but isn't on the list yet.
      for (const id of connected) if (info.has(id)) admit(id, info.get(id), true);
      hello();
      pushRoster();
    } else {
      const s = stash.get(next);
      if (s?.ros) applyRoster(s.ros);
      if (s?.full) { lastFull = s.full; }
      if (wasHost) hello();
      else hello(next);                       // make sure the host has our pid and name
      if (s?.full) defer(() => emit('full', s.full));
    }
    stash.clear();
    emit('host', { isHost: next === selfId, hostId: next, prev, migrated, demoted: wasHost && next !== selfId });
    // Only now: a game restores from room.lastFull in its 'host' handler, and sending our own
    // (still empty) state first would overwrite the very thing it needs.
    if (next === selfId) sendFull();
  }

  // ---- roster (host) ----

  function admit(peer, i, quiet) {
    if (banned.has(i.pid)) { transport.send('kick', { reason: 'kicked' }, peer); return; }
    let entry = roster.find(r => r.pid === i.pid);
    if (entry && entry.peer && entry.peer !== peer && transport.peers().includes(entry.peer)) {
      transport.send('repid', {}, peer);      // a duplicated tab: same pid, both alive
      return;
    }
    const fresh = !entry;
    const rebound = !fresh && entry.peer !== peer;
    if (!entry) {
      // A human takes a bot's seat once the room is as full as it should get: at maxPlayers, or
      // sooner when room.replaceBotsAt is set (public rooms keep to the size the bots filled).
      if (roster.length >= Math.min(room.maxPlayers, room.replaceBotsAt || room.maxPlayers)) {
        const b = roster.findLastIndex(r => r.bot);
        if (b >= 0) { const [bot] = roster.splice(b, 1); emit('botReplaced', bot.pid, i.pid); }
        else if (roster.length >= room.maxPlayers) { transport.send('kick', { reason: 'full' }, peer); return; }
      }
      entry = { pid: i.pid, name: i.name, bot: false, ready: false, peer, since: i.since, gone: 0 };
      roster.push(entry);
    }
    const changed = fresh || entry.peer !== peer || entry.name !== i.name || !!entry.gone;
    entry.peer = peer; entry.name = i.name; entry.gone = 0;
    if (!quiet) {
      if (changed) pushRoster(); else transport.send('ros', roster, peer);
      if (fresh || rebound) {
        const full = room.fullState?.();
        if (full != null) transport.send('full', full, peer);
        emit(fresh ? 'join' : 'rejoin', entry.pid);
      }
    }
  }

  function scheduleDrop(dropPid) {
    after(room.holdMs, () => {
      if (!room.isHost) return;
      const i = roster.findIndex(r => r.pid === dropPid && !r.peer);
      if (i >= 0) { roster.splice(i, 1); pushRoster(); emit('drop', dropPid); }
    });
  }

  function pushRoster() {
    if (!room.isHost) return;
    transport.send('ros', roster, memberPeers());
    emit('roster', roster);
  }
  function applyRoster(list) {
    roster = list.map(r => ({ ...r }));
    emit('roster', roster);
  }
  function sendFull() {
    if (!room.isHost) return;
    const full = room.fullState?.();
    if (full == null) return;
    lastFull = full;
    transport.send('full', full, memberPeers());
  }
  function clientEvent(fromPid, type, data) {
    if (type === '_ready') {
      const e = room.player(fromPid);
      if (e && e.ready !== !!data) { e.ready = !!data; pushRoster(); }
      return;
    }
    emit('clientEvent', fromPid, type, data);
  }

  // ---- wire ----

  transport.on('hi', (d, from) => {
    if (!d || typeof d.pid !== 'string') return;
    info.set(from, { pid: d.pid, name: String(d.name || 'Player').slice(0, 16), since: +d.since || 0, host: d.host || null });
    decide();
    if (room.isHost) admit(from, info.get(from));
  });
  transport.on('ros', (list, from) => {
    if (from === hostId) applyRoster(list);
    else stash.set(from, { ...stash.get(from), ros: list });
  });
  transport.on('full', (full, from) => {
    if (from === hostId) { lastFull = full; emit('full', full); }
    else stash.set(from, { ...stash.get(from), full });
  });
  transport.on('st', (data, from) => { if (from === hostId) emit('snapshot', data); });
  transport.on('in', (data, from) => {
    if (!room.isHost) return;
    const p = room.pidOf(from);
    if (p) emit('input', p, data);
  });
  transport.on('ev', (m, from) => {
    if (!m) return;
    if (room.isHost) { const p = room.pidOf(from); if (p) clientEvent(p, m.t, m.d); }
    else if (from === hostId) emit('event', m.t, m.d);
  });
  transport.on('kick', (d, from) => {
    if (from !== hostId && hostId) return;
    emit('kicked', d?.reason || 'kicked');
    room.leave();
  });
  transport.on('repid', (d, from) => {
    if (from !== hostId) return;
    pid = 'p' + Math.random().toString(36).slice(2, 10);
    emit('repid', pid);
    hello();
  });

  transport.onPeerJoin(id => {
    if (!firstPeerAt) firstPeerAt = now();
    hello(id);
    after(settleMs + 20, decide);
    after(8020, decide);
    emit('peer', id, true);
  });
  transport.onPeerLeave(id => {
    info.delete(id);
    stash.delete(id);
    emit('peer', id, false);
    if (room.isHost) {
      const e = roster.find(r => r.peer === id);
      if (e) { e.peer = null; e.gone = now(); e.ready = false; scheduleDrop(e.pid); pushRoster(); emit('gone', e.pid); }
    }
    if (id === hostId) {
      // The host left. Clear it and let the oldest of us claim the room.
      const prev = hostId;
      hostId = null;
      emit('hostLost', prev);
      decide();
      if (hostId === null) after(60, decide);
      // If the peer who should take it never does (they may not see what we see), take it ourselves.
      after(3000, () => { if (hostId === null) setHost(selfId); });
    } else decide();
  });

  after(aloneMs + 20, decide);
  const fullTimer = setInterval(() => { if (!left) sendFull(); }, fullEveryMs);
  timers.add(fullTimer);

  return room;
}
