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
 * @param {Iterable<string>} routeIds
 * @param {string} [sourceLabel]
 * @returns {void}
 * @throws {Error} when two distinct ids map to the same filename
 */
export function assertUniqueRouteIdFilenames(routeIds, sourceLabel = 'route ids') {
  /** @type {Map<string, string>} */
  const routeIdByFilename = new Map();

  for (const routeId of routeIds) {
    if (typeof routeId !== 'string') {
      continue;
    }

    const filename = `${sanitizeRouteId(routeId)}.png`;
    const previousRouteId = routeIdByFilename.get(filename);
    if (previousRouteId && previousRouteId !== routeId) {
      throw new Error(
        `Route ids "${previousRouteId}" and "${routeId}" in ${sourceLabel} ` +
        `map to the same screenshot filename "screenshots/${filename}". ` +
        `Rename one of the route ids and recapture the affected baseline.`
      );
    }

    routeIdByFilename.set(filename, routeId);
  }
}
