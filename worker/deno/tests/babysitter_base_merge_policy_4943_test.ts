/**
 * The babysitter's base-merge policy for repairs (Issue #4943): a repair
 * merges the PR's base only for a genuine conflict (GitHub reports
 * `CONFLICTING`). A behind-only PR is refreshed by the shared base-refresh
 * owner (Issue #4613), so a failed-CI or review repair must not merge it here.
 *
 * The in-memory GitHub, git and agent boundaries come from
 * tests/support/babysitter_harness.ts, shared with
 * babysitter_fix_orchestration_test.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basePr, harness } from "./support/babysitter_harness.ts";
/**
 * Silence the babysitter's console output, and hand back every stderr line
 * (console.warn) it wrote while the action ran, so the base-refresh diagnostics
 * can be asserted.
 */
async function withConsole<T>(
  action: (stateDir: string, lines: string[]) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir();
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  console.error = () => {};
  try {
    return await action(`${root}/state`, lines);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
}

const baseRefreshLines = (lines: string[]) =>
  lines.filter((line) => line.includes("[base-refresh]"));

Deno.test("a failed-CI repair on a behind-only (MERGEABLE) PR does not merge the base and still runs the agent (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "MERGEABLE" });
    h.state.changes = true;
    await h.attempt();
    assertEquals(h.state.mergeBaseCalls, []);
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.prompts.length, 1);
    assert(
      !h.state.prompts[0]!.includes("has already merged the latest"),
      "the prompt must not claim a merged base",
    );
    const skipped = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair") &&
      line.includes("outcome=base-merge-skipped")
    );
    assertEquals(skipped.length, 1, lines.join("\n"));
  });
});

Deno.test("a requested-review-changes repair on a behind-only (MERGEABLE) PR does not merge the base (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({
      mergeable: "MERGEABLE",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    await h.attempt();
    assertEquals(h.state.mergeBaseCalls, []);
    assertEquals(h.state.sessions, 1);
    assert(
      !h.state.prompts[0]!.includes("has already merged the latest"),
      "the prompt must not claim a merged base",
    );
    assertEquals(
      baseRefreshLines(lines).filter((line) =>
        line.includes("outcome=base-merge-skipped")
      ).length,
      1,
      lines.join("\n"),
    );
  });
});

Deno.test("a conflicting PR merges the base once, and a conflicted merge still reaches the agent (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "CONFLICTING" });
    h.state.mergeBaseResult = { kind: "conflicted" };
    await h.attempt();
    assertEquals(h.state.mergeBaseCalls.length, 1);
    assertEquals(h.state.mergeBaseCalls[0]!.baseRef, "main");
    assertEquals(h.state.sessions, 1);
    assertStringIncludes(
      h.state.prompts[0]!,
      "has already merged the latest main",
    );
    const allowed = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair") &&
      line.includes("outcome=base-merge-allowed")
    );
    assertEquals(allowed.length, 1, lines.join("\n"));
  });
});
