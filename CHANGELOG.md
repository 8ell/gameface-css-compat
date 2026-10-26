# Changelog

## 0.2.0 — 2026-10-27

- Coverage: 179 catalog items are now converted exactly, up from 133. 564 are removed and reported, down from 614.
  - `initial` on 38 properties → the property's initial value.
  - `opacity: 50%` → `0.5`.
  - `stroke-dasharray: none` → `0`.
  - Straight-line `linear()` easings → `linear`.
  - `animation-duration: auto` → `0s` (gameface mode).
  - `:first-of-type` / `:last-of-type` → `:nth-of-type(1)` / `:nth-last-of-type(1)`.
  - `:scope` → `:root` outside `@scope`.
- Syntax lowering in gameface mode, for modern syntax the linter does not flag. Each rewrite is exact in any engine:
  - native CSS nesting is flattened;
  - media range syntax becomes `min-`/`max-` features;
  - `light-dark()` becomes its light colour;
  - relative colours become `rgb()`;
  - `dvh`/`svh`/`lvh`/`vi`/`vb`/`cq*` units become viewport units;
  - `cm`/`mm`/`q`/`pc` become `px`.
- New approximation `individual-transforms`: merges `translate`/`rotate`/`scale` into `transform`.
- Fix: large `--json` output from the CLI was cut off at 64 KB when piped. The upstream sync reads this output.
- Release: any version on `main` that is not on npm yet is published by CI (tests → npm publish with provenance → tag and GitHub Release).
- Security hardening:
  - GitHub Actions are pinned to commit SHAs.
  - Workflows keep no credentials on disk.
  - Jobs run with the least permissions they need.
  - `npm audit signatures` checks the registry signatures of dependencies.
  - The upstream package is installed with `--ignore-scripts`.
  - Upstream major versions are never merged automatically.
  - Added SECURITY.md.

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
