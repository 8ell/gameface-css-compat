// Gameface mode, last step: remove what Gameface ignores.
//
// Gameface's stylesheet parser rejects these declarations (its log says so:
// "Unsupported CSS property detected", "Unable to parse declaration: …"), so
// removing them does not change what Gameface renders. It makes the output
// clean for the official linter and turns every lost behaviour into a report
// entry instead of a silent log line at runtime.

import valueParser from 'postcss-value-parser';
import { isFunctionUnsupported, isKeywordRejected, isMarkerRejected, isPropertyUnsupported, svgSupport } from '../features.js';
import { isInsideKeyframes } from '../analysis.js';
import { hasPreprocessorSyntax } from '../util.js';

/** @typedef {import('../engine.js').Context} Context */

const LENGTH_UNITS = new Set([
  'px', 'em', 'rem', 'ex', 'ch', 'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax', 'svw', 'svh', 'lvw', 'lvh', 'dvw', 'dvh',
  'cm', 'mm', 'in', 'pt', 'pc', 'q', 'lh', 'rlh', 'cap', 'ic',
]);

/**
 * Why Gameface rejects a declaration, or null when it accepts it.
 * @param {Context} ctx
 * @param {import('postcss').Declaration} decl
 * @returns {{ feature: string, reason: string } | null}
 */
export function rejection(ctx, decl) {
  const prop = decl.prop.toLowerCase();
  const { features } = ctx;
  const inKeyframes = isInsideKeyframes(decl);
  const parsed = valueParser(decl.value);

  if (!prop.startsWith('--') && isPropertyUnsupported(features, prop)) {
    return { feature: `property:${prop}`, reason: `Gameface does not support ${prop}` };
  }

  let found = null;
  // functions Gameface cannot parse, anywhere in the value
  valueParser.walk(parsed.nodes, (n) => {
    if (found || n.type !== 'function') return undefined;
    const name = n.value.toLowerCase();
    if (name === 'url') return false;
    if (name && isFunctionUnsupported(features, name)) {
      found = { feature: `function:${name}`, reason: `Gameface does not support ${name}()` };
      return false;
    }
    if (name === 'var' && n.nodes.some((c) => c.type === 'div' && c.value === ',')) {
      found = { feature: 'restriction:var-fallback', reason: 'Gameface does not support var() fallbacks' };
      return false;
    }
    if (inKeyframes && name === 'var') {
      found = { feature: 'restriction:var-in-keyframes', reason: 'Gameface does not support var() inside @keyframes' };
      return false;
    }
    if (inKeyframes && name === 'calc') {
      found = { feature: 'restriction:calc-in-keyframes', reason: 'Gameface does not support calc() inside @keyframes' };
      return false;
    }
    if (name === 'calc' && calcMixesPercent(n)) {
      found = { feature: 'restriction:calc-mixed-percent', reason: 'Gameface calc() cannot mix % with lengths' };
      return false;
    }
    return undefined;
  });
  if (found) return found;
  if (prop.startsWith('--')) return null;

  // keyword values Gameface rejects for this property (same check as the official linter)
  for (const n of parsed.nodes) {
    if (n.type === 'word' && isKeywordRejected(features, prop, n.value)) {
      return { feature: `value:${prop}:${n.value.toLowerCase()}`, reason: `Gameface does not accept ${prop}: ${n.value}` };
    }
  }

  // value categories the catalog lists as rejected
  const top = parsed.nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
  if (isMarkerRejected(features, prop, 'number') && top.some((n) => n.type === 'word' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(n.value))) {
    return { feature: `value:${prop}:number`, reason: `Gameface does not accept numeric ${prop}` };
  }
  if (isMarkerRejected(features, prop, 'percentage') && top.some((n) => n.type === 'word' && valueParser.unit(n.value)?.unit === '%')) {
    return { feature: `value:${prop}:percentage`, reason: `Gameface does not accept percentages for ${prop}` };
  }
  if (isMarkerRejected(features, prop, 'string') && top.some((n) => n.type === 'string')) {
    return { feature: `value:${prop}:string`, reason: `Gameface does not accept strings for ${prop}` };
  }
  if (isMarkerRejected(features, prop, 'oblique-angle') && /^oblique\s+\S/i.test(decl.value.trim())) {
    return { feature: `value:${prop}:oblique-angle`, reason: 'Gameface does not accept an oblique angle' };
  }
  for (const marker of ['url', 'image-set', 'element', 'image-rect', 'anchor', 'anchor-size', 'gradient']) {
    if (!isMarkerRejected(features, prop, marker)) continue;
    let hit = false;
    valueParser.walk(parsed.nodes, (n) => {
      if (n.type !== 'function') return;
      const name = n.value.toLowerCase().replace(/^-\w+-/, '');
      if (name === marker || (marker === 'gradient' && name.endsWith('-gradient'))) hit = true;
    });
    if (hit) return { feature: `value:${prop}:${marker}`, reason: `Gameface does not accept ${marker} values for ${prop}` };
  }
  const timingLonghand = prop.startsWith('animation') ? 'animation-timing-function' : prop.startsWith('transition') ? 'transition-timing-function' : null;
  if (timingLonghand && isMarkerRejected(features, timingLonghand, 'jump') && /\bjump-(none|both|start|end)\b/i.test(decl.value)) {
    return { feature: `value:${timingLonghand}:jump`, reason: 'Gameface does not accept jump-* step positions' };
  }

  if (inKeyframes && svgSupport.keyframeUnitProperties.has(prop) && top.length === 1 && top[0].type === 'word' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(top[0].value)) {
    return { feature: `restriction:keyframes-${prop}-unitless`, reason: `Gameface needs units for ${prop} in @keyframes` };
  }
  return null;
}

/** @param {import('postcss-value-parser').FunctionNode} fn */
function calcMixesPercent(fn) {
  let percent = false;
  let length = false;
  valueParser.walk(fn.nodes, (n) => {
    if (n.type !== 'word') return;
    const u = valueParser.unit(n.value);
    if (!u || u.number === '') return;
    if (u.unit === '%') percent = true;
    else if (LENGTH_UNITS.has(u.unit.toLowerCase())) length = true;
  });
  return percent && length;
}

/**
 * @param {Context} ctx
 * @param {import('postcss').Root} root
 */
export function pruneDeclarations(ctx, root) {
  const emptied = new Set();
  root.walkDecls((decl) => {
    if (hasPreprocessorSyntax(decl.value)) return;
    const prop = decl.prop.toLowerCase();
    // unitless 0 is a valid length; Gameface just wants the unit inside @keyframes
    if (isInsideKeyframes(decl) && svgSupport.keyframeUnitProperties.has(prop) && /^[+-]?0*\.?0+$/.test(decl.value.trim())) {
      ctx.report.add(decl, { transform: 'keyframes-units', action: 'converted', feature: `restriction:keyframes-${prop}-unitless`, before: decl.value, after: '0px' });
      decl.value = '0px';
      return;
    }
    const why = rejection(ctx, decl);
    if (!why) return;
    ctx.report.add(decl, { transform: 'prune', action: 'removed', feature: why.feature, before: `${decl.prop}: ${decl.value}`, reason: why.reason });
    if (decl.parent) emptied.add(decl.parent);
    decl.remove();
  });
  removeEmpty(emptied);
}

/**
 * Removes containers that our removals left empty, walking up.
 * @param {Set<import('postcss').Container>} containers
 */
export function removeEmpty(containers) {
  for (const c of containers) {
    let node = c;
    while (node && node.type !== 'root' && node.nodes && node.nodes.filter((n) => n.type !== 'comment').length === 0) {
      const parent = node.parent;
      node.remove();
      node = parent;
    }
  }
}
