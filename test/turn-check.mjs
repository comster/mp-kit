// Proves the TURN relay on your live site: two players who are only allowed to connect through it
// (?turn=force), and a look at the connection they ended up with, which must be a relay.
// Not part of CI: it uses the real relay and counts against the daily budget.
//
//   node test/turn-check.mjs <url> [quick]   the demo room on your site. PW_CHANNEL=chrome to use installed Chrome.
//   For a game, set HOOK to the name of the test handle it puts on window ({ mp, room }); the demo's is __mp.
//   With `quick`, the two players meet through Quick play instead of an invite link (public rooms are relay only).
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) { console.error('usage: node test/turn-check.mjs <url> [quick]'); process.exit(2); }
const hook = process.env.HOOK || '__mp';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const open = async q => {
  const page = await (await browser.newContext()).newPage();
  // Trystero keeps its peer connections private, so note each one as the page makes it.
  await page.addInitScript(() => {
    const Real = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...args) { const pc = new Real(...args); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Real.prototype;
  });
  await page.goto(url + q);
  return page;
};

const quick = process.argv[3] === 'quick';
const a = await open(quick ? '?auto=quick&test=1&name=Ann' : '?auto=1&test=1&turn=force&name=Ann');
await a.waitForFunction(h => window[h]?.room?.isHost, hook, { timeout: 20000 });
const code = await a.evaluate(h => window[h].mp.code, hook);
const t0 = Date.now();
if (quick) await new Promise(r => setTimeout(r, 12000));      // until the host's first announcement is on the list
const b = await open(quick ? '?auto=quick&test=1&name=Ben' : '?auto=1&test=1&turn=force&name=Ben#r=' + code);
let ok = true;
try { await a.waitForFunction(h => window[h].room.roster.filter(r => r.peer).length === 2, hook, { timeout: 40000 }); } catch { ok = false; }
const pairs = await a.evaluate(async () => {
  const out = [];
  for (const pc of window.__pcs) {
    const stats = await pc.getStats(), byId = {};
    stats.forEach(s => (byId[s.id] = s));
    stats.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded') out.push(byId[s.localCandidateId]?.candidateType + ' to ' + byId[s.remoteCandidateId]?.candidateType); });
  }
  return [...new Set(out)];
});
const relayed = pairs.length > 0 && pairs.every(p => p.startsWith('relay'));
console.log(`relay servers handed out: Ann ${await a.evaluate(h => window[h].mp.turn, hook)}, Ben ${await b.evaluate(h => window[h]?.mp.turn, hook).catch(() => 'page not ready')}`);
if (quick) console.log(`public room ${code}; Ben is in ${await b.evaluate(h => window[h]?.mp.code, hook).catch(() => '?')}`);
console.log(ok ? `two players connected in ${((Date.now() - t0) / 1000).toFixed(1)} s; connection: ${pairs.join(', ') || 'unknown'}` : 'did NOT connect with relay only');
if (ok && !relayed) console.log('but it is not a relayed connection');
await browser.close();
process.exit(ok && relayed ? 0 : 1);
