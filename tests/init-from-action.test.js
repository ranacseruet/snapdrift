/** @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { runInitFromAction } = await import('../lib/init-from-action.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapWorkflow(overrides = {}) {
  return {
    name: 'Visual Tests',
    on: { pull_request: { branches: ['main'] } },
    jobs: {
      screenshots: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'actions/checkout@v4' },
          {
            uses: 'i2dev-com/snap/github-action@v1',
            with: {
              threshold: '0.02',
              'fail-on-changes': 'true',
              format: 'jpeg',
              baseline_tag: 'main',
              'snap-api-key-env': 'SNAP_API_KEY',
              'snap-project-id': 'my-project-42',
              ...overrides
            }
          }
        ]
      }
    }
  };
}

// ---------------------------------------------------------------------------
// runInitFromAction — basic parsing
// ---------------------------------------------------------------------------

describe('runInitFromAction', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapdrift-init-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates snapdrift.json from a Snap action workflow', async () => {
    const workflowPath = path.join(tempDir, 'workflow.yml');
    const workflow = makeSnapWorkflow();
    // Write as YAML using js-yaml
    const yaml = (await import('js-yaml')).default;
    await fs.writeFile(workflowPath, yaml.dump(workflow));

    // Change cwd to temp dir so .github/ is created there
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const result = await runInitFromAction(workflowPath);
      expect(result.configPath).toBe('.github/snapdrift.json');

      // Verify snapdrift.json exists and has correct content
      const configContent = await fs.readFile('.github/snapdrift.json', 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.diff.threshold).toBe(0.02);
      expect(config.diff.mode).toBe('fail-on-changes');
      expect(config.provider).toBe('snap');
      expect(config.snap.apiKeyEnv).toBe('SNAP_API_KEY');
      expect(config.snap.projectId).toBe('my-project-42');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('creates MIGRATION_NOTES.md with warnings', async () => {
    const workflowPath = path.join(tempDir, 'workflow.yml');
    const workflow = makeSnapWorkflow();
    const yaml = (await import('js-yaml')).default;
    await fs.writeFile(workflowPath, yaml.dump(workflow));

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      await runInitFromAction(workflowPath);
      const notes = await fs.readFile('.github/MIGRATION_NOTES.md', 'utf-8');
      // Should contain warning about format: jpeg
      expect(notes).toContain('format');
      expect(notes).toContain('PNG');
      // Should contain warning about baseline_tag
      expect(notes).toContain('baseline_tag');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('throws when workflow file does not exist', async () => {
    await expect(runInitFromAction('/nonexistent/workflow.yml'))
      .rejects.toThrow(/Cannot read workflow file/);
  });

  it('throws when no Snap action step is found', async () => {
    const workflowPath = path.join(tempDir, 'workflow.yml');
    const workflow = {
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: { build: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'actions/checkout@v4' }] } }
    };
    const yaml = (await import('js-yaml')).default;
    await fs.writeFile(workflowPath, yaml.dump(workflow));

    await expect(runInitFromAction(workflowPath))
      .rejects.toThrow(/No Snap action step found/);
  });

  it('refuses to overwrite existing snapdrift.json (idempotency)', async () => {
    const workflowPath = path.join(tempDir, 'workflow.yml');
    const workflow = makeSnapWorkflow();
    const yaml = (await import('js-yaml')).default;
    await fs.writeFile(workflowPath, yaml.dump(workflow));

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      // First run should succeed
      await runInitFromAction(workflowPath);

      // Second run should fail
      await expect(runInitFromAction(workflowPath))
        .rejects.toThrow(/already exists/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('handles workflow without snap-specific inputs', async () => {
    const workflowPath = path.join(tempDir, 'workflow.yml');
    const workflow = makeSnapWorkflow({ threshold: undefined, 'fail-on-changes': undefined, format: undefined, baseline_tag: undefined, 'snap-api-key-env': undefined, 'snap-project-id': undefined });
    // Remove the snap-specific with entries
    workflow.jobs.screenshots.steps[1].with = {};
    const yaml = (await import('js-yaml')).default;
    await fs.writeFile(workflowPath, yaml.dump(workflow));

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      await runInitFromAction(workflowPath);
      const configContent = await fs.readFile('.github/snapdrift.json', 'utf-8');
      const config = JSON.parse(configContent);
      expect(config.diff.threshold).toBe(0.01);
      expect(config.diff.mode).toBe('report-only');
      expect(config.provider).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });
});
