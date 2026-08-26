import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcl } from '../src/acl.js';

const roles = { admin: ['writer'], writer: ['reader'], reader: [], auditor: ['reader'] };
const rules = [
  { id: 'r1', role: 'reader', effect: 'allow', action: 'read', resource: 'repo/**' },
  { id: 'r2', role: 'writer', effect: 'allow', action: 'write', resource: 'repo/*/docs/**' },
  { id: 'r3', role: 'writer', effect: 'deny', action: 'write', resource: 'repo/prod/**' },
  { id: 'r4', role: 'admin', effect: 'allow', action: '*', resource: '**' },
  { id: 'r5', role: 'reader', effect: 'deny', action: 'read', resource: 'repo/secrets/**' },
];

test('inheritance chain allows and deny-overrides beats admin wildcard', () => {
  const acl = createAcl(roles, rules);
  assert.deepEqual(acl.check('writer', 'read', 'repo/x/file'), { allowed: true, rule: 'r1' });
  assert.deepEqual(acl.check('admin', 'write', 'repo/prod/docs/a'), { allowed: false, rule: 'r3' });
  assert.deepEqual(acl.check('admin', 'delete', 'anything/here'), { allowed: true, rule: 'r4' });
});
test('most specific allow wins the trace', () => {
  const acl = createAcl(roles, rules);
  assert.deepEqual(acl.check('writer', 'write', 'repo/x/docs/plan'), { allowed: true, rule: 'r2' });
});
test('deny specificity and default deny', () => {
  const acl = createAcl(roles, rules);
  assert.deepEqual(acl.check('reader', 'read', 'repo/secrets/key'), { allowed: false, rule: 'r5' });
  assert.deepEqual(acl.check('reader', 'write', 'repo/x'), { allowed: false, rule: null });
  assert.deepEqual(acl.check('auditor', 'read', 'elsewhere'), { allowed: false, rule: null });
});
test('tie on literals: longer pattern, then rule order', () => {
  const acl = createAcl({ r: [] }, [
    { id: 'short', role: 'r', effect: 'allow', action: 'a', resource: 'x/**' },
    { id: 'long', role: 'r', effect: 'allow', action: 'a', resource: 'x/*/**' },
  ]);
  assert.deepEqual(acl.check('r', 'a', 'x/y/z'), { allowed: true, rule: 'long' });
  const acl2 = createAcl({ r: [] }, [
    { id: 'first', role: 'r', effect: 'allow', action: 'a', resource: 'x/*' },
    { id: 'second', role: 'r', effect: 'allow', action: 'a', resource: '*/y' },
  ]);
  assert.deepEqual(acl2.check('r', 'a', 'x/y'), { allowed: true, rule: 'first' });
});
test('unknown roles throw exactly', () => {
  assert.throws(() => createAcl({ b: ['ghost'], a: ['b'] }, []), (e) => e.message === 'unknown role ghost');
  const acl = createAcl(roles, rules);
  assert.throws(() => acl.check('nobody', 'read', 'x'), (e) => e.message === 'unknown role nobody');
});
