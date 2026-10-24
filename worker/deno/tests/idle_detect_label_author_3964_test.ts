/**
 * Issue #4212: the audit must model the claim scan's `label-author-not-allowed`
 * refusal.
 *
 * A priority issue whose label an untrusted author added is refused by the
 * scan at `collect_label_candidates.ts`. Without this gate the audit counted it
 * as claimable, so `ALERT mis_classification` fired against a scan that was
 * right. The gate sits right after the blocked and assignee skips and before
 * the milestone-tracker gate, and a failed lookup falls back to the old
 * over-count with a warning.
 *
 * Uses Australian English spelling (behaviour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditClaimableState,
  classifyIssues,
  pickDominantReason,
} from "../lib/idle_detect_diagnostics.ts";

/** Matches the milestone-tracking title pattern `filterAndSort` drops. */
const TRACKER_TITLE = "Merge milestone 'Milestone 34' to Develop";

// ---------------------------------------------------------------------------
// classifyIssues - the gate itself
// ---------------------------------------------------------------------------

Deno.test("classifyIssues - an issue in untrustedLabelIssues is not claimable (Issue #4212)", () => {
  const verdicts = classifyIssues(
    [
      { number: 10, labels: ["top-priority"], assignees: [], milestone: "" },
      { number: 11, labels: ["top-priority"], assignees: [], milestone: "" },
    ],
    { workerUser: "vibebot", untrustedLabelIssues: new Set([10]) },
  );

  assertEquals(verdicts[0]?.claimable, false);
  assertEquals(verdicts[0]?.excludedBy, "label_author_not_allowed");
  // Same labels, not in the set: still claimable.
  assertEquals(verdicts[1]?.claimable, true);
});

Deno.test("classifyIssues - assignee_filter keeps its reason ahead of the label-author gate (Issue #4212)", () => {
  const verdicts = classifyIssues(
    [{
      number: 20,
      labels: ["top-priority"],
      assignees: ["someone"],
      milestone: "",
    }],
    { workerUser: "vibebot", untrustedLabelIssues: new Set([20]) },
  );

  // The scan refuses an assigned issue at the assignee gate, before it reaches
  // the label-author refusal, so the audit reports the same reason.
  assertEquals(verdicts[0]?.excludedBy, "assignee_filter");
});

Deno.test("classifyIssues - label_author_not_allowed is applied before milestone_tracker (Issue #4212)", () => {
  const tracker = {
    number: 30,
    title: TRACKER_TITLE,
    labels: ["work-on"],
    assignees: [],
    milestone: "",
  };

  const refused = classifyIssues([tracker], {
    workerUser: "vibebot",
    untrustedLabelIssues: new Set([30]),
  });
  assertEquals(refused[0]?.excludedBy, "label_author_not_allowed");

  // Positive control: the same tracker, not in the set, is the tracker gate's
  // refusal. Without the set the tracker gate is what answers.
  const plain = classifyIssues([tracker], { workerUser: "vibebot" });
  assertEquals(plain[0]?.excludedBy, "milestone_tracker");
});

Deno.test("classifyIssues - no untrusted set keeps today's verdict (Issue #4212)", () => {
  const issue = {
    number: 40,
    labels: ["top-priority"],
    assignees: [],
    milestone: "",
  };

  const omitted = classifyIssues([issue], { workerUser: "vibebot" });
  assertEquals(omitted[0]?.claimable, true);

  // Empty means "no data": the fail-safe, no issue excluded.
  const empty = classifyIssues([issue], {
    workerUser: "vibebot",
    untrustedLabelIssues: new Set<number>(),
  });
  assertEquals(empty[0]?.claimable, true);
});

// ---------------------------------------------------------------------------
// pickDominantReason - specificity
// ---------------------------------------------------------------------------

Deno.test("pickDominantReason - label_author_not_allowed outranks assignee_filter (Issue #4212)", () => {
  assertEquals(
    pickDominantReason([
      {
        number: 1,
        claimable: false,
        excludedBy: "assignee_filter",
        milestone: "",
      },
      {
        number: 2,
        claimable: false,
        excludedBy: "label_author_not_allowed",
        milestone: "",
      },
    ]),
    "label_author_not_allowed",
  );
});

Deno.test("pickDominantReason - milestone_tracker outranks label_author_not_allowed (Issue #4212)", () => {
  assertEquals(
    pickDominantReason([
      {
        number: 1,
        claimable: false,
        excludedBy: "label_author_not_allowed",
        milestone: "",
      },
      {
        number: 2,
        claimable: false,
        excludedBy: "milestone_tracker",
        milestone: "",
      },
    ]),
    "milestone_tracker",
  );
});

// ---------------------------------------------------------------------------
// auditClaimableState - the probe wiring
// ---------------------------------------------------------------------------

Deno.test("auditClaimableState - a label-author-refused priority issue raises no mis_classification ALERT (Issue #4212)", async () => {
  const logs: string[] = [];
  const lookups: Array<
    {
      repo: string;
      issues: readonly { number: number; labels: readonly string[] }[];
    }
  > = [];
  const result = await auditClaimableState({
    repos: ["org/alpha"],
    workerUser: "vibebot",
    tick: 1,
    // The scan claimed nothing, correctly, because the label was not trusted.
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        {
          number: 42,
          labels: [{ name: "top-priority" }],
          assignees: [],
          milestone: null,
        },
      ])),
    untrustedLabelIssuesFn: (repo, issues) => {
      lookups.push({ repo, issues });
      return Promise.resolve(new Set([42]));
    },
    log: (line) => logs.push(line),
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.claimableTotal, 0);
  assertEquals(result.misClassification, false);

  // The lookup received the repo's open issues, each reduced to number and
  // labels.
  assertEquals(lookups.length, 1);
  assertEquals(lookups[0]?.repo, "org/alpha");
  assertEquals(lookups[0]?.issues, [{ number: 42, labels: ["top-priority"] }]);

  assert(
    logs.some((l) => l.includes("claimable=0 reason=label_author_not_allowed")),
    `the per-repo line must say why; got:\n${logs.join("\n")}`,
  );
  assert(
    !logs.some((l) => l.includes("ALERT mis_classification")),
    `label-author-refused work must not alert; got:\n${logs.join("\n")}`,
  );
});

Deno.test("auditClaimableState - a rejecting untrustedLabelIssuesFn warns and falls back to the old over-count (Issue #4212)", async () => {
  const logs: string[] = [];
  const result = await auditClaimableState({
    repos: ["org/alpha"],
    workerUser: "vibebot",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        {
          number: 42,
          labels: [{ name: "top-priority" }],
          assignees: [],
          milestone: null,
        },
      ])),
    untrustedLabelIssuesFn: () => Promise.reject(new Error("boom")),
    log: (line) => logs.push(line),
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  const warn = logs.find((l) =>
    l.includes("action=warn reason=untrusted_label_lookup_failed")
  );
  assert(
    warn !== undefined,
    `expected a lookup warning; got:\n${logs.join("\n")}`,
  );
  assert(warn.includes("repo=org/alpha"), warn);
  assert(warn.includes("boom"), warn);

  // Fail-safe: no label data means no exclusion, so the issue counts again.
  assertEquals(result.perRepo[0]?.claimable, 1);
  assert(
    logs.some((l) => l.includes("ALERT mis_classification")),
    `the over-count must surface as an alert; got:\n${logs.join("\n")}`,
  );
});

Deno.test("auditClaimableState - the lookup warning carries the bare Error message, or the string form of a non-Error (Issue #4212)", async () => {
  const warnFor = async (reason: unknown): Promise<string> => {
    const logs: string[] = [];
    await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: () =>
        Promise.resolve(JSON.stringify([
          {
            number: 42,
            labels: [{ name: "top-priority" }],
            assignees: [],
            milestone: null,
          },
        ])),
      untrustedLabelIssuesFn: () => Promise.reject(reason),
      log: (line) => logs.push(line),
      hostnameFn: () => "host",
      pidFn: () => 1,
    });
    const warn = logs.find((l) =>
      l.includes("reason=untrusted_label_lookup_failed")
    );
    assert(warn !== undefined, `expected a lookup warning; got:\n${logs}`);
    return warn;
  };

  // An Error contributes its message alone, not the "Error: " prefix.
  assert(
    (await warnFor(new Error("boom"))).endsWith("message=boom"),
    "an Error must log its bare message",
  );
  // A non-Error has no `.message`, so it is stringified.
  assert(
    (await warnFor("plain failure")).endsWith("message=plain failure"),
    "a non-Error must log its string form",
  );
});

Deno.test("classifyIssues - a label-author verdict carries the issue number and milestone (Issue #4212)", () => {
  const verdicts = classifyIssues(
    [
      { number: 7, labels: ["top-priority"], assignees: [], milestone: "M-a" },
      { number: 8, labels: ["top-priority"], assignees: [], milestone: "M-b" },
    ],
    { workerUser: "vibebot", untrustedLabelIssues: new Set([7, 8]) },
  );

  assertEquals(verdicts, [
    {
      number: 7,
      claimable: false,
      excludedBy: "label_author_not_allowed",
      milestone: "M-a",
    },
    {
      number: 8,
      claimable: false,
      excludedBy: "label_author_not_allowed",
      milestone: "M-b",
    },
  ]);
});
