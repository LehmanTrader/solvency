export function createAcl(roles, rules) {
  for (const child of Object.keys(roles).sort())
    for (const p of roles[child]) if (!(p in roles)) throw new Error(`unknown role ${p}`);
  const ancestors = (role) => {
    const seen = new Set([role]);
    const stack = [role];
    while (stack.length) for (const p of roles[stack.pop()]) if (!seen.has(p)) { seen.add(p); stack.push(p); }
    return seen;
  };
  const matchesResource = (pattern, resource) => {
    const ps = pattern.split('/');
    const rs = resource.split('/');
    const deep = ps[ps.length - 1] === '**';
    const fixed = deep ? ps.slice(0, -1) : ps;
    if (deep ? rs.length < fixed.length : rs.length !== fixed.length) return false;
    return fixed.every((seg, i) => seg === '*' || seg === rs[i]);
  };
  const literals = (pattern) => pattern.split('/').filter((s) => s !== '*' && s !== '**').length;
  const segs = (pattern) => pattern.split('/').length;
  return {
    check(role, action, resource) {
      if (!(role in roles)) throw new Error(`unknown role ${role}`);
      const anc = ancestors(role);
      const applicable = rules
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => anc.has(r.role) && (r.action === '*' || r.action === action) && matchesResource(r.resource, resource));
      const best = (list) => list.sort((a, b) =>
        literals(b.r.resource) - literals(a.r.resource) || segs(b.r.resource) - segs(a.r.resource) || a.i - b.i)[0];
      const denies = applicable.filter(({ r }) => r.effect === 'deny');
      if (denies.length) return { allowed: false, rule: best(denies).r.id };
      const allows = applicable.filter(({ r }) => r.effect === 'allow');
      if (allows.length) return { allowed: true, rule: best(allows).r.id };
      return { allowed: false, rule: null };
    },
  };
}
