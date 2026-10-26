import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../helpers/run.js';

const out = (css, options) => run(css, options).css;

test('logical properties map to physical ones (gameface is always LTR)', () => {
  assert.equal(out('.a{margin-inline:1px 2px;padding-block:3px}'), '.a{margin-left:1px;margin-right:2px;padding-top:3px;padding-bottom:3px}');
  assert.equal(out('.a{inline-size:10px;max-block-size:5px}'), '.a{width:10px;max-height:5px}');
  assert.equal(out('.a{border-inline-start:1px solid red}'), '.a{border-left:1px solid red}');
  assert.equal(out('.a{border-block:1px solid red}'), '.a{border-top:1px solid red;border-bottom:1px solid red}');
  assert.equal(out('.a{border-start-end-radius:4px}'), '.a{border-top-right-radius:4px}');
  assert.equal(out('.a{inset-inline:1px 2px}'), '.a{left:1px;right:2px}');
});

test('logical properties stay in source mode unless LTR is promised', () => {
  assert.equal(out('.a{margin-inline:1px 2px}', { mode: 'source' }), '.a{margin-inline:1px 2px}');
  assert.equal(out('.a{margin-inline:1px 2px}', { mode: 'source', assumeLtr: true }), '.a{margin-left:1px;margin-right:2px}');
});

test('a var() in a two-value logical shorthand is not split', () => {
  const { report } = run('.a{margin-inline:var(--m)}', { mode: 'source', assumeLtr: true });
  assert.ok(report.entries.some((e) => e.action === 'kept' && /var\(\)/.test(e.reason)));
});

test('shorthands expand exactly', () => {
  assert.equal(out('.a{inset:0}'), '.a{top:0;right:0;bottom:0;left:0}');
  assert.equal(out('.a{inset:1px 2px 3px}'), '.a{top:1px;right:2px;bottom:3px;left:2px}');
  assert.equal(out('.a{flex-flow:column}'), '.a{flex-direction:column;flex-wrap:nowrap}');
  assert.equal(out('.a{flex-flow:wrap-reverse row-reverse}'), '.a{flex-direction:row-reverse;flex-wrap:wrap-reverse}');
  assert.equal(out('.a{place-content:center space-evenly}'), '.a{align-content:center;justify-content:space-evenly}');
  assert.equal(out('.a{grid-gap:4px 8px}'), '.a{gap:4px 8px}');
  assert.equal(out('.a{inset:inherit !important}'), '.a{top:inherit !important;right:inherit !important;bottom:inherit !important;left:inherit !important}');
});

test('place-content: normal expands and then maps the flex keywords', () => {
  assert.equal(out('.a{place-content:normal}'), '.a{align-content:stretch;justify-content:flex-start}');
});

test('keyword values with exact equivalents', () => {
  assert.equal(out('.a{font-weight:700}'), '.a{font-weight:bold}');
  assert.equal(out('.a{font-weight:400}'), '.a{font-weight:normal}');
  assert.equal(out('.a{font:italic 700 16px/1.2 serif}'), '.a{font:italic bold 16px/1.2 serif}');
  assert.equal(out('.a{justify-content:stretch;align-items:normal}'), '.a{justify-content:flex-start;align-items:stretch}');
  assert.equal(out('.a{text-align:end}'), '.a{text-align:right}');
  assert.equal(out('.a{text-decoration-thickness:15%}'), '.a{text-decoration-thickness:0.15em}');
  assert.equal(out('.a{font-style:oblique 14deg}'), '.a{font-style:oblique}');
  assert.equal(out('.a{transition:opacity 1s steps(3,jump-start)}'), '.a{transition:opacity 1s steps(3,start)}');
});

test('numeric font weights without an equivalent are removed in gameface mode, reported in source mode', () => {
  assert.equal(out('.a{font-weight:600;color:red}'), '.a{color:red}');
  const { css, report } = run('.a{font-weight:600}', { mode: 'source' });
  assert.equal(css, '.a{font-weight:600}');
  assert.ok(report.entries.some((e) => e.action === 'kept' && e.feature === 'value:font-weight:number'));
});

test('approximations are off by default and work when enabled', () => {
  assert.equal(out('.a{font-weight:600;color:red}', { approximations: ['font-weight-nearest'] }), '.a{font-weight:bold;color:red}');
  assert.equal(out('.a{justify-content:start}', { approximations: ['flex-start-end-assume-no-reverse'] }), '.a{justify-content:flex-start}');
  assert.equal(out('.a{outline:2px solid red}', { approximations: ['outline-to-box-shadow'] }), '.a{box-shadow:0 0 0 2px red}');
});

test('colour functions', () => {
  // legacy colours only: the gradient already interpolates in sRGB
  assert.equal(out('.a{background:linear-gradient(hwb(0 0% 0%),hsl(240 100% 50%))}'), '.a{background:linear-gradient(rgb(255,0,0),rgb(0,0,255))}');
  // a non-legacy colour makes the gradient interpolate in Oklab: it is resampled into rgb() stops
  const g = out('.a{background:linear-gradient(hwb(0 0% 0%),oklab(0.5 0.1 0.1))}');
  assert.match(g, /^\.a\{background:linear-gradient\(rgb\(255,0,0\) 0%,(rgb\(\d+,\d+,\d+\) [\d.]+%,)+rgb\(161,66,3\) 100%\)\}$/);
  assert.equal(out('.a{--c:hsl(0 100% 50%)}'), '.a{--c:rgb(255,0,0)}');
});

test('math functions with one unit fold; others stay for the fluid rewrite or are removed', () => {
  assert.equal(out('.a{width:max(10px,2in)}'), '.a{width:192px}');
  assert.equal(out('.a{transform:rotate(atan2(1,1))}'), '.a{transform:rotate(45deg)}');
  assert.equal(out('.a{width:min(10%,2em);color:red}'), '.a{color:red}');
});

test('transform functions', () => {
  assert.equal(out('.a{transform:skew(10deg)}'), '.a{transform:skewX(10deg)}');
  assert.equal(out('.a{transform:skew(0,5deg)}'), '.a{transform:skewY(5deg)}');
  assert.equal(out('.a{transform:skew(45deg,45deg)}'), '.a{transform:matrix(1,1,1,1,0,0)}');
  assert.equal(out('.a{transform:perspective(500px) rotateY(10deg)}'), '.a{transform:matrix3d(1,0,0,0,0,1,0,0,0,0,1,-0.002,0,0,0,1) rotateY(10deg)}');
});

test('skew(a, b) and perspective() are kept when transform can be interpolated', () => {
  const css = '.a{transform:skew(10deg,20deg);transition:transform 1s}';
  assert.equal(out(css, { mode: 'source' }), '.a{transform:skew(10deg,20deg);transition:transform 1s}');
  const partial = '.a{transform:perspective(100px)}';
  assert.equal(out(partial, { mode: 'source', complete: false }), '.a{transform:perspective(100px)}');
});

test('basic shapes', () => {
  assert.equal(out('.a{clip-path:rect(10% 90% 80% 0)}'), '.a{clip-path:inset(10% 10% 20% 0)}');
  assert.equal(out('.a{clip-path:xywh(10% 20% 50% 30%)}'), '.a{clip-path:inset(20% 40% 50% 10%)}');
  assert.equal(out('.a{clip-path:rect(0 10px 10px 0)}'), ''); // needs calc(100% - 10px): removed
});

test('gradient colour stops with two positions are split', () => {
  assert.equal(out('.a{background-image:linear-gradient(90deg,red 0 10px,blue 10px 20px)}'), '.a{background-image:linear-gradient(90deg,red 0,red 10px,blue 10px,blue 20px)}');
});

test('env() in a game view', () => {
  assert.equal(out('.a{padding-top:env(safe-area-inset-top,20px)}'), '.a{padding-top:0px}');
  assert.equal(out('.a{top:env(titlebar-area-y,8px)}'), '.a{top:8px}');
  assert.equal(out('.a{top:env(safe-area-inset-top)}', { mode: 'source' }), '.a{top:env(safe-area-inset-top)}');
});

test('var() fallbacks', () => {
  assert.equal(out(':root{--c:red}.a{color:var(--c,blue)}'), ':root{--c:red}.a{color:var(--c)}');
  // not defined on :root: the fallback may apply, so Gameface would drop the declaration
  assert.equal(out('.b{--c:red}.a{color:var(--c,blue)}'), '.b{--c:red}');
  // closed world: never defined anywhere, so the fallback always applies
  assert.equal(out('.a{color:var(--x,blue)}', { closedWorld: true }), '.a{color:blue}');
  // a variable that is sometimes reset to guaranteed-invalid keeps its fallback meaning
  assert.equal(out(':root{--c:red}.x{--c:initial}.a{color:var(--c,blue)}', { mode: 'source' }), ':root{--c:red}.x{--c:initial}.a{color:var(--c,blue)}');
  // per-file processing cannot know
  assert.equal(out(':root{--c:red}.a{color:var(--c,blue)}', { mode: 'source', complete: false }), ':root{--c:red}.a{color:var(--c,blue)}');
});

test('keyframes: calc() is folded, var() is inlined only in a closed world', () => {
  assert.equal(out('@keyframes k{to{width:calc(10px + 2px)}}'), '@keyframes k{to{width:12px}}');
  assert.equal(out(':root{--w:10px}@keyframes k{to{width:var(--w)}}', { closedWorld: true }), ':root{--w:10px}@keyframes k{to{width:10px}}');
  assert.equal(out(':root{--w:10px}@keyframes k{to{width:var(--w)}}'), ':root{--w:10px}');
});

test('media types resolve to screen', () => {
  assert.equal(out('@media screen and (min-width:600px){.a{color:red}}'), '@media (min-width:600px){.a{color:red}}');
  assert.equal(out('@media screen{.a{color:red}}'), '.a{color:red}');
  assert.equal(out('@media print{.a{color:red}}.b{color:blue}'), '.b{color:blue}');
  assert.equal(out('@media print,(min-width:1px){.a{color:red}}'), '@media (min-width:1px){.a{color:red}}');
  assert.equal(out('@media not print{.a{color:red}}'), '.a{color:red}');
  assert.equal(out('@page{margin:1in}.b{color:blue}'), '.b{color:blue}');
});

test('@supports is evaluated against Gameface', () => {
  assert.equal(out('@supports (display:grid){.a{display:grid}}@supports not (display:grid){.a{display:flex}}'), '.a{display:flex}');
  assert.equal(out('@supports (color:red) and (selector(:has(a))){.a{color:red}}'), '');
  assert.equal(out('@supports (color:red) or (float:left){.a{color:red}}'), '.a{color:red}');
});

test('selectors: :is() expands when specificity is equal', () => {
  assert.equal(out('.a :is(.b,.c){color:red}'), '.a .b,.a .c{color:red}');
  assert.equal(out(':is(h1,h2).x{color:red}'), 'h1.x,h2.x{color:red}');
  assert.equal(out('div:is(span,p){color:red}'), '');
  const { css, report } = run('.a :is(.b,#c){color:red}', { mode: 'source' });
  assert.equal(css, '.a :is(.b,#c){color:red}');
  assert.ok(report.entries.some((e) => e.action === 'kept' && /specificity/.test(e.reason)));
});

test('selectors: unsupported branches are dropped from lists in gameface mode', () => {
  assert.equal(out('.a:has(.b),.c{color:red}'), '.c{color:red}');
  assert.equal(out('.a:not(.b){color:red}.d{color:blue}'), '.d{color:blue}');
  assert.equal(out('.a::selection{color:red;font-weight:bold}'), '.a::selection{color:red}');
  assert.equal(out('li:nth-child(2 of .x){color:red}'), '');
  assert.equal(out('li:nth-child(2){color:red}'), 'li:nth-child(2){color:red}');
});

test('svg stroke dashes only stay on <path>', () => {
  assert.equal(out('circle,path{stroke-dasharray:4;fill:red}'), 'path{stroke-dasharray:4;fill:red}circle{fill:red}');
});

test('unsupported at-rules are removed in gameface mode', () => {
  assert.equal(out('@container (min-width:1px){.a{color:red}}.b{color:blue}'), '.b{color:blue}');
});

test('calc() mixing % and lengths is removed in gameface mode', () => {
  assert.equal(out('.a{width:calc(100% - 20px);height:10px}'), '.a{height:10px}');
});

test('the pipeline is idempotent', () => {
  const css = '.a{inset:0 1px;color:hsl(0 100% 50%);width:clamp(10px,5vw,100px);transform:skew(10deg)} :is(.b,.c){margin-inline:1px} @media screen{.d{place-items:center}}';
  for (const mode of ['gameface', 'source']) {
    const once = out(css, { mode });
    assert.equal(out(once, { mode }), once, mode);
  }
});

test('SCSS syntax is left alone', () => {
  assert.equal(out('.a{color:hsl($h, 50%, 50%);width:min(#{$x}, 10px)}', { mode: 'source' }), '.a{color:hsl($h,50%,50%);width:min(#{$x},10px)}');
});

test('options are validated', () => {
  assert.throws(() => run('', { mode: 'web' }), /Unknown mode/);
  assert.throws(() => run('', { approximations: ['nope'] }), /Unknown approximation/);
});
