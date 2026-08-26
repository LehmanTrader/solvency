# paginate

`paginate(items, page, perPage)` -> `{ page, totalPages, items }`.
- 1-based pages; `page` is clamped into `[1, totalPages]` (empty list has totalPages 1).
- `items` is the slice for the clamped page.
