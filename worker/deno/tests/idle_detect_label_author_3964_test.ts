/**
 * Idle-detect audit models the claim scan's label-author gate (Issue #4212).
 *
 * An issue whose only priority label was added by an untrusted author is
 * refused by the scan as `label-author-not-allowed`. The audit counted it
 * claimable, so `ALERT mis_classification` fired every cycle against a scan
 * that was right.
 *
 * Australian English spelling used throughout (behaviour).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditClaimableState,
  classifyIssues,
  pickDominantReason,
} from "../lib/idle_detect_diagnostics.ts";

const WORKER = "vibebot";

const PRIORITY_ISSUE = {
  number: 42,
  labels: ["top-priority"],
  assignees: [] as string[],
  milestone: "",
};

Deno.test(
  "classifyIssues - an untrusted priority label is label_author_not_allowed (Issue #4212)",
  () => {
    const verdicts = classifyIssues([PRIORITY_ISSUE], {
      workerUser: WORKER,
      untrustedLabelIssues: new Set([42]),
    });
    assertEquals(verdicts.length, 1);
    assertEquals(verdicts[0]!.claimable, false);
    assertEquals(verdicts[0]!.excludedBy, "label_author_not_allowed");
  },
);

Deno.test(
  "classifyIssues - an assigned untrusted issue stays assignee_filter (Issue #4212)",
  () => {
    const verdicts = classifyIssues(
      [{ ...PRIORITY_ISSUE, assignees: ["someone-else"] }],
      {
        workerUser: WORKER,
        untrustedLabelIssues: new Set([42]),
      },
    );
    assertEquals(verdicts[0]!.claimable, false);
    assertEquals(verdicts[0]!.excludedBy, "assignee_filter");
  },
);

Deno.test(
  "classifyIssues - omitting untrustedLabelIssues leaves a priority issue claimable (Issue #4212)",
  () => {
    const verdicts = classifyIssues([PRIORITY_ISSUE], { workerUser: WORKER });
    assertEquals(verdicts[0]!.claimable, true);
    assertEquals(verdicts[0]!.excludedBy, undefined);
  },
);

Deno.test(
  "pickDominantReason - label_author_not_allowed sits between milestone_tracker and assignee_filter (Issue #4212)",
  () => {
    const assigneeAndAuthor = [
      {
        number: 1,
        claimable: false as const,
        excludedBy: "assignee_filter" as const,
        milestone: "",
      },
      {
        number: 2,
        claimable: false as const,
        excludedBy: "label_author_not_allowed" as const,
        milestone: "",
      },
    ];
    assertEquals(
      pickDominantReason(assigneeAndAuthor),
      "label_author_not_allowed",
    );
    assertEquals(
      pickDominantReason([
        ...assigneeAndAuthor,
        {
          number: 3,
          claimable: false,
          excludedBy: "milestone_tracker",
          milestone: "",
        },
      ]),
      "milestone_tracker",
    );
  },
);

function ghListing(
  issues: ReadonlyArray<{ number: number; labels: string[] }>,
) {
  return (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify(
      issues.map((row) => ({
        number: row.number,
        labels: row.labels.map((name) => ({ name })),
        assignees: [],
        milestone: null,
      })),
    ));
}

Deno.test(
  "auditClaimableState - an untrusted-only issue reports label_author_not_allowed and raises no mis_classification (Issue #4212)",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: WORKER,
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: ghListing([{ number: 42, labels: ["top-priority"] }]),
      untrustedLabelIssuesFn: () => Promise.resolve(new Set([42])),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 1234,
    });

    assertEquals(result.claimableTotal, 0);
    assertEquals(result.misClassification, false);
    assertEquals(result.perRepo[0]!.reason, "label_author_not_allowed");
    assert(
      logs.some((line) =>
        line.includes("claimable=0") &&
        line.includes("reason=label_author_not_allowed")
      ),
      `expected claimable=0 reason=label_author_not_allowed; got ${
        logs.join("\n")
      }`,
    );
    assert(
      !logs.some((line) => line.includes("ALERT mis_classification")),
      `expected no ALERT mis_classification; got ${logs.join("\n")}`,
    );
  },
);

Deno.test(
  "auditClaimableState - a rejected untrusted-label lookup warns and still counts the issue (Issue #4212)",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: WORKER,
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: ghListing([{ number: 42, labels: ["top-priority"] }]),
      untrustedLabelIssuesFn: () => Promise.reject(new Error("timeline boom")),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 1234,
    });

    assertEquals(result.perRepo[0]!.claimable, 1);
    assertEquals(result.claimableTotal, 1);
    assert(
      logs.some((line) =>
        line.startsWith("[idle-detect]") &&
        line.includes("repo=org/alpha") &&
        line.includes("action=warn") &&
        line.includes("reason=untrusted_label_lookup_failed") &&
        line.includes("timeline boom")
      ),
      `expected untrusted_label_lookup_failed warning; got ${logs.join("\n")}`,
    );
  },
);
