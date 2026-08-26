# timefmt

Rules for `timeAgo(thenMs, nowMs)`:
- < 60s: 'just now'
- < 60m: 'N minute ago'/'N minutes ago'
- < 24h: 'N hour ago'/'N hours ago'
- < 48h: 'yesterday'
- else: 'N days ago'
