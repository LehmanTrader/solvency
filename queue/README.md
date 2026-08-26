# queue/ — the approval queue

One uniform mechanism for every agent-drafted, human-approved output. Design:
`docs/marketing/panel-2026-08-26/08-automation.md` §2. Core principle: agents
draft, the founder approves. Nothing in here posts or sends anything by
itself — every script under `scripts/` that writes here only writes here.

## Layout

```
queue/
  <date>/                  # one folder per day, e.g. 2026-08-26/
    content-miner.md        # nightly delta-mined drafts (npm run queue:miner)
    price-watch.md           # price-change confirmation checklist + drafts (npm run queue:price-watch)
    reply-scout.md            # (future) thread + drafted reply
    outreach-batch.md         # (future) personalized email drafts
    ads-digest.md              # (future) read-only informational
  _state/                  # snapshot caches each script diffs against (delta-mining state, not drafts)
  _archive/                # `mv queue/<date> queue/_archive/` once a date is processed
```

## File format

Every queue file opens with frontmatter and then a numbered list of items:

```
---
generated_by: scripts/content-miner.ts
run_at: 2026-08-26T02:00:00.000Z
regenerate_with: npm run queue:miner
---

1. <draft text>
   source: data/models.json · input_per_mtok · verified 2026-08-26

2. <draft text>
   source: data/models.json · output_per_mtok · verified 2026-08-26
```

**There is no status field.** The file itself is the decision. Nothing is
"approved" or "rejected" in metadata — presence after your edit pass IS
approval.

## The morning pass (~15 minutes)

1. Open each file in `queue/<today>/`.
2. **Delete** any item you don't want sent. Gone means rejected.
3. **Edit** any item you want to keep, until the wording is exactly what you'd
   post. What remains in the file when you're done is what's approved.
4. Send it yourself (v1: copy-paste by hand; v1.5: a founder-invoked
   `send-approved.ts`, never run from a cron).
5. Archive the date once you're done with it:
   ```
   mv queue/<date> queue/_archive/
   ```

## What never happens here

- No script writes `data/models.json`, `data/benchmarks.json`,
  `data/changelog.json`, or anything else under `data/` — see
  `scripts/watch-prices.ts` for the pattern every content script follows.
- No script calls a posting or sending API. Everything stops at a file under
  `queue/`.
- Nothing in `queue/` is committed except this README — drafts are an
  operator's working files, not repo history. See `.gitignore`.
