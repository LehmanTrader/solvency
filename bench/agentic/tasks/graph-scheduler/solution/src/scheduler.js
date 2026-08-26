export function plan(tasks, limit) {
  const ids = Object.keys(tasks).sort();
  for (const id of ids) for (const dep of tasks[id])
    if (!(dep in tasks)) throw new Error(`unknown dependency ${dep} of ${id}`);
  // cycle detection: DFS following dependency edges (task -> its dep)
  const state = new Map();
  const findCycle = (id, path) => {
    state.set(id, 'gray'); path.push(id);
    for (const dep of tasks[id]) {
      if (state.get(dep) === 'gray') return path.slice(path.indexOf(dep));
      if (!state.has(dep)) { const c = findCycle(dep, path); if (c) return c; }
    }
    path.pop(); state.set(id, 'black');
    return null;
  };
  let cycle = null;
  for (const id of ids) if (!state.has(id)) { const c = findCycle(id, []); if (c) { cycle = c; break; } }
  if (cycle) {
    let k = 0;
    for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[k]) k = i;
    const rot = [...cycle.slice(k), ...cycle.slice(0, k)];
    throw new Error(`cycle: ${[...rot, rot[0]].join(' -> ')}`);
  }
  const done = new Set(); const out = [];
  let remaining = ids.filter(() => true);
  while (remaining.length) {
    const ready = remaining.filter((id) => tasks[id].every((d) => done.has(d))).sort();
    for (let i = 0; i < ready.length; i += limit) out.push(ready.slice(i, i + limit));
    for (const id of ready) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return out;
}
