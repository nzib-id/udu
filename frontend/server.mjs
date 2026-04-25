import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(__dirname, 'dist');
const PORT = Number.parseInt(process.env.PORT ?? '4246', 10);
const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:4247';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const proxy = httpProxy.createProxyServer({ target: BACKEND, ws: true, changeOrigin: true });
proxy.on('error', (err, _req, res) => {
  console.warn('[udu-frontend] proxy error:', err.message);
  if (res && 'writeHead' in res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream backend unavailable');
  }
});

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api') || req.url?.startsWith('/ws')) {
    proxy.web(req, res);
    return;
  }

  const urlPath = (req.url ?? '/').split('?')[0];
  const safe = urlPath.replace(/\.\.+/g, '.');
  let file = join(DIST, safe === '/' ? 'index.html' : safe);

  if (!existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html');

  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) {
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[udu-frontend] listening on :${PORT} → backend ${BACKEND}`);
});
