const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
const decode = (tok) => tok.replace(/~1/g, '/').replace(/~0/g, '~');
const tokens = (ptr) => ptr === '' ? [] : ptr.slice(1).split('/').map(decode);

function idx(tok, len, allowEnd) {
  if (tok === '-' && allowEnd) return len;
  if (!/^(0|[1-9][0-9]*)$/.test(tok) || Number(tok) > len - (allowEnd ? 0 : 1)) throw new Error(`bad index ${tok}`);
  return Number(tok);
}
function parentOf(root, ptr) {
  const toks = tokens(ptr);
  const last = toks.pop();
  let node = root;
  const walked = [];
  for (const t of toks) {
    walked.push(t);
    if (Array.isArray(node)) node = node[idx(t, node.length, false)];
    else if (node && typeof node === 'object' && t in node) node = node[t];
    else throw new Error(`missing parent /${walked.map((x) => x.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`);
  }
  if (node === undefined || node === null || typeof node !== 'object') throw new Error(`missing parent ${ptr.slice(0, ptr.lastIndexOf('/')) || '/' + toks.join('/')}`);
  return { node, last };
}
function getAt(root, ptr) {
  let node = root;
  for (const t of tokens(ptr)) {
    if (Array.isArray(node)) { const i = idx(t, node.length, false); node = node[i]; }
    else if (node && typeof node === 'object' && t in node) node = node[t];
    else throw new Error(`missing ${ptr}`);
  }
  return node;
}
function addAt(rootBox, ptr, value) {
  if (ptr === '') { rootBox.v = value; return; }
  const { node, last } = parentOf(rootBox.v, ptr);
  if (Array.isArray(node)) node.splice(idx(last, node.length, true), 0, value);
  else node[last] = value;
}
function removeAt(rootBox, ptr) {
  if (ptr === '') throw new Error('missing ');
  getAt(rootBox.v, ptr);
  const { node, last } = parentOf(rootBox.v, ptr);
  if (Array.isArray(node)) node.splice(idx(last, node.length, false), 1);
  else delete node[last];
}
export function apply(doc, ops) {
  const box = { v: clone(doc) };
  for (const op of ops) {
    if (op.op === 'add') addAt(box, op.path, clone(op.value));
    else if (op.op === 'remove') removeAt(box, op.path);
    else if (op.op === 'replace') { getAt(box.v, op.path); if (op.path === '') box.v = clone(op.value); else { removeAt(box, op.path); addAt(box, op.path, clone(op.value)); } }
    else if (op.op === 'move') {
      if (op.path === op.from) { getAt(box.v, op.from); continue; }
      if (op.path.startsWith(op.from + '/')) throw new Error('cannot move into self');
      const v = getAt(box.v, op.from);
      removeAt(box, op.from);
      addAt(box, op.path, v);
    }
    else if (op.op === 'copy') addAt(box, op.path, clone(getAt(box.v, op.from)));
    else if (op.op === 'test') {
      const got = getAt(box.v, op.path);
      if (JSON.stringify(got) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`);
    }
    else throw new Error(`unknown op ${op.op}`);
  }
  return box.v;
}
