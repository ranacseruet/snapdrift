// @ts-check

export { makeMarkdown, formatViewport, formatDriftFailureMessage } from './markdown.mjs';
export { buildDriftSummary, describeReason } from './drift-summary.mjs';
export { buildReportCommentBody, PR_COMMENT_MARKER, PR_COMMENT_MARKERS, escapeMarkdown } from './pr-comment.mjs';
export { generateHtmlReport } from './html-report.mjs';
export { DEFAULT_SNAPDRIFT_REPO_URL, DEFAULT_SNAPDRIFT_ICON_URL, STATUS_ICONS, STATUS_LABELS } from './constants.mjs';