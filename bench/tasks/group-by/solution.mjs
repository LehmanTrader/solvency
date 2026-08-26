export function groupBy(items,keyFn){const o={};for(const it of items){const k=keyFn(it);(o[k]=o[k]||[]).push(it);}return o;}
