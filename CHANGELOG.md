# Changelog

## Unreleased

## 0.5.0 - 2026-06-08

### Features

- **Snap local-capture hybrid** — when `provider: "snap"` and `baseUrl` resolves to a local address (localhost, `127.0.0.0/8`, `::1`, `0.0.0.0`), Playwright now runs on the runner to render the page, and the resulting PNG is uploaded to Snap via `POST /v1/visual/captures/:id/local-result`. This makes it possible to point SnapDrift at a server only the runner can reach — the common case — without exposing the server to Snap's render worker. Captures are flagged with `localCapture: true` so Snap keeps them out of the render queue, and the output `results.json` records `provider: "snap"` plus `captureMode: "local-upload"`.

### Fixes

- **Snap baseline run no longer diffs against an old baseline** — `publishBaseline` now sets `skipBaselineResolution: true` on baseline-publish runs and omits `baselineId` from run creation. Previously, publishing a fresh baseline would diff it against the prior baseline, which failed on dimension mismatch and burned an upload.
- **`captureProfileJson` no longer sent on Snap run creation** — the render environment is owned by Snap's render worker, not the client, and the server dereferences nested fields (browser, platform, fonts, viewport) that SnapDrift's minimal profile doesn't populate, which crashed it with a 500. The render worker already defaults locale/timezone/viewport when no profile is present, so omitting it is behaviour-preserving.
- **Run-creation includes `branch` and `baselineId`** — `branch` is sent from `GITHUB_HEAD_REF` (PR source) or `GITHUB_REF_NAME` (push); `baselineId` is the latest accepted baseline for the project, so the backend can diff every capture. Without `baselineId` Snap short-circuits to `diffed` with no comparison data.
- **4xx never falls back, even with `onUnavailable` set** — clarifies the contract: `onUnavailable` is consulted only after 5xx/network retries are exhausted, never on a 4xx (which is a configuration error, not an outage).
- **`actions/pr-diff` no longer installs Playwright when `provider: "snap"` and the run won't need it** — gated on the same `isLocalBaseUrl` check the `baseline` action uses.

### Infrastructure

- **`@snapdrift/manifest` v1.2.0** — added the `ProviderCaptureOptions.purpose` type contract for baseline-publish versus diff captures.

## 0.4.0 - 2026-05-26

### Features

- **VisualProvider interface** — new `VisualProvider` interface (`capture`, `diff`, `publishBaseline`, `fetchLatestBaseline`, `buildCommentBody`) with `LocalProvider` and `SnapProvider` implementations. Config `provider` field (`"local"` | `"snap"`) selects the backend; defaults to `"local"` for zero-config backward compatibility.
- **SnapProvider** — calls Snap's `/v1/visual/*` API for capture, diff, and baseline management. Retries on 5xx with exponential backoff (3 attempts, 30 s cap). Honors `snap.onUnavailable` (`"fail"` | `"warn-and-skip"` | `"fallback-local"`). 4xx errors never retry or fall back.
- **Snap config** — new `snap` config block (`apiUrl`, `apiKeyEnv`/`apiKey`, `projectId`, `onUnavailable`) in `snapdrift.json`. Exactly one of `apiKeyEnv` or `apiKey` is required when `provider: "snap"`.
- **PR comment unification** — both providers now produce identical PR comment markdown via a shared `buildCommentBody(summary, meta?)` method. `SnapProvider` appends a "View in dashboard →" link when `dashboardUrl` is present; `LocalProvider` omits it. Comment steps route through the provider instead of calling `buildReportCommentBody` directly, with a defensive fallback to `LocalProvider` if config loading fails.
- **`migrate-baselines` command** — one-shot CLI command (`snapdrift migrate-baselines --to snap` / `--to local`) to upload local baselines to Snap or export Snap baselines back to a local directory. Supports `--accept-cross-engine` for engine-mismatch scenarios.
- **`init --from-snap-action` codemod** — translates a Snap `github-action` workflow YAML into `snapdrift.json` with `provider: "snap"`. Emits structured warnings for features with no direct equivalent (jpeg format, baseline tags, single-shot artifact upload).

### Infrastructure

- **`@snapdrift/manifest` v1.1.0** — added `ProviderCommentMeta`, `dashboardUrl` on `VisualDiffSummary`, `buildCommentBody` on `VisualProvider`, `SnapConfig` re-export.
- **`@snapdrift/adapter-report-md` v1.1.0** — `buildReportCommentBody` now accepts `dashboardUrl` in meta; renders "View in dashboard →" link when present and valid.
- **Action contract tests** — `snapdrift-actions-contract` test suite now asserts that comment and pr-diff steps include `createProvider` and `buildCommentBody` calls.
- **Provider unification tests** — new `buildCommentBody — provider unification` test block verifying identical markdown output across providers, dashboard link inclusion/exclusion, and URL validation.

## 0.3.0 - 2026-05-26

### Infrastructure

- **Package extraction (Phase 1a)** — extracted `@snapdrift/manifest` (schema, validation, indexing, viewport presets) and `@snapdrift/compare-core` (pure pixel comparison, ignore-region masking) as standalone npm packages with zero runtime deps beyond `pngjs`.
- **Package extraction (Phase 1b)** — extracted `@snapdrift/adapter-fs` (all filesystem I/O: capture, compare, config, staging, drift report generation) and `@snapdrift/adapter-report-md` (pure markdown/HTML report generators, zero runtime deps) as standalone npm packages.
- **Lib/ shim refactor** — all `lib/*.mjs` modules are now thin re-export shims that delegate to packages. `lib/report.mjs` wires the default filesystem `imageReader` for HTML reports. Backward-compatible — all export surfaces preserved.
- **`generateDiffImage` ignore regions** — `@snapdrift/compare-core` now overlays ignored pixel regions with semi-transparent gray instead of skipping them.
- **Publish workflow** — `.github/workflows/publish.yml` now publishes all four `@snapdrift/*` workspace packages in dependency order before the root `snapdrift` package.

### Performance

- **Faster screenshot capture** — navigation now waits for `load` instead of `networkidle`, removing a guaranteed ≥500 ms floor per route. A 20-route run saves ~10 s in navigation waits alone.
- **Concurrent route capture** — routes within the same viewport are now captured in parallel (up to `SNAPDRIFT_CAPTURE_CONCURRENCY` at a time, default 5) rather than sequentially, giving a further 3–5× throughput improvement on multi-route suites.
- **Deterministic animation handling** — screenshots are taken with `animations: 'disabled'` so Playwright finishes/cancels CSS animations before capture, replacing reliance on the settle delay for animation timing.

### Features

- **`SNAPDRIFT_CAPTURE_CONCURRENCY` env var** — controls the maximum number of routes captured concurrently within a viewport context (positive integer, default `5`). Set to `1` to restore serial-per-viewport behaviour for apps with shared session or auth state.

## 0.2.1 - 2026-04-13

### Infrastructure

- **Integration test for compare → stage pipeline** — `tests/integration/capture-compare-pipeline.test.js` exercises the full `generateDriftReport → stageArtifacts` data flow with synthetic PNG fixtures (no live browser needed), catching interface mismatches between modules that unit tests alone would miss.

### Features

- **Configurable PR comment truncation limits** — `actions/pr-diff` and `actions/comment` now accept optional `max-changed-rows` (default: 20) and `max-error-rows` (default: 10) inputs, letting teams control how many rows appear in the drift and error tables before the overflow note.
- **Per-route navigation timeout** — routes now accept an optional `navigationTimeout` (positive integer, ms) that overrides the global 30 000 ms default for that route. Useful for slow SSR pages that need more time or fast static pages that should fail fast.
- **Baseline refresh workflow template** — `docs/workflow-templates/refresh-baseline-on-merge.yml` is a drop-in workflow template for consumer repos that automatically republishes the SnapDrift baseline on every push to the default branch. Supports an optional label gate to avoid republishing on every push.

### Fixes

- **Baseline refresh template trigger** — switched from `pull_request: closed` to `push` on the default branch so published artifacts are actually discoverable by the baseline resolver in `actions/pr-diff`, which hardcodes `event:'push'` when querying workflow runs.
- **Artifact action pins** — `actions/upload-artifact` and `actions/download-artifact` in composite action YAMLs are now pinned to v7 SHAs, matching the CI workflow (the v0.2.0 changelog noted this upgrade but only the CI workflow was updated at the time).
- **Stale version references** — README and integration guide examples now reference `@v0.2.1` instead of the outdated `@v0.1.0`. README "Current constraints" updated to reflect custom viewport support.

## 0.2.0 - 2026-04-08

### Features

- **Local CLI** (`snapdrift capture` / `snapdrift diff`) — run visual captures and diffs locally against a running app without GitHub Actions. Outputs land in `.snapdrift/` by default; all paths are overridable via flags. Exits non-zero when `diff.mode` enforces failure.
- **Self-contained HTML diff report** — the drift artifact now includes a single `report.html` with baseline/current screenshots and diff images embedded as base64, viewable without any server.
- **Custom viewport support** — route `viewport` now accepts an object `{ "width": number, "height": number }` in addition to the `"desktop"` and `"mobile"` presets.
- **Parallel capture by viewport** — routes are now captured concurrently per viewport group, roughly halving capture time on multi-route configurations.
- **Route ID sanitization** — route IDs are sanitised before use as filenames, preventing path-traversal sequences from escaping the screenshots directory.
- **Capture retry logic** — failed route captures are retried once before being recorded as errors.
- **Progress logging** — capture and comparison steps now emit per-route progress to stdout.

### Fixes

- HTML report image embedding now falls back correctly when a resolved image path is missing.
- Custom viewport values are formatted correctly in PR comment reports and dimension-shift entries.
- Viewport width/height are cast to numbers before comparison to prevent type-mismatch false positives.
- Dimension shifts section in PR comment reports is auto-expanded by default.

### Dependencies

- `playwright` 1.58.2 → 1.59.1
- `eslint` 9.x → 10.x, `@eslint/js` 9.x → 10.x
- `typescript` 5.x → 6.x
- `jest` 30.2.0 → 30.3.0
- `actions/upload-artifact` v4 → v7

### Infrastructure

- Added npm publish workflow (`.github/workflows/publish.yml`) triggered on GitHub release, with provenance attestation.
- Added `publishConfig` to `package.json` to make public access and registry explicit.

## 0.1.0 - 2026-03-09

- Prepared SnapDrift for the first public GitHub release under version `0.1.0`.
- Fixed capture metadata to record actual full-page PNG dimensions so dimension shifts stay classified separately from comparison errors.
- Standardized the public contract on SnapDrift-only config paths, environment variables, report markers, and artifact filenames.
- Added Node 22 self-provisioning to the standalone actions that shell out to `node` or `npm`.
- Updated README, contracts, and integration docs to reference public release tags, with commit SHA pinning as an optional hardening step.
