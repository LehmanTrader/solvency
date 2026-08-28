/**
 * Claude Code usage importer — turns local Claude Code session transcripts
 * (~/.claude/projects/<slug>/*.jsonl) into the generic seats CSV that
 * generate.mjs consumes:
 *
 *   seat,date,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens
 *
 *   node tools/seats-report/import-claude-code.mjs \
 *     --seat alice=~/.claude/projects [--seat bob=/exports/bob] \
 *     [--since 2026-08-01] [--until 2026-08-31] --out usage.csv
 *
 * One --seat name=dir per seat; the directory is walked recursively for
 * .jsonl transcripts. Only assistant entries with a message.usage block are
 * counted. Resumed/continued sessions copy earlier assistant messages into
 * the new transcript verbatim, so rows are deduplicated by message.id per
 * seat — an id seen twice is the same API call, not new spend. Entries with
 * a usage block but no message.id cannot be safely deduplicated and are
 * excluded, counted, and reported (fail closed, same posture as the
 * generator's unknown-model handling). Sidechain (subagent) traffic is real
 * consumption on the seat and is included.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Recursively collect .jsonl files under dir. */
export function findTranscripts(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findTranscripts(p));
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * Parse one transcript's text into entries (Map of message.id ->
 * { model, date, input, output, cacheRead, cacheWrite }); counters.noId
 * counts usage-bearing assistant entries that had no message.id.
 */
export function parseTranscript(text, entries = new Map(), counters = { noId: 0 }) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const u = e.message?.usage;
    if (!u) continue;
    const id = e.message.id;
    if (!id) { counters.noId++; continue; }
    if (entries.has(id)) continue;
    entries.set(id, {
      model: e.message.model ?? 'unknown',
      date: (e.timestamp ?? '').slice(0, 10) || 'unknown',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }
  return { entries, noId: counters.noId };
}

/** Aggregate a seat's deduplicated entries to seat×date×model rows. */
export function aggregate(seat, entries, since, until) {
  const rows = new Map();
  for (const e of entries.values()) {
    if (since && e.date < since) continue;
    if (until && e.date > until) continue;
    const key = `${e.date} ${e.model}`;
    const r = rows.get(key) ?? { seat, date: e.date, model: e.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    r.input += e.input; r.output += e.output; r.cacheRead += e.cacheRead; r.cacheWrite += e.cacheWrite; r.calls++;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model));
}

export function toCsv(rows) {
  const header = 'seat,date,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens';
  return [header, ...rows.map((r) =>
    [r.seat, r.date, r.model, r.input, r.output, r.cacheRead, r.cacheWrite].join(','))].join('\n') + '\n';
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const seats = [];
  let since, until, out = 'usage.csv';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seat') {
      const [name, ...rest] = argv[++i].split('=');
      seats.push({ name, dir: rest.join('=').replace(/^~/, homedir()) });
    } else if (argv[i] === '--since') since = argv[++i];
    else if (argv[i] === '--until') until = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
  }
  if (!seats.length) {
    console.error('usage: --seat name=~/.claude/projects [--seat name2=dir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--out usage.csv]');
    process.exit(1);
  }
  const all = [];
  for (const { name, dir } of seats) {
    const entries = new Map();
    const counters = { noId: 0 };
    const files = findTranscripts(dir);
    for (const f of files) parseTranscript(readFileSync(f, 'utf8'), entries, counters);
    const rows = aggregate(name, entries, since, until);
    const calls = rows.reduce((a, r) => a + r.calls, 0);
    console.error(`${name}: ${files.length} transcripts, ${entries.size} unique messages, ${calls} in window${counters.noId ? `, ${counters.noId} usage entries without message.id EXCLUDED (cannot deduplicate)` : ''}`);
    all.push(...rows);
  }
  writeFileSync(out, toCsv(all));
  console.error(`wrote ${out} — ${all.length} rows`);
}
