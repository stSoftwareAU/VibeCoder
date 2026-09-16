/**
 * Issue #2220: a repo-level milestone-branch refusal is categorised
 * `repo_config`, never labels the issue, and releases the labels it left
 * behind once the branch exists.
 *
 * GRQ-FX-validation, milestone `Scan 20260910`, 2026-09-12 to 2026-09-15:
 * sixteen sub-issues died in `setup` with `**Category:** unknown`, six of
 * them reaching `failed`. The ruleset was repaired at 2026-09-15 11:52 UTC
 * and nothing released them.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectFailureCategory,
  getFailureCategoryDisplay,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
  isInfrastructureFailure,
  normaliseFailureCategory,
} from "../lib/failure_diagnosis.ts";
import {
  isRepoLevelBranchRejection,
  isRepoLevelMilestoneBranchRefusal,
} from "../lib/milestone_branch_rejection.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import {
  buildRefusalReleaseComment,
  refusalIsMostRecentFailure,
  releaseMilestoneBranchRefusalLabels,
  resetMilestoneBranchRefusalSweepsForTest,
} from "../lib/milestone_branch_refusal_release.ts";

/** The exact GH013 message from the issue report. */
const GH013 = [
  "remote: error: GH013: Repository rule violations found for refs/heads/milestone/scan-20260910.",
  "remote: - 5 of 6 required status checks are expected.",
  "! [remote rejected] origin/Develop -> milestone/scan-20260910",
].join("\n");

/** The reason the setup phase actually returns around that git error. */
const SETUP_REASON =
  "Failed to ensure milestone branch 'milestone/scan-20260910' for " +
  `milestone 'Scan 20260910': Failed to push milestone branch ` +
  `milestone/scan-20260910 to origin from Develop: ${GH013}`;

const REPO = "stSoftwareAU/GRQ-FX-validation";
const MILESTONE = "Scan 20260910";
const BRANCH = "milestone/scan-20260910";

// ===========================================================================
// detectFailureCategory (acceptance: the GH013 message is not `unknown`)
// ===========================================================================

Deno.test("refusal release - the exact GH013 message is categorised repo_config, not unknown (Issue #2220)", () => {
  assertEquals(detectFailureCategory(GH013), "repo_config");
  assertEquals(detectFailureCategory(SETUP_REASON), "repo_config");
});

Deno.test("refusal release - a repo-level milestone refusal needs BOTH a repo-level signature and a milestone branch (Issue #2220)", () => {
  // Repo-level, but the branch is an ordinary feature branch: still a push
  // failure with its bounded infrastructure retry, not a repository fault.
  const featureBranch =
    "Git push failed: remote: error: GH006: Protected branch update failed " +
    "for refs/heads/issue-42-add-parser.";
  assertEquals(isRepoLevelBranchRejection(featureBranch), true);
  assertEquals(isRepoLevelMilestoneBranchRefusal(featureBranch), false);
  assertEquals(detectFailureCategory(featureBranch), "push_failure");

  // A milestone branch named in a message with no refusal signature at all.
  const noRefusal =
    "Git push failed: could not resolve host github.com while pushing " +
    "milestone/scan-20260910";
  assertEquals(isRepoLevelMilestoneBranchRefusal(noRefusal), false);
  assertEquals(detectFailureCategory(noRefusal), "push_failure");
});

Deno.test("refusal release - repo_config is not an infrastructure failure and has its own display (Issue #2220)", () => {
  assertEquals(isInfrastructureFailure("repo_config"), false);
  assertEquals(getFailureCategoryDisplay("repo_config"), "repo-config");
  assertEquals(normaliseFailureCategory("repo_config"), "repo_config");
  assertStringIncludes(
    getFailureDiagnosis("repo_config"),
    "repository configuration",
  );
  assertStringIncludes(
    getFailureDiagnosisOneliner("repo_config"),
    "Repository configuration refused the milestone branch",
  );
});

Deno.test("refusal release - a repo_config failure is never auto-filed as a worker defect (Issue #2220)", () => {
  const classification = classifyRunFailure("repo_config", SETUP_REASON);
  assertEquals(classification.fixability, "not_code_fixable");
  assertEquals(classification.failureClass, "repo-config");
});

// ===========================================================================
// handleIssueFailure (acceptance: never adds failed-once or failed)
// ===========================================================================

/** Record every gh invocation so the test can assert what was NOT run. */
function recordingGh(): {
  calls: string[][];
  fn: (a: string[]) => Promise<string>;
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

Deno.test("refusal release - handleIssueFailure adds no failed-once/failed label for a milestone refusal (Issue #2220)", async () => {
  const gh = recordingGh();
  const result = await handleIssueFailure({
    repo: REPO,
    issueNumber: 123,
    githubUser: "VibeCoderST",
    failureMessage: SETUP_REASON,
  }, { ghCommandFn: gh.fn });

  assert(result.ok);
  assertEquals(result.value.failureCategory, "repo_config");
  assertEquals(result.value.markedAsFailedOnce, false);
  assertEquals(result.value.markedAsFailed, false);
  assertEquals(result.value.isInfrastructure, false);

  const flat = gh.calls.map((c) => c.join(" "));
  assert(
    !flat.some((c) => c.includes("--add-label")),
    `no label may be added: ${flat.join(" | ")}`,
  );
  const comment = gh.calls.find((c) => c[1] === "comment");
  assert(comment, "the refusal must still be recorded in a comment");
  const body = comment[comment.length - 1] ?? "";
  assertStringIncludes(body, "`repo-config`");
  assertStringIncludes(body, "still claimable");
});

Deno.test("refusal release - an ordinary failure still enters the failed-once ladder (Issue #2220)", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    // No failed-once label yet, and no prior failure comments.
    if (args[1] === "view") return Promise.resolve("");
    return Promise.resolve("");
  };
  const result = await handleIssueFailure({
    repo: REPO,
    issueNumber: 124,
    githubUser: "VibeCoderST",
    failureMessage: "Changes were made but quality checks failed",
  }, { ghCommandFn: gh });

  assert(result.ok);
  assertEquals(result.value.failureCategory, "quality_check");
  assertEquals(result.value.markedAsFailedOnce, true);
});

// ===========================================================================
// refusalIsMostRecentFailure
// ===========================================================================

const REFUSAL_COMMENT =
  `## Automated Processing Failed (First Attempt)\n\n**Category:** \`unknown\`\n\n` +
  `### Error Output\n> ${SETUP_REASON}\n`;

const QUALITY_COMMENT =
  `## Automated Processing Failed (First Attempt)\n\n**Category:** ` +
  `\`quality-failure\`\n\n### Error Output\n> ./quality.sh failed\n`;

Deno.test("refusalIsMostRecentFailure - the refusal record releases, a newer genuine failure does not (Issue #2220)", () => {
  assertEquals(refusalIsMostRecentFailure(["chatter", REFUSAL_COMMENT]), true);
  // A genuine failure AFTER the refusal is the issue's own fault — keep it.
  assertEquals(
    refusalIsMostRecentFailure(["chatter", REFUSAL_COMMENT, QUALITY_COMMENT]),
    false,
  );
  // A refusal after a genuine failure releases: the newest record wins.
  assertEquals(
    refusalIsMostRecentFailure([QUALITY_COMMENT, REFUSAL_COMMENT]),
    true,
  );
  // Non-failure chatter never decides anything.
  assertEquals(refusalIsMostRecentFailure(["hello", "world"]), false);
  assertEquals(refusalIsMostRecentFailure([]), false);
});

Deno.test("refusalIsMostRecentFailure - the escalation comment counts as the refusal record (Issue #2220)", () => {
  const escalation = `## Milestone branch unavailable\n\n**Why:** This issue ` +
    `belongs to milestone '${MILESTONE}', but its milestone branch ` +
    `\`${BRANCH}\` could not be created or fetched: ${GH013}`;
  assertEquals(refusalIsMostRecentFailure([escalation]), true);
});

// ===========================================================================
// releaseMilestoneBranchRefusalLabels
// ===========================================================================

interface FakeIssue {
  number: number;
  labels: string[];
  comments: string[];
}

/** Drive the sweep against an in-memory repository. */
function fakeGh(issues: FakeIssue[]) {
  const calls: string[][] = [];
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list") {
      const label = args[args.indexOf("--label") + 1];
      const matching = issues.filter((i) => i.labels.includes(label ?? ""));
      return Promise.resolve(JSON.stringify(
        matching.map((i) => ({
          number: i.number,
          labels: i.labels.map((name) => ({ name })),
        })),
      ));
    }
    if (args[1] === "view") {
      const issue = byNumber.get(Number(args[2]));
      return Promise.resolve(JSON.stringify({
        comments: (issue?.comments ?? []).map((body) => ({ body })),
      }));
    }
    if (args[1] === "edit") {
      const issue = byNumber.get(Number(args[2]));
      if (issue) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--remove-label") {
            issue.labels = issue.labels.filter((l) => l !== args[i + 1]);
          }
        }
      }
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { calls, fn, byNumber };
}

Deno.test("releaseMilestoneBranchRefusalLabels - releases the refusal's issues and keeps genuine failures (Issue #2220)", async () => {
  resetMilestoneBranchRefusalSweepsForTest();
  const issues: FakeIssue[] = [
    // Refused twice — reached `failed`.
    { number: 123, labels: ["failed", "bug"], comments: [REFUSAL_COMMENT] },
    // Refused once.
    { number: 129, labels: ["failed-once"], comments: [REFUSAL_COMMENT] },
    // Genuinely failed its quality gate — must keep its label.
    { number: 150, labels: ["failed-once"], comments: [QUALITY_COMMENT] },
  ];
  const gh = fakeGh(issues);

  const outcome = await releaseMilestoneBranchRefusalLabels({
    repo: REPO,
    milestoneTitle: MILESTONE,
    milestoneBranch: BRANCH,
    ghCommandFn: gh.fn,
  });

  assertEquals(outcome.alreadySwept, false);
  assertEquals(outcome.released, [123, 129]);
  assertEquals(outcome.retained, [150]);
  assertEquals(outcome.errors, []);
  assertEquals(gh.byNumber.get(123)?.labels, ["bug"]);
  assertEquals(gh.byNumber.get(129)?.labels, []);
  assertEquals(gh.byNumber.get(150)?.labels, ["failed-once"]);

  // Each released issue is told why, once.
  const comments = gh.calls.filter((c) => c[1] === "comment");
  assertEquals(comments.length, 2);
  assertStringIncludes(
    comments[0]?.[comments[0].length - 1] ?? "",
    "Milestone branch restored",
  );
});

Deno.test("releaseMilestoneBranchRefusalLabels - sweeps a branch once per run (Issue #2220)", async () => {
  resetMilestoneBranchRefusalSweepsForTest();
  const gh = fakeGh([
    { number: 123, labels: ["failed-once"], comments: [REFUSAL_COMMENT] },
  ]);
  const first = await releaseMilestoneBranchRefusalLabels({
    repo: REPO,
    milestoneTitle: MILESTONE,
    milestoneBranch: BRANCH,
    ghCommandFn: gh.fn,
  });
  assertEquals(first.released, [123]);

  const callsAfterFirst = gh.calls.length;
  const second = await releaseMilestoneBranchRefusalLabels({
    repo: REPO,
    milestoneTitle: MILESTONE,
    milestoneBranch: BRANCH,
    ghCommandFn: gh.fn,
  });
  assertEquals(second.alreadySwept, true);
  assertEquals(second.released, []);
  assertEquals(gh.calls.length, callsAfterFirst, "no gh call on a re-sweep");
});

Deno.test("releaseMilestoneBranchRefusalLabels - a gh fault is reported, never swallowed (Issue #2220)", async () => {
  resetMilestoneBranchRefusalSweepsForTest();
  const fn = (args: string[]): Promise<string> => {
    if (args[1] === "list") return Promise.reject(new Error("gh: 403"));
    return Promise.resolve("");
  };
  const outcome = await releaseMilestoneBranchRefusalLabels({
    repo: REPO,
    milestoneTitle: MILESTONE,
    milestoneBranch: BRANCH,
    ghCommandFn: fn,
  });
  assertEquals(outcome.released, []);
  assertEquals(outcome.errors.length, 2, outcome.errors.join(" | "));
  assertStringIncludes(outcome.errors[0] ?? "", "gh: 403");
});

Deno.test("buildRefusalReleaseComment - names the branch and every label removed (Issue #2220)", () => {
  const body = buildRefusalReleaseComment(BRANCH, ["failed-once", "failed"]);
  assertStringIncludes(body, BRANCH);
  assertStringIncludes(body, "`failed-once`, `failed`");
  assertStringIncludes(body, "have been removed");
  assertStringIncludes(
    buildRefusalReleaseComment(BRANCH, ["failed"]),
    "has been removed",
  );
});
