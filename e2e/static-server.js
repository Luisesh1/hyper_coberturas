const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 4173);
const apiTarget = process.env.E2E_API_TARGET || '';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function resolveFile(urlPathname) {
  const safePath = urlPathname === '/' ? '/index.html' : urlPathname;
  const filePath = path.join(rootDir, safePath);
  if (filePath.startsWith(rootDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath;
  }
  return path.join(rootDir, 'index.html');
}

function proxyApi(req, res) {
  const targetUrl = new URL(req.url, apiTarget);
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = transport.request(targetUrl, {
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.host,
    },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    send(res, 502, `Proxy error: ${error.message}`);
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (apiTarget && url.pathname.startsWith('/api/')) {
    proxyApi(req, res);
    return;
  }

  const filePath = resolveFile(url.pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      send(res, 404, 'Not found');
      return;
    }
    send(res, 200, content, MIME_TYPES[ext] || 'application/octet-stream');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[static-server] listening on http://127.0.0.1:${port}`);
});
