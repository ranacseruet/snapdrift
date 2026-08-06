import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const actionsDir = path.join(repoRoot, 'actions');

// GitHub Marketplace only accepts these colors, and icons must be Feather icon names.
// https://docs.github.com/actions/creating-actions/metadata-syntax-for-github-actions#branding
const BRANDING_COLORS = new Set(['white', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark']);

// Marketplace rejects the listing if the description reaches this length. It applies only to the
// published root action, so the sub-action descriptions are free to be as long as they need to be.
const MARKETPLACE_DESCRIPTION_LIMIT = 125;

/**
 * @param {string} actionPath
 * @param {boolean} [isMarketplaceEntryPoint]
 * @returns {Promise<void>}
 */
async function validateAction(actionPath, isMarketplaceEntryPoint = false) {
  const raw = await fs.readFile(actionPath, 'utf8');
  const action = yaml.load(raw);

  if (!action || typeof action !== 'object') {
    throw new Error(`Invalid action metadata in ${actionPath}.`);
  }

  const metadata = /** @type {{ name?: unknown, description?: unknown, branding?: { icon?: unknown, color?: unknown }, runs?: { using?: unknown, steps?: unknown[] } }} */ (action);
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
    throw new Error(`Action ${actionPath} is missing a name.`);
  }
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`Action ${actionPath} is missing a description.`);
  }
  if (isMarketplaceEntryPoint && metadata.description.length >= MARKETPLACE_DESCRIPTION_LIMIT) {
    throw new Error(
      `Action ${actionPath} has a ${metadata.description.length}-character description; GitHub Marketplace requires fewer than ${MARKETPLACE_DESCRIPTION_LIMIT}.`,
    );
  }
  if (typeof metadata.branding?.icon !== 'string' || metadata.branding.icon.length === 0) {
    throw new Error(`Action ${actionPath} is missing a branding icon.`);
  }
  if (typeof metadata.branding?.color !== 'string' || !BRANDING_COLORS.has(metadata.branding.color)) {
    throw new Error(`Action ${actionPath} must set a branding color from: ${[...BRANDING_COLORS].join(', ')}.`);
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

// The root action.yml is the GitHub Marketplace entry point, so it is validated alongside the rest
// and additionally held to the Marketplace listing rules.
const actionPaths = [
  path.join(repoRoot, 'action.yml'),
  ...actionDirs.map((actionDir) => path.join(actionsDir, actionDir, 'action.yml')),
];

for (const [index, actionPath] of actionPaths.entries()) {
  await validateAction(actionPath, index === 0);
}

console.log(`Validated ${actionPaths.length} SnapDrift action definitions.`);
