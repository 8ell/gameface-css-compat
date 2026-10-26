// Coverage: one CSS sample per item in the official Gameface catalog.
//
// Every unsupported property, rejected value, function, selector and
// documented restriction becomes a small stylesheet. Running gameface mode on
// each sample tells us, item by item, whether it is converted exactly or
// removed (because Gameface ignores it and nothing equivalent exists). The
// test suite checks that the official linter reports no errors on any output,
// which is what "100%" means for this project.

import { getFeatures } from './features.js';
import { transformCss } from './engine.js';

/** Realistic values for properties we know how to rewrite. */
const SAMPLE_VALUES = {
  inset: '0 1px',
  'place-content': 'center',
  'place-items': 'center',
  'place-self': 'center',
  'flex-flow': 'column wrap',
  'grid-gap': '4px',
  'grid-row-gap': '4px',
  'grid-column-gap': '4px',
  'border-block': '1px solid red',
  'border-inline': '1px solid red',
};

/** Samples for value categories the catalog describes with a marker word. */
const MARKER_SAMPLES = {
  number: (prop) => (prop === 'font-weight' ? '700' : '1'),
  percentage: () => '10%',
  percentages: () => '50%',
  string: () => '"…"',
  gradients: () => 'linear-gradient(red, blue)',
  gradient: () => 'linear-gradient(red, blue)',
  url: () => 'url(a.png)',
  'image-set': () => 'image-set("a.png" 1x)',
  element: () => '-moz-element(#a)',
  'image-rect': () => '-moz-image-rect(url(a.png), 0, 0, 1, 1)',
  'oblique-angle': () => 'oblique 14deg',
  jump: () => 'steps(2, jump-start)',
  anchor: () => 'anchor(--a top)',
  'anchor-size': () => 'anchor-size(width)',
};

/** @param {string} prop */
function sampleFor(prop) {
  if (SAMPLE_VALUES[prop]) return SAMPLE_VALUES[prop];
  if (/^border-(block|inline)(-(start|end))?$/.test(prop)) return '1px solid red';
  if (/-color$/.test(prop)) return 'red';
  if (/-style$/.test(prop)) return 'solid';
  if (/-(width|size|start|end|block|inline)$/.test(prop) || /^(margin|padding|inset)-/.test(prop) || /radius$/.test(prop)) return '1px';
  return 'initial';
}

/**
 * @typedef {object} Sample
 * @property {string} id catalog key, e.g. `property:inset`
 * @property {string} category
 * @property {string} css
 */

/**
 * @param {string} [version]
 * @returns {Sample[]}
 */
export function buildSamples(version) {
  const f = getFeatures(version);
  /** @type {Sample[]} */
  const samples = [];

  for (const prop of [...f.unsupportedProperties].sort()) {
    samples.push({ id: `property:${prop}`, category: 'property', css: `.t { ${prop}: ${sampleFor(prop)}; }` });
  }

  for (const [prop, partial] of [...f.partialProperties].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const value of [...partial.disallowed].sort()) {
      const marker = MARKER_SAMPLES[value];
      let v = marker ? marker(prop) : value;
      let p = prop;
      if (value === 'jump' && !prop.endsWith('timing-function')) continue;
      samples.push({ id: `value:${p}:${value}`, category: 'value', css: `.t { ${p}: ${v}; }` });
    }
  }

  for (const row of f.raw ? catalogFunctions(f) : []) {
    samples.push({ id: `function:${row.name}`, category: 'function', css: `.t { ${row.testProperty}: ${row.canonicalValue}; }` });
  }

  for (const name of [...f.raw.selectorNamesUnsupported].sort()) {
    const t = name.trim();
    let css;
    if (t.startsWith('@')) css = `${t} { .t { color: red; } }`;
    else if (/^:(first|left|right)$/.test(t)) css = `@page ${t} { margin: 1in; }`;
    else css = `.t${t} { color: red; }`;
    samples.push({ id: `selector:${t}`, category: 'selector', css });
  }
  for (const name of [...f.partialSelectors.keys()].sort()) {
    const t = name.trim();
    const css = t === '::selection' ? `.t::selection { color: red; font-weight: bold; }` : `.t${t} { color: red; }`;
    samples.push({ id: `selector-partial:${t}`, category: 'selector', css });
  }

  const restrictions = [
    ['restriction:var-fallback (defined on :root)', ':root { --c: blue; } .t { color: var(--c, red); }'],
    ['restriction:var-fallback (never defined)', '.t { color: var(--never-defined, red); }'],
    ['restriction:var-in-keyframes', ':root { --w: 10px; } @keyframes k { from { width: var(--w); } }'],
    ['restriction:calc-in-keyframes', '@keyframes k { from { width: calc(10px + 5px); } }'],
    ['restriction:calc-mixed-percent', '.t { width: calc(100% - 20px); }'],
    ['restriction:stroke-dash-non-path', 'circle, path { stroke-dasharray: 4; }'],
    ['restriction:keyframes-sizing-unitless', '@keyframes k { from { width: 0; height: 10; } }'],
  ];
  for (const [id, css] of restrictions) samples.push({ id, category: 'restriction', css });

  return samples;
}

/** @param {import('./features.js').Features} f */
function catalogFunctions(f) {
  // the feature index only keeps names; the raw rows carry the sample values
  return [...f.unsupportedFunctions].sort().map((name) => {
    const row = f.functionRows?.get(name);
    return { name, testProperty: row?.evidence?.testProperty ?? 'width', canonicalValue: row?.evidence?.canonicalValue ?? `${name}(1px)` };
  });
}

/**
 * @typedef {object} CoverageRow
 * @property {string} id
 * @property {string} category
 * @property {'converted' | 'removed' | 'mixed' | 'unchanged'} outcome
 * @property {string} input
 * @property {string} output
 * @property {string[]} reasons
 */

/**
 * @param {{ version?: string, options?: object }} [opts]
 * @returns {CoverageRow[]}
 */
export function runCoverage({ version, options = {} } = {}) {
  return buildSamples(version).map((s) => {
    const { css, report } = transformCss(s.css, { mode: 'gameface', version, complete: true, ...options });
    const converted = report.entries.filter((e) => e.action === 'converted');
    const removed = report.entries.filter((e) => e.action === 'removed');
    const outcome = removed.length && converted.length ? 'mixed' : removed.length ? 'removed' : converted.length ? 'converted' : 'unchanged';
    const reasons = [...new Set([...converted, ...removed].map((e) => `${e.action}: ${e.feature}${e.reason ? ` — ${e.reason}` : ''}`))];
    return { id: s.id, category: s.category, outcome, input: s.css, output: css.trim(), reasons };
  });
}
