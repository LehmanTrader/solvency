// Deterministic checker for csv-line. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.parseCsvLine;
if (typeof fn !== 'function') { console.error('no exported function parseCsvLine'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  ['a,b,c', ['a','b','c']],
  ['\u0022a,b\u0022,c', ['a,b','c']],
  ['\u0022say \u0022\u0022hi\u0022\u0022\u0022,x', ['say \u0022hi\u0022','x']],
  ['', ['']],
  ['a,,c', ['a','','c']],
];
for (const [i, o] of cases) {
  if (!eq(fn(i), o)) { console.error(`parseCsvLine(${JSON.stringify(i)}) => ${JSON.stringify(fn(i))}`); process.exit(1); }
}
console.log('ok');
