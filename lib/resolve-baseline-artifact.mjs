// @ts-check

/**
 * @typedef {{
 *   found: boolean,
 *   resolutionStatus: 'found' | 'missing',
 *   artifactName: string,
 *   headSha?: string,
 *   runId?: string,
 *   targetSha?: string,
 *   distance?: number,
 *   message: string
 * }} BaselineResolution
 */

/**
 * Upper bound on distinct commit comparisons made while searching for an
 * ancestor baseline, so a long run of unrelated baselines cannot exhaust the
 * API rate limit.
 */
export const MAX_ANCESTOR_COMPARISONS = 100;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Resolve the most recent successful, non-expired SnapDrift baseline artifact.
 *
 * Without `targetSha` that is the newest qualifying run on the branch. With
 * `targetSha` the baseline is bound to that commit: a baseline published from
 * exactly that commit wins, otherwise the newest baseline published from an
 * ancestor of it is used. Baselines from descendant or diverged commits are
 * never returned.
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
 *     }, repos?: { compareCommits: Function } }
 *   },
 *   repository: string,
 *   workflowId: string,
 *   branch: string,
 *   artifactName: string,
 *   targetSha?: string
 * }} options
 * @returns {Promise<BaselineResolution>}
 */
export async function resolveBaselineArtifact({
  github,
  repository,
  workflowId,
  branch,
  artifactName,
  targetSha
}) {
  const { owner, repo } = parseBaselineRepository(repository);
  if (typeof artifactName !== 'string' || artifactName.trim().length === 0) {
    throw new Error('Invalid baseline artifact name. Expected a non-empty name.');
  }
  const target = normalizeTargetSha(targetSha);

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

  /**
   * @param {{id: number}} run
   * @returns {Promise<{name: string}|undefined>}
   */
  const findBaselineArtifact = async (run) => {
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

    return namedArtifacts.find((artifact) => !artifact.expired);
  };

  /** @type {Array<{id: number, head_sha: string}>} */
  const qualifyingRuns = [];
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

    if (target) {
      qualifyingRuns.push(run);
      continue;
    }

    const match = await findBaselineArtifact(run);
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

  if (!target) {
    return {
      found: false,
      resolutionStatus: 'missing',
      artifactName,
      message: `No non-expired SnapDrift baseline artifact named ${artifactName} was found.`
    };
  }

  /**
   * @param {{id: number, head_sha: string}} run
   * @param {number} distance
   * @returns {Promise<BaselineResolution|undefined>}
   */
  const resolveFromRun = async (run, distance) => {
    const match = await findBaselineArtifact(run);
    if (!match) return undefined;
    return {
      found: true,
      resolutionStatus: 'found',
      artifactName: match.name,
      headSha: run.head_sha,
      runId: String(run.id),
      targetSha: target,
      distance,
      message: ''
    };
  };

  // Pass 1: a baseline published from exactly the target commit.
  for (const run of qualifyingRuns) {
    if (run.head_sha.toLowerCase() !== target) continue;
    const resolved = await resolveFromRun(run, 0);
    if (resolved) return resolved;
  }

  // Pass 2: the newest baseline published from an ancestor of the target.
  /** @type {Map<string, number|null>} head sha -> commits the target is ahead, null when not an ancestor */
  const ancestorDistances = new Map();
  let comparisons = 0;
  let rejected = 0;
  for (const run of qualifyingRuns) {
    const headSha = run.head_sha.toLowerCase();
    if (headSha === target) continue;

    let distance = ancestorDistances.get(headSha);
    if (distance === undefined) {
      if (comparisons >= MAX_ANCESTOR_COMPARISONS) {
        return {
          found: false,
          resolutionStatus: 'missing',
          artifactName,
          targetSha: target,
          message: `No non-expired SnapDrift baseline artifact named ${artifactName} was found at or before target commit ${target.slice(0, 7)}; the ancestor search was capped after ${MAX_ANCESTOR_COMPARISONS} commit comparisons (${rejected} newer or unrelated baseline(s) rejected).`
        };
      }
      comparisons += 1;
      distance = await measureAncestorDistance({ github, owner, repo, baseSha: run.head_sha, targetSha: target });
      ancestorDistances.set(headSha, distance);
    }

    if (distance === null) {
      rejected += 1;
      continue;
    }
    const resolved = await resolveFromRun(run, distance);
    if (resolved) return resolved;
  }

  return {
    found: false,
    resolutionStatus: 'missing',
    artifactName,
    targetSha: target,
    message: `No non-expired SnapDrift baseline artifact named ${artifactName} was found at or before target commit ${target.slice(0, 7)} (${rejected} newer or unrelated baseline(s) rejected).`
  };
}

/**
 * Number of commits between `baseSha` and `targetSha` when `baseSha` is the
 * target itself or one of its ancestors; null when it is a descendant, on a
 * diverged line, or no longer exists.
 *
 * @param {{
 *   github: { rest: { repos?: { compareCommits: Function } } },
 *   owner: string,
 *   repo: string,
 *   baseSha: string,
 *   targetSha: string
 * }} options
 * @returns {Promise<number|null>}
 */
async function measureAncestorDistance({ github, owner, repo, baseSha, targetSha }) {
  if (typeof github.rest.repos?.compareCommits !== 'function') {
    throw new Error('Binding the baseline to a target commit requires github.rest.repos.compareCommits.');
  }
  let response;
  try {
    // Only the status and counts are used, so ask for a single commit.
    response = await github.rest.repos.compareCommits({ owner, repo, base: baseSha, head: targetSha, per_page: 1 });
  } catch (error) {
    // The baseline commit is gone (for example after a force-push), so it can
    // never be an ancestor of the target. Anything else is a real API failure.
    if (error && typeof error === 'object' && /** @type {{status?: unknown}} */ (error).status === 404) {
      return null;
    }
    throw error;
  }

  const data = response && typeof response === 'object' ? response.data : undefined;
  if (!data || typeof data !== 'object' || typeof data.status !== 'string') {
    throw new Error(`GitHub returned a malformed commit comparison for ${baseSha.slice(0, 7)}...${targetSha.slice(0, 7)}.`);
  }
  switch (data.status) {
    case 'identical':
      return 0;
    case 'ahead':
      if (typeof data.ahead_by !== 'number' || !Number.isInteger(data.ahead_by) || data.ahead_by < 0) {
        throw new Error(`GitHub returned a malformed commit comparison for ${baseSha.slice(0, 7)}...${targetSha.slice(0, 7)}.`);
      }
      return data.ahead_by;
    case 'behind':
    case 'diverged':
      return null;
    default:
      throw new Error(`GitHub returned a malformed commit comparison for ${baseSha.slice(0, 7)}...${targetSha.slice(0, 7)}.`);
  }
}

/**
 * @param {unknown} targetSha
 * @returns {string|undefined} lower-case full SHA, or undefined when unbound
 */
function normalizeTargetSha(targetSha) {
  if (targetSha === undefined || targetSha === null) return undefined;
  if (typeof targetSha !== 'string') {
    throw new Error('Invalid baseline target SHA. Expected a 40-character hexadecimal commit SHA.');
  }
  const value = targetSha.trim();
  if (value.length === 0) return undefined;
  if (!FULL_SHA_PATTERN.test(value)) {
    throw new Error(`Invalid baseline target SHA "${value}". Expected a 40-character hexadecimal commit SHA.`);
  }
  return value.toLowerCase();
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
