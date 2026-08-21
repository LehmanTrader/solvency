/**
 * Renders a report markdown file to a self-contained HTML page and prints it
 * to PDF with headless Chrome. Charts are inlined, so the PDF has no external
 * dependencies. No third-party packages.
 *
 *   node scripts/render-pdf.ts reports/2026-08-cost-per-solved-task.md [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';

const src = resolve(process.argv[2] ?? 'reports/2026-08-cost-per-solved-task.md');
const outDir = resolve(process.argv[3] ?? join(dirname(src), 'build'));
const md = readFileSync(src, 'utf8');
const srcDir = dirname(src);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markup, applied to already-escaped text. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

/** Pull an SVG in as markup so the PDF carries no external references. */
function inlineSvg(rel: string): string {
  // Print build prefers the light chart variant when one exists.
  const light = join(srcDir, rel.replace(/^charts\//, 'charts-light/'));
  const p = existsSync(light) ? light : join(srcDir, rel);
  if (!existsSync(p)) throw new Error(`chart not found: ${p}`);
  const svg = readFileSync(p, 'utf8')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto" ');
  return `<figure>${svg}</figure>`;
}

const lines = md.split('\n');
const out: string[] = [];
let i = 0;

const isBlockStart = (l: string) =>
  /^(#{1,6} |\||> |```|---+$|[-*] |\d+\. |!\[)/.test(l) || /^\s*$/.test(l);

while (i < lines.length) {
  const l = lines[i];

  if (/^\s*$/.test(l)) { i++; continue; }

  if (/^```/.test(l)) {
    const buf: string[] = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    i++;
    out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    continue;
  }

  if (/^!\[([^\]]*)\]\(([^)]+)\)\s*$/.test(l)) {
    out.push(inlineSvg(l.match(/\(([^)]+)\)/)![1]));
    i++;
    continue;
  }

  if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }

  const h = l.match(/^(#{1,6}) (.*)$/);
  if (h) { out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`); i++; continue; }

  if (/^\|/.test(l)) {
    const rows: string[] = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    const cells = (r: string) => r.split('|').slice(1, -1).map((c) => c.trim());
    const head = cells(rows[0]);
    const align = cells(rows[1] ?? '').map((a) => (a.endsWith(':') ? (a.startsWith(':') ? 'center' : 'right') : 'left'));
    const body = rows.slice(2).map(cells);
    out.push(
      `<table><thead><tr>${head.map((c, n) => `<th style="text-align:${align[n] ?? 'left'}">${inline(esc(c))}</th>`).join('')}</tr></thead>` +
      `<tbody>${body.map((r) => `<tr>${r.map((c, n) => `<td style="text-align:${align[n] ?? 'left'}">${inline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
    );
    continue;
  }

  if (/^> /.test(l)) {
    const buf: string[] = [];
    while (i < lines.length && /^> ?/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, ''));
    out.push(`<blockquote>${inline(esc(buf.join(' ')))}</blockquote>`);
    continue;
  }

  const listMatch = (s: string) => s.match(/^(\s*)([-*]|\d+\.) (.*)$/);
  if (listMatch(l)) {
    const ordered = /^\s*\d+\./.test(l);
    const items: string[] = [];
    while (i < lines.length) {
      const m = listMatch(lines[i]);
      if (m) { items.push(m[3]); i++; }
      else if (/^\s+\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
      else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${items.map((t) => `<li>${inline(esc(t))}</li>`).join('')}</${tag}>`);
    continue;
  }

  const buf: string[] = [];
  while (i < lines.length && !isBlockStart(lines[i])) buf.push(lines[i++]);
  if (buf.length) out.push(`<p>${inline(esc(buf.join(' ')))}</p>`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(basename(src))}</title>
<style>
  @page { size: A4; margin: 15mm 13mm 16mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  :root {
    --bg:#FFFFFF; --fg:#23292E; --hi:#0B1013; --muted:#6B767D;
    --accent:#A85F00; --rule:#E2E7EA; --panel:#F6F8F9;
    --sans:-apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif;
    --mono:"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace;
  }
  /* Deliberately light. Chrome paints a page background on the FIRST printed
     page only, and neither a fixed backdrop nor @page background repeats, so a
     dark PDF renders white from page 2. The print build is light throughout and
     uses the light chart variant, rather than being half one theme. */
  html, body { background:var(--bg); }
  body { color:var(--fg); font-family:var(--sans); font-size:9.6pt; line-height:1.55; margin:0; }
  h1,h2,h3 { font-family:var(--mono); color:var(--hi); line-height:1.25; break-after:avoid; }
  h1 { font-size:21pt; letter-spacing:-0.4px; margin:0 0 4pt; }
  h2 { font-size:13pt; margin:20pt 0 7pt; padding-top:8pt; border-top:1px solid var(--rule); }
  h3 { font-size:10.5pt; margin:13pt 0 5pt; color:var(--accent); }
  p { margin:0 0 7pt; }
  a { color:var(--accent); text-decoration:none; border-bottom:1px solid rgba(168,95,0,.35); }
  strong { color:var(--hi); }
  hr { border:0; border-top:1px solid var(--rule); margin:14pt 0; }
  code { font-family:var(--mono); font-size:8.6pt; background:var(--panel); color:var(--accent);
         padding:0.5pt 3pt; border-radius:2px; }
  pre { background:var(--panel); border:1px solid var(--rule); border-radius:3px;
        padding:8pt 10pt; overflow:hidden; break-inside:avoid; margin:0 0 9pt; }
  pre code { background:none; color:var(--fg); padding:0; font-size:8.4pt; line-height:1.5; }
  table { width:100%; border-collapse:collapse; margin:0 0 10pt; font-family:var(--mono);
          font-size:8.3pt; break-inside:avoid; font-variant-numeric:tabular-nums; }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:7.6pt;
       letter-spacing:.4px; text-transform:uppercase; padding:4pt 6pt;
       border-bottom:1px solid var(--accent); }
  td { padding:3.6pt 6pt; border-bottom:1px solid var(--rule); color:var(--fg); }
  td strong { color:var(--accent); }
  blockquote { margin:0 0 10pt; padding:8pt 11pt; background:var(--panel);
               border-left:2px solid var(--accent); color:var(--hi); break-inside:avoid; }
  ul,ol { margin:0 0 9pt; padding-left:15pt; }
  li { margin-bottom:3.5pt; }
  figure { margin:9pt 0 12pt; break-inside:avoid; }
  figure svg { display:block; border:1px solid var(--rule); border-radius:3px; }
  h2, h3 { break-inside:avoid; }
</style></head><body>
<div id="backdrop"></div>
${out.join('\n')}
</body></html>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = join(outDir, basename(src).replace(/\.md$/, '.html'));
const pdfPath = join(outDir, basename(src).replace(/\.md$/, '.pdf'));
writeFileSync(htmlPath, html);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
  '--virtual-time-budget=8000', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
], { stdio: 'pipe' });

console.log(`html: ${htmlPath}`);
console.log(`pdf:  ${pdfPath}`);
