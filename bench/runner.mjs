/**
 * Solvency Bench runner (solvency-bench-v0). See bench/SPEC.md.
 *
 * Node >= 20, zero dependencies. Headless CLI here; bench/server.mjs wraps
 * the same engine in the local GUI.
 *
 *   node bench/runner.mjs --selftest
 *   OPENROUTER_API_KEY=... node bench/runner.mjs \
 *     --model z-ai/glm-5.3-flash --trials 3 --budget 5
 */
import { readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ADAPTERS, repriceUsage } from './harness-adapters.mjs';

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(BENCH_DIR, '..');
export const RESULTS_DIR = join(BENCH_DIR, 'results');
export const PROTOCOL = 'solvency-bench-v0';
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------------
export function loadTasks() {
  const dir = join(BENCH_DIR, 'tasks');
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'task.json')))
    .map((d) => ({ ...JSON.parse(readFileSync(join(dir, d, 'task.json'), 'utf8')), dir: join(dir, d) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Fail-closed price resolution: an OpenRouter slug must match a catalog row
 * with verified prices, or explicit prices must be supplied. */
export function resolvePrices(slug, override) {
  if (override) return { ...override, basis: 'user_supplied', priceNote: 'prices supplied on the command line' };
  const models = JSON.parse(readFileSync(join(ROOT, 'data', 'models.json'), 'utf8'));
  const list = Array.isArray(models) ? models : models.models;
  const tail = slug.includes('/') ? slug.split('/')[1] : slug;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const row = list.find((m) => m.source_url?.endsWith(`/${slug}`))
    ?? list.find((m) => norm(m.model_id) === norm(tail));
  if (!row) return null;
  return {
    inputPerMtok: row.input_per_mtok, outputPerMtok: row.output_per_mtok,
    cachedInputPerMtok: row.cached_input_per_mtok ?? row.input_per_mtok,
    basis: 'catalog', modelId: row.model_id, lastVerified: row.last_verified,
    priceNote: `catalog row ${row.model_id}, verified ${row.last_verified}`,
  };
}

export function attemptCostUsd(usage, prices) {
  return (usage.prompt_tokens / 1e6) * prices.inputPerMtok
       + (usage.completion_tokens / 1e6) * prices.outputPerMtok;
}

/** Pre-run estimate: prompt tokens approximated at chars/3.5, completion at
 * the full max_tokens cap — deliberately pessimistic so the real bill lands
 * under the estimate, not over it. */
export function estimateRun({ tasks, trials, maxTokens, prices }) {
  let inTok = 0;
  for (const t of tasks) inTok += Math.ceil(t.prompt.length / 3.5) + 64;
  const attempts = tasks.length * trials;
  const totalIn = inTok * trials, totalOut = attempts * maxTokens;
  const usd = (totalIn / 1e6) * prices.inputPerMtok + (totalOut / 1e6) * prices.outputPerMtok;
  return { attempts, estInputTokens: totalIn, estOutputTokensCeiling: totalOut, estUsdCeiling: usd };
}

export function extractCode(text) {
  const blocks = [...text.matchAll(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/g)];
  if (blocks.length) return blocks[blocks.length - 1][1];
  return /export\s+(function|const)/.test(text) ? text : null;
}

export function runChecker(task, code) {
  return new Promise((resolve) => {
    const work = join(tmpdir(), `sbench-${randomUUID()}`);
    mkdirSync(work, { recursive: true });
    const sol = join(work, 'solution.mjs');
    writeFileSync(sol, code);
    const child = spawn(process.execPath, [join(task.dir, 'check.mjs'), sol], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: work,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, task.timeoutMs);
    child.on('close', (codeNum, signal) => {
      clearTimeout(timer);
      rmSync(work, { recursive: true, force: true });
      resolve({
        pass: codeNum === 0,
        detail: signal === 'SIGKILL' ? `timeout after ${task.timeoutMs}ms` : (err || out).trim().slice(0, 400),
      });
    });
  });
}

async function callModel({ slug, prompt, maxTokens, apiKey }) {
  const res = await fetch(OR_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: slug, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.error) throw new Error(`OpenRouter error: ${JSON.stringify(body.error).slice(0, 300)}`);
  const usage = body.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const choice = body.choices?.[0] ?? {};
  return { text: choice.message?.content ?? '', usage, finish: choice.finish_reason ?? null };
}

export function protocolHash(tasks, trials, maxTokens) {
  return createHash('sha256')
    .update(JSON.stringify({ p: PROTOCOL, ids: tasks.map((t) => t.id), trials, maxTokens }))
    .digest('hex').slice(0, 12);
}

/**
 * The run loop. `emit(event)` receives every state change (the GUI streams
 * these over SSE; the CLI prints them). Resume: attempts already present in
 * results.jsonl for this runId are skipped, never re-billed.
 */
export async function runBenchmark(cfg, emit = () => {}) {
  const { slug, tasks, trials, maxTokens, budgetUsd, prices, apiKey, runId } = cfg;
  mkdirSync(join(RESULTS_DIR, runId), { recursive: true });
  const resultsPath = join(RESULTS_DIR, runId, 'results.jsonl');
  const done = new Set(existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).map((r) => `${r.taskId}#${r.trial}`)
    : []);
  let spent = existsSync(resultsPath)
    ? readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).reduce((a, r) => a + (r.costUsd ?? 0), 0)
    : 0;
  const counted = { pass: 0, fail: 0, infra: 0 };
  let aborted = null;

  outer:
  for (const task of tasks) {
    for (let trial = 1; trial <= trials; trial++) {
      const key = `${task.id}#${trial}`;
      if (done.has(key)) { emit({ type: 'skip', taskId: task.id, trial }); continue; }
      if (cfg.stop?.()) { aborted = 'stopped by operator'; break outer; }
      if (spent >= budgetUsd) { aborted = `budget cap $${budgetUsd} reached at $${spent.toFixed(4)}`; break outer; }
      emit({ type: 'attempt-start', taskId: task.id, trial, spent });
      let rec;
      try {
        const t0 = Date.now();
        let text, costUsd, usageRec, finishNote = null;
        if (cfg.harness) {
          const a = await ADAPTERS[cfg.harness].attempt({ prompt: task.prompt, model: cfg.harnessModel, timeoutMs: 300000 });
          if (a.infra) throw new Error(a.detail);
          text = a.text;
          costUsd = repriceUsage(a.usage, prices);
          usageRec = a.usage;
        } else {
          const r = await callModel({ slug, prompt: task.prompt, maxTokens, apiKey });
          text = r.text;
          costUsd = attemptCostUsd(r.usage, prices);
          usageRec = { input: r.usage.prompt_tokens, cacheRead: 0, cacheWrite: 0, output: r.usage.completion_tokens };
          // Reasoning models can spend the whole cap thinking and return no
          // content: record that as the specific failure it is.
          if (r.finish === 'length') finishNote = 'token cap reached (finish=length) — raise --max-tokens for reasoning models';
        }
        spent += costUsd;
        const code = extractCode(text);
        const check = code ? await runChecker(task, code)
                           : { pass: false, detail: finishNote ?? 'no extractable code block in the reply' };
        rec = {
          taskId: task.id, trial, pass: check.pass, detail: check.detail,
          costUsd: Number(costUsd.toFixed(6)), usage: usageRec,
          // Audit trail: enough of the raw reply to distinguish a model
          // failure from an extraction bug without re-running anything.
          replyHead: (text ?? '').slice(0, 240),
          ms: Date.now() - t0, infra: false, at: new Date().toISOString(),
        };
        counted[check.pass ? 'pass' : 'fail']++;
      } catch (e) {
        rec = { taskId: task.id, trial, pass: false, infra: true, detail: String(e).slice(0, 300), costUsd: 0, at: new Date().toISOString() };
        counted.infra++;
      }
      appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
      emit({ type: 'attempt-done', ...rec, spent });
    }
  }

  const countable = counted.pass + counted.fail;
  const passRate = countable ? counted.pass / countable : null;
  const costPerTask = countable ? spent / countable : null;
  const summary = {
    protocol: cfg.harness ? PROTOCOL + 'h' : PROTOCOL, protocolHash: protocolHash(tasks, trials, maxTokens),
    costBasis: cfg.harness ? 'subscription_usage_repriced' : 'api_metered_at_catalog_prices',
    harness: cfg.harness ? { name: cfg.harness, version: cfg.harnessVersion ?? null,
      note: 'usage measured from the harness; dollars are catalog API list prices; cache writes priced at the uncached input rate (write premium not modelled); the subscription flat fee never enters the math' } : null,
    runId, model: slug, prices: { ...prices }, trials, maxTokens,
    attemptsCountable: countable, infraExcluded: counted.infra,
    passRate, costPerTaskUsd: costPerTask,
    costPerSolvedUsd: passRate ? costPerTask / passRate : null,
    spentUsd: Number(spent.toFixed(4)), budgetUsd, aborted,
    runDate: new Date().toISOString().slice(0, 10),
    isolation: 'own population; never merged with AA/OpenBench/WildClawBench',
  };
  writeFileSync(join(RESULTS_DIR, runId, 'summary.json'), JSON.stringify(summary, null, 2));
  emit({ type: 'run-done', summary });
  return summary;
}

export async function selftest() {
  const tasks = loadTasks();
  let ok = true;
  for (const t of tasks) {
    const ref = readFileSync(join(t.dir, 'solution.mjs'), 'utf8');
    const good = await runChecker(t, ref);
    const bad = await runChecker(t, `export function ${t.func}() { return undefined; }`);
    const line = `${t.id.padEnd(16)} ref:${good.pass ? 'PASS' : 'FAIL'} stub:${bad.pass ? 'ACCEPTED(BAD)' : 'rejected'}`;
    console.log(line + (good.pass && !bad.pass ? '' : `   <-- ${good.detail || bad.detail}`));
    if (!good.pass || bad.pass) ok = false;
  }
  console.log(ok ? `\nself-test clean: ${tasks.length} tasks, every checker accepts its reference and rejects a stub` : '\nSELF-TEST FAILED');
  return ok;
}

// ---------------------------- CLI ------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  if (process.argv.includes('--selftest')) {
    selftest().then((ok) => process.exit(ok ? 0 : 1));
  } else {
    const slug = arg('model');
    const harness = arg('harness'); // claude-code | codex
    if (!slug) { console.error('usage: node bench/runner.mjs --model <slug-or-catalog-id> [--harness claude-code|codex] [--trials 3] [--budget 5] [--max-tokens 1600] [--price-in X --price-out Y] [--run <id>]'); process.exit(1); }
    if (harness && !ADAPTERS[harness]) { console.error(`unknown harness "${harness}" (have: ${Object.keys(ADAPTERS).join(', ')})`); process.exit(1); }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!harness && !apiKey) { console.error('OPENROUTER_API_KEY is not set (or use --harness to run on a local subscription login)'); process.exit(1); }
    const override = arg('price-in') && arg('price-out')
      ? { inputPerMtok: Number(arg('price-in')), outputPerMtok: Number(arg('price-out')) } : null;
    const prices = resolvePrices(slug, override);
    if (!prices) { console.error(`no catalog price row matches "${slug}" — supply --price-in/--price-out (fail-closed pricing, SPEC.md guard 5)`); process.exit(1); }
    const tasks = loadTasks();
    const trials = Number(arg('trials', 3)), maxTokens = Number(arg('max-tokens', 1600));
    const budgetUsd = Number(arg('budget', 5));
    const est = estimateRun({ tasks, trials, maxTokens, prices });
    console.log(`[estimate] ${est.attempts} attempts, ceiling $${est.estUsdCeiling.toFixed(3)} (${prices.priceNote}); budget cap $${budgetUsd}`);
    const runId = arg('run', `${(harness ? harness + '-' : '') + slug.replace(/[^a-z0-9.-]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}`);
    const boot = async () => harness ? await ADAPTERS[harness].version() : null;
    boot().then((hv) => runBenchmark({ slug, tasks, trials, maxTokens, budgetUsd, prices, apiKey, runId,
      harness, harnessModel: slug, harnessVersion: hv }, (e) => {
      if (e.type === 'attempt-done') console.log(`${e.infra ? 'INFRA' : e.pass ? 'pass ' : 'FAIL '} ${e.taskId}#${e.trial}  $${e.spent.toFixed(4)} spent${e.detail && !e.pass ? '  ' + e.detail.split('\n')[0].slice(0, 80) : ''}`);
      if (e.type === 'run-done') console.log('\n' + JSON.stringify(e.summary, null, 2));
    })).catch((e) => { console.error(e); process.exit(1); });
  }
}
