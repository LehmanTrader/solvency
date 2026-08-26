// Deterministic checker for word-wrap. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.wrapText;
if (typeof fn !== 'function') { console.error('no exported function wrapText'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  ['the quick brown fox', 10, ['the quick','brown fox']],
  ['a bb ccc', 3, ['a','bb','ccc']],
  ['supercalifragilistic yes', 5, ['supercalifragilistic','yes']],
  ['', 5, []],
];
for (const [t,w,o] of cases) {
  if (!eq(fn(t,w), o)) { console.error(JSON.stringify([t,w])+' => '+JSON.stringify(fn(t,w))); process.exit(1); }
}
console.log('ok');
