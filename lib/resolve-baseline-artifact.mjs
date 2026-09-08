// @ts-check

/**
 * @typedef {{
 *   found: boolean,
 *   resolutionStatus: 'found' | 'missing',
 *   artifactName: string,
 *   headSha?: string,
 *   runId?: string,
 *   message: string
 * }} BaselineResolution
 */

/**
 * Resolve the most recent successful, non-expired SnapDrift baseline artifact.
 *
 * The GitHub API calls are kept here so the standalone resolver and the PR
 * wrapper share the same response validation and pagination behavior.
 *
 * @param {{
 *   github: {
 *     paginate: Function,
 *     rest: { actions: {
 *       listWorkflowRuns: Function,
 *       listWorkflowRunArtifacts: Function
 *     }}
 *   },
 *   repository: string,
 *   workflowId: string,
 *   branch: string,
 *   artifactName: string
 * }} options
 * @returns {Promise<BaselineResolution>}
 */
export async function resolveBaselineArtifact({
  github,
  repository,
  workflowId,
  branch,
  artifactName
}) {
  const { owner, repo } = parseBaselineRepository(repository);
  if (typeof artifactName !== 'string' || artifactName.trim().length === 0) {
    throw new Error('Invalid baseline artifact name. Expected a non-empty name.');
  }

  // Search the complete successful-run history so an older, still-valid
  // baseline remains discoverable; 100 keeps that intentional search to the
  // fewest API pages GitHub allows.
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: workflowId,
    branch,
    event: 'push',
    per_page: 100
  });

  if (!Array.isArray(runs)) {
    throw new Error('GitHub returned an invalid workflow run list.');
  }

  for (const run of runs) {
    validateWorkflowRun(run);

    // GitHub returns a null conclusion for queued and in-progress runs. They
    // are valid records and must be ignored before inspecting terminal fields.
    if (run.status !== 'completed') {
      continue;
    }
    if (typeof run.conclusion !== 'string') {
      throw new Error(`GitHub returned a malformed completed workflow run record for run ${run.id}.`);
    }
    if (run.conclusion !== 'success') {
      continue;
    }

    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      owner,
      repo,
      run_id: run.id,
      per_page: 100
    });
    if (!Array.isArray(artifacts)) {
      throw new Error(`GitHub returned a malformed artifact list for workflow run ${run.id}.`);
    }

    // Only the artifact SnapDrift depends on needs strict field validation.
    // Other artifacts in the same run belong to the consumer workflow and may
    // legitimately have a different shape.
    const namedArtifacts = artifacts.filter((artifact) => (
      artifact && typeof artifact === 'object' && artifact.name === artifactName
    ));
    for (const artifact of namedArtifacts) {
      if (typeof artifact.expired !== 'boolean') {
        throw new Error(`GitHub returned a malformed baseline artifact record for workflow run ${run.id}.`);
      }
    }

    const match = namedArtifacts.find((artifact) => !artifact.expired);
    if (match) {
      return {
        found: true,
        resolutionStatus: 'found',
        artifactName: match.name,
        headSha: run.head_sha,
        runId: String(run.id),
        message: ''
      };
    }
  }

  return {
    found: false,
    resolutionStatus: 'missing',
    artifactName,
    message: `No non-expired SnapDrift baseline artifact named ${artifactName} was found.`
  };
}

/**
 * @param {string} repository
 * @returns {{owner: string, repo: string}}
 */
export function parseBaselineRepository(repository) {
  const value = String(repository || '').trim();
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Invalid baseline repository "${value}". Expected owner/name.`);
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}

/**
 * @param {unknown} run
 * @returns {asserts run is {id: number, status: string, head_sha: string, conclusion?: unknown}}
 */
function validateWorkflowRun(run) {
  if (!run || typeof run !== 'object') {
    throw new Error('GitHub returned a malformed workflow run record.');
  }
  const record = /** @type {Record<string, unknown>} */ (run);
  if (typeof record.id !== 'number' || !Number.isInteger(record.id) || record.id <= 0 ||
      typeof record.status !== 'string' || typeof record.head_sha !== 'string' || record.head_sha.length === 0) {
    throw new Error('GitHub returned a malformed workflow run record.');
  }
}
