// UM Pathfinder — local server. Serves the web app and a cached copy of the
// official UM catalog, refreshing it automatically from catalog.umt.edu.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');

const PORT = +process.env.PORT || 5600;
const MAX_AGE_DAYS = +process.env.CATALOG_MAX_AGE_DAYS || 7;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

let data = catalog.load();

function ageDays() { return data ? (Date.now() - Date.parse(data.fetchedAt)) / 864e5 : Infinity; }
async function refreshIfStale(force) {
  if (!force && ageDays() < MAX_AGE_DAYS) return;
  const fresh = await catalog.crawl();
  if (fresh) data = fresh;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/status') {
    return json(res, 200, { crawl: catalog.status(), fetchedAt: data?.fetchedAt || null, catalogYear: data?.catalogYear || null, courses: data?.courses.length || 0, programs: data?.programs.length || 0, maxAgeDays: MAX_AGE_DAYS });
  }
  if (url.pathname === '/api/catalog') {
    if (!data) return json(res, 503, { error: 'Catalog not downloaded yet', crawl: catalog.status() });
    return json(res, 200, data);
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    refreshIfStale(true);
    return json(res, 202, { started: true });
  }
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
  console.log(`UM Pathfinder running at http://localhost:${PORT}`);
  console.log(data ? `Catalog cache from ${data.fetchedAt} (${data.courses.length} courses)` : 'No catalog cache yet — downloading from catalog.umt.edu…');
  refreshIfStale(false);
  setInterval(() => refreshIfStale(false), 6 * 3600e3); // re-check every 6 hours
});
