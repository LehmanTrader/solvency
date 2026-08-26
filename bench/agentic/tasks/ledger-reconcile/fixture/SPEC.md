# reconciliation

Both CSVs have header `ref,amount` (no quoting). Amounts are decimal strings.

`reconcile()` -> {
  matched:   count of refs present in both where |bank - ledger| <= 0.01,
  mismatched:[ { ref, bank, ledger } ...refs in both but differing by > 0.01 ],
  missingInLedger: [refs only in bank],
  missingInBank:   [refs only in ledger],
}
- Arrays sorted by ref ascending (string compare).
- bank/ledger amounts in the report are numbers as parsed.
- A duplicated ref within one file: keep the SUM of its amounts.
