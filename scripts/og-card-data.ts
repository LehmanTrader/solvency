/**
 * Pure data for the per-page social stat cards (scripts/og-cards.ts renders
 * these into PNGs; test/og-cards.test.ts re-derives the same figures from the
 * same sources and asserts the committed manifest still matches).
 *
 * Every number here traces to one of:
 *   - reports/*.md frontmatter (`description`, `note`, `price_verified`, `pdf_verified`, `pdf_sources`)
 *   - site/src/lib/headline.ts's headline()/solvedFor()/money()/fmtX() (the same
 *     engine that drives the hero, Share.astro and the report tests)
 *   - site/src/lib/data.ts's models/sourceFor (data/models.json, data/benchmarks.json)
 *   - site/src/lib/charts.ts's BASIS_OF (the same measured/modelled/stale label
 *     used on every model page and chart)
 * No number is authored by hand; a note whose description does not carry the
 * expected figure throws rather than silently guessing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { headline, fmtX, money, solvedFor } from '../site/src/lib/headline.ts';
import { models, sourceFor } from '../site/src/lib/data.ts';
import { BASIS_OF } from '../site/src/lib/charts.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPORTS_DIR = join(ROOT, 'reports');

export interface CardData {
  key: string;
  eyebrow: string;
  number: string;
  claim: string;
  attribution: string;
  /** Raw values the staleness test re-derives and compares against. */
  raw: Record<string, unknown>;
}

export interface ReportFrontmatter {
  file: string;
  title: string;
  note: number;
  date: string;
  description: string;
  price_verified?: string;
  pdf_verified?: string;
  pdf_sources?: string;
}

/** Same regex-frontmatter approach as scripts/render-pdf.ts: no YAML dependency. */
export function readReportFrontmatter(file: string): ReportFrontmatter {
  const raw = readFileSync(join(REPORTS_DIR, file), 'utf8');
  const block = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!block) throw new Error(`${file}: no frontmatter block found`);
  const fm: Record<string, string> = {};
  for (const line of block[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (!fm.title || !fm.note || !fm.description) {
    throw new Error(`${file}: missing required frontmatter (title/note/description)`);
  }
  return {
    file, title: fm.title, note: Number(fm.note), date: fm.date, description: fm.description,
    price_verified: fm.price_verified, pdf_verified: fm.pdf_verified, pdf_sources: fm.pdf_sources,
  };
}

export function allReportFrontmatter(): ReportFrontmatter[] {
  const files = readdirSync(REPORTS_DIR).filter((f) => /^\d{4}-\d{2}-.*\.md$/.test(f));
  if (!files.length) throw new Error('no report markdown files found in reports/');
  return files.map(readReportFrontmatter).sort((a, b) => a.note - b.note);
}

/** Last "Nx" figure in a description, e.g. "...widens from 38x to 146x." -> "146x". */
export function extractLastXNumber(desc: string): string {
  const matches = [...desc.matchAll(/(\d+(?:\.\d+)?)x\b/gi)];
  if (!matches.length) throw new Error(`could not find an "Nx" figure in description: ${desc}`);
  return `${matches[matches.length - 1][1]}x`;
}

/** The ratio between two "median N" figures in a description, formatted like the site's fmtX(). */
export function extractMedianRatio(desc: string): { text: string; lo: number; hi: number } {
  const matches = [...desc.matchAll(/median (\d+)/g)];
  if (matches.length < 2) throw new Error(`could not find two "median N" figures in description: ${desc}`);
  const nums = matches.map((m) => Number(m[1]));
  const lo = Math.min(...nums), hi = Math.max(...nums);
  return { text: fmtX(hi / lo), lo, hi };
}

/**
 * One config entry per research note: the claim (editorial, written from
 * reading the note) and how to derive its number from the note's own
 * frontmatter description (mechanical, re-run by the staleness test). Notes
 * without an entry fail loudly rather than falling back to a guess.
 */
export const NOTE_CONFIG: Record<number, { claim: string; deriveNumber: (fm: ReportFrontmatter) => string }> = {
  1: {
    claim: 'the gap between cheapest and priciest per solved task',
    deriveNumber: (fm) => extractLastXNumber(fm.description),
  },
  2: {
    claim: 'cost spread across four harnesses at one pass rate',
    deriveNumber: (fm) => extractLastXNumber(fm.description),
  },
  3: {
    claim: 'more tasks to ship a data/ML pipeline than a mobile app',
    deriveNumber: (fm) => extractMedianRatio(fm.description).text,
  },
};

export function noteCardData(fm: ReportFrontmatter): CardData {
  const cfg = NOTE_CONFIG[fm.note];
  if (!cfg) throw new Error(`no og-card config for research note ${fm.note} (${fm.file}) — add one to NOTE_CONFIG before generating cards`);
  const number = cfg.deriveNumber(fm);
  const verified = fm.pdf_verified ?? fm.price_verified ?? fm.date;
  return {
    key: `note-${String(fm.note).padStart(2, '0')}`,
    eyebrow: `RESEARCH NOTE ${String(fm.note).padStart(2, '0')}`,
    number,
    claim: cfg.claim,
    attribution: `${fm.pdf_sources ?? 'Solvency'} · verified ${verified}`,
    raw: { note: fm.note, description: fm.description },
  };
}

export function homeCardData(): CardData {
  const h = headline();
  return {
    key: 'home',
    eyebrow: 'SOLVENCY',
    number: fmtX(h.solvedX),
    claim: 'cost per solved task, measured',
    attribution: `${h.source?.attribution ?? 'Solvency'} · verified ${h.verified}`,
    raw: { solvedX: h.solvedX, cheapId: h.cheap.m.model_id, dearId: h.dear.m.model_id },
  };
}

export function currentModels() {
  return models.filter((m: any) => m.status === 'current');
}

export function modelCardData(model: any): CardData {
  const mine = solvedFor(model.model_id, 'heavy');
  if (mine) {
    const basis = BASIS_OF[mine.basisKey] ?? 'modelled';
    const src = sourceFor(mine.r.benchmark);
    return {
      key: `model-${model.model_id}`,
      eyebrow: 'MODEL',
      number: money(mine.cost),
      claim: model.display_name,
      attribution: `${basis} cost per solved task · ${src?.attribution ?? mine.r.benchmark} · verified ${src?.last_verified ?? mine.r.run_date}`,
      raw: { modelId: model.model_id, cost: mine.cost, basisKey: mine.basisKey },
    };
  }
  return {
    key: `model-${model.model_id}`,
    eyebrow: 'MODEL',
    number: `$${model.input_per_mtok}/M`,
    claim: model.display_name,
    attribution: `list price, no published pass rate · Provider pricing page · verified ${model.last_verified}`,
    raw: { modelId: model.model_id, cost: null, basisKey: null, inputPerMtok: model.input_per_mtok },
  };
}
