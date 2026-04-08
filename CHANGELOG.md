# Changelog

## Unreleased

- Added `snapdrift` CLI with `capture` and `diff` commands for local development use without GitHub Actions.
- Extended `runBaselineCapture` with an `outDir` option so outputs can be written to an arbitrary local directory.
- Updated `package.json` to publish the `snapdrift` binary and export `lib/cli.mjs`.
- Added [Local CLI guide](docs/local-cli.md) and updated README, integration guide, and contracts docs.

## 0.1.0 - 2026-03-09

- Prepared SnapDrift for the first public GitHub release under version `0.1.0`.
- Fixed capture metadata to record actual full-page PNG dimensions so dimension shifts stay classified separately from comparison errors.
- Standardized the public contract on SnapDrift-only config paths, environment variables, report markers, and artifact filenames.
- Added Node 22 self-provisioning to the standalone actions that shell out to `node` or `npm`.
- Updated README, contracts, and integration docs to reference public release tags, with commit SHA pinning as an optional hardening step.
