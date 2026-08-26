import type { BuildPlanV1, BuildRoleV1 } from './build-cost.ts';

/**
 * Org-chart layout for the Composer prototype
 * (docs/redesign-2026-08/composer-concept-architecture.md §2 and §6).
 *
 * `parentRoleId` is the one additive, presentational-only field the
 * architecture doc proposes on `BuildRoleV1`: chart-position hint only,
 * never read by `quoteBuildPlan()` or `analyzeBuildSensitivity()`. The
 * shipped schema's strict allowed-keys parser does not accept it yet (a
 * deliberate follow-up schema change, out of scope for this prototype) —
 * so every call into the untouched engine/schema/export functions goes
 * through `toEnginePlan()` first.
 */
export type ComposerRole = BuildRoleV1 & { parentRoleId?: string | null };
export type ComposerPlan = Omit<BuildPlanV1, 'roles'> & { roles: ComposerRole[] };

/** Layout key for the implicit root used when a plan has zero orchestrator nodes. */
export const TRUNK_STUB_KEY = '__stub__';

export interface RoleGroup {
  workers: ComposerRole[];
  fallbacks: ComposerRole[];
}

export interface ComposerTreeLayout {
  orchestrators: ComposerRole[];
  byParent: Map<string, RoleGroup>;
  parentOrder: string[];
}

/**
 * Pure layout derivation: a function of `role.kind`, role order and
 * `parentRoleId` only, meant to be recomputed on every render rather than
 * stored — the chart can never go stale relative to the plan array.
 *
 * Two-level tree: each orchestrator (or the implicit trunk stub, if the
 * plan has none) anchors one group; every worker/fallback role attaches to
 * the orchestrator named by its `parentRoleId` if that id resolves to a
 * real orchestrator in the plan, otherwise to the first orchestrator (or
 * the stub). Fallback ("other") roles are kept in a separate list per
 * group so callers can render them with the dashed "backup for" grammar.
 */
export function groupsFor(plan: ComposerPlan): ComposerTreeLayout {
  const orchestrators = plan.roles.filter((role) => role.kind === 'orchestrator');
  const rest = plan.roles.filter((role) => role.kind !== 'orchestrator');
  const ids = new Set(plan.roles.map((role) => role.roleId));
  const defaultParent = orchestrators[0]?.roleId ?? null;

  const byParent = new Map<string, RoleGroup>();
  const parentOrder: string[] = [];
  const ensure = (key: string): RoleGroup => {
    if (!byParent.has(key)) {
      byParent.set(key, { workers: [], fallbacks: [] });
      parentOrder.push(key);
    }
    return byParent.get(key)!;
  };

  if (orchestrators.length === 0) ensure(TRUNK_STUB_KEY);
  else for (const orchestrator of orchestrators) ensure(orchestrator.roleId);

  for (const role of rest) {
    let key = (role.parentRoleId && ids.has(role.parentRoleId) && role.parentRoleId !== role.roleId)
      ? role.parentRoleId
      : (defaultParent ?? TRUNK_STUB_KEY);
    if (key !== TRUNK_STUB_KEY && !orchestrators.some((orchestrator) => orchestrator.roleId === key)) {
      key = defaultParent ?? TRUNK_STUB_KEY;
    }
    const group = ensure(key);
    (role.kind === 'other' ? group.fallbacks : group.workers).push(role);
  }

  return { orchestrators, byParent, parentOrder };
}

/**
 * Strips `parentRoleId` from every role before a call into
 * `quoteBuildPlan`/`validateUntrustedBuildPlanV1`/`analyzeBuildSensitivity`/
 * the export functions — the exact `BuildPlanV1` shape those already
 * validate today, with zero engine change.
 */
export function toEnginePlan(plan: ComposerPlan): BuildPlanV1 {
  return {
    ...plan,
    roles: plan.roles.map(({ parentRoleId: _parentRoleId, ...rest }) => rest),
  };
}
