#!/usr/bin/env node
// gameface-css-compat command line.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import postcss from 'postcss';
import { createContext, transformRoot } from './engine.js';
import { KNOWN_VERSIONS, LATEST_VERSION, UPSTREAM_VERSION } from './features.js';
import { APPROXIMATIONS } from './options.js';
import { Report } from './report.js';

const HELP = `gameface-css-compat — make CSS work in Coherent Gameface

Usage
  gameface-css-compat fix <files|dirs...>             rewrite sources in place (browser-identical)
  gameface-css-compat check <files|dirs...>           exit 1 if anything would change
  gameface-css-compat build <files|dirs...> -o <dir>  write Gameface-only output to <dir>
  gameface-css-compat coverage [--json|--markdown f]  how every catalog item is handled
  gameface-css-compat versions                        known Gameface versions

Options
  -g, --gameface-version <v>  Gameface version (default: latest = ${LATEST_VERSION})
  -o, --out-dir <dir>         output directory for build
      --assume-ltr            every page is left-to-right (fix/check)
      --closed-world          CSS variables are never set from JS or inline styles
      --root-font-size <px>   size of 1rem, if fixed
      --approx <a,b>          enable approximations: ${APPROXIMATIONS.join(', ')}
      --disable <ids>         skip transforms by id
      --partial               the files are not all the CSS of the page
      --report <file>         write the full report as JSON
      --dry-run               fix: show what would change without writing
  -q, --quiet                 only print the summary
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'gameface-version': { type: 'string', short: 'g' },
    'out-dir': { type: 'string', short: 'o' },
    'assume-ltr': { type: 'boolean' },
    'closed-world': { type: 'boolean' },
    'root-font-size': { type: 'string' },
    approx: { type: 'string' },
    disable: { type: 'string' },
    partial: { type: 'boolean' },
    report: { type: 'string' },
    'dry-run': { type: 'boolean' },
    json: { type: 'boolean' },
    markdown: { type: 'string' },
    quiet: { type: 'boolean', short: 'q' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...inputs] = positionals;

const showHelp = Boolean(values.help || !command);

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function baseOptions() {
  return {
    version: values['gameface-version'] ?? 'latest',
    assumeLtr: values['assume-ltr'],
    closedWorld: values['closed-world'],
    rootFontSize: values['root-font-size'] ? Number(values['root-font-size']) : null,
    approximations: list(values.approx),
    disable: list(values.disable),
    complete: !values.partial,
  };
}

/** @param {string[]} paths */
function collectFiles(paths) {
  const out = [];
  const visit = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        visit(join(p, name));
      }
    } else if (['.css', '.scss'].includes(extname(p).toLowerCase())) out.push(p);
  };
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    visit(resolve(p));
  }
  return out;
}

async function syntaxFor(file) {
  if (extname(file).toLowerCase() !== '.scss') return undefined;
  try {
    return (await import('postcss-scss')).default;
  } catch {
    throw new Error('Install postcss-scss to process .scss files: npm i -D postcss-scss');
  }
}

function printReport(report, cwd) {
  if (values.quiet) return;
  for (const e of report.entries) {
    const where = e.source?.file ? `${relative(cwd, e.source.file)}:${e.source.line ?? '?'}` : '';
    const change = e.after ? `${e.before} -> ${e.after}` : e.before ?? '';
    process.stdout.write(`${e.action.padEnd(9)} ${where.padEnd(28)} ${e.feature}  ${change}${e.reason ? `  (${e.reason})` : ''}\n`);
  }
}

async function run() {
  if (showHelp) {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  const cwd = process.cwd();

  if (command === 'versions') {
    process.stdout.write(`eslint-plugin-gameface data ${UPSTREAM_VERSION}\nGameface versions: ${KNOWN_VERSIONS.join(', ')} (latest ${LATEST_VERSION})\n`);
    return 0;
  }

  if (command === 'coverage') {
    const { runCoverage } = await import('./coverage.js');
    const rows = runCoverage({ version: values['gameface-version'] });
    if (values.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return 0;
    }
    const { coverageMarkdown } = await import('./coverage-report.js');
    const md = coverageMarkdown(rows, { version: values['gameface-version'] });
    if (values.markdown) writeFileSync(values.markdown, md);
    else process.stdout.write(md);
    return 0;
  }

  if (!['fix', 'check', 'build'].includes(command)) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  if (inputs.length === 0) {
    process.stderr.write('Give at least one file or directory.\n');
    return 2;
  }
  if (command === 'build' && !values['out-dir']) {
    process.stderr.write('build writes Gameface-only CSS; pass --out-dir so your sources are not overwritten.\n');
    return 2;
  }

  const files = collectFiles(inputs);
  const parsed = [];
  for (const file of files) {
    const syntax = await syntaxFor(file);
    const css = readFileSync(file, 'utf8');
    parsed.push({ file, css, syntax, root: (syntax ?? postcss).parse(css, { from: file }) });
  }

  const mode = command === 'build' ? 'gameface' : 'source';
  const report = new Report();
  const ctx = createContext({ ...baseOptions(), mode }, parsed.map((p) => p.root), report);
  let changedFiles = 0;
  for (const p of parsed) {
    transformRoot(ctx, p.root);
    const out = p.root.toString(p.syntax);
    const changed = out !== p.css;
    if (changed) changedFiles++;
    if (command === 'fix' && changed && !values['dry-run']) writeFileSync(p.file, out);
    if (command === 'build') {
      const common = commonDir(files);
      const target = join(resolve(values['out-dir']), relative(common, p.file));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, out);
    }
  }

  printReport(report, cwd);
  if (values.report) writeFileSync(values.report, JSON.stringify({ summary: report.summary(), entries: report.entries }, null, 2));
  const s = report.summary();
  const verb = command === 'check' || values['dry-run'] ? 'would change' : command === 'build' ? 'built' : 'changed';
  process.stdout.write(`\n${files.length} files, ${changedFiles} ${verb}: ${s.converted} converted, ${s.removed} removed, ${s.kept} without an exact fix\n`);
  if (command === 'check') return changedFiles > 0 ? 1 : 0;
  return 0;
}

/** @param {string[]} files */
function commonDir(files) {
  if (files.length === 1) return dirname(files[0]);
  const parts = files.map((f) => dirname(f).split(/[\\/]/));
  const first = parts[0];
  let i = 0;
  while (i < first.length && parts.every((p) => p[i] === first[i])) i++;
  return first.slice(0, i).join('/') || '/';
}

// Set exitCode instead of calling process.exit(): exiting immediately can cut
// off output that is still being written to a pipe (large --json output).
run().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`gameface-css-compat: ${err.message}\n`);
    process.exitCode = 2;
  },
);
