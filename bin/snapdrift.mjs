#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Resolve cli.mjs relative to this file so the bin entry works regardless of
// where the consumer installs the package.
const cliPath = new URL('../lib/cli.mjs', import.meta.url).pathname;
const { main } = await import(pathToFileURL(cliPath).href);

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
