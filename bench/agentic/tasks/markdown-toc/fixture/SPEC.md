# Markdown TOC

`toc(markdown, maxLevel)` -> array of nodes `{ text, slug, level, children }`.

Parsing:
- Only ATX headings count: 1-6 `#` at line start, then at least one space, then text.
  Trailing `#` runs (preceded by a space) are stripped: `## Hi ##` -> `Hi`.
- Lines inside fenced code blocks (``` or ~~~ fences, the closing fence must use the
  same character and be at least as long) are ignored entirely.
- Headings deeper than `maxLevel` are ignored.

Slugs (GitHub style):
- lowercase; strip every character except letters, digits, spaces and hyphens;
  spaces -> hyphens (no collapsing beyond that).
- Duplicate slugs get `-1`, `-2`, ... in document order (the first keeps the bare slug).
- Duplicate counting happens on ALL emitted headings (any level <= maxLevel).

Nesting:
- A heading nests under the nearest previous heading of a smaller level; level jumps
  (h1 then h3) still nest directly (the h3 becomes a child of the h1).
- Top-level list holds every heading with no smaller-level predecessor.
