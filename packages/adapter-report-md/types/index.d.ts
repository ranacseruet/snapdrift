/**
 * @snapdrift/adapter-report-md — Pure markdown and HTML report generators for SnapDrift.
 */

import type {
  VisualDiffSummary,
  VisualViewport,
  VisualDiffSummary as DriftSummary
} from '@snapdrift/manifest';

// --- constants.mjs ---

export const DEFAULT_SNAPDRIFT_REPO_URL: string;
export const DEFAULT_SNAPDRIFT_ICON_URL: string;
export const STATUS_ICONS: Readonly<Record<string, string>>;
export const STATUS_LABELS: Readonly<Record<string, string>>;

// --- markdown.mjs ---

export function formatViewport(viewport: VisualViewport | undefined): string;
export function makeMarkdown(summaryData: VisualDiffSummary): string;
export function formatDriftFailureMessage(
  diffMode: VisualDiffSummary['diff']['mode'],
  summary: { changedScreenshots?: number }
): string;

// --- drift-summary.mjs ---

export function describeReason(reason: string): { message: string; markdownReason: string };

export function buildDriftSummary(options: {
  status?: 'skipped' | 'clean' | 'changes-detected' | 'incomplete';
  reason: string;
  message?: string;
  selectedRouteIds?: string[] | string;
  currentResultsPath?: string;
  baselineAvailable?: boolean;
}): { summary: Record<string, unknown>; markdown: string };

// --- pr-comment.mjs ---

export const PR_COMMENT_MARKER: string;
export const PR_COMMENT_MARKERS: string[];

export function escapeMarkdown(value: unknown): string;

export function buildReportCommentBody(
  summary: Record<string, unknown>,
  meta?: {
    artifactName?: string;
    runUrl?: string;
    maxChangedRows?: number;
    maxErrorRows?: number;
  }
): string;

// --- html-report.mjs ---

export function generateHtmlReport(
  summary: VisualDiffSummary,
  options?: {
    baselineRunDir?: string;
    currentRunDir?: string;
    imageReader?: (runDir: string, imagePath: string) => Promise<string | null>;
  }
): Promise<string>;
