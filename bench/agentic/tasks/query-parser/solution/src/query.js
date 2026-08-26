function lex(q) {
  const toks = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    let field = null;
    const fm = q.slice(i).match(/^([A-Za-z0-9_]+):/);
    let j = i;
    if (fm && (q[i + fm[0].length] === '"' || /[A-Za-z0-9_]/.test(q[i + fm[0].length] ?? ''))) { field = fm[1]; j = i + fm[0].length; }
    if (q[j] === '"') {
      const end = q.indexOf('"', j + 1);
      if (end === -1) throw new Error('unterminated phrase');
      toks.push({ t: 'term', field, text: q.slice(j + 1, end), phrase: true });
      i = end + 1; continue;
    }
    const wm = q.slice(j).match(/^[A-Za-z0-9_]+/);
    if (!wm) throw new Error('dangling operator');
    const w = wm[0];
    if (!field && (w === 'AND' || w === 'OR' || w === 'NOT')) toks.push({ t: w });
    else toks.push({ t: 'term', field, text: w, phrase: false });
    i = j + w.length;
  }
  return toks;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(tok) {
  const words = tok.text.trim().split(/\s+/).map(esc).join(' ');
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${words}(?:$|[^A-Za-z0-9_])`, 'i');
  return (doc) => {
    const fields = tok.field ? [doc[tok.field] ?? ''] : Object.values(doc);
    return fields.some((v) => re.test(` ${v} `));
  };
}
export function compile(query) {
  const toks = lex(query);
  let p = 0;
  const peek = () => toks[p];
  const parseOr = () => {
    let left = parseAnd();
    while (peek()?.t === 'OR') { p++; const r = parseAnd(); const l = left; left = (d) => l(d) || r(d); }
    return left;
  };
  const parseAnd = () => {
    let left = parseNot();
    while (peek() && (peek().t === 'AND' || peek().t === 'NOT' || peek().t === 'term' || peek().t === '(')) {
      if (peek().t === 'AND') p++;
      const r = parseNot(); const l = left; left = (d) => l(d) && r(d);
    }
    return left;
  };
  const parseNot = () => {
    if (peek()?.t === 'NOT') { p++; const inner = parseNot(); return (d) => !inner(d); }
    return parseAtom();
  };
  const parseAtom = () => {
    const tok = peek();
    if (!tok) throw new Error('dangling operator');
    if (tok.t === '(') {
      p++;
      if (peek()?.t === ')') throw new Error('empty query');
      const inner = parseOr();
      if (peek()?.t !== ')') throw new Error('unbalanced parens');
      p++;
      return inner;
    }
    if (tok.t === 'term') { p++; return matcher(tok); }
    if (tok.t === 'AND' || tok.t === 'OR') throw new Error('dangling operator');
    throw new Error('unbalanced parens');
  };
  if (!toks.length) throw new Error('empty query');
  const fn = parseOr();
  if (p !== toks.length) {
    if (toks[p].t === ')') throw new Error('unbalanced parens');
    throw new Error('dangling operator');
  }
  return fn;
}
