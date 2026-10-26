// Stylelint plugin: reports what gameface-css-compat would change and fixes it
// with `stylelint --fix` (or fix-on-save in an editor).
//
//   // stylelint.config.js
//   export default {
//     plugins: ['gameface-css-compat/stylelint'],
//     rules: { 'gameface-compat/compat': [true, { assumeLtr: false }] },
//   };
//
// The rule always runs in source mode: fixes must keep your pages identical in
// browsers. Problems that have no exact fix are reported but left alone.

import stylelint from 'stylelint';
import { createContext, transformRoot } from './engine.js';

const ruleName = 'gameface-compat/compat';

const messages = stylelint.utils.ruleMessages(ruleName, {
  converted: (feature, before, after) => `Gameface cannot use ${feature}${before ? ` (${before})` : ''}; exact fix: ${after}`,
  kept: (feature, before, reason) => `Gameface cannot use ${feature}${before ? ` (${before})` : ''}; no exact fix: ${reason}`,
});

/** @type {import('stylelint').Rule} */
const rule = (primary, secondary = {}) => (root, result) => {
  if (!primary) return;
  const options = { ...secondary, mode: 'source' };

  // Dry run on a copy to find what would change, then report with a fix that
  // transforms the real root once (the pipeline is idempotent).
  const copy = root.clone();
  const preview = createContext(options, [copy]);
  transformRoot(preview, copy);

  let fixed = false;
  const fixAll = () => {
    if (fixed) return;
    fixed = true;
    const ctx = createContext(options, [root]);
    transformRoot(ctx, root);
  };

  for (const e of preview.report.entries) {
    if (e.action === 'removed') continue; // never happens in source mode
    const line = e.source?.line ?? 1;
    const column = e.source?.column ?? 1;
    const node = findNodeAt(root, line, column) ?? root;
    if (e.action === 'converted') {
      stylelint.utils.report({
        ruleName,
        result,
        node,
        message: messages.converted(e.feature, e.before, e.after ?? ''),
        fix: { apply: fixAll, node },
      });
    } else {
      stylelint.utils.report({ ruleName, result, node, message: messages.kept(e.feature, e.before, e.reason ?? ''), severity: 'warning' });
    }
  }
};

/**
 * @param {import('postcss').Root} root
 * @param {number} line
 * @param {number} column
 */
function findNodeAt(root, line, column) {
  let found = null;
  root.walk((n) => {
    const s = n.source?.start;
    if (s && s.line === line && s.column === column) found = n;
  });
  return found;
}

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = { url: 'https://github.com/8ell/gameface-css-compat#stylelint', fixable: true };

export default stylelint.createPlugin(ruleName, rule);
export { ruleName, messages };
