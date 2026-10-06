// Dependency-free local preview, including the Vercel-style API handlers.
// Binds only to loopback. No secrets, repository internals or arbitrary paths
// are served. Run: node tools/dev.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = new Set(['btc-regime.html', 'market-context.js', 'market-context.css', 'config.json', 'validation.json']);
const routes = new Set(['market-context', 'relay', 'onchain', 'snapshot', 'equity']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(url.searchParams);
  const route = url.pathname.replace(/^\/api\//, '');
  try {
    if (url.pathname.startsWith('/api/') && routes.has(route)) return await require(path.join(root, 'api', route + '.js'))(req, res);
    const file = url.pathname === '/' ? 'btc-regime.html' : url.pathname.slice(1);
    if (!files.has(file)) { res.writeHead(404); return res.end('Not found'); }
    res.setHeader('Content-Type', types[path.extname(file)] + '; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(path.join(root, file)).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'local_server_error', detail: e.message }));
  }
}).listen(8765, '127.0.0.1', () => console.log('Dashboard preview: http://127.0.0.1:8765/#market-context'));
