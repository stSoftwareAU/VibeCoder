/**
 * Telling a plan limitation from a broken token (Issue #733).
 *
 * Applying the default-branch ruleset to a private repository on a free plan
 * returns HTTP 403 — rulesets need GitHub Pro there. The failure is correctly
 * non-fatal, but setup reported it as `Ruleset sync had issues (non-fatal)`,
 * which is also what a missing token scope, a revoked token and an
 * organisation policy print, so the reporter had to work the plan limitation
 * out for themselves (report item 4 of #722).
 *
 * These cases pin each message, and the sync's own non-fatality: one repo's
 * 403 must not stop the walk, and the summary must record it rather than
 * throw.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  explainRulesetFailure,
  rulesetFailureStatus,
} from "../lib/ruleset_failure.ts";
import {
  syncBranchProtectionForAllRepos,
  syncBranchProtectionForRepo,
} from "../setup/branch_protection_sync.ts";
import type { CommandOutput } from "../setup/branch_protection_sync.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";

/** What gh prints when the repository's plan does not include rulesets. */
const PLAN_403 =
  "HTTP 403: Upgrade to GitHub Pro or make this repository public to enable " +
  "this feature. (https://api.github.com/repos/org/priv/rulesets)";

/** What gh prints when the token simply may not do this. */
const SCOPE_403 =
  "HTTP 403: Resource not accessible by personal access token " +
  "(https://api.github.com/repos/org/priv/rulesets)";

Deno.test("explainRulesetFailure - names GitHub Pro for the plan limitation (Issue #733)", () => {
  const explained = explainRulesetFailure({
    repo: "org/priv",
    error: PLAN_403,
    visibility: "private",
  });

  assertEquals(explained.kind, "plan-required");
  assertEquals(explained.status, 403);
  assertStringIncludes(explained.message, "org/priv");
  assertStringIncludes(explained.message, "GitHub Pro");
  assertStringIncludes(explained.message, "private repository");
  // The operator is told it does not stop setup, and what the choices are.
  assertStringIncludes(explained.message, "Non-fatal");
  assertStringIncludes(explained.message, "make the repository public");
});

Deno.test("explainRulesetFailure - a 403 that is not the plan limitation names the status, not a subscription (Issue #733)", () => {
  const explained = explainRulesetFailure({
    repo: "org/priv",
    error: SCOPE_403,
    visibility: "private",
  });

  assertEquals(explained.kind, "other");
  assertEquals(explained.status, 403);
  assertStringIncludes(explained.message, "org/priv");
  assertStringIncludes(explained.message, "HTTP 403");
  assertStringIncludes(explained.message, "not accessible by personal access");
  assertEquals(
    explained.message.includes("GitHub Pro"),
    false,
    "a token-scope failure must not be blamed on the plan",
  );
});

Deno.test("explainRulesetFailure - any other failure names the repository and what happened (Issue #733)", () => {
  const withStatus = explainRulesetFailure({
    repo: "org/repo",
    error: "HTTP 422: Validation Failed",
  });
  assertEquals(withStatus.kind, "other");
  assertEquals(withStatus.status, 422);
  assertStringIncludes(withStatus.message, "HTTP 422");

  // No status at all — a resolution failure, say — still names the repo.
  const withoutStatus = explainRulesetFailure({
    repo: "org/repo",
    error: "Could not resolve default branch for org/repo",
  });
  assertEquals(withoutStatus.kind, "other");
  assertEquals(withoutStatus.status, undefined);
  assertStringIncludes(withoutStatus.message, "org/repo");
  assertStringIncludes(withoutStatus.message, "Could not resolve");

  // An empty reason is still a line, not a dangling colon.
  assertStringIncludes(
    explainRulesetFailure({ repo: "org/repo", error: "  " }).message,
    "no reason given",
  );
});

Deno.test("explainRulesetFailure - a plan-limitation message on a public repo still explains itself (Issue #733)", () => {
  const explained = explainRulesetFailure({
    repo: "org/pub",
    error: PLAN_403,
    visibility: "public",
  });
  assertEquals(explained.kind, "plan-required");
  assertStringIncludes(explained.message, "this repository");
});

Deno.test("rulesetFailureStatus - reads the status however gh spells it (Issue #733)", () => {
  assertEquals(rulesetFailureStatus("HTTP 403: nope"), 403);
  assertEquals(rulesetFailureStatus("gh: something (HTTP 404)"), 404);
  // Tolerant of the spacing, not of any three digits that wander past.
  assertEquals(rulesetFailureStatus("HTTP403"), 403);
  assertEquals(rulesetFailureStatus("no status here"), undefined);
  assertEquals(rulesetFailureStatus("failed after 12345 ms"), undefined);
});

// ---------------------------------------------------------------------------
// The sync itself stays non-fatal
// ---------------------------------------------------------------------------

/** Metadata reads that always answer, so only the ruleset call can fail. */
function metaRunCommand(
  visibility: string,
  branch: string,
): (cmd: string[]) => Promise<CommandOutput> {
  return (cmd: string[]): Promise<CommandOutput> => {
    const jq = cmd[cmd.length - 1];
    if (jq === ".visibility") {
      return Promise.resolve({ success: true, stdout: visibility, stderr: "" });
    }
    if (jq === ".default_branch") {
      return Promise.resolve({ success: true, stdout: branch, stderr: "" });
    }
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "unexpected",
    });
  };
}

/** A gh executor that refuses every ruleset call with `error`. */
function refusingGh(error: string): { gh: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhExec = (args: string[]) => {
    calls.push(args);
    return Promise.reject(new Error(error));
  };
  return { gh, calls };
}

Deno.test("the ruleset sync records a 403 rather than throwing (Issue #733)", async () => {
  const { gh } = refusingGh(PLAN_403);

  const result = await syncBranchProtectionForRepo("org/priv", {
    runCommand: metaRunCommand("private", "main"),
    ghFn: gh,
  });

  assertEquals(result.ok, false);
  assertEquals(result.repo, "org/priv");
  assert(result.error, "the failure must carry the reason gh gave");
  // The reason survives intact, so the explanation above has something to
  // classify rather than a swallowed "unknown error".
  assertStringIncludes(result.error, "403");
  assertEquals(
    explainRulesetFailure({
      repo: result.repo,
      error: result.error,
      ...(result.visibility ? { visibility: result.visibility } : {}),
    }).kind,
    "plan-required",
  );
});

Deno.test("one repository's 403 does not stop the walk (Issue #733)", async () => {
  // The reported host: a private repo that cannot take a ruleset, beside one
  // that can. Setup must finish, and the second repo must still be visited.
  const gh: GhExec = (args: string[]) => {
    if (args.join(" ").includes("org/priv")) {
      return Promise.reject(new Error(PLAN_403));
    }
    // Nothing configured anywhere else.
    return Promise.reject(new Error("HTTP 404: Not Found"));
  };

  const summary = await syncBranchProtectionForAllRepos({
    repos: ["org/priv", "org/other"],
    runCommand: metaRunCommand("private", "main"),
    ghFn: gh,
  });

  assertEquals(summary.total, 2);
  assertEquals(summary.results.length, 2, "every repo must be visited");
  assertEquals(summary.results[0]!.repo, "org/priv");
  assertEquals(summary.results[0]!.ok, false);
  assertEquals(summary.failed >= 1, true);
});
