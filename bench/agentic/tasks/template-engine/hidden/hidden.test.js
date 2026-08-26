import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/render.js';
test('raw triple stache does not escape', () => {
  assert.equal(render('{{{h}}}|{{h}}', { h: '<i>' }), '<i>|&lt;i&gt;');
});
test('missing and null are empty', () => {
  assert.equal(render('[{{a}}][{{b}}]', { b: null }), '[][]');
});
test('section fallback to outer scope', () => {
  assert.equal(render('{{#xs}}{{v}}-{{unit}};{{/xs}}', { unit: 'kg', xs: [{ v: 1 }, { v: 2, unit: 'g' }] }), '1-kg;2-g;');
});
test('nested sections', () => {
  const t = '{{#rows}}<tr>{{#cells}}<td>{{c}}</td>{{/cells}}</tr>{{/rows}}';
  const d = { rows: [{ cells: [{ c: 'a' }, { c: 'b' }] }, { cells: [{ c: 'x' }] }] };
  assert.equal(render(t, d), '<tr><td>a</td><td>b</td></tr><tr><td>x</td></tr>');
});
test('non-array section renders nothing', () => {
  assert.equal(render('A{{#nope}}X{{/nope}}B', {}), 'AB');
});
