import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import postcssScss from 'postcss-scss';
import stylelint from 'stylelint';
import { build } from 'vite';
import gamefaceCompat from '../src/postcss.js';
import gamefaceVite from '../src/vite.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PLUGIN = fileURLToPath(new URL('../src/stylelint.js', import.meta.url));

test('PostCSS plugin', async () => {
  const result = await postcss([gamefaceCompat({ warn: true })]).process('.a{inset:0;float:left}', { from: 'a.css' });
  assert.equal(result.css, '.a{top:0;right:0;bottom:0;left:0}');
  assert.ok(result.warnings().some((w) => /float/.test(w.text)));
});

test('PostCSS plugin with SCSS syntax in source mode', async () => {
  const result = await postcss([gamefaceCompat({ mode: 'source' })]).process('$x: 1px;\n.a { inset: $x; color: hsl(0 100% 50%); }', { from: 'a.scss', syntax: postcssScss });
  assert.equal(result.css, '$x: 1px;\n.a { inset: $x; color: rgb(255, 0, 0); }');
});

test('Stylelint plugin reports and fixes in source mode', async () => {
  const config = { plugins: [PLUGIN], rules: { 'gameface-compat/compat': true } };
  const code = '.a { inset: 0; float: left; }\n';
  const lint = await stylelint.lint({ code, config });
  const warnings = lint.results[0].warnings;
  assert.ok(warnings.some((w) => w.rule === 'gameface-compat/compat' && /inset/.test(w.text)));
  assert.ok(warnings.some((w) => /float/.test(w.text) && w.severity === 'warning'));
  const fixed = await stylelint.lint({ code, config, fix: true });
  assert.equal(fixed.code ?? fixed.output, '.a { top: 0; right: 0; bottom: 0; left: 0; float: left; }\n');
});

test('Vite plugin rewrites the bundled CSS and writes a report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gfc-vite-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="./a.css"></head><body><script type="module" src="./main.js"></script></body></html>');
  writeFileSync(join(dir, 'a.css'), ':root{--c:red} .a{color:var(--c, blue);inset:0;font-size:clamp(10px,2vw,20px)} .b:has(.c){color:red}');
  writeFileSync(join(dir, 'main.js'), 'document.body.dataset.ok = "1";');
  await build({ root: dir, logLevel: 'silent', plugins: [gamefaceVite()], build: { outDir: join(dir, 'dist'), cssMinify: false } });
  const assets = execFileSync('ls', [join(dir, 'dist', 'assets')]).toString().split('\n').filter((f) => f.endsWith('.css'));
  const css = readFileSync(join(dir, 'dist', 'assets', assets[0]), 'utf8');
  assert.match(css, /var\(--c\)/);
  assert.doesNotMatch(css, /:has/);
  assert.match(css, /@media \(min-width: 500px\)/);
  const report = JSON.parse(readFileSync(join(dir, 'dist', 'gameface-compat-report.json'), 'utf8'));
  assert.ok(report.summary.converted > 0 && report.summary.removed > 0);
});

test('CLI: check, fix, build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gfc-cli-'));
  mkdirSync(join(dir, 'styles'));
  const file = join(dir, 'styles', 'a.css');
  writeFileSync(file, '.a{inset:0;float:left}\n');
  const check = spawnSync(process.execPath, [CLI, 'check', join(dir, 'styles'), '-q']);
  assert.equal(check.status, 1);
  assert.match(check.stdout.toString(), /1 would change/);
  execFileSync(process.execPath, [CLI, 'build', join(dir, 'styles'), '-o', join(dir, 'out'), '-q']);
  assert.equal(readFileSync(join(dir, 'out', 'a.css'), 'utf8'), '.a{top:0;right:0;bottom:0;left:0}\n');
  execFileSync(process.execPath, [CLI, 'fix', file, '-q']);
  assert.equal(readFileSync(file, 'utf8'), '.a{top:0;right:0;bottom:0;left:0;float:left}\n');
  const again = spawnSync(process.execPath, [CLI, 'check', file, '-q']);
  assert.equal(again.status, 0);
});
