// Deterministic checker for group-by. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.groupBy;
if (typeof fn !== 'function') { console.error('no exported function groupBy'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r = fn([6,7,8,9], (n) => n % 2 === 0 ? 'even' : 'odd');
if (!eq(r, { even: [6,8], odd: [7,9] })) { console.error('numbers case failed'); process.exit(1); }
if (!eq(fn([], () => 'x'), {})) { console.error('empty case failed'); process.exit(1); }
const r3 = fn(['a','bb','cc','d'], (s) => String(s.length));
if (!eq(r3, { '1': ['a','d'], '2': ['bb','cc'] })) { console.error('length case failed'); process.exit(1); }
console.log('ok');
