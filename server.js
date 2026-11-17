// UM Pathfinder — Node server. Serves the catalog API (and, locally, the web
// app). Keeps a cached copy of the official UM catalog fresh from catalog.umt.edu.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const catalog = require('./catalog');

const PORT = +process.env.PORT || 5600;
const MAX_AGE_DAYS = +process.env.CATALOG_MAX_AGE_DAYS || 7;
const REFRESH_COOLDOWN_MIN = +process.env.REFRESH_COOLDOWN_MIN || 60;
// Web pages allowed to call this API from another origin (GitHub Pages).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://michaelcassens.github.io,http://localhost:5600')
  .split(',').map(s => s.trim()).filter(Boolean);
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

let data = catalog.load();
let gz = null;              // gzipped catalog JSON, rebuilt when data changes
let lastCrawlStart = 0;

function setData(d) { data = d; gz = d ? zlib.gzipSync(JSON.stringify(d)) : null; }
setData(data);

function ageDays() { return data ? (Date.now() - Date.parse(data.fetchedAt)) / 864e5 : Infinity; }
async function refresh(force) {
  if (!force && ageDays() < MAX_AGE_DAYS) return;
  lastCrawlStart = Date.now();
  const fresh = await catalog.crawl();
  if (fresh) setData(fresh);
}

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/status') {
    return json(res, 200, { crawl: catalog.status(), fetchedAt: data?.fetchedAt || null, catalogYear: data?.catalogYear || null, courses: data?.courses.length || 0, programs: data?.programs.length || 0, maxAgeDays: MAX_AGE_DAYS });
  }
  if (url.pathname === '/api/catalog') {
    if (!data) return json(res, 503, { error: 'Catalog not downloaded yet', crawl: catalog.status() });
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding, Origin' }); return res.end(gz); }
    res.writeHead(200, headers); return res.end(JSON.stringify(data));
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    // Public endpoint: rate-limit so nobody can make us hammer catalog.umt.edu.
    const waitMin = Math.ceil((lastCrawlStart + REFRESH_COOLDOWN_MIN * 60e3 - Date.now()) / 60e3);
    if (catalog.status().running) return json(res, 200, { started: true });
    if (waitMin > 0) return json(res, 429, { started: false, message: `The catalog was checked recently. You can check again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.` });
    refresh(true);
    return json(res, 202, { started: true });
  }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`UM Pathfinder running on port ${PORT}`);
  console.log(data ? `Catalog snapshot from ${data.fetchedAt} (${data.courses.length} courses)` : 'No catalog snapshot yet — downloading from catalog.umt.edu…');
  refresh(false);
  setInterval(() => refresh(false), 6 * 3600e3); // re-check every 6 hours
});
