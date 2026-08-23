import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Reports are loaded from the repository's canonical ../reports directory, not
 * copied into the site. One source of truth: the same file the tests verify and
 * the PDF renders is the one the site publishes.
 */
const reports = defineCollection({
  loader: glob({ pattern: '*.md', base: '../reports' }),
  schema: z.object({
    title: z.string(),
    note: z.number(),
    date: z.coerce.date(),
    description: z.string(),
    price_verified: z.coerce.date().optional(),
    pdf_verified: z.coerce.string().optional(),
    pdf_sources: z.string().optional(),
    pdf_method: z.string().optional(),
    pdf_status: z.string().optional(),
    pdf_tagline: z.string().optional(),
    pdf_hero: z.string().optional(),
  }),
});

export const collections = { reports };
