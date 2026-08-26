# Template inheritance

`render(name, templates, vars)` -> string. `templates` maps name -> source.

## Interpolation
- `{{ expr }}` where expr is a dotted path into `vars` (`user.name`); a missing path
  segment renders the empty string.
- Values are HTML-escaped (`&` `<` `>` `"` -> `&amp;` `&lt;` `&gt;` `&quot;`) unless
  written `{{ expr | raw }}`.

## Inheritance
- A child may begin with `{% extends "layout-name" %}` (must be the very first thing,
  ignoring leading whitespace; unknown template name anywhere: throw Error
  `unknown template <name>`).
- `{% block title %}...{% endblock %}` defines a block. In a child, a block REPLACES
  the parent's block of the same name. `{{ super() }}` inside a child block splices in
  the parent's content for that block (already-rendered).
- Extends chains may nest (grandchild -> child -> layout). Content outside blocks in
  an extending template is discarded. Blocks the child never overrides render the
  parent's content.
- A `{% block %}` without `{% endblock %}`: throw Error `unclosed block <name>`.
- `{{ super() }}` outside any block or in a template with no parent block: render
  the empty string.
