export function parse(text) {
  const records = [];
  let field = '', record = [], i = 0, rec = 1;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { records.push(record); record = []; rec++; };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' && field === '') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= text.length) throw new Error(`unterminated quote in record ${rec}`);
        if (text[j] === '"') {
          if (text[j + 1] === '"') { out += '"'; j += 2; }
          else { j++; break; }
        } else { out += text[j]; j++; }
      }
      field = out;
      i = j;
      // next char must be , or newline or EOF
      if (text[i] === ',') { pushField(); i++; }
      else if (text[i] === '\r' && text[i + 1] === '\n') { pushField(); pushRecord(); i += 2; }
      else if (text[i] === '\n') { pushField(); pushRecord(); i++; }
      else if (i >= text.length) { pushField(); pushRecord(); }
      else { field += text[i]; i++; } // tolerate trailing junk conservatively
      continue;
    }
    if (c === ',') { pushField(); i++; }
    else if (c === '\r' && text[i + 1] === '\n') { pushField(); pushRecord(); i += 2; }
    else if (c === '\n') { pushField(); pushRecord(); i++; }
    else { field += c; i++; }
  }
  if (field !== '' || record.length) { pushField(); pushRecord(); }
  if (!records.length) return [];
  const header = records[0];
  return records.slice(1).map((r, k) => {
    if (r.length !== header.length) throw new Error(`record ${k + 2} has ${r.length} fields, expected ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, r[j]]));
  });
}
const ser = (v) => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
export function leftJoin(leftText, rightText, on, agg) {
  const left = parse(leftText);
  const right = parse(rightText);
  const lHead = parse(leftText.split(/\r?\n/)[0] + '\nx'.repeat(0)) // header via parse of full text instead:
  ;
  const leftHeader = Object.keys(left[0] ?? {});
  const rightHeader = Object.keys(right[0] ?? {});
  const lFirst = leftText.split(/\r?\n/)[0];
  if (!leftHeader.length) throw new Error(`missing key ${on}`);
  if (!leftHeader.includes(on) || !rightHeader.includes(on)) throw new Error(`missing key ${on}`);
  const byKey = new Map();
  for (const r of right) {
    if (!byKey.has(r[on])) byKey.set(r[on], []);
    byKey.get(r[on]).push(r);
  }
  const aggCols = Object.keys(agg);
  const header = [...leftHeader, ...aggCols];
  const rows = left.map((l) => {
    const matches = byKey.get(l[on]) ?? [];
    const vals = aggCols.map((col) => {
      const kind = agg[col];
      if (kind === 'count') return String(matches.length);
      if (kind === 'sum') return String(matches.reduce((s, m) => s + Number(m[col]), 0));
      if (kind === 'max') return matches.length ? String(Math.max(...matches.map((m) => Number(m[col])))) : '';
      return '';
    });
    return [...leftHeader.map((h) => l[h]), ...vals];
  });
  return [header, ...rows].map((r) => r.map(ser).join(',')).join('\n');
}
