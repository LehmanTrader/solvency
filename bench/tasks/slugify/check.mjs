// Deterministic checker for slugify. Exit 0 = pass.
const mod = await import(process.argv[2]);
const fn = mod.slugify;
if (typeof fn !== 'function') { console.error('no exported function slugify'); process.exit(1); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const [i, o] of [['Hello, World!', 'hello-world'], ['  --A  B--  ', 'a-b'], ['abc', 'abc'], ['', ''], ['___', '']]) {
  if (fn(i) !== o) { console.error(`slugify(${JSON.stringify(i)}) => ${JSON.stringify(fn(i))}, wanted ${JSON.stringify(o)}`); process.exit(1); }
}
console.log('ok');
