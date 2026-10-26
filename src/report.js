// Every change (and every kept problem) is recorded so nothing happens silently.

/**
 * @typedef {'converted' | 'removed' | 'kept'} Action
 *   converted: rewritten into an exact equivalent Gameface understands
 *   removed:   Gameface ignores it and there is no exact equivalent; dropped from the output
 *   kept:      left as is (source mode, or a needed fact was unknown); Gameface will ignore it
 */

/**
 * @typedef {object} ReportEntry
 * @property {string} transform id of the transform that produced the entry
 * @property {Action} action
 * @property {string} feature catalog key, e.g. `function:hsl`, `property:inset`
 * @property {string} [before]
 * @property {string} [after]
 * @property {string} [reason] why it was removed or kept
 * @property {{ file?: string, line?: number, column?: number }} [source]
 */

export class Report {
  constructor() {
    /** @type {ReportEntry[]} */
    this.entries = [];
  }

  /**
   * @param {import('postcss').Node | undefined} node
   * @param {Omit<ReportEntry, 'source'>} entry
   */
  add(node, entry) {
    const start = node?.source?.start;
    const file = node?.source?.input?.file ?? node?.source?.input?.from;
    this.entries.push({
      ...entry,
      source: start ? { file, line: start.line, column: start.column } : file ? { file } : undefined,
    });
  }

  /** @param {Action} action */
  count(action) {
    return this.entries.filter((e) => e.action === action).length;
  }

  summary() {
    return {
      converted: this.count('converted'),
      removed: this.count('removed'),
      kept: this.count('kept'),
    };
  }
}
