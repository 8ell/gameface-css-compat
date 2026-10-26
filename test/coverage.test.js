// The "100%" guarantee, checked item by item against the official catalog:
// for every unsupported property, rejected value, function, selector and
// documented restriction, the gameface-mode output must lint clean with
// Coherent's own eslint-plugin-gameface, and must be stable when processed again.
// The catalog comes from the installed upstream package, so new upstream data is
// covered without editing this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { runCoverage } from '../src/coverage.js';
import { transformCss, KNOWN_VERSIONS } from '../src/index.js';
import { createContext } from '../src/engine.js';
import { rejection } from '../src/transforms/prune.js';
import { errorsOf, officialLint } from './helpers/official-lint.js';

for (const version of KNOWN_VERSIONS) {
  test(`every catalog item lints clean after gameface mode (Gameface ${version})`, async () => {
    const rows = runCoverage({ version });
    assert.ok(rows.length > 500, `expected the full catalog, got ${rows.length} samples`);
    const failures = [];
    for (const row of rows) {
      const errors = errorsOf(await officialLint(row.output || '/* empty */', { version }));
      if (errors.length) failures.push(`${row.id}\n  in:  ${row.input}\n  out: ${row.output}\n  ${errors.map((e) => `${e.ruleId}: ${e.message}`).join('\n  ')}`);
    }
    assert.equal(failures.length, 0, failures.join('\n'));
  });
}

test('nothing left in the output is something Gameface rejects (stricter than the linter)', () => {
  for (const row of runCoverage()) {
    const root = postcss.parse(row.output);
    const ctx = createContext({ mode: 'gameface' }, [root]);
    root.walkDecls((decl) => {
      const why = rejection(ctx, decl);
      assert.equal(why, null, `${row.id}: ${decl.toString()} -> ${why?.feature}`);
    });
  }
});

test('every catalog item is handled: converted, removed, or already accepted', () => {
  const rows = runCoverage();
  for (const row of rows) {
    assert.ok(['converted', 'mixed', 'removed', 'unchanged'].includes(row.outcome), row.id);
    if (row.outcome === 'removed' || row.outcome === 'mixed') assert.ok(row.reasons.length > 0, `${row.id} has no reason`);
  }
  // the converted set never shrinks silently: these are guaranteed by the transforms
  const converted = new Set(rows.filter((r) => r.outcome === 'converted' || r.outcome === 'mixed').map((r) => r.id));
  for (const id of ['property:inset', 'property:margin-inline', 'property:place-content', 'property:flex-flow', 'function:hsl', 'function:oklch', 'function:color-mix', 'function:clamp', 'function:min', 'function:max', 'function:skew', 'function:rect', 'function:env', 'value:font-weight:number', 'value:justify-content:normal']) {
    assert.ok(converted.has(id), `${id} should be converted`);
  }
});

test('every sample is idempotent', () => {
  for (const row of runCoverage()) {
    const again = transformCss(row.output, { mode: 'gameface', complete: true }).css.trim();
    assert.equal(again, row.output, row.id);
  }
});
