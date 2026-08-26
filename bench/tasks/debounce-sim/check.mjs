// Deterministic checker for debounce-sim. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.debounceFires;
if (typeof fn !== 'function') { console.error('no exported function debounceFires'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  [[[0,'a'],[5,'b'],[20,'c']], 10, ['b','c']],
  [[[0,'a']], 5, ['a']],
  [[], 5, []],
  [[[0,'a'],[10,'b']], 10, ['a','b']],
];
for (const [ev, w, o] of cases) {
  if (!eq(fn(ev, w), o)) { console.error(JSON.stringify([ev,w])+' => '+JSON.stringify(fn(ev,w))); process.exit(1); }
}
console.log('ok');
