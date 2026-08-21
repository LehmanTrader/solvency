/**
 * Renders a report markdown file to a self-contained HTML page and prints it
 * to PDF with headless Chrome. Charts are inlined, so the PDF carries no
 * external references. No third-party packages.
 *
 *   node scripts/render-pdf.ts reports/2026-08-cost-per-solved-task.md [outDir]
 *
 * Printing goes over the DevTools protocol rather than --print-to-pdf, because
 * the CLI flag cannot set a footer template and an eight-page report with no
 * folio reads unfinished. Falls back to the CLI if CDP is unavailable.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';

const src = resolve(process.argv[2] ?? 'reports/2026-08-cost-per-solved-task.md');
const outDir = resolve(process.argv[3] ?? join(dirname(src), 'build'));
const raw = readFileSync(src, 'utf8');
const srcDir = dirname(src);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

let figureNo = 0;
function inlineSvg(rel: string, alt: string): string {
  const light = join(srcDir, rel.replace(/^charts\//, 'charts-light/'));
  const p = existsSync(light) ? light : join(srcDir, rel);
  if (!existsSync(p)) throw new Error(`chart not found: ${p}`);
  const svg = readFileSync(p, 'utf8')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto" ');
  figureNo++;
  return `<figure>${svg}<figcaption><span class="fig-no">Figure ${figureNo}</span>${esc(alt)}</figcaption></figure>`;
}

/** The chunk before the first horizontal rule becomes the cover. */
const splitAt = raw.indexOf('\n---\n');
const coverMd = splitAt > -1 ? raw.slice(0, splitAt) : '';
const bodyMd = splitAt > -1 ? raw.slice(splitAt + 5) : raw;

const coverTitle = (coverMd.match(/^#\s+(.+)$/m) ?? [, 'Report'])[1];
const coverLead = coverMd.replace(/^#\s+.+$/m, '').trim().replace(/\s*\n\s*/g, ' ');

function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  const isBlockStart = (l: string) =>
    /^(#{1,6} |\||> |```|---+$|[-*] |\d+\. |!\[)/.test(l) || /^\s*$/.test(l);

  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { i++; continue; }

    if (/^```/.test(l)) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) { out.push(inlineSvg(img[2], img[1])); i++; continue; }

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
        `<tbody>${body.map((r) => `<tr>${r.map((c, n) => `<td style="text-align:${align[n] ?? 'left'}">${inline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
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
  return out.join('\n');
}

const CSS = `
  @page { size: A4; margin: 0; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  :root {
    --paper:#FCFBF9; --ink:#14171A; --ink-soft:#394046; --muted:#6E747B;
    --rule:#E6E1D8; --rule-mid:#CFC8BB; --accent:#B0691A; --panel:#F5F2EC;
    --serif: ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif;
    --mono: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  }
  html, body { background: var(--paper); }
  body { margin:0; color: var(--ink-soft); font-family: var(--serif);
         font-size: 10pt; line-height: 1.62; font-kerning: normal;
         -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }

  /* ---- cover ---------------------------------------------------------- */
  .cover { height: 10.1in; display: flex; flex-direction: column;
           justify-content: space-between; break-after: page; }
  .wordmark { font-family: var(--mono); font-size: 8.5pt; letter-spacing: .34em;
              color: var(--accent); font-weight: 600; }
  .cover-top { border-bottom: .5pt solid var(--rule-mid); padding-bottom: 9pt;
               display:flex; justify-content: space-between; align-items: baseline; }
  .cover-kicker { font-family: var(--mono); font-size: 7.5pt; letter-spacing: .16em;
                  color: var(--muted); text-transform: uppercase; }
  .cover-mid { padding-bottom: 1.1in; }
  .cover h1 { font-family: var(--serif); font-size: 40pt; line-height: 1.06;
              letter-spacing: -0.5pt; color: var(--ink); font-weight: 600; margin: 0 0 18pt; }
  .cover .lead { font-size: 12.5pt; line-height: 1.55; color: var(--ink-soft);
                 max-width: 5in; margin: 0; }
  .cover .lead strong { color: var(--ink); font-weight: 600; }
  .cover-foot { border-top: .5pt solid var(--rule-mid); padding-top: 10pt;
                display: flex; gap: 26pt; font-family: var(--mono); font-size: 7.5pt;
                line-height: 1.5; color: var(--muted); }
  .cover-foot dt { text-transform: uppercase; letter-spacing: .12em; color: var(--muted); white-space: nowrap; }
  .cover-foot dd { margin: 2pt 0 0; color: var(--ink); }

  /* ---- flow ----------------------------------------------------------- */
  h2 { font-family: var(--serif); font-size: 16pt; font-weight: 600; color: var(--ink);
       line-height: 1.2; letter-spacing: -0.2pt; margin: 0 0 10pt;
       padding-top: 7pt; border-top: 1.6pt solid var(--accent);
       break-after: avoid; break-inside: avoid; }
  h2:not(:first-child) { margin-top: 24pt; }
  h3 { font-family: var(--mono); font-size: 8pt; font-weight: 600; text-transform: uppercase;
       letter-spacing: .15em; color: var(--accent); margin: 16pt 0 6pt; break-after: avoid; }
  p { margin: 0 0 8pt; }
  p + p { text-indent: 0; }
  a { color: var(--ink); text-decoration: none; border-bottom: .5pt solid var(--accent); }
  strong { color: var(--ink); font-weight: 600; }
  em { font-style: italic; }
  hr { border: 0; border-top: .5pt solid var(--rule); margin: 18pt 0; }
  ul, ol { margin: 0 0 9pt; padding-left: 14pt; }
  li { margin-bottom: 4.5pt; padding-left: 2pt; }
  li::marker { color: var(--accent); }

  code { font-family: var(--mono); font-size: 8.3pt; color: var(--ink);
         background: var(--panel); padding: .5pt 3pt; border-radius: 2px; }
  pre { background: var(--panel); border: .5pt solid var(--rule); border-radius: 2px;
        padding: 9pt 11pt; margin: 0 0 10pt; break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 8.2pt; line-height: 1.55;
             color: var(--ink-soft); }

  /* ---- tables --------------------------------------------------------- */
  table { width: 100%; border-collapse: collapse; margin: 2pt 0 6pt;
          font-family: var(--mono); font-size: 8.1pt; line-height: 1.4;
          font-variant-numeric: tabular-nums; break-inside: avoid; }
  th { text-align: left; font-weight: 600; font-size: 6.8pt; letter-spacing: .13em;
       text-transform: uppercase; color: var(--muted); padding: 0 7pt 5pt;
       border-bottom: .8pt solid var(--ink); white-space: nowrap; }
  td { padding: 4.6pt 7pt; border-bottom: .4pt solid var(--rule); color: var(--ink-soft); }
  tbody tr:last-child td { border-bottom: .8pt solid var(--rule-mid); }
  td strong { color: var(--ink); font-weight: 600; }

  blockquote { margin: 10pt 0 12pt; padding: 0 0 0 14pt;
               border-left: 1.6pt solid var(--accent); color: var(--ink);
               font-size: 10.5pt; line-height: 1.5; break-inside: avoid; }

  /* ---- figures -------------------------------------------------------- */
  figure { margin: 12pt -0.4in 16pt; break-inside: avoid; }
  figure svg { display: block; border: .5pt solid var(--rule); }
  figcaption { font-family: var(--mono); font-size: 7pt; letter-spacing: .05em;
               color: var(--muted); margin-top: 6pt; padding: 0 .4in; }
  .fig-no { color: var(--accent); font-weight: 600; text-transform: uppercase;
            letter-spacing: .13em; margin-right: 8pt; }
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(coverTitle)}</title>
<style>${CSS}</style></head><body>
<section class="cover">
  <div class="cover-top">
    <span class="wordmark">DENOMINATOR</span>
    <span class="cover-kicker">Research Note 01</span>
  </div>
  <div class="cover-mid">
    <h1>${esc(coverTitle)}</h1>
    <p class="lead">${inline(esc(coverLead))}</p>
  </div>
  <dl class="cover-foot">
    <div><dt>Verified</dt><dd>2026-08-21</dd></div>
    <div><dt>Sources</dt><dd>Artificial Analysis · Scale SEAL · Aider</dd></div>
    <div><dt>Method</dt><dd>cost per attempt ÷ pass rate</dd></div>
    <div><dt>Status</dt><dd>Phase 0 — validation</dd></div>
  </dl>
</section>
${mdToHtml(bodyMd)}
</body></html>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = join(outDir, basename(src).replace(/\.md$/, '.html'));
const pdfPath = join(outDir, basename(src).replace(/\.md$/, '.pdf'));
writeFileSync(htmlPath, html);

const FOOTER = `<div style="width:100%;font-family:'SFMono-Regular',Menlo,monospace;font-size:7px;
  color:#6E747B;padding:0 1.02in;display:flex;justify-content:space-between;letter-spacing:.08em;
  -webkit-print-color-adjust:exact;">
  <span>DENOMINATOR &nbsp;·&nbsp; COST PER SOLVED TASK &nbsp;·&nbsp; AUGUST 2026</span>
  <span class="pageNumber"></span></div>`;

const PRINT_OPTS = {
  printBackground: true, preferCSSPageSize: false,
  paperWidth: 8.27, paperHeight: 11.69,
  marginTop: 0.85, marginBottom: 0.72, marginLeft: 1.02, marginRight: 1.02,
  displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: FOOTER,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function printViaCDP(): Promise<boolean> {
  const port = 9331;
  const proc = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${port}`, `file://${htmlPath}`,
  ], { stdio: 'ignore', detached: true });
  try {
    let target: any = null;
    for (let n = 0; n < 60 && !target; n++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* not up yet */ }
    }
    if (!target) return false;

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res as any; ws.onerror = rej as any; });
    let id = 0;
    const send = (method: string, params: any = {}) => new Promise<any>((res) => {
      const myId = ++id;
      const onMsg = (e: MessageEvent) => {
        const m = JSON.parse(e.data as string);
        if (m.id === myId) { ws.removeEventListener('message', onMsg as any); res(m.result); }
      };
      ws.addEventListener('message', onMsg as any);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

    await send('Page.enable');
    for (let n = 0; n < 40; n++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r?.result?.value === 'complete') break;
      await sleep(150);
    }
    await sleep(600); // let fonts settle before paginating
    const { data } = await send('Page.printToPDF', PRINT_OPTS);
    ws.close();
    writeFileSync(pdfPath, Buffer.from(data, 'base64'));
    return true;
  } finally {
    try { process.kill(-proc.pid!, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
  }
}

let mode = 'cdp (with page numbers)';
try {
  if (!(await printViaCDP())) throw new Error('CDP unavailable');
} catch (err) {
  mode = 'cli fallback (no page numbers)';
  console.warn(`CDP print failed (${(err as Error).message}); falling back to --print-to-pdf`);
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
    '--virtual-time-budget=8000', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`], { stdio: 'pipe' });
}

console.log(`mode: ${mode}`);
console.log(`html: ${htmlPath}`);
console.log(`pdf:  ${pdfPath}`);
