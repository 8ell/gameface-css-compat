# gameface-css-compat

[한국어](README.ko.md)

Rewrites modern CSS so that [Coherent Gameface](https://coherent-labs.com/products/coherent-gameface/) renders it. Where an exact equivalent exists, the tool substitutes it. Where none exists, it removes the code (Gameface would have ignored it anyway) and tells you what it removed.

The official [`eslint-plugin-gameface`](https://www.npmjs.com/package/eslint-plugin-gameface) tells you what Gameface does not support. This tool fixes what can be fixed. It reads its data from that same plugin, so the two always agree about what is supported.

> Unofficial. Not affiliated with or endorsed by Coherent Labs. "Gameface" is a trademark of its owner. All feature data comes from the MIT-licensed `eslint-plugin-gameface` package.

```css
/* in */
.panel {
  inset-inline: 0;
  padding-block: 8px 12px;
  width: clamp(200px, 40vw, 480px);
  font-weight: 700;
  float: left;
}
.panel:is(.open, .pinned) > .title { text-align: start; }

/* out (gameface mode) */
.panel {
  left: 0;
  right: 0;
  padding-top: 8px;
  padding-bottom: 12px;
  width: 200px;
  font-weight: bold;
}
@media (min-width: 500px) { .panel { width: 40vw; } }
@media (min-width: 1200px) { .panel { width: 480px; } }
.panel.open > .title, .panel.pinned > .title { text-align: left; }
```

```
removed   hud.css:6 property:float  float: left  (Gameface does not support float)
1 files, 1 built: 6 converted, 1 removed, 0 without an exact fix
```

## What "100%" means here

The upstream catalog lists 758 features that Gameface lacks or only partly supports. In gameface mode, every one of them ends in one of two states:

- **Converted**: it is rewritten to something Gameface supports that renders the same way. There are 179 such items, plus 3 that are partly converted.
- **Removed and reported**: no equivalent exists, so it is dropped. Gameface's parser would have dropped it anyway. There are 564 such items, for example `float`, CSS grid, `:has()`, `@container`, and `calc()` that mixes `%` with `px`.

After the rewrite, the official linter reports **zero errors** on the output for every supported Gameface version. [docs/coverage.md](docs/coverage.md) lists what happens to each catalog item. It is generated and checked in CI.

### Beyond the catalog

Gameface mode also lowers modern syntax that the official linter does not check but that is newer than Gameface's parser. Each rewrite is exact in every engine, so it is safe whether or not Gameface understands the original:

| Input | Output |
| --- | --- |
| native CSS nesting | flat rules, with spec semantics |
| `@media (400px <= width <= 800px)` | `@media (min-width: 400px) and (max-width: 800px)` (`<` and `>` are reported, because they have no exact equivalent) |
| `light-dark(a, b)` | `a` (Gameface has no `color-scheme`) |
| `rgb(from red r g calc(b + 20))` and the other relative colours | `rgb()` |
| `dvh` `svh` `lvh` `vi` `vb` and the `cq*` units | `vh` `vw` `vmin` `vmax` (a game view has no browser UI and no query containers) |
| `cm` `mm` `q` `pc` | `px` |

The tool never guesses. A rewrite runs only when it is exact for the situation the tool can prove. Anything that is merely close is an opt-in [approximation](#approximations).

## Two modes

| | `gameface` (default) | `source` |
| --- | --- | --- |
| Use for | build output that only Gameface reads | your source files, which browsers also render |
| Rewrites | exact for Gameface: always LTR, screen media, no `@supports` surprises | exact in **every** browser |
| Unfixable items | removed and reported | kept in place and reported |
| Lint result | 0 errors | only what has no browser-exact fix remains |

The usual setup is `source` mode in your editor and linter (Stylelint autofix) and `gameface` mode at build time (the Vite plugin).

## Install

```sh
npm i -D gameface-css-compat
```

Node 20.11 or newer is required. `vite`, `stylelint` and `postcss-scss` are optional peer dependencies. Install them only if you use those integrations.

## Usage

### Vite (recommended)

```js
// vite.config.js
import gamefaceCompat from 'gameface-css-compat/vite';

export default {
  plugins: [gamefaceCompat()],
};
```

The plugin runs only on `vite build`, and only on the final CSS assets. It therefore sees every stylesheet of the page, including CSS imported from JS and `<style>` blocks in Vue or Svelte files. Because it sees all the CSS, it can use the whole-page analysis described below. It writes `gameface-compat-report.json` next to the build output.

| Option | Default | |
| --- | --- | --- |
| `version` | `'latest'` | Gameface version to target (`gameface-css-compat versions` lists them) |
| `closedWorld` | `false` | custom properties are never set from JS or inline styles |
| `rootFontSize` | `null` | px size of `1rem`, if fixed |
| `approximations` | `[]` | see [Approximations](#approximations) |
| `disable` | `[]` | transform ids to skip |
| `report` | `'gameface-compat-report.json'` | report file name, or `false` |
| `failOnRemoved` | `false` | fail the build if anything had to be removed |
| `onReport` | | `(report) => void` |

### Stylelint (editor and `--fix`)

```js
// stylelint.config.js
export default {
  plugins: ['gameface-css-compat/stylelint'],
  rules: {
    'gameface-compat/compat': [true, { assumeLtr: true }],
  },
};
```

This always runs in `source` mode, so autofixed files still look identical in browsers. Anything without a browser-exact fix is reported as a warning.

### PostCSS

```js
// postcss.config.js
import gamefaceCompat from 'gameface-css-compat/postcss';

export default {
  plugins: [gamefaceCompat({ mode: 'gameface', complete: true })],
};
```

PostCSS hands the plugin one file at a time. Pass `complete: true` only if that file is all of the page's CSS. `warn: true` turns report entries into PostCSS warnings.

### CLI

```sh
npx gameface-css-compat fix src/            # rewrite sources in place (source mode)
npx gameface-css-compat check src/          # exit 1 if fix would change anything (CI)
npx gameface-css-compat build dist/ -o out/ # write Gameface output (gameface mode)
npx gameface-css-compat coverage --json     # what happens to every catalog item
```

Run `npx gameface-css-compat --help` to see all options. `.scss` files are parsed with `postcss-scss`. Code that uses preprocessor syntax (`$var`, `#{}`) is left alone.

### API

```js
import { transformCss } from 'gameface-css-compat';

const { css, report } = transformCss(input, { mode: 'gameface', complete: true });
console.log(report.summary()); // { converted, removed, kept }
```

## Whole-page analysis

Some rewrites are exact only if the tool knows something about the whole page. The tool works these facts out for itself. It does not take them on trust.

- **`complete`**: the processed CSS is all the CSS of the page. The Vite plugin and the CLI set this. With it, the tool can prove things like "this variable is always defined at `:root`", which lets it drop `var()` fallbacks, or "this element's transform is never animated", which lets it fold `skew(a, b)` into `matrix()`.
- **`closedWorld`**: custom properties are only ever set from CSS. With it, the tool can substitute `var()` fallbacks and inline variables inside `@keyframes`. Only you can know this, so it is opt-in.
- **`rootFontSize`**: lets `rem` take part in folded math, such as fluid `clamp()`.

If one of these facts is unknown, the rewrite that needs it simply does not happen, and the item is reported.

## Approximations

These are off by default. Enable them with `approximations: [...]` or `--approx a,b`.

| id | does | why it is not exact |
| --- | --- | --- |
| `outline-to-box-shadow` | `outline` → `box-shadow` | it can overlap an existing shadow; there is no `outline-offset` for dashed lines |
| `flex-start-end-assume-no-reverse` | `start`/`end` → `flex-start`/`flex-end` | it is wrong inside `*-reverse` flex containers |
| `where-to-is` | `:where()` → `:is()` expansion | it raises specificity |
| `font-weight-nearest` | `450` → `normal`, etc. | Gameface has only normal and bold |
| `transform-merge` | folds `skew`/`perspective` into `matrix` even if the element may be animated | interpolation differs mid-animation |
| `browser-defaults-preamble` | prepends Chromium-like UA defaults | Gameface's UA sheet differs |
| `individual-transforms` | `translate`/`rotate`/`scale` → `transform` in the same rule | a browser composes them with `transform` set by other rules |

## How it is verified

No human reviews the rewrites, so every guarantee comes from automated checks.

1. **Official linter, every item, every version.** For each catalog item, one sample is generated from the upstream data, transformed, and linted with `eslint-plugin-gameface`. The test passes only with zero errors, and it runs for every Gameface version the plugin knows. A second pass over the output must change nothing (idempotency).
2. **Browser equivalence.** Every `source`-mode rewrite is rendered in Chromium twice, once before and once after, through Playwright. The test compares element boxes, computed colors and styles, and screenshots pixel by pixel. Colors, math and fluid sizing are also tested with randomly generated inputs.
3. **Unit tests** cover the CSS math evaluator, the color conversion (which reproduces Chromium's rounding) and each transform.

```sh
npm test               # unit, coverage and integration tests
npm run test:browser   # Chromium equivalence (needs Playwright's Chromium, or CHROME_PATH)
```

## Staying current

`.github/workflows/upstream-sync.yml` runs weekly. When a new `eslint-plugin-gameface` is published, it installs it, regenerates the coverage document, runs every test including the browser suite, and opens a pull request that summarizes which catalog items appeared, disappeared or changed outcome. If everything passes, the pull request merges itself. To turn that off, set the repository variable `AUTO_MERGE_UPSTREAM` to `false`.

Each sync also bumps the patch version. `.github/workflows/release.yml` publishes any version on `main` that is not on npm yet: it runs every test, publishes with provenance, then tags the commit and creates a GitHub Release. To make a release by hand, bump `version` in `package.json` on `main`.

New unsupported features need no new code. The data-driven pipeline removes and reports them until someone adds an exact rewrite. When a feature leaves the catalog because Gameface now supports it, its rewrite switches off automatically for that version.

## Security

- At runtime the package makes no network requests and runs no other programs. It does not use `eval`, and it has no install scripts. It reads only the files you pass it and writes only the outputs you ask for.
- It contains no API keys and calls no AI service. "Automated" here means CI scripts and tests, not a model at runtime.
- Releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so every published version can be traced to the commit and workflow that built it.
- In CI, actions are pinned to commit SHAs and workflows keep no credentials on disk. The npm token is visible only to the publish step. Dependency signatures are checked with `npm audit signatures`. Upstream updates are installed with `--ignore-scripts`, and a new upstream major version is never merged automatically.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- Gameface has no CSS grid, `float`, `:has()` or `@container`. Nothing can make these render, so they are removed and reported. Rebuild those layouts with flexbox.
- `calc()` that mixes `%` with lengths cannot be expressed in Gameface (with the exception of the fluid-viewport cases, which become media queries).
- Fluid `clamp()`/`min()`/`max()` with viewport units is rewritten only in top-level rules or `@layer` (not inside another `@media`), and only up to 12 breakpoints.
- Right-to-left pages: Gameface itself is LTR-only. In source mode, logical properties are mapped only with `assumeLtr`.
- The data is only as accurate as `eslint-plugin-gameface`. If the plugin is wrong about a feature, so is this tool. Please report those cases upstream.

## License

[MIT](LICENSE)
