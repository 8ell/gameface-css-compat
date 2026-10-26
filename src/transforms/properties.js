// Property-level rewrites: a declaration Gameface rejects becomes one or more
// declarations of properties it supports, with the same computed result.
//
// Logical properties map to physical ones only for left-to-right, horizontal
// text (always true in Gameface, which has no `direction`/`writing-mode`).

import { isPropertyUnsupported } from '../features.js';
import { CSS_WIDE, boxSides, components, hasPreprocessorSyntax, hasVar, replaceDecl } from '../util.js';

/** @typedef {import('../engine.js').Context} Context */

const SIDE = { 'block-start': 'top', 'block-end': 'bottom', 'inline-start': 'left', 'inline-end': 'right' };

/** One-to-one logical -> physical renames (LTR, horizontal-tb). */
const LOGICAL_RENAME = new Map();
for (const [logical, physical] of Object.entries(SIDE)) {
  LOGICAL_RENAME.set(`margin-${logical}`, `margin-${physical}`);
  LOGICAL_RENAME.set(`padding-${logical}`, `padding-${physical}`);
  LOGICAL_RENAME.set(`inset-${logical}`, physical);
  LOGICAL_RENAME.set(`border-${logical}`, `border-${physical}`);
  for (const part of ['width', 'style', 'color']) LOGICAL_RENAME.set(`border-${logical}-${part}`, `border-${physical}-${part}`);
  LOGICAL_RENAME.set(`scroll-margin-${logical}`, `scroll-margin-${physical}`);
  LOGICAL_RENAME.set(`scroll-padding-${logical}`, `scroll-padding-${physical}`);
}
for (const [logical, physical] of [['block-size', 'height'], ['inline-size', 'width']]) {
  LOGICAL_RENAME.set(logical, physical);
  LOGICAL_RENAME.set(`min-${logical}`, `min-${physical}`);
  LOGICAL_RENAME.set(`max-${logical}`, `max-${physical}`);
  LOGICAL_RENAME.set(`contain-intrinsic-${logical}`, `contain-intrinsic-${physical}`);
}
LOGICAL_RENAME.set('border-start-start-radius', 'border-top-left-radius');
LOGICAL_RENAME.set('border-start-end-radius', 'border-top-right-radius');
LOGICAL_RENAME.set('border-end-start-radius', 'border-bottom-left-radius');
LOGICAL_RENAME.set('border-end-end-radius', 'border-bottom-right-radius');
LOGICAL_RENAME.set('overflow-block', 'overflow-y');
LOGICAL_RENAME.set('overflow-inline', 'overflow-x');
LOGICAL_RENAME.set('overscroll-behavior-block', 'overscroll-behavior-y');
LOGICAL_RENAME.set('overscroll-behavior-inline', 'overscroll-behavior-x');

/** Logical two-value shorthands: first value -> start side, second (or first) -> end side. */
const LOGICAL_PAIR = new Map();
for (const axis of ['block', 'inline']) {
  const [s, e] = axis === 'block' ? ['top', 'bottom'] : ['left', 'right'];
  LOGICAL_PAIR.set(`margin-${axis}`, [`margin-${s}`, `margin-${e}`]);
  LOGICAL_PAIR.set(`padding-${axis}`, [`padding-${s}`, `padding-${e}`]);
  LOGICAL_PAIR.set(`inset-${axis}`, [s, e]);
  LOGICAL_PAIR.set(`scroll-margin-${axis}`, [`scroll-margin-${s}`, `scroll-margin-${e}`]);
  LOGICAL_PAIR.set(`scroll-padding-${axis}`, [`scroll-padding-${s}`, `scroll-padding-${e}`]);
  for (const part of ['width', 'style', 'color']) LOGICAL_PAIR.set(`border-${axis}-${part}`, [`border-${s}-${part}`, `border-${e}-${part}`]);
}

/** Logical shorthands that set both sides to the same value. */
const LOGICAL_BOTH = new Map([
  ['border-block', ['border-top', 'border-bottom']],
  ['border-inline', ['border-left', 'border-right']],
]);

/** Every logical property this module knows how to map. */
export const LOGICAL_PROPERTIES = new Set([...LOGICAL_RENAME.keys(), ...LOGICAL_PAIR.keys(), ...LOGICAL_BOTH.keys()]);

const FLEX_DIRECTIONS = new Set(['row', 'row-reverse', 'column', 'column-reverse']);
const FLEX_WRAPS = new Set(['nowrap', 'wrap', 'wrap-reverse']);
const ALIGN_SIMPLE = /^[a-z-]+$/;
const ALIGN_COMPLEX = new Set(['baseline', 'first', 'last', 'safe', 'unsafe', 'legacy']);

/** Shorthands (and legacy aliases) this module can expand. */
export const SHORTHAND_PROPERTIES = new Set(['inset', 'place-content', 'place-items', 'place-self', 'flex-flow', 'grid-gap', 'grid-row-gap', 'grid-column-gap']);

/**
 * Expands or renames a declaration. Returns the declarations now standing in
 * its place (the original when nothing changed).
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @returns {import('postcss').Declaration[]}
 */
export function transformProperty(ctx, decl) {
  const prop = decl.prop.toLowerCase();
  if (prop.startsWith('--') || hasPreprocessorSyntax(decl.value)) return [decl];
  if (!isPropertyUnsupported(ctx.features, prop)) {
    if (prop === 'outline' && ctx.options.approximations.has('outline-to-box-shadow')) return outlineApprox(ctx, decl);
    return [decl];
  }

  if (LOGICAL_PROPERTIES.has(prop)) {
    if (!ctx.enabled('logical-properties')) return [decl];
    if (!ctx.options.ltr) {
      ctx.report.add(decl, { transform: 'logical-properties', action: 'kept', feature: `property:${prop}`, before: `${decl.prop}: ${decl.value}`, reason: 'right-to-left pages would map differently (set assumeLtr if every page is LTR)' });
      return [decl];
    }
    return logical(ctx, decl, prop);
  }
  if (SHORTHAND_PROPERTIES.has(prop)) {
    if (!ctx.enabled('shorthands')) return [decl];
    return shorthand(ctx, decl, prop);
  }
  if (prop === 'outline' && ctx.options.approximations.has('outline-to-box-shadow')) return outlineApprox(ctx, decl);
  return [decl];
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {Array<{prop: string, value: string}>} out
 * @param {string} transform
 * @param {string} [reason]
 */
function apply(ctx, decl, out, transform, reason) {
  const before = `${decl.prop}: ${decl.value}`;
  const created = replaceDecl(decl, out);
  ctx.report.add(created[0], {
    transform,
    action: 'converted',
    feature: `property:${decl.prop.toLowerCase()}`,
    before,
    after: out.map((d) => `${d.prop}: ${d.value}`).join('; '),
    reason,
  });
  return created;
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {string} prop
 */
function logical(ctx, decl, prop) {
  const value = decl.value.trim();
  const kept = (reason) => {
    ctx.report.add(decl, { transform: 'logical-properties', action: 'kept', feature: `property:${prop}`, before: `${decl.prop}: ${decl.value}`, reason });
    return [decl];
  };

  if (LOGICAL_RENAME.has(prop)) {
    const target = LOGICAL_RENAME.get(prop);
    if (isPropertyUnsupported(ctx.features, target)) return kept(`its physical equivalent ${target} is not supported either`);
    return apply(ctx, decl, [{ prop: target, value }], 'logical-properties');
  }

  if (LOGICAL_BOTH.has(prop)) {
    const targets = LOGICAL_BOTH.get(prop);
    if (targets.some((t) => isPropertyUnsupported(ctx.features, t))) return kept('its physical equivalents are not supported');
    return apply(ctx, decl, targets.map((t) => ({ prop: t, value })), 'logical-properties');
  }

  const [start, end] = LOGICAL_PAIR.get(prop);
  if (isPropertyUnsupported(ctx.features, start) || isPropertyUnsupported(ctx.features, end)) return kept('its physical equivalents are not supported');
  if (hasVar(value)) return kept('a var() may hold one or two values; the split is unknown');
  const parts = components(value);
  if (!parts || parts.length < 1 || parts.length > 2) return kept('unexpected value');
  const [a, b = a] = parts;
  return apply(ctx, decl, [{ prop: start, value: a }, { prop: end, value: b }], 'logical-properties');
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {string} prop
 */
function shorthand(ctx, decl, prop) {
  const value = decl.value.trim();
  const lower = value.toLowerCase();
  const kept = (reason) => {
    ctx.report.add(decl, { transform: 'shorthands', action: 'kept', feature: `property:${prop}`, before: `${decl.prop}: ${decl.value}`, reason });
    return [decl];
  };
  const unsupportedTarget = (targets) => targets.find((t) => isPropertyUnsupported(ctx.features, t));

  if (prop === 'grid-gap' || prop === 'grid-row-gap' || prop === 'grid-column-gap') {
    const target = prop.replace('grid-', '');
    if (isPropertyUnsupported(ctx.features, target)) return kept(`${target} is not supported either`);
    return apply(ctx, decl, [{ prop: target, value }], 'shorthands', `${prop} is a legacy alias of ${target}`);
  }

  if (prop === 'inset') {
    const targets = ['top', 'right', 'bottom', 'left'];
    if (CSS_WIDE.has(lower)) return apply(ctx, decl, targets.map((t) => ({ prop: t, value })), 'shorthands');
    if (hasVar(value)) return kept('a var() may hold several values; the split is unknown');
    const parts = components(value);
    const sides = parts && boxSides(parts);
    if (!sides) return kept('unexpected value');
    return apply(ctx, decl, targets.map((t, i) => ({ prop: t, value: sides[i] })), 'shorthands');
  }

  if (prop === 'flex-flow') {
    const targets = ['flex-direction', 'flex-wrap'];
    if (unsupportedTarget(targets)) return kept('its longhands are not supported');
    if (CSS_WIDE.has(lower)) return apply(ctx, decl, targets.map((t) => ({ prop: t, value })), 'shorthands');
    if (hasVar(value)) return kept('a var() may hold one or two values; the split is unknown');
    const parts = components(lower);
    if (!parts || parts.length < 1 || parts.length > 2) return kept('unexpected value');
    let direction = null;
    let wrap = null;
    for (const p of parts) {
      if (FLEX_DIRECTIONS.has(p) && direction === null) direction = p;
      else if (FLEX_WRAPS.has(p) && wrap === null) wrap = p;
      else return kept('unexpected value');
    }
    return apply(ctx, decl, [{ prop: 'flex-direction', value: direction ?? 'row' }, { prop: 'flex-wrap', value: wrap ?? 'nowrap' }], 'shorthands');
  }

  // place-content / place-items / place-self
  const axis = prop.slice('place-'.length); // content | items | self
  const targets = [`align-${axis}`, `justify-${axis}`];
  if (CSS_WIDE.has(lower)) return apply(ctx, decl, targets.map((t) => ({ prop: t, value })), 'shorthands');
  if (hasVar(value)) return kept('a var() may hold one or two values; the split is unknown');
  const parts = components(lower);
  if (!parts || parts.length < 1 || parts.length > 2 || !parts.every((p) => ALIGN_SIMPLE.test(p))) return kept('unexpected value');
  if (parts.some((p) => ALIGN_COMPLEX.has(p))) return kept('baseline, safe/unsafe and legacy values are not split automatically');
  const [a, b = a] = parts;
  return apply(ctx, decl, [{ prop: targets[0], value: a }, { prop: targets[1], value: b }], 'shorthands');
}

/**
 * Approximation: a solid outline drawn as a spread box-shadow.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 */
function outlineApprox(ctx, decl) {
  const rule = decl.parent;
  const kept = (reason) => {
    ctx.report.add(decl, { transform: 'outline-to-box-shadow', action: 'kept', feature: 'property:outline', before: `${decl.prop}: ${decl.value}`, reason });
    return [decl];
  };
  if (!rule || rule.type !== 'rule') return kept('not in a style rule');
  let hasShadow = false;
  rule.each((n) => { if (n.type === 'decl' && n.prop.toLowerCase() === 'box-shadow') hasShadow = true; });
  if (hasShadow) return kept('the rule already sets box-shadow');
  const parts = components(decl.value.trim());
  if (!parts) return kept('unexpected value');
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.length === 1 && (lower[0] === 'none' || lower[0] === '0')) return apply(ctx, decl, [{ prop: 'box-shadow', value: 'none' }], 'outline-to-box-shadow', 'approximation');
  if (!lower.includes('solid')) return kept('only solid outlines can be drawn as a shadow');
  const width = parts.find((p) => /^[\d.]+[a-z]+$/i.test(p)) ?? '3px';
  const color = parts.find((p) => p.toLowerCase() !== 'solid' && p !== width) ?? 'currentcolor';
  return apply(ctx, decl, [{ prop: 'box-shadow', value: `0 0 0 ${width} ${color}` }], 'outline-to-box-shadow', 'approximation: the shadow follows border-radius and does not combine with other shadows');
}
