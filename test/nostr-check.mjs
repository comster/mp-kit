// A manual check of the default path: two players meeting over the public Nostr relays.
// Not part of CI (it depends on outside servers):  node test/nostr-check.mjs
import { chromium } from 'playwright';
import { serve } from '../tools/serve.mjs';
const web = await serve(0, new URL('..', import.meta.url).pathname);
const base = `http://localhost:${web.address().port}/?auto=1`;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const open = async (name, hash = '') => { const p = await (await browser.newContext()).newPage(); await p.goto(`${base}&name=${name}${hash}`); return p; };
const t0 = Date.now();
const a = await open('A');
await a.waitForFunction(() => window.__mp.state()?.host, null, { timeout: 15000 });
const code = await a.evaluate(() => window.__mp.mp.code);
const b = await open('B', '#r=' + code);
let ok = true;
try { await b.waitForFunction(() => window.__mp.state()?.roster.length === 2, null, { timeout: 30000 }); } catch { ok = false; }
console.log(ok ? `joined over Nostr in ${((Date.now() - t0) / 1000).toFixed(1)} s` : 'did not connect in 30 s', await b.evaluate(() => JSON.stringify(window.__mp.state()?.roster)));
await browser.close(); web.close(); process.exit(ok ? 0 : 1);
