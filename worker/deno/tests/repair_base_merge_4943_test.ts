/**
 * Unit tests for the base-merge policy and base-refresh diagnostics
 * (Issue #4943): lib/repair_base_merge_4943.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  decideRepairBaseMerge,
  formatBaseRefreshDecision,
  formatBaseRefreshStartup,
  logBaseRefreshDecision,
  parseRefreshOwner,
  readRepairBaseMergeDecision,
  type RepairMergeabilityTracker,
  trackRepairMergeability,
} from "../lib/repair_base_merge_4943.ts";
import {
  type BranchRefreshRefusalEntry,
  type BranchRefreshRefusalState,
} from "../lib/branch_refresh_refusal_streak.ts";
import { getCounters, resetCounters } from "../lib/fault_tolerance_counters.ts";

const FAKE_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

Deno.test("decideRepairBaseMerge merges only for a CONFLICTING PR", () => {
  const decision = decideRepairBaseMerge("CONFLICTING");
  assertEquals(decision.merge, true);
  assertEquals(decision.reason, "genuine conflict: GitHub reports CONFLICTING");
});

Deno.test("decideRepairBaseMerge refuses every other mergeable value with a distinct reason", () => {
  const cases: Array<[unknown, string]> = [
    ["MERGEABLE", '"MERGEABLE"'],
    ["UNKNOWN", '"UNKNOWN"'],
    [null, "null"],
    [undefined, "undefined"],
    [42, "a non-string value (number)"],
  ];
  const reasons = new Set<string>();
  for (const [value, named] of cases) {
    const decision = decideRepairBaseMerge(value);
    assertEquals(decision.merge, false, `merge for ${String(value)}`);
    assert(
      decision.reason.includes(named),
      `reason for ${String(value)} names the value: ${decision.reason}`,
    );
    assert(decision.reason.includes("not CONFLICTING"));
    reasons.add(decision.reason);
  }
  assertEquals(reasons.size, cases.length, "every refusal reason differs");
});

Deno.test("formatBaseRefreshDecision renders the exact single-line shape", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "pr-ci-processor",
      outcome: "refresh-requested",
      repo: "owner/repo",
      prNumber: 12,
      base: "main",
      reason: "ok",
    },
    "build=abc123",
  );
  assertEquals(
    line,
    '[base-refresh] source=pr-ci-processor outcome=refresh-requested repo=owner/repo pr=#12 base=main owner=none reason="ok" build=abc123',
  );
});

Deno.test("formatBaseRefreshDecision renders the owner as #N/worker, and none when absent", () => {
  const owned = formatBaseRefreshDecision(
    {
      source: "branch-update-loop",
      outcome: "refresh-skipped",
      repo: "owner/repo",
      prNumber: 7,
      base: "main",
      reason: "busy",
      ownerPr: 12,
      ownerWorker: "worker-1",
    },
    "build=abc123",
  );
  assertEquals(
    owned,
    '[base-refresh] source=branch-update-loop outcome=refresh-skipped repo=owner/repo pr=#7 base=main owner=#12/worker-1 reason="busy" build=abc123',
  );
  const unowned = formatBaseRefreshDecision(
    {
      source: "branch-update-loop",
      outcome: "refresh-skipped",
      repo: "owner/repo",
      prNumber: 7,
      reason: "busy",
    },
    "build=abc123",
  );
  assertEquals(
    unowned,
    '[base-refresh] source=branch-update-loop outcome=refresh-skipped repo=owner/repo pr=#7 base=none owner=none reason="busy" build=abc123',
  );
});

Deno.test("formatBaseRefreshDecision strips newlines and quotes from the reason", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "pr-feedback-processor",
      outcome: "base-merge-skipped",
      repo: "owner/repo",
      prNumber: 3,
      base: "main",
      reason: "line1\nline2 \"quoted\" 'single' `tick`",
    },
    "build=abc123",
  );
  assert(!line.includes("\n"), "one line only");
  assertEquals(
    line,
    '[base-refresh] source=pr-feedback-processor outcome=base-merge-skipped repo=owner/repo pr=#3 base=main owner=none reason="line1line2 quoted single tick" build=abc123',
  );
});

Deno.test("formatBaseRefreshDecision redacts a fake GitHub token in the reason", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "babysitter-repair",
      outcome: "base-merge-skipped",
      repo: "owner/repo",
      prNumber: 3,
      base: "main",
      reason: `failed with token ${FAKE_TOKEN}`,
    },
    "build=abc123",
  );
  assert(!line.includes(FAKE_TOKEN), "token must not survive");
  assert(line.includes("***REDACTED***"), "placeholder present");
});

Deno.test("formatBaseRefreshDecision caps a 10000-character reason at 200 characters", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "merge-block-repair",
      outcome: "refresh-skipped",
      repo: "owner/repo",
      prNumber: 3,
      base: "main",
      reason: "x".repeat(10_000),
    },
    "build=abc123",
  );
  const match = /reason="(x*)" build=abc123$/.exec(line);
  assert(match, "reason field present at the end of the line");
  assertEquals(match[1]!.length, 200);
  assert(line.length < 600, `bounded line length ${line.length}`);
});

Deno.test("parseRefreshOwner reads the exact shared-owner message", () => {
  assertEquals(
    parseRefreshOwner("base refresh owned by org/repo#12 (refresh-abc)"),
    { ownerPr: 12, ownerWorker: "refresh-abc" },
  );
});

Deno.test("parseRefreshOwner rejects look-alike messages", () => {
  const lookAlikes = [
    "base refresh owned by org/repo#12 (refresh-abc) and more text",
    "base refresh owned by org/repo#0 (refresh-abc)",
    "base refresh owned by org/repo#12",
    "base refresh owned by org/repo#12 ()",
    "base refresh owned by org/repo#12 (refresh-abc)\nextra",
    "something else entirely",
  ];
  for (const message of lookAlikes) {
    assertEquals(parseRefreshOwner(message), null, message);
  }
});

/**
 * A fake gh that answers only a `pr view … --json mergeable` request with
 * `reply`; any other request is an error, so a production call that asked for
 * the wrong field fails the test rather than being answered.
 */
function mergeableGh(reply: string, calls: string[][]) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    const json = args.indexOf("--json");
    const asksMergeable = args.includes("pr") && args.includes("view") &&
      json >= 0 && args[json + 1] === "mergeable";
    return asksMergeable
      ? Promise.resolve(reply)
      : Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
}

Deno.test("readRepairBaseMergeDecision merges for CONFLICTING and logs one line", async () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: mergeableGh('{"mergeable":"CONFLICTING"}', calls),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, true);
  assertEquals(calls.length, 1, "exactly one gh request");
  assertEquals(calls[0]![calls[0]!.indexOf("--json") + 1], "mergeable");
  assertEquals(lines.length, 1);
  assertMatch(
    lines[0]!,
    /^\[base-refresh\] source=pr-ci-processor outcome=base-merge-allowed repo=owner\/repo pr=#12 base=main /,
  );
});

Deno.test("readRepairBaseMergeDecision refuses a MERGEABLE PR and logs the skip", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"MERGEABLE"}'),
    source: "pr-feedback-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, false);
  assert(decision.reason.includes('"MERGEABLE"'));
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("readRepairBaseMergeDecision refuses when gh throws, naming the cause", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.reject(new Error("gateway timeout upstream")),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, false);
  assert(decision.reason.includes("mergeability unreadable"));
  assert(decision.reason.includes("gateway timeout upstream"));
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("readRepairBaseMergeDecision refuses garbled JSON and names the parse cause", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve("{not json"),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, false);
  assert(decision.reason.startsWith("mergeability unreadable: "));
  // The JSON.parse message (for example "... in JSON at position 1") is the cause.
  assertMatch(decision.reason, /JSON at position \d+/);
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("logBaseRefreshDecision never throws, even when the sink throws", () => {
  const facts = {
    source: "pr-ci-processor",
    outcome: "base-merge-skipped" as const,
    repo: "owner/repo",
    prNumber: 1,
    reason: "x",
  };
  const result = logBaseRefreshDecision(
    facts,
    () => {
      throw new Error("sink down");
    },
    "build=abc123",
  );
  assertEquals(result, undefined);
  // Logging keeps working after a throwing sink: a later call with a working
  // sink writes exactly the one expected line.
  const lines: string[] = [];
  logBaseRefreshDecision(facts, (line) => lines.push(line), "build=abc123");
  assertEquals(lines, [
    '[base-refresh] source=pr-ci-processor outcome=base-merge-skipped repo=owner/repo pr=#1 base=none owner=none reason="x" build=abc123',
  ]);
});

/** An in-memory tracker recording every comment notification it is asked for. */
function memoryTracker(): {
  tracker: RepairMergeabilityTracker;
  state: BranchRefreshRefusalState;
  notices: Array<{ active: boolean; entry: BranchRefreshRefusalEntry }>;
  saves: () => number;
} {
  const state: BranchRefreshRefusalState = new Map();
  const notices: Array<
    { active: boolean; entry: BranchRefreshRefusalEntry }
  > = [];
  let saves = 0;
  return {
    state,
    notices,
    saves: () => saves,
    tracker: {
      load: () => Promise.resolve(state),
      save: () => {
        saves++;
        return Promise.resolve();
      },
      notify: ({ active, entry }) => {
        notices.push({ active, entry: { ...entry } });
        return Promise.resolve();
      },
    },
  };
}

Deno.test("trackRepairMergeability posts one waiting notice at the second consecutive UNKNOWN read and one recovered notice after (Issue #4831)", async () => {
  const { tracker, state, notices } = memoryTracker();
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  resetCounters();

  await trackRepairMergeability(tracker, "owner/repo", 12, "UNKNOWN", log);
  assertEquals(state.get("owner/repo#12")?.streak, 1);
  assertEquals(notices, [], "no notice below the threshold");

  await trackRepairMergeability(tracker, "owner/repo", 12, "UNKNOWN", log);
  assertEquals(notices.length, 1);
  assertEquals(notices[0]!.active, true);
  assertEquals(notices[0]!.entry.streak, 2);
  assertEquals(notices[0]!.entry.reason, "mergeability-unknown");
  assertEquals(state.get("owner/repo#12")?.notified, true);
  assertEquals(lines.length, 1);
  assertMatch(
    lines[0]!,
    /^\[base-refresh\] fleet health: repair mergeability of owner\/repo#12 still UNKNOWN after 2 consecutive reads$/,
  );
  assertEquals(getCounters()["baseRefresh.repeatedMergeabilityUnknown"], 1);

  await trackRepairMergeability(tracker, "owner/repo", 12, "UNKNOWN", log);
  assertEquals(notices.length, 1, "the waiting notice is posted once");
  assertEquals(state.get("owner/repo#12")?.streak, 3);

  await trackRepairMergeability(tracker, "owner/repo", 12, "MERGEABLE", log);
  assertEquals(state.has("owner/repo#12"), false, "a known read clears it");
  assertEquals(notices.length, 2);
  assertEquals(notices[1]!.active, false);
});

Deno.test("trackRepairMergeability clears a streak silently when no notice was posted, and leaves it for an inconclusive read", async () => {
  const { tracker, state, notices, saves } = memoryTracker();
  await trackRepairMergeability(tracker, "owner/repo", 12, "UNKNOWN");
  assertEquals(saves(), 1);

  await trackRepairMergeability(tracker, "owner/repo", 12, null);
  await trackRepairMergeability(tracker, "owner/repo", 12, undefined);
  assertEquals(state.get("owner/repo#12")?.streak, 1, "inconclusive: kept");
  assertEquals(saves(), 1, "inconclusive: nothing persisted");

  await trackRepairMergeability(tracker, "owner/repo", 12, "CONFLICTING");
  assertEquals(state.has("owner/repo#12"), false);
  assertEquals(notices, [], "nothing to recover from");
  assertEquals(saves(), 2);

  await trackRepairMergeability(tracker, "owner/repo", 12, "MERGEABLE");
  assertEquals(saves(), 2, "no streak, nothing to persist");
});

Deno.test("trackRepairMergeability is a no-op without a tracker and never throws when the tracker fails", async () => {
  await trackRepairMergeability(undefined, "owner/repo", 12, "UNKNOWN");

  const lines: string[] = [];
  const failing: RepairMergeabilityTracker = {
    load: () => Promise.reject(new Error("disk full " + FAKE_TOKEN)),
    save: () => Promise.resolve(),
    notify: () => Promise.resolve(),
  };
  await trackRepairMergeability(
    failing,
    "owner/repo",
    12,
    "UNKNOWN",
    (line) => lines.push(line),
  );
  assertEquals(lines.length, 1);
  assertMatch(
    lines[0]!,
    /^\[base-refresh\] could not track mergeability of owner\/repo#12: disk full /,
  );
  assert(!lines[0]!.includes(FAKE_TOKEN), "the token is redacted");

  const { tracker, state } = memoryTracker();
  const noticeFails: RepairMergeabilityTracker = {
    ...tracker,
    notify: () => Promise.reject(new Error("comment API down")),
  };
  const noticeLines: string[] = [];
  const log = (line: string) => noticeLines.push(line);
  await trackRepairMergeability(noticeFails, "owner/repo", 12, "UNKNOWN", log);
  await trackRepairMergeability(noticeFails, "owner/repo", 12, "UNKNOWN", log);
  assertEquals(
    state.get("owner/repo#12")?.notified,
    false,
    "a failed post is retried on the next read",
  );
  assert(
    noticeLines.some((line) =>
      line.includes("could not post the refresh-waiting comment") &&
      line.includes("comment API down")
    ),
    noticeLines.join("\n"),
  );
});

Deno.test("readRepairBaseMergeDecision feeds an UNKNOWN read to the #4831 tracker and still refuses the merge", async () => {
  const { tracker, state } = memoryTracker();
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"UNKNOWN"}'),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
    tracker,
  });
  assertEquals(decision.merge, false);
  assertEquals(state.get("owner/repo#12")?.streak, 1);
  assertEquals(lines.length, 1);
});

Deno.test("logBaseRefreshDecision counts each decision by outcome and source", () => {
  resetCounters();
  const facts = {
    source: "pr-ci-processor",
    outcome: "base-merge-skipped" as const,
    repo: "owner/repo",
    prNumber: 1,
    reason: "x",
  };
  logBaseRefreshDecision(facts, () => {}, "build=abc123");
  logBaseRefreshDecision(facts, () => {}, "build=abc123");
  logBaseRefreshDecision(
    { ...facts, outcome: "refresh-requested", source: "branch-update-loop" },
    () => {},
    "build=abc123",
  );
  assertEquals(getCounters(), {
    "baseRefresh.base-merge-skipped.pr-ci-processor": 2,
    "baseRefresh.refresh-requested.branch-update-loop": 1,
  });
});

Deno.test("formatBaseRefreshStartup states the policy and the build stamp", () => {
  assertEquals(
    formatBaseRefreshStartup({ version: "1.2.3", commit: "abc123" }),
    "[base-refresh] startup repair-base-merge=conflicting-only refresh-owner=shared-per-base(#4613) transient-recovery=refusal-streak(#4831) counters=baseRefresh.<outcome>.<source> version=1.2.3 commit=abc123",
  );
});
