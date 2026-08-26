export function invoice(plan, usage) {
  const { tiers } = plan;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.upTo === null) { if (i !== tiers.length - 1) throw new Error('bad tiers'); }
    else if (i > 0 && tiers[i - 1].upTo !== null && t.upTo <= tiers[i - 1].upTo) throw new Error('bad tiers');
  }
  if (tiers[tiers.length - 1].upTo !== null) throw new Error('bad tiers');
  const lines = [];
  let remaining = usage.units;
  let prevCap = 0;
  let subtotal = 0;
  for (const t of tiers) {
    const cap = t.upTo === null ? Infinity : t.upTo;
    const units = Math.max(0, Math.min(remaining, cap - prevCap));
    if (units > 0) {
      const cents = Math.round(units * t.centsPerUnit);
      lines.push({ kind: 'tier', upTo: t.upTo, units, cents });
      subtotal += cents;
      remaining -= units;
    }
    prevCap = cap;
  }
  const fee = Math.round(plan.platformFeeCents * usage.daysActive / usage.daysInMonth);
  if (fee !== 0) { lines.push({ kind: 'platform-fee', cents: fee }); subtotal += fee; }
  if (subtotal < plan.minimumCents) {
    const gap = plan.minimumCents - subtotal;
    lines.push({ kind: 'minimum-trueup', cents: gap });
    subtotal = plan.minimumCents;
  }
  let total = subtotal;
  let applied = 0;
  for (const c of plan.credits ?? []) {
    if (total === 0) break;
    const use = Math.min(c.cents, total);
    applied += use; total -= use;
  }
  return { lines, subtotalCents: subtotal, creditsAppliedCents: applied, totalCents: total };
}
