// At-rule rewrites for gameface mode.
//
//   @media: Gameface always renders as `screen` and does not support media
//     types, so types are resolved statically (screen/all match, others don't).
//   @supports: Gameface does not support it, so the condition is evaluated
//     against Gameface's own feature data and the block is kept or dropped,
//     exactly as an engine with that feature set would.

import valueParser from 'postcss-value-parser';
import selectorParser from 'postcss-selector-parser';
import { isFunctionUnsupported, isKeywordRejected, isPropertyUnsupported } from '../features.js';

/** @typedef {import('../engine.js').Context} Context */

const MATCHING_TYPES = new Set(['screen', 'all']);
const KNOWN_TYPES = new Set(['all', 'screen', 'print', 'speech', 'tty', 'tv', 'projection', 'handheld', 'braille', 'embossed', 'aural']);

/**
 * Resolves the media type of one media query.
 * @param {string} query
 * @returns {{ result: 'true' | 'false' | 'rest', rest?: string } | null} null: leave unchanged
 */
function resolveQuery(query) {
  const q = query.trim();
  const m = /^(?:(only|not)\s+)?([a-z-]+)(?:\s+and\s+([\s\S]+))?$/i.exec(q);
  if (!m) return null; // starts with a condition, nothing to resolve
  const [, modifier, type, conditions] = m;
  const t = type.toLowerCase();
  if (!KNOWN_TYPES.has(t)) return null;
  const matches = MATCHING_TYPES.has(t);
  const negated = modifier && modifier.toLowerCase() === 'not';
  if (!negated) {
    if (!matches) return { result: 'false' };
    return conditions ? { result: 'rest', rest: conditions.trim() } : { result: 'true' };
  }
  // `not T and C` negates the whole query
  if (!matches) return { result: 'true' };
  if (!conditions) return { result: 'false' };
  return null; // `not screen and (cond)` needs `not (cond)`; leave it
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function resolveMediaTypes(ctx, root) {
  // @page only applies when printing
  root.walkAtRules(/^page$/i, (rule) => {
    ctx.report.add(rule, { transform: 'media-types', action: 'removed', feature: 'at-rule:page', before: `@page ${rule.params}`.trim(), reason: 'Gameface never prints, so @page never applies' });
    rule.remove();
  });
  root.walkAtRules(/^media$/i, (rule) => {
    const queries = rule.params.split(',').map((q) => q.trim()).filter(Boolean);
    const resolved = queries.map(resolveQuery);
    if (resolved.every((r) => r === null)) return;
    const before = `@media ${rule.params}`;
    const kept = [];
    let always = false;
    queries.forEach((q, i) => {
      const r = resolved[i];
      if (r === null) kept.push(q);
      else if (r.result === 'true') always = true;
      else if (r.result === 'rest') kept.push(r.rest);
    });
    if (always) {
      ctx.report.add(rule, { transform: 'media-types', action: 'converted', feature: 'at-rule:media-type', before, after: '(unwrapped)', reason: 'Gameface always renders as screen' });
      unwrap(rule);
    } else if (kept.length === 0) {
      ctx.report.add(rule, { transform: 'media-types', action: 'removed', feature: 'at-rule:media-type', before, reason: 'Gameface always renders as screen, so this never matches' });
      rule.remove();
    } else {
      const params = kept.join(', ');
      if (params !== rule.params) {
        rule.params = params;
        ctx.report.add(rule, { transform: 'media-types', action: 'converted', feature: 'at-rule:media-type', before, after: `@media ${params}`, reason: 'Gameface always renders as screen' });
      }
    }
  });
}

/** @param {import('postcss').AtRule} rule */
function unwrap(rule) {
  if (rule.nodes) {
    for (const n of [...rule.nodes]) rule.before(n);
  }
  rule.remove();
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function resolveSupports(ctx, root) {
  if (!ctx.features.unsupportedAtRules.has('supports')) return;
  // innermost first, so nested @supports are resolved before their parent
  const rules = [];
  root.walkAtRules(/^supports$/i, (r) => { rules.push(r); });
  for (const rule of rules.reverse()) {
    const before = `@supports ${rule.params}`;
    let result;
    try {
      result = evaluateCondition(ctx, rule.params);
    } catch {
      ctx.report.add(rule, { transform: 'supports', action: 'kept', feature: 'at-rule:supports', before, reason: 'could not parse the condition' });
      continue;
    }
    if (result) {
      ctx.report.add(rule, { transform: 'supports', action: 'converted', feature: 'at-rule:supports', before, after: '(unwrapped)', reason: 'Gameface supports this condition' });
      unwrap(rule);
    } else {
      ctx.report.add(rule, { transform: 'supports', action: 'removed', feature: 'at-rule:supports', before, reason: 'Gameface does not support this condition' });
      rule.remove();
    }
  }
}

/**
 * Evaluates an @supports condition against Gameface's features.
 * @param {Context} ctx
 * @param {string} text
 * @returns {boolean}
 */
export function evaluateCondition(ctx, text) {
  const parsed = valueParser(text.trim());
  /** @type {import('postcss-value-parser').Node[]} */
  const toks = parsed.nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
  let i = 0;

  const inParens = () => {
    const t = toks[i++];
    if (!t || t.type !== 'function') throw new Error('expected a parenthesised condition');
    const name = t.value.toLowerCase();
    if (name === '') {
      const inner = t.nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
      // either a declaration (prop: value) or a nested condition
      const colon = t.nodes.findIndex((n) => n.type === 'div' && n.value === ':');
      if (colon !== -1 && !(inner[0]?.type === 'function' || inner[0]?.value?.toLowerCase() === 'not')) {
        const prop = valueParser.stringify(t.nodes.slice(0, colon)).trim();
        const value = valueParser.stringify(t.nodes.slice(colon + 1)).trim();
        return declarationSupported(ctx, prop, value);
      }
      return evaluateCondition(ctx, valueParser.stringify(t.nodes));
    }
    if (name === 'selector') return selectorSupported(ctx, valueParser.stringify(t.nodes));
    return false; // font-tech(), font-format() and unknown functions
  };

  const notExpr = () => {
    if (toks[i]?.type === 'word' && toks[i].value.toLowerCase() === 'not') {
      i++;
      return !inParens();
    }
    return inParens();
  };

  let result = notExpr();
  while (i < toks.length) {
    const op = toks[i++];
    if (!op || op.type !== 'word') throw new Error('expected and/or');
    const word = op.value.toLowerCase();
    const right = notExpr();
    if (word === 'and') result = result && right;
    else if (word === 'or') result = result || right;
    else throw new Error('expected and/or');
  }
  return result;
}

/**
 * @param {Context} ctx
 * @param {string} prop
 * @param {string} value
 */
function declarationSupported(ctx, prop, value) {
  const p = prop.toLowerCase();
  if (!p || !value) return false;
  if (p.startsWith('--')) return true;
  if (isPropertyUnsupported(ctx.features, p)) return false;
  const parsed = valueParser(value);
  let ok = true;
  for (const n of parsed.nodes) {
    if (n.type === 'word' && isKeywordRejected(ctx.features, p, n.value)) ok = false;
  }
  valueParser.walk(parsed.nodes, (n) => {
    if (n.type === 'function' && isFunctionUnsupported(ctx.features, n.value)) ok = false;
  });
  return ok;
}

/**
 * @param {Context} ctx
 * @param {string} text
 */
function selectorSupported(ctx, text) {
  let ok = true;
  try {
    selectorParser((root) => {
      root.walkPseudos((p) => {
        if (ctx.features.unsupportedPseudos.has(p.value.toLowerCase())) ok = false;
      });
    }).processSync(text);
  } catch {
    return false;
  }
  return ok;
}

/**
 * Gameface mode: remove at-rules Gameface ignores entirely (@container, @scope, …).
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function pruneAtRules(ctx, root) {
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (!ctx.features.unsupportedAtRules.has(name)) return;
    ctx.report.add(rule, { transform: 'prune', action: 'removed', feature: `at-rule:${name}`, before: `@${rule.name} ${rule.params}`.trim(), reason: `Gameface does not support @${name}` });
    rule.remove();
  });
}
