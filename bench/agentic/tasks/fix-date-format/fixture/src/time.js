export function timeAgo(then, now) {
  const s = Math.floor((now - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' minutes ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hours ago';
  return 'yesterday';
}
