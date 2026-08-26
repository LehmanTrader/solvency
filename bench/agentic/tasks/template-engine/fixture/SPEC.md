# template mini-language

`render(template, data)` -> string.
- `{{name}}`: insert `data.name` (missing/null -> empty string), HTML-escaped:
  & -> &amp;, < -> &lt;, > -> &gt;, " -> &quot;.
- `{{{name}}}`: same lookup, NO escaping.
- `{{#items}}...{{/items}}`: repeat the inner block once per element of the
  array `data.items`; inside the block, lookups resolve against the element
  FIRST, then the outer data (one level of fallback is enough for nesting
  used here). Non-array or missing -> render nothing.
- Sections may nest. Dotted paths are not required.
