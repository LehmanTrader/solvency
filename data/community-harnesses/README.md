# Community harness arena (spec, 2026-08-27)

Anyone can measure their own harness against the fixed Solvency Bench suite:

    export SBENCH_CUSTOM_CMD='your-harness --prompt-file {PROMPT_FILE}'
    export SBENCH_CUSTOM_NAME='my-harness' SBENCH_CUSTOM_VERSION='0.1'
    node bench/runner.mjs --model <slug> --harness custom --trials 3 --max-tokens 8000

The command prints the model reply on stdout plus a final
`SBENCH_USAGE {"input":N,"cacheRead":N,"cacheWrite":N,"output":N}` line;
without it, correctness is graded and dollars are excluded (fail closed).

Submissions land here as `<handle>--<harness-slug>.json`: the run's
summary.json plus `{submitted_by, repo_url, model_slug}`. Two trust tiers:
- `self_reported` — journals attached, anyone can audit.
- `solvency_verified` — we re-ran it on our rig (paid service); rows get the
  verified badge and rank on the public arena.
Arena ranking: cost per solved task on the SAME model + suite; arms on other
models list separately (population isolation applies to people too).
