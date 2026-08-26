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
  /**
   * "mobile app" — the option text, WITHOUT a leading article (stage 1.2,
   * Roy's note 2: "the drop down should just be the type of project without
   * a in front a should be part of the sentence"). The sentence supplies its
   * own article via bucketArticle() below, so it can switch a/an per option.
   */
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

/**
 * True if `word` most likely takes "an" rather than "a" — the first
 * alphanumeric character is a vowel letter (A E I O U). This also correctly
 * handles an acronym pronounced with a vowel-sound letter name ("an API",
 * first letter A), while a consonant-sound acronym ("a CLI tool", "C" is
 * pronounced /siː/) and a digit spoken with a consonant ("a 2D game", "2" is
 * "two") both fall through to "a" — every current bucket label, plus the
 * acronym case direction.md's stage-1.2 note calls out by name. Not a full
 * English-grammar solution (e.g. "a European" would be wrong), but it is
 * automatic, so a new bucket never needs its article hand-picked.
 */
export const startsWithVowelSound = (word: string): boolean => /^[aeiou]/i.test(word);
export const articleFor = (word: string): 'a' | 'an' => (startsWithVowelSound(word) ? 'an' : 'a');

/**
 * The hero sentence's live article, WITH its trailing space baked in so the
 * markup never has to reason about double/missing spaces: "a " / "an " for
 * a real bucket, "" for the "something else" escape hatch (id 'other',
 * which isn't in `buckets` — "I want to ship something else." takes no
 * article at all).
 */
export const bucketArticle = (buckets: TaskBucket[], id: string): string => {
  if (id === 'other') return '';
  const b = bucketById(buckets, id);
  return b ? `${articleFor(b.label)} ` : '';
};

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
