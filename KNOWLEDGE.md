# MOM v2: knowledge notes

For what the app does, how to run it and how to deploy it, see `README.md`. For decisions and known limits, see `ASSUMPTIONS.md`.

## Version

- Current version: **2.0.1** (matches `package.json`).
- `version.json` lives at `public/version.json`. The build copies `public/` to `dist/`, so it is served at `/version.json`.
- Version history in plain words: `CHANGELOG.md` (newest first, dates in IST).
- How to bump: for every deployed change, in the same pull request:
  - raise MAJOR.MINOR.PATCH (PATCH for fixes, MINOR for new features, MAJOR for breaking changes),
  - add a new entry at the top of `CHANGELOG.md`,
  - update `public/version.json` (`version`, `releasedAt`, `releasedAtIST`, `commit`, and add the new item at the top of `changes[]`),
  - update the current version in this section,
  - keep `package.json` `version` the same.
