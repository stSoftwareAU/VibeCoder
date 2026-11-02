import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { prCompletionReportCommand } from "../commands/pr_completion_report.ts";
import type { WorkerConfig } from "../types.ts";

Deno.test("pr-completion-report reads a snapshot and returns dated metrics", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const inputPath = `${dir}/snapshot.json`;
    await Deno.writeTextFile(
      inputPath,
      JSON.stringify({
        cohort: {
          start: "2026-10-01T00:00:00Z",
          end: "2026-11-01T00:00:00Z",
          observedAt: "2026-11-02T00:00:00Z",
        },
        prs: [],
        actions: [],
        blockers: [],
        ciRuns: [],
        regressions: [],
        deployments: [],
        expectedDeployment: {
          components: ["worker"],
          revision: "abc",
          policyFingerprint: "a".repeat(64),
          maxHeartbeatAgeHours: 2,
        },
      }),
    );
    const result = await prCompletionReportCommand.execute(
      { input: inputPath },
      {} as WorkerConfig,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, '"unattendedWithin24Hours": null');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report fails loudly for a missing input path", async () => {
  const result = await prCompletionReportCommand.execute(
    { input: "/missing" },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "pr-completion-report failed:");
  assert(result.exitCode === undefined);
});
