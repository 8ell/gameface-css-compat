// Browser equivalence: every rewrite used in source mode must render
// identically in a real browser engine. These tests are the replacement for
// human review: each case renders the original and the rewritten CSS in
// Chromium and compares boxes, colours, computed styles and pixels.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { transformCss } from '../../src/index.js';
import { convertColor } from '../../src/colors.js';
import { converter, parse } from 'culori';
import { closeBrowser, compareRender, evaluateWith, getBrowser } from './harness.js';

after(closeBrowser);

const WIDTHS = [[320, 600], [399, 600], [400, 600], [401, 600], [640, 600], [800, 600], [801, 600], [1280, 720], [1920, 1080]];

/** @param {string} css @param {object} [options] */
function rewrite(css, options = {}) {
  const { css: out, report } = transformCss(css, { mode: 'source', complete: true, ...options });
  return { out, report };
}

/**
 * @param {string} name
 * @param {{ css: string, html: string, options?: object, viewports?: Array<[number, number]>, ignore?: string[], minConverted?: number }} c
 */
function equivalent(name, c) {
  test(name, async () => {
    const { out, report } = rewrite(c.css, c.options);
    const converted = report.entries.filter((e) => e.action === 'converted').length;
    assert.ok(converted >= (c.minConverted ?? 1), `expected rewrites, got ${converted}:\n${out}`);
    const problems = await compareRender({ before: c.css, after: out, html: c.html, viewports: c.viewports, ignore: c.ignore });
    assert.deepEqual(problems, [], `\n--- before\n${c.css}\n--- after\n${out}`);
  });
}

const boxes = (n, cls = 'b') => Array.from({ length: n }, (_, i) => `<div class="${cls}${i}">${cls}${i}</div>`).join('');

equivalent('colour functions', {
  css: `
    .b0 { color: hsl(210 80% 50%); background-color: hwb(120 10% 20%); }
    .b1 { color: hsla(20, 60%, 40%, 0.7); background-color: oklch(0.7 0.1 30); border: 6px solid lab(60% 20 30); }
    .b2 { background-color: color-mix(in srgb, red 30%, blue); color: color-mix(in oklab, #08f, white 40%); }
    .b3 { background-color: color-mix(in oklch longer hue, oklch(0.7 0.1 20), oklch(0.6 0.1 200)); color: color-mix(in hsl, red, lime); }
    .b4 { background-image: linear-gradient(90deg, hsl(0 100% 50%), oklab(0.6 0.05 -0.1)); height: 40px; }
    .b5 { background-color: color-mix(in srgb, transparent, hsl(120 100% 25%)); box-shadow: 0 0 0 4px hwb(200 20% 10% / 50%); }`,
  html: boxes(6),
  minConverted: 10,
});

equivalent('math functions with one unit', {
  css: `
    .b0 { width: min(120px, 3in); margin-left: max(-10px, -2em); }
    .b1 { width: clamp(10px, 250px, 200px); padding-left: round(13px, 4px); }
    .b2 { width: calc(mod(250px, 70px) + 10px); padding-top: rem(-7px, 3px); margin-left: abs(-12px); }
    .b3 { transform: rotate(atan2(1, 1)) translateX(round(down, 15.7px, 2px)); width: 80px; height: 40px; }
    .b4 { font-size: max(1em, 0.5em); line-height: min(2, 1.5); }`,
  html: boxes(5),
  minConverted: 9,
});

equivalent('fluid clamp/min/max with vw become media queries', {
  css: `
    .b0 { font-size: clamp(16px, 4vw, 32px); }
    .b1 { width: min(300px, 50vw); height: 20px; }
    .b2 { padding: 0 max(10px, 5vw); }
    .b3 { margin-left: clamp(0px, calc(10vw - 50px), 80px); width: 30px; height: 10px; }
    .b4 { width: max(min(40vw, 400px), 150px); height: 10px; }`,
  html: boxes(5),
  viewports: WIDTHS,
  minConverted: 5,
});

equivalent('fluid with vh', {
  css: `.b0 { height: clamp(100px, 50vh, 300px); width: 10px; }`,
  html: boxes(1),
  viewports: [[800, 150], [800, 199], [800, 200], [800, 400], [800, 600], [800, 601], [800, 900]],
});

equivalent('skew() and perspective() as matrices', {
  css: `
    .w { padding: 40px; }
    .b0 { transform: skew(10deg); width: 80px; height: 40px; background: red; }
    .b1 { transform: skew(0, 15deg); width: 80px; height: 40px; background: blue; }
    .b2 { transform: skew(20deg, 10deg); width: 80px; height: 40px; background: green; }
    .b3 { transform: perspective(400px) rotateY(30deg); width: 80px; height: 40px; background: orange; }
    .b4 { transform: perspective(none) rotate(10deg); width: 80px; height: 40px; background: purple; }`,
  html: `<div class="w">${boxes(5)}</div>`,
  ignore: ['transform'], // computed matrices print with different rounding; boxes and pixels are compared
  minConverted: 5,
});

equivalent('rect() and xywh() as inset()', {
  css: `
    .b0 { clip-path: rect(10% 90% 80% 0); width: 100px; height: 60px; background: red; }
    .b1 { clip-path: xywh(10% 20% 50% 30% round 8px); width: 100px; height: 60px; background: blue; }`,
  html: boxes(2),
  ignore: ['clip-path'],
  minConverted: 2,
});

equivalent('gradient stops with two positions', {
  css: `.b0 { height: 40px; background-image: linear-gradient(90deg, red 0 10px, blue 10px 20px, lime 20px); }
        .b1 { height: 40px; background-image: repeating-linear-gradient(red 0 5px, white 5px 10px); }`,
  html: boxes(2),
});

const flexItems = '<i>1</i><i>22</i><i>333</i>';
equivalent('flex alignment keywords', {
  css: `
    i { width: 30px; height: 20px; background: #ccc; font-style: normal; }
    .f { display: flex; width: 300px; height: 120px; margin: 4px; flex-wrap: wrap; align-content: normal; }
    .f0 { justify-content: normal; align-items: normal; }
    .f1 { justify-content: stretch; flex-direction: column; }
    .f2 { justify-content: normal; flex-direction: row-reverse; }
    .f3 { justify-content: stretch; flex-direction: column-reverse; align-items: normal; }
    .f4 { place-content: normal; flex-wrap: wrap-reverse; }
    .f5 { place-content: normal; flex-wrap: wrap; width: 70px; }
    .blk { justify-content: normal; align-items: normal; align-content: normal; height: 40px; }`,
  html: `<div class="f f0">${flexItems}</div><div class="f f1">${flexItems}</div><div class="f f2">${flexItems}</div><div class="f f3">${flexItems}</div><div class="f f4">${flexItems}</div><div class="f f5">${flexItems}</div><div class="blk">${flexItems}</div>`,
  minConverted: 8,
});

equivalent('font and text keywords', {
  css: `
    .b0 { font-weight: 700; } .b1 { font-weight: 400; } .b2 { font: italic 700 18px/1.4 serif; }
    .b3 { text-decoration: underline; text-decoration-thickness: 20%; text-underline-offset: 30%; font-size: 30px; }
    .b4 { font-style: oblique 14deg; font-size: 24px; }
    .base { max-width: 50px; } .b5.base { max-width: none; width: 400px; }
    .b6 { text-decoration: underline 25%; font-size: 28px; }`,
  html: boxes(5) + '<div class="b5 base">wide</div><div class="b6">deco</div>',
  ignore: ['max-width'],
  minConverted: 7,
});

equivalent('text-align start/end when every page is LTR', {
  css: `.b0 { text-align: end; width: 200px; } .b1 { text-align: start; width: 200px; } .p { text-align: end; width: 200px; } .p .b2 { text-align: match-parent; }`,
  html: boxes(2) + '<div class="p"><div class="b2">x</div></div>',
  options: { assumeLtr: true },
  ignore: ['text-align'], // the computed keyword differs (end vs right); boxes and pixels are compared
  minConverted: 3,
});

equivalent('logical properties when every page is LTR', {
  css: `
    .b0 { margin-inline: 10px 30px; padding-block: 5px 15px; border-block: 3px solid red; }
    .b1 { border-inline-start: 4px dashed blue; border-start-end-radius: 10px; inline-size: 120px; block-size: 30px; background: #eee; }
    .b2 { position: relative; inset-inline: 10px 20px; inset-block-start: 5px; max-inline-size: 90px; }
    .b3 { padding-inline-start: 7px; margin-block-end: 9px; border-inline-color: red green; border-inline-style: solid; border-inline-width: 2px 4px; }`,
  html: boxes(4),
  options: { assumeLtr: true },
  minConverted: 10,
});

equivalent('shorthands', {
  css: `
    .w { position: relative; height: 200px; }
    .b0 { position: absolute; inset: 10px 20px 30px; background: red; }
    .f { display: flex; flex-flow: column wrap-reverse; height: 80px; place-content: center end; place-items: center; }
    .f2 { display: flex; flex-flow: wrap; grid-gap: 4px 10px; width: 100px; }
    i { width: 30px; height: 20px; background: #ccc; place-self: end; }`,
  html: `<div class="w"><div class="b0"></div></div><div class="f">${flexItems}</div><div class="f2">${flexItems}${flexItems}</div>`,
  minConverted: 6,
});

equivalent(':is() expansion keeps the cascade', {
  css: `
    .a :is(.b, .c) { color: red; }
    .a .b { color: blue; }
    .a .c.d { color: green; }
    :is(h1, h2).x { color: orange; }
    h2.x { color: purple; }
    div:is(.e, .f) > span { color: teal; }`,
  html: '<div class="a"><p class="b">b</p><p class="c">c</p><p class="c d">cd</p></div><h1 class="x">h1</h1><h2 class="x">h2</h2><div class="e"><span>e</span></div><div class="f"><span>f</span></div>',
  minConverted: 3,
});

equivalent('var() fallback that can never apply', {
  css: `:root { --c: red; --w: 50px; } .y { --c: green; } .b0, .y .b1 { color: var(--c, blue); width: var(--w, 10px); height: 10px; background: var(--c, black); }`,
  html: '<div class="b0">x</div><div class="y"><div class="b1">y</div></div>',
  minConverted: 3,
});

equivalent('gameface-mode rewrites that are also browser-exact on a desktop screen', {
  css: `
    @media screen and (min-width: 600px) { .b0 { color: red; } }
    @media screen { .b1 { color: blue; } }
    @media print { .b2 { color: green; } }
    .b3 { padding-left: env(safe-area-inset-left, 20px); padding-top: env(titlebar-area-y, 7px); }`,
  html: boxes(4),
  options: { mode: 'gameface', disable: ['prune', 'supports'] },
  viewports: [[500, 400], [800, 400]],
  minConverted: 4,
});

test('steps(n, jump-start) samples like steps(n, start)', async () => {
  const css = '.b0 { animation: fade 1000ms steps(4, jump-start) paused; } .b1 { animation: fade 1000ms steps(3, jump-end) paused; } @keyframes fade { from { opacity: 0 } to { opacity: 1 } }';
  const { out } = rewrite(css);
  assert.match(out, /steps\(4, start\)/);
  const sample = (sheet) => evaluateWith(sheet, boxes(2), () => [...document.querySelectorAll('div')].map((el) => [0, 100, 249, 251, 500, 749, 751, 999].map((t) => {
    const a = el.getAnimations()[0];
    a.currentTime = t;
    return getComputedStyle(el).opacity;
  })));
  assert.deepEqual(await sample(out), await sample(css));
});

test('random colours: hsl, hwb, lab, oklch and color-mix match Chromium', async () => {
  const rand = mulberry32(7);
  const r = (a, b) => a + (b - a) * rand();
  const cases = [];
  for (let i = 0; i < 150; i++) cases.push(`hsl(${r(-360, 720).toFixed(2)} ${r(0, 100).toFixed(1)}% ${r(0, 100).toFixed(1)}% / ${r(0, 1).toFixed(2)})`);
  for (let i = 0; i < 100; i++) cases.push(`hwb(${r(0, 360).toFixed(1)} ${r(0, 60).toFixed(1)}% ${r(0, 60).toFixed(1)}%)`);
  for (let i = 0; i < 150; i++) cases.push(`oklch(${r(0.2, 0.9).toFixed(3)} ${r(0, 0.12).toFixed(3)} ${r(0, 360).toFixed(1)})`);
  for (let i = 0; i < 100; i++) cases.push(`lab(${r(10, 90).toFixed(1)}% ${r(-30, 30).toFixed(1)} ${r(-30, 30).toFixed(1)})`);
  const spaces = ['srgb', 'srgb-linear', 'oklab', 'lab', 'xyz', 'hsl', 'oklch', 'lch', 'hwb'];
  for (let i = 0; i < 150; i++) {
    const s = spaces[i % spaces.length];
    const hue = ['hsl', 'oklch', 'lch', 'hwb'].includes(s) && i % 3 === 0 ? ' longer hue' : '';
    cases.push(`color-mix(in ${s}${hue}, rgb(${(r(0, 255)) | 0} ${(r(0, 255)) | 0} ${(r(0, 255)) | 0} / ${r(0.2, 1).toFixed(2)}) ${r(0, 100).toFixed(0)}%, hsl(${r(0, 360).toFixed(0)} 70% 50%))`);
  }
  const pairs = [];
  for (const c of cases) {
    try {
      pairs.push([c, convertColor(c, { allowGamutMapping: false }).value]);
    } catch { /* outside sRGB: not converted in source mode */ }
  }
  assert.ok(pairs.length > 500, `only ${pairs.length} convertible`);
  const browser = await getBrowser();
  const page = await browser.newPage();
  // read both as computed CSS colours, then compare the exact channel values in Node
  const results = await page.evaluate((pairs) => {
    const el = document.createElement('div');
    document.body.append(el);
    const computed = (c) => { el.style.color = ''; el.style.color = c; return getComputedStyle(el).color; };
    return pairs.map(([a, b]) => [a, b, computed(a), computed(b)]);
  }, pairs);
  await page.close();
  const toRgb = converter('rgb');
  const channels = (text) => {
    const c = toRgb(parse(text));
    return [c.r, c.g, c.b].map((v) => Math.min(1, Math.max(0, v)) * 255).concat((c.alpha ?? 1) * 255);
  };
  // rgb() is 8-bit, so half a step of rounding is the best any conversion can do.
  // Chromium stores legacy rgba() alpha as 8 bits and prints it rounded, so alpha
  // is compared after 8-bit quantisation, which is also what gets painted.
  const bad = results.filter(([, , x, y]) => {
    const cx = channels(x);
    const cy = channels(y);
    if (Math.abs(Math.round(cx[3]) - Math.round(cy[3])) > 1) return true;
    // 0.6: the browser prints mixed colours with 6 digits and uses its own matrices, so a value on
    // a .5 boundary may round the other way; that is at most one 8-bit level when painted
    return cx.slice(0, 3).some((v, i) => Math.abs(v - cy[i]) > 0.6);
  });
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} of ${results.length} differ`);
});

test('random math: min/max/clamp/round/mod/rem/abs match Chromium', async () => {
  const rand = mulberry32(11);
  const n = () => (rand() * 400 - 200).toFixed(1) + 'px';
  const p = () => (rand() * 60 + 1).toFixed(1) + 'px';
  const exprs = [];
  for (let i = 0; i < 300; i++) {
    const k = i % 7;
    if (k === 0) exprs.push(`min(${n()}, ${n()}, ${n()})`);
    if (k === 1) exprs.push(`max(${n()}, ${n()})`);
    if (k === 2) exprs.push(`clamp(${n()}, ${n()}, ${n()})`);
    if (k === 3) exprs.push(`round(${['nearest', 'up', 'down', 'to-zero'][i % 4]}, ${n()}, ${p()})`);
    if (k === 4) exprs.push(`mod(${n()}, ${p()})`);
    if (k === 5) exprs.push(`rem(${n()}, ${p()})`);
    if (k === 6) exprs.push(`abs(calc(${n()} * 2 - ${p()}))`);
  }
  const css = exprs.map((e, i) => `.m${i} { margin-left: ${e}; }`).join('\n');
  const { out } = rewrite(css);
  const html = exprs.map((_, i) => `<div class="m${i}"></div>`).join('');
  const read = (sheet) => evaluateWith(sheet, html, () => [...document.querySelectorAll('div')].map((el) => parseFloat(getComputedStyle(el).marginLeft)));
  const a = await read(css);
  const b = await read(out);
  const bad = a.map((v, i) => [exprs[i], v, b[i]]).filter(([, x, y]) => Math.abs(x - y) > 0.01);
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} differ`);
});

test('random fluid expressions match Chromium at every width', async () => {
  const rand = mulberry32(23);
  const exprs = [];
  for (let i = 0; i < 40; i++) {
    const a = Math.round(rand() * 100);
    const d = a + Math.round(rand() * 300) + 1;
    const vw = (rand() * 20 + 0.5).toFixed(2);
    const off = Math.round(rand() * 80 - 40);
    const k = i % 4;
    if (k === 0) exprs.push(`clamp(${a}px, ${vw}vw, ${d}px)`);
    if (k === 1) exprs.push(`clamp(${a}px, calc(${vw}vw + ${off}px), ${d}px)`);
    if (k === 2) exprs.push(`min(${d}px, ${vw}vw, calc(${(vw / 2).toFixed(2)}vw + ${a}px))`);
    if (k === 3) exprs.push(`max(${a}px, min(${vw}vw, ${d}px))`);
  }
  const css = exprs.map((e, i) => `.v${i} { width: ${e}; height: 1px; }`).join('\n');
  const { out, report } = rewrite(css);
  assert.equal(report.entries.filter((e) => e.transform === 'fluid-math' && e.action === 'converted').length, exprs.length);
  const html = exprs.map((_, i) => `<div class="v${i}"></div>`).join('');
  const browser = await getBrowser();
  const pa = await browser.newPage();
  const pb = await browser.newPage();
  await pa.setContent(`<style>body{margin:0}${css}</style>${html}`);
  await pb.setContent(`<style>body{margin:0}${out}</style>${html}`);
  const bad = [];
  for (let w = 200; w <= 2600; w += 37) {
    await pa.setViewportSize({ width: w, height: 400 });
    await pb.setViewportSize({ width: w, height: 400 });
    const read = (page) => page.evaluate(() => [...document.querySelectorAll('div')].map((el) => el.getBoundingClientRect().width));
    const a = await read(pa);
    const b = await read(pb);
    a.forEach((v, i) => { if (Math.abs(v - b[i]) > 0.02) bad.push(`${w}px ${exprs[i]}: ${v} vs ${b[i]}`); });
  }
  await pa.close();
  await pb.close();
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} differ`);
});

/** Small deterministic PRNG so failures are reproducible. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
