# Task-count study

Raw data and method behind [Research Note 03 — What Is a Task](/research/what-is-a-task)
(`reports/2026-08-what-is-a-task.md`). This is **Solvency's own measurement**, not an ingested
third-party benchmark: task counts here are derived directly from public GitHub repository
history via `gh api`, not read off a published leaderboard.

## Files

| File | Contents |
|---|---|
| `final_table.csv` | 60 rows, one per repo: stars, dates, commit/PR counts, the unit and count Solvency used, and a short description. |
| `measure_repo.sh` | The exact `gh api` calls that produced every row. `Usage: measure_repo.sh owner/repo`. |
| `repos.txt` | The 60 repos, one per line as `bucket\|owner/repo`, in the order they were measured. |

## Method

**Population.** 60 shipped open-source repos, curated (not randomly sampled) into six use-case
buckets, 9-11 repos per bucket:

| Bucket | Use case | n |
|---|---|---:|
| a | Marketing/landing site | 10 |
| b | Full web app (SaaS) | 11 |
| c | 2D indie game | 10 |
| d | CLI tool/utility | 9 |
| e | Data/ML pipeline | 9 |
| f | Mobile app | 11 |

**Unit chosen per repo** (`unit_used` / `count_used` columns):

- **Merged PRs**, if the repo runs a PR-review flow: contributors > 3, ≥ 10 merged PRs, and a
  PR/commit ratio (`pr_fraction`) ≥ 0.15.
- **Commits**, otherwise (solo or near-solo repos where most work lands as direct commits).

**Window.** Repo creation (`created_at`) to first non-draft GitHub release
(`first_release_tag` / `first_release_date`), via `gh api repos/{repo}/releases`, filtered to
`draft==false` and sorted ascending. Five repos had no discoverable first-release milestone
consistent with normal development (`first_release_tag` = `NA`); for those, `count_used` falls
back to the lifetime total (`commits_total` or `merged_prs_total`), which measures total project
activity rather than time-to-v1.

**Merged-PR counts** come from `gh api search/issues` with `type:pr is:merged`, optionally bounded
by `merged:<=<release-date>` for the to-release figure. **Commit counts** come from the `Link`
header's last-page number on `gh api repos/{repo}/commits`, which is exact for the default branch
and for the release tag's ref.

## Measured

Queried **2026-08-24 and 2026-08-25 (UTC)** against the public GitHub API (`gh api`, authenticated
via `gh auth token`). Every number in `final_table.csv` traces to one of the two `gh api` call
shapes in `measure_repo.sh` — nothing here is interpolated, modelled, or hand-edited.

## Reproduce

```
GH_TOKEN=$(gh auth token) bash data/task-study/measure_repo.sh owner/repo
```

Run once per line in `repos.txt` to regenerate `final_table.csv` from scratch. Re-running will not
reproduce identical numbers indefinitely — repo history grows, so a re-run after this study's
measurement dates will show equal-or-larger counts, not identical ones.

## Caveats

See "3. Caveats" in the published note for the full list (granularity, survivorship bias, the
fuzziness of "first release," the five lifetime-total fallbacks, and the marketing-site bucket's
template skew). This README covers method only.

## Licensing

This is Solvency's own measured data (GitHub API counts collected by Solvency, not redistributed
third-party benchmark data), so it is published under **CC-BY-4.0**, the same license declared
for the whole repository in `package.json` (`"license": "CC-BY-4.0"`) and the same basis on which
`site/scripts/sync-assets.mjs` exports Solvency's own pricing compilation — third-party benchmark
rows stay cited-and-linked only and never enter an open-data export; only Solvency's own measured
runs do. Attribution: Source: Solvency (solvency.dev).
