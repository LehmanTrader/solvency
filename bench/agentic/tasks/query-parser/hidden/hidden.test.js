import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/query.js';

const doc = { title: 'Solvent Pricing Engine', body: 'cost per solved task, measured daily' };

test('bare terms, any-field, case-insensitive, word boundaries', () => {
  assert.equal(compile('pricing')(doc), true);
  assert.equal(compile('COST')(doc), true);
  assert.equal(compile('solve')(doc), false); // 'solved' is not the word 'solve'
});
test('field terms and phrases', () => {
  assert.equal(compile('title:engine')(doc), true);
  assert.equal(compile('body:engine')(doc), false);
  assert.equal(compile('"per solved task"')(doc), true);
  assert.equal(compile('title:"pricing engine"')(doc), true);
  assert.equal(compile('"solved cost"')(doc), false);
});
test('precedence: NOT over AND over OR; juxtaposition is AND', () => {
  assert.equal(compile('missing OR cost AND task')(doc), true);
  assert.equal(compile('cost AND missing OR task')(doc), true);
  assert.equal(compile('NOT cost OR missing')(doc), false);
  assert.equal(compile('cost task')(doc), true);
  assert.equal(compile('cost NOT task')(doc), false);
  assert.equal(compile('(missing OR cost) AND (task OR absent)')(doc), true);
});
test('exact errors', () => {
  assert.throws(() => compile('(a AND b'), (e) => e.message === 'unbalanced parens');
  assert.throws(() => compile('a) OR b'), (e) => e.message === 'unbalanced parens');
  assert.throws(() => compile('"broken'), (e) => e.message === 'unterminated phrase');
  assert.throws(() => compile('AND b'), (e) => e.message === 'dangling operator');
  assert.throws(() => compile('a OR'), (e) => e.message === 'dangling operator');
  assert.throws(() => compile('a NOT'), (e) => e.message === 'dangling operator');
  assert.throws(() => compile(''), (e) => e.message === 'empty query');
  assert.throws(() => compile('()'), (e) => e.message === 'empty query');
});
