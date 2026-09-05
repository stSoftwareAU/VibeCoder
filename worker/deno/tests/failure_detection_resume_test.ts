/**
 * Tests for the Failure-Detection repair **resume pass** (Issue #60, part of
 * #54).
 *
 * Covers the four behaviours that make the partial-repair state honest:
 *   (a) label discovery — the finder lists open parents carrying
 *       `needs-failure-detection-repair` across the configured repositories;
 *   (b) the idempotent re-gate — a parent whose sub-issues were fixed by hand
 *       between runs costs **zero** Claude calls and simply loses the label;
 *   (c) label removal on a clean pass — repaired offenders clear the label and
 *       a confirmation comment is posted;
 *   (d) bounded retries — a parent that has already burnt its attempts
 *       escalates through the existing `needs-human` path instead of looping.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";
import { findFailureDetectionRepairParents } from "../lib/find_failure_detection_repair_issues.ts";
import {
  buildResumeAttemptMarker,
  countRecordedResumeAttempts,
  MAX_FAILURE_DETECTION_RESUME_ATTEMPTS,
  resumeFailureDetectionRepair,
  runFailureDetectionResumePass,
} from "../lib/failure_detection_resume.ts";
import { FAILURE_DETECTION_REPAIR_LABEL } from "../lib/config_defaults.ts";
import type { RepairClaudeResult } from "../lib/failure_detection_repair.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    security() {},
    skipReason() {},
    timing() {},
  } as unknown as Logger;
}

/** A body carrying a filled `## Failure Detection` section (passes the gate). */
function passingBody(): string {
  return [
    "## Summary",
    "Add the widget.",
    "",
    "## Failure Detection",
    "`tests/widget_test.ts::renders` fails if the widget regresses.",
  ].join("\n");
}

/** A body with no `## Failure Detection` section at all (an offender). */
function offendingBody(): string {
  return ["## Summary", "Add the widget."].join("\n");
}

interface GhStubOptions {
  /** Native sub-issue numbers returned for the parent. */
  subIssueNumbers: number[];
  /** Body returned per sub-issue number. */
  bodies: Record<number, string>;
  /** Sub-issues whose `gh issue edit` should fail. */
  failEditFor?: number[];
}

/** A `gh` stub covering the sub-issue enumeration, reads and edits. */
function ghStub(options: GhStubOptions, calls: string[][]) {
  const bodies = { ...options.bodies };
  return (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && (args[1] ?? "").includes("/sub_issues")) {
      return Promise.resolve(
        JSON.stringify(options.subIssueNumbers.map((n) => ({ number: n }))),
      );
    }
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      return Promise.resolve(
        JSON.stringify({
          number,
          title: `Sub-issue ${number}`,
          body: bodies[number] ?? "",
        }),
      );
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const number = Number(args[2]);
      if (options.failEditFor?.includes(number)) {
        return Promise.reject(new Error("gh edit failed"));
      }
      const bodyIndex = args.indexOf("--body");
      bodies[number] = args[bodyIndex + 1] ?? "";
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
}

interface ClientRecorder {
  comments: string[];
  labelsAdded: string[];
  labelsRemoved: string[];
}

function fakeClient(
  recorder: ClientRecorder,
  existingComments: GitHubComment[] = [],
): GitHubClient {
  return {
    getIssueComments: () => Promise.resolve(existingComments),
    postComment: (_repo: string, _n: number, body: string) => {
      recorder.comments.push(body);
      return Promise.resolve(undefined);
    },
    addLabel: (_repo: string, _n: number, label: string) => {
      recorder.labelsAdded.push(label);
      return Promise.resolve();
    },
    removeLabel: (_repo: string, _n: number, label: string) => {
      recorder.labelsRemoved.push(label);
      return Promise.resolve();
    },
  } as unknown as GitHubClient;
}

/**
 * The fleet login every fixture comment is authored by — an attempt marker
 * only counts when a fleet account recorded it (the planted-marker case is
 * in `tests/untrusted_marker_action_verification_test.ts`).
 */
const FLEET_AUTHOR = "vibe-coder";

function comment(body: string): GitHubComment {
  return {
    id: 1,
    body,
    author: FLEET_AUTHOR,
    createdAt: new Date(0).toISOString(),
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

/** A Claude runner that drafts a passing section and counts its calls. */
function draftingClaude(counter: { calls: number }) {
  return (_prompt: string): Promise<Result<RepairClaudeResult>> => {
    counter.calls++;
    return Promise.resolve({
      ok: true as const,
      value: {
        output:
          "## Failure Detection\n\n`tests/widget_test.ts::renders` fails on regression.",
      },
    });
  };
}

/** A Claude runner that always drafts an unusable (empty) section. */
function failingClaude(counter: { calls: number }) {
  return (_prompt: string): Promise<Result<RepairClaudeResult>> => {
    counter.calls++;
    return Promise.resolve({ ok: true as const, value: { output: "" } });
  };
}

/** A Claude runner that fails the test if it is ever invoked. */
function forbiddenClaude(counter: { calls: number }) {
  return (_prompt: string): Promise<Result<RepairClaudeResult>> => {
    counter.calls++;
    return Promise.resolve({ ok: true as const, value: { output: "" } });
  };
}

// ---------------------------------------------------------------------------
// (a) Label discovery
// ---------------------------------------------------------------------------

Deno.test("findFailureDetectionRepairParents - lists open parents carrying the label in every configured repo", async () => {
  const seen: string[][] = [];
  const parents = await findFailureDetectionRepairParents({
    repos: ["owner/alpha", "owner/beta"],
    ghCommandFn: (args) => {
      seen.push(args);
      const repo = args[args.indexOf("--repo") + 1];
      if (repo === "owner/alpha") {
        return Promise.resolve(
          JSON.stringify([{ number: 842, title: "Plan the widget" }]),
        );
      }
      return Promise.resolve(
        JSON.stringify([{ number: 7, title: "Plan two" }]),
      );
    },
    logger: silentLogger(),
  });

  assertEquals(parents, [
    { repo: "owner/alpha", number: 842, title: "Plan the widget" },
    { repo: "owner/beta", number: 7, title: "Plan two" },
  ]);
  // Every listing is scoped to open issues carrying the resume label.
  for (const args of seen) {
    assert(args.includes("--state"));
    assertEquals(args[args.indexOf("--state") + 1], "open");
    assertEquals(
      args[args.indexOf("--label") + 1],
      FAILURE_DETECTION_REPAIR_LABEL,
    );
  }
});

Deno.test("findFailureDetectionRepairParents - a failing repo never hides the others", async () => {
  const parents = await findFailureDetectionRepairParents({
    repos: ["owner/broken", "owner/good"],
    ghCommandFn: (args) => {
      const repo = args[args.indexOf("--repo") + 1];
      if (repo === "owner/broken") return Promise.reject(new Error("boom"));
      return Promise.resolve(JSON.stringify([{ number: 3, title: "Plan" }]));
    },
    logger: silentLogger(),
  });

  assertEquals(parents.map((p) => p.number), [3]);
});

Deno.test("findFailureDetectionRepairParents - skips malformed repo names and malformed responses", async () => {
  const parents = await findFailureDetectionRepairParents({
    repos: ["not-a-repo", "owner/good"],
    ghCommandFn: () => Promise.resolve("not json"),
    logger: silentLogger(),
  });

  assertEquals(parents, []);
});

// ---------------------------------------------------------------------------
// (b) Idempotent re-gate — zero Claude calls
// ---------------------------------------------------------------------------

Deno.test("resumeFailureDetectionRepair - a parent fixed by hand costs zero Claude calls and loses the label", async () => {
  const calls: string[][] = [];
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const claude = { calls: 0 };

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder),
    ghCommandFn: ghStub(
      {
        subIssueNumbers: [842, 843],
        bodies: { 842: passingBody(), 843: passingBody() },
      },
      calls,
    ),
    runClaude: forbiddenClaude(claude),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(claude.calls, 0, "no Claude call for an already-clean parent");
  assertEquals(outcome.status, "already-clean");
  assertEquals(outcome.labelCleared, true);
  assertEquals(recorder.labelsRemoved, [FAILURE_DETECTION_REPAIR_LABEL]);
  assertEquals(recorder.labelsAdded, []);
  assertEquals(recorder.comments.length, 1);
  assertStringIncludes(recorder.comments[0]!, "Failure Detection");
});

// ---------------------------------------------------------------------------
// (c) Repair + label removal on a clean pass
// ---------------------------------------------------------------------------

Deno.test("resumeFailureDetectionRepair - repairs the still-offending sub-issue and clears the label", async () => {
  const calls: string[][] = [];
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const claude = { calls: 0 };

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder),
    ghCommandFn: ghStub(
      {
        subIssueNumbers: [842, 843],
        bodies: { 842: passingBody(), 843: offendingBody() },
      },
      calls,
    ),
    runClaude: draftingClaude(claude),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(outcome.status, "repaired");
  // Only the still-offending sub-issue is repaired — #842 already passes.
  assertEquals(outcome.offenders, [843]);
  assertEquals(outcome.repaired, [843]);
  assertEquals(outcome.unresolved, []);
  assertEquals(recorder.labelsRemoved, [FAILURE_DETECTION_REPAIR_LABEL]);
  const edits = calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertEquals(edits.length, 1);
  assertEquals(edits[0]![2], "843");
  assertStringIncludes(recorder.comments[0]!, "#843");
});

Deno.test("resumeFailureDetectionRepair - an un-repairable sub-issue keeps the label and records the attempt", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const claude = { calls: 0 };

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder),
    ghCommandFn: ghStub(
      { subIssueNumbers: [843], bodies: { 843: offendingBody() } },
      [],
    ),
    runClaude: failingClaude(claude),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(outcome.status, "outstanding");
  assertEquals(outcome.unresolved, [843]);
  assertEquals(outcome.labelCleared, false);
  assertEquals(recorder.labelsRemoved, []);
  assertEquals(recorder.labelsAdded, []);
  // The attempt is recorded on the parent so the next cycle's retry is bounded.
  assertStringIncludes(recorder.comments[0]!, buildResumeAttemptMarker(1));
});

// ---------------------------------------------------------------------------
// (d) Bounded retries → `needs-human`
// ---------------------------------------------------------------------------

Deno.test("countRecordedResumeAttempts - reads the highest recorded attempt", () => {
  assertEquals(countRecordedResumeAttempts([]), 0);
  assertEquals(
    countRecordedResumeAttempts([
      comment(`still offending ${buildResumeAttemptMarker(1)}`),
      comment("unrelated chatter"),
      comment(`still offending ${buildResumeAttemptMarker(2)}`),
    ]),
    2,
  );
});

Deno.test("resumeFailureDetectionRepair - a spent retry budget escalates to needs-human instead of looping", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const claude = { calls: 0 };
  const spent = Array.from(
    { length: MAX_FAILURE_DETECTION_RESUME_ATTEMPTS },
    (_, i) => comment(`attempt ${buildResumeAttemptMarker(i + 1)}`),
  );

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder, spent),
    ghCommandFn: ghStub(
      { subIssueNumbers: [843], bodies: { 843: offendingBody() } },
      [],
    ),
    runClaude: forbiddenClaude(claude),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
    // Stubbed so the escalation never reaches the network from a unit test.
    escalationDeps: {
      github: {
        ensureLabelExists: () =>
          Promise.resolve({ ok: true, value: undefined }),
      },
    },
  });

  assertEquals(outcome.status, "escalated");
  assertEquals(claude.calls, 0, "a spent budget never spends another repair");
  assert(
    recorder.labelsAdded.includes("needs-human"),
    "the existing needs-human path is used",
  );
  // The resume label is dropped so the pass stops re-picking an escalated parent.
  assertEquals(recorder.labelsRemoved, [FAILURE_DETECTION_REPAIR_LABEL]);
  assertStringIncludes(recorder.comments.join("\n"), "#843");
});

Deno.test("resumeFailureDetectionRepair - budget-deferred offenders do not burn a retry attempt", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const claude = { calls: 0 };

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder),
    ghCommandFn: ghStub(
      { subIssueNumbers: [843], bodies: { 843: offendingBody() } },
      [],
    ),
    runClaude: forbiddenClaude(claude),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
    // A deadline already in the past: no repair can be afforded.
    deadlineMs: 0,
    now: () => 1_000,
  });

  assertEquals(outcome.status, "outstanding");
  assertEquals(claude.calls, 0);
  assertEquals(recorder.labelsRemoved, []);
  assert(
    !recorder.comments.join("\n").includes(buildResumeAttemptMarker(1)),
    "a deferred offender was never attempted, so it must not spend an attempt",
  );
});

Deno.test("resumeFailureDetectionRepair - a parent whose sub-issues cannot be enumerated keeps the label and spends an attempt", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder),
    // No native sub-issues: indistinguishable from a failed API read, so the
    // label must never be cleared on this path.
    ghCommandFn: ghStub({ subIssueNumbers: [], bodies: {} }, []),
    runClaude: forbiddenClaude({ calls: 0 }),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(outcome.status, "outstanding");
  assertEquals(recorder.labelsRemoved, []);
  assertStringIncludes(recorder.comments[0]!, buildResumeAttemptMarker(1));
});

Deno.test("resumeFailureDetectionRepair - repeated enumeration failure escalates rather than looping", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const spent = Array.from(
    { length: MAX_FAILURE_DETECTION_RESUME_ATTEMPTS },
    (_, i) => comment(`attempt ${buildResumeAttemptMarker(i + 1)}`),
  );

  const outcome = await resumeFailureDetectionRepair({
    repo: "owner/repo",
    parentIssueNumber: 100,
    ghClient: fakeClient(recorder, spent),
    ghCommandFn: ghStub({ subIssueNumbers: [], bodies: {} }, []),
    runClaude: forbiddenClaude({ calls: 0 }),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
    escalationDeps: {
      github: {
        ensureLabelExists: () =>
          Promise.resolve({ ok: true, value: undefined }),
      },
    },
  });

  assertEquals(outcome.status, "escalated");
  assert(recorder.labelsAdded.includes("needs-human"));
  assertEquals(recorder.labelsRemoved, [FAILURE_DETECTION_REPAIR_LABEL]);
});

// ---------------------------------------------------------------------------
// The pass over every configured repository
// ---------------------------------------------------------------------------

Deno.test("runFailureDetectionResumePass - processes discovered parents up to the per-cycle bound", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
  const claude = { calls: 0 };

  const result = await runFailureDetectionResumePass({
    repos: ["owner/alpha"],
    ghClient: fakeClient(recorder),
    ghCommandFn: (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([
            { number: 100, title: "Plan one" },
            { number: 101, title: "Plan two" },
          ]),
        );
      }
      return ghStub(
        { subIssueNumbers: [842], bodies: { 842: passingBody() } },
        [],
      )(args);
    },
    runClaude: forbiddenClaude(claude),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
    maxParentsPerCycle: 1,
  });

  assertEquals(result.parentsFound, 2);
  assertEquals(result.outcomes.length, 1, "bounded to one parent per cycle");
  assertEquals(result.outcomes[0]!.status, "already-clean");
  assertEquals(claude.calls, 0);
});

Deno.test("runFailureDetectionResumePass - no labelled parents is a clean no-op", async () => {
  const recorder: ClientRecorder = {
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
  };

  const result = await runFailureDetectionResumePass({
    repos: ["owner/alpha"],
    ghClient: fakeClient(recorder),
    ghCommandFn: () => Promise.resolve("[]"),
    runClaude: forbiddenClaude({ calls: 0 }),
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(result.parentsFound, 0);
  assertEquals(result.outcomes, []);
  assertEquals(recorder.comments, []);
});
