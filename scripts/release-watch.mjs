/**
 * Release watch: detect new models and harness releases before anyone else
 * benchmarks them.
 *
 *   node scripts/release-watch.mjs            # diff against saved state, report
 *   node scripts/release-watch.mjs --seed     # (re)initialize state, no report
 *
 * Sources (deterministic, API-driven — social sweeps layer on top of this):
 *   1. OpenRouter /models — the single highest-signal feed: a model that can
 *      be benchmarked by Solvency appears here first. Diff on model ids.
 *   2. Harness release feeds — GitHub latest release/tag per tracked harness.
 * State lives in data/watch/state.json; findings append a dated brief to
 * docs/watch/. Exit code 0 always (a watch that fails loudly in CI gets
 * disabled by humans); findings are signalled via stdout and the brief file.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = join(ROOT, 'data', 'watch', 'state.json');
const BRIEF_DIR = join(ROOT, 'docs', 'watch');
const SEED = process.argv.includes('--seed');

/** Harness repos we track. Keep in sync with Note 02's feature matrix. */
const HARNESS_REPOS = [
  { name: 'Pi', repo: 'badlogic/pi-mono' },
  { name: 'Aider', repo: 'Aider-AI/aider' },
  { name: 'OpenCode', repo: 'sst/opencode' },
  { name: 'Goose', repo: 'block/goose' },
  { name: 'Cline', repo: 'cline/cline' },
  { name: 'Codex CLI', repo: 'openai/codex' },
  { name: 'Claude Code', repo: 'anthropics/claude-code' },
  { name: 'OpenClaw', repo: 'openclaw/openclaw' },
];

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'user-agent': 'solvency-release-watch', ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

async function openRouterModels() {
  const { data } = await fetchJson('https://openrouter.ai/api/v1/models');
  const out = {};
  for (const m of data) {
    out[m.id] = {
      name: m.name ?? m.id,
      promptPerTok: m.pricing?.prompt ?? null,
      completionPerTok: m.pricing?.completion ?? null,
      created: m.created ?? null,
    };
  }
  return out;
}

async function harnessVersions() {
  const gh = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const out = {};
  for (const h of HARNESS_REPOS) {
    try {
      const rel = await fetchJson(`https://api.github.com/repos/${h.repo}/releases/latest`, gh)
        .catch(() => fetchJson(`https://api.github.com/repos/${h.repo}/tags?per_page=1`, gh).then((t) => t[0] && { tag_name: t[0].name }));
      if (rel?.tag_name) out[h.name] = { repo: h.repo, version: rel.tag_name };
    } catch (e) {
      out[h.name] = { repo: h.repo, version: null, error: String(e.message).slice(0, 80) };
    }
  }
  return out;
}

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : { models: {}, harnesses: {} };
const [models, harnesses] = await Promise.all([openRouterModels(), harnessVersions()]);

const findings = [];
// Dated price alerts (promo expiries etc.) — fire on/after their date until cleared.
const alertsPath = join(ROOT, 'data', 'watch', 'price-alerts.json');
if (existsSync(alertsPath)) {
  const today = new Date().toISOString().slice(0, 10);
  for (const a of JSON.parse(readFileSync(alertsPath, 'utf8')).alerts ?? []) {
    if (a.date <= today) findings.push(`PRICE ALERT (due ${a.date}): ${a.note}`);
  }
}
if (!SEED) {
  for (const [id, m] of Object.entries(models)) {
    if (!(id in state.models)) {
      const inM = m.promptPerTok === null ? '?' : (Number(m.promptPerTok) * 1e6).toFixed(3);
      const outM = m.completionPerTok === null ? '?' : (Number(m.completionPerTok) * 1e6).toFixed(3);
      findings.push(`NEW MODEL on OpenRouter: \`${id}\` (${m.name}) — $${inM}/M in, $${outM}/M out`);
    }
  }
  for (const [name, h] of Object.entries(harnesses)) {
    const prev = state.harnesses[name];
    if (h.version && prev?.version && h.version !== prev.version) {
      findings.push(`HARNESS RELEASE: ${name} ${prev.version} -> ${h.version} (${h.repo})`);
    } else if (h.version && !prev) {
      findings.push(`HARNESS now tracked: ${name} at ${h.version} (${h.repo})`);
    }
  }
}

mkdirSync(dirname(STATE_PATH), { recursive: true });
writeFileSync(STATE_PATH, JSON.stringify({
  updated_at: new Date().toISOString(),
  models: Object.fromEntries(Object.entries(models).map(([id, m]) => [id, { name: m.name }])),
  harnesses,
}, null, 2) + '\n');

if (findings.length) {
  mkdirSync(BRIEF_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const brief = join(BRIEF_DIR, `brief-${day}.md`);
  const lines = [`## Release watch — ${new Date().toISOString()}`, '', ...findings.map((f) => `- ${f}`), ''];
  writeFileSync(brief, (existsSync(brief) ? readFileSync(brief, 'utf8') : `# Watch brief ${day}\n\n`) + lines.join('\n'));
  console.log(`FINDINGS (${findings.length}):`);
  for (const f of findings) console.log(`- ${f}`);
} else {
  console.log(SEED ? `state seeded: ${Object.keys(models).length} models, ${Object.keys(harnesses).length} harnesses` : 'no new releases');
}
