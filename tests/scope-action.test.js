/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeActionScript } from './action-script-runner.mjs';

const REPO_ROOT = path.resolve('.');

const ACTIONS = [
  {
    name: 'standalone scope action',
    path: 'actions/scope/action.yml'
  },
  {
    name: 'pr-diff scope step',
    path: 'actions/pr-diff/action.yml'
  }
];

const BASE_CONFIG = {
  baselineArtifactName: 'snapdrift-baseline',
  workingDirectory: '.',
  baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json',
  manifestFile: 'manifest.json',
  screenshotsRoot: 'screenshots',
  routes: [
    { id: 'home', path: '/', viewport: 'desktop', changePaths: ['src/pages/home/'] },
    { id: 'about', path: '/about', viewport: 'desktop', changePaths: ['src/pages/about/'] }
  ],
  diff: { threshold: 0.01, mode: 'strict' }
};

async function executeScopeAction(action, {
  files = [],
  config = BASE_CONFIG,
  routeIds = '',
  forceRun = 'false',
  forceRunReason = 'forced',
  prNumber = '42',
  pullRequestNumber = 42,
  paginateError
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-scope-action-'));
  const configPath = path.join(tempDir, 'snapdrift.json');
  await fs.writeFile(configPath, JSON.stringify(config));

  const paginateCalls = [];
  const paginateMethods = [];
  const listFiles = async () => ({ data: [] });
  const github = {
    rest: { pulls: { listFiles } },
    paginate: async (method, options) => {
      paginateMethods.push(method);
      paginateCalls.push(options);
      if (paginateError) throw paginateError;
      return files;
    }
  };
  const context = {
    repo: { owner: 'example', repo: 'app' },
    payload: { pull_request: pullRequestNumber ? { number: pullRequestNumber } : undefined }
  };

  try {
    const result = await executeActionScript({
      actionPath: path.join(REPO_ROOT, action.path),
      stepId: 'scope',
      actionRoot: REPO_ROOT,
      env: {
        REPO_CONFIG_PATH: configPath,
        ROUTE_IDS: routeIds,
        FORCE_RUN: forceRun,
        FORCE_RUN_REASON: forceRunReason,
        INPUT_PR_NUMBER: prNumber
      },
      github,
      context
    });
    for (const method of paginateMethods) expect(method).toBe(listFiles);
    return { ...result, paginateCalls };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe.each(ACTIONS)('$name', (action) => {
  it('selects a route when a rename moves out of its watched directory', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'renamed', filename: 'archive/home.js', previous_filename: 'src/pages/home/index.js' }]
    });

    expect(result.outputs).toEqual({
      should_run: 'true',
      reason: 'scoped_snapdrift_change',
      selected_route_ids: 'home'
    });
  });

  it('selects a route when a rename moves into its watched directory', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'renamed', filename: 'src/pages/about/team.js', previous_filename: 'archive/team.js' }]
    });

    expect(result.outputs.selected_route_ids).toBe('about');
    expect(result.outputs.reason).toBe('scoped_snapdrift_change');
  });

  it('selects both routes when a rename crosses two watched directories', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'renamed', filename: 'src/pages/about/team.js', previous_filename: 'src/pages/home/team.js' }]
    });

    expect(result.outputs.selected_route_ids).toBe('home,about');
    expect(result.outputs.reason).toBe('scoped_snapdrift_change');
  });

  it.each([
    ['shared exact', { sharedExact: ['package.json'] }, 'package.json', 'archive/package.json'],
    ['shared prefix', { sharedPrefixes: ['src/shared/'] }, 'src/shared/theme.js', 'archive/theme.js']
  ])('uses either path for a %s rename', async (_label, selection, previousFilename, filename) => {
    const result = await executeScopeAction(action, {
      config: { ...BASE_CONFIG, selection },
      files: [{ status: 'renamed', filename, previous_filename: previousFilename }]
    });

    expect(result.outputs).toEqual({
      should_run: 'true',
      reason: 'shared_snapdrift_change',
      selected_route_ids: 'home,about'
    });
  });

  it('ignores a rename whose two paths are unrelated to SnapDrift routes', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'renamed', filename: 'docs/new.md', previous_filename: 'docs/old.md' }]
    });

    expect(result.outputs).toEqual({
      should_run: 'false',
      reason: 'no_snapdrift_relevant_changes',
      selected_route_ids: ''
    });
  });

  it('runs all routes when GitHub may have truncated the changed-file list', async () => {
    const result = await executeScopeAction(action, {
      files: Array.from({ length: 3000 }, (_value, index) => ({
        status: 'modified',
        filename: `docs/file-${index}.md`
      }))
    });

    expect(result.outputs).toEqual({
      should_run: 'true',
      reason: 'changed_files_truncated',
      selected_route_ids: 'home,about'
    });
    expect(result.warnings[0]).toContain('maximum 3000 changed-file records');
  });

  it('runs all routes with a diagnostic when GitHub returns a malformed file record', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'modified', filename: null }]
    });

    expect(result.outputs).toEqual({
      should_run: 'true',
      reason: 'snapdrift_scope_check_failed',
      selected_route_ids: 'home,about'
    });
    expect(result.warnings[0]).toContain('Malformed GitHub changed-file response');
    expect(result.failures).toHaveLength(0);
  });

  it('deduplicates repeated current and previous paths', async () => {
    const result = await executeScopeAction(action, {
      files: [
        { status: 'renamed', filename: 'src/pages/home/index.js', previous_filename: 'src/pages/home/index.js' },
        { status: 'modified', filename: 'src/pages/home/index.js' }
      ]
    });

    expect(result.outputs.selected_route_ids).toBe('home');
    expect(result.outputs.reason).toBe('scoped_snapdrift_change');
  });

  it('uses the current path when a rename has no previous filename', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'renamed', filename: 'src/pages/about/team.js' }]
    });

    expect(result.outputs.selected_route_ids).toBe('about');
    expect(result.outputs.reason).toBe('scoped_snapdrift_change');
  });

  it('ignores a previous filename on non-rename records', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'modified', filename: 'docs/readme.md', previous_filename: 'src/pages/home/index.js' }]
    });

    expect(result.outputs.should_run).toBe('false');
    expect(result.outputs.reason).toBe('no_snapdrift_relevant_changes');
  });

  it.each([
    ['added', 'src/pages/home/new.js'],
    ['modified', 'src/pages/about/team.js'],
    ['removed', 'src/pages/home/old.js']
  ])('continues to select the current path for %s files', async (status, filename) => {
    const result = await executeScopeAction(action, {
      files: [{ status, filename }]
    });

    expect(result.outputs.should_run).toBe('true');
    expect(result.outputs.reason).toBe('scoped_snapdrift_change');
  });

  it('preserves explicit route selection and standalone lookup behavior', async () => {
    const result = await executeScopeAction(action, {
      routeIds: 'about',
      files: [{ status: 'renamed', filename: 'archive/home.js', previous_filename: 'src/pages/home/index.js' }]
    });

    if (action.path.includes('pr-diff')) {
      expect(result.outputs).toEqual({
        should_run: 'true',
        reason: 'explicit_route_ids',
        selected_route_ids: 'about'
      });
      expect(result.paginateCalls).toHaveLength(0);
    } else {
      expect(result.outputs).toEqual({
        should_run: 'true',
        reason: 'scoped_snapdrift_change',
        selected_route_ids: 'home'
      });
      expect(result.paginateCalls).toHaveLength(1);
    }
  });

  it('ignores a previous filename on copied records', async () => {
    const result = await executeScopeAction(action, {
      files: [{ status: 'copied', filename: 'src/pages/about/team.js', previous_filename: 'src/pages/home/old.js' }]
    });

    expect(result.outputs.selected_route_ids).toBe('about');
    expect(result.outputs.reason).toBe('scoped_snapdrift_change');
  });

  it('preserves force-run and missing-PR fallbacks', async () => {
    const forced = await executeScopeAction(action, {
      forceRun: 'true',
      forceRunReason: 'manual_check',
      files: [{ status: 'renamed', filename: 'docs/new.md', previous_filename: 'docs/old.md' }]
    });
    expect(forced.outputs).toEqual({
      should_run: 'true',
      reason: 'manual_check',
      selected_route_ids: 'home,about'
    });
    expect(forced.paginateCalls).toHaveLength(0);

    const missingPr = await executeScopeAction(action, {
      prNumber: '',
      pullRequestNumber: 0,
      files: []
    });
    expect(missingPr.outputs).toEqual({
      should_run: 'true',
      reason: 'missing_pr_number',
      selected_route_ids: 'home,about'
    });
    expect(missingPr.paginateCalls).toHaveLength(0);
  });

  it('preserves run-all behavior when GitHub file lookup fails', async () => {
    const result = await executeScopeAction(action, {
      paginateError: new Error('rate limit exceeded')
    });

    expect(result.outputs).toEqual({
      should_run: 'true',
      reason: 'snapdrift_scope_check_failed',
      selected_route_ids: 'home,about'
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('rate limit exceeded');
  });

  it('reports no_changed_files for a valid PR with an empty file list', async () => {
    const result = await executeScopeAction(action, { files: [] });

    expect(result.outputs).toEqual({
      should_run: 'false',
      reason: 'no_changed_files',
      selected_route_ids: ''
    });
    expect(result.paginateCalls).toHaveLength(1);
  });
});
