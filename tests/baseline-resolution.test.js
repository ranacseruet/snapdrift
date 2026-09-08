/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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
  const metadata = yaml.load(await fs.readFile(path.join(REPO_ROOT, action.path), 'utf8'));
  const step = metadata.runs.steps.find((candidate) => candidate.id === action.stepId);
  const environment = {
    ACTION_ROOT: REPO_ROOT,
    GITHUB_ACTION_PATH: path.join(REPO_ROOT, 'actions', 'resolve-baseline'),
    GITHUB_WORKSPACE: REPO_ROOT,
    REPO_CONFIG_PATH: configPath,
    INPUT_ARTIFACT_NAME: inputs.artifactName || '',
    INPUT_REPOSITORY: inputs.repository || '',
    INPUT_WORKFLOW_ID: inputs.workflowId || 'ci.yml',
    INPUT_BRANCH: inputs.branch || 'main'
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);

  const outputs = {};
  const failures = [];
  const core = {
    setOutput(name, value) {
      outputs[name] = value;
    },
    setFailed(message) {
      failures.push(String(message));
    }
  };
  const context = { repo: { owner: 'example', repo: 'app' } };

  try {
    await new AsyncFunction('github', 'core', 'context', 'process', 'require', step.with.script)(
      github,
      core,
      context,
      process,
      require
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  return { outputs, failures };
}

function makeGithub({ runs = [], artifactsByRun = {}, paginateError, artifactError, artifactResponse } = {}) {
  const calls = [];
  return {
    calls,
    paginate: async (_method, options) => {
      calls.push({ type: 'runs', options });
      if (paginateError) throw paginateError;
      return runs;
    },
    rest: {
      actions: {
        listWorkflowRunArtifacts: async ({ run_id: runId }) => {
          calls.push({ type: 'artifacts', runId });
          if (artifactError) throw artifactError;
          return artifactResponse || { data: { artifacts: artifactsByRun[runId] || [] } };
        }
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
    else expect(result.failures).toHaveLength(0);
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
  });

  it('classifies malformed GitHub responses as errors', async () => {
    const malformedRuns = await executeResolver(action, {
      configPath,
      github: makeGithub({ runs: null })
    });
    expect(malformedRuns.outputs.resolution_status).toBe('error');
    if (action.standalone) expect(malformedRuns.failures).toHaveLength(1);

    const malformedArtifacts = await executeResolver(action, {
      configPath,
      github: makeGithub({
        runs: [{ id: 42, status: 'completed', conclusion: 'success', head_sha: 'abc123' }],
        artifactResponse: { data: { artifacts: {} } }
      })
    });
    expect(malformedArtifacts.outputs.resolution_status).toBe('error');
    if (action.standalone) expect(malformedArtifacts.failures).toHaveLength(1);
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
      options: { owner: 'owner', repo: 'other-repo', workflow_id: 'visual.yml', branch: 'release' }
    });
    expect(github.calls.filter((call) => call.type === 'artifacts')).toEqual([{ type: 'artifacts', runId: 2 }]);
  });
});

describe('malformed workflow run records', () => {
  let tempDir;
  let configPath;

  beforeEach(async () => {
    ({ tempDir, configPath } = await writeConfig());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not treat a malformed run list as an intentional absence', async () => {
    const result = await executeResolver(ACTIONS[0], {
      configPath,
      github: makeGithub({ runs: null })
    });

    expect(result.outputs.resolution_status).toBe('error');
    expect(result.failures).toHaveLength(1);
  });
});
