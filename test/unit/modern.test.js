import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../helpers/run.js';

const out = (css, options) => run(css, options).css;

test('initial is replaced by the initial value', () => {
  assert.equal(out('.a{padding-top:initial;flex-shrink:initial;transform:initial !important}'), '.a{padding-top:0;flex-shrink:1;transform:none !important}');
  assert.equal(out('.a{background-color:initial}', { mode: 'source' }), '.a{background-color:transparent}');
  // colour's initial value depends on the user agent: not rewritten
  assert.equal(out('.a{color:initial}', { mode: 'source' }), '.a{color:initial}');
});

test('catalog value rewrites', () => {
  assert.equal(out('.a{opacity:50%}'), '.a{opacity:0.5}');
  assert.equal(out('@keyframes k{from{opacity:12.5%}}'), '@keyframes k{from{opacity:0.125}}');
  assert.equal(out('path{stroke-dasharray:none}'), 'path{stroke-dasharray:0}');
  assert.equal(out('.a{animation-duration:auto}'), '.a{animation-duration:0s}');
  assert.equal(out('.a{animation-duration:auto}', { mode: 'source' }), '.a{animation-duration:auto}');
  // percentages are listed for border radii too, but the data also lists % as supported there
  assert.equal(out('.a{border-top-left-radius:50%}'), '.a{border-top-left-radius:50%}');
});

test('straight-line linear() easings become linear', () => {
  assert.equal(out('.a{transition-timing-function:linear(0, 0.25, 0.5, 0.75, 1)}'), '.a{transition-timing-function:linear}');
  assert.equal(out('.a{transition:opacity 1s linear(0, 1)}', { mode: 'source' }), '.a{transition:opacity 1s linear}');
  assert.equal(out('.a{animation-timing-function:linear(0 0%, 0.5 50%, 1 100%)}'), '.a{animation-timing-function:linear}');
  assert.equal(out('.a{animation-timing-function:linear(0, 0.5 25% 75%, 1)}', { mode: 'source' }), '.a{animation-timing-function:linear(0,0.5 25% 75%,1)}');
});

test('pseudo-class aliases keep the element set and specificity', () => {
  assert.equal(out('li:first-of-type,li:last-of-type{color:red}'), 'li:nth-of-type(1),li:nth-last-of-type(1){color:red}');
  assert.equal(out(':scope > .a{color:red}'), ':root > .a{color:red}');
  assert.equal(out('li:first-of-type{color:red}', { mode: 'source' }), 'li:nth-of-type(1){color:red}');
});

test('nesting is flattened in gameface mode only', () => {
  assert.equal(out('.a{color:red;&:hover{color:blue}.b &{color:green}}'), '.a{color:red;}.a:hover{color:blue}.b .a{color:green}');
  assert.equal(out('.a,.b{& .c{color:red}}'), '.a .c,.b .c{color:red}');
  assert.equal(out('.a{@media (min-width:600px){color:red}}'), '@media (min-width:600px){.a{color:red;}}');
  assert.equal(out('.a{&:hover{color:blue}}', { mode: 'source' }), '.a{&:hover{color:blue}}');
});

test('media range syntax becomes min-/max- features', () => {
  assert.equal(out('@media (width >= 600px){.a{color:red}}'), '@media (min-width:600px){.a{color:red}}');
  assert.equal(out('@media screen and (400px <= width <= 700px){.a{color:red}}'), '@media (min-width:400px) and (max-width:700px){.a{color:red}}');
  assert.equal(out('@media (height <= 500px), (16/9 <= aspect-ratio){.a{color:red}}'), '@media (max-height:500px),(min-aspect-ratio:16/9){.a{color:red}}');
  const strict = run('@media (width < 600px){.a{color:red}}');
  assert.equal(strict.css, '@media (width < 600px){.a{color:red}}');
  assert.ok(strict.report.entries.some((e) => e.feature === 'syntax:media-range' && e.action === 'kept'));
});

test('light-dark(), relative colours and unit aliases', () => {
  assert.equal(out('.a{color:light-dark(#111, #eee)}'), '.a{color:#111}');
  assert.equal(out('.a{color:rgb(from red r g b / 50%)}'), '.a{color:rgba(255,0,0,0.5)}');
  // a variable origin cannot be resolved; Gameface rejects hsl(), so it is removed and reported
  const dynamic = run('.a{color:hsl(from var(--c) h s l)}');
  assert.equal(dynamic.css, '');
  assert.ok(dynamic.report.entries.some((e) => e.feature === 'syntax:relative-color' && e.action === 'kept'));
  assert.equal(out('.a{height:100dvh;width:50svw;min-height:10lvh;padding-left:2vi;padding-top:1vb}'), '.a{height:100vh;width:50vw;min-height:10vh;padding-left:2vw;padding-top:1vh}');
  assert.equal(out('.a{width:10cqw;margin-top:1cm;margin-left:2pc;background:url(a.cm)}'), '.a{width:10vw;margin-top:37.795276px;margin-left:32px;background:url(a.cm)}');
  assert.equal(out('.a{height:100dvh}', { mode: 'source' }), '.a{height:100dvh}');
});

test('individual transforms merge only as an approximation', () => {
  assert.equal(out('.a{translate:10px 20px;rotate:45deg;scale:2}'), '.a{}'.replace('.a{}', ''));
  const opts = { approximations: ['individual-transforms'] };
  assert.equal(out('.a{transform:skewX(10deg);scale:50%;translate:10px}', opts), '.a{transform:translate(10px) scale(0.5) skewX(10deg)}');
  assert.equal(out('.a{rotate:x 30deg}', opts), '.a{transform:rotateX(30deg)}');
});

test('new rewrites are idempotent', () => {
  const css = '.a{&:hover{opacity:50%;color:light-dark(red,blue)}}@media (width >= 1px){.b{height:10dvh;padding-top:initial}}li:first-of-type{transition-timing-function:linear(0,1)}';
  const once = run(css).raw;
  assert.equal(run(once).raw, once);
});
