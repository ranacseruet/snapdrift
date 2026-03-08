# Integration Guide

This guide walks through setting up SnapDrift in a consumer repo from scratch.

## Prerequisites

> **v1 supports any app stack on Ubuntu runners.**
> - SnapDrift self-provisions Node 22 internally — your consumer workflow does not need to set up Node.
> - The consumer app can be any language or framework (Node, Python, Go, Ruby, etc.). SnapDrift only needs the app to be running and reachable at `baseUrl`.
> - The runner must be Ubuntu-compatible (`ubuntu-latest` or equivalent). SnapDrift installs Playwright's Chromium and system dependencies via `apt`; `windows-latest` and `macos-latest` runners are not supported in v1.
> - Playwright Chromium is installed automatically by SnapDrift on each run (~150 MB, takes 1–2 min). No manual Playwright setup is required, but the runner must have outbound network access to reach the Playwright CDN.

Your repo must handle its own:

- Checkout
- Dependency installation (in whatever language/tool your app uses)
- App build
- App startup and readiness wait
- App shutdown

SnapDrift owns everything after the app is running: route selection, capture, compare, skipped-summary generation, artifact staging, artifact upload, PR comment publication, and diff-mode enforcement.

## Step 1: Add `.github/visual-regression.json`

This file is the single source of truth for route coverage, output paths, and enforcement policy.

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
  "diff": {
    "threshold": 0.01,
    "mode": "report-only"
  }
}
```

For the full config schema — including optional `selection.sharedPrefixes`, `selection.sharedExact`, and per-route `changePaths` for changed-file scoping — see [contracts.md](contracts.md).

## Step 2: Publish the baseline on push to `main`

In your main CI workflow, after the app is started and reachable:

```yaml
- name: Publish visual baseline
  uses: ranacseruet/snapdrift/actions/baseline@v1
  with:
    repo-config-path: .github/visual-regression.json
    artifact-retention-days: '30'
```

If you want to capture only a subset of routes, pass `route-ids` as a comma-separated list. Otherwise all configured routes are captured.

## Step 3: Run the visual diff on pull requests

The PR workflow requires write permissions to download baseline artifacts and post PR comments:

```yaml
permissions:
  contents: read
  actions: read        # required to download the baseline artifact
  issues: write        # required to post/update the PR comment
  pull-requests: write # required to post/update the PR comment
```

Then add the diff step after your app is running:

```yaml
- name: Run visual PR diff
  uses: ranacseruet/snapdrift/actions/pr-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repo-config-path: .github/visual-regression.json
```

### Complete example workflow (Node app)

```yaml
name: PR Visual Diff

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  actions: read
  issues: write
  pull-requests: write

jobs:
  visual-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run build

      - name: Start app
        run: |
          npm start &
          for i in $(seq 1 45); do
            curl -sf http://127.0.0.1:8080 && break || sleep 1
          done

      - name: Run visual PR diff
        uses: ranacseruet/snapdrift/actions/pr-diff@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repo-config-path: .github/visual-regression.json
```

### Complete example workflow (Python app)

SnapDrift handles its own Node setup, so a Python (or Go, Ruby, etc.) consumer workflow looks identical — just swap out the build/start steps for your stack:

```yaml
name: PR Visual Diff

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  actions: read
  issues: write
  pull-requests: write

jobs:
  visual-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r requirements.txt

      - name: Start app
        run: |
          gunicorn myapp:app --bind 127.0.0.1:8080 &
          for i in $(seq 1 45); do
            curl -sf http://127.0.0.1:8080 && break || sleep 1
          done

      - name: Run visual PR diff
        uses: ranacseruet/snapdrift/actions/pr-diff@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repo-config-path: .github/visual-regression.json
```

No `actions/setup-node` step needed — SnapDrift provisions Node 22 internally.

### What the wrapper does

- Resolves PR scope (changed-file-based route selection) unless you explicitly pass `route-ids`
- Downloads the latest successful `main` baseline artifact
- Captures current screenshots
- Writes a skipped summary when scope is irrelevant or the baseline is unavailable
- Stages and uploads the diff artifact
- Publishes the workflow summary
- Comments on the PR (set `comment-on-pr: false` to suppress)
- Enforces `diff.mode` only after artifacts and comments are published

### Useful input overrides

| Input | Purpose |
|-------|---------|
| `pr-number` | Explicit PR number override |
| `route-ids` | Override scope detection and capture specific routes |
| `force-run` | Force a full run regardless of changed files |
| `baseline-repository` | Fetch baselines from another repo |
| `baseline-workflow-id` | Override the publishing workflow ID |
| `baseline-branch` | Override the publishing branch |
| `comment-on-pr` | Set to `false` to suppress the PR comment |

## Enforcement modes

Start with `report-only` to accumulate baselines without affecting build status. Once baselines are stable, switch to `fail-on-changes` to catch visual regressions.

| Mode | Fails when |
|------|-----------|
| `report-only` | Never |
| `fail-on-changes` | `changedScreenshots > 0` |
| `fail-on-incomplete` | Errors, dimension changes, or missing screenshots |
| `strict` | Any of the above |

## Advanced: low-level actions

The low-level actions are available for custom orchestration when the wrappers don't cover your use case:

- `actions/capture-visual-routes`
- `actions/compare-visual-results`
- `actions/determine-visual-diff-scope`
- `actions/evaluate-visual-diff-outcome`
- `actions/publish-visual-pr-comment`
- `actions/resolve-baseline-artifact`
- `actions/stage-visual-artifacts`

## Upgrading

1. Update the `uses:` reference in your workflow to the new tag.
2. Check [CHANGELOG.md](../CHANGELOG.md) for any contract changes.
3. Minor version bumps do not require changes to `.github/visual-regression.json`.

## Troubleshooting

**"No non-expired visual baseline artifact was found"**
The main CI workflow has not run successfully yet, or the artifact has expired. Run it on `main` and wait for it to complete.

**403 when posting PR comments**
Add `issues: write` and `pull-requests: write` permissions to the PR workflow job.

**Screenshots have different dimensions**
Expected when a PR adds or removes content that changes page height. Recorded as a "dimension change" in the diff summary; pixel comparison is skipped. Merge the PR and let the main CI re-capture the baseline with the new dimensions.

**Route appears in `errors[]` in the diff summary**
The Playwright capture failed (navigation timeout, app not ready, crash). Check the workflow logs. Ensure the app is fully started and `baseUrl` is reachable before the action runs. The navigation timeout is fixed at 30 seconds — if your app or a specific route consistently takes longer to load, the app must be fully warm before the action step runs.
