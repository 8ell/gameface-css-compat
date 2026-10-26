import valueParser from 'postcss-value-parser';

export const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/**
 * Top-level, non-space nodes of a value.
 * @param {string} value
 */
export function topLevel(value) {
  return valueParser(value).nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
}

/**
 * Splits a value on top-level commas into comma-separated layers.
 * @param {string} value
 * @returns {string[]}
 */
export function splitLayers(value) {
  const layers = [''];
  for (const n of valueParser(value).nodes) {
    if (n.type === 'div' && n.value === ',') layers.push('');
    else layers[layers.length - 1] += valueParser.stringify(n);
  }
  return layers.map((l) => l.trim());
}

/** @param {string} value */
export function hasVar(value) {
  return /\bvar\(/i.test(value);
}

/** @param {string} value */
export function hasPreprocessorSyntax(value) {
  // SCSS/Less variables, interpolation, and functions we cannot evaluate
  return /\$[\w-]|#\{|@\{|~"/.test(value);
}

/** @param {import('postcss-value-parser').Node} node */
export function isWord(node, value) {
  return node.type === 'word' && (value === undefined || node.value.toLowerCase() === value);
}

/**
 * Replaces a value-parser node with plain text, in place.
 * @param {import('postcss-value-parser').Node} node
 * @param {string} text
 */
export function replaceNode(node, text) {
  const n = /** @type {any} */ (node);
  n.type = 'word';
  n.value = text;
  delete n.nodes;
  delete n.before;
  delete n.after;
}

/**
 * Walks function nodes bottom-up (innermost first), skipping url() and var()
 * contents unless `intoVar` is set.
 * @param {import('postcss-value-parser').ParsedValue} parsed
 * @param {(fn: import('postcss-value-parser').FunctionNode) => void} visit
 */
export function walkFunctionsBottomUp(parsed, visit) {
  /** @param {import('postcss-value-parser').Node[]} nodes */
  const rec = (nodes) => {
    for (const n of nodes) {
      if (n.type !== 'function') continue;
      const name = n.value.toLowerCase();
      if (name === 'url') continue;
      rec(n.nodes);
      visit(n);
    }
  };
  rec(parsed.nodes);
}

/**
 * Inserts declarations in place of `decl`, carrying over `!important` and raws.
 * @param {import('postcss').Declaration} decl
 * @param {Array<{ prop: string, value: string }>} replacements
 * @returns {import('postcss').Declaration[]}
 */
export function replaceDecl(decl, replacements) {
  const created = replacements.map(({ prop, value }) => {
    const d = decl.clone({ prop, value });
    d.important = decl.important;
    return d;
  });
  for (const d of created) decl.before(d);
  decl.remove();
  return created;
}

/**
 * Expands a 1-4 value box shorthand (`inset`, `margin` style) into top/right/bottom/left.
 * @param {string[]} values
 * @returns {[string, string, string, string] | null}
 */
export function boxSides(values) {
  switch (values.length) {
    case 1: return [values[0], values[0], values[0], values[0]];
    case 2: return [values[0], values[1], values[0], values[1]];
    case 3: return [values[0], values[1], values[2], values[1]];
    case 4: return [values[0], values[1], values[2], values[3]];
    default: return null;
  }
}

/**
 * Splits a value into its top-level space-separated components, keeping
 * functions intact. Returns null if the value has top-level commas or slashes.
 * @param {string} value
 */
export function components(value) {
  const parts = [];
  for (const n of valueParser(value).nodes) {
    if (n.type === 'space' || n.type === 'comment') continue;
    if (n.type === 'div') return null;
    parts.push(valueParser.stringify(n));
  }
  return parts;
}
