export function topK(words,k){const c={};for(const w of words)c[w]=(c[w]||0)+1;return Object.keys(c).sort((a,b)=>c[b]-c[a]||a.localeCompare(b)).slice(0,k);}
