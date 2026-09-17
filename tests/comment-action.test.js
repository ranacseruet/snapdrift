import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { executeActionScript } from './action-script-runner.mjs';
import { LocalProvider } from '../lib/provider.mjs';
import { PR_COMMENT_MARKER, escapeMarkdown } from '../lib/pr-comment.mjs';

const root = path.resolve('.');
const config = {
  baselineArtifactName: 'baseline', workingDirectory: '.', baseUrl: 'http://localhost:3000',
  resultsFile: 'results.json', manifestFile: 'manifest.json', screenshotsRoot: 'screenshots',
  routes: [{ id: 'home', path: '/', viewport: 'desktop' }], diff: { threshold: 0.01, mode: 'strict' }
};
const summary = {
  status: 'clean', matchedScreenshots: 2, changedScreenshots: 0, missingInBaseline: 0,
  missingInCurrent: 0, errors: [], dimensionChanges: [], changed: []
};
const context = { repo: { owner: 'example', repo: 'app' }, payload: { pull_request: { number: 42 } } };
const meta = { artifactName: 'diff', artifactUrl: 'https://example.com/artifact', runUrl: 'https://example.com/run', maxChangedRows: 20, maxErrorRows: 10 };

async function runReport(action, { missingSummary = false, invalidConfig = false, env = {}, comments = [], suppliedSummary = summary } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-comment-action-'));
  const configPath = path.join(tempDir, 'snapdrift.json');
  const summaryPath = path.join(tempDir, 'summary.json');
  const operations = [];
  const github = {
    paginate: jest.fn(async () => comments),
    rest: { issues: Object.fromEntries(['listComments', 'createComment', 'updateComment', 'deleteComment'].map((method) => [
      method, jest.fn(async (options) => { operations.push([method, options]); })
    ])) }
  };
  try {
    await fs.writeFile(configPath, invalidConfig ? '{}' : JSON.stringify(config));
    if (!missingSummary) await fs.writeFile(summaryPath, JSON.stringify(suppliedSummary));
    const result = await executeActionScript({
      actionPath: path.join(root, `actions/${action}/action.yml`), stepId: undefined,
      github, context, actionRoot: root,
      env: {
        REPO_CONFIG_PATH: configPath, SUMMARY_PATH: summaryPath, VISUAL_DIFF_SUMMARY_PATH: summaryPath,
        PR_NUMBER: '42', INPUT_PR_NUMBER: '42', RUN_URL: meta.runUrl, VISUAL_DIFF_RUN_URL: meta.runUrl,
        ARTIFACT_NAME: meta.artifactName, VISUAL_DIFF_ARTIFACT_NAME: meta.artifactName,
        ARTIFACT_URL: meta.artifactUrl, VISUAL_DIFF_ARTIFACT_URL: meta.artifactUrl,
        MAX_CHANGED_ROWS: '', MAX_ERROR_ROWS: '', BASELINE_RESOLUTION_STATUS: '', BASELINE_RESOLUTION_MESSAGE: '', ...env
      }
    });
    return { ...result, github, operations, summaryPath };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe.each(['comment', 'pr-diff'])('%s report adapter', (action) => {
  it('creates the identical provider-rendered report using default truncation limits', async () => {
    const result = await runReport(action);
    expect(result.operations).toEqual([['createComment', {
      ...context.repo, issue_number: 42, body: new LocalProvider().buildCommentBody(summary, meta)
    }]]);
    expect(result.github.paginate).toHaveBeenCalledWith(result.github.rest.issues.listComments, {
      ...context.repo, issue_number: 42, per_page: 100
    });
    expect(result.warnings).toEqual([]);
  });

  it('updates the latest matching report before deleting older duplicates', async () => {
    const result = await runReport(action, { comments: [
      { id: 1, body: PR_COMMENT_MARKER, updated_at: '2026-01-01' },
      { id: 2, body: PR_COMMENT_MARKER, updated_at: '2026-03-01' },
      { id: 3, body: PR_COMMENT_MARKER, created_at: '2026-02-01' },
      { id: 4, body: 'unrelated', updated_at: '2026-04-01' }
    ] });
    expect(result.operations).toEqual([
      ['updateComment', { ...context.repo, comment_id: 2, body: new LocalProvider().buildCommentBody(summary, meta) }],
      ['deleteComment', { ...context.repo, comment_id: 3 }],
      ['deleteComment', { ...context.repo, comment_id: 1 }]
    ]);
  });

  it('preserves configurable report truncation', async () => {
    const suppliedSummary = { ...summary, status: 'changed', errors: [
      { routeId: 'home', viewport: 'desktop', error: 'one' }, { routeId: 'about', viewport: 'desktop', error: 'two' }
    ] };
    const result = await runReport(action, { suppliedSummary, env: { MAX_CHANGED_ROWS: '1', MAX_ERROR_ROWS: '1' } });
    expect(result.operations[0][1].body).toBe(new LocalProvider().buildCommentBody(suppliedSummary, {
      ...meta, maxChangedRows: 1, maxErrorRows: 1
    }));
  });

  it('retains local rendering and the diagnostic on invalid config', async () => {
    const result = await runReport(action, { invalidConfig: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^Could not load SnapDrift config; falling back to LocalProvider\./);
    expect(result.operations[0][1].body).toBe(new LocalProvider().buildCommentBody(summary, meta));
  });

  it('skips without requests when no valid PR number is available', async () => {
    const result = await runReport(action, { env: { PR_NUMBER: 'invalid', INPUT_PR_NUMBER: 'invalid' } });
    expect(result.warnings).toEqual(['SnapDrift PR report skipped because no pull request number was available.']);
    expect(result.operations).toEqual([]);
    expect(result.github.paginate).not.toHaveBeenCalled();
  });
});

describe('missing-summary reporting', () => {
  it('keeps standalone comments as a warning without posting', async () => {
    const result = await runReport('comment', { missingSummary: true });
    expect(result.warnings).toEqual([`SnapDrift summary not found at ${result.summaryPath}`]);
    expect(result.operations).toEqual([]);
    expect(result.github.paginate).not.toHaveBeenCalled();
  });

  it.each([
    ['', '', 'Capture Failed', 'SnapDrift did not produce a summary. This usually means capture failed before the report could be assembled.'],
    ['error', '', 'Baseline Lookup Failed', 'The GitHub baseline lookup failed before comparison could run.'],
    ['error', 'Lookup <failed> *details*', 'Baseline Lookup Failed', 'Lookup <failed> *details*']
  ])('preserves the create-only fallback body for %s/%s', async (status, message, heading, detail) => {
    const result = await runReport('pr-diff', {
      missingSummary: true,
      env: { BASELINE_RESOLUTION_STATUS: status, BASELINE_RESOLUTION_MESSAGE: message },
      comments: [{ id: 1, body: PR_COMMENT_MARKER }]
    });
    const iconUrl = 'https://raw.githubusercontent.com/ranacseruet/snapdrift/main/assets/snapdrift-logo-icon.png';
    const repoUrl = 'https://github.com/ranacseruet/snapdrift';
    const body = `${PR_COMMENT_MARKER}\n<img src="${iconUrl}" alt="SnapDrift" width="20" height="20" />\n\n### \u26a0\ufe0f SnapDrift Report — ${heading}\n\n${escapeMarkdown(detail)}\n\n[View run](${meta.runUrl}) for details.\n\n<div align="right"><sub>Powered by <a href="${repoUrl}">SnapDrift</a></sub></div>`;
    expect(result.operations).toEqual([['createComment', { ...context.repo, issue_number: 42, body }]]);
    expect(result.github.paginate).not.toHaveBeenCalled();
  });
});
