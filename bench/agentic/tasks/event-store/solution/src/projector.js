export function project(events) {
  const m = new Map();
  for (const e of events) {
    const cur = m.get(e.account) ?? 0;
    if (e.type === 'deposit') m.set(e.account, cur + e.amount);
    else if (e.type === 'withdraw' && e.amount <= cur) m.set(e.account, cur - e.amount);
    else if (!m.has(e.account)) m.set(e.account, cur);
  }
  return m;
}
