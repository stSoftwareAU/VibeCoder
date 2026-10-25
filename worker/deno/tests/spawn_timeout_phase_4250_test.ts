/**
 * Timeout outcomes for phase and orchestration spawns (Issue #4250).
 *
 * A non-positive timeout fails before the process starts, so the test does
 * not wait on a real command. Each spawn must surface that as a failure.
 *
 * Uses Australian English throughout.
 */

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { measureDirectoryBytes } from "../lib/heavy_build_gate.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import { preflightRole } from "../lib/orchestration/preflight.ts";
import { createBumpDepsRuntimeDeps } from "../lib/phases/bump_deps_phase.ts";
import { runClaudeCli } from "../lib/review_round.ts";
import { runHistoryScanner } from "../lib/secrets_history_scan.ts";
import { probeCommandSuccess } from "../lib/untrusted_command_env.ts";

Deno.test("bump-deps script timeout is a failed script, not a pass (Issue #4250)", async () => {
  const deps = createBumpDepsRuntimeDeps({} as WorkerDeps, undefined, 0);
  const result = await deps.runScript("/tmp", "bump-deps.sh", {});
  assertNotEquals(result.exitCode, 0);
  assertStringIncludes(result.output, "timed out");
});

Deno.test("review-round claude timeout is not a successful attempt (Issue #4250)", async () => {
  const attempt = await runClaudeCli([], {}, undefined, 0);
  assertEquals(attempt.code, 124);
  assertStringIncludes(attempt.output, "timed out");
});

Deno.test("orchestration preflight timeout is not a runnable CLI (Issue #4250)", async () => {
  await assertRejects(
    () =>
      preflightRole({ provider: "claude" }, "/tmp", {
        CLAUDE_CODE_OAUTH_TOKEN: "test-token",
      }, 0),
    Error,
    "timed out",
  );
});

Deno.test("heavy-build du timeout is not an empty directory (Issue #4250)", async () => {
  await assertRejects(
    () => measureDirectoryBytes("/tmp", 0),
    Error,
    "timed out",
  );
});

Deno.test("history-scan timeout is not a clean sweep (Issue #4250)", async () => {
  await assertRejects(
    () => runHistoryScanner({ bin: "gitleaks", args: ["detect"] }, "/tmp", 0),
    Error,
    "timed out",
  );
});

Deno.test("untrusted-user probe timeout is not 'no agent account' (Issue #4250)", async () => {
  await assertRejects(
    () => probeCommandSuccess(["id", "-u", "agent"], 0),
    Error,
    "timed out",
  );
});
