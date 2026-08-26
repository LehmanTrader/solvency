import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/patch.js';

test('add/replace/remove with escaping and no mutation', () => {
  const doc = { 'a/b': { '~x': 1 }, list: [1, 2] };
  const out = apply(doc, [
    { op: 'replace', path: '/a~1b/~0x', value: 9 },
    { op: 'add', path: '/list/1', value: 5 },
    { op: 'add', path: '/list/-', value: 7 },
    { op: 'remove', path: '/list/0' },
  ]);
  assert.deepEqual(out, { 'a/b': { '~x': 9 }, list: [5, 2, 7] });
  assert.deepEqual(doc, { 'a/b': { '~x': 1 }, list: [1, 2] });
});
test('whole-document replace via empty pointer', () => {
  assert.deepEqual(apply({ a: 1 }, [{ op: 'replace', path: '', value: [3] }]), [3]);
});
test('move within object and array', () => {
  const out = apply({ a: { b: 1 }, c: [10, 20] }, [
    { op: 'move', from: '/a/b', path: '/c/0' },
  ]);
  assert.deepEqual(out, { a: {}, c: [1, 10, 20] });
});
test('move into own subtree throws; move onto itself is a no-op', () => {
  assert.throws(() => apply({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/b/c' }]),
    (e) => e.message === 'cannot move into self');
  assert.deepEqual(apply({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a' }]), { a: { b: 1 } });
});
test('copy is deep', () => {
  const out = apply({ a: { b: [1] } }, [{ op: 'copy', from: '/a', path: '/z' }]);
  out.z.b.push(2);
  assert.deepEqual(out.a.b, [1]);
});
test('test op passes and fails with pointer in message', () => {
  const doc = { a: [1, { k: 'v' }] };
  assert.deepEqual(apply(doc, [{ op: 'test', path: '/a/1', value: { k: 'v' } }]), doc);
  assert.throws(() => apply(doc, [{ op: 'test', path: '/a/0', value: 2 }]),
    (e) => e.message === 'test failed at /a/0');
});
test('exact errors: bad index, missing, missing parent, unknown op', () => {
  assert.throws(() => apply({ a: [1] }, [{ op: 'add', path: '/a/01', value: 0 }]), (e) => e.message === 'bad index 01');
  assert.throws(() => apply({ a: [1] }, [{ op: 'add', path: '/a/5', value: 0 }]), (e) => e.message === 'bad index 5');
  assert.throws(() => apply({ a: [1] }, [{ op: 'remove', path: '/b' }]), (e) => e.message === 'missing /b');
  assert.throws(() => apply({}, [{ op: 'add', path: '/x/y', value: 1 }]), (e) => e.message === 'missing parent /x');
  assert.throws(() => apply({}, [{ op: 'frobnicate', path: '' }]), (e) => e.message === 'unknown op frobnicate');
});
