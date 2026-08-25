/**
 * The pure half of ../lib/tasks.ts: types and formatting only, no Node
 * builtins. ../lib/tasks.ts (which reads and parses
 * data/task-study/final_table.csv via node:fs) is server/build-only — Astro
 * bundles anything a client <script> imports for the browser, where node:fs
 * doesn't exist. Calculator.astro's client island imports its pure helpers
 * from here instead, working on a TASK_BUCKETS array the server embeds in
 * the page as JSON (see #task-buckets-data), so the numbers still trace to
 * exactly one computation — ../lib/tasks.ts — and this file only formats them.
 */

export interface TaskBucket {
  /** Used in the hero <select> value, the URL param and provenance sentence. */
  id: string;
  /** "a mobile app" — sits after "I want to ship" in the hero sentence. */
  label: string;
  /** "mobile apps" — plural, for the provenance sentence. */
  plural: string;
  /** CSV bucket letter (a–f), per data/task-study/README.md. */
  csvBucket: string;
  n: number;
  median: number;
  q1: number;
  q3: number;
}

export const bucketById = (buckets: TaskBucket[], id: string): TaskBucket | undefined =>
  buckets.find((b) => b.id === id);

/** "240.5" or "1,609" — matches reports/2026-08-what-is-a-task.md's own formatting. */
export const fmtTasks = (n: number): string => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1));

/**
 * The house-style provenance line under the hero's project-total answer.
 * Shared by the server render and the client island so the two can never
 * drift apart. `otherProvenanceHtml` covers the "something else" escape
 * hatch, where no bucket study applies.
 */
export const provenanceHtml = (b: TaskBucket): string =>
  `~${fmtTasks(b.median)} tasks: median of ${b.n} shipped ${b.plural} we measured (middle half ${fmtTasks(b.q1)}–${fmtTasks(b.q3)}) · <a class="link" href="/research/what-is-a-task">how we counted →</a>`;

export const otherProvenanceHtml = (taskCount: number): string =>
  `${fmtTasks(taskCount)} tasks — your estimate · <a class="link" href="/research/what-is-a-task">how we define a task →</a>`;
