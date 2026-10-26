// Fluid min()/max()/clamp() with viewport units, rewritten as media queries.
//
// `font-size: clamp(16px, 4vw, 32px)` is a piecewise-linear function of the
// viewport width: 16px below 400px, 4vw up to 800px, 32px above. That is
// exactly expressible with min-width media queries, which Gameface supports:
//
//   .a { font-size: 16px }
//   @media (min-width: 400px) { .a { font-size: 4vw } }
//   @media (min-width: 800px) { .a { font-size: 32px } }
//
// The new rules are inserted directly after the original rule with the same
// selector, so their place in the cascade is the original declaration's place.

import { AtRule } from 'postcss';
import valueParser from 'postcss-value-parser';
import { isFunctionUnsupported } from '../features.js';
import { NotFoldable, evaluateNodes, formatNumber } from '../math.js';
import { isInsideKeyframes } from '../analysis.js';
import { hasPreprocessorSyntax } from '../util.js';
import { unitsFor } from './values.js';

/** @typedef {import('../engine.js').Context} Context */

const FLUID_FUNCTIONS = new Set(['min', 'max', 'clamp']);

/**
 * A linear function of the viewport size v (px): a + k*v.
 * @typedef {{ a: number, k: number }} Linear
 * A piecewise-linear function: segments start at x0 and run to the next x0.
 * @typedef {Array<{ x0: number, f: Linear }>} Piecewise
 */

/** @param {Linear} f @param {number} v */
const at = (f, v) => f.a + f.k * v;

/**
 * @param {Piecewise} pw
 * @param {number} v
 */
function evalPw(pw, v) {
  let seg = pw[0];
  for (const s of pw) if (s.x0 <= v) seg = s;
  return seg.f;
}

/**
 * Combines piecewise functions point-wise with min or max.
 * @param {Piecewise[]} parts
 * @param {'min' | 'max'} op
 * @returns {Piecewise}
 */
function combine(parts, op) {
  // candidate breakpoints: every existing breakpoint plus every crossing of any two pieces
  const xs = new Set([0]);
  for (const p of parts) for (const s of p) xs.add(s.x0);
  const sorted = () => [...xs].sort((a, b) => a - b);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      for (const si of parts[i]) {
        for (const sj of parts[j]) {
          const dk = si.f.k - sj.f.k;
          if (dk === 0) continue;
          const x = (sj.f.a - si.f.a) / dk;
          if (x > 0 && Number.isFinite(x)) xs.add(x);
        }
      }
    }
  }
  const points = sorted();
  /** @type {Piecewise} */
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const x0 = points[i];
    const x1 = points[i + 1] ?? x0 + 1000;
    const mid = (x0 + x1) / 2;
    let best = null;
    for (const p of parts) {
      const f = evalPw(p, mid);
      if (best === null || (op === 'min' ? at(f, mid) < at(best, mid) : at(f, mid) > at(best, mid))) best = f;
    }
    out.push({ x0, f: best });
  }
  return simplify(out);
}

/** @param {Piecewise} pw */
function simplify(pw) {
  const out = [];
  for (const s of pw) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.f.a - s.f.a) < 1e-9 && Math.abs(last.f.k - s.f.k) < 1e-12) continue;
    out.push(s);
  }
  return out;
}

/**
 * Evaluates a node list to a piecewise function of the viewport, or throws.
 * @param {import('postcss-value-parser').Node[]} nodes
 * @param {string} vUnit 'vw' or 'vh'
 * @param {object} mathOpts
 * @returns {Piecewise}
 */
function piecewise(nodes, vUnit, mathOpts) {
  const meaningful = nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
  if (meaningful.length === 1 && meaningful[0].type === 'function' && FLUID_FUNCTIONS.has(meaningful[0].value.toLowerCase())) {
    const fn = meaningful[0];
    const args = splitComma(fn.nodes).map((a) => piecewise(a, vUnit, mathOpts));
    const name = fn.value.toLowerCase();
    if (name === 'min') return combine(args, 'min');
    if (name === 'max') return combine(args, 'max');
    if (args.length !== 3) throw new NotFoldable('clamp takes three arguments');
    return combine([args[0], combine([args[1], args[2]], 'min')], 'max');
  }
  if (meaningful.length === 1 && meaningful[0].type === 'function' && meaningful[0].value.toLowerCase() === 'calc') {
    return piecewise(meaningful[0].nodes, vUnit, mathOpts);
  }
  // otherwise it must be a linear expression in px and the viewport unit
  for (const n of meaningful) {
    if (n.type === 'function' && FLUID_FUNCTIONS.has(n.value.toLowerCase())) throw new NotFoldable('min/max inside arithmetic');
  }
  const sum = evaluateNodes(meaningful, mathOpts);
  let a = 0;
  let k = 0;
  for (const [u, c] of sum) {
    if (u === 'px') a += c;
    else if (u === vUnit) k += c / 100;
    else throw new NotFoldable(`unit ${u || 'number'} is not px or ${vUnit}`);
  }
  return [{ x0: 0, f: { a, k } }];
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

/** @param {Linear} f @param {string} vUnit */
function render(f, vUnit) {
  const a = Math.abs(f.a) < 1e-9 ? 0 : f.a;
  const b = Math.abs(f.k) < 1e-12 ? 0 : f.k * 100;
  if (b === 0) return `${formatNumber(a)}px`;
  if (a === 0) return `${formatNumber(b)}${vUnit}`;
  return `calc(${formatNumber(b)}${vUnit} ${a < 0 ? '-' : '+'} ${formatNumber(Math.abs(a))}px)`;
}

/**
 * A parent where inserting a sibling @media rule keeps the cascade position.
 * @param {import('postcss').Container | undefined} parent
 */
function insertableParent(parent) {
  let p = parent;
  while (p && p.type !== 'root') {
    if (p.type !== 'atrule' || p.name.toLowerCase() !== 'layer') return false;
    p = p.parent;
  }
  return true;
}

/**
 * The property "family", used to make sure no later declaration in the rule
 * interacts with the one being moved into media queries.
 * @param {string} prop
 */
function family(prop) {
  const p = prop.toLowerCase();
  if (p.startsWith('--')) return p;
  return p.split('-')[0];
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function fluidMath(ctx, root) {
  const targets = [];
  root.walkDecls((decl) => {
    if (hasPreprocessorSyntax(decl.value)) return;
    if (!/\b(min|max|clamp)\(/i.test(decl.value)) return;
    targets.push(decl);
  });

  for (const decl of targets) {
    const rule = decl.parent;
    const parsed = valueParser(decl.value);
    const fns = [];
    valueParser.walk(parsed.nodes, (n) => {
      if (n.type === 'function' && FLUID_FUNCTIONS.has(n.value.toLowerCase()) && isFunctionUnsupported(ctx.features, n.value)) {
        fns.push(n);
        return false; // nested ones are part of this one
      }
      return undefined;
    });
    if (fns.length === 0) continue;
    const text = decl.value;
    const kept = (reason) => {
      for (const fn of fns) ctx.report.add(decl, { transform: 'fluid-math', action: 'kept', feature: `function:${fn.value.toLowerCase()}`, before: text, reason });
    };

    const vUnit = /vh\b/i.test(text) && !/vw\b/i.test(text) ? 'vh' : 'vw';
    if (/(vw|vh)\b/i.test(text) && /vw\b/i.test(text) && /vh\b/i.test(text)) { kept('mixes vw and vh'); continue; }
    if (!/(vw|vh)\b/i.test(text)) { kept('arguments mix units that are only known at layout time'); continue; }
    if (isInsideKeyframes(decl)) { kept('media queries cannot be used inside @keyframes'); continue; }
    if (!rule || rule.type !== 'rule' || !insertableParent(rule.parent)) { kept('the rule is inside a conditional block or nested'); continue; }

    const mathOpts = unitsFor(ctx);
    let pws;
    try {
      pws = fns.map((fn) => piecewise([fn], vUnit, mathOpts));
    } catch (err) {
      if (!(err instanceof NotFoldable)) throw err;
      kept(err.message);
      continue;
    }

    // later declarations in the same rule that could interact with this one
    const after = [];
    let seen = false;
    rule.each((n) => {
      if (n === decl) seen = true;
      else if (seen && n.type === 'decl' && family(n.prop) === family(decl.prop)) after.push(n);
    });
    if (after.length > 0) { kept('a later declaration in the same rule sets a related property'); continue; }

    const breakpoints = [...new Set(pws.flatMap((pw) => pw.map((s) => s.x0)))].sort((a, b) => a - b);
    if (breakpoints.length > 12) { kept('too many breakpoints'); continue; }

    const valueAt = (x) => {
      const p = valueParser(text);
      let i = 0;
      valueParser.walk(p.nodes, (n) => {
        if (n.type === 'function' && fns[i] && n.value === fns[i].value && valueParser.stringify(n) === valueParser.stringify(fns[i])) {
          const f = evalPw(pws[i], x);
          /** @type {any} */ (n).type = 'word';
          /** @type {any} */ (n).value = render(f, vUnit);
          delete /** @type {any} */ (n).nodes;
          i++;
          return false;
        }
        return undefined;
      });
      return p.toString();
    };

    const base = valueAt(0);
    decl.value = base;
    let anchor = rule;
    const created = [];
    for (const x of breakpoints.slice(1)) {
      const mediaRule = rule.clone();
      mediaRule.removeAll();
      const d = decl.clone({ value: valueAt(x) });
      d.raws.before = ' ';
      mediaRule.append(d);
      mediaRule.raws.before = '\n  ';
      mediaRule.raws.between = ' ';
      mediaRule.raws.after = ' ';
      mediaRule.raws.semicolon = true;
      const atNode = new AtRule({ name: 'media', params: `(${vUnit === 'vh' ? 'min-height' : 'min-width'}: ${formatNumber(x)}px)` });
      atNode.raws.before = '\n';
      atNode.raws.between = ' ';
      atNode.raws.afterName = ' ';
      atNode.raws.after = '\n';
      atNode.append(mediaRule);
      anchor.after(atNode);
      anchor = atNode;
      created.push(`@media ${atNode.params} { ${mediaRule.selector} { ${d.prop}: ${d.value} } }`);
    }
    for (const fn of fns) {
      ctx.report.add(decl, {
        transform: 'fluid-math',
        action: 'converted',
        feature: `function:${fn.value.toLowerCase()}`,
        before: text,
        after: [`${decl.prop}: ${base}`, ...created].join(' '),
        reason: 'piecewise-linear in the viewport; expressed with min-width media queries',
      });
    }
  }
}

/** Exposed for tests. */
export const _internal = { piecewise, combine, render };
