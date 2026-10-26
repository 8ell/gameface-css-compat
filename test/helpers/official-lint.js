// Runs Coherent's official eslint-plugin-gameface on CSS text.
import { ESLint } from 'eslint';
import gameface from 'eslint-plugin-gameface';

let eslint;

/**
 * @param {string} css
 * @param {{ version?: string }} [opts]
 * @returns {Promise<import('eslint').Linter.LintMessage[]>}
 */
export async function officialLint(css, opts = {}) {
  if (!eslint || opts.version) {
    const config = [...gameface.configs['flat/recommended']];
    if (opts.version) config.push({ settings: { gameface: { version: opts.version } } });
    eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config, cwd: process.cwd() });
  }
  const [result] = await eslint.lintText(css, { filePath: 'gameface-check.css' });
  return result.messages;
}

/** @param {import('eslint').Linter.LintMessage[]} messages */
export const errorsOf = (messages) => messages.filter((m) => m.severity === 2);
