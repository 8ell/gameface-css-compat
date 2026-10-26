import { test } from 'node:test';
import assert from 'node:assert/strict';
import valueParser from 'postcss-value-parser';
import { evaluateFunction, formatSingle, NotFoldable } from '../../src/math.js';

const fold = (text, opts) => formatSingle(evaluateFunction(valueParser(text).nodes[0], opts));

test('min, max and clamp with one unit', () => {
  assert.equal(fold('min(10px, 20px)'), '10px');
  assert.equal(fold('max(1in, 90px)'), '96px');
  assert.equal(fold('clamp(1px, 5px, 3px)'), '3px');
  assert.equal(fold('clamp(1em, 0.5em, 3em)'), '1em');
  assert.equal(fold('min(30%, 10%)'), '10%');
});

test('nested arithmetic', () => {
  assert.equal(fold('max(calc(10px * 2), 15px)'), '20px');
  assert.equal(fold('min(calc(100px / 4 + 1px), 99px)'), '26px');
  assert.equal(fold('calc(2*3px)'), '6px');
});

test('round, mod, rem follow CSS Values 4', () => {
  assert.equal(fold('round(14px, 4px)'), '16px'); // nearest; tie goes up
  assert.equal(fold('round(13px, 4px)'), '12px');
  assert.equal(fold('round(down, 15px, 4px)'), '12px');
  assert.equal(fold('round(up, 13px, 4px)'), '16px');
  assert.equal(fold('round(to-zero, -13px, 4px)'), '-12px');
  assert.equal(fold('mod(-7px, 3px)'), '2px');
  assert.equal(fold('rem(-7px, 3px)'), '-1px');
  assert.equal(fold('abs(-100px)'), '100px');
});

test('trigonometry returns degrees', () => {
  assert.equal(fold('acos(1)'), '0deg');
  assert.equal(fold('atan(1)'), '45deg');
  assert.equal(fold('atan2(1px, 1px)'), '45deg');
  assert.equal(fold('asin(1)'), '90deg');
});

test('mixed units are not folded', () => {
  assert.throws(() => fold('min(10px, 5vw)'), NotFoldable);
  assert.throws(() => fold('min(1em, 1rem)'), NotFoldable);
  assert.throws(() => fold('min(0, 10px)'), NotFoldable); // unitless 0 is a number, not a length
  assert.throws(() => fold('max(10px, 2s)'), NotFoldable);
});

test('rem folds to px only when the root font size is known', () => {
  assert.throws(() => fold('max(1rem, 10px)'), NotFoldable);
  assert.equal(fold('max(1rem, 10px)', { rem: 16 }), '16px');
});

test('a zero of another unit of the same type adopts the unit', () => {
  assert.equal(fold('max(0em, 10px)'), '10px');
});
