#!/usr/bin/env node
/**
 * Ensure a `handoff` executable is on PATH for doctor / integration tests,
 * without requiring a global `pnpm link`.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = resolve(repoRoot, "dist/cli.js");
const binDir = mkdtempSync(`${tmpdir()}/handoff-test-bin-`);
const shim = resolve(binDir, "handoff");
writeFileSync(
  shim,
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
  "utf8"
);
chmodSync(shim, 0o755);
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
