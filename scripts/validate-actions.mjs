import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const actionsDir = path.join(repoRoot, 'actions');

/**
 * @param {string} actionDir
 * @returns {Promise<void>}
 */
async function validateAction(actionDir) {
  const actionPath = path.join(actionsDir, actionDir, 'action.yml');
  const raw = await fs.readFile(actionPath, 'utf8');
  const action = yaml.load(raw);

  if (!action || typeof action !== 'object') {
    throw new Error(`Invalid action metadata in ${actionPath}.`);
  }

  const metadata = /** @type {{ name?: unknown, description?: unknown, runs?: { using?: unknown, steps?: unknown[] } }} */ (action);
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
    throw new Error(`Action ${actionPath} is missing a name.`);
  }
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`Action ${actionPath} is missing a description.`);
  }
  if (metadata.runs?.using !== 'composite') {
    throw new Error(`Action ${actionPath} must use composite runs.`);
  }
  if (!Array.isArray(metadata.runs?.steps) || metadata.runs.steps.length === 0) {
    throw new Error(`Action ${actionPath} must declare at least one step.`);
  }
}

const entries = await fs.readdir(actionsDir, { withFileTypes: true });
const actionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

for (const actionDir of actionDirs) {
  await validateAction(actionDir);
}

console.log(`Validated ${actionDirs.length} SnapDrift action definitions.`);
