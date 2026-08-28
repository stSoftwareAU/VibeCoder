/**
 * Regression tests for Issue #3601 — README.md, CODING-STANDARDS.md and
 * CONTRIBUTING.md still enumerated `shellcheck` as a check the local quality
 * gate runs, and never mentioned `deno fmt --check`.
 *
 * Shellcheck was removed from the worker's gate by Issue #3129 (bash linting is
 * owned by each target repo's own CI) and `deno fmt --check` was added by Issue
 * #2940. These tests tie the prose back to the real behaviour:
 *   - the check names `runQualityGate` actually records, and
 *   - the tools `checkAllPrerequisites` actually requires.
 *
 * Australian English spelling used throughout (behaviour, enumerated, etc.).
 */

import { assert } from "@std/assert";
import { runQualityGate } from "../lib/quality_gate.ts";

/** Check names the real gate records for a minimal repo. */
async function gateCheckNames(): Promise<string[]> {
  const tmpDir = await Deno.makeTempDir();
  try {
    // A script with an unquoted expansion — shellcheck would flag SC2086.
    await Deno.writeTextFile(
      `${tmpDir}/script.sh`,
      "#!/bin/bash\nls $unquoted\n",
    );
    const result = await runQualityGate({
      scriptDir: tmpDir,
      options: { strict: false, sequential: false, validatePrompts: false },
    });
    assert(result.ok, "quality gate should return a result");
    return result.value.checks.map((check) => check.name);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("quality gate - records no shellcheck check (Issue #3129)", async () => {
  const names = await gateCheckNames();
  assert(
    !names.some((name) => /shellcheck/i.test(name)),
    `Gate must not run shellcheck (Issue #3129); recorded: ${names.join(", ")}`,
  );
});

Deno.test("quality gate - records a deno fmt check (Issue #2940)", async () => {
  const names = await gateCheckNames();
  assert(
    names.includes("deno fmt"),
    `Gate must run deno fmt --check; recorded: ${names.join(", ")}`,
  );
});
