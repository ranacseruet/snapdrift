import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), '..');

// An immutable-SHA pin: `uses: ranacseruet/snapdrift/actions/<baseline|pr-diff>@<40-hex>`.
const INNER_PIN_PATTERN = /uses:\s+ranacseruet\/snapdrift\/actions\/(baseline|pr-diff)@([0-9a-f]{40})/g;

/**
 * Read the dispatcher's immutable commit-SHA pin from root action.yml source. Returns null when the
 * root action does not pin to an immutable SHA (for example, an unreleased version still delegates
 * to its upcoming `@vX.Y.Z` tag).
 * @param {string} actionSource
 * @returns {string | null}
 */
export function readPinnedSha(actionSource) {
  const matches = [...actionSource.matchAll(INNER_PIN_PATTERN)];
  return matches.length > 0 ? matches[0][2] : null;
}

/**
 * Decide whether the dispatcher's pinned SHA is stale — i.e. it predates the newest commit that
 * touched `actions/`, so consumers of the Marketplace root action would execute stale wrapper code.
 *
 * @param {{
 *   pinnedSha: string | null,
 *   newestActionsCommit: string | null,
 *   pinContainsNewestActions: boolean
 * }} state
 * @returns {boolean} true when the pinned SHA predates the newest commit touching actions/
 */
export function isPinStale({ pinnedSha, newestActionsCommit, pinContainsNewestActions }) {
  if (!pinnedSha || !newestActionsCommit) {
    return false;
  }
  if (pinnedSha === newestActionsCommit) {
    return false;
  }
  // Fresh when the newest actions commit is an ancestor of the pin (the pin already includes it).
  return !pinContainsNewestActions;
}

/**
 * @param {string} repoRoot
 * @returns {Promise<string | null>} the newest commit touching actions/, or null when git has none.
 */
async function readNewestActionsCommit(repoRoot) {
  try {
    return execFileSync(
      'git', ['log', '-1', '--format=%H', '--', 'actions/'],
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * @typedef {{ stale: boolean }} PinStalenessResult
 */

/**
 * Compare the dispatcher's pinned SHA against the newest commit touching actions/ and report whether
 * the pin is stale. Pure of git process exit; main() wraps this to translate a stale result into a
 * non-zero exit code.
 * @param {{ repoRoot: string, actionPath: string }} targets
 * @returns {Promise<PinStalenessResult>}
 */
export async function checkPinStale({ repoRoot, actionPath }) {
  const actionSource = await fs.readFile(actionPath, 'utf8');
  const pinnedSha = readPinnedSha(actionSource);
  const newestActionsCommit = await readNewestActionsCommit(repoRoot);

  if (!pinnedSha || !newestActionsCommit) {
    process.stdout.write(
      `Dispatcher pin staleness skipped: pinnedSha=${pinnedSha ?? 'none'}, ` +
      `newestActionsCommit=${newestActionsCommit ?? 'none'}.\n`
    );
    return { stale: false };
  }

  let pinContainsNewestActions = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', newestActionsCommit, pinnedSha], { cwd: repoRoot });
  } catch {
    pinContainsNewestActions = false;
  }

  if (isPinStale({ pinnedSha, newestActionsCommit, pinContainsNewestActions })) {
    process.stderr.write(
      `Dispatcher pin @${pinnedSha} is stale: it predates the newest commit touching actions/ ` +
      `(${newestActionsCommit}). Bump action.yml so both inner pins point at a commit that includes ` +
      'the latest wrapper changes.\n'
    );
    return { stale: true };
  }

  process.stdout.write(`Dispatcher pin @${pinnedSha} is fresh relative to wrapper changes.\n`);
  return { stale: false };
}

/**
 * Translate a staleness check into a CLI exit code: exit 1 when the dispatcher pin is stale, so the
 * release workflow can fail the build. Optional overrides exist so this can be driven against a
 * repository other than the one this script lives in (for example, a temporary git repo in tests).
 * @param {{ repoRoot?: string, actionPath?: string }} [targets]
 * @returns {Promise<void>}
 */
export async function runMainIfCalled({ repoRoot: overridesRepoRoot, actionPath: overridesActionPath } = {}) {
  const resolvedRepoRoot = overridesRepoRoot ?? defaultRepoRoot;
  const resolvedActionPath = overridesActionPath ?? path.join(resolvedRepoRoot, 'action.yml');
  const { stale } = await checkPinStale({ repoRoot: resolvedRepoRoot, actionPath: resolvedActionPath });
  if (stale) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  await runMainIfCalled();
}
