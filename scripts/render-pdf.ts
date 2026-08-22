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
const metaPath = join(srcDir, 'charts-light', 'meta.json');
const CHART_META: Record<string, { title: string; subtitle: string[]; source: string[] }> =
  existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

/**
 * Charts are set as cards: the title, method note and source rail are real type
 * in the page, not baked into the SVG, so they share the document's typography.
 */
function inlineSvg(rel: string, alt: string): string {
  const light = join(srcDir, rel.replace(/^charts\//, 'charts-light/'));
  const p = existsSync(light) ? light : join(srcDir, rel);
  if (!existsSync(p)) throw new Error(`chart not found: ${p}`);
  const svg = readFileSync(p, 'utf8')
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" ');
  figureNo++;

  const key = (rel.match(/([a-z]+)\.svg$/) ?? [, ''])[1];
  const m = CHART_META[key];
  const title = m?.title ?? alt;
  const notes = [...(m?.subtitle ?? [])];
  const sources: string[] = [];
  for (const line of m?.source ?? []) (line.startsWith('Data:') ? sources : notes).push(line);

  return `<figure class="chart">
  <div class="chart-head">
    <div class="chart-title"><b>Figure ${figureNo}:</b> ${esc(title)}</div>
    ${notes.length ? `<div class="chart-note">${notes.map(esc).join('<br>')}</div>` : ''}
  </div>
  <div class="chart-plot">${svg}</div>
  <div class="chart-foot">
    <span>${sources.map(esc).join(' ')}</span>
    <span class="mark">SOLVENCY</span>
  </div>
</figure>`;
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
        `<div class="t-wrap"><table><thead><tr>${head.map((c, n) => `<th style="text-align:${align[n] ?? 'left'}">${inline(esc(c))}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${r.map((c, n) => `<td style="text-align:${align[n] ?? 'left'}">${inline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
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
    --page:#F4F3F1; --card:#FFFFFF; --ink:#1B1B20; --body:#3A3D42; --muted:#6E7278;
    --rule:#E4E2DE; --rule-soft:#EDEBE7; --accent:#A9631A; --amber:#FFB000;
    --sans: -apple-system, "SF Pro Text", "Helvetica Neue", Inter, Arial, sans-serif;
    --display: ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif;
    --mono: "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
  }
  html, body { background: var(--page); }
  body { margin:0; color: var(--body); font-family: var(--sans); font-size: 9.6pt;
         line-height: 1.62; -webkit-font-smoothing: antialiased; }

  /* ---- cover ---------------------------------------------------------- */
  .cover { height: 10.05in; display:flex; flex-direction:column; break-after: page; }
  .cover h1 { font-family: var(--display); font-size: 33pt; font-weight: 600; color: var(--ink);
              line-height: 1.08; letter-spacing: -0.4pt; margin: 0 0 9pt; }
  .cover .deck { font-size: 11.5pt; color: var(--muted); margin: 0 0 7pt; max-width: 4.9in; }
  .cover .date { font-family: var(--mono); font-size: 7.2pt; letter-spacing: .12em;
                 text-transform: uppercase; color: var(--muted); margin: 0; }
  .hero { flex: 1; margin-top: 15pt; background: var(--card); border: .75pt solid var(--rule);
          border-radius: 7pt; overflow: hidden; display:flex; flex-direction:column; }
  .hero-top { display:flex; justify-content:space-between; align-items:flex-start; padding: 17pt 19pt 0; }
  .hero-mark { font-family: var(--mono); font-weight:700; letter-spacing:.26em; font-size: 8.5pt; color: var(--ink); }
  .hero-no { font-family: var(--mono); font-size: 9pt; letter-spacing:.1em; color: var(--ink); text-align:right; line-height:1.45; }
  .hero-mid { flex:1; display:flex; align-items:center; justify-content:center; padding: 0 30pt; }
  .hero-title { font-family: var(--mono); font-size: 20pt; letter-spacing:.15em; color: var(--ink);
                text-align:center; line-height:1.62; }
  .hero-bar { height: 10pt; background: linear-gradient(90deg, var(--amber) 0%, #E08A1C 55%, #8A4A0A 100%); }
  .tagline { margin-top: 9pt; background: var(--card); border:.75pt solid var(--rule); border-radius: 7pt;
             padding: 12pt 17pt; display:flex; justify-content:space-between; align-items:center;
             font-family: var(--mono); font-size: 8.4pt; color: var(--ink); }
  .tagline .mark { font-weight:700; letter-spacing:.2em; font-size:7pt; color: var(--muted); }
  .cover-foot { display:flex; gap: 20pt; margin-top: 10pt; font-family: var(--mono);
                font-size: 7pt; line-height:1.5; color: var(--muted); }
  .cover-foot > div { flex: 0 0 auto; }
  .cover-foot dd { white-space: nowrap; }
  .cover-foot dt { text-transform: uppercase; letter-spacing:.12em; white-space: nowrap; }
  .cover-foot dd { margin: 2pt 0 0; color: var(--ink); }

  /* ---- flow ----------------------------------------------------------- */
  h2 { font-family: var(--sans); font-size: 14pt; font-weight: 700; color: var(--ink);
       line-height:1.25; letter-spacing:-0.15pt; margin: 0 0 9pt; padding-top: 10pt;
       border-top: .75pt solid var(--rule); break-after: avoid; break-inside: avoid; }
  h2:not(:first-child) { margin-top: 21pt; }
  h3 { font-family: var(--mono); font-size: 7.6pt; font-weight: 700; text-transform: uppercase;
       letter-spacing: .15em; color: var(--accent); margin: 15pt 0 6pt; break-after: avoid; }
  p { margin: 0 0 8pt; }
  a { color: var(--ink); text-decoration: none; border-bottom: .5pt solid var(--accent); }
  strong { color: var(--ink); font-weight: 600; }
  hr { border:0; border-top:.75pt solid var(--rule); margin: 17pt 0; }
  ul, ol { margin: 0 0 9pt; padding-left: 14pt; }
  li { margin-bottom: 4.5pt; padding-left: 2pt; }
  li::marker { color: var(--accent); }
  code { font-family: var(--mono); font-size: 8.1pt; color: var(--ink);
         background: var(--card); border:.4pt solid var(--rule); padding: .4pt 3pt; border-radius: 2px; }
  pre { background: var(--card); border:.75pt solid var(--rule); border-radius: 6pt;
        padding: 10pt 12pt; margin: 0 0 10pt; break-inside: avoid; }
  pre code { background:none; border:0; padding:0; font-size: 8pt; line-height:1.55; color: var(--body); }

  /* ---- tables as cards ------------------------------------------------ */
  .t-wrap { background: var(--card); border:.75pt solid var(--rule); border-radius: 6pt;
            padding: 10pt 13pt 4pt; margin: 3pt 0 10pt; break-inside: avoid; }
  table { width:100%; border-collapse: collapse; font-family: var(--mono); font-size: 7.9pt;
          line-height:1.4; font-variant-numeric: tabular-nums; }
  th { text-align:left; font-weight:700; font-size: 6.6pt; letter-spacing:.13em;
       text-transform: uppercase; color: var(--muted); padding: 0 7pt 5pt;
       border-bottom: .75pt solid var(--ink); white-space: nowrap; }
  td { padding: 4.4pt 7pt; border-bottom: .4pt solid var(--rule-soft); color: var(--body); }
  tbody tr:last-child td { border-bottom: 0; }
  td strong { color: var(--ink); font-weight: 700; }

  blockquote { background: var(--card); border:.75pt solid var(--rule);
               border-left: 2.5pt solid var(--amber); border-radius: 6pt;
               padding: 11pt 14pt; margin: 10pt 0 12pt; color: var(--ink);
               font-size: 9.6pt; break-inside: avoid; }

  /* ---- chart cards ---------------------------------------------------- */
  figure.chart { background: var(--card); border:.75pt solid var(--rule); border-radius: 7pt;
                 margin: 12pt -0.34in 15pt; padding: 14pt 16pt 0; overflow:hidden;
                 break-inside: avoid; }
  .chart-title { font-family: var(--mono); font-size: 9.8pt; color: var(--ink); line-height:1.38; }
  .chart-title b { font-weight: 700; }
  .chart-note { font-family: var(--mono); font-size: 7.3pt; color: var(--muted);
                margin-top: 5pt; line-height:1.5; }
  .chart-plot { margin-top: 11pt; }
  .chart-foot { margin-top: 9pt; border-top:.5pt solid var(--rule); padding: 7pt 0 12pt;
                display:flex; justify-content:space-between; gap: 14pt;
                font-family: var(--mono); font-size: 6.7pt; color: var(--muted); }
  .chart-foot .mark { font-weight:700; letter-spacing:.19em; color: var(--ink); white-space:nowrap; }

`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(coverTitle)}</title>
<style>${CSS}</style></head><body>
<section class="cover">
  <div>
    <h1>${esc(coverTitle)}</h1>
    <p class="deck">${inline(esc(coverLead))}</p>
    <p class="date">21 August 2026</p>
  </div>
  <div class="hero">
    <div class="hero-top">
      <span class="hero-mark">SOLVENCY</span>
      <span class="hero-no">RESEARCH<br>NOTE&#8202;&#8211;&#8202;01</span>
    </div>
    <div class="hero-mid"><div class="hero-title">COST PER<br>SOLVED TASK</div></div>
    <div class="hero-bar"></div>
  </div>
  <div class="tagline">
    <span>The denominator is the whole story.</span>
    <span class="mark">SOLVENCY</span>
  </div>
  <dl class="cover-foot">
    <div><dt>Verified</dt><dd>2026-08-21</dd></div>
    <div><dt>Sources</dt><dd>AA · SEAL · Aider</dd></div>
    <div><dt>Method</dt><dd>cost ÷ pass rate</dd></div>
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
  <span>SOLVENCY &nbsp;·&nbsp; RESEARCH NOTE 01 &nbsp;·&nbsp; COST PER SOLVED TASK &nbsp;·&nbsp; AUGUST 2026</span>
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
