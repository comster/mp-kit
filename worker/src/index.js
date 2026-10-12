// The kit's one small service, a Cloudflare Worker on the Free plan. It does two jobs:
//
//   GET /ice      hands a player's browser short-lived STUN and TURN servers. About 1 player in 6 can't
//                 connect directly and needs Cloudflare's TURN relay; everyone else never touches it.
//   /rooms        the list of public rooms with a free seat, for "Quick play". Hosts announce their
//                 room every few seconds; a player looking for a game is given one.
//   GET /status   is it on, and how much of today's budget is used. Hands out nothing.
//
// It is also the spend cap and the kill switch for the relay:
//   - The Free plan fails with an error at its request limit instead of billing.
//   - DAILY_LIMIT caps how many credentials go out per day (TURN traffic itself has no hard cap on
//     Cloudflare's side, so we budget by counting credentials), and ICE_PER_IP_HOUR stops one address
//     taking the whole day's share.
//   - ENABLED = "false" (or deleting the Worker) stops new relayed connections at once. Players who
//     connect directly carry on.
//
// Only pages on ALLOWED_ORIGINS may ask. That keeps other websites out; it does not stop a script
// that lies about where it comes from, which is what the two limits above are for.
// Setup and deploy: ../README.md

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
const ROOM_TTL_MS = 35000;          // a room that stops announcing drops off the list
const APP = /^[a-z0-9-]{3,40}$/;
const CODE = /^P[A-Z0-9]{5}$/;      // public room codes: P plus five; invite codes are five

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://example.com').split(',').map(s => s.trim());
    const okOrigin = allowed.includes(origin) || (env.ALLOW_LOCALHOST === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0], 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const hub = env.HUB ? env.HUB.get(env.HUB.idFromName('hub')) : null;
    const ask = async (path, body) => (await hub.fetch('https://hub' + path, { method: 'POST', body: JSON.stringify(body) })).json();

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });

    if (request.method === 'GET' && url.pathname === '/status') {
      const day = new Date().toISOString().slice(0, 10);
      const used = env.BUDGET ? +(await env.BUDGET.get('ice:' + day)) || 0 : null;
      const rooms = hub ? (await ask('/count', {})).rooms : null;
      return new Response(JSON.stringify({ enabled: env.ENABLED !== 'false', configured: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN), day, used, limit: +(env.DAILY_LIMIT || 500), perAddressPerHour: +(env.ICE_PER_IP_HOUR || 20), publicRooms: rooms }),
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/rooms') {
      if (!okOrigin) return json({ error: 'origin not allowed' }, 403);
      if (!hub) return json({ error: 'not configured' }, 503);
      if (env.QUICKPLAY === 'false') return json({ error: 'off' }, 503);
      // A host announces every 10 seconds and a player asks now and then; 40 a minute is plenty for one address.
      if (!(await ask('/take', { key: 'rooms:' + ip, max: 40, windowMs: 60000, keep: false })).ok) return json({ error: 'slow down' }, 429);
      if (request.method === 'GET') {
        const app = url.searchParams.get('app') || '';
        if (!APP.test(app)) return json({ error: 'bad app' }, 400);
        return json(await ask('/pick', { app }));
      }
      let body = null;
      try { body = await request.json(); } catch {}
      if (!body || !APP.test(body.app || '') || !CODE.test(body.code || '')) return json({ error: 'bad room' }, 400);
      if (request.method === 'DELETE') return json(await ask('/drop', { app: body.app, code: body.code }));
      if (request.method === 'POST') return json(await ask('/announce', { app: body.app, code: body.code, open: Math.max(0, Math.min(16, body.open | 0)), humans: Math.max(0, Math.min(16, body.humans | 0)) }));
      return json({ error: 'not found' }, 404);
    }

    if (request.method !== 'GET' || url.pathname !== '/ice') return json({ error: 'not found' }, 404);
    if (!okOrigin) return json({ error: 'origin not allowed' }, 403);
    if (env.ENABLED === 'false') return json({ error: 'off' }, 503);
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'not configured' }, 503);

    // One address may only take a few an hour, so one person can't use up the day for everyone.
    if (hub) {
      const perIp = +(env.ICE_PER_IP_HOUR || 20);
      if (!(await ask('/take', { key: 'ice:' + ip, max: perIp, windowMs: 3600000, keep: true })).ok) return json({ error: 'too many from this address', perHour: perIp }, 429);
    }
    // The daily budget. Without the KV binding there is no count, only the Free plan's own limit.
    const limit = +(env.DAILY_LIMIT || 500);
    const key = 'ice:' + new Date().toISOString().slice(0, 10);
    let used = 0;
    if (env.BUDGET) {
      used = +(await env.BUDGET.get(key)) || 0;
      if (used >= limit) return json({ error: 'daily budget used', used, limit }, 429);
    }

    const res = await fetch(API + env.TURN_KEY_ID + '/credentials/generate-ice-servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: +(env.TTL_SECONDS || 14400) }),      // 4 hours: longer than a play night's session
    });
    if (!res.ok) return json({ error: 'turn api ' + res.status }, 502);
    const body = await res.json();
    // Browsers refuse port 53, and timing out on it slows every connection down.
    const iceServers = [].concat(body.iceServers || []).map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);

    // A failed write (the Free plan allows 1,000 a day) must not hand out uncounted credentials.
    if (env.BUDGET) {
      try { await env.BUDGET.put(key, String(used + 1), { expirationTtl: 3 * 86400 }); }
      catch { return json({ error: 'budget store full' }, 429); }
    }
    return json({ iceServers, used: used + 1, limit });
  },
};

// One Durable Object holds what needs a single shared memory: the per-address counters and the list
// of public rooms. Rooms live in memory only (they are re-announced every few seconds). Counters
// marked `keep` are also written to storage, so they survive the object going to sleep.
export class Hub {
  constructor(state) {
    this.state = state;
    this.rooms = new Map();        // app + ' ' + code -> { app, code, open, humans, at }
    this.counts = new Map();       // key -> { n, until }
    this.takes = 0;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const d = await request.json().catch(() => ({}));
    const now = Date.now();
    const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

    if (path === '/take') {
      let c = this.counts.get(d.key);
      if (!c && d.keep) c = await this.state.storage.get('c:' + d.key);
      if (!c || c.until <= now) c = { n: 0, until: now + d.windowMs };
      const ok = c.n < d.max;
      if (ok) c.n++;
      this.counts.set(d.key, c);
      if (ok && d.keep) await this.state.storage.put('c:' + d.key, c);
      if (++this.takes % 200 === 0) await this.sweep(now);
      return reply({ ok, count: c.n });
    }

    for (const [k, r] of this.rooms) if (now - r.at > ROOM_TTL_MS) this.rooms.delete(k);
    const id = d.app + ' ' + d.code;
    if (path === '/announce') { this.rooms.set(id, { app: d.app, code: d.code, open: d.open, humans: d.humans, at: now }); return reply({ ok: true }); }
    if (path === '/drop') { this.rooms.delete(id); return reply({ ok: true }); }
    if (path === '/count') return reply({ rooms: this.rooms.size });
    if (path === '/pick') {
      // The fullest room that still has a seat: a stranger wants company, not an empty lobby.
      let best = null;
      for (const r of this.rooms.values()) if (r.app === d.app && r.open > 0 && (!best || r.humans > best.humans)) best = r;
      if (best) best.open--;                       // hold the seat until the host's next announcement
      return reply({ code: best ? best.code : null });
    }
    return reply({ error: 'not found' });
  }

  async sweep(now) {
    for (const [k, c] of this.counts) if (c.until <= now) this.counts.delete(k);
    const kept = await this.state.storage.list({ prefix: 'c:' });
    for (const [k, c] of kept) if (c.until <= now) await this.state.storage.delete(k);
  }
}
