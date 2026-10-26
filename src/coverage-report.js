import { LATEST_VERSION, UPSTREAM_VERSION } from './features.js';

const LABEL = {
  converted: 'Converted exactly',
  mixed: 'Partly converted',
  removed: 'Removed (Gameface ignores it; no equivalent exists)',
  unchanged: 'Already accepted',
};

const CATEGORY = {
  property: 'Unsupported properties',
  value: 'Rejected values',
  function: 'Unsupported functions',
  selector: 'Selectors and at-rules',
  restriction: 'Documented restrictions',
};

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * @param {import('./coverage.js').CoverageRow[]} rows
 * @param {{ version?: string }} [opts]
 */
export function coverageMarkdown(rows, opts = {}) {
  const total = rows.length;
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  const lines = [];
  lines.push('# Coverage');
  lines.push('');
  lines.push(`Generated from \`eslint-plugin-gameface\` ${UPSTREAM_VERSION}, Gameface ${opts.version && opts.version !== 'latest' ? opts.version : LATEST_VERSION}. Every catalog item gets one sample stylesheet; the table shows what gameface mode does with it. The test suite checks that the official linter reports no errors on any output.`);
  lines.push('');
  lines.push('| Outcome | Items |');
  lines.push('| --- | ---: |');
  for (const o of ['converted', 'mixed', 'removed', 'unchanged']) lines.push(`| ${LABEL[o]} | ${count(o)} |`);
  lines.push(`| **Total** | **${total}** |`);
  lines.push('');
  for (const [cat, title] of Object.entries(CATEGORY)) {
    const group = rows.filter((r) => r.category === cat);
    if (group.length === 0) continue;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Item | Outcome | Output |');
    lines.push('| --- | --- | --- |');
    for (const r of group) {
      const name = r.id.replace(/^[a-z-]+:/, '');
      lines.push(`| \`${cell(name)}\` | ${r.outcome} | ${r.output ? `\`${cell(r.output)}\`` : '_(removed)_'} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
