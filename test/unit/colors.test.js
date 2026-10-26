import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertColor, NotConvertible } from '../../src/colors.js';

const c = (t, allowGamutMapping = false) => convertColor(t, { allowGamutMapping }).value;

test('hsl and hwb are exact sRGB', () => {
  assert.equal(c('hsl(0, 100%, 50%)'), 'rgb(255, 0, 0)');
  assert.equal(c('hsl(210 80% 50%)'), 'rgb(26, 128, 230)'); // matches Chromium's rounding
  assert.equal(c('hsla(120, 100%, 25%, 0.5)'), 'rgba(0, 128, 0, 0.5)');
  assert.equal(c('hsl(0 0% 50% / 25%)'), 'rgba(128, 128, 128, 0.25)');
  assert.equal(c('hwb(0 0% 0%)'), 'rgb(255, 0, 0)');
  assert.equal(c('hwb(120 10% 20%)'), 'rgb(26, 204, 26)');
});

test('lab/oklch inside sRGB convert; outside are refused unless gamut mapping is allowed', () => {
  assert.equal(c('oklch(0.7 0.1 30)'), 'rgb(213, 134, 121)');
  assert.throws(() => c('oklch(0.7 0.4 30)'), NotConvertible);
  assert.match(c('oklch(0.7 0.4 30)', true), /^rgb\(/);
});

test('color-mix follows CSS Color 5', () => {
  assert.equal(c('color-mix(in srgb, red, blue)'), 'rgb(128, 0, 128)');
  assert.equal(c('color-mix(in srgb, red 25%, blue)'), 'rgb(64, 0, 191)');
  assert.equal(c('color-mix(in srgb, red 25%, blue 25%)'), 'rgba(128, 0, 128, 0.5)'); // sum < 100% scales alpha
  assert.equal(c('color-mix(in srgb, transparent, red)'), 'rgba(255, 0, 0, 0.5)'); // premultiplied
});

test('non-constant colours are refused', () => {
  assert.throws(() => c('hsl(var(--h) 50% 50%)'), NotConvertible);
  assert.throws(() => c('hsl(from var(--c) h s l)'), NotConvertible);
  assert.throws(() => c('rgb(from currentcolor r g b)'), NotConvertible);
  assert.throws(() => c('oklch(from red l c calc(h + 90deg))'), NotConvertible); // h is a number, not an angle
  assert.throws(() => c('color-mix(in srgb, currentcolor, red)'), NotConvertible);
});

test('relative colours with a constant origin resolve', () => {
  assert.equal(c('rgb(from red r g b / 50%)'), 'rgba(255, 0, 0, 0.5)');
  assert.equal(c('hsl(from #3366cc calc(h + 180) s l)'), 'rgb(204, 153, 51)');
  assert.equal(c('hwb(from red h 20% b)'), 'rgb(255, 51, 51)');
  assert.equal(c('rgb(from hsl(120 100% 25%) calc(r * 2) g b)'), 'rgb(0, 128, 0)');
  assert.equal(c('rgb(from #102030 calc(r * 20) g b)'), 'rgb(255, 32, 48)'); // rgb() clamps
});
