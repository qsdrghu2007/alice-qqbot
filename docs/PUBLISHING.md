# Public Repository Copy

This directory is a sanitized source snapshot prepared for the public GitHub
repository:

https://github.com/qsdrghu2007/alice-qqbot

## Included

- Source code, tests, scripts, documentation, and local start/stop helpers.
- The locked `ws` dependency metadata.
- The CI workflow.

## Excluded

- Git history and local repository metadata.
- Runtime data, NapCat installations, dependencies, releases, backups, logs,
  caches, and generated artifacts.
- Local configuration, credentials, cookies, private keys, screenshots, and
  binaries that were not audited for publication.

## Run Locally

Install the locked dependency with:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Create the local `data/` configuration described in `README.md`. Runtime data
and secrets remain local and are ignored by Git.

## Relationship To The Working Copy

This snapshot was rebuilt from an approved source list and does not share the
working copy's Git history. Local deployment details were replaced with generic
examples. Functional defaults and public project settings remain in the source.

Before publishing a future snapshot, review all changed files, run the complete
verification commands, and scan the candidate files for credentials and
personal data.

## v0.6.0 Release Record

- Runtime source version: `0.6.0` in both `package.json` and the root
  `package-lock.json` entry. The `/source` route must read this package version
  instead of carrying a separate hard-coded release number.
- Public documentation includes `docs/RELEASE-v0.6.0.md` with upgrade notes,
  the external NapCat link and start paths, runtime-mode behavior, and known
  end-to-end limitations.
- Release assets remain source-only. Do not add `data/`, `napcat/`,
  `node_modules/`, `backups/`, `releases/`, local logs, credentials, or cookies.
- Candidate validation for this release recorded `npm test` as 384 passed,
  0 skipped, and 0 failed. The candidate also passed `npm run check`,
  `node --check public/app.js`, and the release-file/credential checks described
  above.
- These checks do not constitute real QQ or real-model end-to-end validation.
  Confirm the published tag, release asset hash, and source archive contents
  again immediately before publishing.
