# Doc audit + gap fix

Status: in progress

Branch: `docs/audit-and-fix-gaps`

## Scope

Documentation-only fix-up based on a full code-vs-docs audit. No code or
schema changes. Single PR.

## Items

- [ ] 1. README.md — bump v0.2.1→v0.4.0, add SnapProvider/migrate/init pointer, refresh Current constraints
- [ ] 2. docs/integration-guide.md — bump pins, add SnapProvider section, add force-run-reason, fix low-level actions list
- [ ] 3. docs/local-cli.md — document migrate-baselines and init commands, update console output examples
- [ ] 4. docs/contracts.md — full snap config example, retry semantics, error classes, isLocalBaseUrl, hybrid, MIGRATION_NOTES
- [ ] 5. docs/workflow-templates/refresh-baseline-on-merge.yml — bump pin
- [ ] 6. AGENTS.md — refresh architecture section with current action dirs and packages
- [ ] 7. CONTRIBUTING.md — drop NPM_TOKEN, bump test-file count
- [ ] 8. SECURITY.md — update supported versions table
- [ ] 9. CHANGELOG.md — add missing 0.4.0-post commits (Snap local-capture hybrid)

## Validation

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run validate:actions` passes
- [ ] `npm test` passes
- [ ] Action contract test (`tests/snapdrift-actions-contract.test.js`) still green
