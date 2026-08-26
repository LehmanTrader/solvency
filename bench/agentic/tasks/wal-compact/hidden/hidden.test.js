import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, compact } from '../src/wal.js';

test('replay with tombstone errors and rename overwrite', () => {
  const { state, errors } = replay([
    { op: 'set', key: 'a', value: 1 },
    { op: 'del', key: 'ghost' },
    { op: 'set', key: 'b', value: 2 },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'rename', from: 'zz', to: 'q' },
  ]);
  assert.deepEqual(state, { b: 1 });
  assert.deepEqual(errors, ['del missing ghost', 'rename missing zz']);
});
test('compact collapses set-then-del and rename chains', () => {
  const ops = [
    { op: 'set', key: 'tmp', value: 9 },
    { op: 'del', key: 'tmp' },
    { op: 'del', key: 'gone' },
    { op: 'rename', from: 'base1', to: 'mid' },
    { op: 'rename', from: 'mid', to: 'final' },
    { op: 'set', key: 'k', value: 3 },
  ];
  assert.deepEqual(compact(ops, ['base1', 'gone']), [
    { op: 'del', key: 'gone' },
    { op: 'rename', from: 'base1', to: 'final' },
    { op: 'set', key: 'k', value: 3 },
  ]);
});
test('a set after a rename fixes the value: rename becomes del + set', () => {
  const ops = [
    { op: 'rename', from: 'x', to: 'y' },
    { op: 'set', key: 'y', value: 7 },
  ];
  assert.deepEqual(compact(ops, ['x']), [
    { op: 'del', key: 'x' },
    { op: 'set', key: 'y', value: 7 },
  ]);
});
test('self-rename chain dropped; untouched base keys emit nothing', () => {
  const ops = [
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'rename', from: 'b', to: 'a' },
  ];
  assert.deepEqual(compact(ops, ['a', 'keep']), []);
});
test('compacted log replays clean and equivalent on a sample store', () => {
  const ops = [
    { op: 'set', key: 'n', value: 1 },
    { op: 'rename', from: 'p', to: 'q' },
    { op: 'del', key: 'n' },
    { op: 'set', key: 'n', value: 2 },
  ];
  const min = compact(ops, ['p', 'dead']);
  const store = { p: 'unknownVal', dead: 'x' };
  const viaOps = replay([...Object.entries(store).map(([key, value]) => ({ op: 'set', key, value })), ...ops]);
  const viaMin = replay([...Object.entries(store).map(([key, value]) => ({ op: 'set', key, value })), ...min]);
  assert.deepEqual(viaMin.state, viaOps.state);
  // replaying the compacted log on the store itself must be error-free:
  assert.deepEqual(viaMin.errors, []);
});
