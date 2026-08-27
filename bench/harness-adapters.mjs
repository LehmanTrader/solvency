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

const run = (cmd, args, { timeoutMs = 300000, input, env, cwd } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: env ?? process.env, cwd });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  if (input) { child.stdin.write(input); child.stdin.end(); }
  const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
  child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
});

const runIn = (cmd, args, cwd, timeoutMs) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out: out + err }); });
  child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e) }); });
});

const versionOf = async (cmd) => ((await run(cmd, ['--version'], { timeoutMs: 15000 })).out.trim().split('\n')[0] || '').slice(0, 60) || null;

/** Normalized usage: { input, cacheRead, cacheWrite, output } token counts. */
export function repriceUsage(u, prices) {
  const cachedRate = prices.cachedInputPerMtok ?? prices.inputPerMtok;
  return (u.input / 1e6) * prices.inputPerMtok
       + (u.cacheRead / 1e6) * cachedRate
       + (u.cacheWrite / 1e6) * prices.inputPerMtok
       + (u.output / 1e6) * prices.outputPerMtok;
}

export const ADAPTERS = {
  /** OpenCode headless (`opencode run --format json`), model via
   * openrouter/<slug> — metered caller credentials. Usage from step_finish
   * events (input/output/reasoning + cache read/write), summed across
   * steps; reasoning priced as output. */
  opencode: {
    label: 'OpenCode (headless, metered provider)',
    access: 'metered provider (OpenRouter)',
    async version() { return versionOf('opencode'); },
    async attempt({ prompt, model, timeoutMs }) {
      const r = await run('opencode', ['run', prompt, '-m', `openrouter/${model}`, '--format', 'json'], { timeoutMs });
      if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      let text = '', usage = null;
      for (const line of r.out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const p = e.part ?? e;
        if ((e.type === 'text' || p.type === 'text') && typeof p.text === 'string') text = p.text;
        if (e.type === 'step_finish' && p.tokens) {
          usage ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
          usage.input += p.tokens.input ?? 0;
          usage.cacheRead += p.tokens.cache?.read ?? 0;
          usage.cacheWrite += p.tokens.cache?.write ?? 0;
          usage.output += (p.tokens.output ?? 0) + (p.tokens.reasoning ?? 0);
        }
      }
      if (!usage) return { infra: true, detail: 'no step_finish tokens in opencode stream — cannot reprice, attempt excluded (fail closed)' };
      return { text, usage };
    },
  },

  /** Pi coding agent (badlogic/pi-mono), one-shot `-p` with `--mode json`.
   * The `agent_end` event carries every message with cumulative usage per
   * assistant message {input, output, cacheRead, cacheWrite}; we sum across
   * assistant messages and take the last text as the reply. OpenBench's
   * cheapest arm on its own population — measured here on ours. */
  pi: {
    label: 'Pi (one-shot, metered provider)',
    access: 'metered provider (OpenRouter)',
    async version() { return versionOf('pi'); },
    async attempt({ prompt, model, timeoutMs }) {
      const r = await run('pi', ['--provider', 'openrouter', '--model', model, '--mode', 'json', '-p', prompt], { timeoutMs });
      if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      let final = null;
      for (const line of r.out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'agent_end' && Array.isArray(e.messages)) final = e;
      }
      if (!final) return { infra: true, detail: 'no agent_end event in pi JSON stream — cannot reprice, attempt excluded (fail closed)' };
      const assistants = final.messages.filter((m) => m.role === 'assistant');
      if (!assistants.length) return { infra: true, detail: 'pi returned no assistant message' };
      const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      let text = '';
      for (const m of assistants) {
        const u = m.usage ?? {};
        usage.input += u.input ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        usage.output += (u.output ?? 0) + (u.reasoning ?? 0);
        for (const c of m.content ?? []) if (c.type === 'text' && c.text) text = c.text;
      }
      if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite)
        return { infra: true, detail: 'pi reported zero usage — cannot reprice, attempt excluded (fail closed)' };
      return { text, usage };
    },
  },

  /** Goose (Block / Linux Foundation), headless `goose run -t`. Reply is
   * stdout (banner stripped); usage is read back from Goose's own session
   * store (~/.local/share/goose/sessions/sessions.db) by unique session name
   * — accumulated input/output/cache token columns per session. Provider via
   * GOOSE_PROVIDER=openrouter + GOOSE_MODEL env. */
  goose: {
    label: 'Goose (headless, metered provider)',
    access: 'metered provider (OpenRouter)',
    async version() { return versionOf('goose'); },
    async attempt({ prompt, model, timeoutMs }) {
      const name = `sbench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const env = { ...process.env, GOOSE_PROVIDER: 'openrouter', GOOSE_MODEL: model, GOOSE_DISABLE_KEYRING: '1' };
      const r = await run('goose', ['run', '-n', name, '--max-turns', '3', '-t', prompt], { timeoutMs, env });
      if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      const text = r.out
        .split('\n')
        .filter((l) => !/^\s*(__\(|\\____\)|L L|starting session|logging to|working directory)/i.test(l))
        .join('\n');
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const { homedir } = await import('node:os');
        const db = new DatabaseSync(`${homedir()}/.local/share/goose/sessions/sessions.db`, { readOnly: true });
        const row = db.prepare(
          'SELECT accumulated_input_tokens AS i, accumulated_output_tokens AS o, accumulated_cache_read_tokens AS cr, accumulated_cache_write_tokens AS cw FROM sessions WHERE name = ? OR user_set_name = ? ORDER BY created_at DESC LIMIT 1'
        ).get(name, name);
        db.close();
        if (!row || (!row.i && !row.o)) return { infra: true, detail: `no usage row for goose session ${name} — cannot reprice, attempt excluded (fail closed)` };
        return { text, usage: { input: (row.i ?? 0) - (row.cr ?? 0), cacheRead: row.cr ?? 0, cacheWrite: row.cw ?? 0, output: row.o ?? 0 } };
      } catch (e) {
        return { infra: true, detail: `goose session store unreadable: ${e.message}` };
      }
    },
  },

  /** Cline CLI 2.0, headless `-y --json`, provider openrouter with explicit
   * key. The final `run_result` event carries aggregateUsage with a full
   * cache split; reply text is the concatenation of text content events
   * (the submit_and_exit summary alone is not the reply). */
  cline: {
    label: 'Cline (headless, metered provider)',
    access: 'metered provider (OpenRouter)',
    async version() { return versionOf('cline'); },
    async attempt({ prompt, model, timeoutMs }) {
      // Cline is file-native (its agent edits the workspace rather than
      // replying with a fence) — grade from a file, aider precedent (r1 of
      // this arm was INVALIDated for exactly that extraction artifact).
      const { mkdtempSync, readFileSync: rf, existsSync: ex, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'sbench-cline-'));
      try {
        const r = await run('cline',
          ['-y', '--json', '-P', 'openrouter', '-k', process.env.OPENROUTER_API_KEY, '-m', model,
           `${prompt}\n\nWrite the complete implementation to a file named solution.mjs in the current directory.`],
          { timeoutMs, cwd: dir });
        if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
        let usage = null;
        for (const line of r.out.split('\n')) {
          if (!line.trim().startsWith('{')) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === 'run_result' && e.aggregateUsage) {
            usage = {
              input: e.aggregateUsage.inputTokens ?? 0,
              cacheRead: e.aggregateUsage.cacheReadTokens ?? 0,
              cacheWrite: e.aggregateUsage.cacheWriteTokens ?? 0,
              output: e.aggregateUsage.outputTokens ?? 0,
            };
          }
        }
        if (!usage) return { infra: true, detail: 'no run_result usage in cline JSON stream — cannot reprice, attempt excluded (fail closed)' };
        const file = join(dir, 'solution.mjs');
        const text = ex(file) ? '```js\n' + rf(file, 'utf8') + '\n```' : '';
        return { text, usage };
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    },
  },

  /** Aider one-shot (`--message`), model via openrouter/<slug>. Usage parsed
   * from aider's own "Tokens: X sent, Y received" line; counts >= 1k are
   * k-rounded by aider (recorded as reported — a stated precision limit,
   * not a guess). No cache split is reported, so all sent tokens price at
   * the uncached input rate (conservative). */
  aider: {
    label: 'Aider (one-shot, metered provider)',
    access: 'metered provider (OpenRouter)',
    async version() { return versionOf('aider'); },
    async attempt({ prompt, model, timeoutMs }) {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'sbench-aider-'));
      // Aider's native mode is editing files, and its chat output is
      // terminal-formatted (column padding, rulers) that no fence extractor
      // should be trusted with — the r1 run proved it. So the attempt gives
      // aider a real file and grades THAT file's content.
      const { writeFileSync, readFileSync: rf } = await import('node:fs');
      writeFileSync(join(dir, 'solution.mjs'), '// implement here\n');
      const proc = await runIn('aider', ['solution.mjs', '--model', `openrouter/${model}`,
        '--message', prompt + ' Put the complete implementation in solution.mjs.',
        '--yes', '--no-git', '--no-auto-commits', '--no-check-update', '--no-pretty'], dir, timeoutMs);
      let content = '';
      try { content = rf(join(dir, 'solution.mjs'), 'utf8'); } catch {}
      rmSync(dir, { recursive: true, force: true });
      if (proc.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      const m = proc.out.match(/Tokens:\s*([\d.]+)(k?)\s*sent,\s*([\d.]+)(k?)\s*received/i);
      if (!m) return { infra: true, detail: 'no Tokens line in aider output — cannot reprice, attempt excluded (fail closed)' };
      const n = (v, k) => Math.round(parseFloat(v) * (k ? 1000 : 1));
      return { text: '```js\n' + content + '\n```', usage: { input: n(m[1], m[2]), cacheRead: 0, cacheWrite: 0, output: n(m[3], m[4]) } };
    },
  },

  /** Hermes Agent one-shot (`hermes -z`) with its machine-readable
   * --usage-file accounting. Model routed via --provider (default
   * openrouter, caller-supplied credentials) — access is METERED, and the
   * recorded dollars are still the usage repriced at catalog list rates so
   * every harness arm shares one price basis. reasoning_tokens are added to
   * output (the billing convention for reasoning output). */
  hermes: {
    label: 'Hermes Agent (one-shot, metered provider)',
    access: 'metered provider (OpenRouter)',
    async version() { return versionOf('hermes'); },
    async attempt({ prompt, model, timeoutMs }) {
      const usageFile = `/tmp/sbench-hermes-${Math.random().toString(36).slice(2)}.json`;
      const args = ['-z', prompt, '--usage-file', usageFile];
      if (model) args.push('-m', model, '--provider', 'openrouter');
      const r = await run('hermes', args, { timeoutMs });
      if (r.signal === 'SIGKILL') return { infra: true, detail: `harness timeout after ${timeoutMs}ms` };
      let u;
      try { u = JSON.parse((await import('node:fs')).readFileSync(usageFile, 'utf8')); }
      catch { return { infra: true, detail: 'no usage file from hermes — cannot reprice, attempt excluded (fail closed)' }; }
      if (u.failed) return { infra: true, detail: 'hermes reported failed session' };
      return {
        text: r.out,
        usage: {
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_tokens ?? 0,
          cacheWrite: u.cache_write_tokens ?? 0,
          output: (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0),
        },
      };
    },
  },

  /** Claude Code headless: `claude -p --output-format json` on the local
   * subscription login. Model chosen with --model; usage comes from the
   * result envelope. */
  'claude-code': {
    label: 'Claude Code (local subscription)',
    access: 'local subscription login',
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
    access: 'local subscription login',
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
