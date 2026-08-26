export function createInventory() {
  const lots = new Map(); // sku -> [{lotId, qty, expiresDay}]
  const refs = new Map(); // ref -> {sku, draws:[{lot, qty}]}
  const skuLots = (sku) => lots.get(sku) ?? [];
  return {
    addLot(sku, lotId, qty, expiresDay) {
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('bad qty');
      if (!lots.has(sku)) lots.set(sku, []);
      if (lots.get(sku).some((l) => l.lotId === lotId)) throw new Error(`duplicate lot ${lotId}`);
      lots.get(sku).push({ lotId, qty, expiresDay });
    },
    allocate(sku, qty, ref) {
      if (refs.has(ref)) throw new Error(`ref in use ${ref}`);
      const ordered = [...skuLots(sku)].sort((a, b) => a.expiresDay - b.expiresDay || (a.lotId < b.lotId ? -1 : 1));
      const available = ordered.reduce((s, l) => s + l.qty, 0);
      if (available < qty) throw new Error(`short ${qty - available} of ${sku}`);
      let need = qty;
      const draws = [];
      for (const lot of ordered) {
        if (!need) break;
        if (!lot.qty) continue;
        const take = Math.min(lot.qty, need);
        lot.qty -= take; need -= take;
        draws.push({ lot, qty: take });
      }
      refs.set(ref, { sku, draws });
      return draws.map((d) => ({ lotId: d.lot.lotId, qty: d.qty }));
    },
    release(ref) {
      const r = refs.get(ref);
      if (!r) throw new Error(`unknown ref ${ref}`);
      for (const d of r.draws) d.lot.qty += d.qty;
      refs.delete(ref);
    },
    onHand: (sku) => skuLots(sku).reduce((s, l) => s + l.qty, 0),
    reserved(sku) {
      let t = 0;
      for (const r of refs.values()) if (r.sku === sku) t += r.draws.reduce((s, d) => s + d.qty, 0);
      return t;
    },
  };
}
