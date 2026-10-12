# MP Kit

A starter kit for small online games: 5–8 friends in a room, an invite link, no accounts, proximity voice.
Players' browsers connect straight to each other (WebRTC), so there is no game server to run or pay for.

It was built for the small browser games at [wefav.com](https://wefav.com/), where a hide-and-seek game with
proximity voice is the first to use it. It is a prototype: the automated tests pass, but see "Not done yet".
MIT licensed.

**Try it:** `npm install`, `npm run serve`, then open http://localhost:8080/ in two tabs.

## What's in it

| Part | File | What it does |
|---|---|---|
| Connection | `kit/transport.js`, `kit/trystero.js` | One small `Transport` interface. Behind it: [Trystero](https://github.com/dmotz/trystero) 0.26.0 (WebRTC), an in-process loopback (tests, and "try it alone with bots"), and a `?netsim=` shim for lag and packet loss. |
| Rooms and the host | `kit/room.js` | The roster, host election, hand-over when the host leaves, seats kept for a reload, kick, ready, and bots as virtual players. |
| Smooth movement | `kit/sync.js` | Snapshot interpolation, a fixed-rate ticker, and a heartbeat that keeps a hidden host tab running. |
| Voice | `kit/voice.js` | Opt-in proximity voice on the same connections: distance fade, wall muffling, push-to-talk, mute, the age question, report. |
| Lobby | `kit/lobby.js` | Name, create or join by link or code, the player list, "Fill with bots", Start, and the in-match Players panel. |
| Everything together | `kit/index.js` | `createMultiplayer()`: the one call a game makes. Also the `mp_*` analytics events. |
| The Worker | `worker/`, `kit/config.js` | One Cloudflare Worker (Free plan): relay credentials for the players who can't connect directly, and the public room list. Optional, and off until you deploy your own: see below. |
| Quick play | `kit/quickplay.js` | Public rooms for playing with strangers: no voice, relay only, bots and a countdown. |
| Demo | `index.html`, `demo/` | Capsules chasing a coin. The smallest game that uses every part. |

No build step: `kit/` is plain ES modules. Trystero is bundled once into `kit/vendor/` (`npm run vendor`), so a
game loads nothing from a CDN for its networking.

## Use it in a game

1. Copy the kit in: with this repo checked out next to the game's, `sh ../mp-kit/tools/sync-kit.sh .` copies `kit/` to `src/kit/` and writes
   the kit commit to `src/kit/VERSION`. Run it again to update. Ship `src/kit/` in `dist/`.
2. One call:

```js
import { createMultiplayer, createInterp, createTicker, createHeartbeat } from './kit/index.js';

const mp = createMultiplayer({
  appId: 'my-game',                  // unique per game: rooms are namespaced by it
  storagePrefix: 'my-game',          // localStorage keys: my-game.name, my-game.voiceAge …
  title: 'My Game', tagline: '…', howTo: 'One paragraph of <b>HTML</b> for the first screen.',
  minPlayers: 3, maxPlayers: 8, fillTo: 5,
});
mp.on('room', room => { /* connected: wire up the handlers below */ });
mp.on('start', () => room.broadcast('start', {}));   // the host pressed Start
mp.on('leave', why => { /* back on the first screen */ });
```

3. Decide who owns what. The pattern the demo uses:

| Who | Owns | Sends |
|---|---|---|
| Each client | Its own movement (no lag on your own avatar) | `room.sendInput({ x, z, … })` about 15 times a second; `room.sendToHost('tag', …)` for actions that must arrive |
| The host | The rules: scores, timers, who's caught, the bots | `room.sendSnapshot({ t, players, … })` 15 times a second; `room.broadcast('event', …)` for things that must arrive; `room.fullState = () => everything` for newcomers and the next host |

```js
room.on('input', (pid, data) => { … });               // host: from humans and bots alike
room.on('clientEvent', (pid, type, data) => { … });   // host
room.on('snapshot', snap => interp.push(snap.t, snap.players, performance.now()));
room.on('event', (type, data) => { … });              // everyone, the host included
room.on('full', state => restore(state));             // newcomers
room.on('host', e => { if (e.isHost && e.migrated) restore(room.lastFull); });   // you are the new host
```

The host's own `sendInput` and `sendToHost` are delivered locally, so the same code runs on every machine.
Players are keyed by `pid`, which survives a reload (sessionStorage); `room.roster` is the list.

**Bots** are roster entries with `bot: true`. The host runs their brains and calls `room.injectInput(pid, data)`,
so the rules can't tell a bot from a human. One person can test a six-player game alone.

**Run the host's rules from `createHeartbeat`,** not `requestAnimationFrame`: a host who switches tabs would
otherwise freeze the game for everyone.

**Voice** in the world: call `mp.voice.setSpatial(true)` when the match starts, then every frame
`mp.voice.update(listener, { [pid]: { x, y, z, muffle, gain } })`. `muffle` is 0 (clear) to 1 (through walls);
the game decides it, usually by counting walls between the two players. `mp.voice.setCanTalk(false)` gives a
role no voice. `mp.voice.myLevel()` says how loud this player is talking right now.

## URL switches

| Switch | What it does |
|---|---|
| `#r=CODE` | The invite link. |
| `?solo=1` | Straight into a solo room (no network). |
| `?bots=4` | Fill to 4 players with bots as soon as this player hosts. |
| `?auto=1&name=Ann` | Skip the first screen: join the `#r` room or create one. |
| `?netsim=lat:150,jit:30,loss:0.05` | Add lag (ms each way), jitter, and loss on the unreliable channels. Browser throttling doesn't touch WebRTC, so this is how to feel a bad connection. |
| `?relay=ws://host:port` | Use our own WebSocket relay for introductions instead of the public Nostr relays. |
| `?turn=force` | Connect only through TURN, to prove the relay works. |
| `?ice=off` | No TURN relay for this visit. |
| `?auto=quick` | Skip the first screen and use Quick play. |
| `?hub=http://localhost:8787` | Use a local copy of the Worker (`node tools/hub-dev.mjs`) for the public room list. |
| `?startin=6` | Seconds before a public room starts by itself (default 20). |
| `?aec=loop` | The Chrome echo workaround for voice (to be tested, see below). |

## Tests

```sh
npm install
npm test                 # rooms, hand-over, seats, bots, kick, netsim, interpolation, the TURN Worker (no browser)
npm run test:browser     # four real browsers over WebRTC: join by link, voice, start, move, kill the host
PW_CHANNEL=chrome npm run test:browser     # with the installed Chrome instead of Playwright's Chromium
node test/nostr-check.mjs                  # the default path, over public Nostr relays (not in CI)
```

The browser test opens four isolated contexts (one at phone size), with Chrome's fake microphone, and our own
relay (`createWsRelayServer`) so it needs nothing outside the machine. It checks that all four see each other
within 10 s, that voice reaches only players who opted in, that the match starts and snapshots flow, and that
killing the host hands the room to the oldest remaining player within 5 s. Screenshots land in `test/shots/`.
The browser test wants a few GB of free memory: it runs four browsers at once.

## What it costs

- **Without the Worker: $0.** The page is static, introductions go through public Nostr relays, and game data
  and voice go peer to peer. Players whose network blocks direct connections (about 1 in 6) can't join.
- **With the Worker:** the Worker fits Cloudflare's Free plan, which fails instead of billing at its limit.
  Relayed traffic is free for the first 1,000 GB a month, then $0.05/GB (Cloudflare's prices in October 2026;
  check them). Cloudflare has no hard cap on relay traffic, so the Worker's own limits are the budget.

**Analytics events.** If the page has [Umami](https://umami.is/) loaded (`window.umami`), the kit sends:
`mp_room_create` (`public: 1` for a Quick play room), `mp_room_join` (`via`: `link`, `code` or `quickplay`),
`mp_match_start` (`humans`, `bots`), `mp_match_end` (`duration_s`, `humans`), `mp_host_migrate`,
`mp_conn_fail` (`reason`: `ice`, `signal`, `turn_creds`), `mp_voice_on` (`mic`), `mp_invite_copy`, `mp_report`
(`reason`). A game calls `mp.matchStart()` and `mp.matchEnd()`; the rest is automatic. Without Umami nothing is
sent; the events are still kept in `mp.events`. To use something else, change `track` in `kit/index.js`.

## The Worker (optional)

About 1 player in 6 is on a network that blocks direct connections. They can connect through Cloudflare's TURN
relay instead, and this Worker hands their browser the short-lived credentials for it. Everyone else never
touches it. It also keeps the list of public rooms for Quick play. `kit/config.js` ships with no Worker address,
so until you deploy your own the kit runs without one.

**Deploy your own** (a Cloudflare account, and [wrangler](https://developers.cloudflare.com/workers/wrangler/)):

```sh
cd worker
# 1. Cloudflare dashboard → Realtime → TURN → create a key. Note the Key ID and the API token (shown once).
# 2. In wrangler.toml, set ALLOWED_ORIGINS to the site your games are served from.
wrangler kv namespace create BUDGET       # 3. put the id it prints in wrangler.toml
wrangler deploy
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_KEY_API_TOKEN
```

Then put the Worker's address in `kit/config.js` (`HUB_URL`) and sync the kit into each game. A wrangler API
token needs Workers Scripts, Workers KV Storage and Realtime (Calls), all at edit level. Keep the TURN key and
any API token out of the repo: they belong in `wrangler secret` and nowhere else.

| | |
|---|---|
| **Is it on?** | `curl <your Worker>/status` → `{"enabled":true,"configured":true,"used":12,"limit":500,"perAddressPerHour":20,"publicRooms":0}` |
| **Who may ask** | Pages on `ALLOWED_ORIGINS` only. This keeps other *websites* out. It does not stop a script that lies about where it comes from, which is what the two limits below are for. A page on `localhost` never uses the Worker unless you pass `?hub=`. |
| **The caps** | `DAILY_LIMIT` = 500 credentials a day (one per player per room joined), and `ICE_PER_IP_HOUR` = 20 from any one address in an hour, so one person can't take the day's share. Past either the Worker answers 429 and that player connects directly or not at all. A credential lasts 4 hours and its holder can relay anything through it. |
| **Cost** | A relayed player uses roughly 0.2 GB an hour with voice (our estimate), so the free 1,000 GB is about 5,000 relayed player-hours a month. Set a billing alert on the account as a backstop. |

**Switch it off:** set `ENABLED = "false"` in `worker/wrangler.toml` and deploy, or `wrangler delete`. Players
already connected carry on; new ones connect directly or not at all. To stop games asking at all, set `HUB_URL`
to `null` in `kit/config.js` and sync the kit into each game.

**Prove the relay works:** open a game on your site with `?turn=force` in two browsers; they may then only
connect through the relay. `node test/turn-check.mjs <url of your demo room>` does it for you and reports the
kind of connection it got.

## Quick play (public rooms)

Pass `quickPlay: true` to `createMultiplayer()` and the first screen offers **Quick play with anyone**. The player
is sent to a public room with a free seat, or opens one if there is none. The Worker keeps the list (`/rooms`):
whoever is host announces the room every 10 seconds, and a room that stops announcing drops off after 35.

A public room is not an invite room, and the kit enforces the difference:

| | Invite room | Public room |
|---|---|---|
| Code | 5 characters | `P` + 5 characters, so everyone in it knows which kind it is |
| Voice chat | Opt-in | **None.** `mp.voice` is `null`. |
| Connections | Direct where possible | **Relay only**, so strangers never see each other's IP address. No relay, no public room. |
| Empty seats | "Fill with bots" if the host likes | Bots fill to `fillTo`, and give up a seat for each person who joins |
| Starting | The host presses Start | By itself on a 20-second countdown (the host may start sooner) |
| Kick | The host can | Nobody can: the host is just whoever got there first. Report still works. |

`mp.public` is `true` in a public room. A game should be stricter there than among friends, for example by
checking movement speed on the host. Someone who arrives mid-match is the game's to place
(`room.on('join')`).

**Cost:** every public player is relayed and needs a credential, so Quick play draws on the daily cap and on the
1,000 free GB. Without voice a relayed player moves far less (game data only, perhaps 0.05 GB an hour, our
estimate). Switch Quick play off without touching the relay: `QUICKPLAY = "false"` in `worker/wrangler.toml`, or
leave `quickPlay` out of the game.

**Try it locally:** `node tools/hub-dev.mjs`, then open two tabs with `?hub=http://localhost:8787`.

## Voice safety (the minimum, built in)

- Off until the player turns it on; a neutral age question first, and under-13s get no voice.
- Push-to-talk by default. "Open mic" is a switch, labelled headphones only.
- Mute per player, mute all; the host can kick. A kicked player can't rejoin and is no longer heard.
- Report sends the reason as an analytics event and mutes that player. It never records audio.
- Voice only exists inside invite rooms. Public rooms (Quick play) have none.

This is a prototype minimum, not legal advice. Check the rules of anywhere you publish before shipping voice.

## Not done yet

- **The echo test** (Chrome on laptop speakers, with and without `?aec=loop`, and a real iPhone). Needs real
  devices and ears. Until then push-to-talk is the default.
- **Played by people.** Everything here is proven by automated tests with real browsers. It has not yet had
  a play night with a full room of humans.
- **Introductions** go through public Nostr relays (Trystero's default). Fine for a test with friends; pin a
  relay we control before anything public (`relay` option, `createWsRelayServer` on a $2 machine).
- **Everything rides one reliable channel.** Trystero has no unreliable channel, so a lost packet delays the
  ones behind it. Invisible on good connections at 15 Hz; `?netsim=` shows what a bad one feels like.
- **Movement is trusted.** Clients report their own position. Fine among friends; a public game needs the host
  to check speeds.
- **Public rooms trust their host.** Whoever opened the room runs the rules in their browser, and could cheat.
  The room list can be fed fake rooms by someone who scripts it; they'd lead nowhere.

## Code map

```
kit/            the kit (copy this into a game)
  index.js        createMultiplayer(): URL switches, identity, lobby, metrics
  room.js         roster, host election and hand-over, messages, bots, kick
  config.js       the Worker's address (none by default)
  quickplay.js    public rooms: the list, and what makes a room public
  transport.js    the Transport interface, loopback, netsim
  trystero.js     Trystero adapter, ICE server fetch
  sync.js         interpolation, ticker, heartbeat
  voice.js        proximity voice
  lobby.js        lobby and Players panel (DOM + its CSS)
  vendor/         Trystero bundles (MIT), built by tools/vendor.sh
demo/           the demo room (main.js, style.css)
worker/         the Worker: TURN credentials and the public room list
test/           room.test.mjs, worker.test.mjs (node), browser.mjs (Playwright), nostr-check.mjs
tools/          serve.mjs, hub-dev.mjs (the Worker, locally), build.sh, vendor.sh, sync-kit.sh
```

Built with [three.js](https://threejs.org/) (demo) and [Trystero](https://github.com/dmotz/trystero) (MIT).
