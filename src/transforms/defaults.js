// Approximation (opt-in): browser default styles, prepended for Gameface.
//
// Gameface makes every element `display: flex` with `flex-shrink: 0` and
// `box-sizing: border-box`, and leaves headings and a few other elements
// without default styles. Pages written for browsers rely on the browser
// defaults. This preamble restores the most visible ones. It is an
// approximation: Gameface simulates block and inline with flex, and author
// rules for `*` placed earlier than this preamble would be overridden.

import postcss from 'postcss';

const PREAMBLE = `
*, ::before, ::after { flex-shrink: 1; box-sizing: content-box; }
address, article, aside, blockquote, body, dd, details, dialog, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, hr, html, legend, li, main, menu, nav, ol, p, pre, section, summary, ul { display: block; }
a, abbr, b, bdi, bdo, cite, code, data, dfn, em, i, kbd, label, mark, q, s, samp, small, span, strong, sub, sup, time, u, var { display: inline; }
body { margin: 8px; }
h1 { font-size: 2em; margin: 0.67em 0; font-weight: bold; }
h2 { font-size: 1.5em; margin: 0.83em 0; font-weight: bold; }
h3 { font-size: 1.17em; margin: 1em 0; font-weight: bold; }
h4 { margin: 1.33em 0; font-weight: bold; }
h5 { font-size: 0.83em; margin: 1.67em 0; font-weight: bold; }
h6 { font-size: 0.67em; margin: 2.33em 0; font-weight: bold; }
p, blockquote, figure, dl { margin: 1em 0; }
blockquote, figure { margin-left: 40px; margin-right: 40px; }
b, strong { font-weight: bold; }
i, em, cite, var, dfn { font-style: italic; }
`;

const MARKER = 'gameface-css-compat: browser defaults';

/**
 * @param {import('../engine.js').Context} ctx
 * @param {import('postcss').Root} root
 */
export function browserDefaults(ctx, root) {
  let present = false;
  root.walkComments((c) => { if (c.text.includes(MARKER)) present = true; });
  if (present) return;
  const pre = postcss.parse(PREAMBLE);
  pre.prepend(postcss.comment({ text: `${MARKER} (approximation)` }));
  root.prepend(pre.nodes);
  ctx.report.add(root, { transform: 'browser-defaults', action: 'converted', feature: 'approximation:browser-defaults', reason: 'approximation: browser default styles prepended' });
}
