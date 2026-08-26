import test from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo } from '../src/time.js';
test('one minute is singular', () => assert.equal(timeAgo(0, 61_000), '1 minute ago'));
test('three days is days ago', () => assert.equal(timeAgo(0, 3 * 86_400_000), '3 days ago'));
