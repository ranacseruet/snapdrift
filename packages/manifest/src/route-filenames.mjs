// @ts-check

/**
 * Strip characters that could cause path traversal or produce invalid
 * filenames when a route id is used as a screenshot filename.
 *
 * @param {string} id
 * @returns {string}
 */
export function sanitizeRouteId(id) {
  return id
    .replace(/\.\./g, '_')
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * Validate that distinct route ids produce distinct screenshot filenames.
 * Existing safe route ids keep their current `<sanitized-id>.png` names.
 *
 * @param {Iterable<unknown>} routeIds
 * @param {string} [sourceLabel]
 * @param {string} [extension]
 * @returns {void}
 * @throws {Error} when two distinct ids map to the same filename
 */
export function assertUniqueRouteIdFilenames(routeIds, sourceLabel = 'route ids', extension = '.png') {
  /** @type {Map<string, unknown>} */
  const routeIdByFilename = new Map();
  /** @type {string[]} */
  const errors = [];

  for (const routeId of routeIds) {
    if (typeof routeId !== 'string' || routeId.length === 0) {
      throw new Error(
        `Route id in ${sourceLabel} must be a non-empty string; received ${String(routeId)}. ` +
        `Rename the invalid route id and recapture the affected baseline.`
      );
    }

    const filename = `${sanitizeRouteId(routeId)}${extension}`;
    if (routeIdByFilename.has(filename)) {
      const previousRouteId = routeIdByFilename.get(filename);
      errors.push(
        `Route ids "${previousRouteId}" and "${routeId}" in ${sourceLabel} ` +
        `map to the same screenshot filename "screenshots/${filename}". ` +
        `Rename one of the route ids and recapture the affected baseline.`
      );
    }

    if (!routeIdByFilename.has(filename)) {
      routeIdByFilename.set(filename, routeId);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}
