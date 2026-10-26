// Vite plugin: rewrites the CSS of a production build for Gameface.
//
//   // vite.config.js
//   import gamefaceCompat from 'gameface-css-compat/vite';
//   export default { plugins: [gamefaceCompat()] };
//
// It runs on the final CSS assets, after Vite has bundled every stylesheet
// (including Vue/Svelte <style> blocks and CSS imported from JS), so the
// analysis sees all of the page's CSS. The report is written next to the
// build output as `gameface-compat-report.json`.

import postcss from 'postcss';
import { createContext, transformRoot } from './engine.js';
import { Report } from './report.js';

/**
 * @param {import('./options.js').UserOptions & {
 *   report?: string | false,
 *   onReport?: (report: Report) => void,
 *   failOnRemoved?: boolean
 * }} [options]
 * @returns {import('vite').Plugin}
 */
export default function gamefaceCompat(options = {}) {
  const { report: reportFile = 'gameface-compat-report.json', onReport, failOnRemoved = false, ...rest } = options;
  return {
    name: 'gameface-css-compat',
    apply: 'build',
    enforce: 'post',
    generateBundle(_out, bundle) {
      const assets = Object.values(bundle).filter((a) => a.type === 'asset' && a.fileName.endsWith('.css'));
      if (assets.length === 0) return;
      const roots = assets.map((a) => postcss.parse(String(a.source), { from: a.fileName }));
      const report = new Report();
      const ctx = createContext({ mode: 'gameface', complete: true, ...rest }, roots, report);
      roots.forEach((root, i) => {
        transformRoot(ctx, root);
        assets[i].source = root.toString();
      });
      const summary = report.summary();
      this.info?.(`gameface-css-compat: ${summary.converted} converted, ${summary.removed} removed (Gameface ignores them), ${summary.kept} kept`);
      if (reportFile) {
        this.emitFile({ type: 'asset', fileName: reportFile, source: JSON.stringify({ summary, entries: report.entries }, null, 2) });
      }
      onReport?.(report);
      if (failOnRemoved && summary.removed > 0) {
        this.error(`gameface-css-compat: ${summary.removed} declarations or rules have no Gameface equivalent. See ${reportFile || 'the report'}.`);
      }
    },
  };
}
