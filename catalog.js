// Crawls the official University of Montana catalog (catalog.umt.edu) and
// builds a normalized cache of courses and program requirements.
// No dependencies: Node 18+ (global fetch).
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'https://catalog.umt.edu';
const UA = 'UM-Pathfinder/1.0 (course exploration tool; polite crawler)';
const CACHE = path.join(__dirname, 'data', 'catalog.json');
// Past catalogs (a student follows the requirements of their "catalog of record"). These are
// fixed once published, so they're crawled once and saved compressed in data/archive/.
const ARCHIVE_DIR = path.join(__dirname, 'data', 'archive');
const KNOWN_ARCHIVES = ['2022-2023', '2023-2024', '2024-2025', '2025-2026'];   // add a year here when UM archives one
const CONCURRENCY = 4;

// ---------- small HTML helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] ?? m));
}
function text(html) {
  return decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}
function normCode(c) {
  return String(c).replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}
// "MART 101L" -> "MART 101" (UM appends gen-ed letters to numbers)
function baseCode(c) {
  const m = normCode(c).match(/^([A-Z]{1,5})\s?(\d{3})/);
  return m ? `${m[1]} ${m[2]}` : normCode(c);
}

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) { console.warn(`  ! ${url}: ${e.message}`); return null; }
      await new Promise(res => setTimeout(res, 800 * (i + 1)));
    }
  }
}

async function pool(items, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      done++;
      onProgress && onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

// ---------- course parsing ----------
function parsePrereq(desc) {
  // UM style: "Prereq., CSCI 135 and M 115 or consent of instr." (sentence-ish)
  const m = desc.match(/\b(?:Prereq(?:uisites?)?\.?,?|Prerequisites?:)\s*(.+?)(?:\.\s+(?=[A-Z])|$)/);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}
function parseCoreq(desc) {
  const m = desc.match(/\bCoreq\.?,?\s*(.+?)(?:\.\s+(?=[A-Z])|$)/);
  return m ? m[1].trim() : null;
}
function parseCourses(html, subject, prefix = '') {
  const courses = [];
  const title = text((html.match(/<h1[^>]*page-title[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || subject);
  const blocks = html.split(/<div class="courseblock">/).slice(1);
  for (const b of blocks) {
    const t = text((b.match(/courseblocktitle[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const desc = text((b.match(/courseblockdesc[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
    const extras = [...b.matchAll(/courseblockextra[^>]*>([\s\S]*?)<\/p>/g)].map(x => text(x[1]));
    const m = t.match(/^([A-Z]{1,5}\s*\d{3}[A-Z]{0,2})\s*-\s*(.+?)\.\s*([\d.\-– ]+)\s*Credits?\.?$/i)
      || t.match(/^([A-Z]{1,5}\s*\d{3}[A-Z]{0,2})\s*-\s*(.+?)\.?$/);
    if (!m) continue;
    const code = normCode(m[1]);
    const genEd = [];
    for (const e of extras) {
      const g = e.match(/Gen Ed Attributes?:\s*(.+)/i);
      if (g) genEd.push(...g[1].split(',').map(s => s.trim()).filter(Boolean));
    }
    const offered = (desc.match(/Offered ([a-z ,]+?)(?:\.|$)/i) || [])[1] || null;
    courses.push({
      code, base: baseCode(code), subject: subject.toUpperCase(), subjectName: title.replace(/\s*\([A-Z]+\)\s*$/, ''),
      title: m[2].trim(), credits: (m[3] || '').trim() || null,
      level: +(code.match(/\d{3}/) || ['0'])[0],
      desc, prereq: parsePrereq(desc), coreq: parseCoreq(desc),
      genEd, offered: offered && offered.trim(),
      url: `${BASE}${prefix}/courses/${subject.toLowerCase()}/`
    });
  }
  return courses;
}

// ---------- program parsing ----------
const BOILER = /all students must complete|General Education Requirements|Additional requirements for graduation|grade point average|Courses taken to satisfy|Degree\/Certificate Requirements/i;
function programType(slug, name) {
  const s = (slug + ' ' + name).toLowerCase();
  if (/minor/.test(s)) return 'minor';
  if (/cert|certificate/.test(s)) return 'certificate';
  if (/(^|\/)(ba|bs|bfa|bm|bme|bas|bsn|aas|as|aa)-|bachelor|associate/.test(s)) return 'major';
  if (/lic-|licensure/.test(s)) return 'licensure';
  return 'other';
}
function parseProgram(html, url, prefix = '') {
  const name = text((html.match(/<h1[^>]*page-title[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  // Requirement tables live in the requirements tab; fall back to whole page.
  const reqStart = html.indexOf('id="requirementstextcontainer"');
  let scope = reqStart >= 0 ? html.slice(reqStart) : html;
  const dm = scope.indexOf('id="degreemaptextcontainer"');
  if (dm > 0) scope = scope.slice(0, dm);
  const tables = [...scope.matchAll(/<table class="sc_courselist"[\s\S]*?<\/table>/g)].map(m => m[0]);
  if (!tables.length) return null;

  const groups = [];
  let section = 'Requirements', cur = null, totalHours = null;
  const newGroup = (rule, credits) => { cur = { section, rule, credits: credits || null, courses: [] }; groups.push(cur); };
  for (const t of tables) {
    for (const row of t.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cls = (row.match(/<tr class="([^"]*)"/) || [])[1] || '';
      if (/hidden|plangrid/.test(cls)) continue;
      const hours = text((row.match(/<td class="hourscol">([\s\S]*?)<\/td>/) || [])[1] || '');
      // A page can list the program total and then concentration subtotals: keep the largest.
      if (/listsum/.test(cls) || /Total (Hours|Credits)/i.test(row)) { if (hours && (!totalHours || parseFloat(hours) > parseFloat(totalHours))) totalHours = hours; continue; }
      if (/areaheader/.test(cls)) { section = text(row) || section; cur = null; continue; }
      const comment = row.match(/courselistcomment[^>]*>([\s\S]*?)<\/span>/);
      const codes = [...row.matchAll(/showCourse\(this, '([^']+)'\)/g)].map(m => normCode(m[1]));
      if (codes.length) {
        if (!cur) newGroup('Required', null);
        const title = text((row.match(/<\/td>\s*<td>([\s\S]*?)<\/td>/) || [])[1] || '');
        const alt = /orclass/.test(cls);
        if (alt && cur.courses.length) cur.courses[cur.courses.length - 1].or.push(...codes);
        else cur.courses.push({ code: codes[0], or: codes.slice(1), title });
      } else if (comment) {
        newGroup(text(comment[1]), hours || null);
      }
    }
  }
  // Overview text (first couple of paragraphs of the overview tab)
  const ov = html.match(/id="textcontainer"[\s\S]*?<\/div>\s*<\/div>/);
  const paras = ov ? [...ov[0].matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => text(m[1])).filter(p => p.length > 60 && !BOILER.test(p)).slice(0, 2) : [];
  // Learning outcomes, if the page publishes them
  let outcomes = [];
  const lo = html.match(/<h[2-4][^>]*>[^<]*(?:Learning Outcomes|Outcomes)[^<]*<\/h[2-4]>([\s\S]*?)(?:<h[2-4]|<\/div>)/i);
  if (lo) outcomes = [...lo[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => text(m[1])).filter(Boolean).slice(0, 12);

  const rel = url.replace(BASE + prefix, '');   // program ids stay the same across catalog years
  const parts = rel.split('/').filter(Boolean);
  return {
    id: parts.slice(1).join('/'),
    name, url, type: programType(parts[parts.length - 1], name),
    college: parts[1] || '', overview: paras.join(' '), outcomes,
    totalHours, groups: groups.filter(g => g.courses.length)
  };
}

// ---------- crawl ----------
let state = { running: false, phase: 'idle', done: 0, total: 0, error: null };
function status() { return { ...state }; }

// crawl() reads the current catalog into data/catalog.json.
// crawl({ archive: '2024-2025' }) reads an archived year into data/archive/2024-2025.json.gz.
async function crawl(opts = {}) {
  if (state.running) return;
  const prefix = opts.archive ? `/archived-catalogs/${opts.archive}` : '';
  state = { running: true, phase: 'Reading catalog index', done: 0, total: 0, error: null };
  try {
    const home = await get(BASE + prefix + '/');
    if (!home) throw new Error('Could not reach catalog.umt.edu');
    const year = text((home.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').split('|')[0].trim();
    const linksIn = html => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].trim()).filter(h => h.startsWith(prefix + '/'));
    const hrefs = new Set(linksIn(home));
    const rel = h => h.slice(prefix.length);
    const subjectsOf = () => [...new Set([...hrefs].map(h => (rel(h).match(/^\/courses\/([a-z]+)\/$/) || [])[1]).filter(Boolean))];
    const programsOf = () => [...hrefs].filter(h => /^\/colleges-schools-programs\/.+\/$/.test(rel(h)) && rel(h).split('/').filter(Boolean).length >= 3);
    // Some catalogs (e.g. 2022-23) link only to index pages from the home page: follow those.
    if (subjectsOf().length < 20) { const ci = await get(`${BASE}${prefix}/courses/`); if (ci) linksIn(ci).forEach(h => hrefs.add(h)); }
    if (programsOf().length < 100) {
      state.phase = 'Finding program pages';
      let level = [`${prefix}/colleges-schools-programs/`];
      for (let depth = 0; depth < 3 && level.length; depth++) {   // college → department → program
        const pages = await pool(level, u => get(BASE + u));
        const found = pages.flatMap(h => h ? linksIn(h) : []).filter(h => /^\/colleges-schools-programs\/.+\/$/.test(rel(h)) && !hrefs.has(h));
        found.forEach(h => hrefs.add(h));
        level = [...new Set(found)].filter(h => rel(h).split('/').filter(Boolean).length <= 2 + depth);
      }
    }
    const subjects = subjectsOf();
    const programUrls = [...new Set(programsOf())];

    state.phase = `Reading course descriptions (${subjects.length} subjects)`;
    state.total = subjects.length; state.done = 0;
    const courseLists = await pool(subjects, async s => {
      const h = await get(`${BASE}${prefix}/courses/${s}/`);
      return h ? parseCourses(h, s, prefix) : [];
    }, d => (state.done = d));
    const courses = courseLists.flat();

    state.phase = `Reading program requirements (${programUrls.length} pages)`;
    state.total = programUrls.length; state.done = 0;
    const progs = (await pool(programUrls, async u => {
      const h = await get(BASE + u);
      return h ? parseProgram(h, BASE + u, prefix) : null;
    }, d => (state.done = d))).filter(p => p && p.groups.length && p.type !== 'other');

    const data = { fetchedAt: new Date().toISOString(), catalogYear: year, source: BASE + prefix, courses, programs: progs };
    if (opts.archive) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(ARCHIVE_DIR, `${opts.archive}.json.gz`), require('zlib').gzipSync(JSON.stringify(data), { level: 9 }));
    } else {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(data));
    }
    state = { running: false, phase: 'done', done: courses.length, total: courses.length, error: null };
    console.log(`Catalog cached: ${courses.length} courses, ${progs.length} programs (${year})`);
    return data;
  } catch (e) {
    state = { running: false, phase: 'error', done: 0, total: 0, error: e.message };
    console.error('Crawl failed:', e);
  }
}

function load() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}
// Archived catalog years saved on disk, newest first (e.g. ['2025-2026', '2024-2025']).
function archives() {
  try { return fs.readdirSync(ARCHIVE_DIR).map(f => (f.match(/^(\d{4}-\d{4})\.json\.gz$/) || [])[1]).filter(Boolean).sort().reverse(); }
  catch { return []; }
}
// A saved archive as gzipped JSON, ready to serve as-is (or null).
function archiveGz(id) {
  if (!/^\d{4}-\d{4}$/.test(id)) return null;
  try { return fs.readFileSync(path.join(ARCHIVE_DIR, `${id}.json.gz`)); } catch { return null; }
}

module.exports = { crawl, load, status, archives, archiveGz, CACHE, KNOWN_ARCHIVES, _test: { parseCourses, parseProgram, parsePrereq } };

// node catalog.js                     → the current catalog
// node catalog.js --archive 2024-2025  → one archived year
// node catalog.js --archives           → every year in KNOWN_ARCHIVES, one after another
if (require.main === module) {
  const a = process.argv.slice(2);
  const years = a.includes('--archives') ? KNOWN_ARCHIVES : a.includes('--archive') ? [a[a.indexOf('--archive') + 1]] : null;
  (async () => { if (!years) return crawl(); for (const y of years) { console.log(`Archived catalog ${y}…`); await crawl({ archive: y }); } })();
}
