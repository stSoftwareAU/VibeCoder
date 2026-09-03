/**
 * Issue #857: the audit must model the scan's `dependency-blocked` gate.
 *
 * `classifyIssues` applied seven gates where the claim scan applies eight.
 * The missing one is `dependency-blocked` (Issue #460, GRQ#4465), classified
 * `"human"` in `skip_reason_clearing.ts`. Without it the audit counted
 * dependency-blocked issues as claimable and raised
 * `ALERT mis_classification` against a scan that was right — on every tick.
 *
 * This is the third instance of one pattern. The file's own docblocks record
 * the previous two, each fixed by adding the gate the audit had missed:
 *
 * - #4223 (`pr_blocked`) — "fired on essentially every tick — 1512 times in
 *   one log — and the genuine #2106 symptom became indistinguishable".
 * - GRQ#4419 (`merged_pr_blocked`) — "disagree with a scan that was right on
 *   every tick, for ever".
 *
 * Observed on GRQ-23 on 2026-09-02: `claimable_total=3` on every tick, which
 * was exactly VibeCoder's `dependency_blocked=2` plus GRQ's `=1`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { classifyIssues } from "../lib/idle_detect_diagnostics.ts";

const REPO = "stSoftwareAU/VibeCoder";

function issue(
  number: number,
  body?: string,
): {
  number: number;
  labels: string[];
  assignees: string[];
  milestone: string;
  body?: string;
} {
  return {
    number,
    labels: ["work-on"],
    assignees: [],
    milestone: "",
    ...(body === undefined ? {} : { body }),
  };
}

Deno.test("idle-detect - an issue naming an open dependency is not claimable (Issue #857)", () => {
  const verdicts = classifyIssues([issue(808, "Depends on #805")], {
    workerUser: "VibeCoderST",
    repo: REPO,
    openIssueNumbers: new Set([805]),
  });
  assertEquals(verdicts[0]?.claimable, false);
  assertEquals(verdicts[0]?.excludedBy, "dependency_blocked");
});

Deno.test("idle-detect - a closed same-repo dependency does not block (Issue #857)", () => {
  // #805 absent from the open set means it is closed: the scan claims, so
  // the audit must agree or it manufactures the opposite inversion.
  const verdicts = classifyIssues([issue(808, "Depends on #805")], {
    workerUser: "VibeCoderST",
    repo: REPO,
    openIssueNumbers: new Set([999]),
  });
  assertEquals(verdicts[0]?.claimable, true);
});

Deno.test("idle-detect - an unresolvable cross-repo dependency blocks, as the scan fails safe (Issue #857)", () => {
  const verdicts = classifyIssues(
    [issue(808, "Depends on stSoftwareAU/GRQ#4647")],
    {
      workerUser: "VibeCoderST",
      repo: REPO,
      openIssueNumbers: new Set([1]),
    },
  );
  assertEquals(verdicts[0]?.excludedBy, "dependency_blocked");
});

Deno.test("idle-detect - no dependency data leaves the gate inert (Issue #857)", () => {
  // The fail-safe every other gate takes: absent data must under-count
  // blockers rather than invent them.
  const noSet = classifyIssues([issue(808, "Depends on #805")], {
    workerUser: "VibeCoderST",
  });
  assertEquals(noSet[0]?.claimable, true, "no openIssueNumbers → inert");

  const noBody = classifyIssues([issue(808)], {
    workerUser: "VibeCoderST",
    repo: REPO,
    openIssueNumbers: new Set([805]),
  });
  assertEquals(noBody[0]?.claimable, true, "no body → inert");
});

Deno.test("idle-detect - a more fundamental exclusion keeps its own reason (Issue #857)", () => {
  // The gate is applied last, mirroring the scan: an assigned issue that also
  // names an open dependency reports the assignee, not the dependency.
  const verdicts = classifyIssues([
    {
      number: 808,
      labels: ["work-on"],
      assignees: ["someone"],
      milestone: "",
      body: "Depends on #805",
    },
  ], {
    workerUser: "VibeCoderST",
    repo: REPO,
    openIssueNumbers: new Set([805]),
  });
  assertEquals(verdicts[0]?.excludedBy, "assignee_filter");
});

Deno.test("idle-detect - the GRQ-23 arithmetic no longer alerts (Issue #857)", () => {
  // Two dependency-blocked issues were the whole of VibeCoder's contribution
  // to claimable_total=3. With the gate present, nothing is claimable and no
  // mis_classification is raised.
  const verdicts = classifyIssues(
    [issue(808, "Depends on #805"), issue(796, "Depends on #805")],
    {
      workerUser: "VibeCoderST",
      repo: REPO,
      openIssueNumbers: new Set([805]),
    },
  );
  assertEquals(verdicts.filter((v) => v.claimable).length, 0);
});
