// The connection interface every game talks to. Swap the thing behind it (Trystero today; a Durable
// Object, Colyseus or Steam lobbies later) without touching game code.
//
//   transport = {
//     selfId                      this peer's id (changes on reload)
//     ready                       Promise, resolves when the room is joined (peers may arrive later)
//     peers()                     ids of the peers connected right now
//     send(channel, data, to?)    JSON data to one peer id, a list of ids, or everyone (to omitted)
//     on(channel, fn(data, from)) one handler per channel
//     onPeerJoin(fn(id)) / onPeerLeave(fn(id))
//     addStream(stream, to?) / removeStream(stream) / onPeerStream(fn(stream, id))    voice
//     leave()
//   }
//
// Channels named in UNRELIABLE carry "latest wins" data (inputs and snapshots). A transport may send
// them on an unordered channel, and the netsim shim is allowed to drop them. Everything else must
// arrive, in order.

export const UNRELIABLE = new Set(['in', 'st']);

// ---- loopback: every peer in one process. Used by the tests, and by "play solo with bots". ----

export function createLoopbackHub() {
  const peers = new Map();   // id -> peer
  let n = 0;
  const later = fn => (typeof queueMicrotask === 'function' ? queueMicrotask(fn) : Promise.resolve().then(fn));

  function join(id) {
    id = id || 'p' + (++n).toString(36).padStart(3, '0');
    const handlers = new Map();
    let onJoin = () => {}, onLeave = () => {}, onStream = () => {};
    let alive = true;
    const peer = {
      selfId: id,
      ready: Promise.resolve(),
      peers: () => (alive ? [...peers.keys()].filter(k => k !== id) : []),
      send(channel, data, to) {
        if (!alive) return;
        const json = JSON.stringify(data);            // copy, as a real wire would
        const targets = to == null ? peer.peers() : Array.isArray(to) ? to : [to];
        for (const t of targets) {
          const p = peers.get(t);
          if (p && t !== id) later(() => p._recv(channel, JSON.parse(json), id));
        }
      },
      on(channel, fn) { handlers.set(channel, fn); },
      onPeerJoin(fn) { onJoin = fn; },
      onPeerLeave(fn) { onLeave = fn; },
      addStream() {}, removeStream() {}, onPeerStream(fn) { onStream = fn; },
      leave() {
        if (!alive) return;
        alive = false;
        peers.delete(id);
        for (const p of peers.values()) later(() => p._left(id));
      },
      _recv(channel, data, from) { if (alive) handlers.get(channel)?.(data, from); },
      _joined(other) { if (alive) onJoin(other); },
      _left(other) { if (alive) onLeave(other); },
    };
    for (const p of peers.values()) { later(() => p._joined(id)); const other = p.selfId; later(() => peer._joined(other)); }
    peers.set(id, peer);
    return peer;
  }
  return { join, size: () => peers.size };
}

// A room of one: nobody else can ever join. "Play solo with bots" runs on this.
export function createSoloTransport() {
  return createLoopbackHub().join('solo');
}

// ---- netsim: ?netsim=lat:150,jit:40,loss:0.05 delays every message and drops unreliable ones ----

export function parseNetsim(str) {
  if (!str) return null;
  const o = { lat: 0, jit: 0, loss: 0 };
  for (const part of String(str).split(',')) {
    const [k, v] = part.split(':');
    if (k in o && isFinite(+v)) o[k] = +v;
  }
  return (o.lat || o.jit || o.loss) ? o : null;
}

export function withNetsim(transport, sim, rand = Math.random) {
  if (!sim) return transport;
  const handlers = new Map();
  const wrapped = Object.create(transport);
  wrapped.send = (channel, data, to) => {
    if (UNRELIABLE.has(channel) && rand() < sim.loss) return;
    transport.send(channel, data, to);
  };
  // Delay on receive, so both directions add up to a round trip of 2 × lat. Reliable channels keep
  // their order: each is released no earlier than the one before it.
  let lastReliable = 0;
  wrapped.on = (channel, fn) => {
    handlers.set(channel, fn);
    transport.on(channel, (data, from) => {
      let due = Date.now() + sim.lat + rand() * sim.jit;
      if (!UNRELIABLE.has(channel)) { due = Math.max(due, lastReliable + 1); lastReliable = due; }
      setTimeout(() => handlers.get(channel)?.(data, from), Math.max(0, due - Date.now()));
    });
  };
  return wrapped;
}
