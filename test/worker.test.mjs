// The TURN credentials Worker, with Cloudflare's API and KV faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Hub } from '../worker/src/index.js';

// A stand-in for the Durable Object binding: one Hub with a Map for storage.
export const fakeHub = () => {
  const store = new Map();
  const hub = new Hub({ storage: { get: async k => store.get(k), put: async (k, v) => void store.set(k, v), delete: async k => void store.delete(k), list: async () => new Map(store) } });
  return { idFromName: n => n, get: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }), hub, store };
};

const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), m }; };
const env = extra => ({ TURN_KEY_ID: 'kid', TURN_KEY_API_TOKEN: 'secret', ENABLED: 'true', DAILY_LIMIT: '2', ...extra });
const get = (e, origin = 'https://example.com', path = '/ice') => worker.fetch(new Request('https://ice.example' + path, { headers: { Origin: origin } }), e);

test.beforeEach(() => {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /turn\/keys\/kid\/credentials\/generate-ice-servers$/);
    assert.equal(init.headers.Authorization, 'Bearer secret');
    return Response.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' }] });
  };
});

test('hands out servers, without port 53, and counts them', async () => {
  const e = env({ BUDGET: kv() });
  const res = await get(e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://example.com');
  const body = await res.json();
  assert.deepEqual(body.iceServers[0].urls, ['stun:stun.cloudflare.com:3478']);
  assert.deepEqual(body.iceServers[1].urls, ['turn:turn.cloudflare.com:3478?transport=udp']);
  assert.equal(body.iceServers[1].credential, 'c');
  assert.equal(body.used, 1);
});

test('stops at the daily budget', async () => {
  const e = env({ BUDGET: kv() });
  assert.equal((await get(e)).status, 200);
  assert.equal((await get(e)).status, 200);
  assert.equal((await get(e)).status, 429);
});

test('the kill switch, other origins and other paths', async () => {
  assert.equal((await get(env({ ENABLED: 'false' }))).status, 503);
  assert.equal((await get(env(), 'https://evil.example')).status, 403);
  assert.equal((await get(env(), 'http://localhost:8080')).status, 403);
  assert.equal((await get(env({ ALLOW_LOCALHOST: 'true' }), 'http://localhost:8080')).status, 200);
  assert.equal((await get(env(), 'https://example.com', '/nope')).status, 404);
  assert.equal((await get({ ENABLED: 'true' })).status, 503, 'no secrets set');
});

test('a full counter store never hands out uncounted credentials', async () => {
  const store = kv(); store.put = async () => { throw new Error('limit'); };
  assert.equal((await get(env({ BUDGET: store }))).status, 429);
});

test('/status says whether it is on and how much of the budget is used, without handing anything out', async () => {
  const e = env({ BUDGET: kv() });
  await get(e);
  const res = await get(e, 'https://anywhere.example', '/status');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ enabled: body.enabled, configured: body.configured, used: body.used, limit: body.limit }, { enabled: true, configured: true, used: 1, limit: 2 });
  assert.equal((await (await get(env({ ENABLED: 'false' }), '', '/status')).json()).enabled, false);
});

test('one address can only take a few credentials an hour', async () => {
  const e = env({ BUDGET: kv(), HUB: fakeHub(), DAILY_LIMIT: '100', ICE_PER_IP_HOUR: '2' });
  const from = ip => worker.fetch(new Request('https://ice.example/ice', { headers: { Origin: 'https://example.com', 'CF-Connecting-IP': ip } }), e);
  assert.equal((await from('1.1.1.1')).status, 200);
  assert.equal((await from('1.1.1.1')).status, 200);
  assert.equal((await from('1.1.1.1')).status, 429, 'the third from one address is refused');
  assert.equal((await from('2.2.2.2')).status, 200, 'another address is not affected');
  assert.equal(e.BUDGET.m.get([...e.BUDGET.m.keys()][0]), '3', 'a refused request does not use the daily budget');
  // the counter is kept, so the object going to sleep does not reset it
  assert.ok([...e.HUB.store.keys()].some(k => k === 'c:ice:1.1.1.1'));
  e.HUB.hub.counts.clear();
  assert.equal((await from('1.1.1.1')).status, 429);
});

test('quick play: hosts announce public rooms and a player is given the fullest one with a seat', async () => {
  const e = env({ HUB: fakeHub() });
  const call = (method, body, query = '', origin = 'https://example.com') => worker.fetch(new Request('https://ice.example/rooms' + query, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), e);
  const pick = async app => (await (await call('GET', null, '?app=' + app)).json()).code;
  assert.equal(await pick('my-game'), null, 'nothing to join yet');
  assert.equal((await call('POST', { app: 'my-game', code: 'PAAAAA', open: 3, humans: 1 })).status, 200);
  await call('POST', { app: 'my-game', code: 'PBBBBB', open: 1, humans: 4 });
  await call('POST', { app: 'my-game', code: 'PCCCCC', open: 0, humans: 8 });
  await call('POST', { app: 'other-game', code: 'PDDDDD', open: 5, humans: 6 });
  assert.equal(await pick('my-game'), 'PBBBBB', 'the fullest room with a free seat');
  assert.equal(await pick('my-game'), 'PAAAAA', 'that seat is held, so the next player goes elsewhere');
  assert.equal(await pick('other-game'), 'PDDDDD', 'games do not see each other\'s rooms');
  await call('DELETE', { app: 'my-game', code: 'PAAAAA' });
  await call('POST', { app: 'my-game', code: 'PBBBBB', open: 0, humans: 5 });
  assert.equal(await pick('my-game'), null);
  // rooms that stop announcing drop off
  for (const r of e.HUB.hub.rooms.values()) r.at -= 60000;
  assert.equal(await pick('other-game'), null);
  assert.equal((await call('POST', { app: 'my-game', code: 'ABCDE', open: 1, humans: 1 })).status, 400, 'invite codes are never listed');
  assert.equal((await call('POST', { app: 'my-game', code: 'PAAAAA', open: 1, humans: 1 }, '', 'https://evil.example')).status, 403);
  assert.equal((await (await worker.fetch(new Request('https://ice.example/status'), e)).json()).publicRooms, 0);
});
