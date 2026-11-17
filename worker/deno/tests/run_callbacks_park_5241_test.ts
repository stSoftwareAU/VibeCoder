/**
 * A parked run never fires the failure callback (Issue #5241).
 *
 * A host-disk park (Issue #5077) and a quota park are deliberate waits: the
 * work is preserved for the next claim. The fleet health board reads
 * `callbacks.failure` as a failed run, so a park that fired it turned the host
 * red while it was only waiting. These tests compose the real outcome builder,
 * the real callback-context builder and the real hook runner, so a park is
 * judged on the same facts production hands the hooks.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import type { FailureCategory } from "../lib/failure_diagnosis.ts";
import { buildIssueRunCallbackContext } from "../lib/run_callback_context.ts";
import { invokeRunCallbacks } from "../lib/run_callbacks.ts";
import type { CallbacksConfig } from "../lib/run_callbacks_config.ts";
import { deriveRunOutcome } from "../lib/run_outcome.ts";

const HOOKS: CallbacksConfig = {
  success: "/hooks/success.sh",
  failure: "/hooks/failure.sh",
  always: "/hooks/always.sh",
  timeoutSeconds: 30,
};

/** The hooks a failed execute-phase run with `category` actually fires. */
async function hooksFiredFor(
  category: FailureCategory,
  reason: string,
): Promise<string[]> {
  const context = buildIssueRunCallbackContext(
    {
      repo: "stSoftwareAU/GRQ",
      issueNumber: 4460,
      result: "failure",
      startedAtEpochMs: Date.parse("2026-11-17T07:50:00.000Z"),
      finishedAtEpochMs: Date.parse("2026-11-17T07:59:50.000Z"),
      phase: "execute",
      outcome: deriveRunOutcome({
        success: false,
        category,
        phase: "execute",
        reason,
        elapsedSeconds: 590,
      }),
    },
    { runId: "vibe-5241", host: "worker-1" },
    {
      transcriptEnabled: () => false,
      buildFacts: () => ({ version: "1.0.0", commit: "abc1234" }),
    },
  );
  const fired: string[] = [];
  await invokeRunCallbacks({
    callbacks: HOOKS,
    context,
    log: () => {},
    logError: () => {},
    run: (executable) => {
      fired.push(executable);
      return Promise.resolve({
        ok: true,
        value: {
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
        },
      });
    },
    readEnv: () => undefined,
    now: () => 0,
    writeContextFile: () =>
      Promise.resolve({
        path: "/tmp/ctx.json",
        cleanup: () => Promise.resolve(),
      }),
  });
  return fired;
}

Deno.test("Issue #5241 - a host-disk park fires always but never failure or success", async () => {
  assertEquals(
    await hooksFiredFor(
      "host_disk",
      "Host disk below its floor (51.1 GB free, floor 46.0 GB + headroom 25.0 GB); agent parked",
    ),
    ["/hooks/always.sh"],
  );
});

Deno.test("Issue #5241 - a quota park fires always but never failure or success", async () => {
  assertEquals(
    await hooksFiredFor(
      "rate_limit",
      "The agent hit its usage limit; the work is preserved for the next claim.",
    ),
    ["/hooks/always.sh"],
  );
});

Deno.test("Issue #5241 - a genuine failure still fires failure then always", async () => {
  assertEquals(
    await hooksFiredFor(
      "internal_error",
      "Claude execution failed: unexpected crash",
    ),
    ["/hooks/failure.sh", "/hooks/always.sh"],
  );
});
