import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import rehypeAccessibleTableCaptions from '../site/src/lib/rehype-table-captions.mjs';

const ROOT = join(import.meta.dirname, '..');

const headers = [
  ['Model', 'Harness', 'Index', '$ / task', '$ / solved task'],
  ['Model', 'Source', 'Pass', 'Age', 'Light', 'Moderate', 'Heavy'],
  ['Variant', 'Formula'],
  ['Parameter', 'Value', 'Provenance'],
  ['Source', 'Tasks', 'Covers 2026 models', 'Publishes cost', 'Newest entry'],
];

const table = (labels: string[]) => ({
  type: 'element', tagName: 'table', properties: {}, children: [{
    type: 'element', tagName: 'thead', properties: {}, children: [{
      type: 'element', tagName: 'tr', properties: {}, children: labels.map((label) => ({
        type: 'element', tagName: 'th', properties: {}, children: [{ type: 'text', value: label }],
      })),
    }],
  }],
});

test('the Markdown pipeline gives every Note 01 data table a static hidden caption', () => {
  const markdown = readFileSync(join(ROOT, 'reports/2026-08-cost-per-solved-task.md'), 'utf8');
  const lines = markdown.split('\n');
  const markdownTables = lines.filter((line, index) => /^\|.+\|$/.test(line)
    && /^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[index + 1] ?? ''));
  assert.equal(markdownTables.length, 5);

  const tree: any = { type: 'root', children: headers.map(table) };
  const transform = rehypeAccessibleTableCaptions();
  transform(tree);
  const captions = tree.children.map((node: any) => node.children[0]);
  assert.deepEqual(captions.map((caption: any) => caption.tagName), Array(5).fill('caption'));
  assert.deepEqual(captions.map((caption: any) => caption.properties.className), Array(5).fill(['sr-only']));
  assert.deepEqual(captions.map((caption: any) => caption.children[0].value), [
    'Measured model and harness results, including cost per task and cost per solved task.',
    'Modelled cost per solved task by benchmark source, pass rate, age and workload tier.',
    'Retry-cost calculation variants and their formulas.',
    'Cost-model assumptions, values and provenance.',
    'Research sources, coverage, cost publication and newest available entry.',
  ]);

  transform(tree);
  for (const node of tree.children) {
    assert.equal(node.children.filter((child: any) => child.tagName === 'caption').length, 1);
  }
  const config = readFileSync(join(ROOT, 'site/astro.config.mjs'), 'utf8');
  assert.match(config, /processor:\s*unified\(\{[\s\S]*rehypePlugins:\s*\[rehypeAccessibleTableCaptions\]/);
});
