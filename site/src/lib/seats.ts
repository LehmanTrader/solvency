/**
 * Seat economics: reprice real usage at the verified metered catalog.
 *
 * The browser-side twin of tools/seats-report/generate.mjs — same method
 * (subscription_usage_repriced), same fail-closed posture: cache reads at
 * the cached-input rate, cache writes at the uncached input rate (stated),
 * unknown models excluded and listed, never guessed. Flat fees never enter
 * per-task math. test/seats-report.test.ts pins this file and the CLI to
 * the same hand-computed figures so the two implementations cannot drift.
 */

export interface UsageRow {
  seat: string;
  date: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricedModel {
  model_id: string;
  display_name?: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cached_input_per_mtok?: number | null;
}

const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Match a usage export's model name to a catalog row (tail-tolerant). */
export function findModel(models: PricedModel[], name: string): PricedModel | null {
  const tail = String(name).split('/').pop() ?? '';
  const n = norm(tail);
  return models.find((m) => norm(m.model_id) === n)
    ?? models.find((m) => norm(m.model_id).includes(n) || n.includes(norm(m.model_id)))
    ?? null;
}

const HEADERS = {
  seat: ['seat', 'api_key_name', 'key', 'user'],
  model: ['model', 'model_id', 'model_permaslug'],
  date: ['date', 'day', 'usage_date'],
  input: ['input_tokens', 'tokens_prompt', 'prompt_tokens', 'n_context_tokens_total'],
  output: ['output_tokens', 'tokens_completion', 'completion_tokens', 'n_generated_tokens_total'],
  cacheRead: ['cache_read_tokens', 'tokens_cached', 'cached_tokens'],
  cacheWrite: ['cache_write_tokens', 'cache_creation_tokens'],
};

/** Parse a usage CSV (generic / OpenRouter / OpenAI-platform headers). */
export function parseUsageCsv(text: string): { rows: UsageRow[]; error?: string } {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return { rows: [], error: 'empty file' };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    seat: col(HEADERS.seat), model: col(HEADERS.model), date: col(HEADERS.date),
    input: col(HEADERS.input), output: col(HEADERS.output),
    cacheRead: col(HEADERS.cacheRead), cacheWrite: col(HEADERS.cacheWrite),
  };
  if (c.model < 0 || c.input < 0 || c.output < 0)
    return { rows: [], error: `unrecognized CSV header: ${header.join(',')}` };
  const rows: UsageRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    rows.push({
      seat: c.seat >= 0 ? f[c.seat]?.trim() || 'default' : 'default',
      date: c.date >= 0 ? f[c.date]?.trim() || '' : '',
      model: f[c.model]?.trim() ?? '',
      input: Number(f[c.input]) || 0,
      output: Number(f[c.output]) || 0,
      cacheRead: c.cacheRead >= 0 ? Number(f[c.cacheRead]) || 0 : 0,
      cacheWrite: c.cacheWrite >= 0 ? Number(f[c.cacheWrite]) || 0 : 0,
    });
  }
  return { rows };
}

/** USD for one usage row at a catalog row's metered rates. */
export function priceUsage(u: Pick<UsageRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, m: PricedModel): number {
  const cached = m.cached_input_per_mtok ?? m.input_per_mtok;
  return (u.input * m.input_per_mtok + u.cacheRead * cached + u.cacheWrite * m.input_per_mtok + u.output * m.output_per_mtok) / 1e6;
}

export interface SeatReport {
  seat: string;
  calls: number;
  usd: number;
  input: number;
  output: number;
  cacheRead: number;
  unknownCalls: number;
  byModel: Array<{ model: string; display: string; usd: number; calls: number }>;
}

export function buildSeatReports(rows: UsageRow[], models: PricedModel[]): {
  seats: SeatReport[];
  unknown: Array<{ model: string; calls: number }>;
} {
  const seats = new Map<string, SeatReport>();
  const unknown = new Map<string, number>();
  const modelCache = new Map<string, PricedModel | null>();
  for (const r of rows) {
    if (!modelCache.has(r.model)) modelCache.set(r.model, findModel(models, r.model));
    const m = modelCache.get(r.model)!;
    const s = seats.get(r.seat) ?? { seat: r.seat, calls: 0, usd: 0, input: 0, output: 0, cacheRead: 0, unknownCalls: 0, byModel: [] };
    if (!m) {
      s.unknownCalls++;
      unknown.set(r.model, (unknown.get(r.model) ?? 0) + 1);
    } else {
      const usd = priceUsage(r, m);
      s.usd += usd;
      let bm = s.byModel.find((b) => b.model === m.model_id);
      if (!bm) { bm = { model: m.model_id, display: m.display_name ?? m.model_id, usd: 0, calls: 0 }; s.byModel.push(bm); }
      bm.usd += usd; bm.calls++;
    }
    s.calls++; s.input += r.input; s.output += r.output; s.cacheRead += r.cacheRead;
    seats.set(r.seat, s);
  }
  const list = [...seats.values()].sort((a, b) => b.usd - a.usd);
  for (const s of list) s.byModel.sort((a, b) => b.usd - a.usd);
  return { seats: list, unknown: [...unknown.entries()].map(([model, calls]) => ({ model, calls })) };
}

export type VerdictClass = 'ok' | 'warn' | 'over';

/** Same thresholds as the CLI: ≥1.5× keep · 0.8–1.5× near break-even · 0.2–0.8× review · <0.2× move to metered. */
export function verdictFor(s: SeatReport, fee: number): { verdict: string; cls: VerdictClass } {
  if (s.unknownCalls > s.calls * 0.2) return { verdict: 'incomplete — unknown models', cls: 'warn' };
  if (s.usd >= fee * 1.5) return { verdict: 'keep — seat clearly earns its fee', cls: 'ok' };
  if (s.usd >= fee * 0.8) return { verdict: 'keep — near break-even', cls: 'ok' };
  if (s.usd >= fee * 0.2) return { verdict: 'review — consider a lower tier', cls: 'warn' };
  return { verdict: 'move to metered API key', cls: 'over' };
}
