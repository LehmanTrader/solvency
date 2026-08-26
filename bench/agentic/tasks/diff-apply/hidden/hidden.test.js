import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../src/diff.js';

const src = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n') + '\n';

test('two hunks with original numbering and offset drift', () => {
  const patch = [
    '--- a/f', '+++ b/f',
    '@@ -1,2 +1,3 @@', ' one', '+one-and-a-half', ' two',
    '@@ -5,2 +6,1 @@', '-five', ' six',
  ].join('\n');
  assert.equal(applyPatch(src, patch), ['one', 'one-and-a-half', 'two', 'three', 'four', 'six'].join('\n') + '\n');
});
test('count-1 shorthand and pure insertion', () => {
  const patch = ['@@ -3 +3 @@', '-three', '+trois'].join('\n');
  assert.equal(applyPatch(src, patch), src.replace('three', 'trois'));
  const ins = ['@@ -6,1 +6,2 @@', ' six', '+seven'].join('\n');
  assert.equal(applyPatch(src, ins), src + 'seven\n');
});
test('no trailing newline preserved', () => {
  const noNl = 'a\nb';
  const patch = ['@@ -2,1 +2,1 @@', '-b', '+B'].join('\n');
  assert.equal(applyPatch(noNl, patch), 'a\nB');
});
test('context mismatch names hunk and original line', () => {
  const patch = ['@@ -2,2 +2,2 @@', ' two', '-thre', '+x'].join('\n');
  assert.throws(() => applyPatch(src, patch), (e) => e.message === 'hunk 1 mismatch at line 3');
  const p2 = ['@@ -1,1 +1,1 @@', '-one', '+1', '@@ -4,1 +4,1 @@', '-fourX', '+4'].join('\n');
  assert.throws(() => applyPatch(src, p2), (e) => e.message === 'hunk 2 mismatch at line 4');
});
test('malformed pieces', () => {
  assert.throws(() => applyPatch(src, '@@ nonsense @@\n one'), (e) => e.message === 'bad hunk header 1');
  assert.throws(() => applyPatch(src, '@@ -1,1 +1,1 @@\n*one'), (e) => e.message === 'bad line in hunk 1');
});
