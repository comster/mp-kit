// The browser smoke test: four players in four isolated browser contexts, real WebRTC, our own
// relay for introductions (so it needs nothing outside this machine), fake microphones.
//
//   node test/browser.mjs            headless
//   HEADED=1 node test/browser.mjs   watch it
//   PW_CHANNEL=chrome …              use the installed Chrome instead of Playwright's Chromium
import { chromium } from 'playwright';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';
import { mkdir } from 'node:fs/promises';
import { serve, freePort } from '../tools/serve.mjs';
import { serveHub } from '../tools/hub-dev.mjs';

const N = 4;
const shots = new URL('./shots/', import.meta.url).pathname;
await mkdir(shots, { recursive: true });
const web = await serve(0, new URL('..', import.meta.url).pathname);
const webPort = web.address().port;
const relayPort = await freePort();
const relay = createWsRelayServer({ port: relayPort });
const hub = await serveHub(await freePort());                // the Worker, run locally: the public room list
// A CI container has a fraction of a laptop's CPU and no GPU: draw less and allow more time there.
const SLOW = process.env.CI ? 3 : 1;
const base = `http://localhost:${webPort}/?auto=1&relay=ws://localhost:${relayPort}${process.env.CI ? '&thin=1' : ''}`;

const browser = await chromium.launch({
  headless: !process.env.HEADED,
  channel: process.env.PW_CHANNEL || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
let failed = false;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const check = (ok, what) => { log(ok ? 'ok  ' : 'FAIL', what); if (!ok) failed = true; };
const state = page => page.evaluate(() => window.__mp.state());
async function until(what, ms, fn) {
  const end = Date.now() + ms * SLOW;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 100)); }
  check(false, `${what} (within ${ms / 1000} s)`); return null;
}

try {
  const pages = [];
  for (let i = 0; i < N; i++) {
    const ctx = await browser.newContext({ viewport: i === 3 ? { width: 375, height: 812 } : process.env.CI ? { width: 640, height: 400 } : { width: 1280, height: 800 }, hasTouch: i === 3, permissions: ['microphone'] });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(`P${i + 1}: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`P${i + 1}: ${e.message}`));
    pages.push(page);
  }

  // Player 1 creates the room; the others follow the invite link.
  await pages[0].goto(base + '&name=P1');
  const code = await until('P1 hosts a room', 10000, async () => { const s = await state(pages[0]); return s?.host && pages[0].evaluate(() => window.__mp.mp.code); });
  log('room', code);
  const joinStart = Date.now();
  await Promise.all(pages.slice(1).map((p, i) => p.goto(`${base}&name=P${i + 2}#r=${code}`)));
  const all = await until('every client sees 4 players', 10000, async () => {
    const ss = await Promise.all(pages.map(state));
    return ss.every(s => s && s.roster.length === N && s.roster.every(r => r.here)) && ss;
  });
  if (all) {
    check(true, `every client sees ${N} players (${((Date.now() - joinStart) / 1000).toFixed(1)} s)`);
    check(all.filter(s => s.host).length === 1 && all.every(s => s.hostPid === all[0].pid), 'one host, and everyone agrees it is P1');
  }

  // Voice: two players opt in through the lobby (the age question, then the mic).
  for (const p of [pages[1], pages[2]]) { await p.click('#mp-voice-on'); await p.click('#mp-age-yes'); }
  check(!!await until('voice streams arrive', 8000, async () => { const [a, b] = await Promise.all([state(pages[1]), state(pages[2])]); return a.voiceOn && b.voiceOn && a.voicePeers >= 1 && b.voicePeers >= 1; }), 'voice: opted-in players receive each other\'s stream');
  const heard = await until('voice is heard while P2 holds push-to-talk', 6000, async () => {
    await pages[1].evaluate(() => window.__mp.mp.voice.setTalking(true));
    return pages[2].evaluate(() => { const m = window.__mp; const p2 = m.room.roster.find(r => r.name === 'P2').pid; return m.mp.voice.level(p2) > 0.02; });
  });
  check(!!heard, 'voice: P3 hears P2 while P2 holds push-to-talk');
  await pages[1].evaluate(() => window.__mp.mp.voice.setTalking(false));
  check((await state(pages[3])).voiceOn === false, 'voice stays off for players who did not opt in');

  // The host fills with bots and starts.
  await pages[0].click('#mp-fill', { timeout: 500 }).catch(() => {});   // only there when seats are free
  await pages[0].click('#mp-start');
  check(!!await until('everyone is in the match', 5000, async () => (await Promise.all(pages.map(state))).every(s => s.started && s.seen === s.roster.length)), 'the match starts for everyone, and each client draws every player');

  // A client moves; the host sees it. The host owns the coin and the scores.
  const before = (await state(pages[1])).me;
  await pages[1].evaluate(() => window.__mp.walk(3, 2));
  check(!!await until('P2 moves', 4000, async () => { const m = (await state(pages[1])).me; return Math.hypot(m.x - before.x, m.z - before.z) > 1; }), 'a client moves its own capsule');
  check(!!await until('snapshots flow', 4000, async () => (await Promise.all(pages.slice(1).map(state))).every(s => s.snapAgeMs < 400)), 'snapshots reach every client');
  await Promise.all(pages.map((p, i) => p.screenshot({ path: `${shots}p${i + 1}-match.png` })));

  // Kill the host. The oldest remaining player must take over within 5 seconds.
  const killAt = Date.now();
  await pages[0].context().close();
  const rest = pages.slice(1);
  const after = await until('a new host takes over', 5000, async () => {
    const ss = await Promise.all(rest.map(state));
    return ss.filter(s => s.host).length === 1 && ss.every(s => s.hostPid === ss.find(x => x.host).pid) && ss;
  });
  if (after) {
    check(true, `host hand-over in ${((Date.now() - killAt) / 1000).toFixed(1)} s`);
    check(after.every(s => s.started), 'the match carries on');
    check(after.find(s => s.host).events.includes('mp_host_migrate'), 'the new host reports mp_host_migrate');
  }
  check(!!await until('snapshots resume', 4000, async () => (await Promise.all(rest.map(state))).filter(s => !s.host).every(s => s.snapAgeMs < 400)), 'snapshots resume from the new host');
  await Promise.all(rest.map((p, i) => p.screenshot({ path: `${shots}p${i + 2}-after-handover.png` })));

  // The player panel in a match, at phone size.
  await pages[3].evaluate(() => window.__mp.mp.showLobby('match'));
  await pages[3].screenshot({ path: `${shots}p4-players-phone.png` });

  // Quick play: two strangers. The first finds no room and opens a public one; the second is sent to it.
  const quick = `${base.replace('auto=1', 'auto=quick')}&startin=6&hub=http://localhost:${hub.address().port}`;
  const strangers = [];
  for (const name of ['Q1', 'Q2']) {
    const page = await (await browser.newContext({ viewport: { width: 640, height: 400 }, permissions: ['microphone'] })).newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    await page.goto(`${quick}&name=${name}`);
    strangers.push(page);
    if (name === 'Q1') {
      const s1 = await until('Q1 opens a public room', 10000, async () => { const s = await state(page); return s?.host && s; });
      check(!!s1 && /^P[A-Z0-9]{5}$/.test(await page.evaluate(() => window.__mp.mp.code)), 'quick play with nobody around opens a public room');
      check(!!await until('the room is on the list', 15000, async () => hub.hub.rooms.size === 1), 'the host announces the room');
      check((await state(page)).roster.filter(r => r.bot).length === 3, 'bots hold the empty seats');
    }
  }
  const both = await until('Q2 lands in Q1\'s room', 12000, async () => { const ss = await Promise.all(strangers.map(state)); return ss.every(s => s && s.roster.filter(r => !r.bot && r.here).length === 2) && ss; });
  check(!!both, 'a second player using quick play is sent to that room');
  if (both) {
    check(both[0].roster.length === 4 && both[0].roster.filter(r => r.bot).length === 2, 'and takes a bot\'s seat');
    check((await strangers[0].evaluate(() => [window.__mp.mp.public, window.__mp.mp.voice === null, !!document.querySelector('#mp-voice-on')])).join() === 'true,true,false', 'a public room has no voice chat');
  }
  check(!!await until('the public room starts by itself', 20000, async () => (await Promise.all(strangers.map(state))).every(s => s.started)), 'the game starts by itself on a countdown');
  await strangers[1].screenshot({ path: `${shots}q2-public-room.png` });

  check(errors.length === 0, 'no console errors' + (errors.length ? ':\n  ' + errors.join('\n  ') : ''));
} finally {
  await browser.close();
  web.close();
  hub.close();
  relay.close?.();
}
console.log(failed ? '\nFAILED' : '\nall good');
process.exit(failed ? 1 : 0);
