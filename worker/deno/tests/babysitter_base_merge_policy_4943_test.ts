/**
 * The babysitter's base-merge policy for repairs (Issue #4943): a repair
 * merges the PR's base for a genuine conflict (GitHub reports `CONFLICTING`),
 * or when the failing check it repairs already passes on the base. A behind-only
 * PR with no such check is refreshed by the shared base-refresh owner (Issue
 * #4613), so a failed-CI or review repair must not merge it here.
 *
 * The in-memory GitHub, git and agent boundaries come from
 * tests/support/babysitter_harness.ts, shared with
 * babysitter_fix_orchestration_test.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { basePr, harness } from "./support/babysitter_harness.ts";
import { BASE_REFRESH_COUNTERS_FILE } from "../lib/repair_base_merge_4943.ts";
import {
  BRANCH_REFRESH_REFUSAL_FILE,
  branchRefreshRefusalKey,
  readBranchRefreshRefusals,
} from "../lib/branch_refresh_refusal_streak.ts";
import type { BaseFailureDecision } from "../lib/babysitter_base_failure.ts";
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

/** The exact decision line: source, outcome, repo, PR and base all named. */
const SKIPPED_LINE =
  /^\[base-refresh\] source=babysitter-repair outcome=base-merge-skipped repo=owner\/repo pr=#1 base=main owner=none reason="GitHub reports mergeable MERGEABLE, not CONFLICTING/;
const ALLOWED_LINE =
  /^\[base-refresh\] source=babysitter-repair outcome=base-merge-allowed repo=owner\/repo pr=#1 base=main owner=none reason="genuine conflict: GitHub reports CONFLICTING"/;

/** The decision line of a repair whose failing check passes on the base. */
const FIXED_ON_BASE_LINE =
  /^\[base-refresh\] source=babysitter-repair outcome=base-merge-allowed repo=owner\/repo pr=#1 base=main owner=none reason="failing check Unit tests passes on the base, so the base merge brings the base fix in"/;

const baseRefreshLines = (lines: string[]) =>
  lines.filter((line) => line.includes("[base-refresh]"));

Deno.test("a failed-CI repair on a behind-only (MERGEABLE) PR does not merge the base and still runs the agent (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "MERGEABLE" });
    h.state.changes = true;
    // If the base were merged, the prompt would claim it: the prompt shows it.
    h.state.mergeBaseResult = { kind: "merged", tree: "c".repeat(40) };
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assertEquals(h.state.prompts.length, 1);
    assert(
      !h.state.prompts[0]!.includes("has already merged the latest"),
      "the prompt must not claim a merged base",
    );
    const skipped = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair")
    );
    assertEquals(skipped.length, 1, lines.join("\n"));
    assertMatch(skipped[0]!, SKIPPED_LINE);
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
    h.state.mergeBaseResult = { kind: "merged", tree: "c".repeat(40) };
    await h.attempt();
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
    assertEquals(h.state.sessions, 1);
    assertStringIncludes(
      h.state.prompts[0]!,
      "has already merged the latest main",
    );
    const allowed = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair")
    );
    assertEquals(allowed.length, 1, lines.join("\n"));
    assertMatch(allowed[0]!, ALLOWED_LINE);
  });
});

/**
 * Forget the babysitter's per-PR retry back-off between two passes, keeping the
 * #4831 refusal streak and the decision counters under test.
 */
const forgetRetryBackoff = async (stateDir: string) => {
  const keep = new Set([
    BRANCH_REFRESH_REFUSAL_FILE,
    BASE_REFRESH_COUNTERS_FILE,
  ]);
  for await (const entry of Deno.readDir(stateDir)) {
    if (!keep.has(entry.name)) {
      await Deno.remove(`${stateDir}/${entry.name}`, { recursive: true });
    }
  }
};

const readStreak = async (stateDir: string): Promise<number | undefined> => {
  const state = await readBranchRefreshRefusals(stateDir);
  return state.get(branchRefreshRefusalKey("owner/repo", 1))?.streak;
};

const readCounters = async (
  stateDir: string,
): Promise<Record<string, number>> =>
  JSON.parse(
    await Deno.readTextFile(`${stateDir}/${BASE_REFRESH_COUNTERS_FILE}`),
  ).counters;

Deno.test("an UNKNOWN mergeability read skips the base merge and counts a #4831 refusal streak that a known read clears (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "UNKNOWN" });
    h.state.mergeBaseResult = { kind: "merged", tree: "c".repeat(40) };
    await h.attempt();
    assertEquals(await readStreak(stateDir), 1);
    await forgetRetryBackoff(stateDir);
    await h.attempt();
    assertEquals(await readStreak(stateDir), 2);
    assert(
      lines.some((line) =>
        line.includes("[base-refresh] fleet health: repair mergeability") &&
        line.includes("owner/repo#1 still UNKNOWN after 2 consecutive reads")
      ),
      lines.join("\n"),
    );
    // The skipped decisions are tallied durably in the babysitter state dir.
    assertEquals(
      (await readCounters(stateDir))[
        "baseRefresh.base-merge-skipped.babysitter-repair"
      ],
      2,
    );

    h.state.pr = basePr({ mergeable: "MERGEABLE" });
    await forgetRetryBackoff(stateDir);
    await h.attempt();
    assertEquals(await readStreak(stateDir), undefined);
    assert(
      !h.state.prompts.some((prompt) => prompt.includes("has already merged")),
      "no read in this test merges the base",
    );
  });
});

Deno.test("a conflicting repair is tallied as base-merge-allowed in the babysitter state dir (Issue #4943)", async () => {
  await withConsole(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "CONFLICTING" });
    h.state.mergeBaseResult = { kind: "conflicted" };
    await h.attempt();
    assertEquals(await readCounters(stateDir), {
      "baseRefresh.base-merge-allowed.babysitter-repair": 1,
    });
  });
});

Deno.test("a failed-CI repair on a MERGEABLE PR with only a green current-base check does not merge the base (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "MERGEABLE" });
    h.state.mergeBaseResult = { kind: "merged", tree: "c".repeat(40) };
    h.deps.classifyBaseFailure = () =>
      Promise.resolve<BaseFailureDecision>({
        kind: "repair",
        reason: `the base's run of "Unit tests" is green, not red`,
        repairCheck: { name: "Unit tests", headRunId: 123 },
      });
    await h.attempt();
    assertEquals(h.state.sessions, 1);
    assert(!h.state.prompts[0]!.includes("has already merged the latest main"));
    const allowed = baseRefreshLines(lines).filter((line) =>
      line.includes("source=babysitter-repair")
    );
    assertEquals(allowed.length, 1, lines.join("\n"));
    assertMatch(allowed[0]!, /outcome=base-merge-skipped/);
    assertStringIncludes(allowed[0]!, "base fix not proven");
    assertEquals(h.state.mergeBaseCalls, []);
  });
});

Deno.test("a failed-CI repair on a MERGEABLE PR whose failing check is not green on the base does not merge the base (Issue #4943)", async () => {
  const readings: Array<Extract<BaseFailureDecision, { kind: "repair" }>> = [
    {
      kind: "repair",
      reason: `the base's log for "Unit tests" shows a different failure`,
    },
    {
      kind: "repair",
      reason: `the base's run of "Unit tests" is no-run, not red`,
    },
    {
      kind: "repair",
      reason: `the base's run of "Unit tests" is unavailable, not red`,
    },
    {
      kind: "repair",
      reason: `"Unit tests" is a dependency audit, fixed in each PR`,
    },
  ];
  for (const reading of readings) {
    await withConsole(async (stateDir, lines) => {
      const h = harness(stateDir);
      h.state.pr = basePr({ mergeable: "MERGEABLE" });
      h.state.mergeBaseResult = { kind: "merged", tree: "c".repeat(40) };
      h.deps.classifyBaseFailure = () => Promise.resolve(reading);
      await h.attempt();
      assert(
        !h.state.prompts.some((prompt) =>
          prompt.includes("has already merged")
        ),
        reading.reason,
      );
      assertEquals(h.state.sessions, 1, reading.reason);
      const skipped = baseRefreshLines(lines).filter((line) =>
        line.includes("source=babysitter-repair")
      );
      assertEquals(skipped.length, 1, lines.join("\n"));
      assertMatch(skipped[0]!, SKIPPED_LINE);
    });
  }
});
