function halfEven(num, den) {
  // round(num/den) half-to-even for integer num >= 0 or < 0, den > 0
  const neg = num < 0;
  const n = neg ? -num : num;
  const q = Math.floor(n / den);
  const rem2 = (n % den) * 2;
  let r = q;
  if (rem2 > den) r = q + 1;
  else if (rem2 === den) r = q % 2 === 0 ? q : q + 1;
  return neg ? -r : r;
}
export function createLedger(rates) {
  const entries = new Set();
  const balances = new Map(); // account -> Map(currency -> minor)
  const need = (c) => { if (!(c in rates)) throw new Error(`unknown currency ${c}`); };
  const convert = (amount, currency) => { need(currency); return halfEven(amount * rates[currency], 1_000_000); };
  return {
    convert,
    post(entryId, legs) {
      if (entries.has(entryId)) throw new Error(`duplicate entry ${entryId}`);
      let sum = 0;
      for (const leg of legs) {
        if (!Number.isInteger(leg.amountMinor) || leg.amountMinor === 0) throw new Error('zero leg');
        sum += convert(leg.amountMinor, leg.currency);
      }
      if (sum !== 0) throw new Error(`unbalanced entry ${entryId} by ${sum}`);
      entries.add(entryId);
      for (const leg of legs) {
        const acc = balances.get(leg.account) ?? new Map();
        acc.set(leg.currency, (acc.get(leg.currency) ?? 0) + leg.amountMinor);
        balances.set(leg.account, acc);
      }
    },
    balance(account) {
      const out = {};
      for (const [c, v] of balances.get(account) ?? []) if (v !== 0) out[c] = v;
      return out;
    },
    trialBalance() {
      const out = {};
      for (const account of [...balances.keys()].sort()) {
        let base = 0;
        for (const [c, v] of balances.get(account)) base += convert(v, c);
        if (base !== 0) out[account] = base;
      }
      return out;
    },
  };
}
