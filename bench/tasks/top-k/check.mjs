// Deterministic checker for top-k. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.topK;
if (typeof fn !== 'function') { console.error('no exported function topK'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!eq(fn(['b','a','c','b','a','b'], 2), ['b','a'])) { console.error('case 1'); process.exit(1); }
if (!eq(fn(['z','y','z','y'], 2), ['y','z'])) { console.error('tie case'); process.exit(1); }
if (!eq(fn(['q'], 0), [])) { console.error('k=0 case'); process.exit(1); }
console.log('ok');
