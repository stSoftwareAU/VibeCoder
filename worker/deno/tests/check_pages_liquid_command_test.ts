/**
 * Tests for commands/check_pages_liquid.ts (Issue #1601).
 *
 * Verifies the command wrapper behaviour around the underlying
 * `runPagesLiquidCheck` orchestrator. Toolchain detection is exercised
 * indirectly via the orchestrator tests; here we only need to confirm
 * the command returns the right `success` flag for each status.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkPagesLiquidCommand } from "../commands/check_pages_liquid.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { PagesLiquidCheckResult } from "../lib/pages_liquid_check.ts";

const config = buildDefaultWorkerConfig();

function dataOf(
  result: { data?: unknown },
): PagesLiquidCheckResult | undefined {
  return result.data as PagesLiquidCheckResult | undefined;
}

Deno.test("check-pages-liquid command - SKIPPED when no published files exist", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "check_pages_liquid_cmd_" });
  try {
    // Empty repo — no AGENTS.md, README.md, etc.
    const result = await checkPagesLiquidCommand.execute(
      { "script-dir": tmp },
      config,
    );

    // SKIPPED is success at the command level (strict-mode promotion
    // happens in the quality gate, not here).
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "pages-liquid: SKIPPED");
    assertEquals(dataOf(result)?.status, "SKIPPED");
    assertEquals(dataOf(result)?.filesChecked, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("check-pages-liquid command - SKIPPED when toolchain unavailable but files exist", async () => {
  const tmp = await Deno.makeTempDir({
    prefix: "check_pages_liquid_cmd_skip_",
  });
  try {
    await Deno.writeTextFile(`${tmp}/AGENTS.md`, "# Heading\n\nbody\n");

    // We can't easily force the no-toolchain path through the command
    // wrapper without dependency injection. Either:
    //   - Ruby + Liquid IS available → result is PASSED
    //   - Ruby + Liquid is NOT available → result is SKIPPED
    // Both are valid command-level success outcomes; assert on the
    // intersection: status is one of {PASSED, SKIPPED} and success=true.
    const result = await checkPagesLiquidCommand.execute(
      { "script-dir": tmp },
      config,
    );

    assertEquals(result.success, true);
    const status = dataOf(result)?.status;
    assertEquals(
      status === "PASSED" || status === "SKIPPED",
      true,
      `expected PASSED or SKIPPED, got ${status}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("check-pages-liquid command - default scriptDir falls back to cwd", async () => {
  // No --script-dir argument → command resolves Deno.cwd(). It just
  // needs to run without throwing and return a CommandResult with a
  // recognised status. The actual outcome depends on the cwd, so we
  // assert weak structural properties only.
  const result = await checkPagesLiquidCommand.execute({}, config);
  const status = dataOf(result)?.status;
  assertEquals(
    status === "PASSED" || status === "SKIPPED" || status === "FAILED",
    true,
    `expected a valid status, got ${status}`,
  );
});
