// The transform pipeline. Order matters:
//
//  1. at-rules (gameface): resolve media types and @supports
//  2. selectors: expand :is() where exact
//  3. declarations: expand properties, then rewrite values
//  4. fluid math: viewport min()/max()/clamp() -> media queries
//  5. prune (gameface): remove what Gameface ignores, report it
//
// The pipeline is idempotent: running it on its own output changes nothing.

import postcss from 'postcss';
import { analyze } from './analysis.js';
import { getFeatures } from './features.js';
import { resolveOptions } from './options.js';
import { Report } from './report.js';
import { pruneAtRules, resolveMediaTypes, resolveSupports } from './transforms/atrules.js';
import { fluidMath } from './transforms/fluid.js';
import { transformProperty } from './transforms/properties.js';
import { pruneDeclarations } from './transforms/prune.js';
import { pruneSelectors, pruneSvgDash, unwrapIs } from './transforms/selectors.js';
import { transformValue } from './transforms/values.js';
import { browserDefaults } from './transforms/defaults.js';
import { catalogValues, flattenNesting, individualTransforms, linearEasing, mediaRange, modernValues, pseudoAliases } from './transforms/modern.js';
import valueParser from 'postcss-value-parser';
import { hasPreprocessorSyntax } from './util.js';

/** Every transform id, in pipeline order. */
export const TRANSFORMS = [
  'nesting',
  'browser-defaults',
  'media-range',
  'media-types',
  'supports',
  'selector-is',
  'pseudo-aliases',
  'individual-transforms',
  'logical-properties',
  'shorthands',
  'env',
  'units',
  'light-dark',
  'relative-colors',
  'linear-easing',
  'color-functions',
  'math-functions',
  'transform-functions',
  'basic-shapes',
  'timing-functions',
  'gradient-stops',
  'var-fallback',
  'keywords',
  'initial-keyword',
  'catalog-values',
  'fluid-math',
  'prune',
];

/**
 * @typedef {object} Context
 * @property {import('./features.js').Features} features
 * @property {import('./options.js').ResolvedOptions} options
 * @property {import('./analysis.js').Analysis} analysis
 * @property {Report} report
 * @property {(id: string) => boolean} enabled
 */

/**
 * @param {import('./options.js').UserOptions} userOptions
 * @param {import('postcss').Root[]} roots all stylesheets analysed together
 * @param {Report} [report]
 * @returns {Context}
 */
export function createContext(userOptions, roots, report = new Report()) {
  const options = resolveOptions(userOptions);
  const features = getFeatures(options.version);
  // Nesting is flattened before the analysis, which reads flat rules.
  if (options.mode === 'gameface' && !options.disable.has('nesting')) {
    for (const root of roots) flattenNesting(root, report);
  }
  const analysis = analyze(roots, { complete: options.complete });
  return {
    features,
    options,
    analysis,
    report,
    enabled: (id) => !options.disable.has(id),
  };
}

/**
 * Transforms one root in place.
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function transformRoot(ctx, root) {
  const gameface = ctx.options.mode === 'gameface';

  if (gameface && ctx.options.approximations.has('browser-defaults-preamble') && ctx.enabled('browser-defaults')) browserDefaults(ctx, root);
  if (gameface && ctx.enabled('media-range')) mediaRange(ctx, root);
  if (gameface && ctx.enabled('media-types')) resolveMediaTypes(ctx, root);
  if (gameface && ctx.enabled('supports')) resolveSupports(ctx, root);
  if (ctx.enabled('selector-is')) unwrapIs(ctx, root);
  if (ctx.enabled('pseudo-aliases')) pseudoAliases(ctx, root);
  if (ctx.options.approximations.has('individual-transforms') && ctx.enabled('individual-transforms')) individualTransforms(ctx, root);

  const decls = [];
  root.walkDecls((d) => { decls.push(d); });
  for (const decl of decls) {
    if (!decl.parent) continue;
    for (const d of transformProperty(ctx, decl)) {
      lowerValue(ctx, d);
      transformValue(ctx, d);
      if (d.parent && !hasPreprocessorSyntax(d.value)) catalogValues(ctx, d, d.prop.toLowerCase());
    }
  }

  if (ctx.enabled('fluid-math')) fluidMath(ctx, root);

  if (gameface && ctx.enabled('prune')) {
    pruneAtRules(ctx, root);
    pruneSelectors(ctx, root);
    pruneSvgDash(ctx, root);
    pruneDeclarations(ctx, root);
  }

  if (!gameface && ctx.enabled('prune')) {
    // Source mode never removes anything. Find what Gameface will still ignore
    // by pruning a copy, and report it so nothing is silently left behind.
    const copy = root.clone();
    const shadow = { ...ctx, report: new Report() };
    resolveMediaTypes(shadow, copy);
    pruneAtRules(shadow, copy);
    pruneSelectors(shadow, copy);
    pruneSvgDash(shadow, copy);
    pruneDeclarations(shadow, copy);
    for (const e of shadow.report.entries) {
      ctx.report.entries.push({ ...e, transform: 'unfixable', action: 'kept', reason: `${e.reason ?? ''}; no browser-identical rewrite exists`.replace(/^; /, '') });
    }
  }

  if (gameface && ctx.analysis.hasRtl) {
    ctx.report.add(root, { transform: 'logical-properties', action: 'kept', feature: 'property:direction', reason: 'the stylesheet sets direction: rtl, but Gameface only lays out left-to-right' });
  }
}

/**
 * Transforms a CSS string.
 * @param {string} css
 * @param {import('./options.js').UserOptions & { from?: string, syntax?: import('postcss').Syntax }} [options]
 * @returns {{ css: string, report: Report }}
 */
export function transformCss(css, options = {}) {
  const { from, syntax, ...rest } = options;
  const root = (syntax ?? postcss).parse(css, { from });
  const ctx = createContext(rest, [root]);
  transformRoot(ctx, root);
  return { css: root.toString(syntax), report: ctx.report };
}

/**
 * Value rewrites that run before the main value pass: syntax lowering in
 * gameface mode, and straight-line linear() easings in both modes.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 */
function lowerValue(ctx, decl) {
  if (hasPreprocessorSyntax(decl.value)) return;
  const parsed = valueParser(decl.value);
  if (ctx.options.mode === 'gameface') modernValues(ctx, decl, parsed);
  linearEasing(ctx, decl, parsed);
  const value = parsed.toString();
  if (value !== decl.value) decl.value = value;
}
