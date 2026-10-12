// A tiny static server for local runs and the browser test: node tools/serve.mjs [port] [dir]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };

export function serve(port = 8080, dir = '.') {
  const root = resolve(dir);
  const server = http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(ok => server.listen(port, () => ok(server)));
}

// A port nothing is listening on (for the test relay, which needs a number up front).
export function freePort() {
  return new Promise(ok => { const s = http.createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.argv[2] || 8080;
  await serve(port, process.argv[3] || '.');
  console.log(`http://localhost:${port}/`);
}
