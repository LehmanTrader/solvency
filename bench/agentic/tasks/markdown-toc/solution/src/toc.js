export function toc(markdown, maxLevel) {
  const lines = markdown.split('\n');
  let fence = null;
  const heads = [];
  for (const line of lines) {
    const f = line.match(/^(`{3,}|~{3,})/);
    if (f) {
      const ch = f[1][0], len = f[1].length;
      if (!fence) fence = { ch, len };
      else if (fence.ch === ch && len >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^(#{1,6}) (.*)$/);
    if (!m) continue;
    const level = m[1].length;
    if (level > maxLevel) continue;
    let text = m[2].replace(/ #+\s*$/, '').trim();
    heads.push({ text, level });
  }
  const counts = new Map();
  for (const h of heads) {
    let slug = h.text.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
    const n = counts.get(slug) ?? 0;
    counts.set(slug, n + 1);
    h.slug = n === 0 ? slug : `${slug}-${n}`;
  }
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const h of heads) {
    const node = { text: h.text, slug: h.slug, level: h.level, children: [] };
    while (stack[stack.length - 1].level >= h.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}
