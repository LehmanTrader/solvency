export function timeAgo(then, now) {
  const s = Math.floor((now - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  const p = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (m < 60) return p(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return p(h, 'hour');
  if (h < 48) return 'yesterday';
  return p(Math.floor(h / 24), 'day');
}
