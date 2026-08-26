export function paginate(items, page, perPage) {
  const totalPages = Math.floor(items.length / perPage) + 1;
  const p = Math.min(page, totalPages);
  const start = (p - 1) * perPage;
  return { page: p, totalPages, items: items.slice(start, start + perPage + 1) };
}
