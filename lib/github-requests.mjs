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
