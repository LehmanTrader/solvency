import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupsFor, toEnginePlan, TRUNK_STUB_KEY,
  type ComposerPlan, type ComposerRole,
} from '../site/src/lib/composer-tree.ts';

const role = (overrides: Partial<ComposerRole> & Pick<ComposerRole, 'roleId' | 'kind'>): ComposerRole => ({
  label: overrides.roleId,
  modelId: 'claude-fable-5',
  expectedInvocationsPerBuildAttempt: 1,
  usagePerInvocation: {
    uncachedInputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 100, basis: 'template_assumption',
  },
  parentRoleId: null,
  ...overrides,
});

const makePlan = (roles: ComposerRole[]): ComposerPlan => ({
  schemaVersion: 1,
  name: 'Composer preview stack',
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: 'Custom harness', version: null, configBasis: 'user_supplied',
    fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0,
  },
  roles,
});

describe('Composer org-chart layout (groupsFor)', () => {
  test('an empty plan yields only the implicit trunk stub group', () => {
    const layout = groupsFor(makePlan([]));
    assert.equal(layout.orchestrators.length, 0);
    assert.deepEqual(layout.parentOrder, [TRUNK_STUB_KEY]);
    assert.deepEqual(layout.byParent.get(TRUNK_STUB_KEY), { workers: [], fallbacks: [] });
  });

  test('a lone orchestrator anchors its own group with no children', () => {
    const orchestrator = role({ roleId: 'o1', kind: 'orchestrator' });
    const layout = groupsFor(makePlan([orchestrator]));
    assert.deepEqual(layout.orchestrators, [orchestrator]);
    assert.deepEqual(layout.parentOrder, ['o1']);
    assert.deepEqual(layout.byParent.get('o1'), { workers: [], fallbacks: [] });
  });

  test('a worker with no parentRoleId defaults to the first orchestrator', () => {
    const orchestrator = role({ roleId: 'o1', kind: 'orchestrator' });
    const worker = role({ roleId: 'w1', kind: 'worker' });
    const layout = groupsFor(makePlan([orchestrator, worker]));
    assert.deepEqual(layout.byParent.get('o1')!.workers, [worker]);
  });

  test('a worker explicitly reparented to a second orchestrator groups under that one', () => {
    const first = role({ roleId: 'o1', kind: 'orchestrator' });
    const second = role({ roleId: 'o2', kind: 'orchestrator' });
    const worker = role({ roleId: 'w1', kind: 'worker', parentRoleId: 'o2' });
    const layout = groupsFor(makePlan([first, second, worker]));
    assert.deepEqual(layout.byParent.get('o1')!.workers, []);
    assert.deepEqual(layout.byParent.get('o2')!.workers, [worker]);
    assert.deepEqual(layout.parentOrder, ['o1', 'o2']);
  });

  test('fallback ("other") roles land in the fallbacks list, not workers', () => {
    const orchestrator = role({ roleId: 'o1', kind: 'orchestrator' });
    const fallback = role({ roleId: 'f1', kind: 'other' });
    const layout = groupsFor(makePlan([orchestrator, fallback]));
    assert.deepEqual(layout.byParent.get('o1')!.fallbacks, [fallback]);
    assert.deepEqual(layout.byParent.get('o1')!.workers, []);
  });

  test('a self-referencing parentRoleId falls back to the default parent, never a self-loop', () => {
    const orchestrator = role({ roleId: 'o1', kind: 'orchestrator' });
    const worker = role({ roleId: 'w1', kind: 'worker', parentRoleId: 'w1' });
    const layout = groupsFor(makePlan([orchestrator, worker]));
    assert.deepEqual(layout.byParent.get('o1')!.workers, [worker]);
  });

  test('a parentRoleId pointing at a non-orchestrator role falls back to the default parent', () => {
    const orchestrator = role({ roleId: 'o1', kind: 'orchestrator' });
    const workerA = role({ roleId: 'w1', kind: 'worker' });
    const workerB = role({ roleId: 'w2', kind: 'worker', parentRoleId: 'w1' });
    const layout = groupsFor(makePlan([orchestrator, workerA, workerB]));
    assert.deepEqual(layout.byParent.get('o1')!.workers, [workerA, workerB]);
  });

  test('with zero orchestrators, every worker/fallback attaches to the trunk stub', () => {
    const worker = role({ roleId: 'w1', kind: 'worker' });
    const fallback = role({ roleId: 'f1', kind: 'other' });
    const layout = groupsFor(makePlan([worker, fallback]));
    assert.deepEqual(layout.parentOrder, [TRUNK_STUB_KEY]);
    assert.deepEqual(layout.byParent.get(TRUNK_STUB_KEY), { workers: [worker], fallbacks: [fallback] });
  });

  test('is a pure function: the same plan input always derives the same layout, and the input is untouched', () => {
    const plan = makePlan([
      role({ roleId: 'o1', kind: 'orchestrator' }),
      role({ roleId: 'w1', kind: 'worker' }),
    ]);
    const before = JSON.stringify(plan);
    const first = groupsFor(plan);
    const second = groupsFor(plan);
    assert.deepEqual([...first.byParent.get('o1')!.workers], [...second.byParent.get('o1')!.workers]);
    assert.equal(JSON.stringify(plan), before);
  });
});

describe('Composer engine-plan sanitizer (toEnginePlan)', () => {
  test('strips parentRoleId from every role, leaving every other field untouched', () => {
    const plan = makePlan([
      role({ roleId: 'o1', kind: 'orchestrator', parentRoleId: null }),
      role({ roleId: 'w1', kind: 'worker', parentRoleId: 'o1' }),
    ]);
    const enginePlan = toEnginePlan(plan);
    assert.equal(enginePlan.roles.length, 2);
    for (const engineRole of enginePlan.roles) {
      assert.ok(!('parentRoleId' in engineRole), 'engine plan roles must not carry the chart-only field');
    }
    assert.equal(enginePlan.roles[1].roleId, 'w1');
    assert.equal(enginePlan.roles[1].modelId, 'claude-fable-5');
  });

  test('does not mutate the source ComposerPlan', () => {
    const plan = makePlan([role({ roleId: 'o1', kind: 'orchestrator', parentRoleId: 'o1' })]);
    toEnginePlan(plan);
    assert.equal(plan.roles[0].parentRoleId, 'o1');
  });
});
