# validate

`validateConfig(cfg)`:
- `cfg.port`: integer 1..65535 (required)
- `cfg.host`: non-empty string, default 'localhost'
- `cfg.retries`: integer >= 0, default 3
Return `{ port, host, retries }` (only these keys).
On any invalid field, throw `new Error('invalid config: ' + problems.join('; '))` where each problem is `<field> <reason>` with reasons exactly: `missing`, `not an integer`, `out of range`, `empty`. Collect ALL problems, sorted by field name.
