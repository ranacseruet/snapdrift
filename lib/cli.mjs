// @ts-check

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadSnapdriftConfig } from '@snapdrift/adapter-fs';
import { shouldFailDriftCheck } from '@snapdrift/manifest';
import { createProvider } from './provider.mjs';
import { captureWithPolicy, diffWithPolicy, publishBaselineWithPolicy } from './outage-policy.mjs';
import { generateHtmlReport } from './report.mjs';

/** @typedef {import('../types/visual-diff-types').VisualDiffSummary} DriftSummary */

export const LOCAL_SNAPDRIFT_DIR = '.snapdrift';
export const LOCAL_BASELINE_SUBDIR = 'baseline';
export const LOCAL_CURRENT_SUBDIR = 'current';
export const LOCAL_DIFF_SUBDIR = 'diff';

/**
 * @typedef {{
 *   command: string,
 *   open: boolean,
 *   configPath?: string,
 *   routes: string[],
 *   baselineDir: string,
 *   currentDir: string,
 *   diffDir: string,
 *   to?: 'snap' | 'local',
 *   from?: 'snap',
 *   acceptCrossEngine?: boolean,
 *   fromSnapAction?: string
 * }} CliOptions
 */

/**
 * Parse CLI arguments from process.argv (or a provided argv array).
 * Supported commands: capture, baseline, diff, migrate-baselines, init
 * Supported flags:
 *   --open              Open the HTML report after diff
 *   --config <path>     Path to snapdrift.json (default: .github/snapdrift.json)
 *   --routes <ids>      Comma-separated route IDs to run
 *   --baseline-dir <p>  Override local baseline directory (default: .snapdrift/baseline)
 *   --current-dir <p>   Override local current-capture directory (default: .snapdrift/current)
 *   --diff-dir <p>      Override local diff-output directory (default: .snapdrift/diff)
 *   --to <snap|local>   Migration target (migrate-baselines command)
 *   --from <snap>       Migration source (migrate-baselines --to local)
 *   --accept-cross-engine  Allow importing baselines from a different capture engine
 *   --from-snap-action <path>  Snap action workflow YAML path (init command)
 *
 * @param {string[]} argv - process.argv
 * @returns {CliOptions}
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || 'diff';
  let open = false;
  /** @type {string | undefined} */
  let configPath;
  /** @type {string[]} */
  const routes = [];
  let baselineDir = path.resolve(LOCAL_SNAPDRIFT_DIR, LOCAL_BASELINE_SUBDIR);
  let currentDir = path.resolve(LOCAL_SNAPDRIFT_DIR, LOCAL_CURRENT_SUBDIR);
  let diffDir = path.resolve(LOCAL_SNAPDRIFT_DIR, LOCAL_DIFF_SUBDIR);
  /** @type {'snap' | 'local' | undefined} */
  let to;
  /** @type {'snap' | undefined} */
  let from;
  let acceptCrossEngine = false;
  /** @type {string | undefined} */
  let fromSnapAction;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--open') {
      open = true;
    } else if (arg === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === '--routes' && i + 1 < args.length) {
      routes.push(
        ...args[++i]
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      );
    } else if (arg === '--baseline-dir' && i + 1 < args.length) {
      baselineDir = path.resolve(args[++i]);
    } else if (arg === '--current-dir' && i + 1 < args.length) {
      currentDir = path.resolve(args[++i]);
    } else if (arg === '--diff-dir' && i + 1 < args.length) {
      diffDir = path.resolve(args[++i]);
    } else if (arg === '--to' && i + 1 < args.length) {
      const toVal = args[++i];
      if (toVal === 'snap' || toVal === 'local') {
        to = toVal;
      }
    } else if (arg === '--from' && i + 1 < args.length) {
      const fromVal = args[++i];
      if (fromVal === 'snap') {
        from = fromVal;
      }
    } else if (arg === '--accept-cross-engine') {
      acceptCrossEngine = true;
    } else if (arg === '--from-snap-action' && i + 1 < args.length) {
      fromSnapAction = args[++i];
    }
  }

  return { command, open, configPath, routes, baselineDir, currentDir, diffDir, to, from, acceptCrossEngine, fromSnapAction };
}

/**
 * Format and print a drift summary to stdout.
 *
 * @param {DriftSummary} summary
 * @returns {void}
 */
export function printSummary(summary) {
  const total = summary.totalScreenshots ?? summary.selectedRoutes?.length ?? 0;
  const matched = summary.matchedScreenshots ?? 0;
  const changed = summary.changedScreenshots ?? 0;
  const missing = (summary.missingInBaseline ?? 0) + (summary.missingInCurrent ?? 0);
  const errors = summary.errors?.length ?? 0;
  const dimensionChanges = summary.dimensionChanges?.length ?? 0;

  const statusIcon =
    summary.status === 'clean'
      ? '✅' // ✅
      : summary.status === 'changes-detected'
        ? '🟡' // 🟡
        : '❌'; // ❌
  const statusLabel =
    summary.status === 'clean'
      ? 'Clean'
      : summary.status === 'changes-detected'
        ? 'Drift detected'
        : summary.status ?? 'Unknown';

  process.stdout.write(`\n${statusIcon}  SnapDrift — ${statusLabel}\n`);
  process.stdout.write(`   Routes:   ${total}\n`);
  process.stdout.write(`   Matched:  ${matched}\n`);
  if (changed > 0) process.stdout.write(`   Changed:  ${changed}\n`);
  if (missing > 0) process.stdout.write(`   Missing:  ${missing}\n`);
  if (errors > 0) process.stdout.write(`   Errors:   ${errors}\n`);
  if (dimensionChanges > 0) process.stdout.write(`   Dim diff: ${dimensionChanges}\n`);

  if (summary.changed?.length) {
    process.stdout.write('\n   Changed routes:\n');
    for (const item of summary.changed) {
      const pct = ((item.mismatchRatio ?? 0) * 100).toFixed(2);
      process.stdout.write(`     • ${item.id} (${pct}% diff)\n`);
    }
  }

  process.stdout.write('\n');
}

/**
 * Open a file with the OS default viewer.
 *
 * @param {string} filePath
 * @returns {void}
 */
function openFile(filePath) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    execSync(`${cmd} "${filePath}"`);
  } catch {
    process.stderr.write(`Could not open file: ${filePath}\n`);
  }
}

/**
 * Run the `capture` command — capture screenshots to a local baseline directory.
 *
 * @param {CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runCaptureCommand(opts) {
  process.stdout.write(`Capturing baseline to ${opts.baselineDir} ...\n`);
  const { config } = await loadSnapdriftConfig(opts.configPath);
  const providerName = config.provider ?? 'local';
  const provider = createProvider(providerName, config);

  // onUnavailable: warn-and-skip — the user asked not to fail the build when
  // Snap is down. `diff` and `baseline` both honour this; `capture` used to
  // let SnapSkipError reach bin/snapdrift.mjs, which exits 1. See #108.
  const captured = await captureWithPolicy({
    provider,
    providerName,
    config,
    captureOptions: {
      configPath: opts.configPath,
      routeIds: opts.routes.length > 0 ? opts.routes : undefined,
      outDir: opts.baselineDir,
      purpose: 'baseline'
    },
    onSkip: () => process.stdout.write('Capture skipped (Snap unavailable, warn-and-skip mode).\n'),
    onFallback: () => process.stdout.write('Falling back to local provider for capture...\n')
  });

  if (captured.outcome === 'skipped') {
    return;
  }

  process.stdout.write(
    `Captured ${captured.result.selectedRouteIds.length} route(s) to ${opts.baselineDir}\n`
  );
}

/**
 * Run the `baseline` command — establish a baseline for the configured provider.
 *
 * For `provider: "local"` this is `capture`: the screenshots written to
 * `--baseline-dir` *are* the baseline, and there is nothing to publish.
 *
 * For `provider: "snap"` the capture step only submits a run; the baseline is
 * not created until `publishBaseline()` harvests the rendered object keys. That
 * call previously existed only inside `actions/baseline`, which left anyone not
 * running GitHub Actions with no supported way to seed a hosted project — see
 * ranacseruet/snapdrift#106.
 *
 * Mirrors the two provider-conditional steps of `actions/baseline/action.yml`.
 *
 * @param {CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runBaselineCommand(opts) {
  const { config } = await loadSnapdriftConfig(opts.configPath);
  const providerName = config.provider ?? 'local';
  const provider = createProvider(providerName, config);

  process.stdout.write(
    providerName === 'snap'
      ? 'Establishing baseline via Snap ...\n'
      : `Capturing baseline to ${opts.baselineDir} ...\n`
  );

  /** @type {import('../types/visual-diff-types').ProviderCaptureOptions} */
  const captureOptions = {
    configPath: opts.configPath,
    routeIds: opts.routes.length > 0 ? opts.routes : undefined,
    outDir: opts.baselineDir,
    purpose: 'baseline'
  };

  const onFallback = () => process.stdout.write('Falling back to local provider for capture...\n');

  // Snap can go down during *either* phase — the capture submission or the
  // publish that follows it — and the user's `onUnavailable` choice must hold
  // for both, otherwise `warn-and-skip` still exits 1 and `fallback-local`
  // still leaves them with no baseline.
  const captured = await captureWithPolicy({
    provider,
    providerName,
    config,
    captureOptions,
    onSkip: () => process.stdout.write('Baseline skipped (Snap unavailable, warn-and-skip mode).\n'),
    onFallback
  });

  if (captured.outcome === 'skipped') {
    return;
  }

  if (captured.providerName !== 'snap') {
    const suffix = providerName === 'snap' ? ' (local fallback — nothing published to Snap)' : '';
    process.stdout.write(
      `Captured ${captured.result.selectedRouteIds.length} route(s) to ${opts.baselineDir}${suffix}\n`
    );
    return;
  }

  process.stdout.write(
    `Captured ${captured.result.selectedRouteIds.length} route(s); waiting for Snap to finish rendering ...\n`
  );

  const published = await publishBaselineWithPolicy({
    provider,
    publishOptions: { resultsPath: captured.result.resultsPath },
    captureOptions,
    onSkip: () =>
      process.stdout.write('Baseline publish skipped (Snap unavailable, warn-and-skip mode).\n'),
    onFallback
  });

  if (published.outcome === 'skipped') {
    return;
  }

  if (published.outcome === 'fell-back') {
    process.stdout.write(
      `Captured ${published.recapture?.selectedRouteIds.length ?? 0} route(s) to ${opts.baselineDir} (local fallback — nothing published to Snap)\n`
    );
    return;
  }

  process.stdout.write('Snap baseline published successfully.\n');
}

/**
 * Run the `diff` command — capture current screenshots, compare against the local baseline,
 * write a summary + HTML report, and optionally open it.
 *
 * @param {CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runDiffCommand(opts) {
  process.stdout.write(`Capturing current screenshots to ${opts.currentDir} ...\n`);
  const { config } = await loadSnapdriftConfig(opts.configPath);
  const providerName = config.provider ?? 'local';
  const provider = createProvider(providerName, config);

  /** @type {import('../types/visual-diff-types').ProviderCaptureOptions} */
  const captureOptions = {
    configPath: opts.configPath,
    routeIds: opts.routes.length > 0 ? opts.routes : undefined,
    outDir: opts.currentDir
  };

  const captured = await captureWithPolicy({
    provider,
    providerName,
    config,
    captureOptions,
    onSkip: () =>
      process.stdout.write('Visual regression skipped (Snap unavailable, warn-and-skip mode).\n'),
    onFallback: () => process.stdout.write('Falling back to local provider for capture...\n')
  });

  if (captured.outcome === 'skipped') {
    return;
  }

  const currentCapture = captured.result;

  process.stdout.write('Comparing against baseline ...\n');

  const baselineResultsPath = path.join(opts.baselineDir, path.basename(config.resultsFile));
  const baselineManifestPath = path.join(opts.baselineDir, path.basename(config.manifestFile));

  await fs.mkdir(opts.diffDir, { recursive: true });
  const summaryPath = path.join(opts.diffDir, 'summary.json');
  const markdownPath = path.join(opts.diffDir, 'summary.md');
  const htmlPath = path.join(opts.diffDir, 'report.html');

  const diffed = await diffWithPolicy({
    provider: captured.providerName === 'local' ? createProvider('local') : provider,
    providerName: captured.providerName,
    localScreenshots: captured.localScreenshots,
    captureOptions,
    diffOptions: {
      configPath: opts.configPath,
      routeIds: opts.routes.length > 0 ? opts.routes : undefined,
      baselineResultsPath,
      baselineManifestPath,
      currentResultsPath: currentCapture.resultsPath,
      currentManifestPath: currentCapture.manifestPath,
      baselineRunDir: opts.baselineDir,
      currentRunDir: currentCapture.screenshotsRoot
    },
    onSkip: () =>
      process.stdout.write('Visual regression skipped (Snap unavailable, warn-and-skip mode).\n'),
    onFallback: () => process.stdout.write('Falling back to local provider for the diff...\n'),
    onRecapture: () =>
      process.stdout.write('Recapturing locally so the local diff has screenshots to compare...\n')
  });

  if (diffed.outcome !== 'diffed') {
    return;
  }

  const { summary, markdown } = diffed.result;
  const currentRunDir = diffed.recapture?.screenshotsRoot ?? currentCapture.screenshotsRoot;

  const html = await generateHtmlReport(summary, {
    baselineRunDir: opts.baselineDir,
    currentRunDir
  });

  await Promise.all([
    fs.writeFile(summaryPath, JSON.stringify(summary, null, 2)),
    fs.writeFile(markdownPath, markdown),
    fs.writeFile(htmlPath, html)
  ]);

  printSummary(summary);

  if (opts.open) {
    openFile(htmlPath);
  } else if (summary.status !== 'clean') {
    process.stdout.write(`Report: ${htmlPath}\n`);
  }

  if (shouldFailDriftCheck(summary)) {
    process.exitCode = 1;
  }
}

/**
 * Run the `migrate-baselines` command — migrate baselines between local and Snap.
 *
 * @param {CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runMigrateBaselinesCommand(opts) {
  if (!opts.to || (opts.to !== 'snap' && opts.to !== 'local')) {
    process.stderr.write('Usage: snapdrift migrate-baselines --to <snap|local> [--from snap] [--accept-cross-engine] [--config <path>] [--baseline-dir <dir>]\n');
    process.exitCode = 1;
    return;
  }

  if (opts.to === 'local' && opts.from !== 'snap') {
    process.stderr.write('Error: --to local requires --from snap\n');
    process.exitCode = 1;
    return;
  }

  if (opts.acceptCrossEngine && opts.to !== 'local') {
    process.stderr.write('Error: --accept-cross-engine is only valid with --to local\n');
    process.exitCode = 1;
    return;
  }

  const { runMigrateToSnap, runMigrateToLocal } = await import('./migrate-baselines.mjs');
  const { config } = await loadSnapdriftConfig(opts.configPath);

  if (opts.to === 'snap') {
    await runMigrateToSnap(config, opts);
  } else {
    await runMigrateToLocal(config, opts);
  }
}

/**
 * Run the `init` command — initialize snapdrift config from a Snap action workflow.
 *
 * @param {CliOptions} opts
 * @returns {Promise<void>}
 */
export async function runInitCommand(opts) {
  if (!opts.fromSnapAction) {
    process.stderr.write('Usage: snapdrift init --from-snap-action <workflow-yaml-path>\n');
    process.exitCode = 1;
    return;
  }

  const { runInitFromAction } = await import('./init-from-action.mjs');
  await runInitFromAction(opts.fromSnapAction);
}

/**
 * Main CLI entry point — parse args and dispatch to the appropriate command.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.command === 'capture') {
    await runCaptureCommand(opts);
  } else if (opts.command === 'baseline') {
    await runBaselineCommand(opts);
  } else if (opts.command === 'diff') {
    await runDiffCommand(opts);
  } else if (opts.command === 'migrate-baselines') {
    await runMigrateBaselinesCommand(opts);
  } else if (opts.command === 'init') {
    await runInitCommand(opts);
  } else {
    process.stderr.write(
      `Unknown command: ${opts.command}\nUsage: snapdrift <capture|baseline|diff|migrate-baselines|init> [options]\n`
    );
    process.exitCode = 1;
  }
}