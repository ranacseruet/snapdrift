/** @jest-environment node */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { MAX_ANCESTOR_COMPARISONS, resolveBaselineArtifact } from '../lib/resolve-baseline-artifact.mjs';
import { executeActionScript } from './action-script-runner.mjs';
const REPO_ROOT = path.resolve('.');

const VALID_CONFIG = {
  baselineArtifactName: 'snapdrift-baseline',
  workingDirectory: '.',
  baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json',
  screenshotsRoot: 'screenshots',
  routes: [{ id: 'home', path: '/', viewport: 'desktop' }],
  diff: { threshold: 0.01, mode: 'strict' }
};

const ACTIONS = [
  {
    name: 'standalone resolver',
    path: 'actions/resolve-baseline/action.yml',
    stepId: 'resolve',
    standalone: true
  },
  {
    name: 'pr-diff resolver',
    path: 'actions/pr-diff/action.yml',
    stepId: 'baseline',
    standalone: false
  }
];

async function executeResolver(action, { github, configPath, inputs = {} }) {
  return executeActionScript({
    actionPath: path.join(REPO_ROOT, action.path),
    stepId: action.stepId,
    actionRoot: REPO_ROOT,
    githubActionPath: path.join(REPO_ROOT, 'actions', 'resolve-baseline'),
    githubWorkspace: REPO_ROOT,
    env: {
      REPO_CONFIG_PATH: configPath,
      INPUT_ARTIFACT_NAME: inputs.artifactName || '',
      INPUT_REPOSITORY: inputs.repository || '',
      INPUT_WORKFLOW_ID: inputs.workflowId || 'ci.yml',
      INPUT_BRANCH: inputs.branch || 'main',
      INPUT_TARGET_SHA: inputs.targetSha || ''
    },
    github,
    context: { repo: { owner: 'example', repo: 'app' } }
  });
}

function makeGithub({ runs = [], artifactsByRun = {}, paginateError, artifactError, artifactResponse } = {}) {
  const calls = [];
  const listWorkflowRuns = async () => ({ data: { workflow_runs: runs } });
  const listWorkflowRunArtifacts = async () => ({ data: { artifacts: [] } });
  return {
    calls,
    paginate: async (method, options) => {
      if (method === listWorkflowRunArtifacts) {
        calls.push({ type: 'artifacts', runId: options.run_id });
        if (artifactError) throw artifactError;
        if (artifactResponse !== undefined) return artifactResponse;
        return artifactsByRun[options.run_id] || [];
      }
      calls.push({ type: 'runs', options });
      if (paginateError) throw paginateError;
      return runs;
    },
    rest: {
      actions: {
        listWorkflowRuns,
        listWorkflowRunArtifacts
      }
    }
  };
}

async function writeConfig() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-baseline-resolution-'));
  const configPath = path.join(tempDir, 'snapdrift.json');
  await fs.writeFile(configPath, JSON.stringify(VALID_CONFIG));
  return { tempDir, configPath };
}

const API_ERRORS = [
  ['permission failure', Object.assign(new Error('Resource not accessible by integration'), { status: 403 })],
  ['rate limit', Object.assign(new Error('API rate limit exceeded'), { status: 429 })],
  ['not found', Object.assign(new Error('Not Found'), { status: 404 })],
  ['server failure', Object.assign(new Error('Internal Server Error'), { status: 500 })],
  ['network failure', new Error('fetch failed')]
];

describe.each(ACTIONS)('$name', (action) => {
  let tempDir;
  let configPath;

  beforeEach(async () => {
    ({ tempDir, configPath } = await writeConfig());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(API_ERRORS)('classifies a %s during workflow lookup as an error', async (_label, error) => {
    const result = await executeResolver(action, {
      configPath,
      github: makeGithub({ paginateError: error })
    });

    expect(result.outputs).toMatchObject({
      found: 'false',
      resolution_status: 'error'
    });
    expect(result.outputs.message).toMatch(/Unable to resolve the SnapDrift baseline artifact/);
    if (action.standalone) expect(result.failures).toHaveLength(1);
    else {
      expect(result.failures).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    }
  });

  it.each(API_ERRORS)('classifies an artifact-list %s as an error', async (_label, error) => {
    const result = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
        artifactError: error
      })
    });

    expect(result.outputs.resolution_status).toBe('error');
    if (action.standalone) expect(result.failures).toHaveLength(1);
    else expect(result.warnings).toHaveLength(1);
  });

  it('classifies malformed GitHub responses as errors', async () => {
    const malformedRuns = await executeResolver(action, {
      configPath,
      github: makeGithub({ runs: null })
    });
    expect(malformedRuns.outputs.resolution_status).toBe('error');
    if (action.standalone) expect(malformedRuns.failures).toHaveLength(1);
    else expect(malformedRuns.warnings).toHaveLength(1);

    const malformedArtifacts = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
        artifactResponse: { data: { artifacts: {} } }
      })
    });
    expect(malformedArtifacts.outputs.resolution_status).toBe('error');
    if (action.standalone) expect(malformedArtifacts.failures).toHaveLength(1);
    else expect(malformedArtifacts.warnings).toHaveLength(1);
  });

  it('distinguishes an intentional missing baseline from a found artifact', async () => {
    const missing = await executeResolver(action, {
      configPath,
      github: makeGithub()
    });
    expect(missing.outputs).toMatchObject({ found: 'false', resolution_status: 'missing' });
    expect(missing.failures).toHaveLength(0);

    const found = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
        artifactsByRun: { 42: [{ name: 'snapdrift-baseline', expired: false }] }
      })
    });
    expect(found.outputs).toMatchObject({ found: 'true', resolution_status: 'found' });
    expect(found.failures).toHaveLength(0);
  });

  it('keeps filtering unsuccessful runs and expired artifacts while honoring lookup overrides', async () => {
    const github = makeGithub({
      runs: [
        { id: 1, status: 'completed', conclusion: 'failure', head_sha: 'failed-sha' },
        { id: 2, status: 'completed', conclusion: 'success', head_sha: 'success-sha' }
      ],
      artifactsByRun: {
        2: [
          { name: 'snapdrift-baseline', expired: true },
          { name: 'other-artifact', expired: false },
          { name: action.standalone ? 'custom-baseline' : 'snapdrift-baseline', expired: false }
        ]
      }
    });
    const result = await executeResolver(action, {
      configPath,
      github,
      inputs: {
        ...(action.standalone ? { artifactName: 'custom-baseline' } : {}),
        repository: 'owner/other-repo',
        workflowId: 'visual.yml',
        branch: 'release'
      }
    });

    expect(result.outputs).toMatchObject({
      found: 'true',
      resolution_status: 'found',
      artifact_name: action.standalone ? 'custom-baseline' : 'snapdrift-baseline'
    });
    expect(github.calls[0]).toMatchObject({
      type: 'runs',
      options: {
        owner: 'owner',
        repo: 'other-repo',
        workflow_id: 'visual.yml',
        branch: 'release',
        per_page: 100
      }
    });
    expect(github.calls.filter((call) => call.type === 'artifacts')).toEqual([{ type: 'artifacts', runId: 2 }]);
  });

  it('ignores non-terminal runs with null conclusions before resolving a later baseline', async () => {
    const result = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [
          { id: 99, status: 'in_progress', conclusion: null, head_sha: 'inflight' },
          { id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }
        ],
        artifactsByRun: { 42: [{ name: 'snapdrift-baseline', expired: false }] }
      })
    });

    expect(result.outputs).toMatchObject({ found: 'true', resolution_status: 'found', run_id: '42' });
    expect(result.failures).toHaveLength(0);
  });

  it('ignores malformed unrelated artifacts but rejects a malformed matching artifact', async () => {
    const valid = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
        artifactsByRun: {
          42: [null, { name: 'coverage', expired: 'unknown' }, { name: 'snapdrift-baseline', expired: false }]
        }
      })
    });
    expect(valid.outputs).toMatchObject({ found: 'true', resolution_status: 'found' });

    const malformed = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
        artifactsByRun: { 42: [{ name: 'snapdrift-baseline', expired: null }] }
      })
    });
    expect(malformed.outputs.resolution_status).toBe('error');
    if (action.standalone) expect(malformed.failures).toHaveLength(1);
    else expect(malformed.warnings).toHaveLength(1);
  });

  it('reports malformed baseline repository input as a lookup error', async () => {
    const result = await executeResolver(action, {
      configPath,
      github: makeGithub(),
      inputs: { repository: 'owner-only' }
    });

    expect(result.outputs).toMatchObject({ found: 'false', resolution_status: 'error' });
    expect(result.outputs.message).toContain('Invalid baseline repository');
    if (action.standalone) expect(result.failures).toHaveLength(1);
    else expect(result.warnings).toHaveLength(1);
  });
});

describe('resolveBaselineArtifact bound to a target commit', () => {
  const sha = (char) => char.repeat(40);
  const TARGET = sha('f');
  const hex = (n) => n.toString(16).padStart(40, '0');

  const run = (id, headSha, overrides = {}) => ({ id, status: 'completed', conclusion: 'success', head_sha: headSha, ...overrides });
  const withBaseline = (...runIds) => Object.fromEntries(runIds.map((id) => [id, [{ name: 'snapdrift-baseline', expired: false }]]));

  /**
   * @param {{ runs: object[], artifactsByRun?: object, comparisons?: Record<string, object|Error> }} options
   */
  function bindingGithub({ runs, artifactsByRun = {}, comparisons = {} }) {
    const listWorkflowRunArtifacts = () => {};
    const compareCommits = jest.fn(async ({ base }) => {
      const outcome = comparisons[base];
      if (outcome instanceof Error) throw outcome;
      return { data: outcome ?? { status: 'diverged', ahead_by: 1, behind_by: 1 } };
    });
    return {
      compareCommits,
      artifactCalls: [],
      paginate: jest.fn(async function (method, options) {
        if (method === listWorkflowRunArtifacts) {
          this.artifactCalls.push(options.run_id);
          return artifactsByRun[options.run_id] || [];
        }
        return runs;
      }),
      rest: { actions: { listWorkflowRuns: () => {}, listWorkflowRunArtifacts }, repos: { compareCommits } }
    };
  }

  const resolve = (github, ...override) => {
    const targetSha = override.length > 0 ? override[0] : TARGET;
    // paginate is a plain function property, so bind it to the client for call tracking.
    github.paginate = github.paginate.bind(github);
    return resolveBaselineArtifact({
      github,
      repository: 'example/app',
      workflowId: 'ci.yml',
      branch: 'main',
      artifactName: 'snapdrift-baseline',
      targetSha
    });
  };

  const ahead = (n) => ({ status: 'ahead', ahead_by: n, behind_by: 0 });

  it('prefers a baseline from exactly the target commit even when a newer ancestor run is listed first', async () => {
    const github = bindingGithub({
      runs: [run(3, sha('3')), run(2, TARGET), run(1, sha('1'))],
      artifactsByRun: withBaseline(3, 2, 1),
      comparisons: { [sha('3')]: ahead(1) }
    });
    const result = await resolve(github);
    expect(result).toMatchObject({ found: true, resolutionStatus: 'found', headSha: TARGET, runId: '2', targetSha: TARGET, distance: 0 });
    expect(github.compareCommits).not.toHaveBeenCalled();
    expect(github.artifactCalls).toEqual([2]);
  });

  it('falls through an exact-commit run without an artifact to the closest ancestor', async () => {
    const github = bindingGithub({
      runs: [run(2, TARGET), run(1, sha('1'))],
      artifactsByRun: withBaseline(1),
      comparisons: { [sha('1')]: ahead(4) }
    });
    const result = await resolve(github);
    expect(result).toMatchObject({ found: true, runId: '1', headSha: sha('1'), distance: 4 });
    expect(github.compareCommits).toHaveBeenCalledTimes(1);
    expect(github.compareCommits).toHaveBeenCalledWith({ owner: 'example', repo: 'app', base: sha('1'), head: TARGET, per_page: 1 });
  });

  it('accepts the first ancestor in newest-first order and reports its distance', async () => {
    const github = bindingGithub({
      runs: [run(3, sha('3')), run(2, sha('2')), run(1, sha('1'))],
      artifactsByRun: withBaseline(3, 2, 1),
      comparisons: { [sha('3')]: { status: 'behind', ahead_by: 0, behind_by: 2 }, [sha('2')]: ahead(2), [sha('1')]: ahead(5) }
    });
    const result = await resolve(github);
    expect(result).toMatchObject({ found: true, runId: '2', headSha: sha('2'), distance: 2, targetSha: TARGET });
    // Only the accepted run lists artifacts; the rejected descendant never does.
    expect(github.artifactCalls).toEqual([2]);
  });

  it('treats an identical comparison as distance 0', async () => {
    const github = bindingGithub({
      runs: [run(1, sha('1'))],
      artifactsByRun: withBaseline(1),
      comparisons: { [sha('1')]: { status: 'identical', ahead_by: 0, behind_by: 0 } }
    });
    expect(await resolve(github)).toMatchObject({ found: true, distance: 0 });
  });

  it.each([
    ['descendant', { status: 'behind', ahead_by: 0, behind_by: 3 }],
    ['diverged', { status: 'diverged', ahead_by: 2, behind_by: 1 }]
  ])('rejects a %s baseline and reports missing', async (_label, comparison) => {
    const github = bindingGithub({
      runs: [run(1, sha('1'))],
      artifactsByRun: withBaseline(1),
      comparisons: { [sha('1')]: comparison }
    });
    const result = await resolve(github);
    expect(result).toEqual({
      found: false,
      resolutionStatus: 'missing',
      artifactName: 'snapdrift-baseline',
      targetSha: TARGET,
      message: 'No non-expired SnapDrift baseline artifact named snapdrift-baseline was found at or before target commit fffffff (1 newer or unrelated baseline(s) rejected).'
    });
    expect(github.artifactCalls).toEqual([]);
  });

  it('rejects a baseline whose commit no longer exists (404) and continues', async () => {
    const github = bindingGithub({
      runs: [run(2, sha('2')), run(1, sha('1'))],
      artifactsByRun: withBaseline(2, 1),
      comparisons: { [sha('2')]: Object.assign(new Error('Not Found'), { status: 404 }), [sha('1')]: ahead(1) }
    });
    expect(await resolve(github)).toMatchObject({ found: true, runId: '1', distance: 1 });
  });

  it.each([
    ['a server error', Object.assign(new Error('Internal Server Error'), { status: 500 })],
    ['a rate limit', Object.assign(new Error('API rate limit exceeded'), { status: 429 })],
    ['a network failure', new Error('fetch failed')]
  ])('propagates %s from the comparison', async (_label, error) => {
    const github = bindingGithub({ runs: [run(1, sha('1'))], artifactsByRun: withBaseline(1), comparisons: { [sha('1')]: error } });
    await expect(resolve(github)).rejects.toBe(error);
  });

  it.each([
    ['a missing status', {}],
    ['a non-string status', { status: 1 }],
    ['an unknown status', { status: 'sideways' }],
    ['a missing ahead_by', { status: 'ahead' }],
    ['a negative ahead_by', { status: 'ahead', ahead_by: -1 }],
    ['a fractional ahead_by', { status: 'ahead', ahead_by: 1.5 }],
    ['a string ahead_by', { status: 'ahead', ahead_by: '2' }]
  ])('throws on a malformed comparison with %s', async (_label, comparison) => {
    const github = bindingGithub({ runs: [run(1, sha('1'))], artifactsByRun: withBaseline(1), comparisons: { [sha('1')]: comparison } });
    await expect(resolve(github)).rejects.toThrow('GitHub returned a malformed commit comparison');
  });

  it('throws when the comparison response has no data', async () => {
    const github = bindingGithub({ runs: [run(1, sha('1'))], artifactsByRun: withBaseline(1) });
    github.compareCommits.mockResolvedValue(undefined);
    await expect(resolve(github)).rejects.toThrow('GitHub returned a malformed commit comparison');
  });

  it('caches comparisons per head sha across runs that share a commit', async () => {
    const github = bindingGithub({
      runs: [run(3, sha('3')), run(2, sha('3')), run(1, sha('1'))],
      artifactsByRun: withBaseline(1),
      comparisons: { [sha('3')]: { status: 'behind', ahead_by: 0, behind_by: 1 }, [sha('1')]: ahead(2) }
    });
    expect(await resolve(github)).toMatchObject({ found: true, runId: '1' });
    expect(github.compareCommits.mock.calls.map(([options]) => options.base)).toEqual([sha('3'), sha('1')]);
  });

  it('caps the number of comparisons and reports that the search was capped', async () => {
    const runs = Array.from({ length: MAX_ANCESTOR_COMPARISONS + 5 }, (_, index) => run(index + 1, hex(index + 1)));
    const github = bindingGithub({ runs });
    const result = await resolve(github);
    expect(github.compareCommits).toHaveBeenCalledTimes(MAX_ANCESTOR_COMPARISONS);
    expect(result).toMatchObject({ found: false, resolutionStatus: 'missing', targetSha: TARGET });
    expect(result.message).toContain('capped after 100 commit comparisons');
    expect(result.message).toContain('100 newer or unrelated baseline(s) rejected');
  });

  it('ignores unsuccessful and in-progress runs and expired artifacts when bound', async () => {
    const github = bindingGithub({
      runs: [
        run(4, sha('4'), { status: 'in_progress', conclusion: null }),
        run(3, sha('3'), { conclusion: 'failure' }),
        run(2, sha('2')),
        run(1, sha('1'))
      ],
      artifactsByRun: { 2: [{ name: 'snapdrift-baseline', expired: true }], ...withBaseline(1) },
      comparisons: { [sha('2')]: ahead(1), [sha('1')]: ahead(2) }
    });
    expect(await resolve(github)).toMatchObject({ found: true, runId: '1', distance: 2 });
    expect(github.compareCommits.mock.calls.map(([options]) => options.base)).toEqual([sha('2'), sha('1')]);
  });

  it('matches the target and run shas case-insensitively', async () => {
    const github = bindingGithub({ runs: [run(1, TARGET.toUpperCase())], artifactsByRun: withBaseline(1) });
    expect(await resolve(github, TARGET.toUpperCase())).toMatchObject({ found: true, distance: 0, targetSha: TARGET });
  });

  it.each(['abc123', sha('z'), 'x'.repeat(41), 42])('rejects invalid target sha %p', async (targetSha) => {
    await expect(resolve(bindingGithub({ runs: [] }), targetSha)).rejects.toThrow('Invalid baseline target SHA');
  });

  it('requires compareCommits on the client when bound', async () => {
    const github = bindingGithub({ runs: [run(1, sha('1'))] });
    delete github.rest.repos;
    await expect(resolve(github)).rejects.toThrow('requires github.rest.repos.compareCommits');
  });

  it.each([undefined, null, '', '   '])('keeps the unbound behavior byte-for-byte for target %p', async (targetSha) => {
    const github = bindingGithub({
      runs: [run(2, sha('2')), run(1, sha('1'))],
      artifactsByRun: withBaseline(2, 1)
    });
    const result = await resolve(github, targetSha);
    expect(result).toEqual({
      found: true,
      resolutionStatus: 'found',
      artifactName: 'snapdrift-baseline',
      headSha: sha('2'),
      runId: '2',
      message: ''
    });
    expect(github.compareCommits).not.toHaveBeenCalled();
    const missing = await resolve(bindingGithub({ runs: [] }), targetSha);
    expect(missing).toEqual({
      found: false,
      resolutionStatus: 'missing',
      artifactName: 'snapdrift-baseline',
      message: 'No non-expired SnapDrift baseline artifact named snapdrift-baseline was found.'
    });
  });
});

describe.each(ACTIONS)('$name target binding', (action) => {
  let tempDir;
  let configPath;
  const TARGET = 'f'.repeat(40);
  const target = (n) => String(n).repeat(40);

  beforeEach(async () => {
    ({ tempDir, configPath } = await writeConfig());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function boundGithub({ comparison }) {
    const github = makeGithub({
      runs: [
        { id: 2, status: 'completed', conclusion: 'success', head_sha: target(2) },
        { id: 1, status: 'completed', conclusion: 'success', head_sha: target(1) }
      ],
      artifactsByRun: {
        2: [{ name: 'snapdrift-baseline', expired: false }],
        1: [{ name: 'snapdrift-baseline', expired: false }]
      }
    });
    github.rest.repos = { compareCommits: async ({ base }) => ({ data: comparison[base] }) };
    return github;
  }

  const comparison = {
    [target(2)]: { status: 'behind', ahead_by: 0, behind_by: 1 },
    [target(1)]: { status: 'ahead', ahead_by: 3, behind_by: 0 }
  };

  it('binds to an explicit target sha and exposes the target and distance outputs', async () => {
    const result = await executeResolver(action, {
      configPath,
      github: boundGithub({ comparison }),
      inputs: { targetSha: TARGET }
    });
    expect(result.outputs).toMatchObject({
      found: 'true',
      run_id: '1',
      head_sha: target(1),
      target_sha: TARGET,
      distance: '3'
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('keeps the newest baseline and empty target outputs when no target is given', async () => {
    const result = await executeResolver(action, { configPath, github: boundGithub({ comparison }) });
    expect(result.outputs).toMatchObject({ found: 'true', run_id: '2', target_sha: '', distance: '' });
  });

  it('reports an invalid target sha as a lookup error', async () => {
    const result = await executeResolver(action, { configPath, github: boundGithub({ comparison }), inputs: { targetSha: 'main' } });
    expect(result.outputs).toMatchObject({ found: 'false', resolution_status: 'error' });
    expect(result.outputs.message).toContain('Invalid baseline target SHA');
  });
});

describe('pr-diff baseline target detection', () => {
  const sha = (char) => char.repeat(40);
  const PR_HEAD = sha('a');
  const BASE_TIP = sha('b');
  let tempDir;
  let configPath;
  let workspace;
  let checkedOut;

  beforeEach(async () => {
    ({ tempDir, configPath } = await writeConfig());
    workspace = path.join(tempDir, 'workspace');
    await fs.mkdir(workspace);
    const git = (...args) => execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    }).trim();
    git('init', '--quiet');
    git('commit', '--quiet', '--allow-empty', '-m', 'checked out');
    checkedOut = git('rev-parse', 'HEAD');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function detectionGithub({ commit, pullError, comparison } = {}) {
    const github = makeGithub({
      runs: [
        { id: 2, status: 'completed', conclusion: 'success', head_sha: sha('2') },
        { id: 1, status: 'completed', conclusion: 'success', head_sha: BASE_TIP }
      ],
      artifactsByRun: {
        2: [{ name: 'snapdrift-baseline', expired: false }],
        1: [{ name: 'snapdrift-baseline', expired: false }]
      }
    });
    github.rest.pulls = {
      get: async () => {
        if (pullError) throw pullError;
        return { data: { head: { sha: PR_HEAD }, base: { sha: sha('9'), ref: 'main' } } };
      }
    };
    github.rest.repos = {
      getCommit: async () => ({ data: commit ?? { parents: [{ sha: BASE_TIP }, { sha: PR_HEAD }] } }),
      compareCommits: async ({ base }) => ({
        data: comparison ?? (base === sha('2')
          ? { status: 'behind', ahead_by: 0, behind_by: 1 }
          : { status: 'identical', ahead_by: 0, behind_by: 0 })
      })
    };
    return github;
  }

  function runDetection({ github, env = {}, repo = { owner: 'example', repo: 'app' } }) {
    return executeActionScript({
      actionPath: path.join(REPO_ROOT, 'actions/pr-diff/action.yml'),
      stepId: 'baseline',
      actionRoot: REPO_ROOT,
      githubWorkspace: workspace,
      env: {
        REPO_CONFIG_PATH: configPath,
        INPUT_REPOSITORY: '',
        INPUT_WORKFLOW_ID: 'ci.yml',
        INPUT_BRANCH: 'main',
        INPUT_TARGET_SHA: '',
        INPUT_PR_NUMBER: '7',
        ...env
      },
      github,
      context: { repo, sha: sha('c') }
    });
  }

  it('binds to the base tip when the PR merge ref is checked out and skips the newer baseline', async () => {
    const result = await runDetection({ github: detectionGithub() });
    expect(result.warnings).toEqual([]);
    expect(result.outputs).toMatchObject({
      found: 'true',
      resolution_status: 'found',
      run_id: '1',
      head_sha: BASE_TIP,
      target_sha: BASE_TIP,
      distance: '0'
    });
  });

  it('resolves unbound without calling GitHub for the PR when there is no PR number', async () => {
    const github = detectionGithub();
    github.rest.pulls.get = async () => { throw new Error('must not be called'); };
    const result = await runDetection({ github, env: { INPUT_PR_NUMBER: '' } });
    expect(result.warnings).toEqual([]);
    expect(result.outputs).toMatchObject({ found: 'true', run_id: '2', target_sha: '', distance: '' });
  });

  it('prefers an explicit baseline-target-sha over detection', async () => {
    const github = detectionGithub();
    github.rest.pulls.get = async () => { throw new Error('must not be called'); };
    const result = await runDetection({ github, env: { INPUT_TARGET_SHA: BASE_TIP } });
    expect(result.warnings).toEqual([]);
    expect(result.outputs).toMatchObject({ found: 'true', run_id: '1', target_sha: BASE_TIP, distance: '0' });
  });

  it('does not bind a cross-repo baseline and warns', async () => {
    const result = await runDetection({ github: detectionGithub(), env: { INPUT_REPOSITORY: 'other/baselines' } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('other/baselines');
    expect(result.outputs).toMatchObject({ found: 'true', run_id: '2', target_sha: '' });
  });

  it('treats a baseline repository equal to the PR repository (case-insensitively) as same-repo', async () => {
    const result = await runDetection({ github: detectionGithub(), env: { INPUT_REPOSITORY: 'Example/App' } });
    expect(result.warnings).toEqual([]);
    expect(result.outputs).toMatchObject({ run_id: '1', target_sha: BASE_TIP });
  });

  it('warns and resolves unbound when the checkout is neither the PR head nor its merge ref', async () => {
    const result = await runDetection({ github: detectionGithub({ commit: { parents: [{ sha: BASE_TIP }] } }) });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(checkedOut);
    expect(result.outputs).toMatchObject({ found: 'true', run_id: '2', target_sha: '' });
  });

  it('reports a lookup error instead of silently unbinding when the PR lookup fails', async () => {
    const result = await runDetection({ github: detectionGithub({ pullError: new Error('Not Found') }) });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Unable to determine the PR base commit');
    expect(result.warnings[0]).toContain('Not Found');
    expect(result.outputs).toMatchObject({ found: 'false', resolution_status: 'error' });
    expect(result.outputs.run_id).toBeUndefined();
  });

  it('falls back to the event sha with a warning when the workspace is not a git checkout', async () => {
    const result = await executeActionScript({
      actionPath: path.join(REPO_ROOT, 'actions/pr-diff/action.yml'),
      stepId: 'baseline',
      actionRoot: REPO_ROOT,
      githubWorkspace: path.join(tempDir, 'missing'),
      env: { REPO_CONFIG_PATH: configPath, INPUT_REPOSITORY: '', INPUT_WORKFLOW_ID: 'ci.yml', INPUT_BRANCH: 'main', INPUT_TARGET_SHA: '', INPUT_PR_NUMBER: '7' },
      github: detectionGithub({ commit: { parents: [{ sha: BASE_TIP }, { sha: PR_HEAD }] } }),
      context: { repo: { owner: 'example', repo: 'app' }, sha: sha('c') }
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Unable to read the checked-out commit');
    expect(result.outputs).toMatchObject({ run_id: '1', target_sha: BASE_TIP });
  });
});
