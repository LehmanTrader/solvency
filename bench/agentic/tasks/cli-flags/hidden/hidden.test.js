import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const run = (args, input) => execFileSync(process.execPath, ['bin/wordcount.js', ...args], { input: input ?? '', encoding: 'utf8' }).trim();
test('--file words', () => assert.equal(run(['--file', 'notes.txt']), '6'));
test('--file --lines', () => assert.equal(run(['--file', 'notes.txt', '--lines']), '3'));
test('--lines --file order-independent', () => assert.equal(run(['--lines', '--file', 'notes.txt']), '3'));
test('stdin still works', () => assert.equal(run([], 'one two three'), '3'));
