import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindows } from '../src/window.js';

test('out-of-order events aggregate; finalize in order with lateness', () => {
  const finals = [];
  const w = createWindows(100, 50, (f) => finals.push(f));
  assert.equal(w.add(150, 5), 'ok');
  assert.equal(w.add(30, 1), 'ok');
  assert.equal(w.add(90, 3), 'ok');
  assert.equal(w.add(199, 7), 'ok');
  w.watermark(149); // window0 end=100, +50 lateness => finalize at 150
  assert.deepEqual(finals, []);
  w.watermark(150);
  assert.deepEqual(finals, [{ start: 0, end: 100, count: 2, sum: 4, min: 1, max: 3 }]);
  assert.equal(w.add(95, 9), 'late');
  w.watermark(250);
  assert.deepEqual(finals[1], { start: 100, end: 200, count: 2, sum: 12, min: 5, max: 7 });
});
test('watermark never regresses; empty windows silent; ascending final order', () => {
  const finals = [];
  const w = createWindows(10, 0, (f) => finals.push(f.start));
  w.add(5, 1); w.add(25, 1); // windows 0 and 2; window 1 empty
  w.watermark(100);
  w.watermark(40); // no-op
  assert.deepEqual(finals, [0, 20]);
  w.watermark(100); // idempotent
  assert.deepEqual(finals, [0, 20]);
});
test('pending lists open windows ascending, drains on finalize', () => {
  const w = createWindows(10, 5, () => {});
  w.add(35, 1); w.add(5, 1); w.add(17, 1);
  assert.deepEqual(w.pending(), [0, 10, 30]);
  w.watermark(15); // finalize window 0 (end 10 + 5 <= 15)
  assert.deepEqual(w.pending(), [10, 30]);
});
test('event exactly at a boundary lands in the higher window', () => {
  const finals = [];
  const w = createWindows(100, 0, (f) => finals.push(f));
  w.add(100, 2);
  w.watermark(200);
  assert.deepEqual(finals, [{ start: 100, end: 200, count: 1, sum: 2, min: 2, max: 2 }]);
});
