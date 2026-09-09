/**
 * Tests for gated_head_guard.ts — standing down from a PR head that no
 * direct push can reach (Issue #1679).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  assessGatedHead,
  buildGatedHeadComment,
  buildMilestoneHeadComment,
  gatedHeadMarker,
  guardGatedHead,
  isMilestoneHead,
  milestoneHeadMarker,
  resetGatedHeadReportsForTest,
  standDownMilestoneHead,
} from "../lib/gated_head_guard.ts";
import type { Logger } from "../types.ts";

const MILESTONE_HEAD = "milestone/4690-bug-sampler-enospc";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** A `gh` stub answering the rules read and recording every call. */
function makeGh(
  responses: { rules?: unknown; comments?: unknown; throwOn?: string },
  calls: string[][] = [],
) {
  return {
    calls,
    run: (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (responses.throwOn && joined.includes(responses.throwOn)) {
        return Promise.reject(new Error("HTTP 500: upstream is unwell"));
      }
      if (joined.includes("rules/branches")) {
        return Promise.resolve(JSON.stringify(responses.rules ?? []));
      }
      if (joined.includes("pr view")) {
        return Promise.resolve(
          JSON.stringify({ comments: responses.comments ?? [] }),
        );
      }
      return Promise.resolve("");
    },
  };
}

// ---------------------------------------------------------------------------
// isMilestoneHead
// ---------------------------------------------------------------------------

Deno.test("isMilestoneHead - recognises a milestone collection branch", () => {
  assertEquals(isMilestoneHead(MILESTONE_HEAD), true);
  assertEquals(isMilestoneHead("issue-42-fix-bug"), false);
  assertEquals(isMilestoneHead("milestone/"), false);
  assertEquals(isMilestoneHead("feature/milestone/x"), false);
});

// ---------------------------------------------------------------------------
// assessGatedHead
// ---------------------------------------------------------------------------

Deno.test("assessGatedHead - a milestone head under required status checks is gated", async () => {
  const gh = makeGh({
    rules: [
      { type: "deletion" },
      { type: "required_status_checks", ruleset_id: 21835388 },
    ],
  });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, true);
  assertEquals(assessment.ruleTypes, ["required_status_checks"]);
  assertStringIncludes(assessment.detail, "required_status_checks");
});

Deno.test("assessGatedHead - a pull_request rule also gates the head", async () => {
  const gh = makeGh({ rules: [{ type: "pull_request" }] });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, true);
  assertEquals(assessment.ruleTypes, ["pull_request"]);
});

Deno.test("assessGatedHead - a milestone head with no gating rule is pushable", async () => {
  const gh = makeGh({ rules: [{ type: "deletion" }, { type: "creation" }] });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, false);
  assertEquals(assessment.ruleTypes, []);
});

Deno.test("assessGatedHead - an ordinary feature head is never assessed", async () => {
  const gh = makeGh({ rules: [{ type: "required_status_checks" }] });
  const assessment = await assessGatedHead("org/repo", "issue-42-fix", gh.run);
  assertEquals(assessment.gated, false);
  assertEquals(gh.calls.length, 0, "no API call is made for a feature head");
});

Deno.test("assessGatedHead - an unreadable ruleset fails open, naming the failure", async () => {
  const gh = makeGh({ throwOn: "rules/branches" });
  const assessment = await assessGatedHead("org/repo", MILESTONE_HEAD, gh.run);
  assertEquals(assessment.gated, false);
  assertStringIncludes(assessment.detail, "unreadable");
});

// ---------------------------------------------------------------------------
// guardGatedHead
// ---------------------------------------------------------------------------

Deno.test("guardGatedHead - a gated head is reported on the PR exactly once per run", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [{ type: "required_status_checks" }] });

  const first = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "spelling fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(first.gated, true);

  const comments = gh.calls.filter((args) =>
    args[0] === "pr" && args[1] === "comment"
  );
  assertEquals(comments.length, 1);
  assertStringIncludes(
    comments[0]!.join(" "),
    gatedHeadMarker(MILESTONE_HEAD),
  );

  // The CI-fix pass on the same PR in the same run stands down silently.
  const second = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "CI fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(second.gated, true);
  assertEquals(
    gh.calls.filter((args) => args[0] === "pr" && args[1] === "comment").length,
    1,
    "the stand-down is recorded once per PR, not once per pass",
  );
});

Deno.test("guardGatedHead - a PR that already carries the marker is not commented on again", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({
    rules: [{ type: "required_status_checks" }],
    comments: [{ body: `${gatedHeadMarker(MILESTONE_HEAD)}\nstood down` }],
  });

  const assessment = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "merge conflict",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(assessment.gated, true);
  assertEquals(
    gh.calls.some((args) => args[0] === "pr" && args[1] === "comment"),
    false,
    "an earlier run already recorded the stand-down",
  );
});

Deno.test("guardGatedHead - an unreadable comment thread posts nothing and says so", async () => {
  resetGatedHeadReportsForTest();
  const warnings: string[] = [];
  const logger = makeSilentLogger();
  logger.warn = (message: string) => warnings.push(message);
  const gh = makeGh({
    rules: [{ type: "required_status_checks" }],
    throwOn: "pr view",
  });

  const assessment = await guardGatedHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    pass: "spelling fix",
    logger,
    runGhCommand: gh.run,
  });
  assertEquals(assessment.gated, true);
  assertEquals(
    gh.calls.some((args) => args[0] === "pr" && args[1] === "comment"),
    false,
    "an unreadable thread must not become a duplicate comment",
  );
  assertEquals(
    warnings.some((w) =>
      w.includes("could not record") || w.includes("Could not record")
    ),
    true,
    "the failure to record is loud in the log",
  );
});

Deno.test("guardGatedHead - a pushable head is left alone", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [] });
  const assessment = await guardGatedHead({
    repo: "org/repo",
    prNumber: 7,
    branchName: "issue-7-fix",
    pass: "spelling fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });
  assertEquals(assessment.gated, false);
  assertEquals(gh.calls.length, 0);
});

// ---------------------------------------------------------------------------
// buildGatedHeadComment
// ---------------------------------------------------------------------------

Deno.test("buildGatedHeadComment - names the branch, the rule and the way forward", () => {
  const body = buildGatedHeadComment(MILESTONE_HEAD, {
    gated: true,
    detail:
      `a ruleset applies required_status_checks to '${MILESTONE_HEAD}', so every direct push is refused (GH013)`,
    ruleTypes: ["required_status_checks"],
  });
  assertStringIncludes(body, gatedHeadMarker(MILESTONE_HEAD));
  assertStringIncludes(body, MILESTONE_HEAD);
  assertStringIncludes(body, "required_status_checks");
  assertStringIncludes(body, "pull request");
});

// ---------------------------------------------------------------------------
// standDownMilestoneHead (Issue #1772)
// ---------------------------------------------------------------------------

Deno.test("standDownMilestoneHead - an ungated milestone head still stands down", async () => {
  // The sync owns `default -> milestone/*` whether or not a rule is in force,
  // so this reads the branch name and never the ruleset.
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [] });
  const stoodDown = await standDownMilestoneHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });

  assertEquals(stoodDown, true);
  assertEquals(
    gh.calls.some((args) => args.join(" ").includes("rules/branches")),
    false,
    "the branch name decides it — no rules read is needed",
  );
  const comments = gh.calls.filter((args) =>
    args[0] === "pr" && args[1] === "comment"
  );
  assertEquals(comments.length, 1);
  assertStringIncludes(
    comments[0]?.[comments[0].indexOf("--body") + 1] ?? "",
    "milestone branch sync",
  );
});

Deno.test("standDownMilestoneHead - an ordinary feature head is worked as before", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({ rules: [{ type: "required_status_checks" }] });
  const stoodDown = await standDownMilestoneHead({
    repo: "org/repo",
    prNumber: 7,
    branchName: "issue-7-fix",
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });

  assertEquals(stoodDown, false);
  assertEquals(gh.calls.length, 0);
});

Deno.test("standDownMilestoneHead - a PR already carrying the marker is not commented on again", async () => {
  resetGatedHeadReportsForTest();
  const gh = makeGh({
    comments: [{
      body: `${milestoneHeadMarker(MILESTONE_HEAD)}\nsaid already`,
    }],
  });
  const stoodDown = await standDownMilestoneHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });

  assertEquals(stoodDown, true);
  assertEquals(
    gh.calls.some((args) => args[0] === "pr" && args[1] === "comment"),
    false,
  );
});

Deno.test("standDownMilestoneHead - the gated-head stand-down does not mask it", async () => {
  // Two different stand-downs, two markers: a PR the CI-fix pass already
  // commented on as gated still gets the merge-conflict pass's own comment.
  resetGatedHeadReportsForTest();
  const gh = makeGh({
    comments: [{ body: gatedHeadMarker(MILESTONE_HEAD) }],
  });
  await standDownMilestoneHead({
    repo: "org/repo",
    prNumber: 4702,
    branchName: MILESTONE_HEAD,
    logger: makeSilentLogger(),
    runGhCommand: gh.run,
  });

  assertEquals(
    gh.calls.filter((args) => args[0] === "pr" && args[1] === "comment").length,
    1,
  );
});

Deno.test("buildMilestoneHeadComment - names the branch and the sync that owns it", () => {
  const body = buildMilestoneHeadComment(MILESTONE_HEAD);
  assertStringIncludes(body, milestoneHeadMarker(MILESTONE_HEAD));
  assertStringIncludes(body, MILESTONE_HEAD);
  assertStringIncludes(body, "milestone branch sync");
  assertStringIncludes(body, "no resolution attempt is spent");
});
