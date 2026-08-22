# Solvency site — design brief (design/aa-style)

Reference studied: artificialanalysis.ai (home, /agents/coding-agents), 2026-08-22.
Baseline: solvency.dev as shipped 2026-08-22 (single 48rem column, hero-then-calculator).

## What AA does structurally that we adopt

1. **Wide, dense, data-first.** Content runs to ~1280px; the first screen shows a
   compact thesis and then real charts/tables, not a manifesto.
2. **Sticky global nav** with every section reachable in one click, plus a utility
   cluster on the right (we use Data/Embed/Changelog, not login/premium).
3. **Hero + side rail.** Left: one-line thesis and the headline number. Right: a
   "latest" rail (newest research note, newest changelog entries) so the page feels
   alive and dated.
4. **Highlights row** of three chart cards directly under the hero, each with a title,
   a one-line "what the axis means · lower is better" caption, and a source line.
5. **Chart-led sections** with an eyebrow, a short plain-English caption, the figure,
   then a source + last-verified line. Section TOC on the left at desktop widths.
6. **One card/table system** reused on every page: same header row, same hairline
   rules, same numeral column alignment, same "verified" stamp placement.
7. **Trust signals everywhere:** methodology link, source attribution string, verified
   date on every figure. AA puts them in a right-hand info card; we put them in a
   `Provenance` line under every table/chart and in a Sources section on the home page.

## What we deliberately do not copy

AA's name, logo, purple/cream palette, serif display face, "Premium" nav, tabbed chart
switchers, and their copy. Their attribution string on AA-sourced figures is kept
byte-for-byte because their terms require it.

## What we keep of our own brand

- Ground `#0A0C0D`, panel `#101418`, rule `#1E252A`, ink `#E8ECEF`, amber `#FFB000`.
- Monospace (JetBrains Mono) for every numeral, label and eyebrow; system sans for prose.
- The voice: measured vs modelled are separate tables, "missing" is printed as a word,
  never estimated; the verified date sits beside every number.
- Signature element: the **amber rank rail** — on ranked tables the cheapest row gets an
  amber left rule and amber numeral; the bar charts are single-hue amber with the
  comparison row in ink. One accent, spent on the thing the product is about.

## Page-by-page plan

- **/** Hero (thesis, 3 headline stat tiles computed from data) + latest rail.
  Highlights: three bar charts (cost per solved task, pass rate, output $/Mtok) on the
  measured rows. Leaderboard: Measured table ranked; Modelled table separate, never
  interleaved. Calculator in its own section. Findings: the three report charts with
  captions. Sources: table with tasks, basis, newest entry, verified date. Share row.
- **/reports** Card list with note number, date, description, Share on X + copy link.
- **/reports/[slug]** Two-column at desktop: sticky TOC from headings, prose column with
  improved type scale; share bar under the header and at the end.
- **/models** Sortable-by-eye table (provider grouping, verified column, status badges).
- **/models/[id]** Header + status badges; pricing tiles; cost per solved task tiles;
  benchmark rows with basis; peer bar chart vs current models; compare links.
- **/compare/[a]-vs-[b]** Verdict card; side-by-side tiles; two-bar chart per metric;
  table; provenance line.
- **/methodology, /data, /embed, /changelog** Same shell, prose system, no redesign of
  content.
- **Meta:** every page emits og:*, twitter:card=summary_large_image, twitter:title,
  twitter:description, twitter:image (absolute), og:url, og:site_name.
