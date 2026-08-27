/**
 * Solvency Bench — agentic suite runner (solvency-bench-a2).
 *
 * Protocol history: a1 = the original 13-task tranche (results under that tag
 * stay valid for that population and never mix with a2); a2 = the 30-task
 * screening tier (2026-08-26), 17 hard longer-horizon tasks added.
 *
 * The reference harness ("solvency-loop"): a deliberately minimal,
 * model-agnostic tool loop — list/read/write files and run the test command —
 * driven over OpenRouter tool-calling. Every model gets the identical
 * scaffold, which is the whole point: the cross-model population measures
 * models under equal conditions. Native-harness populations (Claude Code,
 * Codex via bench/harness-adapters.mjs) are a separate labeled group.
 *
 * Isolation: the MODEL talks to the API from the host; the TASK CODE only
 * ever executes inside a docker container with --network none. Hidden tests
 * are injected after the agent finishes (WildClawBench's leak-proofing).
 * Without docker the agentic runner refuses to run models — fail closed —
 * but --selftest verifies every task's grader on the host using our own
 * reference solutions.
 *
 *   node bench/agentic/loop.mjs --selftest
 *   OPENROUTER_API_KEY=... node bench/agentic/loop.mjs \
 *     --model z-ai/glm-5.3-flash --trials 1 --budget 2
 */
import { readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolvePrices } from '../runner.mjs';

const A_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(A_DIR, '..', 'results');
export const PROTOCOL = 'solvency-bench-a2';
const IMAGE = 'node:22-slim';
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function loadAgenticTasks() {
  const dir = join(A_DIR, 'tasks');
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'task.json')))
    .map((d) => ({ ...JSON.parse(readFileSync(join(dir, d, 'task.json'), 'utf8')), dir: join(dir, d) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'List every file in the repo (relative paths).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: 'Read one repo file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite one repo file with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_tests', description: 'Run the repo test suite (npm test) and get its output.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'finish', description: 'Declare the task complete once you believe the goal is met.', parameters: { type: 'object', properties: { note: { type: 'string' } } } } },
];

const SYSTEM = `You are a careful software engineer working inside a small repository.
Use the tools to inspect the repo, make the change the task asks for, and verify with run_tests.
Rules: keep changes minimal; never modify files under test/ unless the task says to; call finish when done.`;

// ---------- docker sandbox ----------
export function dockerAvailable() {
  return spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;
}
function sandboxStart(workDir) {
  const name = `sbench-${randomUUID().slice(0, 8)}`;
  execFileSync('docker', ['run', '-d', '--name', name, '--network', 'none',
    '--memory', '512m', '--cpus', '1', '-v', `${workDir}:/repo`, '-w', '/repo',
    IMAGE, 'sleep', '600'], { stdio: 'pipe' });
  return {
    exec(cmd, timeoutMs = 60000) {
      const r = spawnSync('docker', ['exec', name, 'sh', '-c', cmd],
        { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return { code: r.status, out: ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 12000) };
    },
    stop() { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); },
  };
}

// Tool implementations act on the mounted workDir from the HOST for
// file ops (fast, and the content is inert data) but execute all task code
// inside the container.
function toolImpl(workDir, box) {
  const safe = (p) => {
    const full = join(workDir, p);
    if (!full.startsWith(workDir) || p.includes('..')) throw new Error('path escapes the repo');
    return full;
  };
  const listAll = (d = workDir, base = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name.startsWith('.') ? []
      : e.isDirectory() ? listAll(join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]);
  return {
    list_files: () => listAll().join('\n'),
    read_file: ({ path }) => readFileSync(safe(path), 'utf8').slice(0, 24000),
    write_file: ({ path, content }) => { mkdirSync(dirname(safe(path)), { recursive: true }); writeFileSync(safe(path), content); return `wrote ${path} (${content.length} bytes)`; },
    run_tests: () => { const r = box.exec('npm test --silent 2>&1', 90000); return `exit ${r.code}\n${r.out}`; },
  };
}

async function chat(apiKey, model, messages) {
  let res = await fetch(OR_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 4000, messages, tools: TOOLS }),
  });
  // Upstream 429/503 is capacity, not an answer — back off before failing
  // the attempt (mirrors bench/runner.mjs; the first a2 ling/laguna arms
  // died on a single upstream rate-limit without this).
  for (let retry = 0; (res.status === 429 || res.status === 503) && retry < 5; retry++) {
    await new Promise((r) => setTimeout(r, Math.min(20_000 * 2 ** retry, 120_000)));
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 4000, messages, tools: TOOLS }),
    });
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 300));
  return { msg: body.choices?.[0]?.message ?? {}, usage: body.usage ?? { prompt_tokens: 0, completion_tokens: 0 } };
}

/** One agentic attempt: fresh fixture, tool loop, then post-hoc hidden grading. */
export async function agenticAttempt({ task, model, apiKey, prices, budgetLeftUsd }) {
  const workDir = join(tmpdir(), `sbench-a-${randomUUID()}`);
  cpSync(join(task.dir, 'fixture'), workDir, { recursive: true });
  const box = sandboxStart(workDir);
  let usage = { prompt_tokens: 0, completion_tokens: 0 }, turns = 0, cost = 0;
  try {
    const tools = toolImpl(workDir, box);
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Task: ${task.goal}` },
    ];
    for (turns = 1; turns <= task.maxTurns; turns++) {
      const { msg, usage: u } = await chat(apiKey, model, messages);
      usage.prompt_tokens += u.prompt_tokens; usage.completion_tokens += u.completion_tokens;
      cost = (usage.prompt_tokens / 1e6) * prices.inputPerMtok + (usage.completion_tokens / 1e6) * prices.outputPerMtok;
      if (cost > budgetLeftUsd) return { pass: false, detail: 'attempt aborted: budget cap', usage, cost, turns, aborted: true };
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (!calls.length) break; // model stopped calling tools
      let finished = false;
      for (const c of calls) {
        let result;
        if (c.function.name === 'finish') { finished = true; result = 'ok'; }
        else {
          try { result = String(tools[c.function.name]?.(JSON.parse(c.function.arguments || '{}')) ?? 'unknown tool'); }
          catch (e) { result = `tool error: ${e.message}`; }
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: result.slice(0, 16000) });
      }
      if (finished) break;
    }
    // Post-hoc grading: inject hidden tests only now, run inside the sandbox.
    cpSync(join(task.dir, 'hidden'), join(workDir, 'test'), { recursive: true });
    const g = box.exec('npm test --silent 2>&1', 120000);
    return { pass: g.code === 0, detail: g.code === 0 ? '' : g.out.slice(-500), usage, cost, turns };
  } finally {
    box.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Host-side grader verification: reference solution must pass the hidden
 * tests, the untouched fixture must fail them. No docker, no API, no cost. */
export function selftest() {
  let ok = true;
  for (const t of loadAgenticTasks()) {
    const tryOne = (withSolution) => {
      const d = join(tmpdir(), `sbench-st-${randomUUID()}`);
      cpSync(join(t.dir, 'fixture'), d, { recursive: true });
      if (withSolution) cpSync(join(t.dir, 'solution'), d, { recursive: true });
      cpSync(join(t.dir, 'hidden'), join(d, 'test'), { recursive: true });
      const r = spawnSync('npm', ['test', '--silent'], { cwd: d, encoding: 'utf8', timeout: t.timeoutMs });
      rmSync(d, { recursive: true, force: true });
      return r.status === 0;
    };
    const solved = tryOne(true), unsolved = tryOne(false);
    console.log(`${t.id.padEnd(18)} solution:${solved ? 'PASS' : 'FAIL'}  fixture:${unsolved ? 'PASSES(BAD)' : 'fails as it should'}`);
    if (!solved || unsolved) ok = false;
  }
  console.log(ok ? '\nagentic self-test clean' : '\nAGENTIC SELF-TEST FAILED');
  return ok;
}

// ---------------------------- CLI ------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }
  const model = arg('model');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!model || !apiKey) { console.error('usage: OPENROUTER_API_KEY=... node bench/agentic/loop.mjs --model <slug> [--trials 1] [--budget 2]'); process.exit(1); }
  if (!dockerAvailable()) { console.error('docker is required for agentic runs (task code executes network-less in a container) — install Docker Desktop or colima, then retry. Graders can be verified free with --selftest.'); process.exit(1); }
  const prices = resolvePrices(model, arg('price-in') && arg('price-out') ? { inputPerMtok: +arg('price-in'), outputPerMtok: +arg('price-out') } : null);
  if (!prices) { console.error(`no catalog prices for "${model}" — supply --price-in/--price-out (fail closed)`); process.exit(1); }
  const trials = +arg('trials', 1), budget = +arg('budget', 2);
  const tasks = loadAgenticTasks();
  const runId = `agentic-${model.replace(/[^a-z0-9.-]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(join(RESULTS_DIR, runId), { recursive: true });
  const resultsPath = join(RESULTS_DIR, runId, 'results.jsonl');
  (async () => {
    let spent = 0; const counts = { pass: 0, fail: 0 };
    for (const task of tasks) for (let trial = 1; trial <= trials; trial++) {
      if (spent >= budget) { console.log(`budget cap $${budget} reached`); break; }
      process.stdout.write(`${task.id}#${trial} … `);
      const r = await agenticAttempt({ task, model, apiKey, prices, budgetLeftUsd: budget - spent });
      spent += r.cost;
      counts[r.pass ? 'pass' : 'fail']++;
      appendFileSync(resultsPath, JSON.stringify({ taskId: task.id, trial, ...r, at: new Date().toISOString() }) + '\n');
      console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.turns} turns  $${spent.toFixed(4)} spent`);
    }
    const countable = counts.pass + counts.fail;
    const summary = {
      protocol: PROTOCOL, harness: { name: 'solvency-loop', version: '1' }, model,
      prices, trials, attemptsCountable: countable,
      passRate: countable ? counts.pass / countable : null,
      costPerTaskUsd: countable ? spent / countable : null,
      costPerSolvedUsd: counts.pass ? (spent / countable) / (counts.pass / countable) : null,
      spentUsd: +spent.toFixed(4), runDate: new Date().toISOString().slice(0, 10),
      isolation: 'reference-harness population; never merged with native-harness, v0 single-turn, or third-party populations',
    };
    writeFileSync(join(RESULTS_DIR, runId, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  })().catch((e) => { console.error(e); process.exit(1); });
}
