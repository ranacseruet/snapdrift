// @ts-check

import fs from 'node:fs/promises';

import { resolveImagePath } from './compare-results.mjs';

/** @typedef {import('../types/visual-diff-types').VisualDiffSummary} DriftSummary */
/** @typedef {import('../types/visual-diff-types').VisualViewport} VisualViewport */

/**
 * @param {VisualViewport | undefined} viewport
 * @returns {string}
 */
function formatViewport(viewport) {
  if (!viewport) return '';
  return typeof viewport === 'string' ? viewport : `${viewport.width}x${viewport.height}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readFileAsBase64(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

/**
 * @param {string | null} base64Data
 * @param {string} alt
 * @returns {string}
 */
function imgTag(base64Data, alt) {
  if (!base64Data) return `<span class="no-img">Image unavailable</span>`;
  return `<img src="data:image/png;base64,${base64Data}" alt="${escapeHtml(alt)}" />`;
}

/**
 * Generates a self-contained HTML report from a diff summary.
 * Images are embedded as base64 data URIs when screenshot directories are provided.
 *
 * @param {DriftSummary} summary
 * @param {{
 *   baselineRunDir?: string,
 *   currentRunDir?: string
 * }} [options]
 * @returns {Promise<string>}
 */
export async function generateHtmlReport(summary, options = {}) {
  const { baselineRunDir, currentRunDir } = options;
  const dimensionChanges = summary.dimensionChanges || [];

  const statusClass = {
    clean: 'status-clean',
    'changes-detected': 'status-changes',
    incomplete: 'status-incomplete',
    skipped: 'status-skipped'
  }[summary.status || 'incomplete'] || 'status-incomplete';

  const statusLabel = {
    clean: '&#10003; Clean',
    'changes-detected': 'Drift detected',
    incomplete: 'Incomplete',
    skipped: 'Skipped'
  }[summary.status || 'incomplete'] || 'Incomplete';

  // --- Changed routes ---
  let changedHtml;
  if (summary.changed.length === 0) {
    changedHtml = '<p class="none">None</p>';
  } else {
    const rows = await Promise.all(summary.changed.map(async (item) => {
      let baselineImgHtml = '';
      let currentImgHtml = '';

      if (baselineRunDir) {
        try {
          const resolved = await resolveImagePath(baselineRunDir, item.baselineImagePath);
          baselineImgHtml = imgTag(await readFileAsBase64(resolved), `Baseline: ${item.id}`);
        } catch {
          baselineImgHtml = imgTag(null, `Baseline: ${item.id}`);
        }
      }
      if (currentRunDir) {
        try {
          const resolved = await resolveImagePath(currentRunDir, item.currentImagePath);
          currentImgHtml = imgTag(await readFileAsBase64(resolved), `Current: ${item.id}`);
        } catch {
          currentImgHtml = imgTag(null, `Current: ${item.id}`);
        }
      }

      const dataRow = `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.path)}</td>
        <td>${escapeHtml(formatViewport(item.viewport))}</td>
        <td>${(item.mismatchRatio * 100).toFixed(2)}%</td>
        <td>${item.differentPixels}/${item.totalPixels}</td>
      </tr>`;

      const imagesRow = (baselineImgHtml || currentImgHtml) ? `<tr class="images-row"><td colspan="5">
        <div class="image-compare">
          <div class="image-col"><div class="image-label">Baseline</div>${baselineImgHtml || '<span class="no-img">&ndash;</span>'}</div>
          <div class="image-col"><div class="image-label">Current</div>${currentImgHtml || '<span class="no-img">&ndash;</span>'}</div>
        </div>
      </td></tr>` : '';

      return dataRow + imagesRow;
    }));

    changedHtml = `<table>
      <thead><tr><th>Route</th><th>Path</th><th>Viewport</th><th>Mismatch</th><th>Pixels changed</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
  }

  // --- Capture gaps ---
  let missingHtml;
  if (summary.missing.length === 0) {
    missingHtml = '<p class="none">None</p>';
  } else {
    const rows = summary.missing.map((item) => `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.location)}</td>
        <td>${escapeHtml(item.reason)}</td>
      </tr>`).join('');
    missingHtml = `<table>
      <thead><tr><th>Route</th><th>Missing from</th><th>Reason</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // --- Dimension shifts ---
  let dimensionHtml;
  if (dimensionChanges.length === 0) {
    dimensionHtml = '<p class="none">None</p>';
  } else {
    const rows = dimensionChanges.map((item) => `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(formatViewport(item.viewport))}</td>
        <td>${item.baselineWidth}&times;${item.baselineHeight}</td>
        <td>${item.currentWidth}&times;${item.currentHeight}</td>
      </tr>`).join('');
    dimensionHtml = `<table>
      <thead><tr><th>Route</th><th>Viewport</th><th>Baseline</th><th>Current</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // --- Errors ---
  let errorsHtml;
  if (summary.errors.length === 0) {
    errorsHtml = '<p class="none">None</p>';
  } else {
    const rows = summary.errors.map((item) => `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.message)}</td>
      </tr>`).join('');
    errorsHtml = `<table>
      <thead><tr><th>Route</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // --- Meta bar ---
  const metaParts = [];
  if (summary.baselineArtifactName) metaParts.push(`Baseline: <code>${escapeHtml(summary.baselineArtifactName)}</code>`);
  if (summary.baselineSourceSha) metaParts.push(`SHA: <code>${escapeHtml(summary.baselineSourceSha)}</code>`);
  metaParts.push(`Diff mode: <code>${escapeHtml(summary.diffMode)}</code>`);
  metaParts.push(`Threshold: <code>${summary.threshold}</code>`);

  const generatedAt = escapeHtml(summary.finishedAt || summary.startedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SnapDrift Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; background: #f6f8fa; color: #24292f; line-height: 1.5; }
    a { color: #0969da; }
    h1 { margin: 0 0 8px; font-size: 1.4em; }
    h2 { font-size: 1.1em; border-bottom: 1px solid #d0d7de; padding-bottom: 6px; margin: 0 0 12px; }
    .header { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
    .status { display: inline-block; font-size: 1.1em; font-weight: 600; padding: 3px 10px; border-radius: 12px; }
    .status-clean { background: #dafbe1; color: #116329; }
    .status-changes { background: #fff8c5; color: #7d4e00; }
    .status-incomplete { background: #fff3cd; color: #664d03; }
    .status-skipped { background: #f6f8fa; color: #57606a; }
    .stats { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    .stat { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 14px; min-width: 100px; }
    .stat strong { display: block; font-size: 1.5em; line-height: 1.2; }
    .stat span { font-size: 0.8em; color: #57606a; }
    .meta { margin-top: 12px; font-size: 0.85em; color: #57606a; }
    .meta em { margin-right: 14px; font-style: normal; }
    section { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
    th { background: #f6f8fa; text-align: left; padding: 7px 10px; border-bottom: 1px solid #d0d7de; white-space: nowrap; }
    td { padding: 7px 10px; border-bottom: 1px solid #eaecef; vertical-align: top; word-break: break-word; }
    tr:last-child td { border-bottom: none; }
    .images-row td { padding: 0 10px 14px; background: #fafafa; }
    .image-compare { display: flex; gap: 16px; flex-wrap: wrap; }
    .image-col { flex: 1; min-width: 260px; }
    .image-label { font-size: 0.78em; font-weight: 600; color: #57606a; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .image-col img { max-width: 100%; border: 1px solid #d0d7de; border-radius: 4px; display: block; }
    .no-img { color: #57606a; font-size: 0.85em; font-style: italic; }
    .none { color: #57606a; font-style: italic; margin: 0; }
    code { background: #eaeef2; padding: 1px 5px; border-radius: 4px; font-size: 0.88em; }
    footer { font-size: 0.8em; color: #57606a; text-align: right; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SnapDrift Visual Diff Report</h1>
    <span class="status ${statusClass}">${statusLabel}</span>
    <div class="stats">
      <div class="stat"><strong>${summary.changedScreenshots}</strong><span>Drift signals</span></div>
      <div class="stat"><strong>${summary.matchedScreenshots}</strong><span>Stable captures</span></div>
      <div class="stat"><strong>${summary.missingInBaseline + summary.missingInCurrent}</strong><span>Capture gaps</span></div>
      <div class="stat"><strong>${dimensionChanges.length}</strong><span>Dimension shifts</span></div>
      <div class="stat"><strong>${summary.errors.length}</strong><span>Errors</span></div>
    </div>
    <div class="meta">${metaParts.map((p) => `<em>${p}</em>`).join('')}</div>
  </div>

  <section>
    <h2>Drift signals</h2>
    ${changedHtml}
  </section>

  <section>
    <h2>Capture gaps</h2>
    ${missingHtml}
  </section>

  <section>
    <h2>Dimension shifts</h2>
    ${dimensionHtml}
  </section>

  <section>
    <h2>Comparison errors</h2>
    ${errorsHtml}
  </section>

  <footer>Generated by <a href="https://github.com/ranacseruet/snapdrift">SnapDrift</a> &middot; ${generatedAt}</footer>
</body>
</html>
`;
}
