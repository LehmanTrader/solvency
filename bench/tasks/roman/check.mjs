// Deterministic checker for roman. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.romanToInt;
if (typeof fn !== 'function') { console.error('no exported function romanToInt'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [['MCMXCIV', 1994], ['III', 3], ['LVIII', 58], ['IX', 9], ['', null], ['IIA', null]];
for (const [i, o] of cases) {
  const g = fn(i);
  if (g !== o) { console.error(`romanToInt(${JSON.stringify(i)}) => ${g}, wanted ${o}`); process.exit(1); }
}
console.log('ok');
