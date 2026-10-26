// Gameface feature data.
//
// All support facts come from Coherent Labs' official `eslint-plugin-gameface`
// (MIT). We load its feature index through the same code path the linter uses,
// so "what we treat as unsupported" and "what the official linter flags" can
// never drift apart. The package's `exports` map only exposes its ESLint entry,
// so we import its internal modules by absolute path; `test/upstream.test.js`
// fails loudly if a new upstream release moves them.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pluginEntry = require.resolve('eslint-plugin-gameface');
const pluginSrc = dirname(pluginEntry);
const pluginRoot = dirname(pluginSrc);

const featuresModule = await import(pathToFileURL(join(pluginSrc, 'gameface-features', 'index.js')).href);
const loaderModule = await import(pathToFileURL(join(pluginSrc, 'gameface-features', 'catalog-loader.js')).href);
const deltaModule = await import(pathToFileURL(join(pluginSrc, 'gameface-features', 'delta.js')).href);
const svgModule = await import(pathToFileURL(join(pluginSrc, 'data', 'gameface-svg-support.js')).href);

/** Upstream SVG rules: stroke-dash only works on <path>; some keyframe props need units. */
export const svgSupport = {
  /** @type {(selector: string) => boolean} */
  targetsNonPathShape: svgModule.cssSelectorTargetsNonPathSvgShape,
  /** @type {Set<string>} */
  pathOnlyProperties: new Set(svgModule.PATH_ONLY_STROKE_DASH_PROPERTIES),
  /** @type {Set<string>} */
  keyframeUnitProperties: new Set(svgModule.KEYFRAME_PROPERTIES_REQUIRE_UNITS),
};

/** Version of the official plugin whose data we are using. */
export const UPSTREAM_VERSION = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version;

/** Absolute path of the upstream `gameface-features/` directory. */
export const FEATURES_ROOT = join(pluginRoot, 'gameface-features');

const manifest = loaderModule.readManifest(FEATURES_ROOT);

/** Every Gameface version the bundled data can reconstruct, newest first. */
export const KNOWN_VERSIONS = manifest ? [...(manifest.chain ?? [manifest.base])] : [];

/** Newest Gameface version described by the bundled data. */
export const LATEST_VERSION = manifest?.base ?? 'latest';

/**
 * Pseudo selectors whose catalog entry carries an argument (e.g. `:has(.child)`)
 * are tracked by their bare name: the engine rejects the pseudo itself, whatever
 * its argument. Entries that only differ by argument share one name.
 * @param {string} text
 */
function pseudoBaseName(text) {
  const t = text.trim().toLowerCase();
  const paren = t.indexOf('(');
  return paren === -1 ? t : t.slice(0, paren);
}

const cache = new Map();

/**
 * @typedef {object} PartialProperty
 * @property {Set<string>} disallowed lower-case keywords the engine rejects
 * @property {Set<string>} supported lower-case keywords the engine accepts
 * @property {Record<string, unknown>} evidence raw catalog evidence
 */

/**
 * @typedef {object} Features
 * @property {string} version resolved Gameface version
 * @property {boolean} exactVersion false when the requested version fell back to the nearest known one
 * @property {Set<string>} unsupportedProperties
 * @property {Map<string, PartialProperty>} partialProperties
 * @property {Set<string>} unsupportedFunctions
 * @property {Set<string>} unsupportedPseudos bare pseudo names, e.g. `:has`, `::marker`
 * @property {Set<string>} unsupportedAtRules at-rule names without `@`, e.g. `container`
 * @property {Map<string, Record<string, unknown>>} partialSelectors catalog text -> evidence
 * @property {Set<string>} knownPseudos every pseudo the catalog mentions (supported or not)
 * @property {Map<string, Record<string, any>>} functionRows raw catalog rows of unsupported functions
 * @property {Map<string, Array<Record<string, any>>>} catalogs raw catalog files for this version
 * @property {object} raw the official feature index
 */

/**
 * Loads the feature set for a Gameface version (`'latest'` by default).
 * @param {string} [requested]
 * @returns {Features}
 */
export function getFeatures(requested = 'latest') {
  const key = requested || 'latest';
  if (cache.has(key)) return cache.get(key);

  let version = LATEST_VERSION;
  let exactVersion = true;
  if (manifest) {
    const resolution = deltaModule.resolveVersion(key, manifest);
    version = resolution.version;
    exactVersion = resolution.exact;
  }

  const raw = featuresModule.getFeatureIndex(version);
  const catalogs = loaderModule.loadCatalogs(FEATURES_ROOT, manifest, version);
  const functionRows = new Map();
  for (const row of catalogs.get('functions/unsupported.json') ?? []) {
    if (typeof row.name === 'string') functionRows.set(row.name.toLowerCase(), row);
  }

  /** @type {Map<string, PartialProperty>} */
  const partialProperties = new Map();
  for (const [name, evidence] of raw.cssPropertiesPartial) {
    const supported = new Set((evidence.supportedValues ?? []).map((v) => String(v).toLowerCase()));
    const disallowed = new Set();
    for (const v of [...(evidence.unsupportedValues ?? []), ...(evidence.logRejectedValues ?? [])]) {
      disallowed.add(String(v).toLowerCase());
    }
    for (const v of supported) disallowed.delete(v);
    partialProperties.set(name, { disallowed, supported, evidence });
  }

  const unsupportedPseudos = new Set();
  const unsupportedAtRules = new Set();
  const knownPseudos = new Set();
  for (const text of raw.selectorNamesUnsupported) {
    const t = text.trim();
    if (t.startsWith('@')) {
      unsupportedAtRules.add(t.slice(1).split(/[\s(]/)[0].toLowerCase());
    } else if (t.startsWith(':')) {
      const base = pseudoBaseName(t);
      unsupportedPseudos.add(base);
      knownPseudos.add(base);
    }
  }
  for (const text of [...raw.selectorNamesSupported, ...raw.selectorNamesPartial.keys()]) {
    const t = text.trim();
    if (t.startsWith(':')) knownPseudos.add(pseudoBaseName(t));
  }

  /** @type {Features} */
  const features = {
    version,
    exactVersion,
    unsupportedProperties: new Set(raw.cssPropertiesUnsupported),
    partialProperties,
    unsupportedFunctions: new Set(raw.cssFunctionsUnsupported),
    unsupportedPseudos,
    unsupportedAtRules,
    partialSelectors: new Map(raw.selectorNamesPartial),
    knownPseudos,
    functionRows,
    catalogs,
    raw,
  };
  cache.set(key, features);
  return features;
}

/**
 * Lower-cases a property name and strips a vendor prefix-free form for lookup.
 * Custom properties are returned unchanged.
 * @param {string} prop
 */
export function normalizeProperty(prop) {
  if (prop.startsWith('--')) return prop;
  return prop.toLowerCase();
}

/**
 * @param {Features} features
 * @param {string} prop
 */
export function isPropertyUnsupported(features, prop) {
  const p = normalizeProperty(prop);
  if (p.startsWith('--')) return false;
  return features.unsupportedProperties.has(p);
}

/**
 * Whether the engine rejects keyword `keyword` for property `prop`.
 * @param {Features} features
 * @param {string} prop
 * @param {string} keyword
 */
export function isKeywordRejected(features, prop, keyword) {
  const partial = features.partialProperties.get(normalizeProperty(prop));
  if (!partial) return false;
  return partial.disallowed.has(keyword.toLowerCase());
}

/**
 * Whether the engine accepts keyword `keyword` for property `prop`
 * (true when the property is fully supported or the keyword is not rejected).
 * @param {Features} features
 * @param {string} prop
 * @param {string} keyword
 */
export function isKeywordAccepted(features, prop, keyword) {
  if (isPropertyUnsupported(features, prop)) return false;
  return !isKeywordRejected(features, prop, keyword);
}

/**
 * @param {Features} features
 * @param {string} name
 */
export function isFunctionUnsupported(features, name) {
  return features.unsupportedFunctions.has(name.toLowerCase());
}

/**
 * Whether a category marker such as `number` or `percentage` is listed as rejected
 * for a property. The upstream linter ignores these markers (it only compares
 * identifiers), but they describe real engine behaviour, so we act on the ones
 * whose meaning is unambiguous.
 * @param {Features} features
 * @param {string} prop
 * @param {string} marker
 */
export function isMarkerRejected(features, prop, marker) {
  return isKeywordRejected(features, prop, marker);
}
