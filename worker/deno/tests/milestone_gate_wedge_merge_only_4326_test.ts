/**
 * A merge-only refusal never feeds the gate-wedge ledger (Issue #4326).
 *
 * When the host cannot afford the repository's build, the merge-only
 * resolution gate refuses a resolution without having run anything. That is
 * not a verdict on the resolution, so `concludeGateRefusal` must neither count
 * it nor file a diagnostic blaming the gate. These tests drive the real
 * `concludeGateRefusal` with a recording `gh` stub, and take the refusal's
 * text from the real merge-only resolution gate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GATE_REFUSAL_WEDGE_THRESHOLD,
  isGateWedged,
  type SyncStreakEntry,
} from "../lib/milestone_sync_streak.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  concludeGateRefusal,
  type GateWedgeBranch,
  type GhCommandFn,
} from "../lib/milestone_gate_wedge.ts";
import {
  MERGE_ONLY_NO_BUILD,
  mergeOnlyBindings,
} from "../lib/milestone_merge_only.ts";

const REPO = "owner/repo";
const MILESTONE = "milestone/4326-merge-only-wedge";
const MILESTONE_TITLE = "#4326 merge-only wedge";
const DEFAULT_SHA = "d".repeat(40);
const MILESTONE_SHA = "m".repeat(40);
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const REASON =
  "ephemeral cargo root over budget (test reading) (Issue #3178); the merge " +
  "lands without the repository's build and the repository's CI builds it " +
  "(Issue #4326)";
const ORDINARY_GATE_FAILURE =
  "the merged tree does not compile: error[E0425] cannot find value `x`";
const EMPTY: SyncStreakEntry = { count: 0, escalated: false };

const BRANCH: GateWedgeBranch = {
  repo: REPO,
  milestoneBranch: MILESTONE,
  defaultBranch: "main",
  milestoneTitle: MILESTONE_TITLE,
};

/** A `gh` runner that records every call and answers an empty search. */
function ghStub() {
  const calls: string[][] = [];
  const fn: GhCommandFn = (args) => {
    calls.push(args);
    return Promise.resolve(args[1] === "list" ? "[]" : "");
  };
  return { fn, calls };
}

/** Injected dependencies for one conclusion, with a recording `gh` stub. */
function depsWith(gh: GhCommandFn) {
  return { ghCommandFn: gh, log: (_message: string) => {} };
}

/** A gate refusal as the sync raises one, carrying the gate's text. */
function refusal(gateFailure: string) {
  const escalation = new MilestoneConflictEscalation(
    "the merge gate refused the resolution",
    [],
    [{
      path: "lib/foo_test.ts",
      case: "test-union",
      action: "union",
      reason: "the milestone side is a union of both",
    }],
    DEFAULT_SHA,
    gateFailure,
    MILESTONE_SHA,
  );
  return escalation as MilestoneConflictEscalation & { gateFailure: string };
}

/**
 * The text a merge-only resolution gate refuses with, taken from the real
 * binding on a cargo tree rather than written out here.
 */
async function mergeOnlyGateFailure(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "milestone-wedge-tree-4326-" });
  try {
    await Deno.writeTextFile(
      `${dir}/Cargo.toml`,
      '[package]\nname = "fixture"\nversion = "0.0.0"\n',
    );
    const bindings = mergeOnlyBindings(REASON);
    assert(bindings !== undefined, "a reason must give bindings");
    const outcome = await bindings.resolutionGate(dir);
    assertEquals(outcome.status, "failed");
    assertStringIncludes(outcome.detail, MERGE_ONLY_NO_BUILD);
    return outcome.detail;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("gate wedge - a merge-only refusal is never counted, however often it repeats (Issue #4326)", async () => {
  const failure = await mergeOnlyGateFailure();
  const gh = ghStub();
  let entry: SyncStreakEntry = EMPTY;
  for (let i = 0; i < GATE_REFUSAL_WEDGE_THRESHOLD + 1; i++) {
    const concluded = await concludeGateRefusal(
      entry,
      BRANCH,
      refusal(failure),
      DEFAULT_SHA,
      NOW,
      depsWith(gh.fn),
    );
    assertEquals(concluded.wedged, false);
    entry = concluded.entry;
  }
  assertEquals(entry.gateRefusal, undefined, "nothing was recorded");
  assertEquals(isGateWedged(entry), false);
  assertEquals(gh.calls, [], "no diagnostic was filed or searched for");
});

Deno.test("gate wedge - control: an ordinary gate refusal repeated the same way wedges and files the diagnostic (Issue #4326)", async () => {
  const gh = ghStub();
  let entry: SyncStreakEntry = EMPTY;
  let wedged = false;
  for (let i = 0; i < GATE_REFUSAL_WEDGE_THRESHOLD + 1; i++) {
    const concluded = await concludeGateRefusal(
      entry,
      BRANCH,
      refusal(ORDINARY_GATE_FAILURE),
      DEFAULT_SHA,
      NOW,
      depsWith(gh.fn),
    );
    wedged = concluded.wedged;
    entry = concluded.entry;
  }
  assertEquals(wedged, true);
  assert(isGateWedged(entry), "the ordinary refusal wedges the branch");
  const creates = gh.calls.filter((args) =>
    args[0] === "issue" && args[1] === "create"
  );
  assertEquals(creates.length, 1, "the diagnostic was filed once");
});

Deno.test("gate wedge - a real refusal already on the entry is kept untouched by a merge-only refusal (Issue #4326)", async () => {
  const failure = await mergeOnlyGateFailure();
  const gh = ghStub();

  // One ordinary refusal first, so the entry holds a real refusal keyed the way
  // `concludeGateRefusal` keys it.
  const first = await concludeGateRefusal(
    EMPTY,
    BRANCH,
    refusal(ORDINARY_GATE_FAILURE),
    DEFAULT_SHA,
    NOW,
    depsWith(gh.fn),
  );
  assertEquals(first.entry.gateRefusal?.count, 1);
  const realCallsBefore = gh.calls.length;

  const merged = await concludeGateRefusal(
    first.entry,
    BRANCH,
    refusal(failure),
    DEFAULT_SHA,
    NOW,
    depsWith(gh.fn),
  );
  assertEquals(merged.entry, first.entry, "the entry is returned unchanged");
  assertEquals(merged.wedged, false);
  assertEquals(gh.calls.length, realCallsBefore, "nothing was reported");

  // The real refusal still counts: its next repeat wedges the branch as before.
  const repeat = await concludeGateRefusal(
    merged.entry,
    BRANCH,
    refusal(ORDINARY_GATE_FAILURE),
    DEFAULT_SHA,
    NOW,
    depsWith(gh.fn),
  );
  assertEquals(repeat.entry.gateRefusal?.count, 2);
  assertEquals(repeat.wedged, true);
});
