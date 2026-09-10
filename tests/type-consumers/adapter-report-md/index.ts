import * as api from '@snapdrift/adapter-report-md';
import type { VisualDiffSummary, VisualDriftSkippedSummary } from '@snapdrift/manifest';

declare const summary: VisualDiffSummary;
const skipped: VisualDriftSkippedSummary = { status: 'skipped', reason: 'scope' };
api.DEFAULT_SNAPDRIFT_REPO_URL.toUpperCase();
api.DEFAULT_SNAPDRIFT_ICON_URL.toUpperCase();
api.STATUS_ICONS.clean.toUpperCase();
api.STATUS_LABELS.clean.toUpperCase();
api.makeMarkdown(summary).toUpperCase();
api.formatViewport('desktop').toUpperCase();
api.formatViewport({ width: 10, height: 10 });
api.formatViewport(undefined);
api.formatDriftFailureMessage('strict', { changedScreenshots: 1 });
api.describeReason('scope').message.toUpperCase();
const built = api.buildDriftSummary({ reason: 'scope', selectedRouteIds: ['home'] });
built.markdown.toUpperCase();
api.buildReportCommentBody(summary, { maxErrorRows: 1 });
api.buildReportCommentBody(skipped);
api.buildReportCommentBody(built.summary);
api.PR_COMMENT_MARKER.toUpperCase();
api.PR_COMMENT_MARKERS.map(marker => marker.toUpperCase());
api.escapeMarkdown({ untrusted: true }).toUpperCase();
api.generateHtmlReport(summary, {
  baselineRunDir: '.', currentRunDir: '.', diffRunDir: './diff',
  imageReader: async (dir, imagePath) => dir && imagePath ? 'data:image/png;base64,' : null
}).then(html => html.toUpperCase());
// @ts-expect-error invalid enforcement mode
api.formatDriftFailureMessage('quiet', {});
// @ts-expect-error viewport dimensions are numeric
api.formatViewport({ width: '10', height: 10 });
// @ts-expect-error reader returns a data URI or null
api.generateHtmlReport(summary, { imageReader: async () => 42 });
// @ts-expect-error row limits are numeric
api.buildReportCommentBody(summary, { maxChangedRows: 'all' });
// @ts-expect-error markdown is text
const wrongMarkdown: number = api.makeMarkdown(summary);

// @ts-expect-error typo is not a report summary
api.buildReportCommentBody({ totalScrenshots: 5 });
api.buildReportCommentBody(api.buildDriftSummary({ status: 'incomplete', reason: 'capture_failed' }).summary);
