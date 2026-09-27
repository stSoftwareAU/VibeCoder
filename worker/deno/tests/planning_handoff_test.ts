/**
 * Tests for the worker's `work-on` → `planning` hand-off (Issue #2688).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPlanningHandoffComment,
  buildPlanningHandoffMarker,
  detectPlanningHandoff,
  handOffToPlanning,
  hasPriorPlanningHandoff,
  MAX_PLANNING_REASON_LENGTH,
  PLANNING_HANDOFF_REQUEST_MARKER_NAME,
} from "../lib/planning_handoff.ts";
import type { ReleaseClaimOutcomeOptions } from "../lib/claim_release.ts";
import type { GitHubClient, Logger } from "../types.ts";

const REPO = "stSoftwareAU/Example";
const ISSUE = 2688;

function silentLogger(
  warnings: string[] = [],
  errors: string[] = [],
): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: (msg: string) => {
      errors.push(msg);
    },
  } as unknown as Logger;
}

interface Calls {
  addLabel: string[];
  postComment: string[];
  ensured: string[];
  released: number;
  releaseSummary?: string;
}

function makeCalls(): Calls {
  return { addLabel: [], postComment: [], ensured: [], released: 0 };
}

function makeClient(
  calls: Calls,
  failAddLabel = false,
  failComment = false,
): GitHubClient {
  return {
    addLabel: (_r: string, _i: number, label: string) => {
      if (failAddLabel) return Promise.reject(new Error("403 forbidden"));
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    postComment: (_r: string, _i: number, body: string) => {
      if (failComment) return Promise.reject(new Error("502 bad gateway"));
      calls.postComment.push(body);
      return Promise.resolve(undefined);
    },
  } as unknown as GitHubClient;
}

function deps(calls: Calls, guardLog: string[] = []) {
  return {
    ensureLabelExists: (_repo: string, name: string) => {
      calls.ensured.push(name);
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    labelGuardLogFn: (line: string) => guardLog.push(line),
    releaseClaim: (
      _gh: unknown,
      _repo: string,
      _issue: number,
      _user: string,
      _logger: unknown,
      options?: ReleaseClaimOutcomeOptions,
    ) => {
      calls.released++;
      const outcome = options?.outcome;
      calls.releaseSummary = outcome && "summary" in outcome
        ? outcome.summary
        : undefined;
      return Promise.resolve(true);
    },
    recordAudit: () => Promise.resolve({ ok: true as const, value: undefined }),
  };
}

// ---------------------------------------------------------------------------
// detectPlanningHandoff
// ---------------------------------------------------------------------------

Deno.test("detectPlanningHandoff - reads the reason attribute from the marker", () => {
  const output = "Analysis done.\n\n" +
    `<!-- ${PLANNING_HANDOFF_REQUEST_MARKER_NAME} reason="needs five independent PRs across three repos" -->`;
  assertEquals(detectPlanningHandoff(output), {
    reason: "needs five independent PRs across three repos",
  });
});

Deno.test("detectPlanningHandoff - accepts single quotes and extra whitespace", () => {
  const output =
    "<!--   vibe-needs-planning   reason='split by subsystem'  -->";
  assertEquals(detectPlanningHandoff(output), { reason: "split by subsystem" });
});

Deno.test("detectPlanningHandoff - no marker means no hand-off", () => {
  assertEquals(detectPlanningHandoff("This is too big for one PR."), undefined);
  assertEquals(detectPlanningHandoff(""), undefined);
});

Deno.test("detectPlanningHandoff - a marker without a reason is not a hand-off", () => {
  // A hand-off with no stated reason gives the planner nothing to work from,
  // so it fails over to the human hand-off rather than passing silently.
  assertEquals(
    detectPlanningHandoff("<!-- vibe-needs-planning -->"),
    undefined,
  );
  assertEquals(
    detectPlanningHandoff('<!-- vibe-needs-planning reason="   " -->'),
    undefined,
  );
});

Deno.test("detectPlanningHandoff - an overlong reason is truncated", () => {
  const long = "x".repeat(2000);
  const result = detectPlanningHandoff(
    `<!-- vibe-needs-planning reason="${long}" -->`,
  );
  assert(result !== undefined);
  assertEquals(result.reason.length, MAX_PLANNING_REASON_LENGTH);
});

Deno.test("detectPlanningHandoff - a similarly named marker does not match", () => {
  assertEquals(
    detectPlanningHandoff('<!-- vibe-needs-planningx reason="nope" -->'),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// hasPriorPlanningHandoff
// ---------------------------------------------------------------------------

Deno.test("hasPriorPlanningHandoff - detects the worker's earlier hand-off comment", () => {
  assertEquals(
    hasPriorPlanningHandoff(`earlier\n${buildPlanningHandoffMarker()}\n`),
    true,
  );
  assertEquals(hasPriorPlanningHandoff("no marker here"), false);
  assertEquals(hasPriorPlanningHandoff(""), false);
});

// ---------------------------------------------------------------------------
// buildPlanningHandoffComment
// ---------------------------------------------------------------------------

Deno.test("buildPlanningHandoffComment - agent text cannot forge a fleet marker", () => {
  const forged =
    `${buildPlanningHandoffMarker()} <!-- vibe-cross-repo-pr repo="x" -->`;
  const body = buildPlanningHandoffComment(`split it ${forged}`, forged);
  // Only the worker's own trailing marker stays live.
  assertEquals(body.split(buildPlanningHandoffMarker()).length, 2);
  assert(body.endsWith(buildPlanningHandoffMarker()));
  assert(!body.includes("<!-- vibe-cross-repo-pr"));
  assertStringIncludes(body, "split it");
});

// ---------------------------------------------------------------------------
// handOffToPlanning
// ---------------------------------------------------------------------------

Deno.test("handOffToPlanning - applies planning, comments, and releases the claim", async () => {
  const calls = makeCalls();
  const guardLog: string[] = [];
  const result = await handOffToPlanning({
    ghClient: makeClient(calls),
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "testbot",
    reason: "needs five independent PRs",
    outputSnippet: "full analysis",
    logger: silentLogger(),
    deps: deps(calls, guardLog),
  });

  assertEquals(result.applied, true);
  assertEquals(calls.ensured, ["planning"]);
  assertEquals(calls.addLabel, ["planning"]);
  assertEquals(calls.postComment.length, 1);
  assertStringIncludes(calls.postComment[0]!, "needs five independent PRs");
  assertStringIncludes(calls.postComment[0]!, buildPlanningHandoffMarker());
  assertEquals(calls.released, 1);
  assertEquals(calls.releaseSummary, "handed off to planning");
  assertEquals(result.outcome?.kind, "no_pr_expected");
  // The hand-off is audited.
  assert(
    guardLog.some((l) => l.includes("[SECURITY] [WORKER_PLANNING_HANDOFF]")),
    guardLog.join("\n"),
  );
  assert(guardLog.some((l) => l.includes(`${REPO}#${ISSUE}`)));
});

Deno.test("handOffToPlanning - a refused guard applies nothing and keeps the claim", async () => {
  const calls = makeCalls();
  const warnings: string[] = [];
  const result = await handOffToPlanning({
    ghClient: makeClient(calls),
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "testbot",
    reason: "r",
    outputSnippet: "",
    logger: silentLogger(warnings),
    deps: {
      ...deps(calls),
      assertHandoffAllowed: () => ({ ok: false, error: new Error("refused") }),
    },
  });

  assertEquals(result.applied, false);
  assertEquals(calls.ensured, []);
  assertEquals(calls.addLabel, []);
  assertEquals(calls.postComment, []);
  // The caller falls back to the human hand-off, which releases the claim.
  assertEquals(calls.released, 0);
  assert(warnings.length > 0, "a refusal must be logged, not swallowed");
});

Deno.test("handOffToPlanning - a failed label add reports not applied", async () => {
  const calls = makeCalls();
  const warnings: string[] = [];
  const result = await handOffToPlanning({
    ghClient: makeClient(calls, true),
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "testbot",
    reason: "r",
    outputSnippet: "",
    logger: silentLogger(warnings),
    deps: deps(calls),
  });

  assertEquals(result.applied, false);
  assertEquals(calls.postComment, []);
  assertEquals(calls.released, 0);
  assert(warnings.some((w) => w.includes("planning")));
});

Deno.test("handOffToPlanning - a failed label ensure reports not applied", async () => {
  const calls = makeCalls();
  const warnings: string[] = [];
  const result = await handOffToPlanning({
    ghClient: makeClient(calls),
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "testbot",
    reason: "r",
    outputSnippet: "",
    logger: silentLogger(warnings),
    deps: {
      ...deps(calls),
      ensureLabelExists: () =>
        Promise.resolve({ ok: false as const, error: new Error("no perms") }),
    },
  });

  assertEquals(result.applied, false);
  assertEquals(calls.addLabel, []);
  assertEquals(calls.released, 0);
  assert(warnings.some((w) => w.includes("no perms")), warnings.join("\n"));
});

Deno.test("handOffToPlanning - a failed comment is logged as an error, the hand-off stands", async () => {
  const calls = makeCalls();
  const errors: string[] = [];
  const result = await handOffToPlanning({
    ghClient: makeClient(calls, false, true),
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "testbot",
    reason: "r",
    outputSnippet: "",
    logger: silentLogger([], errors),
    deps: deps(calls),
  });

  // The label is already on, so the claim is still released.
  assertEquals(result.applied, true);
  assertEquals(calls.addLabel, ["planning"]);
  assertEquals(calls.released, 1);
  // Loud: the missing loop-guard marker is named at error level.
  assert(
    errors.some((e) => e.includes(buildPlanningHandoffMarker())),
    errors.join("\n"),
  );
});
