/**
 * Tests for the claimed-issue lifecycle guard (Issue #222).
 *
 * The agent that implements an issue must not decide that issue's lifecycle:
 * NEAT-AI-Backpropagation#94 was closed as `not planned` by the implementing
 * agent while it was blocked on a dependency. These tests drive the pure
 * decision (`evaluateGhCommand`), the classifier that feeds it, and the guard
 * CLI's own argv parsing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";
import { classifyIssueLifecycle } from "../lib/gh_issue_lifecycle.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import { renderGhShimScript } from "../lib/gh_guard_shim.ts";
import {
  GH_GUARD_ALLOW_MARKER,
  GH_GUARD_REFUSE_MARKER,
  runGhGuardCli,
} from "../lib/gh_guard_cli.ts";
import {
  claimedIssueGuard,
  createClaimedIssueGuardContext,
  DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS,
  resetClaimedIssueGuard,
  seedClaimedIssueGuard,
  withClaimedIssueGuardContext,
} from "../lib/claimed_issue_guard.ts";
import type { ClaimedIssue } from "../lib/claimed_issue_guard.ts";

const CLAIM: ClaimedIssue = {
  repo: "stSoftwareAU/NEAT-AI-Backpropagation",
  issueNumber: 94,
  allowedVerbs: ["edit"],
};

/** Guard context with the claim seeded and the allowlist active. */
function ctx(claimedIssue: ClaimedIssue = CLAIM) {
  return { active: true, allowedRepos: [CLAIM.repo], claimedIssue };
}

/** The same context with no claim seeded — the guard must be inert. */
function ctxWithoutClaim() {
  return { active: true, allowedRepos: [CLAIM.repo] };
}

// ---------------------------------------------------------------------------
// evaluateGhCommand — the refusals the acceptance criteria name
// ---------------------------------------------------------------------------

Deno.test("gh guard refuses `gh issue close` on the claimed issue", () => {
  const decision = evaluateGhCommand(
    ["issue", "close", "94", "--repo", CLAIM.repo, "--reason", "not planned"],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "ISSUE_LIFECYCLE_REFUSED");
  assertStringIncludes(decision.reason ?? "", "issue-close");
  assertStringIncludes(decision.reason ?? "", "#94");
  assertStringIncludes(decision.reason ?? "", "claimed issue");
});

Deno.test("gh guard refuses every lifecycle verb bar the allowed ones", () => {
  for (const verb of ["close", "reopen", "delete", "transfer", "lock"]) {
    const decision = evaluateGhCommand(
      ["issue", verb, "94", "--repo", CLAIM.repo],
      ctx(),
    );
    assertEquals(decision.allowed, false, `${verb} should be refused`);
    assertEquals(decision.marker, "ISSUE_LIFECYCLE_REFUSED");
  }
});

Deno.test("gh guard refuses a lifecycle verb on a sibling issue in the claimed repo", () => {
  const decision = evaluateGhCommand(
    ["issue", "close", "88", "--repo", CLAIM.repo],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "ISSUE_LIFECYCLE_REFUSED");
  // Not the claimed issue, so the "this run's claimed issue" note is absent.
  assert(!(decision.reason ?? "").includes("claimed issue)"));
});

Deno.test("gh guard refuses `gh issue close` with no --repo (cwd form)", () => {
  const decision = evaluateGhCommand(["issue", "close", "94"], ctx());
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "ISSUE_LIFECYCLE_REFUSED");
});

Deno.test("gh guard refuses a REST close of the claimed issue", () => {
  const decision = evaluateGhCommand(
    [
      "api",
      "-X",
      "PATCH",
      `repos/${CLAIM.repo}/issues/94`,
      "-f",
      "state=closed",
    ],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "ISSUE_LIFECYCLE_REFUSED");
});

Deno.test("gh guard allows the explicitly-permitted `edit` verb", () => {
  const decision = evaluateGhCommand(
    ["issue", "edit", "94", "--repo", CLAIM.repo, "--add-label", "needs-human"],
    ctx(),
  );
  assertEquals(decision.allowed, true);
});

Deno.test("gh guard allows comments, labels and new issues", () => {
  const allowed: string[][] = [
    ["issue", "comment", "94", "--repo", CLAIM.repo, "--body", "blocked"],
    ["issue", "create", "--repo", CLAIM.repo, "--title", "follow-up"],
    [
      "api",
      "-X",
      "POST",
      `repos/${CLAIM.repo}/issues/94/comments`,
      "-f",
      "body=x",
    ],
    [
      "api",
      "-X",
      "POST",
      `repos/${CLAIM.repo}/issues/94/labels`,
      "-f",
      "labels[]=bug",
    ],
    ["issue", "view", "94", "--repo", CLAIM.repo],
  ];
  for (const args of allowed) {
    const decision = evaluateGhCommand(args, ctx());
    assertEquals(decision.allowed, true, `${args.join(" ")} should be allowed`);
  }
});

Deno.test("gh guard is inert for lifecycle verbs when no claim is seeded", () => {
  const decision = evaluateGhCommand(
    ["issue", "close", "94", "--repo", CLAIM.repo],
    ctxWithoutClaim(),
  );
  assertEquals(decision.allowed, true);
});

Deno.test("a lifecycle verb on another repo is left to the write-repo allowlist", () => {
  const decision = evaluateGhCommand(
    ["issue", "close", "12", "--repo", "stSoftwareAU/NEAT-AI-core"],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  // Refused because the repo is off the allowlist, not by the lifecycle guard.
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});

// ---------------------------------------------------------------------------
// classifyIssueLifecycle — the pure classification
// ---------------------------------------------------------------------------

/** Classify `args` through the mutation classifier, then the lifecycle one. */
function classify(args: string[]) {
  const info = classifyGhMutation(args);
  assert(info, `expected a mutation for: ${args.join(" ")}`);
  return classifyIssueLifecycle(args, info);
}

Deno.test("classifyIssueLifecycle reads the verb, repo and number", () => {
  const attempt = classify(["issue", "close", "94", "--repo", CLAIM.repo]);
  assertEquals(attempt?.verb, "close");
  assertEquals(attempt?.repo, CLAIM.repo);
  assertEquals(attempt?.issueNumber, 94);
});

Deno.test("classifyIssueLifecycle reads an issue URL target", () => {
  const attempt = classify([
    "issue",
    "close",
    `https://github.com/${CLAIM.repo}/issues/94`,
  ]);
  assertEquals(attempt?.verb, "close");
  assertEquals(attempt?.repo, CLAIM.repo);
  assertEquals(attempt?.issueNumber, 94);
});

Deno.test("classifyIssueLifecycle maps REST shapes to lifecycle verbs", () => {
  assertEquals(
    classify([
      "api",
      "-X",
      "PATCH",
      `repos/${CLAIM.repo}/issues/94`,
      "-f",
      "state=open",
    ])
      ?.verb,
    "reopen",
  );
  assertEquals(
    classify([
      "api",
      "-X",
      "PATCH",
      `repos/${CLAIM.repo}/issues/94`,
      "-f",
      "title=x",
    ])
      ?.verb,
    "edit",
  );
  assertEquals(
    classify(["api", "-X", "PUT", `repos/${CLAIM.repo}/issues/94/lock`])?.verb,
    "lock",
  );
  assertEquals(
    classify(["api", "-X", "DELETE", `repos/${CLAIM.repo}/issues/94/lock`])
      ?.verb,
    "unlock",
  );
});

Deno.test("classifyIssueLifecycle ignores non-lifecycle mutations", () => {
  assertEquals(
    classify(["issue", "comment", "94", "--repo", CLAIM.repo, "-b", "hi"]),
    undefined,
  );
  assertEquals(
    classify(["pr", "close", "12", "--repo", CLAIM.repo]),
    undefined,
  );
  assertEquals(
    classify([
      "api",
      "-X",
      "POST",
      `repos/${CLAIM.repo}/issues/94/comments`,
      "-f",
      "body=hi",
    ]),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// The guard CLI — the shim's own contract
// ---------------------------------------------------------------------------

Deno.test("guard CLI refuses a claimed-issue close and reports the marker", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    CLAIM.repo,
    "--claimed-issue",
    `${CLAIM.repo}#94`,
    "--allow-issue-verb",
    "edit",
    "--",
    "issue",
    "close",
    "94",
    "--repo",
    CLAIM.repo,
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "[ISSUE_LIFECYCLE_REFUSED]");
});

Deno.test("guard CLI allows the permitted verb it was given", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    CLAIM.repo,
    "--claimed-issue",
    `${CLAIM.repo}#94`,
    "--allow-issue-verb",
    "edit",
    "--",
    "issue",
    "edit",
    "94",
    "--repo",
    CLAIM.repo,
    "--add-label",
    "needs-human",
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
});

Deno.test("guard CLI rejects a malformed --claimed-issue value", () => {
  const result = runGhGuardCli([
    "--claimed-issue",
    "not-a-slug",
    "--",
    "issue",
    "view",
    "94",
  ]);
  assertEquals(result.exitCode, 2);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "owner/repo#N");
});

// ---------------------------------------------------------------------------
// The wrapper the agent actually runs
// ---------------------------------------------------------------------------

Deno.test("the shim bakes the claim into the wrapper's guard arguments", () => {
  const script = renderGhShimScript({
    denoPath: "/usr/bin/deno",
    guardModulePath: "/opt/vibe/gh_guard_cli.ts",
    realGhPath: "/usr/bin/gh",
    active: true,
    allowedRepos: [CLAIM.repo],
    claimedIssue: CLAIM,
    verdictDir: "/tmp/verdict",
  });
  assertStringIncludes(script, "--claimed-issue");
  assertStringIncludes(script, `${CLAIM.repo}#94`);
  assertStringIncludes(script, "--allow-issue-verb");
});

Deno.test("the shim omits the claim arguments when no claim is seeded", () => {
  const script = renderGhShimScript({
    denoPath: "/usr/bin/deno",
    guardModulePath: "/opt/vibe/gh_guard_cli.ts",
    realGhPath: "/usr/bin/gh",
    active: true,
    allowedRepos: [CLAIM.repo],
    verdictDir: "/tmp/verdict",
  });
  assert(!script.includes("--claimed-issue"));
});

// ---------------------------------------------------------------------------
// Per-run state
// ---------------------------------------------------------------------------

Deno.test("seedClaimedIssueGuard defaults to permitting `edit` only", async () => {
  await withClaimedIssueGuardContext(
    createClaimedIssueGuardContext(),
    async () => {
      seedClaimedIssueGuard(CLAIM.repo, 94);
      assertEquals(claimedIssueGuard()?.issueNumber, 94);
      assertEquals(
        claimedIssueGuard()?.allowedVerbs,
        DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS,
      );
      resetClaimedIssueGuard();
      assertEquals(claimedIssueGuard(), undefined);
      await Promise.resolve();
    },
  );
});

Deno.test("two slots never see one another's claim", async () => {
  const slotA = withClaimedIssueGuardContext(
    createClaimedIssueGuardContext(),
    async () => {
      seedClaimedIssueGuard("org/a", 1);
      await new Promise((r) => setTimeout(r, 5));
      return claimedIssueGuard();
    },
  );
  const slotB = withClaimedIssueGuardContext(
    createClaimedIssueGuardContext(),
    async () => {
      seedClaimedIssueGuard("org/b", 2);
      await new Promise((r) => setTimeout(r, 5));
      return claimedIssueGuard();
    },
  );
  const [a, b] = await Promise.all([slotA, slotB]);
  assertEquals(a?.repo, "org/a");
  assertEquals(b?.repo, "org/b");
});
