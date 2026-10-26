#!/usr/bin/env node
// Updates the Gameface feature data to the newest eslint-plugin-gameface and
// writes a summary of what changed for the pull request body.
//
//   node scripts/sync-upstream.js            update if a newer version exists
//   node scripts/sync-upstream.js --check    exit 1 if an update is available
//
// Outputs (for the GitHub workflow):
//   sync-summary.md   human-readable diff of the catalog and of our coverage
//   GITHUB_OUTPUT     updated=true|false, version=<new version>

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const PKG = 'eslint-plugin-gameface';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const installed = JSON.parse(readFileSync(new URL(`../node_modules/${PKG}/package.json`, import.meta.url), 'utf8')).version;
const latest = sh(npm, ['view', PKG, 'version']);

const output = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

if (installed === latest) {
  console.log(`${PKG} is up to date (${installed}).`);
  output('updated', 'false');
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.log(`${PKG} ${latest} is available (installed ${installed}).`);
  process.exit(1);
}

const coverage = () => JSON.parse(sh(process.execPath, ['src/cli.js', 'coverage', '--json']));
const before = coverage();

console.log(`Updating ${PKG} ${installed} -> ${latest}`);
sh(npm, ['install', '--ignore-scripts', '--save-exact=false', `${PKG}@^${latest}`]);

const after = coverage();
sh(process.execPath, ['src/cli.js', 'coverage', '--markdown', 'docs/coverage.md']);

const beforeMap = new Map(before.map((r) => [r.id, r]));
const afterMap = new Map(after.map((r) => [r.id, r]));
const added = after.filter((r) => !beforeMap.has(r.id));
const removed = before.filter((r) => !afterMap.has(r.id));
const changed = after.filter((r) => beforeMap.has(r.id) && beforeMap.get(r.id).outcome !== r.outcome);

const list = (rows, fmt) => (rows.length ? rows.map(fmt).join('\n') : '_none_');
const summary = `## eslint-plugin-gameface ${installed} → ${latest}

Gameface feature data was updated automatically. Items that are newly
unsupported are handled by the data-driven pipeline (removed in gameface mode,
reported in source mode) until a dedicated exact rewrite exists.

### New catalog items (${added.length})
${list(added, (r) => `- \`${r.id}\` → ${r.outcome}`)}

### Items no longer in the catalog (${removed.length})
These are now supported by Gameface (or were dropped from the data); any rewrite for them turns off automatically for the new version.
${list(removed, (r) => `- \`${r.id}\``)}

### Changed outcomes (${changed.length})
${list(changed, (r) => `- \`${r.id}\`: ${beforeMap.get(r.id).outcome} → ${r.outcome}`)}
`;
writeFileSync('sync-summary.md', summary);

// Patch release: merging this update publishes it (see release.yml).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const next = `${major}.${minor}.${patch + 1}`;
sh(npm, ['version', next, '--no-git-tag-version']);
const today = new Date().toISOString().slice(0, 10);
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const entry = `## ${next} — ${today}\n\n- Gameface data updated to eslint-plugin-gameface ${latest}: ${added.length} new catalog items, ${removed.length} removed, ${changed.length} changed outcomes.\n\n`;
writeFileSync('CHANGELOG.md', changelog.replace(/^(# Changelog\n\n)/, `$1${entry}`));
console.log(summary);
output('updated', 'true');
output('version', latest);
output('major', String(latest.split('.')[0] !== installed.split('.')[0]));
