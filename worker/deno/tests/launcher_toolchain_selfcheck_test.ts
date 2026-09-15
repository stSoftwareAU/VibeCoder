/**
 * The launchers rebuild an image that failed its own toolchain self-check
 * (Issue #1956).
 *
 * Driven end to end: the real launcher runs under the harness with a stubbed
 * runtime whose container exits on the self-check status and prints the
 * marker naming the toolchains, and the assertions are the acceptance of
 * Issue #1956 — the host log names the toolchain, the cached tag is removed so
 * the next launch rebuilds, and a fault a rebuild did not clear is reported
 * rather than removed again for ever.
 *
 * `run.ps1` is held to the same behaviour wherever PowerShell is installed, so
 * a Windows host cannot drift into reusing an image a macOS host rebuilds.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BASH_LAUNCHER,
  type Harness,
  type LauncherInvocation,
  POWERSHELL_LAUNCHER,
  removedImages,
  runCoreLog,
  runLauncher,
  setupHarness,
} from "./fixtures/launcher_harness.ts";
import {
  TOOLCHAIN_SELFCHECK_EXIT_STATUS,
  TOOLCHAIN_SELFCHECK_FAILURE_MARKER,
} from "../lib/toolchain_selfcheck.ts";

const LAUNCHERS: LauncherInvocation[] = [
  BASH_LAUNCHER,
  ...(POWERSHELL_LAUNCHER ? [POWERSHELL_LAUNCHER] : []),
];

/** What a container that failed the self-check writes to its stderr. */
const FAILED_STDERR = [
  "[run-worker] toolchain-selfcheck: ok shellcheck 0.11.0",
  "[run-worker] toolchain-selfcheck: FAILED actionlint 1.7.12 — " +
  "`actionlint --version` exited 126: cannot execute binary file",
  `[run-worker] ${TOOLCHAIN_SELFCHECK_FAILURE_MARKER} actionlint pyyaml`,
].join("\n");

/** A harness whose container fails the self-check. */
function failingHarness(): Promise<Harness> {
  return setupHarness({
    STUB_RUN_EXIT: String(TOOLCHAIN_SELFCHECK_EXIT_STATUS),
    STUB_RUN_STDERR: FAILED_STDERR,
  }, { denoStub: true });
}

for (const launcher of LAUNCHERS) {
  Deno.test(
    `${launcher.name} - a failed toolchain self-check removes the cached image so the next launch rebuilds`,
    async () => {
      const harness = await failingHarness();
      try {
        const outcome = await runLauncher(harness, launcher);

        // The status survives the launcher: the supervisor can tell this
        // apart from a crashed worker.
        assertEquals(
          outcome.code,
          TOOLCHAIN_SELFCHECK_EXIT_STATUS,
          outcome.stderr,
        );

        // The content-derived reference is the rebuild signal, so removing it
        // is what stops the next launch reusing the image just refused.
        const removed = await removedImages(harness);
        assert(
          removed.length > 0,
          "the image that failed its self-check was left in place",
        );
        assert(
          removed.some((reference) => reference.startsWith("vibe-coder:")),
          `expected the worker image to be removed, got: ${removed.join(", ")}`,
        );

        // The host log names the toolchain, not just a status.
        const log = await runCoreLog(harness);
        assertStringIncludes(log, "toolchain-selfcheck");
        assertStringIncludes(log, "actionlint");
        assertStringIncludes(log, "pyyaml");
        assertStringIncludes(log, "no issue was claimed");
      } finally {
        await harness.cleanup();
      }
    },
  );

  Deno.test(
    `${launcher.name} - a self-check the rebuild did not fix is reported, not removed again`,
    async () => {
      const harness = await failingHarness();
      try {
        // The tag is content-derived, so a rebuild produces the same
        // reference: without this bound the launcher would remove and rebuild
        // a multi-gigabyte image on every cycle for ever.
        const first = await runLauncher(harness, launcher);
        assertEquals(
          first.code,
          TOOLCHAIN_SELFCHECK_EXIT_STATUS,
          first.stderr,
        );
        const afterFirst = (await removedImages(harness)).length;
        assert(afterFirst > 0, "the first failure must remove the image");

        const second = await runLauncher(harness, launcher);
        assertEquals(
          second.code,
          TOOLCHAIN_SELFCHECK_EXIT_STATUS,
          second.stderr,
        );
        assertEquals(
          (await removedImages(harness)).length,
          afterFirst,
          "the same reference was removed twice — the bound did not hold",
        );

        const log = await runCoreLog(harness);
        assertStringIncludes(log, "TOOLCHAIN_SELFCHECK_UNRECOVERED");
      } finally {
        await harness.cleanup();
      }
    },
  );

  Deno.test(
    `${launcher.name} - a launch that passes the self-check clears the rebuild record`,
    async () => {
      const harness = await failingHarness();
      try {
        // Fail once, so the record exists and bounds a second removal.
        await runLauncher(harness, launcher);
        const afterFirst = (await removedImages(harness)).length;
        assert(afterFirst > 0, "the first failure must remove the image");

        // The rebuild worked: this reference now gets past the self-check.
        harness.env.STUB_RUN_EXIT = "0";
        harness.env.STUB_RUN_STDERR = "";
        const healthy = await runLauncher(harness, launcher);
        assertEquals(healthy.code, 0, healthy.stderr);
        assertEquals((await removedImages(harness)).length, afterFirst);

        // A later, different fault on the same reference is acted on again
        // rather than suppressed by a record the clean run should have
        // cleared.
        harness.env.STUB_RUN_EXIT = String(TOOLCHAIN_SELFCHECK_EXIT_STATUS);
        harness.env.STUB_RUN_STDERR = FAILED_STDERR;
        const relapse = await runLauncher(harness, launcher);
        assertEquals(
          relapse.code,
          TOOLCHAIN_SELFCHECK_EXIT_STATUS,
          relapse.stderr,
        );
        assertEquals(
          (await removedImages(harness)).length,
          afterFirst + 1,
          "the clean run did not clear the rebuild record",
        );
      } finally {
        await harness.cleanup();
      }
    },
  );
}
