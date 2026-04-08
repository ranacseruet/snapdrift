// @ts-check

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runBaselineCapture } from './capture-routes.mjs';
import { generateDriftReport, shouldFailDriftCheck } from './compare-results.mjs';
import { generateHtmlReport } from './report.mjs';
import { loadSnapdriftConfig } from './snapdrift-config.mjs';

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
 *   diffDir: string
 * }} CliOptions
 */

/**
 * Parse CLI arguments from process.argv (or a provided argv array).
 * Supported commands: capture, diff
 * Supported flags:
 *   --open              Open the HTML report after diff
 *   --config <path>     Path to snapdrift.json (default: .github/snapdrift.json)
 *   --routes <ids>      Comma-separated route IDs to run
 *   --baseline-dir <p>  Override local baseline directory (default: .snapdrift/baseline)
 *   --current-dir <p>   Override local current-capture directory (default: .snapdrift/current)
 *   --diff-dir <p>      Override local diff-output directory (default: .snapdrift/diff)
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
    }
  }

  return { command, open, configPath, routes, baselineDir, currentDir, diffDir };
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
      ? '\u2705' // ✅
      : summary.status === 'changes-detected'
        ? '\uD83D\uDFE1' // 🟡
        : '\u274C'; // ❌
  const statusLabel =
    summary.status === 'clean'
      ? 'Clean'
      : summary.status === 'changes-detected'
        ? 'Drift detected'
        : summary.status ?? 'Unknown';

  process.stdout.write(`\n${statusIcon}  SnapDrift \u2014 ${statusLabel}\n`);
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
      process.stdout.write(`     \u2022 ${item.id} (${pct}% diff)\n`);
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
  const { selectedRouteIds } = await runBaselineCapture({
    configPath: opts.configPath,
    routeIds: opts.routes.length > 0 ? opts.routes : undefined,
    outDir: opts.baselineDir
  });
  process.stdout.write(`Captured ${selectedRouteIds.length} route(s) to ${opts.baselineDir}\n`);
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

  const currentCapture = await runBaselineCapture({
    configPath: opts.configPath,
    routeIds: opts.routes.length > 0 ? opts.routes : undefined,
    outDir: opts.currentDir
  });

  process.stdout.write('Comparing against baseline ...\n');

  const baselineResultsPath = path.join(opts.baselineDir, path.basename(config.resultsFile));
  const baselineManifestPath = path.join(opts.baselineDir, path.basename(config.manifestFile));

  await fs.mkdir(opts.diffDir, { recursive: true });
  const summaryPath = path.join(opts.diffDir, 'summary.json');
  const markdownPath = path.join(opts.diffDir, 'summary.md');
  const htmlPath = path.join(opts.diffDir, 'report.html');

  const { summary, markdown } = await generateDriftReport({
    configPath: opts.configPath,
    routeIds: opts.routes.length > 0 ? opts.routes : undefined,
    baselineResultsPath,
    baselineManifestPath,
    currentResultsPath: currentCapture.resultsPath,
    currentManifestPath: currentCapture.manifestPath,
    baselineRunDir: opts.baselineDir,
    currentRunDir: currentCapture.screenshotsRoot
  });

  const html = await generateHtmlReport(summary, {
    baselineRunDir: opts.baselineDir,
    currentRunDir: currentCapture.screenshotsRoot
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
 * Main CLI entry point — parse args and dispatch to the appropriate command.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.command === 'capture') {
    await runCaptureCommand(opts);
  } else if (opts.command === 'diff') {
    await runDiffCommand(opts);
  } else {
    process.stderr.write(
      `Unknown command: ${opts.command}\nUsage: snapdrift <capture|diff> [options]\n`
    );
    process.exitCode = 1;
  }
}
