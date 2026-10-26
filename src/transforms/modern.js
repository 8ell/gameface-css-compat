// Rewrites added after the first release.
//
// Catalog items (both modes; each is exact in every browser):
//   `prop: initial` -> the property's initial value
//   `opacity: 50%` -> `0.5`
//   `stroke-dasharray: none` -> `0` (a zero-sum dash array is drawn solid)
//   `linear(0, 0.5, 1)` and other straight-line linear() easings -> `linear`
//   `:first-of-type` -> `:nth-of-type(1)`, `:last-of-type` -> `:nth-last-of-type(1)`,
//   `:scope` outside @scope -> `:root` (same specificity)
//   `animation-duration: auto` -> `0s` (gameface mode: no scroll-driven animations)
//
// Syntax lowering (gameface mode). The official linter does not flag these, but
// they are newer than Gameface's parser. Each rewrite produces the same result
// in any engine, so it is safe whether or not Gameface understands the input:
//   CSS nesting -> flat rules (spec semantics, via postcss-nesting)
//   `@media (width >= 600px)` -> `@media (min-width: 600px)`
//   `light-dark(a, b)` -> `a` (Gameface has no color-scheme, so pages are light)
//   relative colours `rgb(from red r g calc(b + 20))` -> `rgb()`
//   dvh/svh/lvh/vi/vb/cq* units -> vh/vw/vmin/vmax (no browser UI, no containers)
//   cm/mm/q/pc -> px (CSS defines them as fixed multiples of px)
//
// Approximation `individual-transforms`: translate/rotate/scale are merged into
// `transform` in the same rule. It assumes no other rule's transform applies
// to the same element (otherwise the browser would compose them).

import postcss from 'postcss';
import postcssNesting from 'postcss-nesting';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { converter, toGamut } from 'culori';
import { NotConvertible, formatRgb, parseConstantColor } from '../colors.js';
import { isKeywordRejected, isPropertyUnsupported } from '../features.js';
import { formatNumber } from '../math.js';
import { replaceNode, walkFunctionsBottomUp } from '../util.js';

/** @typedef {import('../engine.js').Context} Context */

// ---------------------------------------------------------------- nesting

/**
 * Flattens native CSS nesting in place.
 * @param {import('postcss').Root} root
 * @param {import('../report.js').Report} report
 */
export function flattenNesting(root, report) {
  const nested = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === 'rule') return;
    if (rule.some((n) => n.type === 'rule' || (n.type === 'atrule' && n.nodes))) nested.push(rule);
  });
  if (nested.length === 0) return;
  for (const rule of nested) {
    report.add(rule, { transform: 'nesting', action: 'converted', feature: 'syntax:nesting', before: rule.selector, after: '(flattened)', reason: 'nested rules written out as flat rules' });
  }
  postcss([postcssNesting({ edition: '2024-02' })]).process(root, { from: root.source?.input?.file }).sync();
}

// ---------------------------------------------------------------- media range syntax

const RANGE_FEATURES = new Set(['width', 'height', 'aspect-ratio', 'resolution', 'device-width', 'device-height', 'device-aspect-ratio', 'color', 'color-index', 'monochrome']);
const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };

/**
 * One parenthesised range test, rewritten, or null if it is not range syntax.
 * Returns 'strict' for `<`/`>`, which have no exact min-/max- form.
 * @param {string} inner text inside the parentheses
 * @returns {string[] | 'strict' | null}
 */
function rangeTest(inner) {
  const parts = inner.trim().split(/\s*(<=|>=|<|>|=)\s*/);
  if (parts.length !== 3 && parts.length !== 5) return null;
  /** @type {Array<[string, string, string]>} feature, op, value */
  const tests = [];
  if (parts.length === 3) {
    const [a, op, b] = parts;
    if (RANGE_FEATURES.has(a.toLowerCase())) tests.push([a, op, b]);
    else if (RANGE_FEATURES.has(b.toLowerCase())) tests.push([b, FLIP[op], a]);
    else return null;
  } else {
    const [a, op1, name, op2, b] = parts;
    if (!RANGE_FEATURES.has(name.toLowerCase())) return null;
    const lowToHigh = (op1 === '<' || op1 === '<=') && (op2 === '<' || op2 === '<=');
    const highToLow = (op1 === '>' || op1 === '>=') && (op2 === '>' || op2 === '>=');
    if (!lowToHigh && !highToLow) return null;
    tests.push([name, FLIP[op1], a], [name, op2, b]);
  }
  const out = [];
  for (const [name, op, value] of tests) {
    const n = name.toLowerCase();
    if (op === '<' || op === '>') return 'strict';
    out.push(op === '>=' ? `(min-${n}: ${value})` : op === '<=' ? `(max-${n}: ${value})` : `(${n}: ${value})`);
  }
  return out;
}

/**
 * @param {string} query one media query
 * @returns {string | 'strict' | null}
 */
function rewriteQuery(query) {
  if (!/[<>=]/.test(query)) return null;
  // only plain and-chains: `[only] [type and] (a) and (b)`; `not`/`or` need MQ4 grouping
  const m = /^((?:only\s+)?[a-z-]+\s+and\s+)?(.*)$/is.exec(query.trim());
  const prefix = m[1] && !/^not\b/i.test(m[1]) ? m[1] : '';
  const body = prefix ? m[2] : query.trim();
  if (/\b(not|or)\b/i.test(body)) return null;
  const tests = body.split(/\s+and\s+/i);
  const out = [];
  for (const t of tests) {
    const g = /^\(([\s\S]*)\)$/.exec(t.trim());
    if (!g) return null;
    const r = /[<>=]/.test(g[1]) ? rangeTest(g[1]) : [`(${g[1]})`];
    if (r === null) return null;
    if (r === 'strict') return 'strict';
    out.push(...r);
  }
  return prefix + out.join(' and ');
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function mediaRange(ctx, root) {
  root.walkAtRules(/^media$/i, (rule) => {
    if (!/[<>=]/.test(rule.params)) return;
    const queries = rule.params.split(',');
    const rewritten = queries.map(rewriteQuery);
    if (rewritten.includes('strict')) {
      ctx.report.add(rule, { transform: 'media-range', action: 'kept', feature: 'syntax:media-range', before: `@media ${rule.params}`, reason: '< and > have no exact min-/max- equivalent; use <= or >=' });
      return;
    }
    if (rewritten.every((r) => r === null)) return;
    const before = `@media ${rule.params}`;
    rule.params = rewritten.map((r, i) => r ?? queries[i].trim()).join(', ');
    ctx.report.add(rule, { transform: 'media-range', action: 'converted', feature: 'syntax:media-range', before, after: `@media ${rule.params}` });
  });
}

// ---------------------------------------------------------------- selectors

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function pseudoAliases(ctx, root) {
  const { unsupportedPseudos } = ctx.features;
  const ALIASES = {
    ':first-of-type': ':nth-of-type(1)',
    ':last-of-type': ':nth-last-of-type(1)',
  };
  const active = Object.entries(ALIASES).filter(([from, to]) => unsupportedPseudos.has(from) && !unsupportedPseudos.has(to.replace(/\(.*$/, '')));
  const scope = unsupportedPseudos.has(':scope') && !unsupportedPseudos.has(':root');
  if (active.length === 0 && !scope) return;

  root.walkRules((rule) => {
    if (!/:(first-of-type|last-of-type|scope)\b/i.test(rule.selector)) return;
    let insideScope = false;
    for (let p = rule.parent; p; p = p.parent) if (p.type === 'atrule' && p.name.toLowerCase() === 'scope') insideScope = true;
    const before = rule.selector;
    const changed = [];
    const out = selectorParser((sel) => {
      sel.walkPseudos((ps) => {
        const name = ps.value.toLowerCase();
        const alias = active.find(([from]) => from === name);
        if (alias && ps.nodes.length === 0) {
          ps.replaceWith(selectorParser.pseudo({ value: alias[1] }));
          changed.push(name);
        } else if (scope && name === ':scope' && !insideScope) {
          ps.value = ':root';
          changed.push(name);
        }
      });
    }).processSync(rule.selector, { lossless: true });
    if (changed.length === 0) return;
    rule.selector = out;
    for (const name of new Set(changed)) {
      ctx.report.add(rule, { transform: 'pseudo-aliases', action: 'converted', feature: `selector:${name}`, before, after: out, reason: name === ':scope' ? 'outside @scope, :scope is the root element' : 'same element set, same specificity' });
    }
  });
}

// ---------------------------------------------------------------- values

/** Initial values (CSS specs) for properties whose `initial` keyword Gameface rejects. */
const INITIAL = {
  'animation-delay': '0s',
  'backdrop-filter': 'none',
  'background-color': 'transparent',
  'border-image-outset': '0',
  'border-image-slice': '100%',
  cx: '0',
  cy: '0',
  d: 'none',
  fill: 'black',
  'fill-opacity': '1',
  filter: 'none',
  'flex-grow': '0',
  'flex-shrink': '1',
  'mask-repeat': 'repeat',
  'padding-top': '0',
  'padding-right': '0',
  'padding-bottom': '0',
  'padding-left': '0',
  r: '0',
  rx: 'auto',
  ry: 'auto',
  'shape-rendering': 'auto',
  'stop-color': 'black',
  'stop-opacity': '1',
  stroke: 'none',
  'stroke-dashoffset': '0',
  'stroke-miterlimit': '4',
  'stroke-opacity': '1',
  'stroke-width': '1px',
  'text-anchor': 'start',
  'text-decoration-color': 'currentcolor',
  '-webkit-text-stroke-color': 'currentcolor',
  'text-stroke-color': 'currentcolor',
  '-webkit-text-stroke-width': '0',
  'text-stroke-width': '0',
  transform: 'none',
  'transition-delay': '0s',
  'transition-duration': '0s',
  x: '0',
  y: '0',
};

/**
 * Keyword-level catalog rewrites on a whole declaration.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {string} prop
 */
export function catalogValues(ctx, decl, prop) {
  const { features } = ctx;
  const value = decl.value.trim();
  const lower = value.toLowerCase();
  const set = (after, feature, reason, transform = 'catalog-values') => {
    ctx.report.add(decl, { transform, action: 'converted', feature, before: value, after, reason });
    decl.value = after;
  };

  if (lower === 'initial' && ctx.enabled('initial-keyword') && INITIAL[prop] !== undefined && isKeywordRejected(features, prop, 'initial')) {
    set(INITIAL[prop], `value:${prop}:initial`, 'replaced by the initial value', 'initial-keyword');
    return;
  }
  if (!ctx.enabled('catalog-values')) return;

  if (prop === 'stroke-dasharray' && lower === 'none' && isKeywordRejected(features, prop, 'none')) {
    set('0', 'value:stroke-dasharray:none', 'a dash array that sums to zero is drawn solid, like none');
    return;
  }
  if (prop === 'animation-duration' && lower === 'auto' && ctx.options.mode === 'gameface' && isKeywordRejected(features, prop, 'auto')) {
    set('0s', 'value:animation-duration:auto', 'auto is 0s for time-based animations, the only kind Gameface has');
    return;
  }
  const partial = features.partialProperties.get(prop);
  const units = partial?.evidence?.supportedUnits;
  if (partial?.disallowed.has('percentages') && units && !units.includes('%') && units.includes('<number>')) {
    const parsed = valueParser(decl.value);
    let hit = false;
    for (const n of parsed.nodes) {
      const u = n.type === 'word' ? valueParser.unit(n.value) : false;
      if (u && u.unit === '%' && u.number !== '') {
        n.value = formatNumber(Number(u.number) / 100);
        hit = true;
      }
    }
    if (hit) set(parsed.toString(), `value:${prop}:percentages`, 'percentage written as the equivalent number');
  }
}

const UNIT_ALIASES = {
  dvh: 'vh', svh: 'vh', lvh: 'vh', dvw: 'vw', svw: 'vw', lvw: 'vw',
  dvmin: 'vmin', svmin: 'vmin', lvmin: 'vmin', dvmax: 'vmax', svmax: 'vmax', lvmax: 'vmax',
  vi: 'vw', svi: 'vw', lvi: 'vw', dvi: 'vw', vb: 'vh', svb: 'vh', lvb: 'vh', dvb: 'vh',
};
const CONTAINER_UNITS = { cqw: 'vw', cqi: 'vw', cqh: 'vh', cqb: 'vh', cqmin: 'vmin', cqmax: 'vmax' };
const ABSOLUTE_UNITS = { cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pc: 16 };

const toRgb = converter('rgb');
const gamutMapRgb = toGamut('rgb', 'oklch');
const RELATIVE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch']);

/**
 * Value-level syntax lowering (gameface mode).
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 */
export function modernValues(ctx, decl, parsed) {
  const { features } = ctx;

  if (ctx.enabled('units')) {
    const noContainers = isPropertyUnsupported(features, 'container-type');
    valueParser.walk(parsed.nodes, (n) => {
      if (n.type === 'function' && n.value.toLowerCase() === 'url') return false;
      if (n.type !== 'word') return undefined;
      const u = valueParser.unit(n.value);
      if (!u || u.number === '') return undefined;
      const unit = u.unit.toLowerCase();
      let after = null;
      let reason;
      if (UNIT_ALIASES[unit]) {
        after = u.number + UNIT_ALIASES[unit];
        reason = 'a game view has no browser UI and is always horizontal, so these equal the plain viewport units';
      } else if (noContainers && CONTAINER_UNITS[unit]) {
        after = u.number + CONTAINER_UNITS[unit];
        reason = 'with no query containers, container units fall back to viewport units';
      } else if (ABSOLUTE_UNITS[unit]) {
        after = `${formatNumber(Number(u.number) * ABSOLUTE_UNITS[unit])}px`;
        reason = 'CSS defines absolute units as fixed multiples of px';
      }
      if (after === null) return undefined;
      ctx.report.add(decl, { transform: 'units', action: 'converted', feature: `unit:${unit}`, before: n.value, after, reason });
      n.value = after;
      return undefined;
    });
  }

  walkFunctionsBottomUp(parsed, (fn) => {
    const name = fn.value.toLowerCase();
    if (name === 'light-dark' && ctx.enabled('light-dark') && isPropertyUnsupported(features, 'color-scheme')) {
      const args = [[]];
      for (const n of fn.nodes) {
        if (n.type === 'div' && n.value === ',') args.push([]);
        else args[args.length - 1].push(n);
      }
      if (args.length !== 2) return;
      const before = valueParser.stringify(fn);
      const after = valueParser.stringify(args[0]).trim();
      replaceNode(fn, after);
      ctx.report.add(decl, { transform: 'light-dark', action: 'converted', feature: 'function:light-dark', before, after, reason: 'Gameface has no color-scheme, so the light colour is always used' });
      return;
    }
    if (RELATIVE_FUNCTIONS.has(name) && ctx.enabled('relative-colors') && fn.nodes.some((n) => n.type === 'word' && n.value.toLowerCase() === 'from')) {
      const before = valueParser.stringify(fn);
      try {
        const color = parseConstantColor(before);
        const rgb = toRgb(color);
        const srgb = name.startsWith('rgb') || name.startsWith('hsl') || name === 'hwb';
        const inGamut = ['r', 'g', 'b'].every((c) => rgb[c] >= -1e-6 && rgb[c] <= 1 + 1e-6);
        const after = formatRgb(srgb || inGamut ? rgb : gamutMapRgb(color));
        replaceNode(fn, after);
        ctx.report.add(decl, { transform: 'relative-colors', action: 'converted', feature: 'syntax:relative-color', before, after });
      } catch (err) {
        if (!(err instanceof NotConvertible)) throw err;
        ctx.report.add(decl, { transform: 'relative-colors', action: 'kept', feature: 'syntax:relative-color', before, reason: err.message });
      }
      return;
    }
  });
}

/**
 * Value rewrites that are exact in browsers too (both modes).
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 */
export function linearEasing(ctx, decl, parsed) {
  if (!ctx.enabled('linear-easing')) return;
  walkFunctionsBottomUp(parsed, (fn) => {
    if (fn.value.toLowerCase() !== 'linear' || !isStraightLinear(fn)) return;
    const before = valueParser.stringify(fn);
    replaceNode(fn, 'linear');
    ctx.report.add(decl, { transform: 'linear-easing', action: 'converted', feature: 'function:linear', before, after: 'linear', reason: 'every point lies on the straight line' });
  });
}

/**
 * Whether a linear() easing is the identity, with input positions filled in as
 * CSS Easing 2 §2.1 describes.
 * @param {import('postcss-value-parser').FunctionNode} fn
 */
function isStraightLinear(fn) {
  const stops = [[]];
  for (const n of fn.nodes) {
    if (n.type === 'div' && n.value === ',') stops.push([]);
    else if (n.type === 'word') stops[stops.length - 1].push(n.value);
    else if (n.type !== 'space' && n.type !== 'comment') return false;
  }
  /** @type {Array<{ out: number, at: number | null }>} */
  const pts = [];
  for (const s of stops) {
    if (s.length < 1 || s.length > 3) return false;
    const out = Number(s[0]);
    if (!Number.isFinite(out) || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s[0])) return false;
    const at = s.slice(1).map((p) => (/%$/.test(p) ? Number(p.slice(0, -1)) / 100 : NaN));
    if (at.some((x) => !Number.isFinite(x))) return false;
    if (at.length === 0) pts.push({ out, at: null });
    else for (const a of at) pts.push({ out, at: a });
  }
  if (pts.length < 2) return false;
  if (pts[0].at === null) pts[0].at = 0;
  if (pts[pts.length - 1].at === null) pts[pts.length - 1].at = 1;
  let max = pts[0].at;
  for (const p of pts) {
    if (p.at !== null) { if (p.at < max) p.at = max; max = p.at; }
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].at !== null) continue;
    let j = i;
    while (pts[j].at === null) j++;
    const a = pts[i - 1].at;
    const b = pts[j].at;
    for (let k = i; k < j; k++) pts[k].at = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  const eps = 1e-9;
  if (Math.abs(pts[0].at) > eps || Math.abs(pts[pts.length - 1].at - 1) > eps) return false;
  return pts.every((p) => Math.abs(p.out - p.at) < eps);
}

// ---------------------------------------------------------------- individual transforms (approximation)

/**
 * @param {string} prop
 * @param {string} value
 * @returns {string | null} transform function text, '' for none, null if unknown
 */
function individualToFunction(prop, value) {
  const words = valueParser(value).nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
  if (words.some((n) => n.type === 'div')) return null;
  const t = words.map((n) => valueParser.stringify(n));
  if (t.length === 1 && t[0].toLowerCase() === 'none') return '';
  if (prop === 'translate') {
    if (t.length === 1) return `translate(${t[0]})`;
    if (t.length === 2) return `translate(${t[0]}, ${t[1]})`;
    if (t.length === 3) return `translate3d(${t[0]}, ${t[1]}, ${t[2]})`;
  }
  if (prop === 'scale') {
    const num = (s) => (/%$/.test(s) ? formatNumber(Number(s.slice(0, -1)) / 100) : s);
    if (t.length === 1) return `scale(${num(t[0])})`;
    if (t.length === 2) return `scale(${num(t[0])}, ${num(t[1])})`;
    if (t.length === 3) return `scale3d(${num(t[0])}, ${num(t[1])}, ${num(t[2])})`;
  }
  if (prop === 'rotate') {
    if (t.length === 1) return `rotate(${t[0]})`;
    if (t.length === 2) {
      const axis = t[0].toLowerCase();
      if (axis === 'x' || axis === 'y' || axis === 'z') return `rotate${axis.toUpperCase()}(${t[1]})`;
    }
    if (t.length === 4) return `rotate3d(${t[0]}, ${t[1]}, ${t[2]}, ${t[3]})`;
  }
  return null;
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function individualTransforms(ctx, root) {
  root.walkRules((rule) => {
    const decls = rule.nodes.filter((n) => n.type === 'decl' && ['translate', 'rotate', 'scale'].includes(n.prop.toLowerCase()));
    if (decls.length === 0) return;
    // the last declaration of each property wins, like the cascade within a rule
    const last = {};
    for (const d of decls) last[d.prop.toLowerCase()] = d;
    const parts = [];
    for (const p of ['translate', 'rotate', 'scale']) {
      if (!last[p]) continue;
      const f = individualToFunction(p, last[p].value);
      if (f === null) return;
      if (f) parts.push(f);
    }
    const transforms = rule.nodes.filter((n) => n.type === 'decl' && n.prop.toLowerCase() === 'transform');
    const existing = transforms.length ? transforms[transforms.length - 1].value.trim() : '';
    const tail = existing && existing.toLowerCase() !== 'none' ? existing : '';
    const value = [...parts, tail].filter(Boolean).join(' ') || 'none';
    const before = decls.map((d) => `${d.prop}: ${d.value}`).join('; ');
    for (const t of transforms) t.remove();
    decls[decls.length - 1].after(postcss.decl({ prop: 'transform', value, raws: { before: decls[decls.length - 1].raws.before } }));
    for (const d of decls) d.remove();
    ctx.report.add(rule, { transform: 'individual-transforms', action: 'converted', feature: 'property:translate/rotate/scale', before, after: `transform: ${value}`, reason: 'approximation: assumes no other rule sets a transform on the same element' });
  });
}
