/**
 * Solvency Bench — local GUI. `npm run bench:gui` then open
 * http://localhost:4871. One run at a time; every guard from SPEC.md is
 * enforced server-side (the UI cannot start a run without an estimate, and
 * the engine's budget cap aborts regardless of what the UI does).
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasks, resolvePrices, estimateRun, runBenchmark, selftest, BENCH_DIR, RESULTS_DIR } from './runner.mjs';

const PORT = 4871;
const tasks = loadTasks();
const clients = new Set();
let active = null; // { runId, stop }

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const broadcast = (event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(line);
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {}));
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/') return send(res, 200, readFileSync(join(BENCH_DIR, 'ui.html'), 'utf8'), 'text/html');
    if (url.pathname === '/brand-mark.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(readFileSync(join(BENCH_DIR, '..', 'site', 'public', 'brand', 'mark-j1-ink.png')));
    }
    if (url.pathname === '/api/tasks') return send(res, 200, tasks.map(({ id, title, func }) => ({ id, title, func })));
    if (url.pathname === '/api/selftest' && req.method === 'POST') {
      const ok = await selftest();
      return send(res, 200, { ok });
    }
    if (url.pathname === '/api/estimate' && req.method === 'POST') {
      const { slug, trials, maxTokens, taskIds, priceIn, priceOut } = await readBody(req);
      const chosen = tasks.filter((t) => !taskIds?.length || taskIds.includes(t.id));
      const prices = resolvePrices(slug, priceIn && priceOut ? { inputPerMtok: +priceIn, outputPerMtok: +priceOut } : null);
      if (!prices) return send(res, 200, { error: `No catalog price row matches "${slug}". Enter explicit prices — fail-closed, never guessed.` });
      return send(res, 200, { ...estimateRun({ tasks: chosen, trials: +trials, maxTokens: +maxTokens, prices }), prices });
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      if (active) return send(res, 409, { error: `run ${active.runId} is already in progress` });
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) return send(res, 200, { error: 'OPENROUTER_API_KEY is not set in the server environment.' });
      const { slug, trials, maxTokens, budgetUsd, taskIds, priceIn, priceOut } = await readBody(req);
      const chosen = tasks.filter((t) => !taskIds?.length || taskIds.includes(t.id));
      const prices = resolvePrices(slug, priceIn && priceOut ? { inputPerMtok: +priceIn, outputPerMtok: +priceOut } : null);
      if (!prices) return send(res, 200, { error: 'unpriced model — refused (SPEC guard 5)' });
      const runId = `${slug.replace(/[^a-z0-9.-]+/gi, '-')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
      let stopped = false;
      active = { runId, stop: () => { stopped = true; } };
      runBenchmark(
        { slug, tasks: chosen, trials: +trials, maxTokens: +maxTokens, budgetUsd: +budgetUsd, prices, apiKey, runId, stop: () => stopped },
        broadcast,
      ).catch((e) => broadcast({ type: 'run-error', error: String(e) }))
       .finally(() => { active = null; });
      return send(res, 200, { runId });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      active?.stop();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/summary/')) {
      const id = url.pathname.split('/').pop();
      const p = join(RESULTS_DIR, id, 'summary.json');
      return existsSync(p) ? send(res, 200, JSON.parse(readFileSync(p, 'utf8'))) : send(res, 404, { error: 'no summary' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
}).listen(PORT, () => console.log(`Solvency Bench GUI: http://localhost:${PORT}`));
