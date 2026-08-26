const NAMES = {
  4: { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 },
  3: { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 },
};
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(raw, fi) {
  const [lo, hi] = RANGES[fi];
  const bad = () => { throw new Error(`bad field ${fi + 1}: ${raw}`); };
  const names = NAMES[fi] ?? {};
  const val = (s) => {
    const up = s.toUpperCase();
    if (up in names) return names[up];
    if (!/^[0-9]+$/.test(s)) bad();
    const n = Number(s);
    if (n < lo || n > hi) { throw new Error(`bad field ${fi + 1}: ${s}`); }
    return n;
  };
  const out = new Set();
  const restricted = raw !== '*';
  for (const part of raw.split(',')) {
    const m = part.match(/^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/([0-9]+))?$/);
    if (!m) { throw new Error(`bad field ${fi + 1}: ${part}`); }
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) { throw new Error(`bad field ${fi + 1}: ${part}`); }
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) {
      const [x, y] = m[1].split('-');
      a = val(x); b = val(y);
      if (a > b) { throw new Error(`bad field ${fi + 1}: ${part}`); }
    } else { a = val(m[1]); b = a; }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return { set: out, restricted };
}

export function nextFire(expr, fromMs) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected 5 fields, got ${fields.length}`);
  const [min, hour, dom, mon, dow] = fields.map((f, i) => parseField(f, i));
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = fromMs + 5 * 366 * 86400000;
  while (t <= limit) {
    const d = new Date(t);
    const okMin = min.set.has(d.getUTCMinutes());
    const okHour = hour.set.has(d.getUTCHours());
    const okMon = mon.set.has(d.getUTCMonth() + 1);
    const okDom = dom.set.has(d.getUTCDate());
    const okDow = dow.set.has(d.getUTCDay());
    const okDay = dom.restricted && dow.restricted ? (okDom || okDow)
      : dom.restricted ? okDom : dow.restricted ? okDow : true;
    if (okMin && okHour && okMon && okDay) return t;
    t += 60000;
  }
  throw new Error('no fire within 5 years');
}
