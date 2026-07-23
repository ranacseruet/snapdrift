# SnapDrift

![SnapDrift](assets/snapdrift-logo-banner.png)

![CI](https://github.com/ranacseruet/snapdrift/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

SnapDrift captures full-page application frames, compares them against a known baseline, and reports drift directly in GitHub Actions.

SnapDrift is ready to integrate from public GitHub releases. Workflow examples below use the latest public tag for readability; security-conscious consumers can pin the resolved commit SHA instead.

## What SnapDrift handles

- Baseline capture on `main`
- Pull request drift detection against the latest successful baseline
- Route scoping from changed files
- PR report upserts (with optional Snap dashboard link)
- Drift enforcement through `diff.mode`
- Pluggable backends: local filesystem (default) or hosted Snap (`provider: "snap"`)
- One-shot baseline migration between backends
- Codemod that translates an existing Snap `github-action` workflow to `snapdrift.json`

You keep ownership of checkout, build, startup, readiness, and teardown. SnapDrift takes over once the app is reachable.

## Quickstart

**1. Add `.github/snapdrift.json` to your repo:**

```json
{
  "baselineArtifactName": "my-app-snapdrift-baseline",
  "workingDirectory": ".",
  "baseUrl": "http://127.0.0.1:8080",
  "resultsFile": "qa-artifacts/snapdrift/baseline/current/results.json",
  "manifestFile": "qa-artifacts/snapdrift/baseline/current/manifest.json",
  "screenshotsRoot": "qa-artifacts/snapdrift/baseline/current",
  "routes": [
    { "id": "home-desktop", "path": "/", "viewport": "desktop" },
    { "id": "home-mobile", "path": "/", "viewport": "mobile" }
  ],
  "diff": { "threshold": 0.01, "mode": "report-only" }
}
```

**2. Publish a baseline on push to `main`:**

```yaml
- name: SnapDrift Baseline
  uses: ranacseruet/snapdrift/actions/baseline@v0.4.0
  with:
    repo-config-path: .github/snapdrift.json
```

**3. Run SnapDrift on pull requests:**

```yaml
- name: SnapDrift Report
  uses: ranacseruet/snapdrift/actions/pr-diff@v0.4.0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repo-config-path: .github/snapdrift.json
```

That is the full integration. See the [Integration Guide](docs/integration-guide.md) for workflow examples, permissions, compatibility notes, advanced overrides, and the hosted Snap backend (`provider: "snap"`).

## Local CLI

SnapDrift ships a `snapdrift` CLI for running captures, diffs, migrations, and config initialization locally against a running app — no GitHub Actions required. Use it during development to validate UI changes before pushing.

```bash
# Capture a baseline
snapdrift capture

# Compare against it after making UI changes
snapdrift diff --open

# Migrate local baselines to the hosted Snap backend
snapdrift migrate-baselines --to snap

# Translate an existing Snap github-action workflow into snapdrift.json
snapdrift init --from-snap-action .github/workflows/snap.yml
```

See the [Local CLI guide](docs/local-cli.md) for installation, all flags, directory layout, and examples.

## Drift modes

Start with `report-only` while baselines settle. Move to `fail-on-changes` or stricter modes once the signal is stable.

| Mode | Stops the run when |
|------|--------------------|
| `report-only` | Never |
| `fail-on-changes` | Any capture exceeds threshold |
| `fail-on-incomplete` | Captures are missing, dimensions shift, or comparison errors occur |
| `strict` | Any drift signal or incomplete comparison appears |

## Current constraints

- Ubuntu runners only (local CLI works on any OS Node 22+ supports)
- Full-page capture only
- Viewport presets: `desktop` (1440×900) and `mobile` (390×844), or custom `{ "width": number, "height": number }`
- One global `diff.threshold`
- Dimension shifts are reported separately from pixel drift
- Local provider writes artifacts to the runner filesystem; for a hosted backend with a dashboard and a shared baseline store, configure `provider: "snap"` (see the [Integration Guide](docs/integration-guide.md#hosted-snap-provider))

## Outgrew GitHub artifacts?

Baselines live as GitHub Actions artifacts by default — quick to start, but they expire (30 days by default), are scoped to one repo, and every PR re-renders on your CI runner. When visual regression becomes load-bearing, `provider: "snap"` moves baselines into durable, shared storage with a review dashboard — and, when `baseUrl` points at a public preview URL Snap can reach, renders on Snap's hosted fleet instead of your runner (with a localhost `baseUrl`, capture stays a local-Playwright-and-upload hybrid). Same routes, same diff config; add a `snap` config block and API key per the [hosted-provider setup](docs/integration-guide.md#hosted-snap-provider). Snap's hosted Visual CI is built for small teams (plans from $9.99/mo).

→ **[Hosted Visual CI with Snap](https://snap.i2dev.com/ci)**

## Docs

- [Integration Guide](docs/integration-guide.md)
- [Local CLI](docs/local-cli.md)
- [Contracts](docs/contracts.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)
