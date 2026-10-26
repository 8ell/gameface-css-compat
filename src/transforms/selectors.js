// Selector rewrites.
//
//   :is(a, b) -> a, b   when every argument is a compound selector and all
//                       arguments have the same specificity (so the cascade
//                       cannot change).
//   :where(…)           same, as an opt-in approximation (raises specificity).
//
// In gameface mode, branches Gameface cannot match are removed from selector
// lists so the supported branches keep working, and rules left with no branch
// are removed.

import selectorParser from 'postcss-selector-parser';
import { svgSupport } from '../features.js';
import { isInsideKeyframes } from '../analysis.js';

/** @typedef {import('../engine.js').Context} Context */

/**
 * Specificity of a (complex) selector as [ids, classes, types].
 * @param {selectorParser.Selector} sel
 * @returns {[number, number, number]}
 */
export function specificity(sel) {
  /** @type {[number, number, number]} */
  const s = [0, 0, 0];
  const addMax = (selectors) => {
    let best = [0, 0, 0];
    for (const x of selectors) {
      const sp = specificity(x);
      if (compare(sp, best) > 0) best = sp;
    }
    s[0] += best[0];
    s[1] += best[1];
    s[2] += best[2];
  };
  for (const n of sel.nodes) {
    switch (n.type) {
      case 'id': s[0] += 1; break;
      case 'class':
      case 'attribute': s[1] += 1; break;
      case 'tag': s[2] += 1; break;
      case 'pseudo': {
        const name = n.value.toLowerCase();
        if (name.startsWith('::') || [':before', ':after', ':first-line', ':first-letter'].includes(name)) { s[2] += 1; break; }
        if (name === ':where') break;
        if ([':is', ':not', ':has', ':matches', ':-webkit-any'].includes(name)) { addMax(n.nodes); break; }
        s[1] += 1;
        if ((name === ':nth-child' || name === ':nth-last-child') && /\sof\s/i.test(n.toString())) {
          const text = n.toString();
          const ofPart = text.slice(text.search(/\sof\s/i) + 4, text.lastIndexOf(')'));
          try {
            addMax(selectorParser().astSync(ofPart).nodes);
          } catch { /* not a selector list */ }
        }
        break;
      }
      default:
        break;
    }
  }
  return s;
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Bare pseudo name: `:has(.a)` -> `:has`.
 * @param {selectorParser.Pseudo} p
 */
function pseudoName(p) {
  return p.value.toLowerCase();
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function unwrapIs(ctx, root) {
  const allowWhere = ctx.options.approximations.has('where-to-is');
  const isUnsupported = ctx.features.unsupportedPseudos.has(':is');
  const whereUnsupported = ctx.features.unsupportedPseudos.has(':where');
  if (!isUnsupported && !(allowWhere && whereUnsupported)) return;

  root.walkRules((rule) => {
    if (isInsideKeyframes(rule) || !/:(is|where)\(/i.test(rule.selector)) return;
    let parsed;
    try {
      parsed = selectorParser().astSync(rule.selector);
    } catch {
      return;
    }
    const out = [];
    let changed = false;
    let failure = null;
    for (const sel of parsed.nodes) {
      const expanded = expandSelector(ctx, sel, { isUnsupported, allowWhere: allowWhere && whereUnsupported });
      if (expanded.failure) failure = expanded.failure;
      if (expanded.changed) changed = true;
      out.push(...expanded.selectors);
    }
    if (failure) {
      ctx.report.add(rule, { transform: 'selector-is', action: 'kept', feature: 'selector::is', before: rule.selector, reason: failure });
    }
    if (!changed) return;
    const before = rule.selector;
    if (out.length === 0) {
      ctx.report.add(rule, { transform: 'selector-is', action: 'removed', feature: 'selector::is', before, reason: 'the selector cannot match any element' });
      rule.remove();
      return;
    }
    rule.selector = out.join(', ');
    ctx.report.add(rule, { transform: 'selector-is', action: 'converted', feature: 'selector::is', before, after: rule.selector });
  });
}

/**
 * @param {Context} ctx
 * @param {selectorParser.Selector} sel
 * @param {{ isUnsupported: boolean, allowWhere: boolean }} opts
 * @returns {{ selectors: string[], changed: boolean, failure?: string }}
 */
function expandSelector(ctx, sel, opts) {
  const nodes = sel.nodes;
  const idx = nodes.findIndex((p) => p.type === 'pseudo' && ((pseudoName(p) === ':is' && opts.isUnsupported) || (pseudoName(p) === ':where' && opts.allowWhere)));
  const unchanged = (failure) => ({ selectors: [sel.toString().trim()], changed: false, failure });
  if (idx === -1) {
    let nested = false;
    sel.walkPseudos((p) => { if ([':is', ':where'].includes(pseudoName(p)) && p.parent !== sel) nested = true; });
    return unchanged(nested ? 'nested inside another pseudo-class' : undefined);
  }
  const target = nodes[idx];
  const args = target.nodes;
  for (const arg of args) {
    let bad = null;
    for (const n of arg.nodes) {
      if (n.type === 'combinator') bad = 'an argument has a combinator';
      else if (n.type === 'nesting') bad = 'nesting selector';
      else if (n.type === 'pseudo') {
        const name = pseudoName(n);
        if (name.startsWith('::')) bad = 'pseudo-element inside :is()';
        else if (!ctx.features.knownPseudos.has(name) && !STANDARD_PSEUDOS.has(name)) bad = `unknown pseudo ${name}`;
      }
    }
    if (bad) return unchanged(bad);
  }
  if (pseudoName(target) === ':is') {
    const sp = args.map((a) => specificity(a));
    if (!sp.every((x) => compare(x, sp[0]) === 0)) return unchanged('arguments have different specificity; expanding would change the cascade');
  }

  let start = idx;
  while (start > 0 && nodes[start - 1].type !== 'combinator') start--;
  let end = idx;
  while (end < nodes.length - 1 && nodes[end + 1].type !== 'combinator') end++;

  const results = [];
  for (const arg of args) {
    const compound = [...nodes.slice(start, idx), ...arg.nodes, ...nodes.slice(idx + 1, end + 1)];
    const tags = compound.filter((n) => n.type === 'tag' || n.type === 'universal');
    const named = tags.filter((n) => n.type === 'tag');
    if (new Set(named.map((n) => n.value.toLowerCase())).size > 1) continue; // can never match
    const lead = named[0] ?? tags[0];
    const elements = compound.filter((n) => n.type === 'pseudo' && pseudoName(n).startsWith('::'));
    const middle = compound.filter((n) => !tags.includes(n) && !elements.includes(n));
    const rebuilt = selectorParser.selector({ value: '' });
    for (const n of nodes.slice(0, start)) rebuilt.append(n.clone());
    for (const n of [...(lead ? [lead] : []), ...middle, ...elements]) {
      const c = n.clone();
      c.spaces = { before: '', after: '' };
      rebuilt.append(c);
    }
    for (const n of nodes.slice(end + 1)) rebuilt.append(n.clone());
    results.push(rebuilt);
  }
  const final = [];
  let failure;
  for (const r of results) {
    const again = expandSelector(ctx, r, opts);
    if (again.failure) failure = again.failure;
    final.push(...again.selectors);
  }
  return { selectors: final, changed: true, failure };
}

/** Standard pseudo-classes that are always safe to place in a selector list. */
const STANDARD_PSEUDOS = new Set([
  ':hover', ':active', ':focus', ':focus-visible', ':focus-within', ':first-child', ':last-child', ':only-child',
  ':nth-child', ':nth-last-child', ':nth-of-type', ':nth-last-of-type', ':first-of-type', ':last-of-type', ':only-of-type',
  ':root', ':empty', ':checked', ':disabled', ':enabled', ':visited', ':link', ':target', ':not', ':is', ':where', ':has',
]);

/**
 * Gameface mode: drop selector branches Gameface cannot match.
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function pruneSelectors(ctx, root) {
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule)) return;
    let parsed;
    try {
      parsed = selectorParser().astSync(rule.selector);
    } catch {
      return;
    }
    const keep = [];
    for (const sel of parsed.nodes) {
      const problem = unsupportedIn(ctx, sel);
      if (problem) {
        ctx.report.add(rule, { transform: 'prune', action: 'removed', feature: `selector:${problem}`, before: sel.toString().trim(), reason: `Gameface does not support ${problem}` });
      } else keep.push(sel.toString().trim());
    }
    if (keep.length === parsed.nodes.length) {
      selectionDeclarations(ctx, rule);
      return;
    }
    if (keep.length === 0) {
      rule.remove();
      return;
    }
    rule.selector = keep.join(', ');
    selectionDeclarations(ctx, rule);
  });
}

/**
 * @param {Context} ctx
 * @param {selectorParser.Selector} sel
 * @returns {string | null}
 */
function unsupportedIn(ctx, sel) {
  let problem = null;
  sel.walkPseudos((p) => {
    if (problem) return;
    const name = pseudoName(p);
    if (ctx.features.unsupportedPseudos.has(name)) problem = name;
    else if ((name === ':nth-child' || name === ':nth-last-child') && /\sof\s/i.test(p.toString())) problem = `${name}(… of …)`;
  });
  return problem;
}

/**
 * ::selection only honours color and background-color in Gameface.
 * @param {Context} ctx
 * @param {import('postcss').Rule} rule
 */
function selectionDeclarations(ctx, rule) {
  if (!/::selection/i.test(rule.selector) || !ctx.features.partialSelectors.has('::selection')) return;
  rule.each((n) => {
    if (n.type !== 'decl') return;
    const p = n.prop.toLowerCase();
    if (p === 'color' || p === 'background-color' || p.startsWith('--')) return;
    ctx.report.add(n, { transform: 'prune', action: 'removed', feature: 'selector:::selection', before: `${n.prop}: ${n.value}`, reason: '::selection only honours color and background-color in Gameface' });
    n.remove();
  });
}

/**
 * Gameface mode: stroke-dasharray/stroke-dashoffset only work on <path>.
 * Selector lists that mix path and other shapes are split so the path branch keeps them.
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function pruneSvgDash(ctx, root) {
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule)) return;
    const dashDecls = rule.nodes?.filter((n) => n.type === 'decl' && svgSupport.pathOnlyProperties.has(n.prop.toLowerCase())) ?? [];
    if (dashDecls.length === 0 || !svgSupport.targetsNonPathShape(rule.selector)) return;
    const branches = rule.selectors;
    const pathBranches = branches.filter((b) => !svgSupport.targetsNonPathShape(b));
    const otherBranches = branches.filter((b) => svgSupport.targetsNonPathShape(b));
    if (pathBranches.length > 0) {
      const pathRule = rule.clone({ selector: pathBranches.join(', ') });
      rule.before(pathRule);
      rule.selector = otherBranches.join(', ');
    }
    for (const d of rule.nodes.filter((n) => n.type === 'decl' && svgSupport.pathOnlyProperties.has(n.prop.toLowerCase()))) {
      ctx.report.add(d, { transform: 'prune', action: 'removed', feature: `restriction:${d.prop.toLowerCase()}-non-path`, before: `${rule.selector} { ${d.prop}: ${d.value} }`, reason: 'Gameface only applies stroke dashes to <path>' });
      d.remove();
    }
    if (rule.nodes.length === 0) rule.remove();
  });
}
