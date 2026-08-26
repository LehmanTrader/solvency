export function applyPatch(source, patch) {
  const hadNl = source.endsWith('\n');
  const lines = hadNl ? source.slice(0, -1).split('\n') : source.split('\n');
  const pl = patch.split('\n');
  let i = 0;
  while (i < pl.length && !pl[i].startsWith('@@')) i++;
  let out = lines.slice();
  let offset = 0;
  let k = 0;
  while (i < pl.length) {
    if (pl[i].trim() === '') { i++; continue; }
    k++;
    const m = pl[i].match(/^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/);
    if (!m) throw new Error(`bad hunk header ${k}`);
    const oldStart = Number(m[1]);
    i++;
    let pos = oldStart - 1 + offset; // index into `out`
    let orig = oldStart;             // 1-based original line for messages
    while (i < pl.length && !pl[i].startsWith('@@')) {
      const line = pl[i];
      if (line === '') { i++; continue; }
      const tag = line[0], body = line.slice(1);
      if (tag === ' ') {
        if (out[pos] !== body) throw new Error(`hunk ${k} mismatch at line ${orig}`);
        pos++; orig++;
      } else if (tag === '-') {
        if (out[pos] !== body) throw new Error(`hunk ${k} mismatch at line ${orig}`);
        out.splice(pos, 1); offset--; orig++;
      } else if (tag === '+') {
        out.splice(pos, 0, body); pos++; offset++;
      } else throw new Error(`bad line in hunk ${k}`);
      i++;
    }
  }
  return out.join('\n') + (hadNl ? '\n' : '');
}
