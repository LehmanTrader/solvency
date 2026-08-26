import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/validate.js';
test('defaults applied', () => {
  assert.deepEqual(validateConfig({ port: 8080 }), { port: 8080, host: 'localhost', retries: 3 });
});
test('normalized shape only', () => {
  assert.deepEqual(validateConfig({ port: 1, host: 'x', retries: 0, extra: true }), { port: 1, host: 'x', retries: 0 });
});
test('collects every problem sorted by field', () => {
  assert.throws(() => validateConfig({ host: '', retries: -1 }),
    (e) => e.message === 'invalid config: host empty; port missing; retries out of range');
});
test('non-integer port', () => {
  assert.throws(() => validateConfig({ port: 80.5 }), (e) => e.message === 'invalid config: port not an integer');
});
test('port range', () => {
  assert.throws(() => validateConfig({ port: 70000 }), (e) => e.message === 'invalid config: port out of range');
});
