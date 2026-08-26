import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.js';

const seeded = () => {
  const inv = createInventory();
  inv.addLot('widget', 'B', 5, 20);
  inv.addLot('widget', 'A', 5, 20);
  inv.addLot('widget', 'C', 10, 10);
  return inv;
};

test('FEFO with lotId tiebreak and a multi-lot draw', () => {
  const inv = seeded();
  const plan = inv.allocate('widget', 12, 'r1');
  assert.deepEqual(plan, [{ lotId: 'C', qty: 10 }, { lotId: 'A', qty: 2 }]);
  assert.equal(inv.onHand('widget'), 8);
  assert.equal(inv.reserved('widget'), 12);
});
test('short allocation changes nothing and names the gap', () => {
  const inv = seeded();
  assert.throws(() => inv.allocate('widget', 21, 'r1'), (e) => e.message === 'short 1 of widget');
  assert.equal(inv.onHand('widget'), 20);
  assert.throws(() => inv.allocate('gadget', 1, 'r2'), (e) => e.message === 'short 1 of gadget');
});
test('release restores lots for future FEFO draws; double release throws', () => {
  const inv = seeded();
  inv.allocate('widget', 12, 'r1');
  inv.release('r1');
  assert.equal(inv.onHand('widget'), 20);
  const plan = inv.allocate('widget', 11, 'r2');
  assert.deepEqual(plan, [{ lotId: 'C', qty: 10 }, { lotId: 'A', qty: 1 }]);
  assert.throws(() => inv.release('r1'), (e) => e.message === 'unknown ref r1');
});
test('ref reuse guarded until released', () => {
  const inv = seeded();
  inv.allocate('widget', 1, 'job');
  assert.throws(() => inv.allocate('widget', 1, 'job'), (e) => e.message === 'ref in use job');
  inv.release('job');
  inv.allocate('widget', 1, 'job');
});
test('input guards', () => {
  const inv = createInventory();
  inv.addLot('s', 'L1', 3, 5);
  assert.throws(() => inv.addLot('s', 'L1', 2, 9), (e) => e.message === 'duplicate lot L1');
  assert.throws(() => inv.addLot('s', 'L2', 0, 9), (e) => e.message === 'bad qty');
  assert.throws(() => inv.addLot('s', 'L2', 2.5, 9), (e) => e.message === 'bad qty');
});
