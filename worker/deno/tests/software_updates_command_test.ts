/**
 * Tests for the software-updates command (Issue #1270).
 *
 * The command used to convert `--interval` / `--timeout` with `parseInt` and
 * pass the result on with `??`, which does not catch `NaN`. A wrapper invoking
 * `mod.ts software-updates --timeout "${SOFTWARE_UPDATE_TIMEOUT}"` with the
 * variable unset-but-quoted therefore delivered `NaN`: the interval gate never
 * elapsed, or every install aborted immediately, and the command still exited
 * 0 saying "Software update check complete".
 *
 * No real update command runs here — the refusals return before any update is
 * attempted, and the accepted-value test points the command at a temporary
 * timestamp directory it has just marked as checked, so the run is not due.
 * Nothing mutates process-wide state, so the suite stays in the gate's
 * parallel pass (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { softwareUpdatesCommand } from "../commands/software_updates.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { parseArgs } from "../mod.ts";

// No version floors: a floor check reads each tool's installed version, which
// would spawn a real command. The floor path is covered in
// `software_updates_test.ts` with an injected reader.
const config = buildDefaultWorkerConfig({ softwareMinVersions: {} });

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("softwareUpdatesCommand - has correct name", () => {
  assertEquals(softwareUpdatesCommand.name, "software-updates");
});

// ============================================================================
// Unreadable durations are refused (Issue #1270)
// ============================================================================

Deno.test("softwareUpdatesCommand - refuses an empty --timeout from the CLI (Issue #1270)", async () => {
  // Exactly the wrapper shape from the finding: the shell expanded an unset
  // variable into a quoted empty string.
  const { command, args } = parseArgs([
    "software-updates",
    "--timeout",
    "",
  ]);
  assertEquals(command, "software-updates");
  assertEquals(args["timeout"], ""); // parseArgs leaves it as the empty string

  const result = await softwareUpdatesCommand.execute(args, config);
  assertEquals(result.success, false); // exit 1, not a silent exit 0
  assertStringIncludes(result.message, "--timeout");
});

Deno.test("softwareUpdatesCommand - refuses an empty --interval (Issue #1270)", async () => {
  const result = await softwareUpdatesCommand.execute(
    { interval: "" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--interval");
});

Deno.test("softwareUpdatesCommand - refuses a valueless --timeout flag (Issue #1270)", async () => {
  // `--timeout` at the end of the line parses to `true`, which parseInt also
  // turned into NaN.
  const { args } = parseArgs(["software-updates", "--timeout"]);
  assertEquals(args["timeout"], true);
  const result = await softwareUpdatesCommand.execute(args, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--timeout");
});

Deno.test("softwareUpdatesCommand - refuses non-positive durations (Issue #1270)", async () => {
  for (const timeout of [0, -30, 1.5]) {
    const result = await softwareUpdatesCommand.execute({ timeout }, config);
    assertEquals(result.success, false, `--timeout ${timeout} must be refused`);
    assertStringIncludes(result.message, "--timeout");
  }
  for (const interval of [0, -1]) {
    const result = await softwareUpdatesCommand.execute({ interval }, config);
    assertEquals(
      result.success,
      false,
      `--interval ${interval} must be refused`,
    );
    assertStringIncludes(result.message, "--interval");
  }
});

// ============================================================================
// Well-formed values still work, and the message states what happened
// ============================================================================

Deno.test("softwareUpdatesCommand - accepts well-formed durations and reports the outcome (Issue #1270)", async () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    // Mark the check as having just run, so the command has nothing to do.
    Deno.writeTextFileSync(
      `${tmpDir}/.last_software_update_check`,
      String(Math.floor(Date.now() / 1000)),
    );
    const result = await softwareUpdatesCommand.execute(
      { "timestamp-dir": tmpDir, interval: "3600", timeout: 60 },
      config,
    );
    assertEquals(result.success, true);
    // The final line names what the run did rather than claiming a completed
    // check regardless of outcome.
    assertStringIncludes(result.message, "no tool update attempted");
    // `Command` erases the per-command data type, so the shape is asserted
    // through a narrow cast. Inside the worker container the whole step is
    // suppressed; on a host the interval simply has not elapsed.
    const data = result.data as { outcome?: { status?: string } } | undefined;
    assertEquals(
      ["not-due", "suppressed"].includes(data?.outcome?.status ?? ""),
      true,
      `unexpected outcome status: ${data?.outcome?.status}`,
    );
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
