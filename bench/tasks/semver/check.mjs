// Deterministic checker for semver. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.semverCompare;
if (typeof fn !== 'function') { console.error('no exported function semverCompare'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [['1.2.10','1.3',-1], ['1.3','1.2.10',1], ['1.0.0','1',0], ['2','10',-1], ['0.0.1','0.0.1',0]];
for (const [a,b,o] of cases) {
  if (fn(a,b) !== o) { console.error(`semverCompare(${a},${b}) => ${fn(a,b)}, wanted ${o}`); process.exit(1); }
}
console.log('ok');
