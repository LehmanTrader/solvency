import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFire } from '../src/cron.js';

const T = (...a) => Date.UTC(...a);

test('every 15 minutes, strict after', () => {
  const from = T(2026, 0, 1, 10, 15, 0);
  assert.equal(nextFire('*/15 * * * *', from), T(2026, 0, 1, 10, 30, 0));
  assert.equal(nextFire('*/15 * * * *', from - 1), T(2026, 0, 1, 10, 15, 0));
});
test('names, lists and ranges', () => {
  // 09:30 on weekdays in March
  const from = T(2026, 2, 6, 10, 0, 0); // Fri Mar 6 2026 10:00, after 09:30
  assert.equal(nextFire('30 9 * MAR mon-fri', from), T(2026, 2, 9, 9, 30, 0)); // Monday
});
test('dom/dow union when both restricted', () => {
  // day 13 OR Friday
  const from = T(2026, 1, 1, 0, 0, 0); // Feb 1 2026 (Sunday)
  assert.equal(nextFire('0 0 13 * 5', from), T(2026, 1, 6, 0, 0, 0)); // first Friday Feb 6
  assert.equal(nextFire('0 0 13 * 5', T(2026, 1, 6, 0, 0, 0)), T(2026, 1, 13, 0, 0, 0)); // then the 13th (also Fri)
});
test('only dom restricted must match, leap year Feb 29', () => {
  const from = T(2026, 1, 27, 0, 0, 0);
  assert.equal(nextFire('0 12 29 2 *', from), T(2028, 1, 29, 12, 0, 0));
});
test('stepped range', () => {
  const from = T(2026, 0, 1, 0, 0, 0);
  assert.equal(nextFire('10-40/10 2 * * *', from), T(2026, 0, 1, 2, 10, 0));
  assert.equal(nextFire('10-40/10 2 * * *', T(2026, 0, 1, 2, 10, 0)), T(2026, 0, 1, 2, 20, 0));
});
test('exact errors', () => {
  assert.throws(() => nextFire('* * * *', 0), (e) => e.message === 'expected 5 fields, got 4');
  assert.throws(() => nextFire('61 * * * *', 0), (e) => e.message === 'bad field 1: 61');
  assert.throws(() => nextFire('* * * * 7', 0), (e) => e.message === 'bad field 5: 7');
  assert.throws(() => nextFire('* * 0 * *', 0), (e) => e.message === 'bad field 3: 0');
  assert.throws(() => nextFire('* * * FOO *', 0), (e) => e.message === 'bad field 4: FOO');
  assert.throws(() => nextFire('5-3 * * * *', 0), (e) => e.message === 'bad field 1: 5-3');
  assert.throws(() => nextFire('*/0 * * * *', 0), (e) => e.message === 'bad field 1: */0');
});
