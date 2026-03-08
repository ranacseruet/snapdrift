# SnapDrift

![SnapDrift](assets/snapdrift-logo-banner.png)

![CI](https://github.com/ranacseruet/snapdrift/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-v1.0.0-informational)

Visual regression testing as a GitHub Actions pipeline — no external services, no SaaS subscriptions.

SnapDrift captures full-page screenshots of your app on every push to `main`, then diffs them on every PR and posts the results as a PR comment. It's built on [Playwright](https://playwright.dev) and runs entirely within GitHub Actions.

## What it handles

- **Baseline capture** — screenshots per route on `main`, uploaded as a GitHub artifact
- **PR diffing** — pixel-level comparison against the baseline on every pull request
- **Smart scoping** — only diffs routes touched by the PR's changed files (optional)
- **PR comments** — structured summary posted and updated automatically on the PR
- **Enforcement** — fails the build if screenshots change, depending on your chosen mode

You keep ownership of checkout, build, and app startup. SnapDrift takes over once the app is running.

## Quickstart

**1. Add `.github/visual-regression.json` to your repo:**

```json
{
  "baselineArtifactName": "my-app-visual-baseline",
  "workingDirectory": ".",
  "baseUrl": "http://127.0.0.1:8080",
  "resultsFile": "qa-artifacts/visual-baselines/current/visual-baseline-results.json",
  "manifestFile": "qa-artifacts/visual-baselines/current/visual-screenshot-manifest.json",
  "screenshotsRoot": "qa-artifacts/visual-baselines/current",
  "routes": [
    { "id": "home-desktop", "path": "/", "viewport": "desktop" },
    { "id": "home-mobile",  "path": "/", "viewport": "mobile"  }
  ],
  "diff": { "threshold": 0.01, "mode": "report-only" }
}
```

**2. Capture the baseline on push to `main`:**

```yaml
- name: Publish visual baseline
  uses: ranacseruet/snapdrift/actions/baseline@v1
  with:
    repo-config-path: .github/visual-regression.json
```

**3. Diff on every PR:**

```yaml
- name: Run visual PR diff
  uses: ranacseruet/snapdrift/actions/pr-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repo-config-path: .github/visual-regression.json
```

That's the full integration. See the [Integration Guide](docs/integration-guide.md) for complete workflow examples, permission requirements, and input overrides.

## Enforcement modes

Start with `report-only` to accumulate baselines without affecting build status. Switch to `fail-on-changes` once they're stable.

| Mode | Fails when |
|------|-----------|
| `report-only` | Never |
| `fail-on-changes` | Any screenshot changed |
| `fail-on-incomplete` | Missing screenshots, dimension changes, or errors |
| `strict` | Any of the above |

## Known limitations

- **Ubuntu runners only** — Playwright's system dependency installer (`--with-deps`) requires apt; `windows-latest` and `macos-latest` runners are not supported
- Full-page capture only — no sub-region masking or cropping
- Fixed viewport presets: `desktop` (1440×900) and `mobile` (390×844)
- Single `diff.threshold` applies to all routes — no per-route overrides
- Dimension changes skip pixel diff and are reported separately

## Docs

- [Integration Guide](docs/integration-guide.md) — step-by-step setup, config reference, overrides, troubleshooting
- [Contracts](docs/contracts.md) — schema, artifact shapes, environment variables
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE) — MIT
