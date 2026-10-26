import { transformCss } from '../../src/index.js';

/**
 * Transforms CSS and returns the output with whitespace normalised.
 * @param {string} css
 * @param {object} [options]
 */
export function run(css, options = {}) {
  const { css: out, report } = transformCss(css, { mode: 'gameface', complete: true, ...options });
  return { css: normalize(out), report, raw: out };
}

/** @param {string} css */
export function normalize(css) {
  return css.replace(/\s+/g, ' ').replace(/\s*([{};,])\s*/g, '$1').replace(/:\s+/g, ':').trim();
}
