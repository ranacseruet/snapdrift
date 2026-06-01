# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, open a [GitHub Security Advisory](https://github.com/ranacseruet/snapdrift/security/advisories/new) (private disclosure). You can expect an acknowledgement within 48 hours and a patch or mitigation plan within 14 days.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested mitigations (optional)

## Scope

Security-relevant areas in SnapDrift include:

- **GitHub Actions execution** - the composite actions install dependencies, provision Playwright Chromium, download artifacts, and post PR comments. Changes that affect token usage, workflow permissions, artifact handling, or shell execution are security-sensitive.
- **Baseline and artifact handling** - SnapDrift reads and stages screenshots, manifests, and summary bundles. Path resolution, artifact download behavior, and report generation should not allow unsafe file access or unexpected data exposure.
- **PR reporting** - SnapDrift upserts pull request comments and emits workflow summaries. Any issue that could expose sensitive information or enable malicious content injection into reports is in scope.

## Supported Versions

SnapDrift is in pre-1.0 development. Security patches are backported to the current and the immediately previous minor version. Earlier minors are end-of-life.

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| 0.3.x   | Yes       |
| 0.2.x   | No        |
| 0.1.x   | No        |

The same policy applies to the `@snapdrift/*` workspace packages — they're released in lockstep with the root package, so each minor version is published with matching `@snapdrift/manifest`, `@snapdrift/compare-core`, `@snapdrift/adapter-fs`, and `@snapdrift/adapter-report-md` versions.

If you need a security patch for an unsupported version, open an issue and we can usually cut a backport — but the default expectation is to upgrade.
