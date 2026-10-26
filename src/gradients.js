// Gradients that contain a non-legacy colour (lab, oklch, color-mix, …)
// interpolate in Oklab, not sRGB (CSS Images 4). Converting those colours to
// rgb() alone would switch the whole gradient to sRGB interpolation, which is
// visibly different. Instead we resample the gradient: extra rgb() stops are
// added until linear sRGB interpolation between neighbouring stops is within a
// quarter of one 8-bit step of the true Oklab curve, so it paints the same.

import valueParser from 'postcss-value-parser';
import { converter, getMode } from 'culori';
import { formatNumber } from './math.js';
import { parseConstantColor, formatRgb, NotConvertible } from './colors.js';

const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient$/;
const POLAR = new Set(['hsl', 'hwb', 'lch', 'oklch']);
const SPACE_TO_MODE = {
  srgb: 'rgb', 'srgb-linear': 'lrgb', 'display-p3': 'p3', 'a98-rgb': 'a98', 'prophoto-rgb': 'prophoto', rec2020: 'rec2020',
  lab: 'lab', oklab: 'oklab', xyz: 'xyz65', 'xyz-d65': 'xyz65', 'xyz-d50': 'xyz50', hsl: 'hsl', hwb: 'hwb', lch: 'lch', oklch: 'oklch',
};
const LEGACY_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb']);

const toRgb = converter('rgb');

/** @param {string} name */
export function isGradient(name) {
  return GRADIENT.test(name.toLowerCase().replace(/^-\w+-/, ''));
}

/**
 * True when a colour function makes a gradient interpolate in Oklab.
 * @param {string} name
 */
export function isNonLegacyColorFunction(name) {
  const n = name.toLowerCase();
  return ['lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix'].includes(n);
}

/** @param {import('postcss-value-parser').Node[]} nodes */
function splitComma(nodes) {
  const out = [[]];
  for (const n of nodes) {
    if (n.type === 'div' && n.value === ',') out.push([]);
    else out[out.length - 1].push(n);
  }
  return out.map((a) => a.filter((n) => n.type !== 'space' && n.type !== 'comment'));
}

/** @param {import('postcss-value-parser').Node} n */
function isColorNode(n) {
  if (n.type === 'function') {
    const name = n.value.toLowerCase();
    return LEGACY_FUNCTIONS.has(name) || isNonLegacyColorFunction(name);
  }
  if (n.type !== 'word') return false;
  const v = n.value.toLowerCase();
  if (v === 'currentcolor') return true;
  try {
    parseConstantColor(v);
    return true;
  } catch {
    return false;
  }
}

/** @param {import('postcss-value-parser').Node} n */
function position(n) {
  if (n.type !== 'word') return null;
  const u = valueParser.unit(n.value);
  if (!u || u.number === '') return null;
  return { value: Number(u.number), unit: u.unit.toLowerCase() };
}

/**
 * @param {import('postcss-value-parser').FunctionNode} fn a gradient function
 * @returns {string} the resampled gradient
 * @throws {NotConvertible} when it cannot be resampled exactly
 */
export function resampleGradient(fn) {
  const name = fn.value;
  const args = splitComma(fn.nodes);
  let config = [];
  let stopArgs = args;
  if (args.length && !args[0].some(isColorNode)) {
    config = args[0];
    stopArgs = args.slice(1);
  }

  // interpolation method: `in <space> [<hue-method> hue]`
  let mode = 'oklab';
  let hueMethod = 'shorter';
  const cfg = [];
  for (let i = 0; i < config.length; i++) {
    const w = config[i].type === 'word' ? config[i].value.toLowerCase() : '';
    if (w === 'in' && config[i + 1]) {
      const space = config[i + 1].value.toLowerCase();
      mode = SPACE_TO_MODE[space];
      if (!mode) throw new NotConvertible(`unknown interpolation space ${space}`);
      i++;
      if (config[i + 2]?.value?.toLowerCase() === 'hue' && POLAR.has(mode)) {
        hueMethod = config[i + 1].value.toLowerCase();
        i += 2;
      }
      continue;
    }
    cfg.push(valueParser.stringify(config[i]));
  }

  const stops = [];
  for (const arg of stopArgs) {
    if (arg.length === 1 && !isColorNode(arg[0])) throw new NotConvertible('colour hints are not resampled');
    const colorNode = arg.find(isColorNode);
    if (!colorNode) throw new NotConvertible('unexpected gradient argument');
    const positions = arg.filter((n) => n !== colorNode).map(position);
    if (positions.some((p) => p === null)) throw new NotConvertible('unexpected stop position');
    if (positions.length > 1) throw new NotConvertible('double-position stops must be split first');
    let color;
    try {
      color = parseConstantColor(valueParser.stringify(colorNode));
    } catch (err) {
      throw new NotConvertible(err.message);
    }
    stops.push({ color, pos: positions[0] ?? null });
  }
  if (stops.length < 2) throw new NotConvertible('a gradient needs two stops');

  // positions: one unit throughout; missing ones follow the CSS fix-up rules
  const units = new Set(stops.filter((s) => s.pos).map((s) => s.pos.unit));
  if (units.size > 1) throw new NotConvertible('stop positions mix units');
  const unit = units.size === 1 ? [...units][0] : '%';
  if (unit !== '%' && (!stops[0].pos || !stops[stops.length - 1].pos)) throw new NotConvertible('implicit first/last positions are percentages');
  if (!stops[0].pos) stops[0].pos = { value: 0, unit };
  if (!stops[stops.length - 1].pos) stops[stops.length - 1].pos = { value: 100, unit };
  let max = -Infinity;
  for (const s of stops) {
    if (s.pos) {
      s.pos.value = Math.max(s.pos.value, max);
      max = s.pos.value;
    }
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].pos) continue;
    let j = i;
    while (!stops[j].pos) j++;
    const a = stops[i - 1].pos.value;
    const b = stops[j].pos.value;
    for (let k = i; k < j; k++) stops[k].pos = { value: a + ((b - a) * (k - i + 1)) / (j - i + 1), unit };
  }

  const conv = converter(mode);
  const channels = getMode(mode).channels.filter((c) => c !== 'alpha');
  const inSpace = stops.map((s) => conv(s.color));
  // missing (powerless) components take the neighbour's value
  for (let i = 0; i < inSpace.length; i++) {
    for (const ch of channels) {
      if (inSpace[i][ch] !== undefined) continue;
      const prev = inSpace[i - 1]?.[ch];
      const next = inSpace[i + 1]?.[ch];
      inSpace[i][ch] = prev ?? next ?? 0;
    }
  }

  /** premultiplied interpolation in `mode`, returned as sRGB with alpha */
  const sample = (c1, c2, t) => {
    const a1 = c1.alpha ?? 1;
    const a2 = c2.alpha ?? 1;
    const alpha = a1 + (a2 - a1) * t;
    const out = { mode };
    for (const ch of channels) {
      let v1 = c1[ch];
      let v2 = c2[ch];
      if (ch === 'h') {
        [v1, v2] = fixHues(v1, v2, hueMethod);
        out.h = v1 + (v2 - v1) * t;
        continue;
      }
      const pm = v1 * a1 + (v2 * a2 - v1 * a1) * t;
      out[ch] = alpha === 0 ? 0 : pm / alpha;
    }
    out.alpha = alpha;
    const rgb = toRgb(out);
    return { r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b), a: alpha };
  };

  const pieces = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (i === 0) {
      pieces.push([sample(inSpace[0], inSpace[0], 0), s.pos.value]);
      continue;
    }
    const p1 = stops[i - 1].pos.value;
    const p2 = s.pos.value;
    const c1 = inSpace[i - 1];
    const c2 = inSpace[i];
    if (p2 === p1) {
      pieces.push([sample(c1, c2, 1), p2]);
      continue;
    }
    const ts = [];
    subdivide(c1, c2, 0, 1, sample, ts, 0);
    for (const t of ts) pieces.push([sample(c1, c2, t), p1 + (p2 - p1) * t]);
  }

  const parts = pieces.map(([c, p]) => `${formatRgb(c)} ${formatNumber(p)}${unit}`);
  return `${name}(${[...(cfg.length ? [cfg.join(' ')] : []), ...parts].join(', ')})`;
}

/** @param {number} x */
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * Pushes the end points of linear pieces over [a, b] (excluding a) such that
 * linear sRGB interpolation stays within 0.25/255 of the true curve.
 */
function subdivide(c1, c2, a, b, sample, out, depth) {
  const fa = sample(c1, c2, a);
  const fb = sample(c1, c2, b);
  let ok = depth >= 7;
  if (!ok) {
    ok = true;
    for (const q of [0.25, 0.5, 0.75]) {
      const t = a + (b - a) * q;
      const truth = sample(c1, c2, t);
      const alpha = fa.a + (fb.a - fa.a) * q;
      for (const ch of ['r', 'g', 'b']) {
        // browsers interpolate legacy colours with premultiplied alpha
        const lin = alpha === 0 ? 0 : (fa[ch] * fa.a + (fb[ch] * fb.a - fa[ch] * fa.a) * q);
        if (Math.abs(lin - truth[ch] * truth.a) > 0.25 / 255) ok = false;
      }
      if (Math.abs(alpha - truth.a) > 0.25 / 255) ok = false;
    }
  }
  if (ok) {
    out.push(b);
    return;
  }
  const m = (a + b) / 2;
  subdivide(c1, c2, a, m, sample, out, depth + 1);
  subdivide(c1, c2, m, b, sample, out, depth + 1);
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
  if (method === 'longer') {
    if (d > 0 && d < 180) a += 360;
    else if (d > -180 && d <= 0) b += 360;
  } else if (method === 'increasing') {
    if (b < a) b += 360;
  } else if (method === 'decreasing') {
    if (a < b) a += 360;
  } else if (d > 180) a += 360;
  else if (d < -180) b += 360;
  return [a, b];
}
