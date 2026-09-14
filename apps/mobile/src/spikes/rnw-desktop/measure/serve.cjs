/**
 * T4.1 spike — minimal static server for the exported web bundle
 * (THROWAWAY). SPA fallback to index.html so /spike/rnw-desktop serves.
 *
 *   node serve.cjs <export-dir> [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const port = Number(process.argv[3] ?? 8091);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (urlPath === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(root, 'index.html');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`serving ${root} on http://127.0.0.1:${port}`);
  });
