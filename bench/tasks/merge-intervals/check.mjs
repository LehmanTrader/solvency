// Deterministic checker for merge-intervals. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.mergeIntervals;
if (typeof fn !== 'function') { console.error('no exported function mergeIntervals'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inp = [[8,10],[1,3],[2,6],[15,18],[10,11]];
if (!eq(fn(inp), [[1,6],[8,11],[15,18]])) { console.error('merge case: '+JSON.stringify(fn(inp))); process.exit(1); }
if (!eq(inp[0], [8,10])) { console.error('input was mutated'); process.exit(1); }
if (!eq(fn([]), [])) { console.error('empty case'); process.exit(1); }
console.log('ok');
