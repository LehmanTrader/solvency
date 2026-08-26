// Deterministic checker for parse-duration. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.parseDuration;
if (typeof fn !== 'function') { console.error('no exported function parseDuration'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [['1h30m15s', 5415], ['45m', 2700], ['90s', 90], ['2h', 7200], ['', null], ['h', null], ['30m1h', null], ['1h1h', null], ['1x', null], ['10', null]];
for (const [i, o] of cases) {
  const g = fn(i);
  if (!(g === o)) { console.error(`parseDuration(${JSON.stringify(i)}) => ${g}, wanted ${o}`); process.exit(1); }
}
console.log('ok');
