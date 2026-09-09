import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Execute a github-script step from an action definition with the same small
 * core/context/process surface used by the action runner.
 *
 * @param {{
 *   actionPath: string,
 *   stepId: string,
 *   env?: Record<string, string>,
 *   github: object,
 *   context?: object,
 *   actionRoot?: string,
 *   githubActionPath?: string,
 *   githubWorkspace?: string
 * }} options
 * @returns {Promise<{outputs: Record<string, unknown>, failures: string[], warnings: string[]}>}
 */
export async function executeActionScript({
  actionPath,
  stepId,
  env = {},
  github,
  context = { repo: { owner: 'example', repo: 'app' } },
  actionRoot = path.resolve('.'),
  githubActionPath = path.join(actionRoot, 'actions', 'resolve-baseline'),
  githubWorkspace = actionRoot
}) {
  const metadata = yaml.load(await fs.readFile(path.resolve(actionPath), 'utf8'));
  const step = metadata.runs.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Could not find ${stepId} step in ${actionPath}`);

  const environment = {
    ACTION_ROOT: actionRoot,
    GITHUB_ACTION_PATH: githubActionPath,
    GITHUB_WORKSPACE: githubWorkspace,
    ...env
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);

  const outputs = {};
  const failures = [];
  const warnings = [];
  const core = {
    setOutput(name, value) {
      outputs[name] = value;
    },
    setFailed(message) {
      failures.push(String(message));
    },
    warning(message) {
      warnings.push(String(message));
    }
  };

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

  return { outputs, failures, warnings };
}
