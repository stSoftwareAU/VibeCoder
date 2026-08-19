/**
 * Tests for the unworkable-work-on escalation helper (Issue #2752).
 *
 * Covers the shared escalation action: `needs-human` applied + exactly one
 * explanatory comment naming the blocker, routed through the
 * `escalateToHuman` chokepoint. The GitHub label/comment calls are mocked
 * and their payloads asserted.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCycleEscalation,
  buildDeadLabelEscalation,
  escalateUnworkableWorkOn,
} from "../lib/escalate_unworkable_work_on.ts";
import type { GitHubClient, GitHubComment } from "../types.ts";
import { defaultLogger } from "../lib/logger.ts";

interface Recorder {
  labels: Array<{ issue: number; label: string }>;
  comments: Array<{ issue: number; body: string }>;
}

function recordingClient(
  recorder: Recorder,
  comments: GitHubComment[] = [],
): GitHubClient {
  const notImpl = (m: string) => () => Promise.reject(new Error(`${m} unused`));
  return {
    getIssue: notImpl("getIssue"),
    getIssueComments: (_repo: string, _n: number) => Promise.resolve(comments),
    addLabel: (_repo: string, issue: number, label: string) => {
      recorder.labels.push({ issue, label });
      return Promise.resolve();
    },
    removeLabel: notImpl("removeLabel"),
    postComment: (_repo: string, issue: number, body: string) => {
      recorder.comments.push({ issue, body });
      return Promise.resolve(undefined);
    },
    editIssue: notImpl("editIssue"),
    assignIssue: notImpl("assignIssue"),
    unassignIssue: notImpl("unassignIssue"),
    closeIssue: notImpl("closeIssue"),
  };
}

const ensureOk = () => Promise.resolve({ ok: true as const, value: undefined });

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

Deno.test("buildCycleEscalation - renders the loop closed back to start", () => {
  const e = buildCycleEscalation(340, [340, 341]);
  assertStringIncludes(e.reason, "#340 → #341 → #340");
  assertStringIncludes(e.reason, "dependency cycle");
  assertEquals(e.dedupKey, "work-on-dependency-cycle-340");
});

Deno.test("buildCycleEscalation - falls back to the issue when path empty", () => {
  const e = buildCycleEscalation(7, []);
  assertStringIncludes(e.reason, "#7");
});

Deno.test("buildDeadLabelEscalation - names the relabel/close next step", () => {
  const e = buildDeadLabelEscalation(50);
  assertStringIncludes(e.reason, "milestone-tracking");
  assertStringIncludes(e.reason, "work-on");
  assertStringIncludes(e.nextStep, "Relabel or close");
  assertEquals(e.dedupKey, "work-on-dead-label-tracker-50");
});

// ---------------------------------------------------------------------------
// escalateUnworkableWorkOn — payload assertions
// ---------------------------------------------------------------------------

Deno.test(
  "escalateUnworkableWorkOn - applies needs-human and posts one comment naming the cycle",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    const fired = await escalateUnworkableWorkOn({
      repo: "owner/repo",
      issueNumber: 340,
      needsHumanLabel: "needs-human",
      escalation: buildCycleEscalation(340, [340, 341]),
      githubUser: "bot",
      ghFn: () => Promise.resolve("[]"),
      deps: {
        ghClient: recordingClient(recorder),
        ensureLabelExists: ensureOk,
        logger: defaultLogger,
      },
    });

    assertEquals(fired, true);
    assertEquals(recorder.labels, [{ issue: 340, label: "needs-human" }]);
    assertEquals(recorder.comments.length, 1);
    assertStringIncludes(recorder.comments[0]!.body, "#340 → #341 → #340");
    assertStringIncludes(recorder.comments[0]!.body, "Next step:");
    // Stable dedup marker present for idempotent re-scans.
    assertStringIncludes(
      recorder.comments[0]!.body,
      "work-on-dependency-cycle-340",
    );
  },
);

Deno.test(
  "escalateUnworkableWorkOn - dead-label escalation posts a relabel/close comment",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    await escalateUnworkableWorkOn({
      repo: "owner/repo",
      issueNumber: 50,
      needsHumanLabel: "needs-human",
      escalation: buildDeadLabelEscalation(50),
      githubUser: "bot",
      ghFn: () => Promise.resolve("[]"),
      deps: {
        ghClient: recordingClient(recorder),
        ensureLabelExists: ensureOk,
      },
    });

    assertEquals(recorder.labels, [{ issue: 50, label: "needs-human" }]);
    assertEquals(recorder.comments.length, 1);
    assertStringIncludes(recorder.comments[0]!.body, "Relabel or close");
  },
);

Deno.test(
  "escalateUnworkableWorkOn - idempotent: a prior dedup marker suppresses the comment",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    const priorComment: GitHubComment = {
      id: 1,
      body: "earlier escalation\n\n<!-- needs-human-escalation: " +
        "work-on-dependency-cycle-340 -->",
      author: "bot",
      createdAt: "2026-06-13T00:00:00Z",
      reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    };
    await escalateUnworkableWorkOn({
      repo: "owner/repo",
      issueNumber: 340,
      needsHumanLabel: "needs-human",
      escalation: buildCycleEscalation(340, [340, 341]),
      ghFn: () => Promise.resolve("[]"),
      deps: {
        ghClient: recordingClient(recorder, [priorComment]),
        ensureLabelExists: ensureOk,
        // Fixed clock 1h after the prior comment — inside the 24h window.
        now: () => Date.parse("2026-06-13T01:00:00Z"),
      },
    });

    // Label add is idempotent (re-attempted), but no duplicate comment.
    assertEquals(recorder.labels, [{ issue: 340, label: "needs-human" }]);
    assertEquals(recorder.comments.length, 0);
  },
);
