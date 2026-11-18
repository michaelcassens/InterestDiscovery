/* UM Pathfinder — transcript reader.
   Turns an unofficial transcript (PDF, saved web page, text, or pasted text)
   into a list of courses. Everything runs in the browser: the file is never
   uploaded, and only the course codes a student approves are kept. */
(() => {
'use strict';

// ---------- reading files into lines of text ----------
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfReady = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return pdfReady ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    s.onerror = () => { pdfReady = null; fail(new Error('Could not load the PDF reader. Check your internet connection and try again.')); };
    document.head.append(s);
  });
}

// Rebuild text lines from a PDF page's positioned text pieces.
function pageLines(items, width) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 3) * 3, x = it.transform[4];
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x, w: it.width || it.str.length * 4, s: it.str });
  }
  const ys = [...rows.keys()].sort((a, b) => b - a);
  ys.forEach(y => rows.get(y).sort((a, b) => a.x - b.x));
  // A true two-column page has an empty gutter down the middle. A wide table
  // (like a transcript's grade and credit columns) doesn't, so it stays one column.
  const mid = width / 2, all = ys.flatMap(y => rows.get(y));
  const gutterEmpty = !all.some(p => p.x < mid + 10 && p.x + p.w > mid - 10);
  const both = ys.filter(y => { const r = rows.get(y); return r.some(p => p.x + p.w < mid) && r.some(p => p.x > mid); }).length;
  const twoCol = gutterEmpty && ys.length > 10 && both / ys.length > 0.3;
  // Pieces that touch (gap ≈ 0) are one word split for kerning; a gap or an overlap means separate words.
  const join = parts => { let out = '', end = null; for (const p of parts) { const gap = end === null ? 0 : p.x - end; out += end === null ? p.s : (gap > 12 ? '\t' : gap > 1 || gap < -2 ? ' ' : '') + p.s; end = p.x + p.w; } return out; };
  if (!twoCol) return ys.map(y => join(rows.get(y)));
  const left = ys.map(y => join(rows.get(y).filter(p => p.x < mid))).filter(Boolean);
  const right = ys.map(y => join(rows.get(y).filter(p => p.x >= mid))).filter(Boolean);
  return [...left, ...right];
}
async function readPdf(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    lines.push(...pageLines(tc.items, page.view[2]));
  }
  return lines;
}
function htmlToLines(html) {
  const t = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/t[dh]>/gi, '\t').replace(/<br\s*\/?>|<\/(tr|p|div|li|h\d|table|caption)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const ta = document.createElement('textarea'); ta.innerHTML = t;   // decode &amp; etc.
  return ta.value.split(/\r?\n/);
}
async function readFile(file) {
  const name = file.name.toLowerCase(), type = file.type;
  if (type === 'application/pdf' || name.endsWith('.pdf')) return readPdf(file);
  if (/^image\//.test(type) || /\.(png|jpe?g|gif|heic|webp)$/.test(name))
    throw new Error('This file is a picture or scan, which Pathfinder can’t read. Save your transcript as a PDF from your browser (Print → Save as PDF), or copy its text and paste it instead.');
  const text = await file.text();
  if (/\.html?$/.test(name) || /^\s*</.test(text)) return htmlToLines(text);
  return text.split(/\r?\n/);
}

// ---------- finding courses in the text ----------
// Subject + number. Subjects are 1–5 capitals, and older UM transcripts also have
// "C&I" and two-part subjects like "H PE". UM numbers have 3 digits; other schools
// sometimes use 4 ("HIST 1100").
const CODE = /(?:^|[\s\t(])([A-Z](?:[A-Z&]{0,4}| [A-Z]{2,3}))[\s\t]{0,3}(\d{3,4}[A-Z]{0,2})(?=$|[\s\t)*,;:])/;
const CODE_G = new RegExp(CODE.source, 'g');
// Words that look like a subject code but aren't (from totals, headers, addresses).
const NOT_SUBJECT = new Set(('HRS HOURS GPA TERM TOTAL TOTALS PAGE CUM EARNED ATTEMPTED POINTS QUALITY PASSED CREDIT CREDITS ' +
  'ID MT ZIP BOX PO SUITE APT FALL SPRING SUMMER AUTUMN WINTER YEAR UG GR LD UD OF AND THE TO IN DOB SSN NO NUMBER ' +
  'TRANSFER INSTITUTION OVERALL CURRENT LEVEL STANDING DEAN HONORS GOOD').split(' '));
const GRADE_SRC = 'A|A-|B\\+|B|B-|C\\+|C|C-|D\\+|D|D-|F|P|NP|CR|NC|W|WP|WF|I|I[A-F]|IP|AU|S|U|N|T|TR|TA|TB|TC|TP|XF';
const GRADE = new RegExp(`^(${GRADE_SRC})$`);
const GLUED = new RegExp(`^(.*[a-z)\\]])(${GRADE_SRC})$`);    // "LaboratoryA" → "Laboratory" + "A"
const NO_CREDIT = /^(F|NP|NC|W|WF|WP|I|AU|U|N|XF)$/;
const SEC_TRANSFER = /transfer credit|credit accepted|^\s*transfer\b|advanced placement|\bap\b.*(exam|credit)|\bclep\b|dual (credit|enrollment)|military credit|\bibo?\b exam|international baccalaureate|test credit|credit by exam/i;
const SEC_PROGRESS = /in[- ]progress|currently enrolled|courses? (registered|scheduled)/i;
const SCHOOL = /\b(college|university|community|institute|school|academy|polytechnic|program)\b/i;
const titleCase = s => /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(I|Ii|Iii|Iv|Bc|Ab)\b/g, m => m.toUpperCase());

/* parse(lines, { isUMSubject, findCourse }) → [{ code, title, credits, grade, noCredit,
   group: 'um' | 'progress' | 'transfer', school, term, known, graduate }]
   A UM course that isn't in today's catalog (an older or renumbered course) comes back as
   group 'um' with known: false; the app offers to match it to a current course. */
function parse(lines, ctx) {
  let group = 'um', school = '', term = '', sawSections = false;
  const out = [];
  for (const raw of lines) {
    const line = String(raw).replace(/ /g, ' ').trim(); if (!line) continue;
    const m = line.match(CODE);
    if (!m) {
      if (/^\s*(total|overall|cumulative|cum\b|current term|term totals?|transcript totals?|pre-system)/i.test(line)) continue;   // totals rows aren't headings
      // Banner lists each transfer source as "1991-91: Advanced Placement Program" or "202250: Flathead Valley CC".
      const src = line.match(/^\s*\d{4,6}(?:-\d{2,4})?\s*:\s*(.+)$/);
      if (group === 'transfer' && src) { school = src[1].replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim(); continue; }
      if (line.length <= 60 && SEC_PROGRESS.test(line)) { group = 'progress'; sawSections = true; }
      else if (line.length <= 60 && SEC_TRANSFER.test(line)) { group = 'transfer'; school = ''; sawSections = true; }
      else if (/institution credit|courses? taken at (the )?university of montana/i.test(line)) { group = 'um'; school = ''; sawSections = true; }
      else if (group === 'transfer' && SCHOOL.test(line) && line.length < 90) school = line.replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      // A transfer row with no course number ("M  -  CALCULUS BC=MATH 155OR165  P  5.000"), e.g. AP credit.
      if (group === 'transfer') { const nc = line.match(/^([A-Z&]{1,5})[\s\t]+-[\s\t]+(.+)$/); if (nc) add('', '', nc[2].split(/[\t ]+/)); }
      const t = line.match(/\b(autumn|fall|spring|summer|winter)\s+(?:semester\s+|session\s+|quarter\s+)?(\d{4})\b/i); if (t) term = `${t[1][0].toUpperCase()}${t[1].slice(1).toLowerCase()} ${t[2]}`;
      continue;
    }
    // A plain list on one line ("WRIT 101, M 115, PSYX 100S"): each code is its own course.
    const all = [...line.matchAll(CODE_G)];
    if (all.length > 1 && !line.replace(CODE_G, ' ').replace(/[\s,;/&]|\band\b/gi, '')) {
      for (const a of all) add(a[1], a[2], []);
      continue;
    }
    add(m[1], m[2], line.slice(line.indexOf(m[0]) + m[0].length).split(/[\t ]+/).map(t => t.replace(/[,;]$/, '')).filter(Boolean));
  }
  return mergeRepeats(out);

  // One course: toks is the rest of its row.
  function add(subjRaw, num, toks) {
    const subj = subjRaw.replace(/\s+/g, ' ');
    if (subj && NOT_SUBJECT.has(subj)) return;
    const code = subj ? `${subj} ${num}` : '';
    // Read the row from the right: an "R" (repeat) flag, number columns (credits,
    // quality points, GPA), then the grade, then the title. Reading right-to-left keeps
    // a title ending in a Roman numeral ("College Writing I") from looking like grade "I".
    if (toks.length > 2 && /^[A-Z]$/.test(toks[toks.length - 1]) && /^\d/.test(toks[toks.length - 2])) toks.pop();
    const nums = [];
    while (toks.length && /^\d{1,3}(\.\d{1,3})?$/.test(toks[toks.length - 1])) nums.unshift(toks.pop());
    let grade = null;
    const last = toks[toks.length - 1] || '';
    if (toks.length > 1 && GRADE.test(last) && group !== 'progress') grade = toks.pop();
    else if (nums.length && GLUED.test(last)) { const g = last.match(GLUED); toks[toks.length - 1] = g[1]; grade = g[2]; }
    const credits = nums.length ? parseFloat(nums[0]) : null;
    if (grade === 'I' && !nums.length) { toks.push('I'); grade = null; }   // "College Chemistry I" with no grade column
    // Drop a leading level column ("10", "01", "02", "UG") and campus words.
    while (toks.length && /^(\d{2}|UG|GR|LD|UD|LDUG|UDUG)$/.test(toks[0])) toks.shift();
    const titleWords = toks.filter(w => !/^(UG|GR|LD|UD|UM|MC|MISSOULA|MSLA|UMM|BITTERROOT)$/i.test(w));
    const known = code ? ctx.findCourse(code) : null;
    const umSubject = subj && ctx.isUMSubject(subj);
    // Without section headings (a pasted list), a code from a subject UM doesn't use is
    // from another school, and one with no credits on the line probably isn't a course.
    let g = group;
    if (!sawSections && g === 'um' && !umSubject) { if (credits === null) return; g = 'transfer'; }
    if (g === 'um' && /^(IP|IN PROGRESS)$/i.test(grade || '')) g = 'progress';
    const tTitle = titleCase(titleWords.join(' ').replace(/\s{2,}/g, ' ').trim()).replace(/=/g, ' = ').replace(/(\d)\s*or\s*(\d)/gi, '$1 or $2').replace(/\s{2,}/g, ' ');
    if (!code && !tTitle) return;
    out.push({
      code, title: (g !== 'transfer' && known ? known.title : tTitle) || (known ? known.title : ''),
      credits, grade, noCredit: !!(grade && NO_CREDIT.test(grade)), group: g,
      school: g === 'transfer' ? (school || 'Another school') : '', term, known: !!known,
      graduate: /^[5-9]\d\d/.test(num || ''),
    });
  }
}
// A course taken more than once (a repeat, or a choir every term) appears once:
// the attempt that earned credit, the latest if several did.
function mergeRepeats(items) {
  const best = new Map(), order = [];
  for (const it of items) {
    const k = `${it.group}|${it.code || it.title}|${it.group === 'transfer' ? it.school : ''}`;
    const b = best.get(k);
    if (!b) { best.set(k, it); order.push(k); }
    else if (!it.noCredit || b.noCredit) best.set(k, it);
  }
  return order.map(k => best.get(k));
}

window.Transcript = { readFile, parse, _pageLines: pageLines };
})();
