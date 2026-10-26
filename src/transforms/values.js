// Value-level rewrites: each one replaces part of a declaration value with an
// exact equivalent that Gameface can parse. A rewrite only runs when the target
// Gameface version rejects the original feature.

import valueParser from 'postcss-value-parser';
import { COLOR_FUNCTIONS, NotConvertible, convertColor } from '../colors.js';
import { isGradient, isNonLegacyColorFunction, resampleGradient } from '../gradients.js';
import { isFunctionUnsupported, isKeywordRejected, isMarkerRejected } from '../features.js';
import { MATH_FUNCTIONS, NotFoldable, evaluateFunction, formatNumber, formatSingle, single } from '../math.js';
import { isInsideKeyframes } from '../analysis.js';
import { hasPreprocessorSyntax, replaceNode, topLevel, walkFunctionsBottomUp } from '../util.js';

/** @typedef {import('../engine.js').Context} Context */

const ENV_ZERO = /^(safe-area-inset|safe-area-max-inset|keyboard-inset)-(top|right|bottom|left|width|height)$/;

/** Math functions Gameface may reject; calc() itself is supported. */
const FOLDABLE = new Set([...MATH_FUNCTIONS].filter((f) => f !== 'calc'));

/**
 * Runs every value-level rewrite on a declaration.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 */
export function transformValue(ctx, decl) {
  if (hasPreprocessorSyntax(decl.value)) return;
  const prop = decl.prop.toLowerCase();
  const before = decl.value;
  const parsed = valueParser(decl.value);
  const inKeyframes = isInsideKeyframes(decl);

  if (ctx.options.mode === 'gameface' && ctx.enabled('env')) envFunctions(ctx, decl, parsed);
  if (ctx.enabled('gradient-stops')) gradientStops(ctx, decl, parsed);
  const skip = new Set();
  if (ctx.enabled('color-functions')) gradientColors(ctx, decl, parsed, skip);
  if (ctx.enabled('color-functions')) colorFunctions(ctx, decl, parsed, prop, skip);
  if (ctx.enabled('math-functions')) mathFunctions(ctx, decl, parsed, inKeyframes);
  if (ctx.enabled('transform-functions')) transformFunctions(ctx, decl, parsed, inKeyframes);
  if (ctx.enabled('basic-shapes')) basicShapes(ctx, decl, parsed);
  if (ctx.enabled('timing-functions')) timingFunctions(ctx, decl, parsed, prop);
  if (ctx.enabled('var-fallback')) varFallbacks(ctx, decl, parsed, inKeyframes);

  const value = parsed.toString();
  if (value !== before) decl.value = value;

  if (ctx.enabled('keywords')) keywords(ctx, decl, prop);
}

/**
 * env(): Gameface has no environment variables. A game view is a plain rectangle,
 * so the inset variables are 0, exactly as in a desktop browser. Other variables
 * are undefined outside special browser modes, so the fallback applies.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 */
function envFunctions(ctx, decl, parsed) {
  if (!isFunctionUnsupported(ctx.features, 'env')) return;
  walkFunctionsBottomUp(parsed, (fn) => {
    if (fn.value.toLowerCase() !== 'env') return;
    const text = valueParser.stringify(fn);
    const args = splitComma(fn.nodes);
    const name = args[0].filter((n) => n.type === 'word').map((n) => n.value)[0]?.toLowerCase() ?? '';
    let replacement = null;
    if (ENV_ZERO.test(name)) replacement = '0px';
    else if (args.length > 1) replacement = valueParser.stringify(args.slice(1).flatMap((a, i) => (i ? [{ type: 'div', value: ',', before: '', after: ' ' }, ...a] : a))).trim();
    if (replacement === null) return;
    replaceNode(fn, replacement);
    ctx.report.add(decl, { transform: 'env', action: 'converted', feature: 'function:env', before: text, after: replacement });
  });
}

/**
 * Gradients with a non-legacy colour interpolate in Oklab; resample them so the
 * rgb() version paints the same.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {Set<object>} skip colour nodes colorFunctions must leave alone
 */
function gradientColors(ctx, decl, parsed, skip) {
  /** @param {import('postcss-value-parser').Node[]} nodes */
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.type !== 'function') continue;
      if (!isGradient(n.value)) { visit(n.nodes); continue; }
      let needs = false;
      let nonLegacy = false;
      valueParser.walk(n.nodes, (c) => {
        if (c.type !== 'function') return;
        const name = c.value.toLowerCase();
        if (COLOR_FUNCTIONS.has(name) && isFunctionUnsupported(ctx.features, name)) needs = true;
        if (isNonLegacyColorFunction(name)) nonLegacy = true;
      });
      if (!needs || !nonLegacy) continue; // legacy-only gradients interpolate in sRGB already
      const text = valueParser.stringify(n);
      try {
        const out = resampleGradient(n);
        replaceNode(n, out);
        ctx.report.add(decl, { transform: 'color-functions', action: 'converted', feature: 'function:gradient-oklab', before: text, after: out, reason: 'gradient with Oklab interpolation resampled into rgb() stops (within 1/4 of an 8-bit step)' });
      } catch (err) {
        if (!(err instanceof NotConvertible)) throw err;
        valueParser.walk(n.nodes, (c) => { if (c.type === 'function') skip.add(c); });
        ctx.report.add(decl, { transform: 'color-functions', action: 'kept', feature: 'function:gradient-oklab', before: text, reason: `gradient interpolates in Oklab and could not be resampled: ${err.message}` });
      }
    }
  };
  visit(parsed.nodes);
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {string} prop
 * @param {Set<object>} skip
 */
function colorFunctions(ctx, decl, parsed, prop, skip) {
  const source = ctx.options.mode === 'source';
  // Transitions and animations interpolate non-legacy colours in Oklab and legacy ones in sRGB.
  const animated = !ctx.analysis.complete || ctx.analysis.allAnimated || ctx.analysis.animatedProperties.has(prop) || isInsideKeyframes(decl);
  walkFunctionsBottomUp(parsed, (fn) => {
    const name = fn.value.toLowerCase();
    if (!COLOR_FUNCTIONS.has(name) || skip.has(fn)) return;
    if (source && isNonLegacyColorFunction(name) && (animated || prop.startsWith('--'))) {
      if (isFunctionUnsupported(ctx.features, name) || containsUnsupportedColor(ctx, fn)) {
        ctx.report.add(decl, { transform: 'color-functions', action: 'kept', feature: `function:${name}`, before: valueParser.stringify(fn), reason: prop.startsWith('--') ? 'a variable may be used in a gradient or transition, where rgb() interpolates differently' : 'this property can be animated; rgb() interpolates in sRGB instead of Oklab' });
      }
      return;
    }
    // color-mix() is evaluated as a whole, including inner colour functions
    if (!isFunctionUnsupported(ctx.features, name) && !containsUnsupportedColor(ctx, fn)) return;
    const text = valueParser.stringify(fn);
    try {
      const { value, gamutMapped } = convertColor(text, { allowGamutMapping: ctx.options.mode === 'gameface' });
      replaceNode(fn, value);
      ctx.report.add(decl, {
        transform: 'color-functions',
        action: 'converted',
        feature: `function:${name}`,
        before: text,
        after: value,
        reason: gamutMapped ? 'outside sRGB; mapped into sRGB with the CSS Color 4 gamut-mapping algorithm' : undefined,
      });
    } catch (err) {
      if (!(err instanceof NotConvertible)) throw err;
      ctx.report.add(decl, { transform: 'color-functions', action: 'kept', feature: `function:${name}`, before: text, reason: err.message });
    }
  });
}

/** @param {Context} ctx @param {import('postcss-value-parser').FunctionNode} fn */
function containsUnsupportedColor(ctx, fn) {
  let found = false;
  valueParser.walk(fn.nodes, (n) => {
    if (n.type === 'function' && COLOR_FUNCTIONS.has(n.value.toLowerCase()) && isFunctionUnsupported(ctx.features, n.value)) found = true;
  });
  return found;
}

/**
 * Folds math functions Gameface rejects (min, max, clamp, round, …) when every
 * argument has the same unit. Mixed viewport/px arguments are handled later by
 * the fluid rewrite, which needs the surrounding rule.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {boolean} inKeyframes
 */
function mathFunctions(ctx, decl, parsed, inKeyframes) {
  const calcBanned = inKeyframes; // Gameface rejects calc() inside @keyframes
  walkFunctionsBottomUp(parsed, (fn) => {
    const name = fn.value.toLowerCase();
    const isCalc = name === 'calc';
    if (!(FOLDABLE.has(name) && isFunctionUnsupported(ctx.features, name)) && !(isCalc && calcBanned)) return;
    const text = valueParser.stringify(fn);
    try {
      const result = evaluateFunction(fn, unitsFor(ctx));
      const one = single(result);
      if (!one) throw new NotFoldable('arguments mix units');
      if (!Number.isFinite(one[1])) throw new NotFoldable('result is not finite');
      const out = formatSingle(result);
      replaceNode(fn, out);
      ctx.report.add(decl, { transform: 'math-functions', action: 'converted', feature: isCalc ? 'restriction:calc-in-keyframes' : `function:${name}`, before: text, after: out });
    } catch (err) {
      if (!(err instanceof NotFoldable)) throw err;
      // The fluid rewrite may still handle it; it reports its own outcome.
    }
  });
}

/** @param {Context} ctx */
export function unitsFor(ctx) {
  // rem only becomes px when the root font size is known; otherwise it stays its own unit
  return { rem: ctx.options.rootFontSize ?? (ctx.analysis.complete ? ctx.analysis.rootFontSize : null) };
}

/**
 * skew() and perspective() as exact equivalents.
 *   skew(a)      -> skewX(a)          (same interpolation primitive)
 *   skew(0, b)   -> skewY(b)
 *   skew(a, b)   -> matrix(…)         (only when transform is never interpolated)
 *   perspective(d) -> matrix3d(…)     (same condition)
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {boolean} inKeyframes
 */
function transformFunctions(ctx, decl, parsed, inKeyframes) {
  const staticOk = ctx.analysis.complete && !ctx.analysis.transformAnimated && !inKeyframes;
  walkFunctionsBottomUp(parsed, (fn) => {
    const name = fn.value.toLowerCase();
    if (name !== 'skew' && name !== 'perspective') return;
    if (!isFunctionUnsupported(ctx.features, name)) return;
    const text = valueParser.stringify(fn);
    const args = splitComma(fn.nodes).map((a) => valueParser.stringify(a).trim());
    let out = null;
    let reason = null;
    try {
      if (name === 'skew') {
        const ax = angleDeg(args[0]);
        const ay = args[1] !== undefined ? angleDeg(args[1]) : 0;
        if (ay === 0) out = `skewX(${args[0]})`;
        else if (ax === 0) out = `skewY(${args[1]})`;
        else if (staticOk) {
          const m = [1, Math.tan((ay * Math.PI) / 180), Math.tan((ax * Math.PI) / 180), 1, 0, 0].map(formatNumber);
          out = `matrix(${m.join(', ')})`;
        } else reason = ctx.analysis.complete ? 'transform is animated or transitioned; a matrix would interpolate differently' : 'needs the whole stylesheet to know transform is never animated';
      } else {
        const arg = args[0].toLowerCase();
        if (!staticOk) reason = ctx.analysis.complete ? 'transform is animated or transitioned; a matrix would interpolate differently' : 'needs the whole stylesheet to know transform is never animated';
        else if (arg === 'none') out = 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)';
        else {
          const parsedArg = valueParser.unit(arg);
          const factor = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 }[parsedArg?.unit ?? ''];
          if (!parsedArg || factor === undefined) reason = 'perspective length is relative';
          else {
            const d = Math.max(1, Number(parsedArg.number) * factor);
            out = `matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, ${formatNumber(-1 / d)}, 0, 0, 0, 1)`;
          }
        }
      }
    } catch (err) {
      if (!(err instanceof NotFoldable)) throw err;
      reason = err.message;
    }
    if (out) {
      replaceNode(fn, out);
      ctx.report.add(decl, { transform: 'transform-functions', action: 'converted', feature: `function:${name}`, before: text, after: out });
    } else {
      ctx.report.add(decl, { transform: 'transform-functions', action: 'kept', feature: `function:${name}`, before: text, reason });
    }
  });
}

/** @param {string} text */
function angleDeg(text) {
  const p = valueParser.unit(text);
  if (!p) throw new NotFoldable(`not an angle: ${text}`);
  const n = Number(p.number);
  const u = p.unit.toLowerCase();
  if (u === '' && n === 0) return 0;
  const f = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 }[u];
  if (f === undefined) throw new NotFoldable(`not an angle: ${text}`);
  return n * f;
}

/**
 * rect() and xywh() as the inset() they are defined to equal.
 * Only when no calc() mixing % and lengths is needed (Gameface rejects that).
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 */
function basicShapes(ctx, decl, parsed) {
  walkFunctionsBottomUp(parsed, (fn) => {
    const name = fn.value.toLowerCase();
    if (name !== 'rect' && name !== 'xywh') return;
    if (!isFunctionUnsupported(ctx.features, name)) return;
    const text = valueParser.stringify(fn);
    const words = fn.nodes.filter((n) => n.type !== 'space' && n.type !== 'comment').map((n) => valueParser.stringify(n));
    const roundAt = words.findIndex((w) => w.toLowerCase() === 'round');
    const main = roundAt === -1 ? words : words.slice(0, roundAt);
    const round = roundAt === -1 ? '' : ' ' + words.slice(roundAt).join(' ');
    let out = null;
    let reason = 'needs calc() mixing % and lengths, which Gameface rejects';
    if (name === 'rect' && main.length === 4) {
      const [t, r, b, l] = main;
      const inset = [edge(t), farEdge(r), farEdge(b), edge(l)];
      if (inset.every((v) => v !== null)) out = `inset(${inset.join(' ')}${round})`;
    } else if (name === 'xywh' && main.length === 4) {
      const [x, y, w, h] = main;
      const right = remaining(x, w);
      const bottom = remaining(y, h);
      if (right !== null && bottom !== null && edge(x) !== null && edge(y) !== null) out = `inset(${edge(y)} ${right} ${bottom} ${edge(x)}${round})`;
    } else {
      reason = 'unexpected arguments';
    }
    if (out) {
      replaceNode(fn, out);
      ctx.report.add(decl, { transform: 'basic-shapes', action: 'converted', feature: `function:${name}`, before: text, after: out });
    } else {
      ctx.report.add(decl, { transform: 'basic-shapes', action: 'kept', feature: `function:${name}`, before: text, reason });
    }
  });
}

/** A near edge (top/left): `auto` means 0. */
function edge(v) {
  if (v.toLowerCase() === 'auto') return '0';
  return /^[+-]?[\d.]+(e[+-]?\d+)?([a-z%]*)$/i.test(v) ? v : null;
}

/** A far edge (right/bottom) as an inset from that side: 100% - v. */
function farEdge(v) {
  if (v.toLowerCase() === 'auto') return '0';
  const p = valueParser.unit(v);
  if (!p) return null;
  const n = Number(p.number);
  if (p.unit === '%') return formatNumber(100 - n) + '%';
  if (n === 0 && p.unit === '') return '100%';
  return null;
}

/** 100% - a - b, when both are percentages (or zero). */
function remaining(a, b) {
  const pa = valueParser.unit(a);
  const pb = valueParser.unit(b);
  if (!pa || !pb) return null;
  const pct = (p) => (p.unit === '%' ? Number(p.number) : Number(p.number) === 0 && p.unit === '' ? 0 : null);
  const na = pct(pa);
  const nb = pct(pb);
  if (na === null || nb === null) return null;
  return formatNumber(100 - na - nb) + '%';
}

/**
 * steps(n, jump-start) and steps(n, jump-end) are defined to equal
 * steps(n, start) and steps(n, end).
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {string} prop
 */
function timingFunctions(ctx, decl, parsed, prop) {
  const longhand = prop.startsWith('animation') ? 'animation-timing-function' : prop.startsWith('transition') ? 'transition-timing-function' : null;
  if (!longhand || !isMarkerRejected(ctx.features, longhand, 'jump')) return;
  walkFunctionsBottomUp(parsed, (fn) => {
    if (fn.value.toLowerCase() !== 'steps') return;
    for (const n of fn.nodes) {
      if (n.type !== 'word') continue;
      const v = n.value.toLowerCase();
      if (v === 'jump-start' || v === 'jump-end') {
        const after = v === 'jump-start' ? 'start' : 'end';
        ctx.report.add(decl, { transform: 'timing-functions', action: 'converted', feature: `value:${longhand}:jump`, before: n.value, after });
        n.value = after;
      } else if (v === 'jump-none' || v === 'jump-both') {
        ctx.report.add(decl, { transform: 'timing-functions', action: 'kept', feature: `value:${longhand}:jump`, before: n.value, reason: 'no start/end equivalent' });
      }
    }
  });
}

/**
 * A colour stop with two positions (`red 0 10px`) is defined as two stops
 * (`red 0, red 10px`). Gameface only accepts the single-position form.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 */
function gradientStops(ctx, decl, parsed) {
  if (!doubleStopsRejected(ctx)) return;
  walkFunctionsBottomUp(parsed, (fn) => {
    const name = fn.value.toLowerCase().replace(/^-\w+-/, '');
    if (!/^(repeating-)?(linear|radial|conic)-gradient$/.test(name)) return;
    const args = splitComma(fn.nodes);
    let changed = false;
    const out = [];
    for (const arg of args) {
      const meaningful = arg.filter((n) => n.type !== 'space' && n.type !== 'comment');
      if (meaningful.length === 3 && isPosition(meaningful[1]) && isPosition(meaningful[2]) && !isPosition(meaningful[0])) {
        const color = valueParser.stringify(meaningful[0]);
        out.push(`${color} ${meaningful[1].value}`, `${color} ${meaningful[2].value}`);
        changed = true;
      } else out.push(valueParser.stringify(arg).trim());
    }
    if (!changed) return;
    const before = valueParser.stringify(fn);
    const after = `${fn.value}(${out.join(', ')})`;
    replaceNode(fn, after);
    ctx.report.add(decl, { transform: 'gradient-stops', action: 'converted', feature: 'value:background-image:double-position-stops', before, after, reason: 'a two-position colour stop is defined as two stops' });
  });
}

/** @param {Context} ctx */
function doubleStopsRejected(ctx) {
  const partial = ctx.features.partialProperties.get('background-image');
  if (!partial) return false;
  return [...partial.disallowed].some((v) => /gradient\(/.test(v) && /[a-z)]\s*[\d.]+[a-z%]*\s+[\d.]+[a-z%]+/i.test(v));
}

/** @param {import('postcss-value-parser').Node} n */
function isPosition(n) {
  if (n.type !== 'word') return false;
  const u = valueParser.unit(n.value);
  return Boolean(u) && u.number !== '' && /^(|%|px|em|rem|vw|vh|vmin|vmax|in|pt|pc|cm|mm|q|ex|ch|deg|rad|grad|turn)$/i.test(u.unit);
}

/**
 * var(--x, fallback): Gameface rejects the fallback argument.
 *   - --x always defined on :root -> the fallback can never apply, drop it.
 *   - --x never defined (closed world) -> the fallback always applies, use it.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {boolean} inKeyframes
 */
function varFallbacks(ctx, decl, parsed, inKeyframes) {
  const { analysis, options } = ctx;
  walkFunctionsBottomUp(parsed, (fn) => {
    if (fn.value.toLowerCase() !== 'var') return;
    const args = splitComma(fn.nodes);
    const name = args[0].filter((n) => n.type === 'word').map((n) => n.value)[0];
    if (!name) return;
    const facts = analysis.customProperties.get(name);
    const text = valueParser.stringify(fn);

    if (inKeyframes && options.closedWorld && analysis.complete && facts && facts.declarations === 1 && facts.definedAtRoot && !facts.everInvalid && !/\bvar\(/i.test(facts.values[0]) && !analysis.registered?.has(name)) {
      replaceNode(fn, facts.values[0]);
      ctx.report.add(decl, { transform: 'var-fallback', action: 'converted', feature: 'restriction:var-in-keyframes', before: text, after: facts.values[0] });
      return;
    }

    if (args.length < 2) return;
    const fallback = valueParser.stringify(args.slice(1).flatMap((a, i) => (i ? [{ type: 'div', value: ',', before: '', after: ' ' }, ...a] : a))).trim();

    if (analysis.complete && facts && facts.definedAtRoot && !facts.everInvalid && facts.values.every((v) => !/\bvar\(/i.test(v)) && !analysis.registered?.has(name)) {
      const out = `var(${name})`;
      replaceNode(fn, out);
      ctx.report.add(decl, { transform: 'var-fallback', action: 'converted', feature: 'restriction:var-fallback', before: text, after: out, reason: `${name} is always defined on :root, so the fallback never applies` });
      return;
    }
    if (analysis.complete && options.closedWorld && !facts && !analysis.registered?.has(name)) {
      replaceNode(fn, fallback);
      ctx.report.add(decl, { transform: 'var-fallback', action: 'converted', feature: 'restriction:var-fallback', before: text, after: fallback, reason: `${name} is never defined, so the fallback always applies` });
      return;
    }
    ctx.report.add(decl, {
      transform: 'var-fallback',
      action: 'kept',
      feature: 'restriction:var-fallback',
      before: text,
      reason: !analysis.complete ? 'needs the whole stylesheet to know whether the variable is defined' : !options.closedWorld && !facts ? 'variable is not defined in CSS; it may be set from JS or inline styles (enable closedWorld if not)' : 'variable is not always defined on :root',
    });
  });
}

/**
 * Keyword values Gameface rejects that have an exact supported equivalent.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @param {string} prop
 */
function keywords(ctx, decl, prop) {
  const { features, options } = ctx;
  const value = decl.value.trim();
  const lower = value.toLowerCase();
  /** @param {string} after @param {string} feature @param {string} [reason] */
  const set = (after, feature, reason) => {
    ctx.report.add(decl, { transform: 'keywords', action: 'converted', feature, before: value, after, reason });
    decl.value = after;
  };

  // font-weight: 400 and 700 are by definition `normal` and `bold`
  if (prop === 'font-weight' && isMarkerRejected(features, 'font-weight', 'number')) {
    const n = Number(lower);
    if (lower !== '' && Number.isFinite(n) && /^[\d.]+$/.test(lower)) {
      if (n === 400) return set('normal', 'value:font-weight:number');
      if (n === 700) return set('bold', 'value:font-weight:number');
      if (options.approximations.has('font-weight-nearest')) {
        const near = n < 550 ? 'normal' : 'bold';
        return set(near, 'value:font-weight:number', 'approximation: nearest of normal/bold');
      }
      ctx.report.add(decl, { transform: 'keywords', action: 'kept', feature: 'value:font-weight:number', before: value, reason: 'Gameface only accepts normal/bold/bolder/lighter' });
    }
  }
  if (prop === 'font' && isMarkerRejected(features, 'font-weight', 'number')) {
    const parts = value.split(/\s+/);
    let changed = false;
    for (let i = 0; i < parts.length; i++) {
      // weight comes before the size token; stop at the first size-looking token
      if (/^[\d.]+(px|em|rem|%|pt|vw|vh|ex|ch)|^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)/i.test(parts[i])) break;
      if (parts[i] === '400') { parts[i] = 'normal'; changed = true; }
      else if (parts[i] === '700') { parts[i] = 'bold'; changed = true; }
    }
    if (changed) return set(parts.join(' '), 'value:font-weight:number');
  }

  // In flex layout `normal` behaves as stretch (align-*) or flex-start (justify-content).
  const alignMap = {
    'justify-content': { normal: 'flex-start', stretch: 'flex-start' },
    'align-items': { normal: 'stretch' },
    'align-content': { normal: 'stretch' },
  };
  if (alignMap[prop] && alignMap[prop][lower] && isKeywordRejected(features, prop, lower)) {
    return set(alignMap[prop][lower], `value:${prop}:${lower}`, `in a flex container ${lower} behaves as ${alignMap[prop][lower]}`);
  }
  if (['justify-content', 'align-items', 'align-content', 'align-self'].includes(prop) && (lower === 'start' || lower === 'end') && isKeywordRejected(features, prop, lower)) {
    if (options.approximations.has('flex-start-end-assume-no-reverse')) {
      return set(`flex-${lower}`, `value:${prop}:${lower}`, 'approximation: assumes no row-reverse/column-reverse/wrap-reverse');
    }
    ctx.report.add(decl, { transform: 'keywords', action: 'kept', feature: `value:${prop}:${lower}`, before: value, reason: 'start and flex-start differ in reversed flex containers' });
  }

  // text-align: start/end in a left-to-right page are left/right
  if (prop === 'text-align' && options.ltr) {
    const map = { start: 'left', end: 'right', 'match-parent': 'inherit' };
    if (map[lower] && isKeywordRejected(features, prop, lower)) return set(map[lower], `value:text-align:${lower}`, 'left-to-right text');
  }

  // percentages of text-decoration thickness and underline offset are relative to 1em
  if ((prop === 'text-decoration-thickness' || prop === 'text-underline-offset') && isMarkerRejected(features, prop, 'percentage')) {
    const p = valueParser.unit(lower);
    if (p && p.unit === '%') return set(`${formatNumber(Number(p.number) / 100)}em`, `value:${prop}:percentage`, 'percentages here are relative to 1em');
  }
  if (prop === 'text-decoration' && isMarkerRejected(features, 'text-decoration-thickness', 'percentage')) {
    const parts = value.split(/\s+/);
    let changed = false;
    for (let i = 0; i < parts.length; i++) {
      const p = valueParser.unit(parts[i]);
      if (p && p.unit === '%') { parts[i] = `${formatNumber(Number(p.number) / 100)}em`; changed = true; }
    }
    if (changed) return set(parts.join(' '), 'value:text-decoration-thickness:percentage', 'percentages here are relative to 1em');
  }

  // font-style: oblique 14deg is exactly the default `oblique`
  if (prop === 'font-style' && isMarkerRejected(features, prop, 'oblique-angle')) {
    const m = /^oblique\s+(.+)$/.exec(lower);
    if (m) {
      try {
        if (Math.abs(angleDeg(m[1].trim()) - 14) < 1e-9) return set('oblique', 'value:font-style:oblique-angle');
      } catch (err) {
        if (!(err instanceof NotFoldable)) throw err;
      }
      ctx.report.add(decl, { transform: 'keywords', action: 'kept', feature: 'value:font-style:oblique-angle', before: value, reason: 'only the default 14deg oblique has an equivalent' });
    }
  }

  // max-width/max-height: none -> a limit no layout reaches
  if ((prop === 'max-width' || prop === 'max-height') && lower === 'none' && isKeywordRejected(features, prop, 'none')) {
    return set('9999999px', `value:${prop}:none`, 'larger than any layout; keeps the reset of an earlier max-size');
  }
}

/** @param {import('postcss-value-parser').Node[]} nodes */
function splitComma(nodes) {
  const out = [[]];
  for (const n of nodes) {
    if (n.type === 'div' && n.value === ',') out.push([]);
    else out[out.length - 1].push(n);
  }
  return out;
}

export { topLevel };
