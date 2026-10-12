// Rooms over the in-process loopback: host election, hand-over, seats, bots and kicks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackHub, withNetsim, parseNetsim } from '../kit/transport.js';
import { createRoom } from '../kit/room.js';
import { createInterp } from '../kit/sync.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const fast = { settleMs: 30, aloneMs: 60, holdMs: 150, fullEveryMs: 40 };
const mk = (hub, name, extra = {}) => createRoom({ transport: hub.join(), pid: 'pid-' + name, name, ...fast, ...extra });

test('first in hosts; later joiners adopt the host and share one roster', async () => {
  const hub = createLoopbackHub();
  const a = mk(hub, 'a');
  await wait(120);
  assert.equal(a.isHost, true);
  const b = mk(hub, 'b'); await wait(40);
  const c = mk(hub, 'c'); await wait(40);
  const d = mk(hub, 'd');
  await wait(150);
  for (const r of [b, c, d]) { assert.equal(r.isHost, false); assert.equal(r.hostPid, 'pid-a'); }
  for (const r of [a, b, c, d]) assert.deepEqual(r.roster.map(x => x.pid), ['pid-a', 'pid-b', 'pid-c', 'pid-d']);
  [a, b, c, d].forEach(r => r.leave());
});

test('four players who arrive together agree on one host', async () => {
  const hub = createLoopbackHub();
  const rooms = ['a', 'b', 'c', 'd'].map(n => mk(hub, n));
  await wait(250);
  assert.equal(rooms.filter(r => r.isHost).length, 1);
  const host = rooms.find(r => r.isHost).pid;
  for (const r of rooms) { assert.equal(r.hostPid, host); assert.equal(r.roster.length, 4); }
  rooms.forEach(r => r.leave());
});

test('host leaves: the oldest remaining player takes over with the last full state', async () => {
  const hub = createLoopbackHub();
  const a = mk(hub, 'a');
  await wait(100);
  let score = 7;
  a.fullState = () => ({ score });
  const b = mk(hub, 'b'); await wait(15);
  const c = mk(hub, 'c'); await wait(15);
  const d = mk(hub, 'd');
  await wait(150);
  a.addBot('Robo');
  await wait(60);
  const hostEvents = [];
  let seenAtHandOver = null;
  b.fullState = () => ({ score: 'not restored yet' });       // what a game returns before it has restored
  b.on('host', e => { hostEvents.push(e); seenAtHandOver = b.lastFull; });
  a.leave();
  await wait(120);
  assert.equal(b.isHost, true, 'b joined first, so b hosts');
  assert.equal(hostEvents.at(-1).migrated, true);
  assert.deepEqual(seenAtHandOver, { score: 7 }, "the new host still has the old host's state when it is told");
  for (const r of [b, c, d]) {
    assert.equal(r.hostPid, 'pid-b');
    assert.equal(r.roster.find(x => x.pid === 'pid-a').peer, null, "the old host's seat is held");
    assert.ok(r.roster.some(x => x.bot), 'bots survive the hand-over');
  }
  await wait(250);
  for (const r of [b, c, d]) assert.ok(!r.roster.some(x => x.pid === 'pid-a'), 'and dropped after the hold');
  [b, c, d].forEach(r => r.leave());
});

test('a reloaded tab gets its seat back by pid', async () => {
  const hub = createLoopbackHub();
  const a = mk(hub, 'a'); await wait(100);
  const b = mk(hub, 'b'); await wait(100);
  const events = [];
  a.on('rejoin', p => events.push(p));
  b.leave();
  await wait(40);
  assert.equal(a.player('pid-b').peer, null);
  const b2 = mk(hub, 'b');
  await wait(120);
  assert.deepEqual(events, ['pid-b']);
  assert.equal(a.roster.length, 2);
  assert.equal(a.player('pid-b').peer, b2.selfId);
  a.leave(); b2.leave();
});

test('messages: inputs, events and snapshots go through the host', async () => {
  const hub = createLoopbackHub();
  const a = mk(hub, 'a'); await wait(100);
  const b = mk(hub, 'b'); await wait(100);
  const got = [];
  a.on('input', (p, d) => got.push(['in', p, d.x]));
  a.on('clientEvent', (p, t, d) => got.push(['ev', p, t, d]));
  b.on('snapshot', d => got.push(['st', d.n]));
  b.on('event', (t, d) => got.push(['b-event', t, d]));
  a.on('event', (t, d) => got.push(['a-event', t, d]));
  b.sendInput({ x: 1 }); a.sendInput({ x: 2 });
  b.sendToHost('tag', 5); a.sendToHost('tag', 6);
  a.sendSnapshot({ n: 9 });
  a.broadcast('boo', 1);
  const bot = a.addBot();
  a.injectInput(bot, { x: 3 });
  await wait(40);
  const has = e => assert.ok(got.some(g => JSON.stringify(g) === JSON.stringify(e)), 'missing ' + JSON.stringify(e));
  has(['in', 'pid-b', 1]); has(['in', 'pid-a', 2]); has(['in', bot, 3]);
  has(['ev', 'pid-b', 'tag', 5]); has(['ev', 'pid-a', 'tag', 6]);
  has(['st', 9]); has(['b-event', 'boo', 1]); has(['a-event', 'boo', 1]);
  a.leave(); b.leave();
});

test('ready, bots, a full room and kick', async () => {
  const hub = createLoopbackHub();
  const a = mk(hub, 'a', { maxPlayers: 4 }); await wait(100);
  const b = mk(hub, 'b'); await wait(80);
  b.setReady(true);
  a.fillBots(4);
  await wait(40);
  assert.equal(b.roster.length, 4);
  assert.equal(b.roster.filter(r => r.bot).length, 2);
  assert.equal(a.player('pid-b').ready, true);
  const c = mk(hub, 'c'); await wait(100);
  assert.equal(a.roster.length, 4, 'a human takes a bot seat');
  assert.equal(a.roster.filter(r => r.bot).length, 1);
  let kicked = null;
  c.on('kicked', r => (kicked = r));
  a.kick('pid-c');
  await wait(40);
  assert.equal(kicked, 'kicked');
  assert.ok(!b.roster.some(r => r.pid === 'pid-c'));
  const c2 = mk(hub, 'c'); let again = null; c2.on('kicked', r => (again = r));
  await wait(100);
  assert.equal(again, 'kicked', 'a kicked player cannot rejoin');
  a.leave(); b.leave();
});

test('netsim delays messages and drops only the unreliable ones', async () => {
  assert.deepEqual(parseNetsim('lat:150,loss:0.05'), { lat: 150, jit: 0, loss: 0.05 });
  assert.equal(parseNetsim(''), null);
  const hub = createLoopbackHub();
  const ta = withNetsim(hub.join(), { lat: 40, jit: 0, loss: 1 });
  const tb = hub.join();
  const got = [];
  tb.on('st', () => got.push('st')); tb.on('ev', d => got.push(d));
  const back = []; ta.on('ev', d => back.push(d));
  ta.send('st', 1); ta.send('ev', 'a'); ta.send('ev', 'b');
  tb.send('ev', 'x');
  await wait(15);
  assert.deepEqual(got, ['a', 'b']);
  assert.deepEqual(back, [], 'still in flight');
  await wait(60);
  assert.deepEqual(back, ['x']);
});

test('interpolation renders between snapshots, slightly in the past', () => {
  const it = createInterp({ delayMs: 100 });
  it.push(1000, { a: { x: 0, yaw: 3.0 } }, 5000);
  it.push(1100, { a: { x: 10, yaw: -3.0 } }, 5100);
  const mid = it.sample('a', 5150);          // host time 1050
  assert.ok(Math.abs(mid.x - 5) < 1e-6);
  assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.2, 'angles take the short way round');
  assert.equal(it.sample('a', 5400).x, 10, 'holds the last one when snapshots stop');
  assert.equal(it.sample('nobody', 5150), null);
});
