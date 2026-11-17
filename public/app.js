/* UM Pathfinder — client app. All matching runs in the browser against the
   catalog snapshot served by server.js (refreshed from catalog.umt.edu). */
(() => {
'use strict';
const K = window.KNOWLEDGE;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORE = 'umPathfinder.v1';

// ---------------- state ----------------
const blank = () => ({ programs: [], interests: [], taken: [], planned: [], location: 'Montana', filters: {} });
let S = blank();
try { S = Object.assign(blank(), JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { /* storage unavailable */ }
function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* ignore */ } }

let D = null;               // catalog
const byCode = new Map(), byBase = new Map(), progById = new Map();
const courseToProgs = new Map();   // base code -> [{prog, group}]
let IDF = new Map(), VEC = new Map();
let shown = 30;

// ---------------- text utils ----------------
const STOP = new Set(('a an and are as at be by for from has have in into is it its of on or that the their this to was were will with ' +
  'offered autumn spring summer prereq prereqs coreq credit credits course courses student students consent instr instructor level standing ' +
  'introduction introduces include includes including topic topics study studies emphasis also may using use used through other well basic ' +
  'such how what who which these those both each one two three not only can must required requires missoula college campus mountain ' +
  'semester year years major majors equivalent grade minimum permission department focus provides overview various').split(' '));
function stem(w) {
  if (w.length > 4) {
    if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
    if (w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  }
  return w;
}
function tokens(s) { return (s.toLowerCase().match(/[a-z][a-z0-9+#]+/g) || []).filter(w => !STOP.has(w)).map(stem); }
const normCode = c => String(c).toUpperCase().replace(/\s+/g, ' ').replace(/^([A-Z]{1,5})\s?(\d{3}[A-Z]{0,2})$/, '$1 $2').trim();
const baseOf = c => { const m = normCode(c).match(/^([A-Z]{1,5}) ?(\d{3})/); return m ? `${m[1]} ${m[2]}` : normCode(c); };
const credNum = c => parseFloat((c && c.credits) || '3') || 3;
const typeBadge = p => new RegExp(p.type === 'major' ? 'B\\.|A\\.|Bachelor|Associate' : p.type, 'i').test(p.name) ? '' : ` <span class="badge b-plain">${typeLabel(p.type)}</span>`;
// Type word to show after a program name, unless the name already says it ("... Certificate").
const typeNote = p => new RegExp(p.type, 'i').test(p.name) ? '' : typeLabel(p.type);
const typeLabel = t => ({ major: 'Major', minor: 'Minor', certificate: 'Certificate', licensure: 'Licensure' }[t] || t);

// ---------------- catalog indexing ----------------
function index() {
  const df = new Map();
  for (const c of D.courses) {
    if (c.level >= 500) continue;
    byCode.set(c.code, c);
    if (!byBase.has(c.base)) byBase.set(c.base, c);
    c._title = tokens(c.title); c._desc = tokens(c.desc);
    c._lc = (c.title + ' ' + c.desc).toLowerCase();
    for (const t of new Set([...c._title, ...c._desc])) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = byCode.size;
  for (const [t, n] of df) IDF.set(t, Math.log(N / n));
  for (const c of byCode.values()) {
    const v = new Map();
    for (const t of c._title) v.set(t, (v.get(t) || 0) + 2);
    for (const t of c._desc) v.set(t, (v.get(t) || 0) + 1);
    let norm = 0;
    for (const [t, f] of v) { const w = (1 + Math.log(f)) * (IDF.get(t) || 0); v.set(t, w); norm += w * w; }
    VEC.set(c.code, { v, norm: Math.sqrt(norm) || 1 });
  }
  for (const p of D.programs) {
    progById.set(p.id, p);
    p._codes = new Set();
    p.groups.forEach((g, gi) => g.courses.forEach(x => [x.code, ...x.or].forEach(code => {
      const b = baseOf(code); p._codes.add(b);
      if (!courseToProgs.has(b)) courseToProgs.set(b, []);
      courseToProgs.get(b).push({ prog: p, group: g, gi });
    })));
    p._hours = parseFloat(p.totalHours) || null;
  }
}
function addVec(acc, code, w) {
  const e = VEC.get(code); if (!e) return;
  for (const [t, x] of e.v) acc.set(t, (acc.get(t) || 0) + x * w / e.norm);
}
function cosine(code, acc, accNorm) {
  const e = VEC.get(code); if (!e || !accNorm) return 0;
  let dot = 0;
  for (const [t, x] of e.v) { const y = acc.get(t); if (y) dot += x * y; }
  return dot / (e.norm * accNorm);
}
const vnorm = acc => Math.sqrt([...acc.values()].reduce((s, x) => s + x * x, 0));

// ---------------- profile helpers ----------------
const takenBases = () => new Set(S.taken.map(baseOf));
const plannedBases = () => new Set(S.planned.map(baseOf));
const myProgs = () => S.programs.map(id => progById.get(id)).filter(Boolean);
function homeSubjects() {
  const counts = new Map();
  for (const p of myProgs().filter(p => p.type === 'major')) for (const b of p._codes) { const s = b.split(' ')[0]; counts.set(s, (counts.get(s) || 0) + 1); }
  return new Set([...counts].filter(([, n]) => n >= 3).map(([s]) => s));
}
function findCourse(code) { const n = normCode(code); return byCode.get(n) || byBase.get(baseOf(n)); }

// ---------------- prerequisite evaluation ----------------
const CODE_RE = /\b([A-Z]{1,5})\s?(\d{3})[A-Z]{0,2}\b/g;
function prereqStatus(c, done) {
  if (!c.prereq) return { state: 'none' };
  const clauses = c.prereq.split(/;|\band\b(?![^(]*\))/i).map(s => s.trim().replace(/^[,.\s]+|[,.\s]+$/g, '')).filter(Boolean);
  const missing = [], manual = [];
  for (const cl of clauses) {
    const codes = [...cl.matchAll(CODE_RE)].map(m => `${m[1]} ${m[2]}`);
    if (!codes.length) { manual.push(cl); continue; }
    if (!codes.some(x => done.has(x))) missing.push(cl);
  }
  if (missing.length) return { state: 'missing', missing, text: c.prereq };
  if (manual.length) return { state: 'check', manual, text: c.prereq };
  return { state: 'met', text: c.prereq };
}

// ---------------- interest matching ----------------
function expandInterests(list) {
  const out = [];
  for (const raw of list) {
    const i = raw.toLowerCase().trim(); if (!i) continue;
    const syn = K.synonyms[i] || K.synonyms[i.replace(/s$/, '')] || [];
    out.push({ label: raw, phrases: [...new Set([i, ...syn])] });
  }
  return out;
}
function interestScore(c, exp) {
  let score = 0; const hits = [];
  for (const it of exp) {
    let best = 0;
    for (const ph of it.phrases) {
      let s = 0;
      if (ph.includes(' ')) { if (c._lc.includes(ph)) s = 3 + (c.title.toLowerCase().includes(ph) ? 4 : 0); }
      else {
        const t = stem(ph), idf = Math.min(IDF.get(t) || 0, 6);
        if (!idf) continue;
        const inT = c._title.includes(t) ? 1 : 0, inD = Math.min(c._desc.filter(x => x === t).length, 3);
        s = idf * (3 * inT + inD) / 2;
      }
      if (ph !== it.phrases[0]) s *= 0.7;  // synonyms count a bit less
      best = Math.max(best, s);
    }
    if (best > 0) { score += best; hits.push(it.label); }
  }
  // breadth bonus: matching several interests at once is the point
  if (hits.length > 1) score *= 1 + 0.25 * (hits.length - 1);
  return { score, hits };
}

// ---------------- recommendation engine ----------------
function recommend() {
  const done = takenBases(), plan = plannedBases();
  const progs = myProgs(), home = homeSubjects();
  const q = $('q').value.trim();
  const exp = expandInterests(q ? [q] : S.interests);
  // history vector from what the student has taken (and planned)
  const hist = new Map();
  S.taken.forEach(x => { const c = findCourse(x); c && addVec(hist, c.code, 1); });
  S.planned.forEach(x => { const c = findCourse(x); c && addVec(hist, c.code, 0.5); });
  const hn = vnorm(hist);
  // elective groups in the student's majors, as vectors (for substitution ideas)
  const electiveGroups = [];
  for (const p of progs.filter(p => p.type === 'major')) for (const g of p.groups) {
    if (/all of the following|complete the following|required/i.test(g.rule) || g.courses.length < 3) continue;
    const acc = new Map(); const subj = new Set();
    g.courses.forEach(x => { const c = findCourse(x.code); if (c) { addVec(acc, c.code, 1); subj.add(c.subject); } });
    electiveGroups.push({ p, g, acc, norm: vnorm(acc), subj });
  }
  const f = S.filters;
  const out = [];
  for (const c of byCode.values()) {
    if (done.has(c.base) || c.level < 100 || c.level >= 500) continue;
    if (f.level === 'lower' && c.level >= 300) continue;
    if (f.level === 'upper' && c.level < 300) continue;
    if (f.genEd && !c.genEd.length) continue;
    const outside = !home.has(c.subject);
    if (f.outside && !outside) continue;
    const ints = exp.length ? interestScore(c, exp) : { score: 0, hits: [] };
    if (q && !ints.score) continue;
    const histSim = hn ? cosine(c.code, hist, hn) : 0;
    const pre = prereqStatus(c, done);
    if (f.prereq && pre.state === 'missing') continue;
    const nextAfter = pre.state !== 'missing' && c.prereq ? [...c.prereq.matchAll(CODE_RE)].map(m => `${m[1]} ${m[2]}`).filter(b => done.has(b)) : [];
    // Where it counts
    const links = (courseToProgs.get(c.base) || []);
    const inMine = links.filter(l => S.programs.includes(l.prog.id));
    const feeds = links.filter(l => !S.programs.includes(l.prog.id) && l.prog.type !== 'major');
    if (f.feeds && !inMine.length && !feeds.length && !c.genEd.length) continue;
    // Substitution idea: not listed in the group, but strongly resembles it, from another subject
    let sub = null;
    if (!inMine.length && (ints.score > 0 || histSim > 0.05)) {
      for (const eg of electiveGroups) {
        if (eg.subj.has(c.subject)) continue;
        const sim = cosine(c.code, eg.acc, eg.norm);
        if (sim > 0.2 && (!sub || sim > sub.sim)) sub = { sim, p: eg.p, g: eg.g };
      }
    }
    const progressFeeds = feeds.filter(l => [...l.prog._codes].some(b => done.has(b) || plan.has(b)));
    let score = ints.score + histSim * 10 + (nextAfter.length ? 2 : 0) + (inMine.length ? 1.5 : 0) +
      (progressFeeds.length ? 1.2 : 0) + (sub ? 1 : 0) + (pre.state === 'met' ? 0.4 : 0) - (pre.state === 'missing' ? 1.5 : 0) +
      (outside && exp.length ? 0.3 : 0);
    if (!exp.length && !hn) score = (c.genEd.length ? 1 : 0) + (c.level < 200 ? 0.5 : 0) + (inMine.length ? 1.5 : 0);
    if (exp.length && !ints.score && histSim < 0.08 && !nextAfter.length) continue;
    if (score <= 0.3) continue;
    out.push({ c, score, ints, histSim, pre, nextAfter, inMine, feeds, progressFeeds, sub, outside });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------- rendering: suggestions ----------------
function badge(text, cls) { return `<li class="badge ${cls}">${esc(text)}</li>`; }
// Short label for the card; the full prerequisite text goes in "More details".
function preBadge(pre) {
  if (pre.state === 'none') return badge('No prerequisites', 'b-green');
  if (pre.state === 'met') return badge('Prerequisites met', 'b-green');
  if (pre.state === 'check') return badge('Check prerequisites', 'b-amber');
  const codes = [...new Set(pre.missing.flatMap(cl => [...cl.matchAll(CODE_RE)].map(m => `${m[1]} ${m[2]}`)))];
  return badge(codes.length && codes.length <= 2 ? `Take ${codes.join(' or ')} first` : 'Prerequisite needed first', 'b-red');
}
// A short preview of what the course is about: skip rule sentences ("Restricted to…",
// "Prereq…", "Offered…") and keep sentences until about 80–220 characters.
const RULE_SENT = /^(restricted|open (only )?to|prereq|coreq|offered|same as|cross-?listed|level:|credit|repeatable|may be repeated|students (must|may)|this course (is|may) (restricted|open|repeated)|requires|recommended|consent|graded)/i;
function shortDesc(d) {
  // Drop "Prereq., M 115 or STAT 216." clauses first (their periods confuse sentence splitting).
  const body = d.replace(/\b(?:Prereq|Coreq)[a-z]*\.?,?:?\s*[^.]*\.?/gi, ' ').replace(/\s+/g, ' ').trim() || d;
  const sents = body.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [body];
  let out = '';
  for (const s of sents.map(x => x.trim()).filter(x => /^[A-Z0-9"“(]/.test(x) && !RULE_SENT.test(x))) {
    if (out && (out + ' ' + s).length > 220) break;
    out = out ? out + ' ' + s : s;
    if (out.length >= 80) break;
  }
  if (!out) out = body;
  return out.length > 240 ? out.slice(0, 220).replace(/\s+\S*$/, '') + '…' : out;
}
function updateFilterCount() {
  const f = S.filters, n = ['outside', 'prereq', 'genEd', 'feeds'].filter(k => f[k]).length + (f.level && f.level !== 'all' ? 1 : 0);
  $('filterCount').textContent = n ? ` (${n} on)` : '';
}
function renderSuggestions() {
  const list = recommend();
  const hasInput = S.interests.length || S.taken.length || $('q').value.trim();
  $('suggestLead').innerHTML = hasInput
    ? 'Courses from across UM that match your interests and build on what you’ve taken. The best fits are at the top.' +
      (S.planned.length ? '' : ' <strong>Tip:</strong> click “Save to plan” on any course you like, then open the other tabs to see what it counts toward.')
    : 'These are introductory Gen Ed courses that are good for exploring. For suggestions picked for you, tell Pathfinder a little about yourself. ' +
      '<button type="button" class="btn-small" data-wizard="1">Answer 3 quick questions</button>';
  $('resultCount').textContent = `${list.length.toLocaleString()} matching courses from ${byCode.size.toLocaleString()} in the catalog`;
  updateFilterCount();
  const plan = plannedBases();
  $('results').innerHTML = list.slice(0, shown).map(r => {
    const c = r.c;
    // Why it fits: one short line.
    const why = [];
    if (r.ints.hits.length) why.push(`matches <strong>${r.ints.hits.map(esc).join(', ')}</strong>`);
    if (r.nextAfter.length) why.push(`a next step after ${r.nextAfter.map(esc).join(', ')}`);
    else if (r.histSim > 0.12) why.push('builds on courses you’ve taken');
    const fs = [...new Map((r.progressFeeds.length ? r.progressFeeds : r.feeds).map(l => [l.prog.id, l.prog])).values()];
    // At most three labels on the card: prerequisites, the most useful "counts toward", Gen Ed.
    const b = [preBadge(r.pre)];
    if (r.inMine.length) b.push(badge(`Counts toward your ${r.inMine[0].prog.name}`, 'b-green'));
    else if (r.sub) b.push(badge('Possible substitution: ask your advisor', 'b-amber'));
    else if (fs.length) b.push(badge(`Counts toward ${fs[0].name}${fs.length > 1 ? ` + ${fs.length - 1} more` : ''}`, 'b-blue'));
    if (c.genEd.length) b.push(badge('Gen Ed: ' + c.genEd.join(', '), 'b-plain'));
    // Everything else goes in "More details".
    const more = [];
    r.inMine.forEach(l => more.push(`Counts toward <strong>${esc(l.prog.name)}</strong> (${esc(l.group.section)}).`));
    if (r.sub) more.push(`Possible substitution in <strong>${esc(r.sub.p.name)}</strong> (${esc(r.sub.g.section)}): it closely resembles courses in that group. Ask your advisor whether it can count.`);
    if (fs.length) more.push(`Also counts toward ${fs.length === 1 ? 'this minor or certificate' : `these ${fs.length} minors and certificates`}: ${fs.slice(0, 8).map(p => esc(p.name)).join('; ')}${fs.length > 8 ? '…' : ''}`.replace(/([^.…])$/, '$1.'));
    if (!r.inMine.length && !fs.length && !c.genEd.length) more.push('A free elective that adds breadth to your experience.');
    if (r.outside) more.push(`Taught outside your major’s department, by ${esc(c.subjectName)}.`);
    if (r.pre.text) more.push(`Prerequisites, as written in the catalog: ${esc(r.pre.text)}`);
    const inPlan = plan.has(c.base);
    const shortD = shortDesc(c.desc);
    return `<li class="card">
      <h3><span class="code">${esc(c.code)}</span> ${esc(c.title)}</h3>
      <p class="meta">${esc(c.subjectName)} · ${esc(c.credits || '?')} credits${c.offered ? ' · ' + esc(c.offered) : ''}</p>
      ${why.length ? `<p class="why"><span class="why-label">Why it fits:</span> ${why.join(', ')}</p>` : ''}
      <p class="desc">${esc(shortD)}</p>
      <ul class="badges" aria-label="Key facts about ${esc(c.code)}">${b.join('')}</ul>
      <details class="more">
        <summary>More details<span class="sr-only"> about ${esc(c.code)}</span></summary>
        ${shortD !== c.desc ? `<p class="desc">${esc(c.desc)}</p>` : ''}
        ${more.length ? `<ul class="more-list">${more.map(m => `<li>${m}</li>`).join('')}</ul>` : ''}
        <p><a href="${esc(c.url)}" target="_blank" rel="noopener">See ${esc(c.code)} in the official catalog<span class="sr-only"> (opens in new tab)</span></a></p>
      </details>
      <div class="card-actions">
        <button type="button" data-plan="${esc(c.code)}" aria-pressed="${inPlan}">${inPlan ? 'In my plan ✓' : 'Save to plan'}</button>
        <button type="button" class="btn-ghost" data-took="${esc(c.code)}">I’ve taken this</button>
      </div></li>`;
  }).join('') || '<li class="empty">No courses match. Try turning off a filter under “Narrow the list”, or add a broader interest.</li>';
  $('moreBtn').hidden = list.length <= shown;
}

// Empty tab: say what will appear here, and offer a button to the setup step that fills it.
function emptyState(text, actions) {
  return `<div class="empty"><p>${esc(text)}</p><div class="empty-actions">${actions.map(([n, label]) => `<button type="button" data-wizard="${n}">${esc(label)}</button>`).join('')}</div></div>`;
}

// ---------------- rendering: requirements ----------------
function statusFor(codes, done, plan) {
  const bs = codes.map(baseOf);
  if (bs.some(b => done.has(b))) return '<span class="st st-done">✓ Taken</span>';
  if (bs.some(b => plan.has(b))) return '<span class="st st-plan">◐ Planned</span>';
  return '<span class="st st-no">○ Not yet</span>';
}
function renderReqs() {
  const done = takenBases(), plan = plannedBases();
  const progs = myProgs();
  if (!progs.length) { $('reqs').innerHTML = emptyState('Add your major, minor or certificate, and its requirements from the official catalog will show up here, with the courses you’ve finished checked off.', [[1, 'Add what I study']]); return; }
  $('reqs').innerHTML = progs.map(p => {
    const all = [...p._codes]; const d = all.filter(b => done.has(b)).length;
    let section = '';
    const groups = p.groups.map(g => {
      const head = g.section !== section ? `<h4>${esc(section = g.section)}</h4>` : '';
      const got = g.courses.filter(x => [x.code, ...x.or].some(k => done.has(baseOf(k)))).length;
      return `${head}<p class="rule">${esc(g.rule)}${g.credits ? ` (${esc(g.credits)} credits)` : ''} — ${got} of ${g.courses.length} listed taken</p>
        <ul class="req-list">${g.courses.map(x => {
          const c = findCourse(x.code);
          return `<li>${statusFor([x.code, ...x.or], done, plan)} ${esc(x.code)}${x.or.length ? ' or ' + x.or.map(esc).join(' or ') : ''} — ${esc(x.title || c?.title || '')}</li>`;
        }).join('')}</ul>`;
    }).join('');
    return `<article class="prog"><h3>${esc(p.name)}${typeBadge(p)}</h3>
      <p class="meta">${p.totalHours ? `${esc(p.totalHours)} total credits · ` : ''}${d} of ${all.length} listed courses taken · <a href="${esc(p.url)}" target="_blank" rel="noopener">Official requirements<span class="sr-only"> for ${esc(p.name)} (opens in new tab)</span></a></p>
      ${p.overview ? `<p class="desc">${esc(p.overview.slice(0, 500))}${p.overview.length > 500 ? '…' : ''}</p>` : ''}
      ${groups}</article>`;
  }).join('');
}

// ---------------- rendering: minors & certificates ----------------
function renderMinors() {
  const done = takenBases(), plan = plannedBases();
  const exp = expandInterests(S.interests);
  const rows = [];
  for (const p of D.programs) {
    if (p.type === 'major' || S.programs.includes(p.id)) continue;
    const codes = [...p._codes];
    const d = codes.filter(b => done.has(b)), pl = codes.filter(b => plan.has(b) && !done.has(b));
    const credits = [...d, ...pl].reduce((s, b) => s + credNum(byBase.get(b)), 0);
    let fit = 0; const fitHits = new Set();
    if (exp.length) for (const b of codes) { const c = byBase.get(b); if (!c) continue; const r = interestScore(c, exp); fit += Math.min(r.score, 6); r.hits.forEach(h => fitHits.add(h)); }
    fit = codes.length ? fit / Math.sqrt(codes.length) : 0;
    // Courses listed in many programs (WRIT 101, M 115…) say little about fit.
    const spec = b => 1 / Math.max(1, Math.log2((courseToProgs.get(b) || []).length));
    const score = d.reduce((s, b) => s + 3 * spec(b), 0) + pl.reduce((s, b) => s + 2 * spec(b), 0) + fit;
    if (score <= 0.5) continue;
    rows.push({ p, d, pl, credits, fit, fitHits: [...fitHits], score });
  }
  rows.sort((a, b) => b.score - a.score);
  if (!rows.length) { $('minors').innerHTML = emptyState('Many students are closer to a minor or certificate than they think. Add your interests or the courses you’ve taken, and Pathfinder will show which ones you’re building toward.', [[2, 'Add my interests'], [3, 'Add courses I’ve taken']]); return; }
  $('minors').innerHTML = rows.slice(0, 15).map(r => {
    const p = r.p; const pct = p._hours ? Math.min(100, Math.round(100 * r.credits / p._hours)) : null;
    const remaining = [...p._codes].filter(b => !done.has(b) && !plan.has(b)).map(b => byBase.get(b)).filter(Boolean);
    const exp2 = expandInterests(S.interests);
    remaining.sort((a, b) => (exp2.length ? interestScore(b, exp2).score - interestScore(a, exp2).score : 0));
    return `<article class="prog"><h3>${esc(p.name)}${typeBadge(p)}</h3>
      <p class="meta">${r.d.length} taken · ${r.pl.length} planned${p.totalHours ? ` · about ${r.credits} of ${esc(p.totalHours)} credits` : ''}${r.fitHits.length ? ` · fits your interest in ${r.fitHits.map(esc).join(', ')}` : ''}</p>
      ${pct !== null ? `<div class="meter" role="img" aria-label="About ${pct}% of credits complete or planned"><span style="width:${pct}%"></span></div>` : ''}
      ${r.d.length ? `<p class="rule">Already counts: ${r.d.map(esc).join(', ')}</p>` : ''}
      <p class="rule">Courses to look at next: ${remaining.slice(0, 6).map(c => `${esc(c.code)} ${esc(c.title)}`).join(' · ') || '—'}</p>
      <a href="${esc(p.url)}" target="_blank" rel="noopener">See the official ${esc(p.name)} requirements<span class="sr-only"> (opens in new tab)</span></a></article>`;
  }).join('');
}

// ---------------- rendering: careers ----------------
function domainProfile() {
  const scores = new Map(K.domains.map(d => [d.id, 0]));
  const sources = new Map(K.domains.map(d => [d.id, new Set()]));
  const consider = [...S.taken.map(c => [c, 1]), ...S.planned.map(c => [c, 0.7])];
  for (const p of myProgs()) for (const b of p._codes) consider.push([b, p.type === 'major' ? 0.25 : 0.4]);
  for (const [code, w] of consider) {
    const c = findCourse(code); if (!c) continue;
    for (const d of K.domains) {
      let s = d.subjects.includes(c.subject) ? 2 : 0;
      s += d.keywords.filter(k => c._lc.includes(k)).length * 0.5;
      if (s) { scores.set(d.id, scores.get(d.id) + s * w * credNum(c) / 3); if (w >= 0.7) sources.get(d.id).add(c.code); }
    }
  }
  for (const i of S.interests.map(x => x.toLowerCase())) for (const d of K.domains) {
    if (d.keywords.some(k => k.includes(i) || i.includes(k)) || d.name.toLowerCase().includes(i)) scores.set(d.id, scores.get(d.id) + 4);
  }
  const max = Math.max(...scores.values(), 1);
  return K.domains.map(d => ({ d, score: scores.get(d.id), pct: Math.round(100 * scores.get(d.id) / max), src: [...sources.get(d.id)] }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}
function jobLinks(role) {
  const loc = (S.location || '').trim(); const q = encodeURIComponent(role); const l = encodeURIComponent(loc);
  return `<div class="links">
    <a href="https://www.linkedin.com/jobs/search/?keywords=${q}${loc ? '&location=' + l : ''}" target="_blank" rel="noopener">LinkedIn jobs<span class="sr-only"> for ${esc(role)} (opens in new tab)</span></a>
    <a href="https://www.indeed.com/jobs?q=${q}${loc ? '&l=' + l : ''}" target="_blank" rel="noopener">Indeed<span class="sr-only"> listings for ${esc(role)} (opens in new tab)</span></a>
    <a href="https://www.usajobs.gov/Search/Results?k=${q}${loc ? '&l=' + l : ''}" target="_blank" rel="noopener">USAJOBS<span class="sr-only"> for ${esc(role)} (opens in new tab)</span></a>
    <a href="https://www.onetonline.org/find/quick?s=${q}" target="_blank" rel="noopener">O*NET skills &amp; pay<span class="sr-only"> for ${esc(role)} (opens in new tab)</span></a>
  </div>`;
}
function renderCareers() {
  const prof = domainProfile();
  if (!prof.length) { $('careers').innerHTML = emptyState('Tell Pathfinder what you study or what you’re curious about. It will show the skills you’re building, the careers they lead to, and links to live job listings.', [[1, 'Get started']]); return; }
  const top = prof.slice(0, 4); const ids = new Set(top.map(x => x.d.id));
  const combos = K.combos.filter(c => ids.has(c.a) && ids.has(c.b));
  $('careers').innerHTML = `
    <h3>Your skill profile</h3>
    ${top.map(x => `<div class="dom"><div class="dom-head"><span>${esc(x.d.name)}</span><span>${x.pct}% of your strongest area</span></div>
      <div class="meter" aria-hidden="true"><span style="width:${x.pct}%"></span></div>
      ${x.src.length ? `<p class="rule">From: ${x.src.slice(0, 8).map(esc).join(', ')}</p>` : '<p class="rule">From your interests and program choices</p>'}</div>`).join('')}
    <div class="cols">
      <div><h3>Learning outcomes you're developing</h3><ul>${top.flatMap(x => x.d.outcomes.map(o => `<li>${esc(o)} <span class="k">(${esc(x.d.name)})</span></li>`)).join('')}</ul></div>
      <div><h3>${combos.length ? 'Hybrid roles your combination opens' : 'Combine areas to open hybrid roles'}</h3>
        ${combos.length ? combos.map(c => `<div class="role"><h4>${c.roles.map(esc).join(' · ')}</h4><p class="rule">${esc(c.why)}</p>${jobLinks(c.roles[0])}</div>`).join('')
          : '<p class="rule">Your strongest areas don’t yet pair into a recognized hybrid. Try a course from a different area in “Course ideas”.</p>'}
      </div>
    </div>
    <h3>Roles to explore in each area</h3>
    ${top.slice(0, 3).map(x => `<h4>${esc(x.d.name)}</h4>${x.d.careers.slice(0, 4).map(r => `<div class="role"><h4>${esc(r)}</h4>${jobLinks(r)}</div>`).join('')}`).join('')}
    <p class="hint">Job links open live searches on each site. LinkedIn may ask you to sign in. Also search UM’s Handshake through the Career Development office. O*NET (U.S. Dept. of Labor) lists the skills, education and typical pay for each role so you can compare against your coursework.</p>`;
}

// ---------------- rendering: why ----------------
function renderWhy() {
  const prof = domainProfile().slice(0, 3);
  const majors = myProgs().filter(p => p.type === 'major').map(p => p.name);
  let personal = '';
  const names = prof.map(x => `<strong>${esc(x.d.name)}</strong>`);
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
  if (prof.length >= 2) personal = `<div class="callout"><h3>Your path so far</h3><p>Your coursework and interests draw on ${list}${majors.length ? `, alongside your ${majors.map(esc).join(' and ')} program` : ''}. That combination lets you describe yourself to employers and graduate programs as someone who can work between fields — e.g. ${esc((K.combos.find(c => prof.some(x => x.d.id === c.a) && prof.some(x => x.d.id === c.b)) || { roles: ['a team member who translates between specialists'] }).roles[0])}.</p></div>`;
  $('whyPersonal').innerHTML = personal;
  $('why').innerHTML = K.whyInterdisciplinary.map(w => `<div class="why-item"><h3>${esc(w.h)}</h3><p>${esc(w.p)}</p></div>`).join('') +
    `<div class="why-item"><h3>How to talk about it</h3><p>On a résumé or in an interview, name the combination and the problem it lets you solve: “I paired my ${esc(majors[0] || 'major')} with coursework in ${esc(prof[1]?.d.name || 'another field')} so I can ${esc((prof[1]?.d.outcomes[0] || 'bring a second perspective to my team').toLowerCase())}.”</p></div>`;
}

// ---------------- profile UI ----------------
function chip(label, key, kind, extra) {
  return `<li><span>${esc(label)}${extra ? ` <span class="k">${esc(extra)}</span>` : ''}</span><button type="button" data-remove="${kind}" data-key="${esc(key)}" aria-label="Remove ${esc(label)}">×</button></li>`;
}
function renderProfile() {
  $('progChips').innerHTML = myProgs().map(p => chip(p.name, p.id, 'programs', typeNote(p))).join('');
  $('intChips').innerHTML = S.interests.map(i => chip(i, i, 'interests')).join('');
  $('takenChips').innerHTML = S.taken.map(c => chip(c, c, 'taken', findCourse(c)?.title)).join('');
  $('planChips').innerHTML = S.planned.map(c => chip(c, c, 'planned', findCourse(c)?.title)).join('');
  $('planEmpty').hidden = S.planned.length > 0;
  $('intIdeas').innerHTML = IDEAS.filter(i => !S.interests.includes(i)).slice(0, 10).map(i => `<button type="button" data-idea="${esc(i)}">+ ${esc(i)}</button>`).join('');
  renderWizard();
}
const IDEAS = ['climate', 'games', 'data', 'storytelling', 'health', 'indigenous', 'music', 'business', 'wildlife', 'AI', 'justice', 'design',
  'teaching', 'outdoors', 'film', 'psychology', 'writing', 'art', 'law', 'science', 'sports', 'travel', 'helping people', 'technology'];
function renderAll() {
  save(); renderProfile();
  if (!D) return;           // catalog still loading; the rest renders once it arrives
  renderSuggestions(); renderReqs(); renderMinors(); renderCareers(); renderWhy();
}
const wizardOpen = () => !$('wizard').hidden;
function say(msg) { $(wizardOpen() ? 'wMsg' : 'profileMsg').textContent = msg; }
const notReady = () => D ? false : (say('The course catalog is still loading. Try again in a moment.'), true);

// Several programs can match what a student types ("biology" → 10+). Then show them as
// buttons to choose from instead of silently picking the first.
const pickBox = inp => $(inp.id === 'wProg' ? 'wProgPick' : 'progPick');
function addProgramId(id, inp) {
  const p = progById.get(id); if (!p) return;
  if (!S.programs.includes(p.id)) S.programs.push(p.id);
  if (inp) { inp.value = ''; pickBox(inp).innerHTML = ''; }
  say(`Added ${p.name}`.replace(/([^.])$/, '$1.')); renderAll();
}
function addProgram(inp = $('progInput')) {
  const raw = inp.value.trim(), v = raw.toLowerCase(); if (!v || notReady()) return;
  const exact = D.programs.find(p => `${p.name} (${typeLabel(p.type)})`.toLowerCase() === v) || D.programs.find(p => p.name.toLowerCase() === v);
  if (exact) return addProgramId(exact.id, inp);
  const words = v.split(/\s+/);
  const matches = D.programs.filter(p => words.every(w => p.name.toLowerCase().includes(w)) && !S.programs.includes(p.id))
    .sort((a, b) => (a.type === 'major' ? 0 : 1) - (b.type === 'major' ? 0 : 1) || a.name.localeCompare(b.name));
  if (matches.length === 1) return addProgramId(matches[0].id, inp);
  if (!matches.length) { pickBox(inp).innerHTML = ''; return say(`No program matches “${raw}”. Try fewer letters, like “bio” or “art”.`); }
  const box = pickBox(inp);
  box.innerHTML = `<p class="pick-q">${matches.length} programs match “${esc(raw)}”. Which one?</p><div class="pick-list">` +
    matches.slice(0, 12).map(p => `<button type="button" class="btn-ghost" data-addprog="${esc(p.id)}" data-for="${inp.id}">${esc(p.name)} <span class="k">${typeNote(p)}</span></button>`).join('') +
    `</div>${matches.length > 12 ? `<p class="hint">Showing 12 of ${matches.length}. Type more of the name to narrow it down.</p>` : ''}`;
  say(`${matches.length} programs match. Choose one from the buttons below the box.`);
  box.querySelector('button').focus();
}
function addInterest(v, inp = $('intInput')) {
  v = (v ?? inp.value).trim(); if (!v) return;
  v.split(/,\s*/).forEach(x => x && !S.interests.includes(x) && S.interests.push(x));
  inp.value = ''; shown = 30; say(`Added “${v}”.`); renderAll();
}
function toggleInterest(v) {
  if (S.interests.includes(v)) { S.interests = S.interests.filter(x => x !== v); say(`Removed “${v}”.`); renderAll(); }
  else addInterest(v);
}
function addTaken(raw) {
  if (notReady()) return;
  const codes = [...String(raw).toUpperCase().matchAll(/\b([A-Z]{1,5})\s?(\d{3}[A-Z]{0,2})\b/g)].map(m => `${m[1]} ${m[2]}`);
  let added = 0, unknown = [];
  for (const code of codes) {
    const c = findCourse(code); const k = c ? c.code : code;
    if (!c) unknown.push(code);
    if (!S.taken.some(t => baseOf(t) === baseOf(k))) { S.taken.push(k); added++; }
    S.planned = S.planned.filter(t => baseOf(t) !== baseOf(k));
  }
  say(codes.length ? `Added ${added} course${added === 1 ? '' : 's'}.${unknown.length ? ` Not in the current catalog (kept anyway): ${unknown.join(', ')}.` : ''}` : 'Enter a course code like CSCI 135.');
  renderAll();
}

// ---------------- suggestion dropdown (ARIA 1.2 combobox) ----------------
// Our own list instead of <datalist>, which doesn't show reliably (hidden
// containers, iPhone Safari) and can't be styled or announced consistently.
function attachCombo(input, { source, onPick, onEnter, label }) {
  const wrap = document.createElement('div'); wrap.className = 'combo';
  input.replaceWith(wrap); wrap.append(input);
  const list = document.createElement('ul');
  list.id = input.id + '-list'; list.className = 'combo-list'; list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label); list.hidden = true; wrap.append(list);
  Object.entries({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': list.id }).forEach(([k, v]) => input.setAttribute(k, v));
  let items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const highlight = i => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', k === i));
    if (i >= 0) { input.setAttribute('aria-activedescendant', list.children[i].id); list.children[i].scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const open = () => {
    items = D ? source(input.value.trim()) : [];
    if (!items.length) return close();
    list.innerHTML = items.map((it, k) => `<li role="option" id="${list.id}-${k}" aria-selected="false"><span class="opt-main">${esc(it.label)}</span>${it.sub ? ` <span class="opt-sub">${esc(it.sub)}</span>` : ''}</li>`).join('');
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
  };
  const pick = i => { const it = items[i]; close(); onPick(it); };
  input.addEventListener('input', open);
  input.addEventListener('focus', () => { if (input.value.trim()) open(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', e => {
    const isOpen = !list.hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen) open(); else highlight(Math.min(active + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp' && isOpen) { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (isOpen && active >= 0) pick(active); else { close(); onEnter(); } }
  });
  list.addEventListener('mousedown', e => e.preventDefault());   // keep focus in the input
  list.addEventListener('click', e => { const li = e.target.closest('[role=option]'); if (li) pick([...list.children].indexOf(li)); });
}
function programMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return [];
  return D.programs.filter(p => !S.programs.includes(p.id) && words.every(w => p.name.toLowerCase().includes(w)))
    .sort((a, b) => (b.name.toLowerCase().startsWith(words[0]) - a.name.toLowerCase().startsWith(words[0])) ||
      ((a.type === 'major' ? 0 : 1) - (b.type === 'major' ? 0 : 1)) || a.name.localeCompare(b.name))
    .slice(0, 10).map(p => ({ id: p.id, label: p.name, sub: typeNote(p) }));
}
function courseMatches(q) {
  const n = q.toUpperCase().replace(/\s+/g, ' ').trim(); if (n.length < 2) return [];
  const compact = n.replace(/\s/g, ''), words = q.toLowerCase().split(/\s+/).filter(Boolean), done = takenBases(), out = [];
  for (const c of byCode.values()) {
    if (done.has(c.base) || c.level >= 500) continue;
    const codeHit = c.code.replace(/\s/g, '').startsWith(compact);
    const titleHit = words.every(w => c.title.toLowerCase().includes(w));
    if (codeHit || titleHit) out.push({ c, rank: codeHit ? 0 : 1 });
  }
  return out.sort((a, b) => a.rank - b.rank || a.c.code.localeCompare(b.c.code, undefined, { numeric: true }))
    .slice(0, 10).map(({ c }) => ({ id: c.code, label: c.code, sub: c.title }));
}
const comboFor = {
  program: inp => attachCombo(inp, { label: 'Matching programs', source: programMatches,
    onPick: it => { addProgramId(it.id, inp); inp.focus(); }, onEnter: () => addProgram(inp) }),
  course: inp => attachCombo(inp, { label: 'Matching courses', source: courseMatches,
    onPick: it => { addTaken(it.id); inp.value = ''; inp.focus(); }, onEnter: () => { addTaken(inp.value); inp.value = ''; } }),
};

// ---------------- guided setup ----------------
let wStep = 1;
const wHas = n => [S.programs, S.interests, S.taken][n - 1].length > 0;
function renderWizard() {
  $('wProgChips').innerHTML = myProgs().map(p => chip(p.name, p.id, 'programs', typeNote(p))).join('');
  $('wIntChips').innerHTML = S.interests.map(i => chip(i, i, 'interests')).join('');
  $('wTakenChips').innerHTML = S.taken.map(c => chip(c, c, 'taken', findCourse(c)?.title)).join('');
  const ideas = [...new Set([...IDEAS, ...S.interests.filter(i => IDEAS.includes(i))])];
  $('wIdeas').innerHTML = ideas.map(i => `<button type="button" data-toggle="${esc(i)}" aria-pressed="${S.interests.includes(i)}">${esc(i)}</button>`).join('');
  const last = wStep === 3;
  $('wNext').textContent = wHas(wStep) ? (last ? 'Show my course ideas' : 'Next') : (last ? 'Skip and show my course ideas' : 'Skip this step');
}
function wGo(n, focus = true) {
  wStep = n;
  document.querySelectorAll('.wiz-step').forEach(s => { s.hidden = +s.dataset.step !== n; });
  document.querySelectorAll('#wizSteps li').forEach(li => {
    const k = +li.dataset.step;
    if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    li.classList.toggle('done', k < n);
    li.querySelector('.num').textContent = k < n ? '✓' : k;
    let sr = li.querySelector('.sr-only'); if (!sr) { sr = document.createElement('span'); sr.className = 'sr-only'; li.append(sr); }
    sr.textContent = k < n ? ' (done)' : k === n ? ' (current step)' : '';
  });
  $('wBack').hidden = n === 1; $('wMsg').textContent = '';
  renderWizard();
  if (focus) document.querySelector(`.wiz-step[data-step="${n}"] h3`).focus();
}
function wizShow(n = 1, focus = true) {
  $('helpDialog').open && $('helpDialog').close();
  $('wizard').hidden = false; $('layout').hidden = true;
  window.scrollTo(0, 0); wGo(n, focus);
}
function wizFinish() {
  S.onboarded = true;
  $('wizard').hidden = true; $('layout').hidden = false;
  renderAll();
  selectTab($('tab-suggest')); window.scrollTo(0, 0); $('main').focus();
  const n = S.interests.length + S.taken.length + S.programs.length;
  say(n ? 'Your course ideas are ready. You can edit your answers on the left at any time.' : 'Explore freely. Add answers on the left whenever you like.');
}
$('wNext').onclick = () => wStep < 3 ? wGo(wStep + 1) : wizFinish();
$('wBack').onclick = () => wGo(wStep - 1);
$('wExit').onclick = wizFinish;
$('wProgAdd').onclick = () => addProgram($('wProg'));
comboFor.program($('wProg'));
$('wIntAdd').onclick = () => addInterest(undefined, $('wInt'));
$('wInt').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addInterest(undefined, $('wInt')); } };
$('wTakenAdd').onclick = () => { addTaken($('wTaken').value); $('wTaken').value = ''; };
comboFor.course($('wTaken'));
$('wPasteBtn').onclick = () => { addTaken($('wPaste').value); $('wPaste').value = ''; };
$('wizAgain').onclick = () => wizShow(1);
// Help dialog
$('helpBtn').onclick = () => $('helpDialog').showModal();
$('helpClose').onclick = () => $('helpDialog').close();
$('helpWizard').onclick = () => wizShow(1);

// ---------------- tabs ----------------
function selectTab(btn) {
  document.querySelectorAll('[role=tab]').forEach(t => { const on = t === btn; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; $(t.getAttribute('aria-controls')).hidden = !on; });
}
$('tabs').addEventListener('click', e => { const t = e.target.closest('[role=tab]'); t && selectTab(t); });
$('tabs').addEventListener('keydown', e => {
  const tabs = [...document.querySelectorAll('[role=tab]')]; const i = tabs.indexOf(document.activeElement);
  let n = null;
  if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
  if (n !== null) { e.preventDefault(); tabs[n].focus(); selectTab(tabs[n]); }
});

// ---------------- events ----------------
$('progAdd').onclick = addProgram;
// Use statement bodies: an on* handler that returns false cancels the keystroke.
comboFor.program($('progInput'));
$('intAdd').onclick = () => addInterest();
$('intInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addInterest(); } };
$('takenAdd').onclick = () => { addTaken($('takenInput').value); $('takenInput').value = ''; };
comboFor.course($('takenInput'));
$('takenPasteBtn').onclick = () => { addTaken($('takenPaste').value); $('takenPaste').value = ''; };
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.remove) {
    const k = t.dataset.remove; S[k] = S[k].filter(x => x !== t.dataset.key); say('Removed.'); renderAll();
    // The removed chip's button is gone; put focus somewhere sensible.
    if (wizardOpen()) $(['wProg', 'wInt', 'wTaken'][wStep - 1]).focus();
  }
  else if (t.dataset.addprog) { const inp = $(t.dataset.for); addProgramId(t.dataset.addprog, inp); inp.focus(); }
  else if (t.dataset.wizard) wizShow(+t.dataset.wizard);
  else if (t.dataset.toggle) toggleInterest(t.dataset.toggle);
  else if (t.dataset.idea) addInterest(t.dataset.idea);
  else if (t.dataset.plan) {
    const code = t.dataset.plan, b = baseOf(code);
    S.planned = S.planned.some(x => baseOf(x) === b) ? S.planned.filter(x => baseOf(x) !== b) : [...S.planned, code];
    say(`${code} ${S.planned.some(x => baseOf(x) === b) ? 'saved to' : 'removed from'} your plan.`); renderAll();
  } else if (t.dataset.took) addTaken(t.dataset.took);
});
let qTimer; $('q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => { shown = 30; renderSuggestions(); }, 250); };
[['fOutside', 'outside'], ['fPrereq', 'prereq'], ['fGenEd', 'genEd'], ['fFeeds', 'feeds']].forEach(([id, k]) => {
  $(id).checked = !!S.filters[k]; $(id).onchange = () => { S.filters[k] = $(id).checked; shown = 30; save(); renderSuggestions(); };
});
$('fLevel').value = S.filters.level || 'all';
// Keep the filter panel open when filters are already on, so they're never hidden.
updateFilterCount(); $('narrow').open = $('filterCount').textContent !== '';
$('fLevel').onchange = () => { S.filters.level = $('fLevel').value; save(); renderSuggestions(); };
$('moreBtn').onclick = () => { shown += 30; renderSuggestions(); };
// Job links change only when the student presses the button (or Enter), with a confirmation.
const locMsg = l => l ? `Job links now search ${l}.` : 'Job links now search everywhere.';
function syncLoc() { $('loc').value = S.location || ''; $('locStatus').textContent = locMsg((S.location || '').trim()); }
syncLoc();
$('locForm').onsubmit = e => {
  e.preventDefault();
  S.location = $('loc').value.trim(); $('loc').value = S.location;
  save(); renderCareers();
  $('locStatus').textContent = locMsg(S.location);
};
$('resetBtn').onclick = () => { if (confirm('Clear your programs, interests and courses?')) { S = blank(); syncLoc(); renderAll(); wizShow(1); say('Cleared. Let’s start again.'); } };
$('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify({ ...S, exportedAt: new Date().toISOString(), catalog: D.catalogYear }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'um-pathfinder-plan.json'; a.click(); URL.revokeObjectURL(a.href);
};
$('importFile').onchange = async e => {
  try { const j = JSON.parse(await e.target.files[0].text()); S = Object.assign(blank(), j); syncLoc(); renderAll(); say('Plan loaded.'); }
  catch { say('That file isn’t a Pathfinder plan.'); }
  e.target.value = '';
};

// ---------------- catalog loading / refresh ----------------
// API base: '' when the page is served by server.js itself; the Render URL when
// the page is hosted on GitHub Pages (set in config.js).
const API = (window.PATHFINDER_API || '').replace(/\/+$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function status() {
  let s = null;
  // Free cloud servers sleep when idle; keep trying while it wakes up (~1 min).
  for (let i = 0; !s; i++) {
    try { const r = await fetch(API + '/api/status'); if (r.ok) s = await r.json(); } catch { /* still waking */ }
    if (!s) {
      if (i > 60) throw new Error('the catalog server is not responding. Try again in a few minutes.');
      $('catStatus').textContent = 'Waking up the catalog server — this can take up to a minute…';
      await sleep(3000);
    }
  }
  if (s.crawl.running) $('catStatus').textContent = `Updating from catalog.umt.edu: ${s.crawl.phase} (${s.crawl.done}/${s.crawl.total})`;
  else if (s.fetchedAt) $('catStatus').textContent = `${s.catalogYear || 'UM Catalog'} · ${s.courses.toLocaleString()} courses, ${s.programs} programs · checked ${new Date(s.fetchedAt).toLocaleDateString()}`;
  return s;
}
$('refreshBtn').onclick = async () => {
  const r = await fetch(API + '/api/refresh', { method: 'POST' }).then(x => x.json()).catch(() => ({}));
  if (!r.started) { $('catStatus').textContent = r.message || 'Could not start an update right now.'; return; }
  $('refreshBtn').disabled = true;
  const poll = setInterval(async () => { const s = await status(); if (!s.crawl.running) { clearInterval(poll); $('refreshBtn').disabled = false; await load(); } }, 2000);
};
async function load() {
  let s = await status();
  while (!s.fetchedAt) { await sleep(2500); s = await status(); }
  D = await (await fetch(API + '/api/catalog')).json();
  byCode.clear(); byBase.clear(); progById.clear(); courseToProgs.clear(); IDF = new Map(); VEC = new Map();
  index();
  S.programs = S.programs.filter(id => progById.has(id));
  await status();
  renderAll();
}
// First visit (nothing entered yet): start with the guided setup.
renderProfile();
if (!S.onboarded && !S.programs.length && !S.interests.length && !S.taken.length) wizShow(1, false);
load().catch(err => { $('catStatus').textContent = 'Could not load the catalog: ' + err.message; });
})();
