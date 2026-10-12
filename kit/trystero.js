// Trystero behind the Transport interface: browsers connect directly over WebRTC, and only the
// introductions go through a relay (public Nostr relays by default; our own WebSocket relay when
// `relay` is set, which is what the tests use).
//
// Trystero connects every peer to every other peer. The kit still talks in a star (clients send to
// the host, the host sends to everyone), and the spare links carry voice and make a host hand-over
// instant, because the next host is already connected to everybody.

export async function createTrysteroTransport({ appId, roomId, relay, iceServers, forceRelay, onJoinError }) {
  // The two strategies are separate bundles; load only the one in use.
  const lib = relay
    ? await import('./vendor/trystero-ws.js')
    : await import('./vendor/trystero-nostr.js');

  const config = { appId };
  if (relay) config.relayConfig = { urls: [].concat(relay) };
  if (iceServers?.length) {
    // Our own list replaces Trystero's default STUN servers, so it must hold STUN and TURN.
    config.rtcConfig = { iceServers };
    if (forceRelay) config.rtcConfig.iceTransportPolicy = 'relay';
  }
  // Headless Chrome in CI has no mDNS, so local candidates never resolve without this.
  if (relay && /^wss?:\/\/(localhost|127\.0\.0\.1)/.test([].concat(relay)[0])) config._test_only_mdnsHostFallbackToLoopback = true;

  const room = lib.joinRoom(config, roomId, { onJoinError: d => onJoinError?.(d) });
  const actions = new Map();
  const action = ch => {
    let a = actions.get(ch);
    if (!a) { a = room.makeAction(ch); actions.set(ch, a); }
    return a;
  };
  const live = new Set();
  let onJoin = () => {}, onLeave = () => {}, onStream = () => {};
  room.onPeerJoin = id => { live.add(id); onJoin(id); };
  room.onPeerLeave = id => { live.delete(id); onLeave(id); };
  room.onPeerStream = (stream, id) => onStream(stream, id);

  return {
    selfId: lib.selfId,
    ready: Promise.resolve(),
    peers: () => [...live],
    send(channel, data, to) {
      const opts = to == null ? undefined : { target: to };
      if (to != null && (Array.isArray(to) ? !to.length : !live.has(to))) return;
      action(channel).send(data, opts).catch(() => {});   // a peer that left mid-send is not an error
    },
    on(channel, fn) { action(channel).onMessage = (data, ctx) => fn(data, ctx.peerId); },
    onPeerJoin(fn) { onJoin = fn; },
    onPeerLeave(fn) { onLeave = fn; },
    addStream(stream, to) { try { room.addStream(stream, to == null ? undefined : { target: to }); } catch {} },
    removeStream(stream) { try { room.removeStream(stream); } catch {} },
    onPeerStream(fn) { onStream = fn; },
    connections: () => room.getPeers(),
    ping: id => room.ping(id),
    leave() { live.clear(); return room.leave(); },
  };
}

// Ask our Cloudflare Worker for short-lived STUN and TURN servers. Any failure (no Worker deployed,
// the kill switch, the daily budget) falls back to public STUN: players who can connect directly
// still do, and only the 10–20% who need a relay are left out.
export const PUBLIC_STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export async function fetchIceServers(url, timeoutMs = 8000) {
  if (!url) return { iceServers: PUBLIC_STUN, turn: false };
  // Be patient and try twice: this runs while the game is still loading, and a player who needs the
  // relay and doesn't get it can't join at all.
  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { error = 'HTTP ' + res.status; break; }          // off, over budget or not allowed: asking again won't help
      const list = [].concat((await res.json()).iceServers || []);
      if (!list.length) { error = 'empty'; break; }
      return { iceServers: list, turn: list.some(s => [].concat(s.urls).some(u => /^turns?:/.test(u))) };
    } catch (err) { error = String(err.message || err); }
  }
  return { iceServers: PUBLIC_STUN, turn: false, error };
}
