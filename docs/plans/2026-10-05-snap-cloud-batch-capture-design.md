# Design Specification: Snap Cloud Batch Screenshot Capture Engine

**Date:** 2026-10-05  
**Status:** Approved  
**Author:** Pair programming session (Antigravity & Rana)

---

## 1. Context & Motivation

SnapDrift currently offers two provider workflows:
1. **`provider: "local"`**: Executes Playwright locally on the runner to capture screenshots into PNGs, then runs pure-JS pixel comparison (`@snapdrift/compare-core`) and stores baselines in GitHub Actions artifacts.
2. **`provider: "snap"`**: Connects to Snap Cloud's Visual Regression service (`/v1/visual/*`), requiring a Snap project ID and hosted baseline management.

In CI workflows using `provider: "local"`, the primary speed bottleneck is running Playwright on the runner:
- Downloading and installing Chromium and OS dependencies (`playwright install --with-deps chromium`) adds 45–90 seconds per CI job.
- Headless rendering on limited CI runner CPU/RAM slows down capture of multi-route configurations.

Snap Cloud provides a public Batch Screenshot API (`POST /v1/screenshots` with `items: [...]`) capable of asynchronously capturing up to 50 URLs in parallel on hosted render workers and returning signed image URLs.

By adding a pluggable **Snap Cloud batch capture engine** to `provider: "local"`, repositories with public or preview URLs can offload screenshot rendering to Snap Cloud, skip Playwright installation in CI entirely, and continue using GitHub Actions for zero-setup baseline storage, diffing, and PR commenting.

---

## 2. Configuration Contract

In `.github/snapdrift.json` (or inline config):

```json
{
  "provider": "local",
  "capture": "snap",
  "baseUrl": "https://preview.example.com",
  "routes": [
    { "id": "home", "path": "/", "viewport": "desktop" },
    { "id": "pricing", "path": "/pricing", "viewport": "mobile" }
  ]
}
```

### Schema Rules
- **`capture`**: Optional string. Allowed values: `"playwright"` (default) | `"snap"`. Overridable via `SNAPDRIFT_CAPTURE_ENGINE` environment variable.
- **Authentication**: When `capture: "snap"`, authentication uses `process.env.SNAP_API_KEY`. No project ID is required.
- **API URL**: Defaults internally to `https://snap.i2dev.com`.
- **Base URL Validation**:
  - `isLocalBaseUrl(config.baseUrl)` evaluates loopback addresses (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`).
  - If `baseUrl` is local and `capture: "snap"` is configured:
    - In CLI/local development, if Playwright is available, it gracefully falls back to local Playwright with a notice, or errors if unresolvable.
    - In CI workflows targeting public preview deployments, `baseUrl` is remote and Snap Cloud batch capture executes.

---

## 3. Data Flow & Batch Lifecycle

```
[Selected Routes]
       │
       ▼
1. Map routes to batch items (url, viewport)
       │
       ▼
2. POST https://snap.i2dev.com/v1/screenshots (Bearer SNAP_API_KEY)
   Body: { format: "png", fullPage: true, items: [...] }
       │
       ▼ Returns { batchId, status: "queued", statusUrl }
3. Poll GET /v1/screenshots/:batchId every 1.5s
       │
       ▼ status: "completed"
4. Download PNGs in parallel from item.imageUrl -> screenshots/<sanitizedRouteId>.png
       │
       ▼
5. Inspect image dimensions and write results.json & manifest.json
       │
       ▼
6. Run local pixel comparison (@snapdrift/compare-core)
```

### Route & Viewport Mapping
- Viewports are resolved via `@snapdrift/manifest` presets:
  - `"desktop"` → `{ width: 1440, height: 900 }`
  - `"mobile"` → `{ width: 390, height: 844 }`
  - Custom objects `{ width, height }` are passed directly.
- Full target URLs are constructed via `new URL(route.path, config.baseUrl).href`.

### Polling & Timeout
- Poll interval: 1.5 seconds.
- Monotonic operation deadline: 5 minutes.
- Stops when `status === "completed"`.

### Artifact Generation
- Downloaded PNGs are written to `<screenshotsRoot>/screenshots/<sanitizedRouteId>.png`.
- Output structure matches `runBaselineCapture`:
  - `manifest.json`: lists screenshots with route id, path, viewport, relative imagePath, and dimensions.
  - `results.json`: records capture metadata with engine `snap-batch`.

---

## 4. Error Handling & Resilience

1. **Individual Route Failure in Batch**:
   - Snap Cloud returns batches even if some URLs fail (`status: "failed"` on specific items).
   - SnapDrift adheres to its strict baseline contract: any navigation error or HTTP failure rejects the capture to prevent committing broken states.
   - Halts immediately with: `Route "<id>" failed cloud capture: <error.message> (<error.code>)`.
2. **Authentication (401)**:
   - Fails fast with: `Missing or invalid SNAP_API_KEY for Snap Cloud batch screenshot capture.`
3. **Transient Server Errors (5xx)**:
   - Retries up to 3 times with exponential backoff (1s, 2s, 4s).
4. **Rate Limits (429)**:
   - Honors `Retry-After` header when available. Surfaces quota exhaustion errors clearly.
5. **Private Addresses (400 `unsafe_url`)**:
   - Prevented ahead of time via early `isLocalBaseUrl` check.

---

## 5. GitHub Actions Optimization

In `actions/baseline/action.yml` and `actions/pr-diff/action.yml`:
Playwright installation is skipped when `capture: "snap"` and `baseUrl` is remote:

```yaml
- name: Install Playwright Chromium
  if: >
    steps.scope.outputs.should_run == 'true' &&
    (
      (steps.config.outputs.provider == 'local' && steps.config.outputs.capture_engine != 'snap') ||
      steps.config.outputs.snap_local_capture == 'true' ||
      steps.config.outputs.on_unavailable == 'fallback-local'
    )
```

This cuts CI setup time by 45–90 seconds per run on pull requests.

---

## 6. Testing Strategy

1. **`@snapdrift/manifest` Tests**:
   - Validate `capture` field (`"playwright"`, `"snap"`).
   - Rejection of invalid capture engine strings.
2. **`@snapdrift/adapter-fs` Tests**:
   - Unit tests for `runSnapBatchCapture` with mocked HTTP responses:
     - Successful batch submission, polling cycle, and image download.
     - Propagation of single-item failure in batch.
     - Handling 401, 429, and 5xx retries.
     - Verification of output `manifest.json`, `results.json`, and file paths.
3. **Action Contract Tests**:
   - Verify composite action YAML outputs and Playwright installation condition logic.
