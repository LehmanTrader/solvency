export function replay(ops) {
  const state = new Map();
  const errors = [];
  for (const o of ops) {
    if (o.op === 'set') state.set(o.key, o.value);
    else if (o.op === 'del') {
      if (!state.has(o.key)) errors.push(`del missing ${o.key}`);
      else state.delete(o.key);
    } else if (o.op === 'rename') {
      if (!state.has(o.from)) errors.push(`rename missing ${o.from}`);
      else { state.set(o.to, state.get(o.from)); state.delete(o.from); }
    }
  }
  return { state: Object.fromEntries(state), errors };
}
export function compact(ops, baseKeys) {
  // Symbolic replay: values are either {v} literals or {from: baseKey} unknowns.
  const state = new Map(baseKeys.map((k) => [k, { from: k }]));
  for (const o of ops) {
    if (o.op === 'set') state.set(o.key, { v: o.value });
    else if (o.op === 'del') state.delete(o.key);
    else if (o.op === 'rename') {
      if (state.has(o.from)) { state.set(o.to, state.get(o.from)); state.delete(o.from); }
    }
  }
  const consumed = new Set(); // base keys whose unknown value survives somewhere
  const renames = [];
  const sets = [];
  for (const [key, val] of state) {
    if ('v' in val) sets.push({ op: 'set', key, value: val.v });
    else {
      consumed.add(val.from);
      if (val.from !== key) renames.push({ op: 'rename', from: val.from, to: key });
    }
  }
  const dels = baseKeys
    .filter((k) => !consumed.has(k) && !state.has(k))
    .map((key) => ({ op: 'del', key }));
  dels.sort((a, b) => a.key < b.key ? -1 : 1);
  renames.sort((a, b) => a.to < b.to ? -1 : 1);
  sets.sort((a, b) => a.key < b.key ? -1 : 1);
  return [...dels, ...renames, ...sets];
}
