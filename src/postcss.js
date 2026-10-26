// PostCSS plugin.
//
//   import gamefaceCompat from 'gameface-css-compat/postcss';
//   export default { plugins: [gamefaceCompat({ mode: 'gameface' })] };
//
// PostCSS processes one file at a time, so rewrites that need to see all CSS
// (for example "this variable is always defined") stay off unless you pass
// `complete: true`. The Vite plugin and the CLI see everything and set it.

import { createContext, transformRoot } from './engine.js';

/**
 * @param {import('./options.js').UserOptions & {
 *   onReport?: (report: import('./report.js').Report, file?: string) => void,
 *   warn?: boolean
 * }} [options]
 * @returns {import('postcss').Plugin}
 */
export default function gamefaceCompat(options = {}) {
  const { onReport, warn = false, ...rest } = options;
  return {
    postcssPlugin: 'gameface-css-compat',
    Once(root, { result }) {
      const ctx = createContext(rest, [root]);
      transformRoot(ctx, root);
      if (warn) {
        for (const e of ctx.report.entries) {
          if (e.action === 'converted') continue;
          result.warn(`${e.action === 'removed' ? 'Removed' : 'Kept'} ${e.feature}${e.before ? ` (${e.before})` : ''}: ${e.reason ?? ''}`, { plugin: 'gameface-css-compat', word: e.before });
        }
      }
      onReport?.(ctx.report, root.source?.input?.file);
    },
  };
}
gamefaceCompat.postcss = true;
