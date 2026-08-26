import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, leftJoin } from '../src/join.js';

test('parse handles quotes, escapes, embedded separators and CRLF', () => {
  const text = 'id,name,notes\r\n1,"Doe, Jane","said ""hi""\nthen left"\r\n2,Bo,\r\n';
  assert.deepEqual(parse(text), [
    { id: '1', name: 'Doe, Jane', notes: 'said "hi"\nthen left' },
    { id: '2', name: 'Bo', notes: '' },
  ]);
});
test('parse errors carry record numbers', () => {
  assert.throws(() => parse('a,b\n1,"open'), (e) => e.message === 'unterminated quote in record 2');
  assert.throws(() => parse('a,b\n1,2,3'), (e) => e.message === 'record 2 has 3 fields, expected 2');
});
test('left join aggregates and keeps unmatched left rows', () => {
  const left = 'sku,label\nA,"Widget, big"\nB,Gadget\nC,Gizmo';
  const right = 'sku,qty,price\nA,2,10\nA,3,7\nC,1,5';
  const out = leftJoin(left, right, 'sku', { qty: 'sum', price: 'max', sku: 'count' });
  assert.equal(out, [
    'sku,label,qty,price,sku',
    'A,"Widget, big",5,10,2',
    'B,Gadget,0,,0',
    'C,Gizmo,1,5,1',
  ].join('\n'));
});
test('missing key columns throw', () => {
  assert.throws(() => leftJoin('a\n1', 'b\n2', 'a', {}), (e) => e.message === 'missing key a');
  assert.throws(() => leftJoin('a\n1', 'a\n2', 'zz', {}), (e) => e.message === 'missing key zz');
});
test('minimal quoting on output', () => {
  const left = 'k,v\n1,"a\nb"';
  const right = 'k,n\n1,3';
  assert.equal(leftJoin(left, right, 'k', { n: 'sum' }), 'k,v,n\n1,"a\nb",3');
});
