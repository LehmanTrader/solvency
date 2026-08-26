# Unified diff applier

`applyPatch(source, patch)` -> patched string.

`source` is text (lines separated by `\n`). `patch` is a unified diff containing one or
more hunks; ignore any lines before the first `@@` (e.g. `---`/`+++` headers).

Hunk header: `@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@` (counts may be
omitted with their comma when 1: `@@ -3 +3 @@`). Body lines start with ` ` (context),
`-` (remove) or `+` (add).

Rules:
- oldStart is 1-based into the CURRENT source. Hunks apply in order; later hunks'
  oldStart still refers to ORIGINAL line numbers (standard unified diff), so track the
  running offset from earlier hunks.
- Context (` `) and removal (`-`) lines must equal the source line they address; on the
  first mismatch throw Error `hunk <k> mismatch at line <n>` where k is the 1-based
  hunk index and n the 1-based ORIGINAL source line number being compared.
- A malformed hunk header: throw Error `bad hunk header <k>`; a body line with an
  unknown prefix: throw Error `bad line in hunk <k>`.
- Preserve a trailing newline in the source if present; do not invent one.
