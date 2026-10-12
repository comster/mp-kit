// MP Kit: rooms, a host, bots, proximity voice and a lobby for small online games (5–8 friends),
// peer to peer. A game needs this one call:
//
//   const mp = createMultiplayer({ appId: 'my-game', storagePrefix: 'my-game', title: 'My Game',
//                                  minPlayers: 3, maxPlayers: 8, fillTo: 5 })
//   mp.on('room', room => { … })        connected, and somebody is host
//   mp.on('start', () => { … })         the host pressed Start (host only; broadcast your own round start)
//   mp.on('leave', why => { … })        left, kicked, or the room is gone
//   mp.hideLobby() / mp.showLobby('lobby' | 'match')
//   mp.room, mp.voice, mp.track(name, data), mp.matchStart(), mp.matchEnd()
//   mp.public                           true in a Quick play room (strangers: no voice, relay only; see quickplay.js)
//
// Pass quickPlay: true to offer "Quick play" on the first screen.
//
// URL switches (all optional):
//   #r=CODE            the invite link
//   ?relay=ws://…      use our own WebSocket relay for introductions instead of public Nostr relays
//   ?netsim=lat:150,jit:30,loss:0.05    fake lag and packet loss
//   ?bots=4            fill to 4 players with bots as soon as this player hosts
//   ?auto=1&name=Ann   skip the first screen (tests): join the #r room, or create one; ?auto=quick uses Quick play
//   ?hub=<url>         another Worker for relay servers and the public room list (tests run one locally)
//   ?solo=1            straight into a solo room with bots
//   ?turn=force        only connect through the TURN relay (to prove TURN works)
//   ?ice=off           no TURN relay for this visit; ?ice=<url> uses another credentials Worker
//   ?aec=loop          the Chrome echo workaround for voice (see voice.js)

import { createRoom } from './room.js';
import { createSoloTransport, withNetsim, parseNetsim } from './transport.js';
import { createTrysteroTransport, fetchIceServers } from './trystero.js';
import { createVoice } from './voice.js';
import { createLobby, createTalkButton } from './lobby.js';
import { ICE_URL, HUB_URL } from './config.js';
import { isPublicCode, makePublicCode, pickRoom, announceRoom, dropRoom } from './quickplay.js';

export { createRoom } from './room.js';
export { createLoopbackHub, createSoloTransport, withNetsim, parseNetsim, UNRELIABLE } from './transport.js';
export { createInterp, createTicker, createHeartbeat } from './sync.js';
export { createVoice } from './voice.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';     // no 0/O, 1/I/L
export const makeCode = (n = 5, rand = Math.random) => Array.from({ length: n }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]).join('');

export function createMultiplayer(opts) {
  const {
    appId, storagePrefix, title, tagline, howTo,
    minPlayers = 2, maxPlayers = 8, fillTo = maxPlayers,
    voice: wantVoice = true, voiceRange = 14, pttKey = 'KeyV', pttLabel = 'V',
    mount = document.body, canStart = null, quickPlay = false,
  } = opts;
  const params = new URLSearchParams(location.search);
  // The relay Worker only answers the live site, so don't ask from a dev machine or a test.
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const hubUrl = params.get('hub') || (local ? null : HUB_URL);
  const iceUrl = params.get('ice') === 'off' ? null : params.get('ice') || ('iceUrl' in opts ? opts.iceUrl : local ? null : params.get('hub') ? params.get('hub') + '/ice' : ICE_URL);
  const listeners = new Map();
  const emit = (ev, ...a) => { for (const fn of listeners.get(ev) || []) fn(...a); };
  const ls = {
    get(k) { try { return localStorage.getItem(storagePrefix + '.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(storagePrefix + '.' + k, v); } catch {} },
  };
  const track = (name, data) => { try { window.umami?.track(name, data); } catch {} mp.events.push([name, data]); };

  let pid;
  try { pid = sessionStorage.getItem(storagePrefix + '.pid'); } catch {}
  if (!pid) { pid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3); try { sessionStorage.setItem(storagePrefix + '.pid', pid); } catch {} }

  const hashCode = () => (/[#&]r=([A-Za-z0-9]{4,6})/.exec(location.hash)?.[1] || '').toUpperCase();
  let view = 'landing', code = '', error = '', mode = 'lobby', solo = false, joinVia = null, matchAt = 0, matchHumans = 0;
  let room = null, voice = null, transport = null, session = 0, pub = false, startAt = 0;

  const mp = {
    params, events: [], turn: null,          // turn: true once this visit has relay servers, false if it asked and got none
    get room() { return room; },
    get voice() { return voice; },
    get code() { return code; },
    get solo() { return solo; },
    get public() { return pub; },
    get pid() { return room?.pid || pid; },
    on(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn); return mp; },
    track,
    showLobby(m = 'lobby') { mode = m; lobby.show(); },
    hideLobby() { lobby.hide(); },
    get lobbyVisible() { return lobby.visible; },
    inviteLink: () => location.origin + location.pathname + location.search + '#r=' + code,
    matchStart() {
      if (!room) return;
      matchAt = Date.now();
      matchHumans = room.humans;
      if (room.isHost) track('mp_match_start', { humans: room.humans, bots: room.roster.filter(r => r.bot).length });
    },
    matchEnd() {
      if (!matchAt) return;
      if (room?.isHost) track('mp_match_end', { duration_s: Math.round((Date.now() - matchAt) / 1000), humans: Math.max(matchHumans, room.humans) });
      matchAt = 0;
    },
    create: name => connect({ name, create: true }),
    join: (c, name, via = 'code') => connect({ name, code: c, via }),
    playSolo: name => connect({ name, solo: true }),
    // Join a public room with a free seat, or open one if there is none.
    async quickPlay(name) {
      if (!hubUrl) return;
      view = 'connecting'; code = ''; error = ''; lobby.show();
      let found = null;
      try { found = await pickRoom(hubUrl, appId); }
      catch { view = 'landing'; error = "Quick play isn't available right now. Try again in a minute, or create a room."; lobby.render(); return; }
      return connect({ name, code: found || makePublicCode(), via: 'quickplay', create: !found });
    },
    leave: why => leave(why),
  };

  const lobby = createLobby({
    mount, title, tagline, howTo, minPlayers, maxPlayers, fillTo, pttLabel,
    state: () => ({
      view, code, error, mode, solo, room, voice, name: ls.get('name') || params.get('name') || '', linkCode: hashCode(),
      quick: quickPlay && !!hubUrl, public: pub, startIn: pub && room?.isHost && startAt && !matchAt ? Math.max(0, Math.ceil((startAt - Date.now()) / 1000)) : null,
      canStart: !!room && room.roster.length >= minPlayers && (canStart ? canStart(room) === true : true),
      startHint: room && canStart && typeof canStart(room) === 'string' ? canStart(room) : '',
    }),
    actions: {
      create: mp.create, join: mp.join, solo: mp.playSolo, quick: mp.quickPlay,
      leave: () => leave('left'),
      close: () => { lobby.hide(); emit('close'); },
      start: () => emit('start'),
      report: (p, reason) => voice ? voice.report(p, reason) : track('mp_report', { reason }),
      async copyLink() {
        const link = mp.inviteLink();
        try {
          if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title, text: 'Join my room: ' + code, url: link });
          else await navigator.clipboard.writeText(link);
        } catch { prompt('Copy this invite link', link); }
        track('mp_invite_copy');
      },
    },
  });
  let talkBtn = null;

  async function connect({ name, code: joinCode, create, via, solo: wantSolo }) {
    if (room) await leave('switch', true);
    const my = ++session;
    name = (name || 'Player').trim().slice(0, 16) || 'Player';
    ls.set('name', name);
    solo = !!wantSolo; error = '';
    code = solo ? 'SOLO' : (joinCode || makeCode()).toUpperCase();
    joinVia = create && via !== 'quickplay' ? 'create' : via || 'code';
    pub = !solo && isPublicCode(code);
    startAt = 0;
    view = 'connecting'; lobby.show();
    try {
      if (solo) transport = createSoloTransport();
      else {
        history.replaceState(null, '', location.pathname + location.search + '#r=' + code);
        const ice = await fetchIceServers(iceUrl);
        if (my !== session) return;
        mp.turn = iceUrl ? ice.turn : null;
        if (iceUrl && !ice.turn) track('mp_conn_fail', { reason: 'turn_creds' });
        // Strangers only ever connect through the relay, so they never learn each other's address.
        // No relay, no public room. (A dev machine has no relay to use, and is among friends.)
        if (pub && !ice.turn && !local) { view = 'landing'; pub = false; error = "Quick play isn't available right now. Try again in a minute, or create a room."; lobby.render(); return; }
        transport = await createTrysteroTransport({
          appId, roomId: code, relay: params.get('relay') || opts.relay || null,
          iceServers: ice.iceServers, forceRelay: params.get('turn') === 'force' || (pub && ice.turn),
          onJoinError: d => { track('mp_conn_fail', { reason: 'ice' }); error = "Couldn't connect to one of the players. Their network may block direct connections."; lobby.render(); },
        });
        if (my !== session) { transport.leave(); return; }
        transport = withNetsim(transport, parseNetsim(params.get('netsim')));
      }
    } catch (err) {
      if (my !== session) return;
      view = 'landing'; error = 'Could not start: ' + (err.message || err); lobby.render();
      track('mp_conn_fail', { reason: 'signal' });
      return;
    }
    room = createRoom({ transport, pid, name, maxPlayers, ...(solo ? { aloneMs: 0, settleMs: 0 } : {}), ...(opts.roomOptions || {}) });
    if (pub) room.replaceBotsAt = Math.min(fillTo, maxPlayers);
    voice = wantVoice && !solo && !pub ? createVoice({ room, transport, storagePrefix, range: voiceRange, aec: params.get('aec'), onChange: () => lobby.render(), track }) : null;
    if (voice && !talkBtn) talkBtn = createTalkButton({ mount, voice: { setTalking: on => voice?.setTalking(on) } });

    let announced = false;
    room.on('host', e => {
      if (my !== session) return;
      if (!announced) {
        announced = true;
        view = 'room';
        // A room we made that nobody else was in is a create; anything else is a join.
        if (room.isHost && (joinVia === 'create' || create)) track('mp_room_create', pub ? { public: 1 } : undefined);
        else if (!solo) track('mp_room_join', { via: joinVia === 'create' ? 'code' : joinVia });
        const bots = +params.get('bots') || 0;
        if (room.isHost && bots) room.fillBots(Math.min(bots, maxPlayers));
        emit('room', room);
      } else if (e.migrated) track('mp_host_migrate');
      lobby.render();
    });
    room.on('roster', () => lobby.render());
    room.on('join', () => { if (pub && startAt) startAt = Math.max(startAt, Date.now() + 8000); });     // give a newcomer a moment to read
    room.on('repid', p => { pid = p; try { sessionStorage.setItem(storagePrefix + '.pid', p); } catch {} });
    room.on('kicked', why => leave(why === 'full' ? 'full' : 'kicked'));
  }

  async function leave(why = 'left', quiet = false) {
    if (!room) { view = 'landing'; lobby.render(); return; }
    mp.matchEnd();
    session++;
    const r = room;
    if (pub && r.isHost && hubUrl) dropRoom(hubUrl, appId, code);
    voice?.disable();
    pub = false;
    room = null; voice = null; transport = null;
    try { await r.leave(); } catch {}
    view = 'landing'; mode = 'lobby'; solo = false;
    error = why === 'kicked' ? 'The host removed you from that room.' : why === 'full' ? 'That room is full.' : '';
    if (!quiet) {
      history.replaceState(null, '', location.pathname + location.search);
      lobby.show();
      emit('leave', why);
    }
  }

  // Push-to-talk, and the talking rings in the player list.
  addEventListener('keydown', e => { if (e.code === pttKey && !e.repeat && voice?.enabled && !isTyping(e)) voice.setTalking(true); });
  addEventListener('keyup', e => { if (e.code === pttKey && voice?.enabled) voice.setTalking(false); });
  addEventListener('blur', () => voice?.setTalking(false));
  const isTyping = e => /^(INPUT|TEXTAREA)$/.test(e.target?.tagName || '');
  setInterval(() => {
    if (voice?.enabled && lobby.visible) lobby.pulse(p => (p === room.pid ? voice.myLevel() : voice.level(p)));
    talkBtn?.update(!!voice?.enabled && voice.hasMic && voice.canTalk && !lobby.visible && matchMedia('(pointer: coarse)').matches);
  }, 120);
  addEventListener('pagehide', () => { mp.matchEnd(); if (pub && room?.isHost && hubUrl) dropRoom(hubUrl, appId, code); room?.leave(); });

  // A public room runs itself: whoever is host keeps it on the list while it has a free seat, bots
  // hold the empty seats, and the game starts on a countdown because nobody here is in charge.
  let announcedAt = 0;
  setInterval(() => {
    if (!room || !pub || !room.isHost || view !== 'room') return;
    const now = Date.now();
    if (hubUrl && now - announcedAt > 10000) { announcedAt = now; announceRoom(hubUrl, appId, code, room.maxPlayers - room.humans, room.humans); }
    if (matchAt) { startAt = 0; return; }
    room.fillBots(fillTo);
    if (!startAt) startAt = now + (+params.get('startin') || 20) * 1000;
    if (now >= startAt && room.roster.length >= minPlayers && (!canStart || canStart(room) === true)) { startAt = 0; emit('start'); }
    lobby.render();
  }, 500);

  lobby.show();
  // Tests and quick starts skip the first screen.
  if (params.get('solo')) mp.playSolo(params.get('name') || ls.get('name') || 'Player');
  else if (params.get('auto') === 'quick') mp.quickPlay(params.get('name') || 'Player');
  else if (params.get('auto')) hashCode() ? mp.join(hashCode(), params.get('name'), 'link') : mp.create(params.get('name'));

  return mp;
}
