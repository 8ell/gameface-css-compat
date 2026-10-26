// Guards the coupling to eslint-plugin-gameface internals. If a new upstream
// release moves or reshapes them, this fails and the automated update PR is not merged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURES_ROOT, KNOWN_VERSIONS, LATEST_VERSION, UPSTREAM_VERSION, getFeatures, svgSupport } from '../src/features.js';

test('upstream data is present and versioned', () => {
  assert.match(UPSTREAM_VERSION, /^\d+\.\d+\.\d+/);
  assert.ok(existsSync(join(FEATURES_ROOT, 'versions', 'manifest.json')));
  assert.ok(KNOWN_VERSIONS.includes(LATEST_VERSION));
});

test('every known version loads with non-trivial data', () => {
  for (const v of KNOWN_VERSIONS) {
    const f = getFeatures(v);
    assert.equal(f.version, v);
    assert.ok(f.unsupportedProperties.size > 100, `${v}: properties`);
    assert.ok(f.partialProperties.size > 20, `${v}: partial properties`);
    assert.ok(f.unsupportedFunctions.size > 10, `${v}: functions`);
    assert.ok(f.unsupportedPseudos.size > 20, `${v}: selectors`);
    assert.ok(f.functionRows.size > 0, `${v}: function rows`);
  }
});

test('unknown versions fall back to the nearest known one', () => {
  const f = getFeatures('3.1.3.9');
  assert.equal(f.exactVersion, false);
  assert.ok(KNOWN_VERSIONS.includes(f.version));
});

test('svg support helpers are wired', () => {
  assert.equal(typeof svgSupport.targetsNonPathShape, 'function');
  assert.ok(svgSupport.pathOnlyProperties.has('stroke-dasharray'));
  assert.ok(svgSupport.targetsNonPathShape('circle'));
  assert.ok(!svgSupport.targetsNonPathShape('path'));
});
