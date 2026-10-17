/**
 * The quality gate records why a stage was SKIPPED (Issue #3726).
 *
 * Without the reason an audit cannot tell a skipped local stage from a passed
 * one, so cannot match a CI-only failure to it.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runQualityGate } from "../lib/quality_gate.ts";

Deno.test("quality gate - a SKIPPED semgrep stage records its reason (Issue #3726)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await runQualityGate({
      scriptDir: tmpDir,
      options: { strict: false, sequential: true, validatePrompts: false },
    });
    assert(result.ok, "quality gate should return a result");
    const semgrep = result.value.checks.find((c) => c.name === "semgrep");
    assert(semgrep, "the gate must record a semgrep check");
    assertEquals(semgrep.status, "SKIPPED");
    assertStringIncludes(semgrep.output ?? "", "not a git repository");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("quality gate - SKIPPED Deno checks record why (Issue #3726)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await runQualityGate({
      scriptDir: tmpDir,
      options: { strict: false, sequential: true, validatePrompts: false },
    });
    assert(result.ok, "quality gate should return a result");
    for (
      const name of ["deno tests", "deno lint", "deno type check", "deno fmt"]
    ) {
      const check = result.value.checks.find((c) => c.name === name);
      assert(check, `the gate must record a '${name}' check`);
      assertEquals(check.status, "SKIPPED");
      assertEquals(
        check.output,
        "no Deno worker directory configured or found",
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
