/**
 * Converts a markdown file to .docx via HTML and macOS `textutil`.
 *   node scripts/docx.ts docs/outreach/emails.md [outPath]
 * No third-party packages: textutil ships with macOS and writes real .docx.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname, basename } from 'node:path';

const src = resolve(process.argv[2] ?? 'docs/outreach/emails.md');
const out = resolve(process.argv[3] ?? join(dirname(src), basename(src).replace(/\.md$/, '.docx')));
const md = readFileSync(src, 'utf8');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) => s
  .replace(/`([^`]+)`/g, (_, c) => `<span style="font-family:Menlo,monospace">${c}</span>`)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`)
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');

const lines = md.split('\n');
const html: string[] = [];
let i = 0;
const blockStart = (l: string) => /^(#{1,6} |\||> |```|---+$|[-*] |\d+\. )/.test(l) || /^\s*$/.test(l);

while (i < lines.length) {
  const l = lines[i];
  if (/^\s*$/.test(l)) { i++; continue; }
  if (/^```/.test(l)) {
    const buf: string[] = []; i++;
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    i++;
    html.push(`<pre style="font-family:Menlo,monospace;font-size:9pt;background:#F4F4F2">${esc(buf.join('\n'))}</pre>`);
    continue;
  }
  if (/^---+\s*$/.test(l)) { html.push('<hr>'); i++; continue; }
  const h = l.match(/^(#{1,6}) (.*)$/);
  if (h) { html.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`); i++; continue; }
  if (/^\|/.test(l)) {
    const rows: string[] = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    const cells = (r: string) => r.split('|').slice(1, -1).map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    html.push(`<table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse;font-size:10pt">` +
      `<tr>${head.map((c) => `<th align="left">${inline(esc(c))}</th>`).join('')}</tr>` +
      body.map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`).join('') + `</table>`);
    continue;
  }
  if (/^> /.test(l)) {
    const buf: string[] = [];
    while (i < lines.length && /^> ?/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, ''));
    // keep paragraph breaks inside a quoted email body
    const paras = buf.join('\n').split(/\n\s*\n/).map((p) => `<p>${inline(esc(p.replace(/\n/g, ' ')))}</p>`).join('');
    html.push(`<blockquote style="margin-left:24pt;border-left:2pt solid #B0691A;padding-left:12pt">${paras}</blockquote>`);
    continue;
  }
  const lm = (s: string) => s.match(/^(\s*)([-*]|\d+\.) (.*)$/);
  if (lm(l)) {
    const ordered = /^\s*\d+\./.test(l);
    const items: string[] = [];
    while (i < lines.length) {
      const m = lm(lines[i]);
      if (m) { items.push(m[3]); i++; }
      else if (/^\s+\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
      else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    html.push(`<${tag}>${items.map((t) => `<li>${inline(esc(t))}</li>`).join('')}</${tag}>`);
    continue;
  }
  const buf: string[] = [];
  while (i < lines.length && !blockStart(lines[i])) buf.push(lines[i++]);
  if (buf.length) html.push(`<p>${inline(esc(buf.join(' ')))}</p>`);
}

const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(basename(src))}</title></head>
<body style="font-family:Calibri,Helvetica,sans-serif;font-size:11pt;line-height:1.45">
${html.join('\n')}
</body></html>`;

mkdirSync(dirname(out), { recursive: true });
const tmp = out.replace(/\.docx$/, '.tmp.html');
writeFileSync(tmp, doc);
execFileSync('textutil', ['-convert', 'docx', '-output', out, tmp]);
execFileSync('rm', ['-f', tmp]);
console.log(`wrote ${out}`);
