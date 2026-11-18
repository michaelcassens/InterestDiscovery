/* UM Pathfinder — turn a plan into a document.
   The app describes the plan once as simple blocks; this file renders those blocks
   as a Word document (.docx) or as a print view (Print → Save as PDF).

   Blocks: { t: 'h1' | 'h2' | 'h3', text }
           { t: 'p', parts: [{ text, bold?, url? }] }   (or { t: 'p', text })
           { t: 'list', items: [string | parts[]] }
           { t: 'table', caption, head: [string], rows: [[string]] }
   Both outputs are built for WCAG 2.1 AA: real headings, real lists, tables with a
   header row, and the document title and language set. */
(() => {
'use strict';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const partsOf = b => b.parts || [{ text: b.text || '' }];

// ---------- print view ----------
function toHTML(blocks) {
  const inline = parts => parts.map(p => {
    const t = p.bold ? `<strong>${esc(p.text)}</strong>` : esc(p.text);
    return p.url ? `<a href="${esc(p.url)}">${t}</a>` : t;
  }).join('');
  return blocks.map(b => {
    if (/^h[1-3]$/.test(b.t)) return `<${b.t}>${esc(b.text)}</${b.t}>`;
    if (b.t === 'p') return `<p>${inline(partsOf(b))}</p>`;
    if (b.t === 'list') return `<ul>${b.items.map(i => `<li>${inline(Array.isArray(i) ? i : [{ text: i }])}</li>`).join('')}</ul>`;
    if (b.t === 'table') return `<table>${b.caption ? `<caption>${esc(b.caption)}</caption>` : ''}<thead><tr>${b.head.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${b.rows.map(r => `<tr>${r.map((c, k) => k === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return '';
  }).join('\n');
}

// ---------- Word document ----------
const DOCX = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js';
let docxReady = null;
function loadDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  return docxReady ||= new Promise((ok, fail) => {
    const s = document.createElement('script'); s.src = DOCX;
    s.onload = () => ok(window.docx);
    s.onerror = () => { docxReady = null; fail(new Error('Could not load the Word document maker. Check your internet connection, or use “Print or save as PDF” instead.')); };
    document.head.append(s);
  });
}
async function toDocx(blocks, meta) {
  const d = await loadDocx();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ExternalHyperlink, ShadingType } = d;
  const MAROON = '70002E';
  const runs = parts => parts.map(p => p.url
    ? new ExternalHyperlink({ link: p.url, children: [new TextRun({ text: p.text, bold: p.bold, style: 'Hyperlink' })] })
    : new TextRun({ text: p.text, bold: p.bold }));
  const H = { h1: HeadingLevel.TITLE, h2: HeadingLevel.HEADING_1, h3: HeadingLevel.HEADING_2 };
  const children = [];
  for (const b of blocks) {
    if (H[b.t]) children.push(new Paragraph({ text: b.text, heading: H[b.t] }));
    else if (b.t === 'p') children.push(new Paragraph({ children: runs(partsOf(b)), spacing: { after: 120 } }));
    else if (b.t === 'list') b.items.forEach(i => children.push(new Paragraph({ children: runs(Array.isArray(i) ? i : [{ text: i }]), bullet: { level: 0 } })));
    else if (b.t === 'table') {
      if (b.caption) children.push(new Paragraph({ children: [new TextRun({ text: b.caption, bold: true })], spacing: { before: 120, after: 60 } }));
      const cell = (text, head) => new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold: head, color: head ? 'FFFFFF' : undefined })] })],
        shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: MAROON } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ tableHeader: true, children: b.head.map(h => cell(h, true)) }),   // repeats on each page; marked as the header row
               ...b.rows.map(r => new TableRow({ children: r.map(c => cell(c, false)) }))],
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    }
  }
  const doc = new Document({
    title: meta.title, subject: meta.subject, creator: 'UM Pathfinder', description: meta.description,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22, language: { value: 'en-US' } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 40, bold: true, color: MAROON }, paragraph: { spacing: { after: 120 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, color: MAROON }, paragraph: { spacing: { before: 280, after: 100 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 25, bold: true, color: '4F0020' }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

window.PlanDoc = { toHTML, toDocx };
})();
