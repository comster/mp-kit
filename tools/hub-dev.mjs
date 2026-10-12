// The Worker, run locally for tests and development: the same code, with a Map where Cloudflare
// keeps its storage. It lists public rooms; it has no TURN key, so /ice answers "not configured".
//
//   node tools/hub-dev.mjs [port]       then open a game with ?hub=http://localhost:<port>
import http from 'node:http';
// In the kit repo the Worker is next door; in a game it is the copy sync-kit.sh leaves beside this file.
const { default: worker, Hub } = await import('../worker/src/index.js').catch(() => import('./hub-worker.js'));

export function serveHub(port = 8787) {
  const store = new Map();
  const hub = new Hub({ storage: { get: async k => store.get(k), put: async (k, v) => void store.set(k, v), delete: async k => void store.delete(k), list: async () => new Map(store) } });
  const env = { ALLOW_LOCALHOST: 'true', ALLOWED_ORIGINS: 'https://example.com', HUB: { idFromName: n => n, get: () => ({ fetch: (url, init) => hub.fetch(new Request(url, init)) }) } };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost' + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text());
  });
  return new Promise(ok => server.listen(port, () => ok(Object.assign(server, { hub }))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.argv[2] || 8787;
  await serveHub(port);
  console.log(`http://localhost:${port}/status`);
}
