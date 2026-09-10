/**
 * The idle-detect audit models the weekly-quota pace gate (Issue #1915).
 *
 * While the week-pace guard (Issue #1885) is engaged the Priority 2 scan
 * drops tiers 3 and 4 — `low-priority` and `idle-task` — from the ladder, so
 * nothing in them can be claimed until the window resets. The audit did not
 * know that: on GRQ-25 it counted 87 pace-suppressed `low-priority` issues as
 * claimable, so every cycle read as a scan/probe disagreement, raised
 * `mis_classification`, and eventually forced the idle-task filer through the
 * disagreement bound at ~800 GraphQL points a cycle.
 *
 * These tests drive the pure classifier and `auditClaimableState` in both
 * directions: pace engaged (the suppressed tiers stop counting) and pace off
 * (every count unchanged).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditClaimableState,
  classifyIssues,
  pickDominantReason,
} from "../lib/idle_detect_diagnostics.ts";

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

Deno.test(
  "classifyIssues - pace engaged excludes low-priority and idle-task as pace_suppressed (Issue #1915)",
  () => {
    const verdicts = classifyIssues(
      [
        { number: 1, labels: ["low-priority"], assignees: [], milestone: "" },
        { number: 2, labels: ["idle-task"], assignees: [], milestone: "" },
      ],
      { workerUser: "vibebot", weekPaceEngaged: true },
    );
    assertEquals(verdicts.map((v) => v.claimable), [false, false]);
    assertEquals(
      verdicts.map((v) => v.excludedBy),
      ["pace_suppressed", "pace_suppressed"],
    );
  },
);

Deno.test(
  "classifyIssues - pace engaged leaves top-priority and work-on claimable (Issue #1915)",
  () => {
    const verdicts = classifyIssues(
      [
        { number: 1, labels: ["top-priority"], assignees: [], milestone: "" },
        { number: 2, labels: ["work-on"], assignees: [], milestone: "" },
        {
          number: 3,
          labels: ["low-priority", "work-on"],
          assignees: [],
          milestone: "",
        },
      ],
      { workerUser: "vibebot", weekPaceEngaged: true },
    );
    assertEquals(verdicts.map((v) => v.claimable), [true, true, true]);
  },
);

Deno.test(
  "classifyIssues - pace off leaves the suppressed tiers claimable (Issue #1915)",
  () => {
    const verdicts = classifyIssues(
      [
        { number: 1, labels: ["low-priority"], assignees: [], milestone: "" },
        { number: 2, labels: ["idle-task"], assignees: [], milestone: "" },
      ],
      { workerUser: "vibebot" },
    );
    assertEquals(verdicts.map((v) => v.claimable), [true, true]);
  },
);

Deno.test(
  "classifyIssues - a more fundamental refusal outranks pace_suppressed (Issue #1915)",
  () => {
    // The pace gate is the scan's *last* filter, so an issue the scan already
    // refuses for a blocking label or an assignee keeps that reason.
    const verdicts = classifyIssues(
      [
        {
          number: 1,
          labels: ["low-priority", "needs-human"],
          assignees: [],
          milestone: "",
        },
        {
          number: 2,
          labels: ["low-priority"],
          assignees: ["someone"],
          milestone: "",
        },
      ],
      { workerUser: "vibebot", weekPaceEngaged: true },
    );
    assertEquals(
      verdicts.map((v) => v.excludedBy),
      ["blocking_label", "assignee_filter"],
    );
  },
);

Deno.test(
  "pickDominantReason - pace_suppressed outranks stream occupancy and the filters (Issue #1915)",
  () => {
    assertEquals(
      pickDominantReason([
        {
          number: 1,
          claimable: false,
          excludedBy: "label_filter",
          milestone: "",
        },
        {
          number: 2,
          claimable: false,
          excludedBy: "stream_occupied",
          milestone: "",
        },
        {
          number: 3,
          claimable: false,
          excludedBy: "pace_suppressed",
          milestone: "",
        },
      ]),
      "pace_suppressed",
    );
  },
);

// ---------------------------------------------------------------------------
// auditClaimableState — the GRQ-25 shape
// ---------------------------------------------------------------------------

interface StubIssueRow {
  number: number;
  labels: string[];
}

/** A backlog of `count` unblocked `low-priority` issues, GRQ-25's shape. */
function lowPriorityBacklog(count: number): StubIssueRow[] {
  return Array.from({ length: count }, (_unused, i) => ({
    number: i + 1,
    labels: ["low-priority"],
  }));
}

function makeGhStub(byRepo: Record<string, StubIssueRow[]>) {
  return (args: string[]): Promise<string> => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1]! : "";
    const rows = byRepo[repo] ?? [];
    return Promise.resolve(JSON.stringify(
      rows.map((row) => ({
        number: row.number,
        labels: row.labels.map((name) => ({ name })),
        assignees: [],
        milestone: null,
      })),
    ));
  };
}

Deno.test(
  "auditClaimableState - pace engaged: a pace-suppressed backlog is not claimable and raises no mis_classification (Issue #1915)",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      weekPaceEngaged: true,
      ghCommandFn: makeGhStub({ "org/alpha": lowPriorityBacklog(87) }),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 1234,
    });

    assertEquals(result.claimableTotal, 0);
    assertEquals(result.misClassification, false);
    assertEquals(result.perRepo[0]!.reason, "pace_suppressed");
    assert(
      !logs.some((l) => l.includes("mis_classification")),
      `expected no ALERT while the pace guard is engaged; got ${
        logs.join("\n")
      }`,
    );
  },
);

Deno.test(
  "auditClaimableState - pace off: the same backlog counts as claimable and alerts (unchanged, Issue #1915)",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      ghCommandFn: makeGhStub({ "org/alpha": lowPriorityBacklog(87) }),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 1234,
    });

    assertEquals(result.claimableTotal, 87);
    assertEquals(result.misClassification, true);
    assert(logs.some((l) => l.includes("ALERT mis_classification")));
  },
);

Deno.test(
  "auditClaimableState - pace engaged still counts top-priority work (Issue #1915)",
  async () => {
    const logs: string[] = [];
    const result = await auditClaimableState({
      repos: ["org/alpha"],
      workerUser: "vibebot",
      tick: 1,
      scanFoundClaimable: false,
      weekPaceEngaged: true,
      ghCommandFn: makeGhStub({
        "org/alpha": [
          ...lowPriorityBacklog(3),
          { number: 99, labels: ["top-priority"] },
        ],
      }),
      log: (line) => logs.push(line),
      hostnameFn: () => "host-a",
      pidFn: () => 1234,
    });

    assertEquals(result.claimableTotal, 1);
    assertEquals(result.misClassification, true);
  },
);
