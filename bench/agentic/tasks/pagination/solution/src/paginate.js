export function paginate(items, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * perPage;
  return { page: p, totalPages, items: items.slice(start, start + perPage) };
}
