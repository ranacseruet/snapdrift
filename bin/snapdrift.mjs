#!/usr/bin/env node
// @ts-check

import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve cli.mjs relative to this file so the bin entry works regardless of
// where the consumer installs the package. Use fileURLToPath(new URL(...)) rather
// than URL.pathname so paths containing spaces or Windows drive letters survive
// the conversion (URL.pathname percent-encodes them, then pathToFileURL re-encodes
// the result, producing a path that does not exist).
const cliPath = fileURLToPath(new URL('../lib/cli.mjs', import.meta.url));
const { main } = await import(pathToFileURL(cliPath).href);

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
