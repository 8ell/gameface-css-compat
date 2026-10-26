// Facts about the whole stylesheet that some rewrites depend on.
//
// A rewrite that needs global knowledge (for example "this custom property is
// always defined") only runs when the analysis is complete, i.e. the caller
// promised that the CSS being processed is all the CSS the page uses.

import valueParser from 'postcss-value-parser';

const GUARANTEED_INVALID = new Set(['initial', 'unset', 'revert', 'revert-layer']);

/** @param {import('postcss').Rule} rule */
function isRootSelector(rule) {
  return rule.selectors.every((s) => {
    const t = s.trim().toLowerCase();
    return t === ':root' || t === 'html';
  });
}

/**
 * Whether a node applies unconditionally (not inside @media, @supports, @container, …).
 * `@layer` does not make a rule conditional.
 * @param {import('postcss').Node} node
 */
export function isUnconditional(node) {
  let p = node.parent;
  while (p && p.type !== 'root') {
    if (p.type === 'atrule' && p.name.toLowerCase() !== 'layer') return false;
    if (p.type === 'rule') return false; // nested rules only apply where the parent matches
    p = p.parent;
  }
  return true;
}

/**
 * @typedef {object} CustomPropertyFacts
 * @property {number} declarations how many times it is declared anywhere
 * @property {boolean} definedAtRoot declared unconditionally on :root or html
 * @property {boolean} everInvalid somewhere set to initial/unset/revert (guaranteed-invalid)
 * @property {string[]} values distinct declared values
 */

/**
 * @typedef {object} Analysis
 * @property {boolean} complete
 * @property {Map<string, CustomPropertyFacts>} customProperties
 * @property {boolean} transformAnimated a transition or animation can interpolate `transform`
 * @property {number | null} rootFontSize px, when html/:root sets a fixed px font-size and nothing else does
 * @property {boolean} hasRtl some declaration sets `direction: rtl`
 * @property {Set<string>} animatedProperties properties that a transition or @keyframes can interpolate
 * @property {boolean} allAnimated some transition covers `all` properties
 */

/**
 * @param {import('postcss').Root[]} roots
 * @param {{ complete: boolean }} options
 * @returns {Analysis}
 */
export function analyze(roots, { complete }) {
  /** @type {Map<string, CustomPropertyFacts>} */
  const customProperties = new Map();
  let transformAnimated = false;
  let hasRtl = false;
  let allAnimated = false;
  const animatedProperties = new Set();
  const rootFontSizes = [];

  for (const root of roots) {
    root.walkDecls((decl) => {
      const prop = decl.prop;
      const lower = prop.toLowerCase();
      if (prop.startsWith('--')) {
        const facts = customProperties.get(prop) ?? { declarations: 0, definedAtRoot: false, everInvalid: false, values: [] };
        facts.declarations += 1;
        const value = decl.value.trim();
        if (!facts.values.includes(value)) facts.values.push(value);
        if (GUARANTEED_INVALID.has(value.toLowerCase())) facts.everInvalid = true;
        const parent = decl.parent;
        if (parent?.type === 'rule' && isRootSelector(/** @type {import('postcss').Rule} */ (parent)) && isUnconditional(parent) && !GUARANTEED_INVALID.has(value.toLowerCase())) {
          facts.definedAtRoot = true;
        }
        customProperties.set(prop, facts);
        return;
      }

      if (lower === 'direction' && decl.value.trim().toLowerCase() === 'rtl') hasRtl = true;

      const inKeyframes = isInsideKeyframes(decl);
      if (inKeyframes) animatedProperties.add(lower);
      if (inKeyframes && ['transform', 'rotate', 'scale', 'translate'].includes(lower)) transformAnimated = true;

      if (lower === 'transition' || lower === 'transition-property') {
        if (transitionCoversTransform(decl.value, lower === 'transition')) transformAnimated = true;
        const props = transitionProperties(decl.value, lower === 'transition');
        if (props === 'all') allAnimated = true;
        else for (const p of props) animatedProperties.add(p);
      }

      if (lower === 'font-size' && decl.parent?.type === 'rule') {
        const rule = /** @type {import('postcss').Rule} */ (decl.parent);
        if (isRootSelector(rule)) {
          const parsed = valueParser.unit(decl.value.trim());
          if (parsed && parsed.unit === 'px' && isUnconditional(rule)) rootFontSizes.push(Number(parsed.number));
          else rootFontSizes.push(NaN);
        }
      }
    });
  }

  const distinct = [...new Set(rootFontSizes)];
  const rootFontSize = distinct.length === 1 && Number.isFinite(distinct[0]) ? distinct[0] : null;

  return { complete, customProperties, transformAnimated, rootFontSize, hasRtl, animatedProperties, allAnimated };
}

/** @param {import('postcss').Node} node */
export function isInsideKeyframes(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'atrule' && /^(-\w+-)?keyframes$/i.test(p.name)) return true;
    p = p.parent;
  }
  return false;
}

/**
 * @param {string} value
 * @param {boolean} shorthand
 */
function transitionCoversTransform(value, shorthand) {
  for (const words of layerWords(value)) {
    if (words.length === 0) continue;
    if (!shorthand) {
      if (words.some((w) => w === 'all' || w === 'transform' || w === 'rotate' || w === 'scale' || w === 'translate')) return true;
      continue;
    }
    // In the shorthand the property defaults to `all` when it is omitted.
    const propertyLike = words.filter((w) => /^[a-z-]+$/.test(w) && !TIMING_KEYWORDS.has(w) && !/^(ease|linear|step)/.test(w));
    if (propertyLike.length === 0) return true;
    if (propertyLike.some((w) => w === 'all' || w === 'transform' || w === 'rotate' || w === 'scale' || w === 'translate')) return true;
  }
  return false;
}

/**
 * Top-level words of each comma-separated layer (functions are skipped).
 * @param {string} value
 * @returns {string[][]}
 */
function layerWords(value) {
  const layers = [[]];
  for (const n of valueParser(value).nodes) {
    if (n.type === 'div' && n.value === ',') layers.push([]);
    else if (n.type === 'word') layers[layers.length - 1].push(n.value.toLowerCase());
  }
  return layers;
}

/**
 * Property names a transition declaration covers, or 'all'.
 * @param {string} value
 * @param {boolean} shorthand
 * @returns {string[] | 'all'}
 */
function transitionProperties(value, shorthand) {
  const out = [];
  for (const words of layerWords(value)) {
    if (words.length === 0) continue;
    const props = shorthand ? words.filter((w) => /^[a-z-]+$/.test(w) && !TIMING_KEYWORDS.has(w) && !/^(ease|linear|step)/.test(w)) : words;
    if (props.length === 0 || props.includes('all')) return 'all';
    out.push(...props.filter((p) => p !== 'none'));
  }
  return out;
}

const TIMING_KEYWORDS = new Set([
  'ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'normal', 'allow-discrete', 'none', 'initial', 'inherit', 'unset', 'revert', 'revert-layer',
]);
