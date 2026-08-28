/**
 * console-state: the client-side state engine behind /app (console rebuild
 * 2026-08-28, operator: "flesh out the console fully... make the mvp as
 * feature rich as possible"). Everything persists to localStorage so the
 * console feels like a product across visits, and every derived number
 * (team rollups, budget status, alerts, daily series) is a pure function
 * over the loaded usage rows so test/console-state.test.ts can pin the
 * math. No backend: usage stays in the browser, same posture as seats.ts.
 */
import type { SeatReport, UsageRow } from './seats.ts';

const KEY = 'solvency-console-v1';
const MAX_PERSISTED_CSV = 512 * 1024; // larger uploads stay in-memory only

export type IntegrationStatus = 'connected' | 'available' | 'planned';

export interface ConsoleState {
  workspaceName: string;
  plan: string;
  seatFee: number;
  seatTeams: Record<string, string>;
  teamBudgets: Record<string, number>;
  alertsArmed: boolean;
  integrations: Record<string, IntegrationStatus>;
  usageCsv: string | null;
  usageLabel: string | null;
}

export const DEFAULT_STATE: ConsoleState = {
  workspaceName: 'My workspace',
  plan: 'Design partner',
  seatFee: 200,
  seatTeams: {},
  teamBudgets: {},
  alertsArmed: true,
  integrations: {
    'openrouter-csv': 'available',
    'openai-csv': 'available',
    'claude-code-cli': 'available',
    'anthropic-admin': 'planned',
    'hubspot': 'planned',
    'slack-alerts': 'planned',
  },
  usageCsv: null,
  usageLabel: null,
};

export function loadState(): ConsoleState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed, integrations: { ...DEFAULT_STATE.integrations, ...(parsed.integrations ?? {}) } };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: ConsoleState): void {
  try {
    const toStore = { ...state };
    if (toStore.usageCsv && toStore.usageCsv.length > MAX_PERSISTED_CSV) {
      toStore.usageCsv = null;
      toStore.usageLabel = state.usageLabel ? `${state.usageLabel} (too large to keep, reload it next visit)` : null;
    }
    localStorage.setItem(KEY, JSON.stringify(toStore));
  } catch { /* storage may be unavailable; the session still works in memory */ }
}

export function resetState(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Team for a seat: explicit mapping first, else 'unassigned'. */
export function teamOf(seat: string, seatTeams: Record<string, string>): string {
  return seatTeams[seat]?.trim() || 'unassigned';
}

export interface TeamSpend {
  team: string;
  usd: number;
  seats: number;
  fees: number;
}

/** Roll seat reports up to teams. Fees use the flat per-seat fee. */
export function computeTeamSpend(seats: SeatReport[], seatTeams: Record<string, string>, seatFee: number): TeamSpend[] {
  const teams = new Map<string, TeamSpend>();
  for (const s of seats) {
    const team = teamOf(s.seat, seatTeams);
    const t = teams.get(team) ?? { team, usd: 0, seats: 0, fees: 0 };
    t.usd += s.usd; t.seats += 1; t.fees += seatFee;
    teams.set(team, t);
  }
  return [...teams.values()].sort((a, b) => b.usd - a.usd);
}

export type BudgetLevel = 'ok' | 'near' | 'over' | 'none';

export interface BudgetStatus {
  team: string;
  spend: number;
  budget: number | null;
  pct: number | null;
  level: BudgetLevel;
}

/** Status bands: over at 100%, near at 80%, none when no budget is set. */
export function budgetStatus(t: TeamSpend, budgets: Record<string, number>): BudgetStatus {
  const budget = budgets[t.team] > 0 ? budgets[t.team] : null;
  if (budget === null) return { team: t.team, spend: t.usd, budget: null, pct: null, level: 'none' };
  const pct = t.usd / budget;
  return { team: t.team, spend: t.usd, budget, pct, level: pct >= 1 ? 'over' : pct >= 0.8 ? 'near' : 'ok' };
}

export interface AlertItem {
  kind: 'over' | 'near' | 'idle';
  team?: string;
  seat?: string;
  text: string;
}

/**
 * Alerts from the loaded data: budget threshold crossings per team, plus
 * idle seats (a seat whose metered-equivalent is under 5% of its fee).
 */
export function buildAlerts(statuses: BudgetStatus[], seats: SeatReport[], seatFee: number): AlertItem[] {
  const out: AlertItem[] = [];
  for (const s of statuses) {
    if (s.level === 'over') out.push({ kind: 'over', team: s.team, text: `${s.team} is over budget: $${Math.round(s.spend).toLocaleString()} of $${Math.round(s.budget!).toLocaleString()}` });
    else if (s.level === 'near') out.push({ kind: 'near', team: s.team, text: `${s.team} at ${Math.round(s.pct! * 100)}% of its $${Math.round(s.budget!).toLocaleString()} budget` });
  }
  for (const s of seats) {
    if (seatFee > 0 && s.usd < seatFee * 0.05) out.push({ kind: 'idle', seat: s.seat, text: `${s.seat} used $${s.usd.toFixed(2)} against a $${seatFee} seat; consider moving to metered` });
  }
  return out;
}

export interface DailyPoint {
  date: string;
  usd: number;
}

/** Metered-equivalent per day, date-sorted, for the overview chart. */
export function dailySeries(rows: UsageRow[], price: (r: UsageRow) => number | null): DailyPoint[] {
  const days = new Map<string, number>();
  for (const r of rows) {
    const usd = price(r);
    if (usd === null || !r.date) continue;
    days.set(r.date, (days.get(r.date) ?? 0) + usd);
  }
  return [...days.entries()].map(([date, usd]) => ({ date, usd })).sort((a, b) => a.date.localeCompare(b.date));
}

/** SVG path for a simple area chart over the series (viewBox 0 0 w h). */
export function areaPath(series: DailyPoint[], w: number, h: number): { line: string; area: string; max: number } {
  if (!series.length) return { line: '', area: '', max: 0 };
  const max = Math.max(...series.map((p) => p.usd)) || 1;
  const pad = 4;
  const x = (i: number) => series.length === 1 ? w / 2 : pad + (i / (series.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.usd).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(series.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  return { line, area, max };
}
