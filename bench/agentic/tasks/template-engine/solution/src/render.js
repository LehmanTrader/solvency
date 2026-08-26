const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function render(template, data, outer = null) {
  let out = '';
  let i = 0;
  const lookup = (name) => {
    if (data != null && Object.prototype.hasOwnProperty.call(data, name)) return data[name];
    if (outer != null && Object.prototype.hasOwnProperty.call(outer, name)) return outer[name];
    return undefined;
  };
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open === -1) { out += template.slice(i); break; }
    out += template.slice(i, open);
    if (template[open + 2] === '#') {
      const close = template.indexOf('}}', open);
      const name = template.slice(open + 3, close);
      const endTag = '{{/' + name + '}}';
      let depth = 1, scan = close + 2;
      const startTag = '{{#' + name + '}}';
      let endIdx = -1;
      while (scan < template.length) {
        const nextStart = template.indexOf(startTag, scan);
        const nextEnd = template.indexOf(endTag, scan);
        if (nextEnd === -1) break;
        if (nextStart !== -1 && nextStart < nextEnd) { depth++; scan = nextStart + startTag.length; continue; }
        depth--;
        if (depth === 0) { endIdx = nextEnd; break; }
        scan = nextEnd + endTag.length;
      }
      const inner = template.slice(close + 2, endIdx);
      const arr = lookup(name);
      if (Array.isArray(arr)) for (const el of arr) out += render(inner, el, data);
      i = endIdx + endTag.length;
    } else if (template[open + 2] === '{') {
      const close = template.indexOf('}}}', open);
      const v = lookup(template.slice(open + 3, close));
      out += v == null ? '' : String(v);
      i = close + 3;
    } else {
      const close = template.indexOf('}}', open);
      const v = lookup(template.slice(open + 2, close));
      out += v == null ? '' : esc(v);
      i = close + 2;
    }
  }
  return out;
}
