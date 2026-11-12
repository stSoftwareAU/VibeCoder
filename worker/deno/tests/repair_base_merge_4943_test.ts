/**
 * Unit tests for the base-merge policy and base-refresh diagnostics
 * (Issue #4943): lib/repair_base_merge_4943.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  BASE_REFRESH_COUNTERS_FILE,
  baseRefreshCounterName,
  createRepairMergeabilityTracker,
  decideRepairBaseMerge,
  formatBaseRefreshDecision,
  formatBaseRefreshStartup,
  formatStartupBuildLines,
  logBaseRefreshDecision,
  parseRefreshOwner,
  persistBaseRefreshCounter,
  readRepairBaseMergeDecision,
  trackRepairMergeability,
} from "../lib/repair_base_merge_4943.ts";
import {
  BRANCH_REFRESH_REFUSAL_FILE,
  notifyBranchRefreshRefusal,
  readBranchRefreshRefusals,
  updateBranchRefreshRefusals,
} from "../lib/branch_refresh_refusal_streak.ts";
import { getCounters, resetCounters } from "../lib/fault_tolerance_counters.ts";
import {
  sweepAutoMerge,
  type SweepAutoMergeOptions,
} from "../lib/auto_merge_sweep.ts";
import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import {
  AUTHOR,
  BASE,
  BASE_SHA,
  FakeFleet,
  headOf,
  movedHeadOf,
  readyPr,
  REPO,
} from "./support/base_refresh_fleet.ts";

import { createRendezvous } from "./support/rendezvous.ts";

const FAKE_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

Deno.test("decideRepairBaseMerge merges for a CONFLICTING PR", () => {
  const decision = decideRepairBaseMerge("CONFLICTING");
  assertEquals(decision.merge, true);
  assertEquals(decision.reason, "genuine conflict: GitHub reports CONFLICTING");
});

Deno.test("decideRepairBaseMerge merges a MERGEABLE PR when a matching historical failure is fixed on a newer base (Issue #4943)", () => {
  const decision = decideRepairBaseMerge("MERGEABLE", ["Unit tests"]);
  assertEquals(decision.merge, true);
  assertEquals(
    decision.reason,
    'check "Unit tests" has the same failure on the PR merge base and passes on the newer base; merging brings in that fix',
  );
});

Deno.test("decideRepairBaseMerge merges an UNKNOWN PR with a proven base fix, cleaning and capping the names (Issue #4943)", () => {
  const decision = decideRepairBaseMerge("UNKNOWN", [
    'Lint "x"\n',
    "A".repeat(300),
  ]);
  assertEquals(decision.merge, true);
  assertEquals(
    decision.reason,
    `check "Lint x, ${
      "A".repeat(72)
    }" has the same failure on the PR merge base and passes on the newer base; merging brings in that fix`,
  );
});

Deno.test("decideRepairBaseMerge keeps the conflict reason when a base fix is also proven (Issue #4943)", () => {
  const decision = decideRepairBaseMerge("CONFLICTING", ["Unit tests"]);
  assertEquals(decision.merge, true);
  assertEquals(decision.reason, "genuine conflict: GitHub reports CONFLICTING");
});

Deno.test("decideRepairBaseMerge refuses a non-conflicting PR without a proven base fix (Issue #4943)", () => {
  for (const provenBaseFixChecks of [undefined, []] as const) {
    const decision = decideRepairBaseMerge("MERGEABLE", provenBaseFixChecks);
    assertEquals(decision.merge, false);
    assert(decision.reason.includes('"MERGEABLE"'), decision.reason);
    assert(decision.reason.includes("not CONFLICTING"), decision.reason);
  }
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

Deno.test("base-refresh diagnostics redact every field before truncation", () => {
  const source = `lane-${FAKE_TOKEN}`;
  const facts = {
    source,
    outcome: "base-merge-skipped" as const,
    repo: `owner/${FAKE_TOKEN}`,
    prNumber: 3,
    base: "b".repeat(70) + FAKE_TOKEN,
    ownerPr: 4,
    ownerWorker: `worker-${FAKE_TOKEN}`,
    reason: "waiting",
  };
  const lines: string[] = [];
  logBaseRefreshDecision(
    facts,
    (line) => lines.push(line),
    `build=${FAKE_TOKEN}`,
  );
  assertEquals(lines, [
    "[base-refresh] source=lane-***REDACTED*** outcome=base-merge-skipped repo=owner/***REDACTED*** pr=#3 base=" +
    "b".repeat(70) +
    '***REDACTE owner=#4/worker-***REDACTED*** reason="waiting" build=***REDACTED***',
  ]);

  const original = console.error;
  const fallback: string[] = [];
  console.error = (line: string) => fallback.push(line);
  try {
    logBaseRefreshDecision(facts, () => {
      throw new Error("sink unavailable");
    }, "build=abc123");
  } finally {
    console.error = original;
  }
  assertEquals(fallback, [
    "[base-refresh] could not record the decision source=lane-***REDACTED*** repo=owner/***REDACTED*** pr=#3 outcome=base-merge-skipped: sink unavailable",
  ]);
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
function mergeableGh(reply: string) {
  return (args: string[]): Promise<string> => {
    const json = args.indexOf("--json");
    const asksMergeable = args.includes("pr") && args.includes("view") &&
      json >= 0 && args[json + 1] === "mergeable";
    return asksMergeable
      ? Promise.resolve(reply)
      : Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
}

Deno.test("readRepairBaseMergeDecision merges for CONFLICTING and logs one line", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: mergeableGh('{"mergeable":"CONFLICTING"}'),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, true);
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

Deno.test("logBaseRefreshDecision never throws, and a throwing sink leaves one redacted fallback line on stderr", () => {
  const facts = {
    source: "pr-ci-processor",
    outcome: "base-merge-skipped" as const,
    repo: "owner/repo",
    prNumber: 1,
    reason: "x",
  };
  const original = console.error;
  const fallback: string[] = [];
  console.error = (...parts: unknown[]) => {
    fallback.push(parts.map(String).join(" "));
  };
  let result: unknown = "unset";
  try {
    result = logBaseRefreshDecision(
      facts,
      () => {
        throw new Error(`sink down with ${FAKE_TOKEN}`);
      },
      "build=abc123",
    );
  } finally {
    console.error = original;
  }
  assertEquals(result, undefined);
  assertEquals(fallback.length, 1, fallback.join("\n"));
  assert(
    fallback[0]!.startsWith(
      "[base-refresh] could not record the decision source=pr-ci-processor repo=owner/repo pr=#1 outcome=base-merge-skipped: sink down with ",
    ),
    fallback[0],
  );
  assert(!fallback[0]!.includes(FAKE_TOKEN), "the token is redacted");
  // Logging keeps working after a throwing sink: a later call with a working
  // sink writes exactly the one expected line.
  const lines: string[] = [];
  logBaseRefreshDecision(facts, (line) => lines.push(line), "build=abc123");
  assertEquals(lines, [
    '[base-refresh] source=pr-ci-processor outcome=base-merge-skipped repo=owner/repo pr=#1 base=none owner=none reason="x" build=abc123',
  ]);
});

/** Stateful GitHub boundary: comments survive fresh tracker instances. */
function commentService() {
  const comments: Array<{ id: number; body: string; author: string }> = [];
  let unavailable = false;
  const gh = async (args: string[]): Promise<string> => {
    if (unavailable) throw new Error("comment API down");
    if (args[0] === "api" && args[1]?.includes("/comments?")) {
      return JSON.stringify(comments);
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const id = comments.length + 1;
      comments.push({
        id,
        body: args[args.indexOf("--body") + 1]!,
        author: "VibeCoderST",
      });
      return `https://github.com/owner/repo/pull/${args[2]}#issuecomment-${id}`;
    }
    if (args[0] === "api" && args.includes("PATCH")) {
      const id = Number(
        args.find((value) => /comments\/\d+$/.test(value))!.split("/").at(-1),
      );
      const comment = comments.find((value) => value.id === id);
      if (!comment) throw new Error(`comment ${id} does not exist`);
      comment.body = args.find((value) => value.startsWith("body="))!.slice(5);
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return {
    comments,
    gh,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

Deno.test("repair notifications redact repository identifiers in every diagnostic", async () => {
  const dir = await Deno.makeTempDir();
  const service = commentService();
  const repo = `owner/${FAKE_TOKEN}`;
  const tracker = createRepairMergeabilityTracker({
    workDir: dir,
    gh: service.gh,
    fleetAuthors: ["VibeCoderST"],
  })!;
  const lines: string[] = [];
  const read = (mergeable: string) =>
    trackRepairMergeability(
      tracker,
      repo,
      12,
      mergeable,
      (line) => lines.push(line),
    );
  try {
    service.setUnavailable(true);
    await read("UNKNOWN");
    await read("UNKNOWN");
    service.setUnavailable(false);
    await read("UNKNOWN");
    assertEquals(service.comments.length, 1);
    service.setUnavailable(true);
    await read("MERGEABLE");
    assertEquals((await readBranchRefreshRefusals(dir)).size, 0);
    assertEquals(lines, [
      "[base-refresh] fleet health: repair mergeability of owner/***REDACTED***#12 still UNKNOWN after 2 consecutive reads",
      "[base-refresh] could not post the refresh-waiting comment on owner/***REDACTED***#12: comment API down",
      "[base-refresh] fleet health: repair mergeability of owner/***REDACTED***#12 still UNKNOWN after 3 consecutive reads",
      "[base-refresh] could not update the refresh-waiting comment on owner/***REDACTED***#12: comment API down",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("production repair trackers persist concurrent PR streaks and deliver one comment per PR across restarts", async () => {
  const dir = await Deno.makeTempDir();
  const service = commentService();
  const tracker = () =>
    createRepairMergeabilityTracker({
      workDir: dir,
      gh: service.gh,
      fleetAuthors: ["VibeCoderST"],
    })!;
  const read = () => readBranchRefreshRefusals(dir);
  try {
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        [12, 13, 14, 15].map((pr) =>
          trackRepairMergeability(
            tracker(),
            "owner/repo",
            pr,
            "UNKNOWN",
            () => {},
          )
        ),
      );
      const state = await read();
      assertEquals(
        [...state.keys()].sort(),
        [12, 13, 14, 15].map((pr) => `owner/repo#${pr}`),
      );
      for (const entry of state.values()) {
        assertEquals(entry.streak, round + 1);
        assertEquals(entry.notified, round >= 1);
      }
      assertEquals(service.comments.length, round === 0 ? 0 : 4);
    }
    for (const comment of service.comments) {
      assertMatch(comment.body, /Repair is waiting on mergeability/);
    }
    await Promise.all(
      [12, 13, 14, 15].map((pr) =>
        trackRepairMergeability(
          tracker(),
          "owner/repo",
          pr,
          "MERGEABLE",
          () => {},
        )
      ),
    );
    assertEquals((await read()).size, 0);
    assertEquals(service.comments.length, 4);
    for (const comment of service.comments) {
      assertMatch(comment.body, /Repair mergeability recovered/);
    }
    await Promise.all(
      Array.from({ length: 6 }, () =>
        trackRepairMergeability(
          tracker(),
          "owner/repo",
          14,
          "UNKNOWN",
          () => {},
        )),
    );
    assertEquals((await read()).get("owner/repo#14")?.streak, 6);
    assertEquals(
      service.comments.length,
      4,
      "simultaneous reads update the existing comment without duplicates",
    );
    assertEquals(
      service.comments.filter((comment) =>
        comment.body.includes("Repair is waiting")
      ).length,
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a repair tracker posts its comments with the refusal lock released and records notified afterwards (PR #5059 review)", async () => {
  const dir = await Deno.makeTempDir();
  const service = commentService();
  const lockPath = `${dir}/${BRANCH_REFRESH_REFUSAL_FILE}.lock`;
  const lockHeld: boolean[] = [];
  const gh = async (args: string[]) => {
    if (args[0] === "pr" && args[1] === "comment") {
      lockHeld.push(await Deno.stat(lockPath).then(() => true, () => false));
    }
    return service.gh(args);
  };
  const tracker = () =>
    createRepairMergeabilityTracker({
      workDir: dir,
      gh,
      fleetAuthors: ["VibeCoderST"],
    })!;
  try {
    for (let round = 0; round < 3; round++) {
      await trackRepairMergeability(
        tracker(),
        "owner/repo",
        9,
        "UNKNOWN",
        () => {},
      );
    }
    assertEquals(lockHeld, [false], "one waiting comment, posted lock-free");
    assertEquals(
      (await readBranchRefreshRefusals(dir)).get("owner/repo#9")?.notified,
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweep and repair lanes retain stale-parent escalation until the real parent validation succeeds", async () => {
  const dir = await Deno.makeTempDir();
  const service = commentService();
  const fleet = new FakeFleet([readyPr(10)]);
  let stale = true;
  const parentsEntered = createRendezvous(2);
  const parentsReleased = createRendezvous(2);
  let pauseParents = true;
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "comment" || args.includes("PATCH")) {
      return service.gh(args);
    }
    if (args[1]?.includes("/comments?")) {
      return JSON.stringify([...fleet.comments, ...service.comments]);
    }
    if (stale && args[1]?.includes("/git/commits/")) {
      if (pauseParents) {
        pauseParents = false;
        assertEquals(await parentsEntered.arrive(), 2);
        assertEquals(await parentsReleased.arrive(), 2);
      }
      return JSON.stringify({
        parents: [{ sha: "0".repeat(40) }, {
          sha: fleet.prs.get(10)!.headRefOid,
        }],
      });
    }
    return fleet.gh(args);
  };
  const tracker = createRepairMergeabilityTracker({
    workDir: dir,
    gh,
    fleetAuthors: [AUTHOR],
  })!;
  const options: SweepAutoMergeOptions = {
    repos: [REPO],
    isRepoAllowed: () => true,
    fleetAuthors: [AUTHOR],
    listOpenPrs: async () => [{ number: 10, baseRefName: BASE }, {
      number: 12,
      baseRefName: BASE,
    }],
    prLiveState: async (_repo, pr) =>
      pr.number === 12
        ? { unknown: true, error: "transient API read" }
        : { open: true, armed: true, behind: true, mergeable: "MERGEABLE" },
    updateBranchFn: (repo, pr, base) =>
      requestReadyBranchUpdate(repo, pr, gh, base, undefined, async () => {}, {
        fleetAuthors: [AUTHOR],
      }, "auto-merge-sweep"),
    branchRefreshRefusals: {
      update: (change) => updateBranchRefreshRefusals(dir, change),
      notify: (event) =>
        notifyBranchRefreshRefusal(event, gh, (author) => author === AUTHOR),
    },
    isMergeQueueBase: async () => false,
    checkBaseIntegrity: async () => ({ action: "proceed", disarmed: false }),
    attemptMerge: async () => ({
      result: AutoMergeResult.Failed,
      message: "not ready",
    }),
    recordOutcome: () => {},
    invalidateOpenPrCache: async () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const run = async () => {
    const result = await sweepAutoMerge(options);
    assert(result.ok);
  };
  try {
    const sweep = run();
    assertEquals(await parentsEntered.arrive(), 2);
    await trackRepairMergeability(tracker, REPO, 12, "UNKNOWN", () => {});
    assertEquals(await parentsReleased.arrive(), 2);
    await sweep;
    assertEquals(
      (await readBranchRefreshRefusals(dir)).get(`${REPO}#12`)?.streak,
      1,
      "the concurrent repair survives the sweep's publication",
    );
    await run();
    let escalated = await readBranchRefreshRefusals(dir);
    assertEquals(
      escalated.get(`${REPO}#10`)?.reason,
      "test-merge-parents-stale",
    );
    assertEquals(escalated.get(`${REPO}#10`)?.streak, 2);
    assertEquals(escalated.get(`${REPO}#10`)?.notified, true);
    assertEquals(service.comments.length, 1);
    assertMatch(service.comments[0]!.body, /parents still lag/);
    for (
      const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN", "MERGEABLE"]
    ) {
      await readRepairBaseMergeDecision({
        repo: REPO,
        prNumber: 10,
        gh: async () => JSON.stringify({ mergeable }),
        source: "pr-ci-processor",
        tracker,
        log: () => {},
      });
      const after = await readBranchRefreshRefusals(dir);
      const entry = after.get(`${REPO}#10`);
      // No mergeability read clears or re-labels the stale-parent refusal, and
      // none posts a second comment; an UNKNOWN read still counts towards the
      // streak, so the #4831 count is not frozen (PR #5059 review).
      assertEquals(entry?.reason, "test-merge-parents-stale");
      assertEquals(entry?.notified, true);
      assertEquals(
        entry?.streak,
        escalated.get(`${REPO}#10`)!.streak + (mergeable === "UNKNOWN" ? 1 : 0),
      );
      assertEquals(after.get(`${REPO}#12`), escalated.get(`${REPO}#12`));
      assertEquals(service.comments.length, 1);
      assert(!service.comments[0]!.body.includes("recovered"));
      escalated = after;
    }
    fleet.prs.get(10)!.reviewDecision = "REVIEW_REQUIRED";
    await run();
    // A pass that skips the PR ends the consecutive-refusal streak, as on main,
    // and corrects the waiting comment (PR #5059 review).
    assertEquals(
      (await readBranchRefreshRefusals(dir)).has(`${REPO}#10`),
      false,
      "a skipped pass ends the stale-parent streak",
    );
    assertMatch(service.comments[0]!.body, /Branch refresh recovered/);
    fleet.prs.get(10)!.reviewDecision = "APPROVED";
    stale = false;
    await run();
    assertEquals(fleet.prs.get(10)!.headRefOid, movedHeadOf(10));
    assertEquals(fleet.parents.get(movedHeadOf(10)), [headOf(10), BASE_SHA]);
    assertEquals(
      (await readBranchRefreshRefusals(dir)).has(`${REPO}#10`),
      false,
    );
    assertEquals(
      (await readBranchRefreshRefusals(dir)).get(`${REPO}#12`)?.streak,
      1,
    );
    assertEquals(service.comments.length, 1);
    assertMatch(service.comments[0]!.body, /Branch refresh recovered/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("production repair tracker preserves inconclusive reads, clears unnotified known reads, and retries failed comment delivery", async () => {
  const dir = await Deno.makeTempDir();
  const service = commentService();
  const tracker = createRepairMergeabilityTracker({
    workDir: dir,
    gh: service.gh,
    fleetAuthors: ["VibeCoderST"],
  })!;
  const lines: string[] = [];
  const run = (value: unknown) =>
    trackRepairMergeability(
      tracker,
      "owner/repo",
      12,
      value,
      (line) => lines.push(line),
    );
  try {
    await run("UNKNOWN");
    await run(null);
    await run(undefined);
    assertEquals(
      (await readBranchRefreshRefusals(dir)).get("owner/repo#12")?.streak,
      1,
    );
    await run("CONFLICTING");
    assertEquals((await readBranchRefreshRefusals(dir)).size, 0);
    assertEquals(service.comments, []);
    service.setUnavailable(true);
    await run("UNKNOWN");
    await run("UNKNOWN");
    assertEquals(
      (await readBranchRefreshRefusals(dir)).get("owner/repo#12")?.notified,
      false,
    );
    assert(lines.some((line) => line.includes("comment API down")));
    service.setUnavailable(false);
    await run("UNKNOWN");
    assertEquals(
      (await readBranchRefreshRefusals(dir)).get("owner/repo#12")?.notified,
      true,
    );
    assertEquals(service.comments.length, 1);
    assertMatch(service.comments[0]!.body, /3 consecutive passes/);
    await run("MERGEABLE");
    assertEquals((await readBranchRefreshRefusals(dir)).size, 0);
    assertMatch(service.comments[0]!.body, /Repair mergeability recovered/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repair tracking failure is redacted and does not change the base-merge decision", async () => {
  await trackRepairMergeability(undefined, "owner/repo", 12, "UNKNOWN");
  const dir = await Deno.makeTempDir();
  const file = `${dir}/${FAKE_TOKEN}`;
  await Deno.writeTextFile(file, "not a directory");
  const tracker = createRepairMergeabilityTracker({
    workDir: file,
    gh: async () => "",
    fleetAuthors: [],
  })!;
  const lines: string[] = [];
  try {
    const decision = await readRepairBaseMergeDecision({
      repo: `owner/${FAKE_TOKEN}`,
      prNumber: 12,
      gh: async () => '{"mergeable":"UNKNOWN"}',
      source: "pr-ci-processor",
      tracker,
      log: (line) => lines.push(line),
    });
    assertEquals(decision.merge, false);
    assert(lines.some((line) => line.includes("could not")));
    for (const line of lines) assert(!line.includes(FAKE_TOKEN), line);
    assertEquals(await Deno.readTextFile(file), "not a directory");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readRepairBaseMergeDecision merges a MERGEABLE PR when the probe returns a proven base fix, and logs the reason (Issue #4943)", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"MERGEABLE"}'),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
    provenBaseFixChecks: () => Promise.resolve(["test"]),
  });
  assertEquals(decision.merge, true);
  assertEquals(lines.length, 1);
  assertMatch(
    lines[0]!,
    /^\[base-refresh\] source=pr-ci-processor outcome=base-merge-allowed repo=owner\/repo pr=#12 base=main owner=none reason="check test has the same failure on the PR merge base and passes on the newer base; merging brings in that fix" /,
  );
});

Deno.test("readRepairBaseMergeDecision keeps the conflict reason when the probe returns a proven base fix (Issue #4943)", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"CONFLICTING"}'),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
    provenBaseFixChecks: () => Promise.resolve(["test"]),
  });
  assertEquals(decision.merge, true);
  assertEquals(
    decision.reason,
    "genuine conflict: GitHub reports CONFLICTING",
  );
  assertMatch(lines[0]!, /outcome=base-merge-allowed /);
});

Deno.test("readRepairBaseMergeDecision refuses a MERGEABLE PR when the probe names no check, as before (Issue #4943)", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"MERGEABLE"}'),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
    provenBaseFixChecks: () => Promise.resolve([]),
  });
  assertEquals(decision.merge, false);
  assert(!decision.reason.includes("base-fix check unreadable"));
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("readRepairBaseMergeDecision treats a throwing probe as no check, redacts its cause and appends it to the skip reason (Issue #4943)", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"MERGEABLE"}'),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
    provenBaseFixChecks: () =>
      Promise.reject(new Error(`base read failed with token ${FAKE_TOKEN}`)),
  });
  assertEquals(decision.merge, false);
  assert(
    decision.reason.startsWith("GitHub reports mergeable"),
    decision.reason,
  );
  assert(
    decision.reason.includes("base-fix check unreadable: base read failed"),
    decision.reason,
  );
  assert(!decision.reason.includes(FAKE_TOKEN), "the token is redacted");
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
  assert(lines[0]!.includes("***REDACTED***"), lines[0]);
  assert(!lines[0]!.includes(FAKE_TOKEN), "the token is redacted in the log");
});

Deno.test("readRepairBaseMergeDecision persists the repeated-UNKNOWN counter beside its decision counters, once the threshold is reached (Issue #4943)", async () => {
  const dir = await Deno.makeTempDir();
  const service = commentService();
  const tracker = createRepairMergeabilityTracker({
    workDir: dir,
    gh: service.gh,
    fleetAuthors: ["VibeCoderST"],
  })!;
  const readTally = async () =>
    JSON.parse(await Deno.readTextFile(`${dir}/${BASE_REFRESH_COUNTERS_FILE}`))
      .counters;
  const run = () =>
    readRepairBaseMergeDecision({
      repo: "owner/repo",
      prNumber: 12,
      gh: () => Promise.resolve('{"mergeable":"UNKNOWN"}'),
      source: "pr-ci-processor",
      base: "main",
      log: () => {},
      tracker,
      counterDir: dir,
    });
  try {
    resetCounters();
    await run();
    assertEquals(await readTally(), {
      "baseRefresh.base-merge-skipped.pr-ci-processor": 1,
    }, "below the threshold the repeated counter is not set");
    await run();
    assertEquals(await readTally(), {
      "baseRefresh.base-merge-skipped.pr-ci-processor": 2,
      "baseRefresh.repeatedMergeabilityUnknown": 1,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
    "[base-refresh] startup repair-base-merge=conflict-or-base-fixed refresh-owner=shared-per-base(#4613) transient-recovery=refusal-streak(#4831) counters=baseRefresh.<outcome>.<source> version=1.2.3 commit=abc123",
  );
});

Deno.test("formatStartupBuildLines prints the build banner then the base-refresh policy from one stamp", () => {
  const info = { version: "1.2.3", commit: "abc123" };
  assertEquals(formatStartupBuildLines(info), [
    "[worker-build] version=1.2.3 commit=abc123",
    formatBaseRefreshStartup(info),
  ]);
});

/** Run `fn` with console.warn captured; resolves to the lines it printed. */
async function captureWarns(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

Deno.test("counter warnings redact directory names and malformed counter keys", async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/${FAKE_TOKEN}`;
  try {
    await Deno.mkdir(dir);
    await Deno.writeTextFile(
      `${dir}/${BASE_REFRESH_COUNTERS_FILE}`,
      JSON.stringify({
        counters: { [FAKE_TOKEN]: "invalid" },
      }),
    );
    const warnings = await captureWarns(() =>
      persistBaseRefreshCounter(dir, {
        source: "pr-ci",
        outcome: "base-merge-skipped",
      })
    );
    assertEquals(warnings, [
      `[base-refresh] could not read the counters in ${root}/***REDACTED***/${BASE_REFRESH_COUNTERS_FILE}; the tally restarts: the "counters" entry "***REDACTED***" is not a finite number`,
    ]);
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${dir}/${BASE_REFRESH_COUNTERS_FILE}`),
      ).counters,
      {
        "baseRefresh.base-merge-skipped.pr-ci": 1,
      },
    );

    const file = `${root}/blocked-${FAKE_TOKEN}`;
    await Deno.writeTextFile(file, "sentinel");
    const failed = await captureWarns(() =>
      persistBaseRefreshCounter(file, {
        source: `lane-${FAKE_TOKEN}`,
        outcome: "base-merge-skipped",
      })
    );
    assertEquals(failed.length, 1);
    assertEquals(failed[0]!.includes(FAKE_TOKEN), false);
    assertMatch(
      failed[0]!,
      /could not persist the counter baseRefresh\.base-merge-skipped\.lane-\*\*\*REDACTED\*\*\* under /,
    );
    assertMatch(failed[0]!, /File exists|AlreadyExists|already exists/i);
    assertEquals(await Deno.readTextFile(file), "sentinel");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("persistBaseRefreshCounter accumulates named decision counters across calls, and restarts the tally with one warning on a garbled file (Issue #4943)", async () => {
  const dir = await Deno.makeTempDir();
  const counters = `${dir}/${BASE_REFRESH_COUNTERS_FILE}`;
  const read = async () =>
    JSON.parse(await Deno.readTextFile(counters)).counters;
  try {
    const skipped = { outcome: "base-merge-skipped", source: "pr-ci" } as const;
    const firstWrites = await captureWarns(async () => {
      await persistBaseRefreshCounter(dir, skipped);
      await persistBaseRefreshCounter(dir, skipped);
      await persistBaseRefreshCounter(dir, {
        outcome: "base-merge-allowed",
        source: "pr-ci",
      });
    });
    assertEquals(firstWrites, [], "a missing file starts the tally silently");
    assertEquals(await read(), {
      "baseRefresh.base-merge-skipped.pr-ci": 2,
      "baseRefresh.base-merge-allowed.pr-ci": 1,
    });
    assertEquals(
      baseRefreshCounterName(skipped),
      "baseRefresh.base-merge-skipped.pr-ci",
    );

    await Deno.writeTextFile(counters, "{oops");
    const garbled = await captureWarns(() =>
      persistBaseRefreshCounter(dir, skipped)
    );
    assertEquals(garbled.length, 1, garbled.join("\n"));
    assert(
      garbled[0]!.startsWith(
        `[base-refresh] could not read the counters in ${counters}; the tally restarts: `,
      ),
      garbled[0],
    );
    assertMatch(garbled[0]!, /JSON/, "the parse error is named");
    assertEquals(await read(), { "baseRefresh.base-merge-skipped.pr-ci": 1 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

for (
  const [shape, text, cause] of [
    ["an array root", "[]", /not a JSON object/],
    ["a null root", "null", /not a JSON object/],
    ["no counters field", "{}", /"counters" field is missing/],
    [
      "an array counters field",
      '{"counters":[]}',
      /"counters" field is missing/,
    ],
    [
      "a non-numeric entry",
      '{"counters":{"baseRefresh.a.b":"many"}}',
      /"counters" entry "baseRefresh.a.b" is not a finite number/,
    ],
  ] as const
) {
  Deno.test(`persistBaseRefreshCounter warns once, naming the field, before it restarts a tally stored as ${shape} (PR #5059 review)`, async () => {
    const dir = await Deno.makeTempDir();
    const counters = `${dir}/${BASE_REFRESH_COUNTERS_FILE}`;
    try {
      await Deno.writeTextFile(counters, text);
      const warns = await captureWarns(() =>
        persistBaseRefreshCounter(dir, {
          outcome: "base-merge-skipped",
          source: "pr-ci",
        })
      );
      assertEquals(warns.length, 1, warns.join("\n"));
      assert(
        warns[0]!.startsWith(
          `[base-refresh] could not read the counters in ${counters}; the tally restarts: `,
        ),
        warns[0],
      );
      assertMatch(warns[0]!, cause);
      assertEquals(JSON.parse(await Deno.readTextFile(counters)).counters, {
        "baseRefresh.base-merge-skipped.pr-ci": 1,
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("persistBaseRefreshCounter serialises concurrent writers to the same tally (Issue #4943)", async () => {
  const dir = await Deno.makeTempDir();
  const counters = `${dir}/${BASE_REFRESH_COUNTERS_FILE}`;
  const decision = {
    outcome: "refresh-skipped",
    source: "pr-maintenance",
  } as const;
  try {
    await Promise.all(
      Array.from({ length: 8 }, () => persistBaseRefreshCounter(dir, decision)),
    );
    const stored = JSON.parse(await Deno.readTextFile(counters));
    assertEquals(stored.counters, {
      "baseRefresh.refresh-skipped.pr-maintenance": 8,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("persistBaseRefreshCounter logs nothing without a directory, and warns with the cause but never throws on an unwritable one (Issue #4943)", async () => {
  const facts = { outcome: "base-merge-skipped", source: "pr-ci" } as const;

  // No directory: the call resolves and there is nothing to report.
  const absent = await captureWarns(async () => {
    assertEquals(await persistBaseRefreshCounter(undefined, facts), undefined);
  });
  assertEquals(absent, [], "no directory, no line");

  const root = await Deno.makeTempDir();
  try {
    // A regular file cannot be a directory: persistence fails quietly.
    const file = `${root}/not-a-dir`;
    await Deno.writeTextFile(file, "sentinel");
    const warns = await captureWarns(async () => {
      assertEquals(await persistBaseRefreshCounter(file, facts), undefined);
    });
    assertEquals(await Deno.readTextFile(file), "sentinel", "file unchanged");
    assertEquals(
      [...Deno.readDirSync(root)].map((entry) => entry.name),
      ["not-a-dir"],
      "no sibling counters or temp file left behind",
    );
    const persistLine = warns.find((line) =>
      line.startsWith(
        `[base-refresh] could not persist the counter baseRefresh.base-merge-skipped.pr-ci under ${file}: `,
      )
    );
    assert(persistLine !== undefined, warns.join("\n"));
    assertMatch(persistLine, /File exists|AlreadyExists|already exists/i);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
