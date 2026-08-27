/**
 * Orchestrator-effect study v0 — does the composer model change the outcome?
 *
 *   source ~/.solvency-bench-env && node bench/orchestrator-study/run.mjs
 *
 * Question (operator, 2026-08-27): "would choosing a different composer
 * impact an agentic workflow? … the downstream agents may react differently
 * to different composers … the quality of the work and obviously cost."
 *
 * Protocol (orchestrator-study-v0):
 *   - The 12 solvency-bench-v0 tasks (deterministic hidden-vector graders).
 *   - Each ORCHESTRATOR model receives the raw task and a meta-prompt: write
 *     the instruction you would hand a junior AI model. It must not solve
 *     the task itself (violations are recorded, not silently cleaned).
 *   - A FIXED WORKER (glm-5.3-flash — 36/36 on these tasks when prompted
 *     directly, so any downstream failure is attributable to the
 *     instruction, not the worker) receives ONLY the orchestrator's
 *     instruction, never the original prompt.
 *   - Grade the worker's solution with the existing checker. 1 trial.
 *   - Metrics per orchestrator: worker pass rate, orchestrator cost, worker
 *     cost, end-to-end cost per solved task, latency, instruction length,
 *     and whether the instruction leaked implementation code.
 * Baseline: the worker's own direct-prompt run (bench/results, 36/36) —
 * an orchestrator that drops the worker below 12/12 made things WORSE.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, resolvePrices, attemptCostUsd, extractCode, runChecker } from '../runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const WORKER = 'z-ai/glm-5.3-flash';
const ORCHESTRATORS = [
  'openai/gpt-5.6-sol',
  'anthropic/claude-opus-5',
  'z-ai/glm-5.3',
  'moonshotai/kimi-k3',
  'z-ai/glm-5.3-flash', // self-orchestration control
];

const META = (task) => `You are the lead engineer orchestrating a junior AI model that will implement a task you assign.
Rewrite the task below as the single instruction message you would hand that junior model. Make the instruction as effective as you can: clarify the requirements, call out likely pitfalls and edge cases, and specify the exact deliverable format (one complete \`\`\`js fenced code block containing the full implementation, nothing else).
Do NOT solve the task yourself — your message must contain no implementation code.

TASK:
${task.prompt}`;

async function chat(model, content, maxTokens) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.error) throw new Error(`${model} error: ${JSON.stringify(body.error).slice(0, 200)}`);
  const c = body.choices?.[0] ?? {};
  return { text: c.message?.content ?? '', usage: body.usage ?? {}, finish: c.finish_reason, ms: Date.now() - t0 };
}

const usageShape = (u) => ({
  input: u.prompt_tokens ?? 0,
  cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
  cacheWrite: 0,
  output: u.completion_tokens ?? 0,
});

const tasks = loadTasks();
const journalPath = join(HERE, 'results.jsonl');
const done = new Set(existsSync(journalPath)
  ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.orchestrator}::${r.taskId}`; })
  : []);

for (const orch of ORCHESTRATORS) {
  const oPrices = resolvePrices(orch);
  const wPrices = resolvePrices(WORKER);
  if (!oPrices || !wPrices) { console.error(`no catalog prices for ${orch} or ${WORKER} — skipped (fail closed)`); continue; }
  for (const task of tasks) {
    const key = `${orch}::${task.id}`;
    if (done.has(key)) { console.log(`skip ${key}`); continue; }
    let rec = { orchestrator: orch, worker: WORKER, taskId: task.id, at: new Date().toISOString() };
    try {
      const o = await chat(orch, META(task), 4000);
      const instruction = o.text.trim();
      const leaked = /```/.test(instruction);
      const w = await chat(WORKER, instruction, 8000);
      const code = extractCode(w.text);
      const graded = code ? await runChecker(task, code) : { pass: false, detail: 'no extractable code block in worker reply' };
      rec = {
        ...rec,
        pass: !!graded.pass, detail: graded.detail ?? 'ok',
        instructionChars: instruction.length, instructionLeakedCode: leaked,
        orchUsage: usageShape(o.usage), workerUsage: usageShape(w.usage),
        orchCostUsd: attemptCostUsd(o.usage, oPrices),
        workerCostUsd: attemptCostUsd(w.usage, wPrices),
        orchMs: o.ms, workerMs: w.ms, orchFinish: o.finish, workerFinish: w.finish,
      };
    } catch (e) {
      rec = { ...rec, pass: false, infra: true, detail: String(e.message).slice(0, 200) };
    }
    appendFileSync(journalPath, JSON.stringify(rec) + '\n');
    console.log(`${rec.infra ? 'INFRA' : rec.pass ? 'pass ' : 'FAIL '} ${orch.padEnd(28)} ${task.id.padEnd(16)} $${((rec.orchCostUsd ?? 0) + (rec.workerCostUsd ?? 0)).toFixed(4)}${rec.instructionLeakedCode ? '  [leaked code]' : ''}`);
  }
}

// summary
const rows = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byOrch = {};
for (const r of rows.filter((r) => !r.infra)) {
  const b = byOrch[r.orchestrator] ??= { n: 0, pass: 0, orchUsd: 0, workerUsd: 0, ms: 0, leaked: 0, chars: 0 };
  b.n++; b.pass += r.pass ? 1 : 0; b.orchUsd += r.orchCostUsd ?? 0; b.workerUsd += r.workerCostUsd ?? 0;
  b.ms += (r.orchMs ?? 0) + (r.workerMs ?? 0); b.leaked += r.instructionLeakedCode ? 1 : 0; b.chars += r.instructionChars ?? 0;
}
const summary = {
  protocol: 'orchestrator-study-v0', worker: WORKER, runDate: new Date().toISOString().slice(0, 10),
  baseline_note: 'worker direct-prompt baseline: 36/36 on these tasks (bench/results, solvency-bench-v0)',
  orchestrators: Object.fromEntries(Object.entries(byOrch).map(([o, b]) => [o, {
    countable: b.n, pass_rate: b.n ? b.pass / b.n : null,
    orchestrator_cost_usd: +b.orchUsd.toFixed(4), worker_cost_usd: +b.workerUsd.toFixed(4),
    end_to_end_cost_per_solved_usd: b.pass ? +((b.orchUsd + b.workerUsd) / b.pass).toFixed(5) : null,
    mean_latency_ms: b.n ? Math.round(b.ms / b.n) : null,
    instructions_leaking_code: b.leaked, mean_instruction_chars: b.n ? Math.round(b.chars / b.n) : null,
  }])),
};
writeFileSync(join(HERE, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('\n' + JSON.stringify(summary, null, 2));
