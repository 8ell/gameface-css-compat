# Changelog

## 0.1.0 — 2026-10-27

First release.

- Uses the Gameface feature data from `eslint-plugin-gameface` 1.3.1 (Gameface 3.1.2.1, 3.1.3.3 and 3.1.4.1).
- Adds `gameface` and `source` modes.
- Handles all 758 catalog items in gameface mode: 133 are converted exactly, 3 are partly converted, 614 are removed and reported, and 8 are already accepted. The official linter reports no errors on the output.
- Exact rewrites:
  - logical properties and their shorthands;
  - `:is()` expansion;
  - CSS math folding, with fluid viewport math turned into media queries;
  - modern color functions converted to `rgb()` using Chromium's rounding;
  - Oklab and other non-sRGB gradient interpolation resampled into `rgb()` stops;
  - transform functions;
  - basic shapes;
  - `steps()` jump keywords;
  - `var()` fallbacks, using whole-page analysis;
  - keyword normalization;
  - `@media` types and `@supports` resolved against the data.
- Integrations: a Vite plugin, a PostCSS plugin, a Stylelint rule with autofix, and a CLI.
- Verification: the official linter runs on every catalog item for every version, Chromium checks that rendering is unchanged, and randomized tests cover colors, math and fluid sizing.
- A weekly workflow syncs the upstream data and merges the update automatically when all tests pass.
