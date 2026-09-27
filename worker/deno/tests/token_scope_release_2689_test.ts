/**
 * A host's missing `workflow` scope releases the issue for a host that has
 * it — no `failed-once`, no `failed`, no `needs-human` (Issue #2689).
 *
 * GRQ#4939 changed `.github/workflows/quality.yml`; the claiming host's token
 * could not push it, and the issue was laddered and parked for a human even
 * though another host in the fleet could have pushed it untouched.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyCodingFailureLadder,
  classifyCodingFailure,
  planCodingFailure,
} from "../lib/coding_failure_ladder.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import {
  createMissingScopeWarner,
  WORKFLOW_SCOPE_REMEDIATION,
  workflowScopePushRefusalMessage,
} from "../lib/workflow_scope.ts";

const REPO = "stSoftwareAU/GRQ";

/** The completion phase's pre-push refusal, as it words it. */
const PRE_PUSH_REASON =
  "Cannot push: the token lacks the 'workflow' scope and the branch changes " +
  ".github/workflows/quality.yml (per the branch diff) — GitHub rejects such " +
  `a push from any OAuth token without it. No push was attempted. Fix: ` +
  WORKFLOW_SCOPE_REMEDIATION;

/** GitHub's own refusal, as the completion phase reports it. */
const PUSH_REFUSAL_REASON = workflowScopePushRefusalMessage(
  "! [remote rejected] HEAD -> issue-4939 (refusing to allow an OAuth App " +
    "to create or update workflow `.github/workflows/quality.yml` without " +
    "`workflow` scope)",
);

const REASONS = [PRE_PUSH_REASON, PUSH_REFUSAL_REASON];

/** Every gh invocation, so the test can assert what was NOT run. */
function recordingGh(): {
  calls: string[][];
  fn: (a: string[]) => Promise<string>;
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args: string[]) => {
      calls.push(args);
      // Worst case for the ladder: the issue already carries failed-once.
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve("failed-once");
      }
      return Promise.resolve("");
    },
  };
}

function addedLabels(calls: string[][]): string[] {
  return calls.map((c) => c.join(" ")).filter((c) => c.includes("--add-label"));
}

Deno.test("classifyCodingFailure - a missing workflow scope is transient: no attempt, no escalating cooldown (Issue #2689)", () => {
  for (const reason of REASONS) {
    const decision = classifyCodingFailure(reason);
    assertEquals(decision.category, "token_scope");
    assertEquals(decision.failureClass, "token-scope");
    assertEquals(decision.disposition, "transient");
    assertEquals(decision.cooldownKind, undefined);
  }
});

Deno.test("planCodingFailure - a missing workflow scope never reaches the ladder (Issue #2689)", () => {
  for (const reason of REASONS) {
    const plan = planCodingFailure({
      success: false,
      expectedSkip: false,
      reason,
    });
    assertEquals(plan.decision?.disposition, "transient");
    assertEquals(plan.applyLadder, false);
    assertEquals(plan.cooldownKind, undefined);
  }
});

Deno.test("applyCodingFailureLadder - a missing workflow scope never calls handleIssueFailure (Issue #2689)", async () => {
  let called = 0;
  const outcome = await applyCodingFailureLadder({
    repo: REPO,
    issueNumber: 4939,
    githubUser: "stservice",
    failureReason: PUSH_REFUSAL_REASON,
  }, {
    handleIssueFailure: () => {
      called++;
      return Promise.reject(new Error("must not be reached"));
    },
  });
  assertEquals(called, 0);
  assertEquals(outcome.decision.disposition, "transient");
  assertEquals(outcome.error, undefined);
});

Deno.test("handleIssueFailure - a missing workflow scope adds no failed-once, failed or needs-human label (Issue #2689)", async () => {
  for (const reason of REASONS) {
    const gh = recordingGh();
    const result = await handleIssueFailure({
      repo: REPO,
      issueNumber: 4939,
      githubUser: "stservice",
      failureMessage: reason,
    }, { ghCommandFn: gh.fn });

    assert(result.ok);
    assertEquals(result.value.failureCategory, "token_scope");
    assertEquals(result.value.markedAsFailedOnce, false);
    assertEquals(result.value.markedAsFailed, false);
    assertEquals(result.value.isInfrastructure, false);
    assertEquals(addedLabels(gh.calls), [], "no label may be added");
  }
});

Deno.test("handleIssueFailure - an ordinary quality failure still enters the ladder (Issue #2689)", async () => {
  const gh = recordingGh();
  const result = await handleIssueFailure({
    repo: REPO,
    issueNumber: 4940,
    githubUser: "stservice",
    failureMessage: "Changes were made but quality checks failed",
  }, { ghCommandFn: gh.fn });
  assert(result.ok);
  assertEquals(result.value.markedAsFailed, true);
});

Deno.test("createMissingScopeWarner - names the missing scope once per process (Issue #2689)", () => {
  const warnOnce = createMissingScopeWarner();
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  assertEquals(warnOnce(warn), true);
  assertEquals(warnOnce(warn), false);
  assertEquals(warnOnce(warn), false);

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "`workflow` OAuth scope");
  assertStringIncludes(warnings[0] ?? "", "host that can push");
  assertStringIncludes(warnings[0] ?? "", WORKFLOW_SCOPE_REMEDIATION);

  // Each warner is its own latch: a fresh process warns again.
  assertEquals(createMissingScopeWarner()(warn), true);
  assertEquals(warnings.length, 2);
});
