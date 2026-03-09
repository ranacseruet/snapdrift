# Changelog

## Unreleased

- Prepared SnapDrift for the first public GitHub release under version `0.1.0`.
- Fixed capture metadata to record actual full-page PNG dimensions so dimension shifts stay classified separately from comparison errors.
- Standardized the public contract on SnapDrift-only config paths, environment variables, report markers, and artifact filenames.
- Added Node 22 self-provisioning to the standalone actions that shell out to `node` or `npm`.
- Updated README, contracts, and integration docs to reference public release tags, with commit SHA pinning as an optional hardening step.
