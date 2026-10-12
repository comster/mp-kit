// Quick play: joining a room with strangers. The Worker keeps a list of public rooms with a free
// seat; a host announces its room every few seconds, and a player looking for a game is given one.
//
// Public rooms are not the same as invite rooms, and the kit enforces the difference:
//   - no voice chat (live voice between strangers is the one thing we don't ship);
//   - every connection goes through the relay, so strangers never see each other's IP address;
//   - bots hold the empty seats and give them up as people arrive, and the game starts by itself.
// A public room's code is P plus five characters; an invite code is five. Everyone in the room can
// tell which kind it is from the code alone.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const isPublicCode = code => /^P[A-Z0-9]{5}$/.test(code || '');
export const makePublicCode = (rand = Math.random) => 'P' + Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]).join('');

// Patient, and twice: this runs while the game is still loading, and a busy page answers late.
const call = async (hub, method, body, query = '') => {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(hub + '/rooms' + query, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000), keepalive: method === 'DELETE' });
      if (res.ok) return res.json();
      last = new Error('HTTP ' + res.status);
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) { last = err; }
  }
  throw last;
};

// A room to join, or null when nobody has a free seat (then the player opens a new public room).
export const pickRoom = async (hub, app) => (await call(hub, 'GET', null, '?app=' + encodeURIComponent(app))).code || null;
export const announceRoom = (hub, app, code, open, humans) => call(hub, 'POST', { app, code, open, humans }).catch(() => {});
export const dropRoom = (hub, app, code) => call(hub, 'DELETE', { app, code }).catch(() => {});
