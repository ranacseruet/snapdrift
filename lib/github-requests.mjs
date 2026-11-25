// @ts-check

import { selectConfiguredRoutes, selectRoutesForChangedFiles, splitCommaList } from './snapdrift-config.mjs';

/** @typedef {import('../types/visual-diff-types').VisualRegressionConfig} VisualRegressionConfig */
/** @typedef {{ filename: string, status?: string, previous_filename?: string }} PullRequestFile */
/** @typedef {ReturnType<typeof selectRoutesForChangedFiles>} ScopeDecision */
/** @typedef {{ paginate: Function, rest: { pulls: { listFiles: Function } } }} ScopeGitHubClient */
/**
 * @typedef {{
 *   paginate: Function,
 *   rest: { issues: {
 *     listComments: Function,
 *     createComment: Function,
 *     updateComment: Function,
 *     deleteComment: Function
 *   } }
 * }} CommentGitHubClient
 */

/**
 * @typedef {{
 *   rest: {
 *     pulls: { get: Function },
 *     repos: { compareCommits: Function, getCommit: Function }
 *   }
 * }} BaselineTargetGitHubClient
 */
/** @typedef {'pr-head-merge-base' | 'merge-ref-base' | 'unrecognized-checkout'} BaselineTargetReason */

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * @param {{ github: ScopeGitHubClient, owner: string, repo: string, pullNumber: number }} options
 * @returns {Promise<PullRequestFile[]>}
 */
export async function fetchPullRequestFiles({ github, owner, repo, pullNumber }) {
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });
  if (!Array.isArray(files)) {
    throw new Error('Malformed GitHub changed-file response: expected an array of file records.');
  }
  for (const [index, file] of files.entries()) {
    if (!file || typeof file !== 'object' || typeof file.filename !== 'string' || file.filename.length === 0) {
      throw new Error(`Malformed GitHub changed-file response: file record ${index} must include a non-empty string filename.`);
    }
  }
  return files;
}

/**
 * @param {{ config: VisualRegressionConfig, files: PullRequestFile[] }} options
 * @returns {ScopeDecision}
 */
export function resolveScopeDecision({ config, files }) {
  if (files.length >= 3000) {
    return { shouldRun: true, reason: 'changed_files_truncated', selectedRouteIds: (config.routes || []).map((route) => route.id) };
  }
  const changedFiles = [...new Set(files.flatMap((file) => [
    file.filename,
    ...(file.status === 'renamed' && typeof file.previous_filename === 'string' && file.previous_filename
      ? [file.previous_filename]
      : [])
  ]))];
  return selectRoutesForChangedFiles(config, changedFiles);
}

/**
 * @param {{
 *   github: ScopeGitHubClient,
 *   owner: string,
 *   repo: string,
 *   config: VisualRegressionConfig,
 *   pullNumber: number,
 *   routeIds?: string,
 *   forceRun?: boolean,
 *   forceRunReason?: string,
 *   warning?: (message: string) => void
 * }} options
 * @returns {Promise<ScopeDecision>}
 */
export async function resolvePullRequestScope({ github, owner, repo, config, pullNumber, routeIds = '', forceRun = false, forceRunReason = 'forced', warning = (_message) => {} }) {
  const allRouteIds = (config.routes || []).map((route) => route.id);
  const explicitRouteIds = splitCommaList(routeIds);
  if (explicitRouteIds.length > 0) {
    const selected = selectConfiguredRoutes(config, explicitRouteIds);
    return { shouldRun: true, reason: 'explicit_route_ids', selectedRouteIds: selected.selectedRouteIds };
  }
  if (forceRun) {
    return { shouldRun: true, reason: forceRunReason || 'forced', selectedRouteIds: allRouteIds };
  }
  if (!Number.isFinite(pullNumber) || pullNumber <= 0) {
    return { shouldRun: true, reason: 'missing_pr_number', selectedRouteIds: allRouteIds };
  }
  try {
    const files = await fetchPullRequestFiles({ github, owner, repo, pullNumber });
    const scope = resolveScopeDecision({ config, files });
    if (scope.reason === 'changed_files_truncated') {
      warning('GitHub returned the maximum 3000 changed-file records; the list may be truncated, so running all configured captures.');
    }
    return scope;
  } catch (error) {
    warning(`Unable to inspect PR files for SnapDrift scope; running all configured captures instead. ${error.message}`);
    return { shouldRun: true, reason: 'snapdrift_scope_check_failed', selectedRouteIds: allRouteIds };
  }
}

/**
 * @param {{
 *   github: CommentGitHubClient,
 *   owner: string,
 *   repo: string,
 *   issueNumber: number,
 *   body: string,
 *   markers: readonly string[]
 * }} options
 * @returns {Promise<void>}
 */
export async function upsertPullRequestReportComment({ github, owner, repo, issueNumber, body, markers }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100
  });
  const matchingComments = comments
    .filter((comment) => comment.body && markers.some((marker) => comment.body.includes(marker)))
    .sort((left, right) => {
      const leftTime = new Date(left.updated_at || left.created_at).getTime();
      const rightTime = new Date(right.updated_at || right.created_at).getTime();
      // NaN (unparseable timestamps) makes the comparator's contract
      // unreliable: subtracting NaN yields NaN, and V8 treats an unsorted
      // NaN result as "keep order", which would pick an arbitrary comment
      // to update. Send non-finite timestamps to the end deterministically.
      const leftFinite = Number.isFinite(leftTime);
      const rightFinite = Number.isFinite(rightTime);
      if (!leftFinite && !rightFinite) return 0;
      if (!leftFinite) return 1;
      if (!rightFinite) return -1;
      return rightTime - leftTime;
    });
  const existing = matchingComments[0];
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
  for (const duplicate of matchingComments.slice(1)) {
    await github.rest.issues.deleteComment({ owner, repo, comment_id: duplicate.id });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string} lower-case full commit SHA
 */
function requireCommitSha(value, label) {
  if (typeof value !== 'string' || !FULL_SHA_PATTERN.test(value)) {
    throw new Error(`Malformed GitHub response: ${label} must be a 40-character commit SHA.`);
  }
  return value.toLowerCase();
}

/**
 * Work out which base-branch commit the checked-out PR tree is built on, so
 * the baseline can be bound to it. A checkout of the PR merge ref
 * (`refs/pull/N/merge`, the `pull_request` default) is built on the base tip
 * recorded as its first parent; a checkout of the PR head is built on the
 * merge base of the PR head and its base branch. Any other checkout cannot be
 * tied to a base commit, so no target is returned and the caller decides how
 * to proceed.
 *
 * @param {{
 *   github: BaselineTargetGitHubClient,
 *   owner: string,
 *   repo: string,
 *   pullNumber: number,
 *   checkedOutSha: string
 * }} options
 * @returns {Promise<{ targetSha: string | null, reason: BaselineTargetReason }>}
 */
export async function resolveBaselineTargetSha({ github, owner, repo, pullNumber, checkedOutSha }) {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('Cannot bind the baseline to a pull request without a valid pull request number.');
  }
  if (typeof checkedOutSha !== 'string' || !FULL_SHA_PATTERN.test(checkedOutSha.trim())) {
    return { targetSha: null, reason: 'unrecognized-checkout' };
  }
  const checkedOut = checkedOutSha.trim().toLowerCase();

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (!pr || typeof pr !== 'object' || !pr.head || typeof pr.head !== 'object' || !pr.base || typeof pr.base !== 'object') {
    throw new Error('Malformed GitHub pull request response: expected head and base records.');
  }
  const headSha = requireCommitSha(pr.head.sha, 'pull request head.sha');
  const baseSha = requireCommitSha(pr.base.sha, 'pull request base.sha');
  // The branch name tracks the current base tip, which is what the PR merges
  // into; base.sha can be stale once the base branch has moved on.
  const baseRef = typeof pr.base.ref === 'string' && pr.base.ref.length > 0 ? pr.base.ref : baseSha;

  if (checkedOut === headSha) {
    const { data: comparison } = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: baseRef,
      head: headSha,
      per_page: 1
    });
    return {
      targetSha: requireCommitSha(comparison?.merge_base_commit?.sha, 'comparison merge_base_commit.sha'),
      reason: 'pr-head-merge-base'
    };
  }

  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: checkedOut });
  if (!commit || typeof commit !== 'object' || !Array.isArray(commit.parents)) {
    throw new Error('Malformed GitHub commit response: expected a parents array.');
  }
  if (commit.parents.length === 2 && commit.parents[1]?.sha?.toLowerCase?.() === headSha) {
    return {
      targetSha: requireCommitSha(commit.parents[0]?.sha, 'merge commit first parent sha'),
      reason: 'merge-ref-base'
    };
  }

  return { targetSha: null, reason: 'unrecognized-checkout' };
}
