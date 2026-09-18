/**
 * Tests for milestone_fallback_flag.ts — the milestone half of the
 * `merge-fallback` flag (Issue #2311, part of #2298).
 *
 * What matters here is that the flag reports what the fallback actually
 * observed and never quietly reports less: both spent runs with their host and
 * timings, what each made of the conflict, what was reverted — and, when the
 * filing itself fails, an honest `undefined` with the failure said out loud.
 *
 * Every test injects the filer and `gh`. No live GitHub.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import {
  describeConflictAnalyses,
  describeFallbackAction,
  fallbackRun,
  fileFallbackFlag,
  readBehindSince,
} from "../lib/milestone_fallback_flag.ts";
import type {
  MergeFallbackFiling,
  MergeFallbackOutcome,
} from "../lib/merge_fallback_issue.ts";
import type { FileAnalysis } from "../lib/milestone_conflict_triage.ts";
import type { ConflictAttemptRecord } from "../lib/milestone_sync_streak.ts";

const REPO = "owner/repo";
const BRANCH = {
  milestoneBranch: "milestone/2298-merge-conflicts",
  defaultBranch: "main",
};

/** One escalated file, with the reason the ladder left on it. */
function analysis(path: string, reason: string): FileAnalysis {
  return {
    path,
    reason,
    oursExports: [],
    theirsExports: [],
    oursTests: [],
    theirsTests: [],
    onlyOursTests: [],
    onlyTheirsTests: [],
  };
}

/** A filer that records what it was handed and reports a filed issue. */
function recordingFiler(
  filings: MergeFallbackFiling[],
  result: Result<MergeFallbackOutcome> = {
    ok: true,
    value: { issueNumber: 4242, url: "u", appended: false },
  },
): (filing: MergeFallbackFiling) => Promise<Result<MergeFallbackOutcome>> {
  return (filing) => {
    filings.push(filing);
    return Promise.resolve(result);
  };
}

Deno.test("describeConflictAnalyses - names the undecided files and the settled ones (Issue #2311)", () => {
  const text = describeConflictAnalyses({
    analyses: [analysis("lib/a.ts", "agent: both sides rewrote the loop")],
    resolved: [{
      path: "deno.lock",
      case: "superset",
      action: "theirs",
      reason: "both sides only added",
    }],
  });
  assertStringIncludes(text, "Files no rung could settle:");
  assertStringIncludes(text, "- `lib/a.ts` — agent: both sides rewrote");
  assertStringIncludes(text, "Files the ladder did settle:");
  assertStringIncludes(text, "- `deno.lock` — both sides only added");
});

Deno.test("describeConflictAnalyses - each half stands alone, and nothing at all is empty (Issue #2311)", () => {
  const undecidedOnly = describeConflictAnalyses({
    analyses: [analysis("lib/a.ts", "agent: undecided")],
    resolved: [],
  });
  assertStringIncludes(undecidedOnly, "Files no rung could settle:");
  assert(
    !undecidedOnly.includes("did settle"),
    "a heading with nothing under it says nothing",
  );

  const settledOnly = describeConflictAnalyses({
    analyses: [],
    resolved: [{
      path: "deno.lock",
      case: "superset",
      action: "theirs",
      reason: "both sides only added",
    }],
  });
  assertStringIncludes(settledOnly, "Files the ladder did settle:");
  assert(!settledOnly.startsWith("\n"), "no leading blank from an empty half");

  // An error naming no file at all renders as nothing, not as bare headings.
  assertEquals(describeConflictAnalyses({ analyses: [], resolved: [] }), "");
});

Deno.test("fallbackRun - carries the conclusion, the host, the timings and the account (Issue #2311)", () => {
  const record: ConflictAttemptRecord = {
    at: "2026-09-18T01:00:00.000Z",
    outcome: "failed",
    reason: "conflict unresolved at rung agent",
    host: "mel-01",
    analysis: "- `lib/a.ts` — agent: undecided",
    timings: "Timings (host `mel-01`): deepen 3s · agent unfinished",
  };
  const run = fallbackRun(record, 2);
  assertEquals(run.run, 2);
  assertEquals(run.host, "mel-01");
  assertEquals(run.timings, [
    { stage: "deepen", seconds: 3 },
    { stage: "agent", seconds: null },
  ]);
  assertStringIncludes(run.analysis ?? "", "Concluded `failed`");
  assertStringIncludes(run.analysis ?? "", "conflict unresolved at rung agent");
  assertStringIncludes(run.analysis ?? "", "- `lib/a.ts` — agent: undecided");
});

Deno.test("fallbackRun - a record with nothing recorded still names its conclusion (Issue #2311)", () => {
  const run = fallbackRun({
    at: "2026-09-18T01:00:00.000Z",
    outcome: "failed",
    reason: "conflict unresolved at rung rules",
  }, 1);
  assertEquals(run.host, undefined);
  assertEquals(run.timings, undefined);
  assertStringIncludes(run.analysis ?? "", "rung rules");
});

Deno.test("describeFallbackAction - tells a revert from a roll-back that could not merge (Issue #2311)", () => {
  const merged = describeFallbackAction({
    merged: true,
    reverted: [{
      prNumber: 12,
      sha: "abc1234",
      headRefName: "issue-45-child",
      title: "Child",
    }],
  }, "main");
  assertStringIncludes(merged, "PR #12");
  assertStringIncludes(merged, "revert `abc1234`");

  const stuck = describeFallbackAction({
    merged: false,
    reverted: [],
    reason: "nothing left to revert",
  }, "main");
  assertStringIncludes(stuck, "could not make `main` merge cleanly");
  assertStringIncludes(stuck, "nothing left to revert");
});

Deno.test("fileFallbackFlag - hands the filer every field the fallback observed (Issue #2311)", async () => {
  const filings: MergeFallbackFiling[] = [];
  const events: string[] = [];
  const issue = await fileFallbackFlag({
    repo: REPO,
    branch: BRANCH,
    runs: [
      {
        at: "2026-09-18T01:00:00.000Z",
        outcome: "failed",
        reason: "rung agent",
        host: "mel-01",
      },
      {
        at: "2026-09-18T02:00:00.000Z",
        outcome: "failed",
        reason: "rung agent",
        host: "syd-02",
      },
    ],
    outcome: {
      merged: true,
      reverted: [{
        prNumber: 12,
        sha: "abc1234",
        headRefName: "issue-45-child",
        title: "Child",
      }],
    },
    fallback: {
      conflictedFiles: ["lib/a.ts"],
      behindBy: 9,
      behindSince: "2026-09-17T00:00:00Z",
    },
    fileMergeFallbackFn: recordingFiler(filings),
    log: () => undefined,
    emitSelfHealEvent: (event) => {
      events.push(`${event.action}:${event.reason}`);
      return Promise.resolve(true);
    },
  });

  assertEquals(issue, 4242);
  assertEquals(filings.length, 1, "one fallback, one filing");
  const filing = filings[0]!;
  assertEquals(filing.target, {
    kind: "milestone",
    repo: REPO,
    milestoneBranch: BRANCH.milestoneBranch,
    defaultBranch: BRANCH.defaultBranch,
  });
  assertEquals(filing.conflictedFiles, ["lib/a.ts"]);
  assertEquals(filing.behindBy, 9);
  assertEquals(filing.behindSince, "2026-09-17T00:00:00Z");
  assertEquals(filing.runs?.length, 2, "both spent runs are reported");
  assertEquals(filing.runs?.[0]?.host, "mel-01");
  assertEquals(filing.runs?.[1]?.run, 2);
  assertStringIncludes(filing.fallbackAction ?? "", "PR #12");
  assert(
    events.some((e) => e.startsWith("fallback_flagged:") && e.includes("4242")),
    `no fallback_flagged event: ${JSON.stringify(events)}`,
  );
});

Deno.test("fileFallbackFlag - a filing that failed is said out loud and reported as unfiled (Issue #2311)", async () => {
  const logs: string[] = [];
  const events: string[] = [];
  const issue = await fileFallbackFlag({
    repo: REPO,
    branch: BRANCH,
    runs: [],
    outcome: { merged: false, reverted: [], reason: "nothing to revert" },
    fallback: {},
    fileMergeFallbackFn: () =>
      Promise.resolve({ ok: false, error: new Error("gh issue create: 403") }),
    log: (m) => logs.push(m),
    emitSelfHealEvent: (event) => {
      events.push(event.action);
      return Promise.resolve(true);
    },
  });

  assertEquals(
    issue,
    undefined,
    "nothing may link to a flag that is not there",
  );
  assert(
    logs.some((l) =>
      l.startsWith("WARNING:") && l.includes("gh issue create: 403")
    ),
    `the failure was swallowed: ${JSON.stringify(logs)}`,
  );
  assertEquals(events, [], "an unfiled flag is not reported as flagged");
});

Deno.test("fileFallbackFlag - an unreadable issue number reports as unfiled (Issue #2311)", async () => {
  const issue = await fileFallbackFlag({
    repo: REPO,
    branch: BRANCH,
    runs: [],
    outcome: { merged: true, reverted: [] },
    fallback: {},
    fileMergeFallbackFn: () =>
      Promise.resolve({
        ok: true,
        value: { issueNumber: 0, url: "", appended: false },
      }),
    log: () => undefined,
  });
  assertEquals(issue, undefined, "issue #0 is not a link a reader can follow");
});

Deno.test("readBehindSince - reads the first missing commit's date (Issue #2311)", async () => {
  const calls: string[][] = [];
  const since = await readBehindSince(
    REPO,
    "aaaaaaa",
    "main",
    (args) => {
      calls.push(args);
      return Promise.resolve("2026-09-17T04:05:06Z\n");
    },
    () => undefined,
  );
  assertEquals(since, { behindSince: "2026-09-17T04:05:06Z" });
  assertStringIncludes(calls[0]!.join(" "), "compare/aaaaaaa...main");
});

Deno.test("readBehindSince - an unknown tip, an empty answer and a failed compare record nothing (Issue #2311)", async () => {
  const logs: string[] = [];
  assertEquals(
    await readBehindSince(REPO, undefined, "main", () => {
      throw new Error("gh must not be called without a tip");
    }, () => undefined),
    {},
  );
  assertEquals(
    await readBehindSince(
      REPO,
      "aaaaaaa",
      "main",
      () => Promise.resolve("null\n"),
      () => undefined,
    ),
    {},
  );
  assertEquals(
    await readBehindSince(
      REPO,
      "aaaaaaa",
      "main",
      () => Promise.reject(new Error("compare: 404")),
      (m) => logs.push(m),
    ),
    {},
  );
  assert(
    logs.some((l) => l.startsWith("WARNING:") && l.includes("compare: 404")),
    `the failed compare was swallowed: ${JSON.stringify(logs)}`,
  );
});
