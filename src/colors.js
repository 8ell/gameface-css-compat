// Colour conversion for colour functions Gameface cannot parse.
//
// `hsl()`, `hwb()` always describe sRGB colours, so converting them to `rgb()`
// is exact. `lab()`, `lch()`, `oklab()` and `oklch()` can describe colours
// outside sRGB; those are only converted exactly when they are inside the sRGB
// gamut. `color-mix()` is evaluated with the CSS Color 5 algorithm
// (premultiplied alpha, hue interpolation methods).

import { converter, displayable, getMode, parse, toGamut } from 'culori';
import valueParser from 'postcss-value-parser';
import { NotFoldable, evaluateFunction, single } from './math.js';

const toRgb = converter('rgb');
const gamutMapRgb = toGamut('rgb', 'oklch');

/** Colour functions this module can convert. */
export const COLOR_FUNCTIONS = new Set(['hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color-mix']);

/** Colour functions whose result is always inside sRGB. */
const ALWAYS_SRGB = new Set(['hsl', 'hsla', 'hwb']);

const SPACE_TO_MODE = {
  srgb: 'rgb',
  'srgb-linear': 'lrgb',
  'display-p3': 'p3',
  'a98-rgb': 'a98',
  'prophoto-rgb': 'prophoto',
  rec2020: 'rec2020',
  lab: 'lab',
  oklab: 'oklab',
  xyz: 'xyz65',
  'xyz-d65': 'xyz65',
  'xyz-d50': 'xyz50',
  hsl: 'hsl',
  hwb: 'hwb',
  lch: 'lch',
  oklch: 'oklch',
};

const POLAR = new Set(['hsl', 'hwb', 'lch', 'oklch']);

export class NotConvertible extends Error {}

/**
 * A parsed colour value, or throws when the text is not a constant colour.
 * @param {string} text
 */
export function parseConstantColor(text) {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower.includes('var(') || lower.includes('env(') || lower.includes('attr(')) throw new NotConvertible('not a constant colour');
  if (/^[a-z]+\(\s*from\s/.test(lower)) {
    const node = valueParser(t).nodes[0];
    if (!node || node.type !== 'function') throw new NotConvertible('bad relative colour');
    return relativeColor(node);
  }
  if (/\bfrom\b/.test(lower)) throw new NotConvertible('relative colour syntax');
  if (lower === 'currentcolor' || lower === 'inherit' || lower === 'initial' || lower === 'unset') {
    throw new NotConvertible('depends on context');
  }
  if (lower.startsWith('color-mix(')) {
    const node = valueParser(t).nodes[0];
    if (!node || node.type !== 'function') throw new NotConvertible('bad color-mix()');
    return mix(node);
  }
  const c = parse(t);
  if (!c) throw new NotConvertible(`cannot parse colour ${t}`);
  return c;
}

/**
 * @param {number} h1
 * @param {number} h2
 * @param {string} method
 */
function fixHues(h1, h2, method) {
  let a = ((h1 % 360) + 360) % 360;
  let b = ((h2 % 360) + 360) % 360;
  const d = b - a;
  switch (method) {
    case 'longer':
      if (d > 0 && d < 180) a += 360;
      else if (d > -180 && d <= 0) b += 360;
      break;
    case 'increasing':
      if (b < a) b += 360;
      break;
    case 'decreasing':
      if (a < b) a += 360;
      break;
    default: // shorter
      if (d > 180) a += 360;
      else if (d < -180) b += 360;
  }
  return [a, b];
}

/**
 * Evaluates `color-mix()` per CSS Color 5 §3.
 * @param {import('postcss-value-parser').FunctionNode} fn
 */
function mix(fn) {
  const parts = [[]];
  for (const n of fn.nodes) {
    if (n.type === 'div' && n.value === ',') parts.push([]);
    else parts[parts.length - 1].push(n);
  }
  if (parts.length !== 3) throw new NotConvertible('color-mix() needs an interpolation method and two colours');

  const method = parts[0].filter((n) => n.type === 'word').map((n) => n.value.toLowerCase());
  if (method[0] !== 'in' || !method[1]) throw new NotConvertible('missing interpolation space');
  const space = method[1];
  const mode = SPACE_TO_MODE[space];
  if (!mode) throw new NotConvertible(`unknown colour space ${space}`);
  let hueMethod = 'shorter';
  if (method.length > 2) {
    if (method.length !== 4 || method[3] !== 'hue' || !POLAR.has(mode)) throw new NotConvertible('bad hue method');
    hueMethod = method[2];
    if (!['shorter', 'longer', 'increasing', 'decreasing'].includes(hueMethod)) throw new NotConvertible('bad hue method');
  }

  /** @param {import('postcss-value-parser').Node[]} nodes */
  const colourAndPct = (nodes) => {
    const meaningful = nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
    let pct = null;
    const rest = [];
    for (const n of meaningful) {
      if (n.type === 'word' && /%$/.test(n.value) && valueParser.unit(n.value)?.unit === '%') pct = Number(n.value.slice(0, -1));
      else rest.push(n);
    }
    if (rest.length !== 1) throw new NotConvertible('bad colour argument');
    return { color: parseConstantColor(valueParser.stringify(rest[0])), pct };
  };

  const a = colourAndPct(parts[1]);
  const b = colourAndPct(parts[2]);
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 === null && p2 === null) { p1 = 50; p2 = 50; }
  else if (p1 === null) p1 = 100 - p2;
  else if (p2 === null) p2 = 100 - p1;
  if (p1 < 0 || p2 < 0 || p1 > 100 || p2 > 100) throw new NotConvertible('percentage out of range');
  const sum = p1 + p2;
  if (sum === 0) throw new NotConvertible('percentages sum to zero');
  const alphaMultiplier = sum < 100 ? sum / 100 : 1;
  const w2 = p2 / sum;
  const w1 = 1 - w2;

  const conv = converter(mode);
  const c1 = conv(a.color);
  const c2 = conv(b.color);
  const channels = getMode(mode).channels.filter((ch) => ch !== 'alpha');
  const alpha1 = c1.alpha ?? 1;
  const alpha2 = c2.alpha ?? 1;

  // Missing components (culori leaves achromatic hues undefined) take the other colour's value.
  for (const ch of channels) {
    if (c1[ch] === undefined && c2[ch] !== undefined) c1[ch] = c2[ch];
    if (c2[ch] === undefined && c1[ch] !== undefined) c2[ch] = c1[ch];
  }

  const out = { mode };
  const alpha = alpha1 * w1 + alpha2 * w2;
  for (const ch of channels) {
    let v1 = c1[ch] ?? 0;
    let v2 = c2[ch] ?? 0;
    if (ch === 'h') {
      [v1, v2] = fixHues(v1, v2, hueMethod);
      out.h = v1 * w1 + v2 * w2;
      continue;
    }
    // premultiplied interpolation; hue is never premultiplied
    const pm = v1 * alpha1 * w1 + v2 * alpha2 * w2;
    out[ch] = alpha === 0 ? 0 : pm / alpha;
  }
  out.alpha = alpha * alphaMultiplier;
  return out;
}

/**
 * @param {number} x 0..1
 */
// Browsers round half-way channel values up; the epsilon absorbs float noise such as 0.5 - 0.4 = 0.0999…98.
const byte = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255 + 1e-7);

/**
 * @param {number} a
 */
function formatAlpha(a) {
  const v = Math.min(1, Math.max(0, a));
  return Number(v.toFixed(4)).toString();
}

/**
 * Formats sRGB channels (0..1) and alpha as rgb()/rgba().
 * @param {{ r: number, g: number, b: number, a?: number, alpha?: number }} c
 */
export function formatRgb(c) {
  const alpha = c.a ?? c.alpha ?? 1;
  const r = byte(c.r);
  const g = byte(c.g);
  const b = byte(c.b);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${formatAlpha(alpha)})`;
}

/**
 * Converts a colour function call to `rgb()`/`rgba()`.
 * @param {string} text the full function text, e.g. `hsl(210 80% 50%)`
 * @param {{ allowGamutMapping: boolean }} options
 * @returns {{ value: string, gamutMapped: boolean }}
 */
export function convertColor(text, { allowGamutMapping }) {
  const name = text.slice(0, text.indexOf('(')).trim().toLowerCase();
  const parsed = parseConstantColor(text);
  let rgb = toRgb(parsed);
  let gamutMapped = false;
  // rgb() channels clamp at parse time, like hsl()/hwb() saturation and lightness
  const inGamut = ALWAYS_SRGB.has(name) || name === 'rgb' || name === 'rgba' || displayable({ ...rgb, r: rgb.r, g: rgb.g, b: rgb.b }) || nearlyDisplayable(rgb);
  if (!inGamut) {
    if (!allowGamutMapping) throw new NotConvertible('colour is outside sRGB; converting would change it on wide-gamut screens');
    rgb = gamutMapRgb(parsed);
    gamutMapped = true;
  }
  return { value: formatRgb(rgb), gamutMapped };
}

/** sRGB within rounding noise of the gamut boundary. */
function nearlyDisplayable(rgb) {
  const eps = 1e-6;
  return ['r', 'g', 'b'].every((ch) => rgb[ch] >= -eps && rgb[ch] <= 1 + eps);
}

/**
 * Relative colour syntax (CSS Color 5 §4): `rgb(from <origin> r g calc(b + 20))`.
 * Channel keywords resolve to the origin's channels in the function's own
 * space, using the reference ranges CSS defines for each channel.
 */
const RELATIVE = {
  rgb: { mode: 'rgb', keys: ['r', 'g', 'b'], scale: [255, 255, 255], pct: [2.55, 2.55, 2.55] },
  hsl: { mode: 'hsl', keys: ['h', 's', 'l'], scale: [1, 100, 100], pct: [null, 1, 1] },
  hwb: { mode: 'hwb', keys: ['h', 'w', 'b'], scale: [1, 100, 100], pct: [null, 1, 1] },
  lab: { mode: 'lab', keys: ['l', 'a', 'b'], scale: [1, 1, 1], pct: [1, 1.25, 1.25] },
  lch: { mode: 'lch', keys: ['l', 'c', 'h'], scale: [1, 1, 1], pct: [1, 1.5, null] },
  oklab: { mode: 'oklab', keys: ['l', 'a', 'b'], scale: [1, 1, 1], pct: [0.01, 0.004, 0.004] },
  oklch: { mode: 'oklch', keys: ['l', 'c', 'h'], scale: [1, 1, 1], pct: [0.01, 0.004, null] },
};
RELATIVE.rgba = RELATIVE.rgb;
RELATIVE.hsla = RELATIVE.hsl;

const ANGLE = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/**
 * @param {import('postcss-value-parser').FunctionNode} fn
 */
export function relativeColor(fn) {
  const spec = RELATIVE[fn.value.toLowerCase()];
  if (!spec) throw new NotConvertible(`relative ${fn.value}() is not supported`);
  const nodes = fn.nodes.filter((n) => n.type !== 'space' && n.type !== 'comment');
  const slash = nodes.findIndex((n) => n.type === 'div' && n.value === '/');
  const main = slash === -1 ? nodes : nodes.slice(0, slash);
  const alphaPart = slash === -1 ? [] : nodes.slice(slash + 1);
  if (main.some((n) => n.type === 'div')) throw new NotConvertible('relative colours use the space-separated syntax');
  if (main.length !== 5 || main[0].type !== 'word' || main[0].value.toLowerCase() !== 'from' || alphaPart.length > 1) {
    throw new NotConvertible('bad relative colour');
  }
  const origin = converter(spec.mode)(parseConstantColor(valueParser.stringify(main[1])));
  /** @type {Record<string, number>} */
  const env = { alpha: origin.alpha ?? 1 };
  spec.keys.forEach((k, i) => { env[k] = (origin[k] ?? 0) * spec.scale[i]; });

  const out = { mode: spec.mode };
  spec.keys.forEach((k, i) => {
    const hue = k === 'h';
    const v = channel(main[2 + i], env, { hue, pct: spec.pct[i] });
    out[k] = hue ? v : v / spec.scale[i];
  });
  out.alpha = alphaPart.length ? Math.min(1, Math.max(0, channel(alphaPart[0], env, { hue: false, pct: 0.01 }))) : env.alpha;
  return out;
}

/**
 * One channel argument: a keyword, a number, a percentage, an angle or a math
 * function over those.
 * @param {import('postcss-value-parser').Node} node
 * @param {Record<string, number>} env
 * @param {{ hue: boolean, pct: number | null }} kind
 */
function channel(node, env, kind) {
  let sum;
  try {
    if (node.type === 'word') {
      const w = node.value.toLowerCase();
      if (w in env) return env[w];
      if (w === 'none') return 0;
      sum = evaluateFunction({ type: 'function', value: 'calc', nodes: [node] });
    } else if (node.type === 'function') {
      const copy = structuredClone(node);
      valueParser.walk(copy.nodes, (n) => {
        if (n.type === 'word' && n.value.toLowerCase() in env) n.value = String(env[n.value.toLowerCase()]);
      });
      sum = evaluateFunction(copy);
    } else throw new NotConvertible('bad channel');
  } catch (err) {
    if (err instanceof NotFoldable) throw new NotConvertible(`cannot evaluate channel: ${err.message}`);
    throw err;
  }
  const one = single(sum);
  if (!one) throw new NotConvertible('channel mixes units');
  const [unit, value] = one;
  if (unit === '') return value;
  if (unit === '%' && kind.pct !== null) return value * kind.pct;
  if (kind.hue && unit in ANGLE) return value * ANGLE[unit];
  throw new NotConvertible(`unexpected ${unit} in a colour channel`);
}
