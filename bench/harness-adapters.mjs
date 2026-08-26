/**
 * Harness adapters (solvency-bench-v0h): run an attempt through a real,
 * locally-authenticated coding harness instead of a raw API call, capture
 * the token usage the harness itself reports, and reprice it at verified
 * catalog API rates.
 *
 * This is the operator's subscription-repricing insight, and it has direct
 * precedent: Note 02's OpenBench numbers are subscription-backed usage
 * repriced at API rates (`source_usage_repriced`). Here the basis is
 * labelled `subscription_usage_repriced`: the tokens are measured from the
 * harness's own accounting, the dollars are catalog list prices — the
 * subscription's flat fee never enters the math.
 *
 * What a harness attempt measures: the MODEL+HARNESS pair (e.g.
 * "Claude Code + Opus 5"), never the model alone — same rule as every
 * harness number on the site. Harness name + version are recorded per run.
 *
 * Cache pricing: cache READS at the catalog cached-input rate; cache WRITES
 * are priced at the uncached input rate and the record says so (vendors'
 * write premium is not modelled — stated, not guessed).
 */
import { spawn } from 'node:child_process';

const run = (cmd, args, { timeoutMs = 300000, input } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  if (input) { child.stdin.write(input); child.stdin.end(); }
  const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
  child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
});

const versionOf = async (cmd) => (await run(cmd, ['--version'], { timeoutMs: 15000 })).out.trim().slice(0, 60) || null;

/** Normalized usage: { input, cacheRead, cacheWrite, output } token counts. */
export function repriceUsage(u, prices) {
  const cachedRate = prices.cachedInputPerMtok ?? prices.inputPerMtok;
  return (u.input / 1e6) * prices.inputPerMtok
       + (u.cacheRead / 1e6) * cachedRate
       + (u.cacheWrite / 1e6) * prices.inputPerMtok
       + (u.output / 1e6) * prices.outputPerMtok;
}

export const ADAPTERS = {
  /** Claude Code headless: `claude -p --output-format json` on the local
   * subscription login. Model chosen with --model; usage comes from the
   * result envelope. */
  'claude-code': {
    label: 'Claude Code (local subscription)',
    async version() { return versionOf('claude'); },
    async attempt({ prompt, model, timeoutMs }) {
      const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '1'];
      if (model) args.push('--model', model);
      const r = await run('claude', args, { timeoutMs });
      if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      let body;
      try { body = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop()); }
      catch { return { infra: true, detail: `unparseable claude output: ${(r.err || r.out).slice(0, 200)}` }; }
      const u = body.usage ?? body.message?.usage;
      if (!u) return { infra: true, detail: 'no usage block in claude output — cannot reprice, attempt excluded (fail closed)' };
      return {
        text: body.result ?? body.content ?? '',
        usage: {
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        },
      };
    },
  },

  /** Codex CLI headless: `codex exec --json` on the local ChatGPT login.
   * Usage is read from the JSONL event stream (token count events); if this
   * Codex build does not emit usage, the attempt is excluded fail-closed. */
  codex: {
    label: 'Codex CLI (local subscription)',
    async version() { return versionOf('codex'); },
    async attempt({ prompt, model, timeoutMs }) {
      // Codex CLI 1.x JSON stream (verified live 2026-08-26): the reply is
      // {type:"item.completed", item:{type:"agent_message", text}} and usage
      // is {type:"turn.completed", usage:{input_tokens (incl. cached),
      // cached_input_tokens, cache_write_input_tokens, output_tokens,
      // reasoning_output_tokens}}. output_tokens is treated as inclusive of
      // reasoning tokens, the OpenAI accounting convention.
      const args = ['exec', '--json', '--skip-git-repo-check'];
      if (model) args.push('--model', model);
      args.push(prompt);
      const r = await run('codex', args, { timeoutMs });
      if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      let text = '', usage = null;
      for (const line of r.out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text;
        // Older builds nested events under .msg with different names — keep those paths alive.
        const msg = e.msg ?? e;
        if (typeof msg.last_agent_message === 'string') text = msg.last_agent_message;
        const u = (e.type === 'turn.completed' && e.usage) ? e.usage
          : (msg.info?.total_token_usage ?? msg.token_usage ?? null);
        if (u && u.input_tokens != null) {
          usage = {
            input: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0),
            cacheRead: u.cached_input_tokens ?? 0,
            cacheWrite: u.cache_write_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
        }
      }
      if (!usage) return { infra: true, detail: 'no token-usage event in codex --json stream — cannot reprice, attempt excluded (fail closed)' };
      return { text, usage };
    },
  },
};
