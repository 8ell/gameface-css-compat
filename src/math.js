// A small evaluator for CSS math functions (CSS Values and Units 4).
//
// Values are kept as linear combinations of canonical units, the same way a
// browser simplifies a calculation tree: `calc(1in + 4px)` is `{ px: 100 }`.
// Absolute units collapse to one canonical unit per type; relative units
// (`em`, `vw`, `%`, …) are kept apart because their size is only known at
// layout time.

import valueParser from 'postcss-value-parser';

export class NotFoldable extends Error {}

const LENGTH_ABSOLUTE = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
const ANGLE = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };
const TIME = { ms: 1, s: 1000 };
const RESOLUTION = { dppx: 1, x: 1, dpi: 1 / 96, dpcm: 2.54 / 96 };
const FREQUENCY = { hz: 1, khz: 1000 };

const LENGTH_RELATIVE = new Set([
  'em', 'rem', 'ex', 'rex', 'ch', 'rch', 'cap', 'rcap', 'ic', 'ric', 'lh', 'rlh',
  'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax',
  'svw', 'svh', 'svi', 'svb', 'svmin', 'svmax',
  'lvw', 'lvh', 'lvi', 'lvb', 'lvmin', 'lvmax',
  'dvw', 'dvh', 'dvi', 'dvb', 'dvmin', 'dvmax',
  'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax',
]);

/** Math functions this module can evaluate. */
export const MATH_FUNCTIONS = new Set([
  'calc', 'min', 'max', 'clamp', 'abs', 'sign', 'round', 'mod', 'rem',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp',
]);

const CONSTANTS = { e: Math.E, pi: Math.PI, infinity: Infinity, '-infinity': -Infinity, nan: NaN };

/**
 * @typedef {Map<string, number>} Sum unit -> coefficient; '' is a plain number
 */

/** @param {string} unit */
export function unitType(unit) {
  const u = unit.toLowerCase();
  if (u === '') return 'number';
  if (u === '%') return 'percentage';
  if (u in LENGTH_ABSOLUTE || LENGTH_RELATIVE.has(u)) return 'length';
  if (u in ANGLE) return 'angle';
  if (u in TIME) return 'time';
  if (u in RESOLUTION) return 'resolution';
  if (u in FREQUENCY) return 'frequency';
  if (u === 'fr') return 'flex';
  return 'unknown';
}

/**
 * Canonical unit and factor for a unit.
 * @param {string} unit
 * @returns {[string, number]}
 */
function canonical(unit) {
  const u = unit.toLowerCase();
  if (u in LENGTH_ABSOLUTE) return ['px', LENGTH_ABSOLUTE[u]];
  if (u in ANGLE) return ['deg', ANGLE[u]];
  if (u in TIME) return ['ms', TIME[u]];
  if (u in RESOLUTION) return ['dppx', RESOLUTION[u]];
  if (u in FREQUENCY) return ['hz', FREQUENCY[u]];
  return [u, 1];
}

/** @param {number} n @param {string} unit @returns {Sum} */
export function term(n, unit) {
  const [u, f] = canonical(unit);
  return new Map([[u, n * f]]);
}

/** @param {Sum} s */
function clean(s) {
  for (const [k, v] of s) if (v === 0 && s.size > 1) s.delete(k);
  return s;
}

/** @param {Sum} a @param {Sum} b */
function compatible(a, b) {
  const types = new Set();
  for (const k of [...a.keys(), ...b.keys()]) {
    const t = unitType(k);
    if (t === 'percentage') continue;
    types.add(t);
  }
  // A plain number can only be added to another plain number.
  const aNum = isNumber(a);
  const bNum = isNumber(b);
  if (aNum !== bNum) {
    // `0` is not special inside calc(): 0 + 1px is invalid
    return false;
  }
  return types.size <= 1;
}

/** @param {Sum} a @param {Sum} b @returns {Sum} */
export function add(a, b) {
  if (!compatible(a, b)) throw new NotFoldable('incompatible types in addition');
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return clean(out);
}

/** @param {Sum} a @param {number} k @returns {Sum} */
export function scale(a, k) {
  const out = new Map();
  for (const [u, v] of a) out.set(u, v * k);
  return out;
}

/** @param {Sum} s */
export function isNumber(s) {
  return s.size === 1 && s.has('');
}

/**
 * The single unit and value of a sum, or null when it mixes units.
 * @param {Sum} s
 * @returns {[string, number] | null}
 */
export function single(s) {
  if (s.size !== 1) return null;
  const [[u, v]] = s;
  return [u, v];
}

/** @param {Sum} s */
function num(s) {
  if (!isNumber(s)) throw new NotFoldable('expected a number');
  return s.get('');
}

/**
 * Splits value-parser nodes on top-level commas.
 * @param {import('postcss-value-parser').Node[]} nodes
 */
function splitArgs(nodes) {
  const args = [[]];
  for (const n of nodes) {
    if (n.type === 'div' && n.value === ',') args.push([]);
    else args[args.length - 1].push(n);
  }
  return args;
}

/**
 * Turns value-parser nodes into a flat token list for the expression parser.
 * @param {import('postcss-value-parser').Node[]} nodes
 */
function tokens(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'space' || n.type === 'comment') continue;
    if (n.type === 'div') {
      if (n.value === '/') out.push({ op: '/' });
      else throw new NotFoldable(`unexpected "${n.value}"`);
      continue;
    }
    if (n.type === 'word') {
      // value-parser keeps `2*3` as one word
      const parts = n.value.split(/([*/])/).filter(Boolean);
      for (const p of parts) {
        if (p === '*' || p === '/' || p === '+' || p === '-') out.push({ op: p });
        else out.push({ node: { ...n, value: p } });
      }
      continue;
    }
    if (n.type === 'function') {
      out.push({ node: n });
      continue;
    }
    throw new NotFoldable(`unexpected ${n.type}`);
  }
  return out;
}

/**
 * @param {import('postcss-value-parser').Node} node
 * @param {Options} opts
 * @returns {Sum}
 */
function leaf(node, opts) {
  if (node.type === 'function') return evaluateFunction(node, opts);
  const v = node.value;
  const lower = v.toLowerCase();
  if (lower in CONSTANTS) return new Map([['', CONSTANTS[lower]]]);
  const parsed = valueParser.unit(v);
  if (!parsed || parsed.number === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(parsed.number)) {
    throw new NotFoldable(`not a numeric value: ${v}`);
  }
  const n = Number(parsed.number);
  const unit = parsed.unit;
  if (unit && unitType(unit) === 'unknown') throw new NotFoldable(`unknown unit ${unit}`);
  if (unit && opts.units && !opts.units(unit.toLowerCase())) throw new NotFoldable(`unit ${unit} not allowed`);
  if (unit.toLowerCase() === 'rem' && typeof opts.rem === 'number') return term(n * opts.rem, 'px');
  return term(n, unit);
}

/**
 * @param {Array<{op?: string, node?: import('postcss-value-parser').Node}>} toks
 * @param {Options} opts
 * @returns {Sum}
 */
function parseExpression(toks, opts) {
  let i = 0;
  const peek = () => toks[i];

  function factor() {
    const t = toks[i++];
    if (!t) throw new NotFoldable('unexpected end of expression');
    if (t.op === '-' || t.op === '+') {
      // unary signs are not valid CSS math syntax with whitespace, but `-` can
      // reach us glued to a function (value-parser splits `-min(…)`)
      const inner = factor();
      return t.op === '-' ? scale(inner, -1) : inner;
    }
    if (t.op) throw new NotFoldable(`unexpected operator ${t.op}`);
    return leaf(t.node, opts);
  }

  function product() {
    let left = factor();
    while (peek() && (peek().op === '*' || peek().op === '/')) {
      const op = toks[i++].op;
      const right = factor();
      if (op === '*') {
        if (isNumber(right)) left = scale(left, num(right));
        else if (isNumber(left)) left = scale(right, num(left));
        else throw new NotFoldable('multiplying two dimensions');
      } else {
        if (!isNumber(right)) throw new NotFoldable('dividing by a dimension');
        const d = num(right);
        if (d === 0) throw new NotFoldable('division by zero');
        left = scale(left, 1 / d);
      }
    }
    return left;
  }

  let result = product();
  while (peek() && (peek().op === '+' || peek().op === '-')) {
    const op = toks[i++].op;
    const right = product();
    result = add(result, op === '-' ? scale(right, -1) : right);
  }
  if (i !== toks.length) throw new NotFoldable('trailing tokens');
  return result;
}

/**
 * @typedef {object} Options
 * @property {(unit: string) => boolean} [units] restrict which units may appear
 * @property {number | null} [rem] px size of 1rem; rem is folded into px when known
 */

/**
 * Evaluates a list of value-parser nodes as one math expression.
 * @param {import('postcss-value-parser').Node[]} nodes
 * @param {Options} [opts]
 * @returns {Sum}
 */
export function evaluateNodes(nodes, opts = {}) {
  return parseExpression(tokens(nodes), opts);
}

/**
 * Two sums of the same single unit, or throws.
 * @param {Sum[]} values
 * @returns {{ unit: string, nums: number[] }}
 */
function sameUnit(values) {
  const pairs = values.map((v) => {
    const one = single(v);
    if (!one) throw new NotFoldable('argument mixes units');
    return one;
  });
  const nonZero = new Set(pairs.filter(([, n]) => n !== 0).map(([u]) => u));
  if (nonZero.size > 1) throw new NotFoldable('arguments use different units');
  const unit = nonZero.size === 1 ? [...nonZero][0] : pairs[0][0];
  for (const [u] of pairs) {
    // a zero of the same type means the same thing in any unit
    if (u !== unit && unitType(u) !== unitType(unit)) throw new NotFoldable('arguments use different types');
  }
  return { unit, nums: pairs.map(([, n]) => n) };
}

/** @param {number} x */
const toRad = (x) => (x * Math.PI) / 180;
/** @param {number} x */
const toDeg = (x) => (x * 180) / Math.PI;

/**
 * @param {Sum} s
 * @returns {number} radians
 */
function angleOrNumberToRadians(s) {
  const one = single(s);
  if (!one) throw new NotFoldable('trig argument mixes units');
  const [u, n] = one;
  if (u === '') return n;
  if (u === 'deg') return toRad(n);
  throw new NotFoldable('trig argument must be a number or an angle');
}

/**
 * @param {number} a
 * @param {number} b
 * @param {string} strategy
 */
function roundTo(a, b, strategy) {
  if (b === 0) return NaN;
  const q = a / Math.abs(b);
  const lower = Math.floor(q) * Math.abs(b);
  const upper = Math.ceil(q) * Math.abs(b);
  if (lower === upper) return a;
  switch (strategy) {
    case 'up': return upper;
    case 'down': return lower;
    case 'to-zero': return Math.abs(lower) < Math.abs(upper) ? lower : upper;
    default: {
      const dl = a - lower;
      const du = upper - a;
      return dl < du ? lower : upper; // ties go up (towards +∞)
    }
  }
}

/**
 * @param {import('postcss-value-parser').FunctionNode} fn
 * @param {Options} opts
 * @returns {Sum}
 */
export function evaluateFunction(fn, opts = {}) {
  const name = fn.value.toLowerCase();
  const args = splitArgs(fn.nodes);
  const ev = (arg) => evaluateNodes(arg, opts);

  switch (name) {
    case '':
    case 'calc': {
      if (args.length !== 1) throw new NotFoldable('calc takes one argument');
      return ev(args[0]);
    }
    case 'min':
    case 'max': {
      const vals = args.map(ev);
      const { unit, nums } = sameUnit(vals);
      const n = name === 'min' ? Math.min(...nums) : Math.max(...nums);
      return term(n, unit ?? '');
    }
    case 'clamp': {
      if (args.length !== 3) throw new NotFoldable('clamp takes three arguments');
      if (args.some((a) => a.length === 1 && a[0].type === 'word' && a[0].value.toLowerCase() === 'none')) {
        throw new NotFoldable('clamp() with none');
      }
      const { unit, nums } = sameUnit(args.map(ev));
      const [lo, val, hi] = nums;
      return term(Math.max(lo, Math.min(val, hi)), unit ?? '');
    }
    case 'abs': {
      const s = single(ev(args[0]));
      if (!s) throw new NotFoldable('abs() of mixed units');
      return term(Math.abs(s[1]), s[0]);
    }
    case 'sign': {
      const s = single(ev(args[0]));
      if (!s) throw new NotFoldable('sign() of mixed units');
      return term(Math.sign(s[1]), '');
    }
    case 'round': {
      let strategy = 'nearest';
      let rest = args;
      const first = args[0];
      if (first.length === 1 && first[0].type === 'word' && ['nearest', 'up', 'down', 'to-zero'].includes(first[0].value.toLowerCase())) {
        strategy = first[0].value.toLowerCase();
        rest = args.slice(1);
      }
      const a = ev(rest[0]);
      const b = rest[1] ? ev(rest[1]) : null;
      if (!b) {
        if (!isNumber(a)) throw new NotFoldable('round() of a dimension needs a step');
        return term(roundTo(num(a), 1, strategy), '');
      }
      const { unit, nums } = sameUnit([a, b]);
      return term(roundTo(nums[0], nums[1], strategy), unit ?? '');
    }
    case 'mod':
    case 'rem': {
      const { unit, nums } = sameUnit([ev(args[0]), ev(args[1])]);
      const [a, b] = nums;
      if (b === 0) return term(NaN, unit ?? '');
      const r = name === 'mod' ? a - b * Math.floor(a / b) : a - b * Math.trunc(a / b);
      return term(r, unit ?? '');
    }
    case 'sin': return term(Math.sin(angleOrNumberToRadians(ev(args[0]))), '');
    case 'cos': return term(Math.cos(angleOrNumberToRadians(ev(args[0]))), '');
    case 'tan': return term(Math.tan(angleOrNumberToRadians(ev(args[0]))), '');
    case 'asin': return term(toDeg(Math.asin(num(ev(args[0])))), 'deg');
    case 'acos': return term(toDeg(Math.acos(num(ev(args[0])))), 'deg');
    case 'atan': return term(toDeg(Math.atan(num(ev(args[0])))), 'deg');
    case 'atan2': {
      const { nums } = sameUnit([ev(args[0]), ev(args[1])]);
      return term(toDeg(Math.atan2(nums[0], nums[1])), 'deg');
    }
    case 'pow': return term(Math.pow(num(ev(args[0])), num(ev(args[1]))), '');
    case 'sqrt': return term(Math.sqrt(num(ev(args[0]))), '');
    case 'hypot': {
      const { unit, nums } = sameUnit(args.map(ev));
      return term(Math.hypot(...nums), unit ?? '');
    }
    case 'log': {
      const x = num(ev(args[0]));
      if (args[1]) return term(Math.log(x) / Math.log(num(ev(args[1]))), '');
      return term(Math.log(x), '');
    }
    case 'exp': return term(Math.exp(num(ev(args[0]))), '');
    default:
      throw new NotFoldable(`${name}() is not a math function`);
  }
}

/**
 * Formats a number the way it is safest to write in CSS: no exponent, at
 * most 6 decimals, no `-0`.
 * @param {number} n
 */
export function formatNumber(n) {
  if (!Number.isFinite(n)) throw new NotFoldable('non-finite result');
  let s = Number(n.toFixed(6)).toString();
  if (s.includes('e')) s = n.toFixed(6).replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

/**
 * Serialises a single-unit sum, or null when it mixes units.
 * @param {Sum} s
 */
export function formatSingle(s) {
  const one = single(s);
  if (!one) return null;
  const [u, n] = one;
  if (!Number.isFinite(n)) return null;
  return formatNumber(n) + u;
}
