export function createWindows(sizeMs, latenessMs, onFinal) {
  const open = new Map(); // start -> {count,sum,min,max}
  const finalized = new Set();
  let mark = -Infinity;
  return {
    add(ts, value) {
      const start = Math.floor(ts / sizeMs) * sizeMs;
      if (finalized.has(start)) return 'late';
      const w = open.get(start) ?? { count: 0, sum: 0, min: Infinity, max: -Infinity };
      w.count++; w.sum += value;
      w.min = Math.min(w.min, value); w.max = Math.max(w.max, value);
      open.set(start, w);
      return 'ok';
    },
    watermark(ts) {
      if (ts <= mark) return;
      mark = ts;
      const due = [...open.keys()].filter((s) => s + sizeMs + latenessMs <= mark).sort((a, b) => a - b);
      for (const s of due) {
        const w = open.get(s);
        open.delete(s);
        finalized.add(s);
        onFinal({ start: s, end: s + sizeMs, count: w.count, sum: w.sum, min: w.min, max: w.max });
      }
    },
    pending: () => [...open.keys()].sort((a, b) => a - b),
  };
}
