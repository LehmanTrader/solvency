// Deterministic checker for deep-equal. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.deepEqual;
if (typeof fn !== 'function') { console.error('no exported function deepEqual'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const T = [[1,1],[NaN,NaN],[0,-0],[{a:[1,{b:2}]},{a:[1,{b:2}]}],[{a:1,b:2},{b:2,a:1}],[[],[]]];
const F = [[1,'1'],[[1,2],[2,1]],[null,{}],[{a:{}},{a:[]}]];
for (const [a,b] of T) if (fn(a,b) !== true) { console.error('should be equal: '+JSON.stringify([a,b])); process.exit(1); }
for (const [a,b] of F) if (fn(a,b) !== false) { console.error('should differ: '+JSON.stringify([a,b])); process.exit(1); }
console.log('ok');
