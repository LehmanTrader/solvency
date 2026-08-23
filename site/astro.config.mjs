import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

/**
 * The canonical report markdown lives in ../reports and references its charts
 * relatively ("charts/x.svg") so the file renders correctly on its own and in
 * the PDF. On the site those need to resolve from the site root instead.
 */
function absoluteChartPaths() {
  return (tree) => {
    const walk = (n) => {
      if (n.type === 'image' && typeof n.url === 'string' && n.url.startsWith('charts/')) {
        // dark and light renders of the same figure; CSS shows the one for the active theme
        const file = n.url.slice('charts/'.length);
        const alt = String(n.alt ?? '').replace(/"/g, '&quot;');
        n.type = 'html';
        n.value = `<img src="/charts/${file}" alt="${alt}" width="900" height="600" class="chart-dark" loading="lazy" />` +
                  `<img src="/charts-light/${file}" alt="${alt}" width="900" height="600" class="chart-light" loading="lazy" />`;
      }
      (n.children || []).forEach(walk);
    };
    walk(tree);
  };
}

export default defineConfig({
  site: 'https://solvency.dev',
  // "Reports" read as exports; the notes live at /research. public/_redirects
  // gives Cloudflare real 301s; these keep the old URLs resolving anywhere.
  redirects: {
    '/reports': '/research',
    '/reports/[...slug]': '/research/[...slug]',
  },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwind()],
    // the engine and datasets live one level up, in the repository root
    server: { fs: { allow: ['..'] } },
  },
  markdown: { remarkPlugins: [absoluteChartPaths] },
});
