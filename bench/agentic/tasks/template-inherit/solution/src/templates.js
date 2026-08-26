const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function lookup(vars, path) {
  let v = vars;
  for (const seg of path.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object' || !(seg in v)) return '';
    v = v[seg];
  }
  return v ?? '';
}
function parseBlocks(src) {
  // returns { extends: name|null, blocks: Map(name -> body), body: src-with-blocks }
  const em = src.match(/^\s*\{%\s*extends\s+"([^"]+)"\s*%\}/);
  const parent = em ? em[1] : null;
  const rest = em ? src.slice(em.index + em[0].length) : src;
  const blocks = new Map();
  const re = /\{%\s*block\s+([A-Za-z0-9_]+)\s*%\}/g;
  let m;
  while ((m = re.exec(rest))) {
    const name = m[1];
    const end = rest.indexOf('{% endblock %}', re.lastIndex);
    const endLoose = end === -1 ? rest.search(/\{%\s*endblock\s*%\}/) : end;
    let close = -1, closeLen = 0;
    const cm = rest.slice(re.lastIndex).match(/\{%\s*endblock\s*%\}/);
    if (cm) { close = re.lastIndex + cm.index; closeLen = cm[0].length; }
    if (close === -1) throw new Error(`unclosed block ${name}`);
    blocks.set(name, rest.slice(re.lastIndex, close));
    re.lastIndex = close + closeLen;
  }
  return { parent, blocks, body: rest };
}
function interpolate(text, vars) {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*(\|\s*raw\s*)?\}\}/g, (_, path, raw) => {
    const v = lookup(vars, path);
    return raw ? String(v) : escapeHtml(v);
  });
}
export function render(name, templates, vars) {
  if (!(name in templates)) throw new Error(`unknown template ${name}`);
  // walk the extends chain root-ward
  const chain = [];
  let cur = name;
  while (cur !== null) {
    if (!(cur in templates)) throw new Error(`unknown template ${cur}`);
    const parsed = parseBlocks(templates[cur]);
    chain.push(parsed);
    cur = parsed.parent;
  }
  const root = chain[chain.length - 1];
  // effective block content: walk from root to leaf, letting children override,
  // resolving {{ super() }} against the previous effective content.
  const renderBlockText = (text, effective) =>
    interpolate(text.replace(/\{\{\s*super\(\)\s*\}\}/g, () => effective ?? ''), vars);
  const blockNames = new Set();
  for (const level of chain) for (const b of level.blocks.keys()) blockNames.add(b);
  const finalBlocks = new Map();
  for (const bn of blockNames) {
    let eff = '';
    for (let i = chain.length - 1; i >= 0; i--) {
      const lvl = chain[i];
      if (lvl.blocks.has(bn)) eff = renderBlockText(lvl.blocks.get(bn), eff);
    }
    finalBlocks.set(bn, eff);
  }
  // render the ROOT body, substituting block regions with final content
  let out = '';
  const src = root.body;
  const re = /\{%\s*block\s+([A-Za-z0-9_]+)\s*%\}/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    out += interpolate(src.slice(last, m.index), vars);
    const cm = src.slice(re.lastIndex).match(/\{%\s*endblock\s*%\}/);
    const close = re.lastIndex + cm.index;
    out += finalBlocks.get(m[1]) ?? '';
    last = close + cm[0].length;
    re.lastIndex = last;
  }
  out += interpolate(src.slice(last), vars);
  return out;
}
