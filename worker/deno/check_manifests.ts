/**
 * `deno task check:manifests` — the completeness checks, in seconds
 * (Issue #1483).
 *
 * Runs the tree-scanning completeness tests — every `lib/` module claimed by
 * a sweep slice, every `VIBE_*` name registered, every integration suite in
 * its manifest, and the rest of that family — under `--allow-read
 * --allow-env` alone. The membership is derived by
 * `lib/completeness_checks.ts`, not listed here, so it cannot drift.
 *
 * Run it before raising a PR, beside `deno task check` and `deno task lint`:
 * the failures it finds are one-line registration omissions that otherwise
 * cost a full CI matrix to discover.
 *
 * Usage:
 *   deno task check:manifests            # run the family
 *   deno task check:manifests --list     # print the derived membership
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { installConsoleRedaction } from "./lib/console_redaction.ts";
import {
  completenessTestArgs,
  deriveCompletenessTestFiles,
} from "./lib/completeness_checks.ts";

async function main(): Promise<number> {
  // Issue #1280 (SEC-1217-12): every entry point patches its own console.
  installConsoleRedaction();

  const denoDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const files = await deriveCompletenessTestFiles(denoDir);

  if (Deno.args.includes("--list")) {
    for (const file of files) console.log(file);
    return 0;
  }
  if (files.length === 0) {
    console.error(
      "check:manifests: no completeness checks were derived — refusing to report a pass for an empty family",
    );
    return 1;
  }

  console.log(
    `check:manifests: ${files.length} completeness check file(s), derived from the tree`,
  );
  const started = Date.now();
  const command = new Deno.Command(Deno.execPath(), {
    args: completenessTestArgs(files),
    cwd: denoDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `check:manifests: ${code === 0 ? "PASSED" : "FAILED"} in ${seconds}s`,
  );
  return code;
}

if (import.meta.main) {
  Deno.exit(await main());
}
