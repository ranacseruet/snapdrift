// @ts-check

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

/** @typedef {import('../types/visual-diff-types').InitWarning} InitWarning */

const DEFAULT_OUTPUT_DIR = '.github';
const DEFAULT_CONFIG_FILENAME = 'snapdrift.json';
const MIGRATION_NOTES_FILENAME = 'MIGRATION_NOTES.md';

/**
 * Find the step that uses the Snap visual testing action.
 *
 * @param {object} workflow - Parsed YAML workflow
 * @returns {{ step: object, jobName: string, stepIndex: number } | null}
 */
function findSnapActionStep(workflow) {
  const jobs = workflow.jobs || {};
  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = job.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const uses = step.uses || '';
      if ((uses.includes('snap/github-action') || uses.includes('i2dev-com/snap')) && uses.includes('action')) {
        return { step, jobName, stepIndex: i };
      }
    }
  }
  return null;
}

/**
 * Map Snap action enforcement mode to snapdrift diff.mode.
 *
 * @param {object} inputs
 * @returns {string}
 */
function mapDiffMode(inputs) {
  const failOnChanges = inputs['fail-on-changes'] || inputs.fail_on_changes;
  if (failOnChanges === 'true' || failOnChanges === true) {
    return 'fail-on-changes';
  }
  const failOnIncomplete = inputs['fail-on-incomplete'] || inputs.fail_on_incomplete;
  if (failOnIncomplete === 'true' || failOnIncomplete === true) {
    return 'fail-on-incomplete';
  }
  return 'report-only';
}

/**
 * Extract Snap action inputs and translate to snapdrift config fields.
 *
 * @param {object} step - The workflow step using the Snap action
 * @returns {{ config: object, warnings: InitWarning[] }}
 */
function translateStepToConfig(step) {
  /** @type {InitWarning[]} */
  const warnings = [];
  const inputs = step.with || {};

  // Diff settings
  const threshold = parseFloat(inputs.threshold || inputs['diff-threshold'] || '0.01');
  const diffMode = mapDiffMode(inputs);

  // Format warning
  const format = inputs.format;
  if (format && format !== 'png') {
    warnings.push({
      field: 'format',
      originalValue: format,
      message: `SnapDrift only supports PNG screenshots. The Snap action's "format: ${format}" setting has no snapdrift equivalent and will be ignored.`,
      severity: 'warning'
    });
  }

  // Baseline tag warning
  const baselineTag = inputs.baseline_tag || inputs['baseline-tag'];
  if (baselineTag) {
    warnings.push({
      field: 'baseline_tag',
      originalValue: baselineTag,
      message: `SnapDrift uses commit-based baselines. The Snap action's "baseline_tag: ${baselineTag}" is a semantic gap that cannot be automatically translated. SnapDrift always uses the latest baseline from the target branch.`,
      severity: 'warning'
    });
  }

  // Snap provider config (if present in inputs)
  /** @type {object | undefined} */
  let snap;
  const snapApiUrl = inputs['snap-api-url'] || inputs.snap_api_url;
  const snapApiKeyEnv = inputs['snap-api-key-env'] || inputs.snap_api_key_env;
  const snapProjectId = inputs['snap-project-id'] || inputs.snap_project_id;

  if (snapApiKeyEnv || snapProjectId) {
    snap = {};
    if (snapApiUrl) snap.apiUrl = snapApiUrl;
    if (snapApiKeyEnv) snap.apiKeyEnv = snapApiKeyEnv;
    if (snapProjectId) snap.projectId = snapProjectId;
  }

  const config = {
    baselineArtifactName: 'snapdrift-baseline',
    workingDirectory: '.',
    baseUrl: 'http://localhost:3000',
    resultsFile: 'qa-artifacts/snapdrift/baseline/current/results.json',
    manifestFile: 'qa-artifacts/snapdrift/baseline/current/manifest.json',
    screenshotsRoot: 'qa-artifacts/snapdrift/baseline/current',
    routes: [],
    diff: {
      threshold: isNaN(threshold) ? 0.01 : threshold,
      mode: diffMode
    }
  };

  if (snap) {
    config.provider = 'snap';
    config.snap = snap;
  }

  // Note about routes — cannot be auto-translated from action inputs
  warnings.push({
    field: 'routes',
    originalValue: '',
    message: 'Routes cannot be automatically translated from the Snap action. You must fill in the routes array in snapdrift.json manually, matching the pages you want to test.',
    severity: 'note'
  });

  // Note about baseUrl — cannot be auto-translated
  warnings.push({
    field: 'baseUrl',
    originalValue: '',
    message: 'The baseUrl was set to a placeholder (http://localhost:3000). Update it to match your app URL before running snapdrift.',
    severity: 'note'
  });

  return { config, warnings };
}

/**
 * Generate MIGRATION_NOTES.md content.
 *
 * @param {InitWarning[]} warnings
 * @param {string} sourceYamlPath
 * @returns {string}
 */
function generateMigrationNotes(warnings, sourceYamlPath) {
  const lines = [
    '# Migration Notes',
    '',
    `Generated from: \`${sourceYamlPath}\``,
    '',
    '## Warnings',
    ''
  ];

  const warningsList = warnings.filter((w) => w.severity === 'warning');
  if (warningsList.length === 0) {
    lines.push('No warnings.');
  } else {
    for (const w of warningsList) {
      lines.push(`- **${w.field}**: ${w.message}`);
    }
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');

  const notesList = warnings.filter((w) => w.severity === 'note');
  for (const n of notesList) {
    lines.push(`- **${n.field}**: ${n.message}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Run the init --from-snap-action codemod.
 *
 * Reads a Snap action workflow YAML, translates it into snapdrift.json,
 * and emits MIGRATION_NOTES.md with warnings.
 *
 * @param {string} actionYamlPath - Path to the Snap action workflow YAML
 * @returns {Promise<{ configPath: string, warningsCount: number }>}
 */
export async function runInitFromAction(actionYamlPath) {
  // Read and parse YAML
  let workflowContent;
  try {
    workflowContent = await fs.readFile(actionYamlPath, 'utf-8');
  } catch {
    throw new Error(`Cannot read workflow file: ${actionYamlPath}`);
  }

  const workflow = yaml.load(workflowContent);
  if (!workflow || typeof workflow !== 'object') {
    throw new Error(`Invalid workflow YAML: ${actionYamlPath}`);
  }

  // Find the Snap action step
  const snapStep = findSnapActionStep(workflow);
  if (!snapStep) {
    throw new Error(
      `No Snap action step found in ${actionYamlPath}. ` +
      `Looked for steps with "uses" containing "snap" and "action".`
    );
  }

  // Translate
  const { config, warnings } = translateStepToConfig(snapStep.step);

  // Ensure output directory exists
  const outputDir = DEFAULT_OUTPUT_DIR;
  await fs.mkdir(outputDir, { recursive: true });

  const configPath = path.join(outputDir, DEFAULT_CONFIG_FILENAME);
  const notesPath = path.join(outputDir, MIGRATION_NOTES_FILENAME);

  // Idempotency: refuse to overwrite existing snapdrift.json
  const configExists = await fs.access(configPath).then(() => true, () => false);
  if (configExists) {
    throw new Error(
      `${configPath} already exists. Remove it manually and re-run to regenerate.`
    );
  }

  // Write snapdrift.json
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  // Write MIGRATION_NOTES.md
  const notesContent = generateMigrationNotes(warnings, actionYamlPath);
  await fs.writeFile(notesPath, notesContent);

  process.stdout.write(`Created ${configPath}\n`);
  process.stdout.write(`Created ${notesPath}\n`);
  if (warnings.length > 0) {
    process.stdout.write(`${warnings.length} warning(s)/note(s) — review ${notesPath}\n`);
  }

  return { configPath, warningsCount: warnings.length };
}
