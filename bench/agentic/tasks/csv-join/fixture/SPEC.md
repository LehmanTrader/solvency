# CSV join

`parse(text)` -> array of row objects using the first record as the header.
`leftJoin(leftText, rightText, on, agg)` -> CSV string.

## parse (RFC-4180)
- Fields separated by `,`; records by `\n` or `\r\n` (either accepted; a final
  trailing newline does not create an empty record).
- A field starting with `"` is quoted: it ends at the next lone `"`; `""` inside is a
  literal quote; commas and newlines inside quotes are literal.
- A malformed quoted field (EOF before the closing quote): throw Error
  `unterminated quote in record <n>` (1-based record number).
- A record with a different field count than the header: throw Error
  `record <n> has <k> fields, expected <h>`.

## leftJoin
- `on` is a column name present in both CSVs (else throw Error `missing key <on>`).
- Every LEFT row appears exactly once, in original order. Right rows matching its key
  are aggregated: `agg` is `{ column: 'sum'|'count'|'max' }` over MATCHING right rows;
  sum/max coerce with Number(); max of no rows is empty string, sum of none is 0,
  count of none is 0.
- Output columns: the left header (original order), then the agg columns in
  Object.keys order. Serialize minimally: quote a field only when it contains
  `,`, `"`, `\n` or `\r` (doubling internal quotes); join records with `\n`, no
  trailing newline.
