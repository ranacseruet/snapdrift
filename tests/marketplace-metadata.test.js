/** @jest-environment node */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// https://docs.github.com/actions/creating-actions/metadata-syntax-for-github-actions#branding
const BRANDING_COLORS = ['white', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'];

// Accepts either a tag pin (`@v1.2.3`) or a commit-SHA pin carrying the version in a trailing
// comment (`@<sha> # v1.2.3`), matching how this repo pins third-party actions. Either way the
// version the pin claims to be must equal the root package version.
const INNER_ACTION_REF_PATTERN =
  /uses:\s+ranacseruet\/snapdrift\/actions\/(baseline|pr-diff)@(?:[0-9a-f]{40}\s+#\s+(v\S+)|(v\S+))/g;

async function readAction(relativePath) {
  return yaml.load(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8'));
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return packageJson.version;
}

describe('GitHub Marketplace metadata', () => {
  it('exposes a composite root action as the marketplace entry point', async () => {
    const root = await readAction('action.yml');

    expect(root.name).toBe('SnapDrift');
    expect(typeof root.description).toBe('string');
    expect(root.description.length).toBeGreaterThan(0);
    // Marketplace rejects the listing at or above 125 characters.
    expect(root.description.length).toBeLessThan(125);
    expect(root.runs.using).toBe('composite');
    expect(root.runs.steps.length).toBeGreaterThan(0);
  });

  it('brands every action so the metadata is publishable', async () => {
    const actionDirs = (await fs.readdir(path.join(REPO_ROOT, 'actions'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const relativePaths = ['action.yml', ...actionDirs.map((dir) => `actions/${dir}/action.yml`)];
    const actions = await Promise.all(relativePaths.map((relativePath) => readAction(relativePath)));

    expect(relativePaths).toHaveLength(10);

    const unbranded = actions
      .map((action, index) => ({ file: relativePaths[index], branding: action.branding }))
      .filter(({ branding }) => !branding?.icon || !BRANDING_COLORS.includes(branding?.color))
      .map(({ file }) => file);

    expect(unbranded).toEqual([]);
  });

  it('pins the root action to the current release of its inner actions', async () => {
    const [raw, version] = await Promise.all([
      fs.readFile(path.join(REPO_ROOT, 'action.yml'), 'utf8'),
      readPackageVersion(),
    ]);
    const matches = [...raw.matchAll(INNER_ACTION_REF_PATTERN)];

    // A relative `uses: ./actions/...` would resolve against the caller's workspace rather than
    // this action's directory, so the dispatcher pins absolute refs that must track the release.
    expect(matches.map((match) => match[1]).sort()).toEqual(['baseline', 'pr-diff']);
    expect(new Set(matches.map((match) => match[2] ?? match[3]))).toEqual(new Set([`v${version}`]));
  });

  it('dispatches on mode and forwards every input of both wrapper actions', async () => {
    const [root, baseline, prDiff] = await Promise.all([
      readAction('action.yml'),
      readAction('actions/baseline/action.yml'),
      readAction('actions/pr-diff/action.yml'),
    ]);

    expect(root.inputs.mode.default).toBe('pr-diff');

    const wrapperInputs = new Set([...Object.keys(baseline.inputs), ...Object.keys(prDiff.inputs)]);
    for (const input of wrapperInputs) {
      expect(Object.keys(root.inputs)).toContain(input);
    }

    const wrapperOutputs = new Set([...Object.keys(baseline.outputs), ...Object.keys(prDiff.outputs)]);
    for (const output of wrapperOutputs) {
      expect(Object.keys(root.outputs)).toContain(output);
    }

    const steps = Object.fromEntries(root.runs.steps.filter((step) => step.id).map((step) => [step.id, step]));
    expect(steps.baseline.if).toBe("inputs.mode == 'baseline'");
    expect(steps['pr-diff'].if).toBe("inputs.mode == 'pr-diff'");
    expect(Object.keys(steps.baseline.with).sort()).toEqual(Object.keys(baseline.inputs).sort());
    expect(Object.keys(steps['pr-diff'].with).sort()).toEqual(Object.keys(prDiff.inputs).sort());
  });

  it('keeps the root action usable without an explicit token in baseline mode', async () => {
    const root = await readAction('action.yml');

    // `pr-diff` requires a token; the root action defaults it so `mode: baseline` needs no inputs.
    expect(root.inputs['github-token'].required).toBe(false);
    expect(root.inputs['github-token'].default).toBe('${{ github.token }}');
  });
});
