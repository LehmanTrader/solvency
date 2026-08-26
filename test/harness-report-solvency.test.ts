/**
 * Research Note 02, population three: Solvency's own five-arm run. Every
 * published cell — the ranked table, the anatomy medians, the 7.7x headline —
 * must re-derive from the exported study in
 * data/harness-study/solvency-bench-v0.json, which itself derives from the
 * per-attempt journals under bench/results/.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(ROOT, 'reports', '2026-08-same-model-four-harnesses.md'), 'utf8');
const study = JSON.parse(readFileSync(join(ROOT, 'data', 'harness-study', 'solvency-bench-v0.json'), 'utf8'));
const cells = (line: string) => line.split('|').slice(1, -1).map((c: string) => c.trim());
const num = (s: string) => Number(s.replace(/[*$%,x]/g, ''));

type Arm = {
  harness: string | null; harness_version: string | null; access: string;
  pass_rate: number; cost_per_solved_usd: number;
  median_usage_per_attempt: { input: number; cache_read: number; cache_write: number; output: number };
};
const arms: Arm[] = study.arms;
const armLabel = (a: Arm) => a.harness === null ? 'API, no harness'
  : a.harness === 'aider' ? 'Aider' : a.harness === 'codex' ? 'Codex' : a.harness === 'pi' ? 'Pi'
  : a.harness === 'opencode' ? 'OpenCode' : a.harness === 'hermes' ? 'Hermes Agent' : a.harness;

describe('Research Note 02, population three, matches the first-party study', () => {
  const section = md.split('## Population three')[1]?.split('## Finding 7')[0] ?? '';

  test('the note actually carries the population-three section', () => {
    assert.ok(section.length > 500, 'Population three section missing or truncated');
    assert.match(md, /# Same Model, Eight Harnesses/);
  });

  test('all five ranked rows re-derive: pass, $/solved, ratio vs cheapest', () => {
    const rows = section.split('\n')
      .filter((l) => /^\| (Aider|API, no harness|Pi|Codex|OpenCode|Hermes Agent) \| /.test(l))
      .filter((l) => cells(l).length === 6); // ranked table only; the anatomy table has 5 columns
    assert.equal(rows.length, 6, 'expected exactly six arms in the table');
    const cheapest = Math.min(...arms.map((a) => a.cost_per_solved_usd));
    const sorted = [...arms].sort((a, b) => a.cost_per_solved_usd - b.cost_per_solved_usd);
    rows.forEach((line, i) => {
      const [label, version, , pass, solved, vs] = cells(line);
      const arm = sorted[i];
      assert.equal(label, armLabel(arm), `row ${i} order must follow ascending $/solved`);
      if (arm.harness_version) assert.equal(version, arm.harness_version);
      assert.equal(num(pass), Math.round(arm.pass_rate * 100));
      assert.equal(num(solved), Number(arm.cost_per_solved_usd.toFixed(4)));
      assert.equal(num(vs), Number((arm.cost_per_solved_usd / cheapest).toFixed(2)));
    });
  });

  test('the anatomy medians re-derive from the study, verbatim', () => {
    const rows = section.split('Output |')[1].split('\n').filter((l) => /^\| (Aider|API, no harness|Pi|Codex|OpenCode|Hermes Agent) \| /.test(l));
    assert.equal(rows.length, 6);
    for (const line of rows) {
      const [label, input, cr, cw, out] = cells(line);
      const arm = arms.find((a) => armLabel(a) === label)!;
      const m = arm.median_usage_per_attempt;
      assert.equal(num(input), m.input, `${label} input`);
      assert.equal(num(cr), m.cache_read, `${label} cache reads`);
      assert.equal(num(cw), m.cache_write, `${label} cache writes`);
      assert.equal(num(out), m.output, `${label} output`);
    }
  });

  test('the 7.7x headline is the true max/min ratio, and every arm passed everything', () => {
    const costs = arms.map((a) => a.cost_per_solved_usd);
    const spread = Math.max(...costs) / Math.min(...costs);
    assert.equal(spread.toFixed(1), '7.7');
    assert.match(md, /spans \*\*7\.7x\*\*/);
    for (const a of arms) assert.equal(a.pass_rate, 1, `${armLabel(a)} must be 100% for the "pass explains none of this" claim`);
  });

  test('provenance and access labels are stated honestly', () => {
    // subscription arms record the bare model id; metered arms the provider-prefixed one
    for (const a of arms as (Arm & { model: string })[]) assert.equal(a.model.replace(/^openai\//, ''), 'gpt-5.6-sol');
    assert.match(section, /subscription arm.s flat fee never enters the math/);
    assert.match(section, /cache writes price at the uncached\s+input rate/i);
    for (const a of arms.filter((x) => x.harness)) {
      const row = section.split('\n').find((l) => l.startsWith(`| ${armLabel(a)} |`))!;
      if (a.access.includes('subscription')) assert.match(row, /local subscription/);
      else assert.match(row, /metered/);
    }
  });

  test('the primer cites Osmani and the eight-harness count is real', () => {
    assert.match(md, /addyosmani\.com\/blog\/agent-harness-engineering/);
    assert.match(md, /Agent = Model \+ Harness/);
    const p12 = ['Pi', 'Claude Code', 'Grok Build', 'Codex', 'OpenClaw', 'Hermes Agent'];
    const p3 = arms.filter((a) => a.harness).map(armLabel);
    assert.equal(new Set([...p12, ...p3]).size, 8);
  });
});
