// The demo room: coloured capsules chasing a coin. It is the smallest game that uses every part of
// the kit, and the page the kit's browser test drives.
//
// Who owns what: each client moves its own capsule and tells the host where it is. The host owns
// the rules (the coin and the scores), moves the bots, and sends everyone a snapshot 15 times a second.
import * as THREE from 'three';
import { createMultiplayer, createInterp, createTicker, createHeartbeat } from '../kit/index.js';

const ARENA = { w: 16, d: 10 };
const WALL = { x: 0, z0: -2.5, z1: 2.5 };          // one wall across the middle, to hear voices muffle
const SPEED = 4.2, R = 0.4;
const COLORS = [0xffc857, 0x5bc0eb, 0xff6b6b, 0x9bc53d, 0xc77dff, 0xff9f1c, 0x2ec4b6, 0xf7aef8];
const touch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', touch);

const mp = createMultiplayer({
  appId: 'mp-kit-demo', storagePrefix: 'mp-kit', title: 'MP Kit demo room',
  tagline: 'A test room for our multiplayer kit. Grab the coin before your friends do.',
  howTo: 'Send the invite link to a friend, or fill the room with bots. <b>Move</b> with ' + (touch ? 'a finger: drag where you want to go' : 'WASD or the arrow keys, or drag with the mouse') + '. With voice on, hold <b>' + (touch ? 'the talk button' : 'V') + '</b> to talk: voices fade with distance and muffle behind the wall.',
  minPlayers: 1, maxPlayers: 8, fillTo: 4, quickPlay: true,
});

// ---- state ----
const game = { started: false, coin: { x: 3, z: 0 }, scores: {}, bots: {} };   // host-owned
const me = { x: 0, z: 0 };
const interp = createInterp({ delayMs: 120 });
const players = new Map();     // pid -> { mesh, x, z }
let room = null, lastSnapAt = 0, snapCount = 0, snapRate = 0, seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

mp.on('room', r => {
  room = r;
  me.x = (Math.random() - 0.5) * 6; me.z = (Math.random() - 0.5) * 6;
  room.fullState = () => ({ started: game.started, coin: game.coin, scores: game.scores });
  room.on('full', restore);
  room.on('host', e => { if (e.isHost && e.migrated && room.lastFull) restore(room.lastFull); });
  room.on('input', (pid, d) => { const p = pos(pid); p.x = d.x; p.z = d.z; });
  room.on('snapshot', s => {
    interp.push(s.t, s.p, performance.now());
    game.coin = s.c; game.scores = s.s;
    snapCount++; lastSnapAt = performance.now();
  });
  room.on('event', (type, d) => {
    if (type === 'start') begin();
    if (type === 'coin') ping(d.x, d.z, d.by);
  });
  room.on('roster', () => { if (room.isHost) for (const p of room.roster) game.scores[p.pid] ??= 0; });
});
mp.on('start', () => { mp.matchStart(); room.broadcast('start', {}); });
mp.on('leave', () => { room = null; game.started = false; document.getElementById('hud').hidden = true; for (const p of players.values()) scene.remove(p.mesh); players.clear(); interp.reset(); });

function restore(full) {
  game.coin = full.coin; game.scores = { ...full.scores };
  if (full.started && !game.started) begin();
}
function begin() {
  game.started = true;
  mp.hideLobby();
  document.getElementById('hud').hidden = false;
  window.umami?.track('play');
  mp.voice?.setSpatial(true);
}
const hostPos = new Map();
const pos = pid => hostPos.get(pid) || hostPos.set(pid, { x: 0, z: 0 }).get(pid);

// ---- the host's rules ----
function hostStep(dt) {
  const mine = pos(room.pid); mine.x = me.x; mine.z = me.z;
  for (const p of room.roster) {
    if (!p.bot) continue;
    const b = pos(p.pid), brain = (game.bots[p.pid] ??= { tx: 0, tz: 0, t: 0 });
    brain.t -= dt;
    if (brain.t <= 0) { brain.t = 0.6 + rnd() * 1.2; const chase = rnd() < 0.7; brain.tx = chase ? game.coin.x : (rnd() - 0.5) * ARENA.w; brain.tz = chase ? game.coin.z : (rnd() - 0.5) * ARENA.d; }
    const next = move(b, brain.tx - b.x, brain.tz - b.z, SPEED * 0.75, dt);
    room.injectInput(p.pid, next);       // bots use the same door as humans
  }
  for (const p of room.roster) {
    const q = pos(p.pid);
    if (Math.hypot(q.x - game.coin.x, q.z - game.coin.z) < R + 0.45) {
      game.scores[p.pid] = (game.scores[p.pid] || 0) + 1;
      room.broadcast('coin', { x: game.coin.x, z: game.coin.z, by: p.pid });
      game.coin = { x: (rnd() - 0.5) * (ARENA.w - 2), z: (rnd() - 0.5) * (ARENA.d - 2) };
      if (Math.abs(game.coin.x) < 0.8) game.coin.x += 1.6;
    }
  }
}
const sendSnapshot = createTicker(15, () => {
  const p = {};
  for (const r of room.roster) { const q = pos(r.pid); p[r.pid] = { x: +q.x.toFixed(2), z: +q.z.toFixed(2) }; }
  const snap = { t: Math.round(performance.now()), p, c: game.coin, s: game.scores };
  room.sendSnapshot(snap);
  interp.push(snap.t, p, performance.now());   // the host draws from the same buffer as everyone else
});
const sendInput = createTicker(15, () => room.sendInput({ x: +me.x.toFixed(2), z: +me.z.toFixed(2) }));

function move(p, dx, dz, speed, dt) {
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return { x: p.x, z: p.z };
  let nx = p.x + (dx / len) * speed * dt, nz = p.z + (dz / len) * speed * dt;
  nx = Math.max(-ARENA.w / 2 + R, Math.min(ARENA.w / 2 - R, nx));
  nz = Math.max(-ARENA.d / 2 + R, Math.min(ARENA.d / 2 - R, nz));
  if (nz > WALL.z0 - R && nz < WALL.z1 + R && Math.abs(nx - WALL.x) < R + 0.15) {
    if (p.z <= WALL.z0 - R || p.z >= WALL.z1 + R) nz = p.z; else nx = p.x;
  }
  return { x: nx, z: nz };
}
const wallBetween = (a, b) => {
  if ((a.x - WALL.x) * (b.x - WALL.x) >= 0) return false;
  const t = (WALL.x - a.x) / (b.x - a.x), z = a.z + (b.z - a.z) * t;
  return z > WALL.z0 && z < WALL.z1;
};

// ---- input ----
const keys = new Set();
let drag = null;
addEventListener('keydown', e => { keys.add(e.code); if (e.code === 'Escape' && room && game.started) mp.lobbyVisible ? mp.hideLobby() : mp.showLobby('match'); });
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const canvas = document.getElementById('game');
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); drag = toWorld(e); });
canvas.addEventListener('pointermove', e => { if (drag) drag = toWorld(e); });
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => (drag = null));
document.getElementById('players').addEventListener('click', () => mp.showLobby('match'));

// ---- drawing ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10131c);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a1c28, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(4, 10, 6); scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.w, ARENA.d), new THREE.MeshStandardMaterial({ color: 0x252a3d, roughness: 1 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new THREE.GridHelper(ARENA.w, ARENA.w, 0x39405c, 0x2c3248); grid.scale.z = ARENA.d / ARENA.w; grid.position.y = 0.01; scene.add(grid);
const wall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, WALL.z1 - WALL.z0), new THREE.MeshStandardMaterial({ color: 0x4a5275, roughness: 0.9 }));
wall.position.set(WALL.x, 0.6, 0); scene.add(wall);
const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 20), new THREE.MeshStandardMaterial({ color: 0xffc857, emissive: 0x7a5a10, metalness: 0.6, roughness: 0.3 }));
coin.rotation.x = Math.PI / 2; scene.add(coin);
const rings = [];
const capGeo = new THREE.CapsuleGeometry(R, 0.6, 4, 12);
const ringGeo = new THREE.RingGeometry(0.5, 0.62, 28);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Pull back until the whole arena fits, upright phone or wide desktop.
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = Math.max((ARENA.d / 2 + 1.5) / Math.tan(vfov / 2), (ARENA.w / 2 + 1) / Math.tan(hfov / 2));
  camera.position.set(0, dist * 0.9, dist * 0.45);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const ray = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
function toWorld(e) {
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  return ray.ray.intersectPlane(ground, hit) ? { x: hit.x, z: hit.z } : null;
}
function ping(x, z, by) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: colorOf(by), transparent: true, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, 0.05, z); scene.add(m); rings.push({ m, t: 0 });
}
const colorOf = pid => COLORS[Math.max(0, room?.roster.findIndex(r => r.pid === pid) ?? 0) % COLORS.length];

function step(dt) {
  if (!room || !game.started) return;
  let dx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  let dz = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
  if (!dx && !dz && drag) { dx = drag.x - me.x; dz = drag.z - me.z; if (Math.hypot(dx, dz) < 0.15) dx = dz = 0; }
  Object.assign(me, move(me, dx, dz, SPEED, dt));
  sendInput(dt * 1000);
  if (room.isHost) { hostStep(dt); sendSnapshot(dt * 1000); }
}

function draw(dt, now) {
  if (room && game.started) {
    const seen = new Set();
    room.roster.forEach((r, i) => {
      seen.add(r.pid);
      let p = players.get(r.pid);
      if (!p) {
        p = { mesh: new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ color: COLORS[i % COLORS.length], roughness: 0.6 })), x: 0, z: 0 };
        scene.add(p.mesh); players.set(r.pid, p);
      }
      p.mesh.material.color.setHex(COLORS[i % COLORS.length]);
      const s = r.pid === room.pid ? me : interp.sample(r.pid, now);
      if (s) { p.x = s.x; p.z = s.z; }
      p.mesh.position.set(p.x, 0.7, p.z);
      p.mesh.visible = !!s;
      p.mesh.material.opacity = r.bot || r.peer ? 1 : 0.35; p.mesh.material.transparent = !(r.bot || r.peer);
    });
    for (const [pid, p] of players) if (!seen.has(pid)) { scene.remove(p.mesh); players.delete(pid); }
    coin.position.set(game.coin.x, 0.5 + Math.sin(now / 300) * 0.08, game.coin.z); coin.rotation.z += dt * 2;
    if (mp.voice?.enabled) {
      const world = {};
      for (const [pid, p] of players) if (pid !== room.pid) world[pid] = { x: p.x, y: 1, z: p.z, muffle: wallBetween(me, p) ? 0.8 : 0, gain: 1 };
      mp.voice.update({ x: me.x, y: 1, z: me.z, fx: 0, fy: 0, fz: -1 }, world);
    }
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt; r.m.scale.setScalar(1 + r.t * 4); r.m.material.opacity = 1 - r.t / 0.6;
    if (r.t > 0.6) { scene.remove(r.m); rings.splice(i, 1); }
  }
  if (!thin || ++frames % 20 === 0) renderer.render(scene, camera);
}

// ?thin=1 draws one frame in twenty: four software-rendered pages starve a small CI machine.
const thin = !!mp.params.get('thin');
let frames = 0;
let hudAt = 0;
function hud(now) {
  if (!room || now - hudAt < 250) return;
  hudAt = now;
  const el = document.getElementById('scores');
  el.replaceChildren(...room.roster.map((r, i) => {
    const row = document.createElement('div'), dot = document.createElement('i');
    dot.style.background = '#' + COLORS[i % COLORS.length].toString(16).padStart(6, '0');
    row.append(dot, `${r.name}${r.pid === room.pid ? ' (you)' : ''}: ${game.scores[r.pid] || 0}`);
    return row;
  }));
  document.getElementById('net').textContent = `${room.isHost ? 'you are the host' : 'host: ' + (room.player(room.hostPid)?.name || '…')}\n${room.humans} players, ${room.roster.filter(r => r.bot).length} bots${room.isHost ? '' : '\n' + snapRate + ' snapshots/s'}${mp.params.get('netsim') ? '\nnetsim ' + mp.params.get('netsim') : ''}${mp.turn === null ? '' : mp.turn ? '\nrelay ready' + (mp.params.get('turn') === 'force' ? ' (forced)' : '') : '\nno relay'}`;
  document.getElementById('hint').textContent = touch ? 'Drag to move' : 'WASD or arrows to move · Esc for players';
}
setInterval(() => { snapRate = snapCount; snapCount = 0; }, 1000);

// The game steps from a heartbeat that survives a hidden tab (a hidden host would freeze everyone);
// drawing stays on requestAnimationFrame.
createHeartbeat(60, step);
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  draw(dt, now); hud(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// For tests and agents: read the room, and run the game without waiting on frames.
window.__mp = {
  mp, game, me,
  get room() { return room; },
  state: () => room && ({ host: room.isHost, hostPid: room.hostPid, pid: room.pid, phase: room.phase, roster: room.roster.map(r => ({ pid: r.pid, name: r.name, bot: r.bot, here: r.bot || !!r.peer })), started: game.started, scores: { ...game.scores }, me: { ...me }, seen: [...players.keys()].filter(p => players.get(p).mesh.visible).length, snapAgeMs: Math.round(performance.now() - lastSnapAt), turn: mp.turn, voicePeers: mp.voice ? mp.voice._peers.size : 0, voiceOn: !!mp.voice?.enabled, events: mp.events.map(e => e[0]) }),
  advance(seconds) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) step(1 / 60); draw(0, performance.now()); },
  walk(dx, dz) { drag = { x: me.x + dx, z: me.z + dz }; },
};
