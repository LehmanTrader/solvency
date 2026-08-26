import test from 'node:test';
import assert from 'node:assert/strict';
import { toc } from '../src/toc.js';

test('nesting with a level jump', () => {
  const md = '# A\n### B\n## C\n# D\n';
  const t = toc(md, 6);
  assert.deepEqual(t.map((n) => n.text), ['A', 'D']);
  assert.deepEqual(t[0].children.map((n) => n.text), ['B', 'C']);
  assert.equal(t[0].children[0].level, 3);
});
test('fenced blocks hide headings, including tilde fences', () => {
  const md = '# Real\n```\n# NotAHeading\n```\n~~~~\n## AlsoHidden\n~~~~\n## Back\n';
  assert.deepEqual(toc(md, 6).map((n) => n.text), ['Real']);
  assert.deepEqual(toc(md, 6)[0].children.map((n) => n.text), ['Back']);
});
test('mismatched fence char does not close', () => {
  const md = '```\n~~~\n# Hidden\n```\n# Shown\n';
  assert.deepEqual(toc(md, 6).map((n) => n.text), ['Shown']);
});
test('slugs: case, punctuation, spaces, duplicates in order', () => {
  const md = '# Hello World!\n## Hello, World\n# hello world\n';
  const flat = [];
  const walk = (ns) => ns.forEach((n) => { flat.push(n.slug); walk(n.children); });
  walk(toc(md, 6));
  assert.deepEqual(flat, ['hello-world', 'hello-world-1', 'hello-world-2']);
});
test('trailing hash run stripped; maxLevel filters; not-a-heading lines ignored', () => {
  const md = '## Keep It ##\n####### seven\n#nospace\n### Deep\n';
  const t = toc(md, 2);
  assert.deepEqual(t.map((n) => [n.text, n.slug, n.level]), [['Keep It', 'keep-it', 2]]);
});
