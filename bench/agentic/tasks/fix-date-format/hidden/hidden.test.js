import test from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo } from '../src/time.js';
test('just now', () => assert.equal(timeAgo(0, 30_000), 'just now'));
test('plural minutes', () => assert.equal(timeAgo(0, 120_000), '2 minutes ago'));
test('singular hour', () => assert.equal(timeAgo(0, 3_600_000), '1 hour ago'));
test('yesterday window', () => assert.equal(timeAgo(0, 30 * 3_600_000), 'yesterday'));
test('many days', () => assert.equal(timeAgo(0, 10 * 86_400_000), '10 days ago'));
