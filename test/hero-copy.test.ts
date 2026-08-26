/**
 * Pins the rebuilt hero (site/src/components/Calculator.astro): the default
 * "I want to ship a [bucket]" sentence and project-total answer, the
 * "something else" escape hatch, the provenance line linking Research Note
 * 03, and the quiet monthly-mode toggle that keeps old tasks-per-month links
 * working. See test/hero-task-buckets.test.ts for the bucket-median data
 * itself and test/slider-ticks.test.ts for the monthly-mode slider ticks,
 * both of which this file leaves untouched.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const src = readFileSync(join(ROOT, 'site', 'src', 'components', 'Calculator.astro'), 'utf8');
const tasksLib = readFileSync(join(ROOT, 'site', 'src', 'lib', 'tasks.ts'), 'utf8');
const tasksShared = readFileSync(join(ROOT, 'site', 'src', 'lib', 'tasks-shared.ts'), 'utf8');
// Everything from the opening <script> tag to its closing tag: the client
// island, which Astro/Vite bundles for the browser (no node:fs there).
const clientScript = src.match(/<script>[\s\S]*<\/script>/)?.[0] ?? '';

describe('hero: bucket mode is the default sentence', () => {
  test('the hero sentence is "I want to ship a [bucket]", not the old "I build [tier] tasks..."', () => {
    assert.match(src, /I want to ship\{' '\}<span id="c-bucket-article">\{defaultArticle\}<\/span><select id="c-bucket"/);
    assert.match(src, /class="sentence mode-bucket mt-6"/);
  });

  // Stage 1.2 (Roy's note 2): "the drop down should just be the type of
  // project without a in front a should be part of the sentence" — the
  // article moved out of each option's label and into the sentence itself
  // (#c-bucket-article), switching a/an automatically per selection.
  test('the article lives in the sentence, not in the dropdown options — and switches a/an automatically', () => {
    assert.match(src, /const defaultArticle = bucketArticle\(TASK_BUCKETS, defaultBucket\.id\);/);
    assert.match(src, /import \{ TASK_BUCKETS, bucketById, provenanceHtml, bucketArticle \} from '\.\.\/lib\/tasks\.ts';/);
    const tasksShared = readFileSync(join(ROOT, 'site', 'src', 'lib', 'tasks-shared.ts'), 'utf8');
    assert.match(tasksShared, /export const articleFor = \(word: string\): 'a' \| 'an' =>/);
    assert.match(tasksShared, /export const bucketArticle = \(buckets: TaskBucket\[\], id: string\): string =>/);
    // client island keeps the visible article in sync with the selected bucket
    assert.match(clientScript, /const syncBucketArticle = \(\) => \{ bucketArticleEl\.textContent = bucketArticle\(TASK_BUCKETS, CTRL\.bucket\.value\); \};/);
    assert.match(clientScript, /from '\.\.\/lib\/tasks-shared\.ts'/);
  });

  test('the bucket options are exactly the six measured buckets plus the escape hatch, with no leading article on any label', () => {
    assert.match(src, /\{TASK_BUCKETS\.map\(\(b\) => <option value=\{b\.id\} selected=\{b\.id === defaultBucket\.id\}>\{b\.label\}<\/option>\)\}/);
    assert.match(src, /<option value="other">something else<\/option>/);
    const tasksLib2 = readFileSync(join(ROOT, 'site', 'src', 'lib', 'tasks.ts'), 'utf8');
    for (const label of ['web app', 'mobile app', 'marketing site', '2D game', 'CLI tool', 'data/ML pipeline']) {
      assert.match(tasksLib2, new RegExp(`label: '${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`), label);
    }
    assert.doesNotMatch(tasksLib2, /label: 'a /, 'a bucket label still carries its old leading article');
  });

  test('the default bucket is mobile (median 48), matching the design\'s worked example', () => {
    assert.match(src, /const defaultBucket = bucketById\('mobile'\)!;/);
  });

  test('"something else" reveals a task-count input, the only place a raw count appears in bucket mode', () => {
    assert.match(src, /<p id="c-other-row" class="mode-bucket small mt-2 hidden">/);
    assert.match(src, /<input id="c-taskcount"[^>]*data-ctl="taskcount"/);
  });

  test('the answer card is the project total, not the monthly callout, at build time', () => {
    assert.match(src, /const project = projectTotalHtml\(rows, defaultBucket\.median\);/);
    assert.match(src, /<p id="c-callout"[^>]*set:html=\{project\}>/);
  });

  test('the provenance line sits under the answer and links Research Note 03', () => {
    assert.match(src, /<p id="c-provenance" class="small mt-2" aria-live="polite" set:html=\{provenance\}><\/p>/);
    // The actual link markup (provenanceHtml/otherProvenanceHtml) lives in the
    // pure, node:fs-free ../lib/tasks-shared.ts, imported by both the server
    // frontmatter (via ../lib/tasks.ts's re-export) and the client island
    // directly — one definition, never duplicated.
    assert.match(tasksShared, /href="\/research\/what-is-a-task"/);
    assert.match(tasksShared, /export const provenanceHtml/);
    assert.match(tasksShared, /export const otherProvenanceHtml/);
    assert.match(tasksLib, /export \{ fmtTasks, provenanceHtml, otherProvenanceHtml, bucketArticle \};/);
  });

  test('the client island never imports ../lib/tasks.ts (node:fs; would break the browser bundle) — only the pure ../lib/tasks-shared.ts, with the server-computed buckets passed as embedded JSON', () => {
    assert.doesNotMatch(clientScript, /from '\.\.\/lib\/tasks\.ts'/, 'client script imports the node:fs-based tasks.ts');
    assert.match(clientScript, /from '\.\.\/lib\/tasks-shared\.ts'/);
    assert.match(clientScript, /JSON\.parse\(document\.getElementById\('task-buckets-data'\)!\.textContent!\)/);
    assert.match(src, /<script type="application\/json" id="task-buckets-data" is:inline set:html=\{JSON\.stringify\(TASK_BUCKETS\)\}><\/script>/);
  });

  test('the task tier control is a secondary row, not inside the hero sentence', () => {
    const heroSentence = src.match(/I want to ship\{' '\}<span id="c-bucket-article">[\s\S]*?<\/select>\.\s*<\/p>/)?.[0] ?? '';
    assert.doesNotMatch(heroSentence, /c-tier-bucket|Task tier/, 'tier control leaked into the hero sentence');
    assert.match(src, /Task tier:\{' '\}<select id="c-tier-bucket"/);
  });

  test('a quiet toggle restores monthly mode, and the legacy monthly sentence and slider still exist', () => {
    assert.match(src, /id="c-mode-toggle"[^>]*>pricing ongoing work instead\?<\/button>/);
    assert.match(src, /class="sentence mode-monthly hidden mt-6"/);
    assert.match(src, /I build\{' '\}<select id="c-tier"/);
    assert.match(src, /<div class="ticks small" aria-hidden="true">/);
  });

  test('the copy link URL carries mode, bucket and task count for shareable state', () => {
    assert.match(src, /mode, bucket: CTRL\.bucket\.value/);
    assert.match(src, /if \(CTRL\.bucket\.value === 'other'\) p\.set\('taskcount', CTRL\.taskcount\.value\);/);
  });

  test('a link that already encodes ?volume= keeps opening in monthly mode when ?mode= is absent', () => {
    assert.match(src, /q\.has\('volume'\) \? 'monthly' : 'bucket'/);
  });
});
