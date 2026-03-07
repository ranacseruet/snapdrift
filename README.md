# SnapDrift

This module contains the shared visual regression implementation for `Node + Playwright` projects.

## What lives here

- `lib/`: shared config, capture, compare, staging, and skipped-summary logic
- `actions/`: cross-repo composite actions for baseline publishing and PR diffs
- `.github/workflows/`: staged reusable workflow templates for later promotion
- `docs/`: contracts and promotion checklist

## Status: v1 (stable)

The contracts, lib exports, and action interfaces are frozen for v1. See [CHANGELOG](CHANGELOG.md) for version history.

The primary CI and PR workflows in this repo use the wrapper actions as the main integration path. Because GitHub only recognizes reusable workflows from a repository root `.github/workflows/` directory, the workflow files under this module are staged templates. The composite actions under `actions/` are the current cross-repo integration surface.

## Integration Guide

### Primary entrypoints

- `actions/publish-visual-baseline`
- `actions/run-visual-pr-diff`

Use these wrapper actions by cross-repo reference:

```yaml
- uses: user/snapdrift/actions/publish-visual-baseline@v1
```

Pin to a commit SHA or tag (e.g., `@v1`) instead of a moving branch when possible.

If this repo is private, enable GitHub Actions access from the consumer repo before testing cross-repo references.

### Consumer responsibilities

Consumer repos still own:

- checkout
- Node setup
- dependency installation
- app build
- app startup
- readiness wait
- app shutdown

The shared layer owns route selection, capture, compare, skipped-summary generation, artifact staging, artifact upload, PR comment publication, and diff-mode enforcement.

### Step 1: Add `.github/visual-regression.json`

Create `.github/visual-regression.json` in the consumer repo and make it the source of truth for route coverage, output paths, and enforcement mode.

Example:

```json
{
  "baselineArtifactName": "ui-foundation-visual-baseline",
  "workingDirectory": ".",
  "baseUrl": "http://127.0.0.1:8080",
  "readyUrl": "http://127.0.0.1:8080",
  "readyTimeoutSeconds": 45,
  "resultsFile": "qa-artifacts/visual-baselines/current/visual-baseline-results.json",
  "manifestFile": "qa-artifacts/visual-baselines/current/visual-screenshot-manifest.json",
  "screenshotsRoot": "qa-artifacts/visual-baselines/current",
  "routes": [
    {
      "id": "root-index-desktop",
      "path": "/",
      "viewport": "desktop"
    },
    {
      "id": "root-index-mobile",
      "path": "/",
      "viewport": "mobile"
    }
  ],
  "diff": {
    "threshold": 0.01,
    "mode": "report-only"
  }
}
```

If you want changed-file scoping, also add the optional `selection` block and per-route `changePaths` entries. See [docs/contracts.md](docs/contracts.md) for the full schema including optional `selection` fields.

### Step 2: Publish the baseline artifact from the main CI workflow

In the workflow that runs on `push` to `main`:

1. Check out the repo.
2. Set up Node and install dependencies.
3. Build the app if needed.
4. Start the app locally and wait until `baseUrl` is reachable.
5. Call `publish-visual-baseline`.

Example:

```yaml
- name: Publish main visual baseline
  uses: user/snapdrift/actions/publish-visual-baseline@v1
  with:
    repo-config-path: .github/visual-regression.json
    artifact-retention-days: '30'
```

If you already have route selection logic, pass it through `route-ids`. Otherwise the wrapper captures all configured routes.

### Step 3: Add the PR visual diff workflow

The PR workflow must grant write permissions so the action can resolve baseline artifacts from another repo and post PR comments:

```yaml
permissions:
  contents: read
  actions: read
  issues: write
  pull-requests: write
```

`actions: read` is required to download the baseline artifact from the main branch workflow run. `issues: write` and `pull-requests: write` are required to post and update the PR comment. Without these, the action will fail with a 403.

In the PR workflow:

1. Check out the PR head commit.
2. Set up Node and install dependencies.
3. Build and start the app locally.
4. Call `run-visual-pr-diff`.

Step example:

```yaml
- name: Run visual PR diff
  uses: user/snapdrift/actions/run-visual-pr-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    repo-config-path: .github/visual-regression.json
```

Complete `.github/workflows/pr-visual-diff.yml`:

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
        uses: user/snapdrift/actions/run-visual-pr-diff@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          repo-config-path: .github/visual-regression.json
```

The wrapper:

- resolves PR scope unless you explicitly pass `route-ids`
- downloads the latest successful `main` baseline artifact
- captures current routes
- writes skipped summaries when scope is irrelevant or the baseline is unavailable
- stages and uploads the diff artifact
- publishes the workflow summary
- comments on the PR by default when a PR number is available
- enforces `diff.mode` only after artifacts and comments are published

Useful overrides:

- `pr-number`: explicit PR number override
- `route-ids`: explicit route override that bypasses changed-file scope detection
- `force-run`: force a full run
- `baseline-repository`: fetch baselines from another repo
- `baseline-workflow-id`: override the publishing workflow id
- `baseline-branch`: override the publishing branch
- `comment-on-pr`: set to `false` to suppress the PR comment

### Advanced usage

The low-level actions remain available for advanced consumers, but they are now secondary building blocks:

- `actions/capture-visual-routes`
- `actions/compare-visual-results`
- `actions/determine-visual-diff-scope`
- `actions/evaluate-visual-diff-outcome`
- `actions/publish-visual-pr-comment`
- `actions/resolve-baseline-artifact`
- `actions/stage-visual-artifacts`

Use the low-level actions only when you need custom orchestration that the wrappers do not provide.

## Diff calculation limitations

The pixel diff engine has the following known limitations:

- **Viewport dimension changes skip diff**: When a PR changes page content such that the captured screenshot dimensions differ from the baseline (e.g., adding or removing sections that change page height), pixel-level comparison is skipped for that route. These are reported as "dimension changes" in the summary, not as errors. The recommended workflow is to merge the PR and let the main CI re-capture the baseline with the new dimensions.
- **Full-page capture dependency**: Screenshot dimensions depend on the full rendered page height at capture time. Any layout change that affects the document height — even outside the visually changed area — will trigger a dimension mismatch for that route.
- **No sub-region diffing**: The engine compares entire screenshots pixel-by-pixel. There is no support for cropping or masking specific regions before comparison.
- **Fixed viewport presets only**: v1 supports only `desktop` (1440x900) and `mobile` (390x844) presets. Custom viewport sizes are not supported.
- **Single threshold per config**: The mismatch threshold (`diff.threshold`) applies uniformly to all routes. Per-route thresholds are not supported in v1.

## Repo contract

Consumer repos provide `.github/visual-regression.json` and keep repo-specific app build/start logic outside the shared visual pipeline.

See [docs/contracts.md](docs/contracts.md) for the exact file contracts.

## Enforcement modes

Start with `report-only` to accumulate baselines without affecting build status. Once baselines are stable, switch to `fail-on-changes` to catch visual regressions. Use `strict` to also fail on missing screenshots, dimension changes, and comparison errors.

| Mode | Fails when |
|:-----|:-----------|
| `report-only` | Never |
| `fail-on-changes` | `changedScreenshots > 0` |
| `fail-on-incomplete` | Errors, dimension changes, or missing screenshots |
| `strict` | Any of the above |

## Upgrading

When the module moves to a dedicated repo or cuts a new version:

1. Update the `uses:` reference in your workflow to the new repo/tag.
2. Check the [CHANGELOG](CHANGELOG.md) for any contract changes.
3. Minor version bumps do not require changes to `.github/visual-regression.json`.

## Troubleshooting

**"No non-expired visual baseline artifact was found"**
- The main CI workflow has not run successfully yet, or the artifact has expired.
- Run the main CI workflow on `main` and wait for it to complete.

**403 when posting PR comments**
- Add `issues: write` and `pull-requests: write` permissions to the PR workflow job.

**Screenshots have different dimensions**
- Expected when a PR changes page content such that the captured dimensions differ from the baseline (e.g., adding or removing sections that change page height). Recorded as a "dimension change" in the diff summary; pixel comparison is skipped for that route.
- Merge the PR and let the main CI re-capture the baseline with the new dimensions.
