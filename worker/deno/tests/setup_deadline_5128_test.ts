/**
 * Tests for the setup-phase deadline (Issue #5128).
 *
 * A container on `GRQ-25` sat in setup for over two hours holding its claim
 * until the launcher's watchdog reaped it, so the run never released the
 * claim. The setup phase now runs under a deadline: a wedged step ends the run
 * with a `timeout` failure, which the run's failure path releases.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  runSetupWithDeadline,
  setSetupPhaseDeadlineForTests,
  SETUP_PHASE_DEADLINE_MS,
} from "../lib/setup_steps.ts";
import { workOnIssue } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueDeps } from "../lib/issue_worker_wiring.ts";

/** A promise that never settles — a setup step that wedged. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

Deno.test("SETUP_PHASE_DEADLINE_MS is one hour, well past every bounded setup subprocess (Issue #5128)", () => {
  assertEquals(SETUP_PHASE_DEADLINE_MS, 60 * 60 * 1000);
});

Deno.test("runSetupWithDeadline returns the setup result when setup settles first (Issue #5128)", async () => {
  setSetupPhaseDeadlineForTests(5_000);
  try {
    const result = await runSetupWithDeadline(() =>
      Promise.resolve({ status: "continue" as const })
    );
    assertEquals(result, { status: "continue" });
  } finally {
    setSetupPhaseDeadlineForTests();
  }
});

Deno.test("runSetupWithDeadline ends a wedged setup with a timeout failure (Issue #5128)", async () => {
  setSetupPhaseDeadlineForTests(20);
  try {
    const result = await runSetupWithDeadline(() =>
      never<{ status: "continue" }>()
    );
    assertEquals(result.status, "failure");
    if (result.status !== "failure") return;
    assertEquals(result.category, "timeout");
    assertStringIncludes(result.reason, "Issue #5128");
  } finally {
    setSetupPhaseDeadlineForTests();
  }
});

Deno.test("runSetupWithDeadline swallows a setup rejection that arrives after the deadline (Issue #5128)", async () => {
  setSetupPhaseDeadlineForTests(10);
  let rejectLate: (err: Error) => void = () => {};
  try {
    const result = await runSetupWithDeadline(() =>
      new Promise<{ status: "continue" }>((_, reject) => {
        rejectLate = reject;
      })
    );
    assertEquals(result.status, "failure");
    // A rejection nothing awaits would fail the test as unhandled.
    rejectLate(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    setSetupPhaseDeadlineForTests();
  }
});

Deno.test({
  name:
    "workOnIssue ends a run whose setup wedges with a setup timeout failure, so the claim is released (Issue #5128)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    setSetupPhaseDeadlineForTests(50);
    try {
      const ctx: IssueContext = {
        repo: "org/repo",
        issueNumber: 5515,
        issueTitle: "Wedged setup",
        issueBody: "The issue claim never returns.",
        issueLabels: [],
        issueComments: "",
        githubUser: "testbot",
        config: buildDefaultWorkerConfig(),
      };
      const deps = createMockDeps({
        issues: {
          claimIssue: () =>
            never<Awaited<ReturnType<IssueDeps["claimIssue"]>>>(),
        },
      });

      const result = await workOnIssue(ctx, deps);

      assertEquals(result.success, false);
      assertEquals(result.phase, "setup");
      assertEquals(result.category, "timeout");
      // A setup failure is not a refused claim, so run_core's release path
      // unassigns the issue rather than leaving it to the watchdog.
      assertEquals(
        (result as { claimNotHeld?: true }).claimNotHeld,
        undefined,
      );
    } finally {
      setSetupPhaseDeadlineForTests();
    }
  },
});
