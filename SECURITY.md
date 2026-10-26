# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

You should get a reply within a week.

## Scope

`gameface-css-compat` is a build-time tool. It reads CSS files that you pass to it and writes CSS. It makes no network requests, runs no other programs, uses no `eval`, and has no install scripts.

The most relevant risks are:

- **Supply chain.** Its feature data comes from the `eslint-plugin-gameface` package. In CI, updates to that package are installed with `--ignore-scripts`, their registry signatures are verified, and they are tested before merging. A new major version is never merged automatically.
- **Release integrity.** Every release is published from GitHub Actions with npm provenance. Check the provenance on the package's npm page, or run `npm audit signatures`.
