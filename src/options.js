// Options and their defaults. Every default is the strict choice: nothing that
// could change how a page looks is enabled unless the caller opts in.

/** Approximations: rewrites that are close, but not guaranteed identical. */
export const APPROXIMATIONS = /** @type {const} */ ([
  'outline-to-box-shadow',
  'flex-start-end-assume-no-reverse',
  'where-to-is',
  'font-weight-nearest',
  'transform-merge',
  'browser-defaults-preamble',
]);

/**
 * @typedef {object} UserOptions
 * @property {'gameface' | 'source'} [mode]
 *   gameface: the output is only for Gameface (a build step). Rewrites that are
 *     exact for an LTR, screen-only engine are used, and whatever Gameface would
 *     ignore anyway is removed so the official linter reports nothing.
 *   source: the output replaces your source files and must still render
 *     identically in browsers. Only browser-exact rewrites are used.
 * @property {string} [version] Gameface version, or 'latest'
 * @property {boolean} [assumeLtr] source mode: every page is left-to-right (gameface mode always is)
 * @property {boolean} [closedWorld] custom properties are only ever set from CSS (never JS or inline styles)
 * @property {boolean} [complete] the CSS being processed is all the CSS the page uses
 *   (set automatically by the CLI in project mode and by the Vite plugin)
 * @property {number | null} [rootFontSize] px size of 1rem, if fixed; enables folding rem-based math
 * @property {Array<typeof APPROXIMATIONS[number]>} [approximations]
 * @property {string[]} [disable] transform ids to skip
 */

/**
 * @typedef {Required<Omit<UserOptions, 'approximations' | 'disable'>> & {
 *   approximations: Set<string>, disable: Set<string>, ltr: boolean }} ResolvedOptions
 */

/**
 * @param {UserOptions} [user]
 * @returns {ResolvedOptions}
 */
export function resolveOptions(user = {}) {
  const mode = user.mode ?? 'gameface';
  if (mode !== 'gameface' && mode !== 'source') throw new TypeError(`Unknown mode "${mode}". Use "gameface" or "source".`);
  const approximations = new Set(user.approximations ?? []);
  for (const a of approximations) {
    if (!APPROXIMATIONS.includes(/** @type {any} */ (a))) {
      throw new TypeError(`Unknown approximation "${a}". Known: ${APPROXIMATIONS.join(', ')}.`);
    }
  }
  return {
    mode,
    version: user.version ?? 'latest',
    assumeLtr: Boolean(user.assumeLtr),
    closedWorld: Boolean(user.closedWorld),
    complete: Boolean(user.complete),
    rootFontSize: user.rootFontSize ?? null,
    approximations,
    disable: new Set(user.disable ?? []),
    // Gameface has no `direction` or `writing-mode`, so its output is always LTR.
    ltr: mode === 'gameface' || Boolean(user.assumeLtr),
  };
}
