// Deterministic checker for lru. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.createLru;
if (typeof fn !== 'function') { console.error('no exported function createLru'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const c = fn(2);
c.put(1, 1); c.put(2, 2);
if (c.get(1) !== 1) { console.error('get 1'); process.exit(1); }
c.put(3, 3);
if (c.get(2) !== -1) { console.error('2 should be evicted'); process.exit(1); }
c.put(4, 4);
if (c.get(1) !== -1 || c.get(3) !== 3 || c.get(4) !== 4) { console.error('final state'); process.exit(1); }
console.log('ok');
