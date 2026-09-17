import { jest } from '@jest/globals';
import { fetchPullRequestFiles, resolveScopeDecision, resolvePullRequestScope, upsertPullRequestReportComment } from '../lib/github-requests.mjs';

const config = {
  routes: [
    { id: 'home', path: '/', viewport: 'desktop', changePaths: ['src/home/'] },
    { id: 'about', path: '/about', viewport: 'desktop', changePaths: ['src/about/'] }
  ],
  selection: { sharedExact: ['package.json'], sharedPrefixes: ['src/shared/'] }
};
const repository = { owner: 'example', repo: 'app' };

function filesClient(files) {
  return { rest: { pulls: { listFiles: jest.fn() } }, paginate: jest.fn(async () => files) };
}

function commentsClient(comments) {
  const operations = [];
  const issues = Object.fromEntries(['listComments', 'createComment', 'updateComment', 'deleteComment'].map((method) => [
    method, jest.fn(async (options) => { operations.push([method, options]); })
  ]));
  return { rest: { issues }, paginate: jest.fn(async () => comments), operations };
}

describe('fetchPullRequestFiles', () => {
  it('paginates with the injected client and returns raw records unchanged', async () => {
    const files = [{ filename: 'src/home/index.js', status: 'modified', additions: 3 }];
    const github = filesClient(files);
    expect(await fetchPullRequestFiles({ github, ...repository, pullNumber: 42 })).toBe(files);
    expect(github.paginate).toHaveBeenCalledWith(github.rest.pulls.listFiles, {
      ...repository, pull_number: 42, per_page: 100
    });
  });

  it.each([null, {}, 'files', undefined])('rejects non-array responses: %s', async (files) => {
    await expect(fetchPullRequestFiles({ github: filesClient(files), ...repository, pullNumber: 42 }))
      .rejects.toThrow('Malformed GitHub changed-file response: expected an array of file records.');
  });

  it.each([null, undefined, 'file', {}, { filename: '' }, { filename: 1 }, { filename: null }])('rejects invalid records: %s', async (file) => {
    await expect(fetchPullRequestFiles({ github: filesClient([{ filename: 'valid' }, file]), ...repository, pullNumber: 42 }))
      .rejects.toThrow('Malformed GitHub changed-file response: file record 1 must include a non-empty string filename.');
  });

  it('propagates request failures', async () => {
    const github = filesClient([]);
    github.paginate.mockRejectedValue(new Error('rate limited'));
    await expect(fetchPullRequestFiles({ github, ...repository, pullNumber: 42 })).rejects.toThrow('rate limited');
  });
});

describe('resolveScopeDecision', () => {
  it.each([
    [[], false, 'no_changed_files', []],
    [[{ filename: 'docs/readme.md' }], false, 'no_snapdrift_relevant_changes', []],
    [[{ filename: 'src/home/index.js' }], true, 'scoped_snapdrift_change', ['home']],
    [[{ filename: 'package.json' }], true, 'shared_snapdrift_change', ['home', 'about']],
    [[{ filename: 'src/shared/theme.js' }], true, 'shared_snapdrift_change', ['home', 'about']],
    [[{ filename: 'src/about/index.js', status: 'renamed', previous_filename: 'src/home/index.js' }], true, 'scoped_snapdrift_change', ['home', 'about']]
  ])('resolves changed files %j', (files, shouldRun, reason, selectedRouteIds) => {
    expect(resolveScopeDecision({ config, files })).toMatchObject({ shouldRun, reason, selectedRouteIds });
  });

  it('deduplicates renamed and repeated paths without mutating inputs', () => {
    const files = Object.freeze([
      Object.freeze({ filename: 'src/home/index.js', status: 'renamed', previous_filename: 'src/home/index.js' }),
      Object.freeze({ filename: 'src/home/index.js' })
    ]);
    expect(resolveScopeDecision({ config, files })).toEqual(resolveScopeDecision({ config, files: [{ filename: 'src/home/index.js' }] }));
  });

  it.each([undefined, '', 12])('ignores unusable previous filenames: %s', (previous_filename) => {
    expect(resolveScopeDecision({ config, files: [{ filename: 'docs/a.md', status: 'renamed', previous_filename }] }).reason)
      .toBe('no_snapdrift_relevant_changes');
  });

  it.each(['copied', 'modified'])('ignores previous paths for %s records', (status) => {
    expect(resolveScopeDecision({ config, files: [{ filename: 'docs/a.md', status, previous_filename: 'src/home/a.js' }] }).shouldRun).toBe(false);
  });

  it.each([2999, 3000, 3001])('checks truncation before deduplication at %s records', (length) => {
    const result = resolveScopeDecision({ config, files: Array.from({ length }, () => ({ filename: 'docs/a.md' })) });
    expect(result).toMatchObject(length >= 3000
      ? { shouldRun: true, reason: 'changed_files_truncated', selectedRouteIds: ['home', 'about'] }
      : { shouldRun: false, reason: 'no_snapdrift_relevant_changes', selectedRouteIds: [] });
  });
});

describe('resolvePullRequestScope', () => {
  it('prioritizes explicit routes over forcing and missing PRs', async () => {
    const github = filesClient([]);
    expect(await resolvePullRequestScope({ github, ...repository, config, pullNumber: 0, routeIds: 'about,about', forceRun: true }))
      .toEqual({ shouldRun: true, reason: 'explicit_route_ids', selectedRouteIds: ['about'] });
    expect(github.paginate).not.toHaveBeenCalled();
  });

  it('does not swallow invalid explicit route selection', async () => {
    await expect(resolvePullRequestScope({ github: filesClient([]), ...repository, config, pullNumber: 42, routeIds: 'unknown' })).rejects.toThrow();
  });

  it('keeps malformed responses ahead of truncation fallback', async () => {
    const warning = jest.fn();
    const files = Array.from({ length: 3000 }, () => ({ filename: 'docs/a.md' }));
    files[2999] = {};
    expect((await resolvePullRequestScope({ github: filesClient(files), ...repository, config, pullNumber: 42, warning })).reason)
      .toBe('snapdrift_scope_check_failed');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('file record 2999'));
  });
});

describe('upsertPullRequestReportComment', () => {
  const options = { ...repository, issueNumber: 42, body: 'new report', markers: ['<!-- report -->', '<!-- legacy -->'] };

  it('creates when no markers match and requests all comment pages', async () => {
    const github = commentsClient([{ id: 1, body: 'unrelated' }, { id: 2, body: null }]);
    await upsertPullRequestReportComment({ github, ...options });
    expect(github.paginate).toHaveBeenCalledWith(github.rest.issues.listComments, { ...repository, issue_number: 42, per_page: 100 });
    expect(github.operations).toEqual([['createComment', { ...repository, issue_number: 42, body: options.body }]]);
  });

  it('updates the most recently updated match then deletes duplicates newest first', async () => {
    const comments = [
      { id: 1, body: '<!-- report -->', updated_at: '2026-01-01' },
      { id: 2, body: '<!-- legacy -->', updated_at: '2026-03-01', created_at: '2025-01-01' },
      { id: 3, body: '<!-- report -->', created_at: '2026-02-01' },
      { id: 4, body: 'unrelated', updated_at: '2026-04-01' }
    ];
    const github = commentsClient(comments);
    await upsertPullRequestReportComment({ github, ...options });
    expect(github.operations).toEqual([
      ['updateComment', { ...repository, comment_id: 2, body: options.body }],
      ['deleteComment', { ...repository, comment_id: 3 }],
      ['deleteComment', { ...repository, comment_id: 1 }]
    ]);
    expect(comments.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
  });

  it('does not delete duplicates when updating the retained comment fails', async () => {
    const github = commentsClient([1, 2].map((id) => ({ id, body: '<!-- report -->', created_at: '2026-01-01' })));
    github.rest.issues.updateComment.mockRejectedValue(new Error('denied'));
    await expect(upsertPullRequestReportComment({ github, ...options })).rejects.toThrow('denied');
    expect(github.rest.issues.deleteComment).not.toHaveBeenCalled();
  });
});
