/**
 * Tests for the re-approved-then-superseded hand-off (Issue #1862).
 *
 * GRQ-AutoTrader#106 was resolved by PR #116; a maintainer then re-applied
 * `work-on` after the merge. Every cycle the merged-PR pre-check honoured the
 * re-approval and kept the issue open (#1618), a fresh agent found the merged
 * PR already satisfied the original description, and the branch was released
 * as superseded (#218) — a "success" with no output, no comment and the label
 * untouched, so the next cycle claimed it again. Three claims in four hours.
 *
 * These tests drive the real helpers with injected doubles and assert on
 * observable behaviour: the phase state the pre-check records, the comment and
 * label the hand-off produces, that a second run posts no second comment, and
 * that the escalated issue is dropped by the discovery filter.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReapprovalSupersededEscalation,
  escalateReapprovalSuperseded,
  type PostMergeReapproval,
  reapprovalSupersededDedupKey,
} from "../lib/reapproval_superseded_handoff.ts";
import { supersededOutcome } from "../lib/run_outcome.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";
import { filterAndSort } from "../lib/issue_filter.ts";
import { LABEL_DEFAULTS } from "../lib/config_defaults.ts";
import type { GitHubClient, GitHubComment } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — the GRQ-AutoTrader#106 shape
// ---------------------------------------------------------------------------

/** When PR #116 merged. */
const MERGED_AT = "2026-09-09T09:35:27Z";
/** When the maintainer re-applied `work-on` — 6h14m after the merge. */
const REAPPROVED_AT = Math.floor(Date.parse("2026-09-09T15:49:15Z") / 1000);

const REAPPROVAL: PostMergeReapproval = {
  label: "work-on",
  addedBy: "nleck",
  addedAt: REAPPROVED_AT,
  prNumber: 116,
  mergedAt: MERGED_AT,
};

/** The superseded release the completion phase produced for that same PR. */
function supersededByPr116(): RunOutcome {
  return supersededOutcome({
    phase: "completion",
    prUrl: "https://github.com/stSoftwareAU/GRQ-AutoTrader/pull/116",
    prNumber: 116,
    prState: "MERGED",
  });
}

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
    getIssueComments: () => Promise.resolve(comments),
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

/** Run the hand-off against a recording client, returning what it did. */
function runHandoff(
  opts: {
    recorder: Recorder;
    reapproval?: PostMergeReapproval;
    outcome?: RunOutcome;
    priorComments?: GitHubComment[];
    now?: () => number;
    ghFn?: (args: string[]) => Promise<string>;
  },
): Promise<string | null> {
  return escalateReapprovalSuperseded({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    issueNumber: 106,
    needsHumanLabel: "needs-human",
    reapproval: "reapproval" in opts ? opts.reapproval : REAPPROVAL,
    outcome: "outcome" in opts ? opts.outcome : supersededByPr116(),
    githubUser: "vibe-bot",
    ghFn: opts.ghFn ?? (() => Promise.resolve("[]")),
    deps: {
      ghClient: recordingClient(opts.recorder, opts.priorComments ?? []),
      ensureLabelExists: ensureOk,
      dedupAuthors: { fleetAuthors: ["vibe-bot"] },
      ...(opts.now ? { now: opts.now } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

Deno.test(
  "buildReapprovalSupersededEscalation - names the resolving PR, the re-approval and what to answer",
  () => {
    const escalation = buildReapprovalSupersededEscalation({
      issueNumber: 106,
      reapproval: REAPPROVAL,
      supersedingPrNumber: 116,
    });

    // The PR that resolved the issue, and when it merged.
    assertStringIncludes(escalation.reason, "PR #116");
    assertStringIncludes(escalation.reason, MERGED_AT);
    // Who re-approved it, with which label and when.
    assertStringIncludes(escalation.reason, "`work-on`");
    assertStringIncludes(escalation.reason, "@nleck");
    assertStringIncludes(escalation.reason, "2026-09-09T15:49:15.000Z");
    // Why nothing happened.
    assertStringIncludes(escalation.reason, "superseded");
    // The request: say what the re-approval should change.
    assertStringIncludes(
      escalation.nextStep,
      "Put it in the issue description",
    );
    assertStringIncludes(escalation.nextStep, "needs-human");
    assertStringIncludes(escalation.nextStep, "re-apply `work-on`");
    assertEquals(escalation.dedupKey, "reapproval-superseded-106");
  },
);

Deno.test(
  "buildReapprovalSupersededEscalation - names a superseding PR that differs from the pre-check's",
  () => {
    const escalation = buildReapprovalSupersededEscalation({
      issueNumber: 106,
      reapproval: REAPPROVAL,
      supersedingPrNumber: 131,
      supersedingPrUrl: "https://github.com/o/r/pull/131",
    });

    assertStringIncludes(escalation.reason, "PR #116");
    assertStringIncludes(escalation.reason, "PR #131");
    assertStringIncludes(escalation.reason, "https://github.com/o/r/pull/131");
  },
);

Deno.test(
  "buildReapprovalSupersededEscalation - does not repeat one PR as two facts",
  () => {
    const escalation = buildReapprovalSupersededEscalation({
      issueNumber: 106,
      reapproval: REAPPROVAL,
      supersedingPrNumber: 116,
    });

    assertEquals(escalation.reason.includes("The release named"), false);
  },
);

Deno.test(
  "buildReapprovalSupersededEscalation - an unusable re-approval time degrades to its raw form",
  () => {
    // A timestamp the API reported oddly must not take down the hand-off the
    // comment exists to deliver: both a non-finite value and a finite one
    // outside the Date range render raw.
    for (const addedAt of [Number.NaN, 8.64e18]) {
      const escalation = buildReapprovalSupersededEscalation({
        issueNumber: 106,
        reapproval: { ...REAPPROVAL, addedAt },
        supersedingPrNumber: 116,
      });
      assertStringIncludes(escalation.reason, String(addedAt));
      assertStringIncludes(escalation.reason, "PR #116");
    }
  },
);

Deno.test("reapprovalSupersededDedupKey - stable per issue", () => {
  assertEquals(reapprovalSupersededDedupKey(106), "reapproval-superseded-106");
  assertEquals(reapprovalSupersededDedupKey(7), "reapproval-superseded-7");
});

// ---------------------------------------------------------------------------
// The hand-off
// ---------------------------------------------------------------------------

Deno.test(
  "escalateReapprovalSuperseded - posts one marker-deduped comment and applies needs-human",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    const note = await runHandoff({ recorder });

    assertEquals(recorder.labels, [{ issue: 106, label: "needs-human" }]);
    assertEquals(recorder.comments.length, 1);
    const body = recorder.comments[0]!.body;
    assertStringIncludes(body, "Re-approved after the PR merged");
    assertStringIncludes(body, "PR #116");
    assertStringIncludes(body, "@nleck");
    assertStringIncludes(body, "**Next step:**");
    // The marker a second run recognises.
    assertStringIncludes(
      body,
      "<!-- needs-human-escalation: reapproval-superseded-106 -->",
    );
    // The claim-release comment says why the run produced nothing.
    assertStringIncludes(note ?? "", "PR #116");
    assertStringIncludes(note ?? "", "needs-human");
  },
);

Deno.test(
  "escalateReapprovalSuperseded - a second run posts no second comment",
  async () => {
    const first: Recorder = { labels: [], comments: [] };
    await runHandoff({ recorder: first });
    assertEquals(first.comments.length, 1);

    // The second run sees the first run's comment on the issue.
    const prior: GitHubComment = {
      id: 1,
      body: first.comments[0]!.body,
      author: "vibe-bot",
      createdAt: "2026-09-10T00:21:40Z",
      reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    };
    const second: Recorder = { labels: [], comments: [] };
    await runHandoff({
      recorder: second,
      priorComments: [prior],
      // Two hours later — the next cycle, inside the 24h dedup window.
      now: () => Date.parse("2026-09-10T02:33:34Z"),
    });

    assertEquals(second.comments.length, 0);
    // The label add stays idempotent, so a stripped label is re-applied.
    assertEquals(second.labels, [{ issue: 106, label: "needs-human" }]);
  },
);

Deno.test(
  "escalateReapprovalSuperseded - no re-approval leaves the ordinary superseded stop untouched",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    const ghCalls: string[][] = [];
    const note = await runHandoff({
      recorder,
      reapproval: undefined,
      ghFn: (args) => {
        ghCalls.push([...args]);
        return Promise.resolve("[]");
      },
    });

    assertEquals(note, null);
    assertEquals(recorder.comments.length, 0);
    assertEquals(recorder.labels.length, 0);
    assertEquals(ghCalls.length, 0);
  },
);

Deno.test(
  "escalateReapprovalSuperseded - a re-approved run that raised a PR is not handed off",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    const note = await runHandoff({
      recorder,
      outcome: {
        kind: "pr",
        prUrl: "https://github.com/stSoftwareAU/GRQ-AutoTrader/pull/131",
        prNumber: 131,
      },
    });

    assertEquals(note, null);
    assertEquals(recorder.comments.length, 0);
    assertEquals(recorder.labels.length, 0);
  },
);

Deno.test(
  "escalateReapprovalSuperseded - a re-approved run that failed is not handed off",
  async () => {
    const recorder: Recorder = { labels: [], comments: [] };
    const note = await runHandoff({
      recorder,
      outcome: {
        kind: "no_pr",
        category: "timeout",
        phase: "execute",
        elapsedSeconds: 3600,
        message: "Claude timed out",
      },
    });

    assertEquals(note, null);
    assertEquals(recorder.comments.length, 0);
  },
);

Deno.test(
  "escalateReapprovalSuperseded - a client that throws is reported, not raised",
  async () => {
    const throwing: GitHubClient = {
      ...recordingClient({ labels: [], comments: [] }),
      addLabel: () => Promise.reject(new Error("gh unavailable")),
      postComment: () => Promise.reject(new Error("gh unavailable")),
    };
    const note = await escalateReapprovalSuperseded({
      repo: "stSoftwareAU/GRQ-AutoTrader",
      issueNumber: 106,
      needsHumanLabel: "needs-human",
      reapproval: REAPPROVAL,
      outcome: supersededByPr116(),
      ghFn: () => Promise.resolve("[]"),
      deps: { ghClient: throwing, ensureLabelExists: ensureOk },
    });

    assertEquals(note, null);
  },
);

// ---------------------------------------------------------------------------
// The next scan
// ---------------------------------------------------------------------------

Deno.test(
  "the escalated issue is dropped by discovery on the next scan (Issue #1862)",
  () => {
    const labels = {
      failedLabel: LABEL_DEFAULTS.failedLabel,
      needsRevisionLabel: LABEL_DEFAULTS.needsRevisionLabel,
      refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel,
      planningLabel: LABEL_DEFAULTS.planningLabel,
      questionLabel: LABEL_DEFAULTS.questionLabel,
      needsHumanLabel: LABEL_DEFAULTS.needsHumanLabel,
    };
    const escalated = {
      number: 106,
      title: "web: PWA manifest and shell precaching service",
      labels: ["work-on", LABEL_DEFAULTS.needsHumanLabel],
      assignees: [],
      createdAt: "2026-09-01T00:00:00Z",
      body: "",
      url: "https://github.com/stSoftwareAU/GRQ-AutoTrader/issues/106",
      author: "nleck",
      milestone: "",
    };
    const stillClaimable = { ...escalated, number: 107, labels: ["work-on"] };

    const picked = filterAndSort([escalated, stillClaimable], labels);
    assertEquals(picked.map((i) => i.number), [107]);
  },
);
