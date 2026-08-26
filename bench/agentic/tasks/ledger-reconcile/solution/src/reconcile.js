import { readFileSync } from 'node:fs';
function load(path) {
  const [, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const m = new Map();
  for (const r of rows) {
    const [ref, amount] = r.split(',');
    m.set(ref, (m.get(ref) ?? 0) + Number(amount));
  }
  return m;
}
export function reconcile() {
  const bank = load('data/bank.csv'), ledger = load('data/ledger.csv');
  const out = { matched: 0, mismatched: [], missingInLedger: [], missingInBank: [] };
  for (const [ref, b] of [...bank].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (!ledger.has(ref)) { out.missingInLedger.push(ref); continue; }
    const l = ledger.get(ref);
    if (Math.abs(b - l) <= 0.01) out.matched++;
    else out.mismatched.push({ ref, bank: b, ledger: l });
  }
  out.missingInBank = [...ledger.keys()].filter((r) => !bank.has(r)).sort();
  return out;
}
