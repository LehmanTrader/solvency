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
        n.url = '/' + n.url;
      }
      (n.children || []).forEach(walk);
    };
    walk(tree);
  };
}

export default defineConfig({
  site: 'https://solvency.dev',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwind()],
    // the engine and datasets live one level up, in the repository root
    server: { fs: { allow: ['..'] } },
  },
  markdown: { remarkPlugins: [absoluteChartPaths] },
});
