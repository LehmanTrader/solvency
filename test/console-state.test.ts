/**
 * Console math: team rollups, budget bands, alert generation and the daily
 * series behind /app's Overview chart. Pure functions only (persistence
 * needs a browser); fixtures are synthetic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTeamSpend, budgetStatus, buildAlerts, dailySeries, areaPath, teamOf } from '../site/src/lib/console-state.ts';

const seat = (name: string, usd: number) => ({ seat: name, calls: 10, usd, input: 0, output: 0, cacheRead: 0, unknownCalls: 0, byModel: [] });

describe('console-state', () => {
  test('team rollup groups by mapping and defaults to unassigned', () => {
    const seats = [seat('ana', 300), seat('ben', 100), seat('zoe', 50)];
    const rollup = computeTeamSpend(seats, { ana: 'eng', ben: 'eng' }, 200);
    assert.deepEqual(rollup.map((t) => [t.team, t.usd, t.seats, t.fees]),
      [['eng', 400, 2, 400], ['unassigned', 50, 1, 200]]);
  });

  test('budget bands: ok under 80%, near at 80%, over at 100%, none without a budget', () => {
    const mk = (usd: number) => ({ team: 'eng', usd, seats: 1, fees: 200 });
    assert.equal(budgetStatus(mk(79), { eng: 100 }).level, 'ok');
    assert.equal(budgetStatus(mk(80), { eng: 100 }).level, 'near');
    assert.equal(budgetStatus(mk(100), { eng: 100 }).level, 'over');
    assert.equal(budgetStatus(mk(50), {}).level, 'none');
  });

  test('alerts: over and near budgets plus idle seats under 5% of fee', () => {
    const statuses = [
      budgetStatus({ team: 'eng', usd: 120, seats: 1, fees: 200 }, { eng: 100 }),
      budgetStatus({ team: 'mkt', usd: 85, seats: 1, fees: 200 }, { mkt: 100 }),
      budgetStatus({ team: 'ops', usd: 10, seats: 1, fees: 200 }, { ops: 100 }),
    ];
    const alerts = buildAlerts(statuses, [seat('idle-one', 5), seat('busy', 500)], 200);
    assert.deepEqual(alerts.map((a) => a.kind), ['over', 'near', 'idle']);
    assert.match(alerts[0].text, /eng is over budget/);
    assert.match(alerts[2].text, /idle-one/);
  });

  test('daily series aggregates priced rows by date and sorts', () => {
    const rows = [
      { seat: 'a', date: '2026-08-02', model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { seat: 'a', date: '2026-08-01', model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      { seat: 'a', date: '2026-08-01', model: 'x', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ];
    const priced: Record<string, number | null> = { m: 10, x: null };
    const series = dailySeries(rows, (r) => priced[r.model]);
    assert.deepEqual(series, [{ date: '2026-08-01', usd: 10 }, { date: '2026-08-02', usd: 10 }]);
  });

  test('area path spans the box and is empty for an empty series', () => {
    const { line, area } = areaPath([{ date: 'd1', usd: 1 }, { date: 'd2', usd: 2 }], 100, 50);
    assert.match(line, /^M4\.0,/);
    assert.match(area, /Z$/);
    assert.deepEqual(areaPath([], 100, 50), { line: '', area: '', max: 0 });
  });

  test('teamOf trims and falls back to unassigned', () => {
    assert.equal(teamOf('a', { a: ' eng ' }), 'eng');
    assert.equal(teamOf('b', {}), 'unassigned');
  });
});
