/**
 * Tests for the claimed-repo PR-lifecycle guard (Issue #1462).
 *
 * `evaluateGhCommand` is the sole mediation layer for the agent subprocess's
 * own `gh` calls, and it classified no `gh pr <verb>` at all: `gh pr merge` on
 * the claimed repo fell through every check to the write-repo allowlist, which
 * allows it because the claimed repo is on that allowlist by construction. The
 * merge therefore skipped `direct_merge.ts`, where CI freshness and the
 * default-branch approval gate live.
 *
 * These tests drive both directions — the refusals, and the `pr create` /
 * `pr view` / `pr list` surface that must keep working, because a guard that
 * stops the agent raising a PR is a broken worker rather than containment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";
import { classifyPrLifecycle } from "../lib/gh_pr_lifecycle.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import {
  GH_GUARD_ALLOW_MARKER,
  GH_GUARD_REFUSE_MARKER,
  runGhGuardCli,
} from "../lib/gh_guard_cli.ts";
import type { ClaimedIssue } from "../lib/claimed_issue_guard.ts";

const CLAIM: ClaimedIssue = {
  repo: "stSoftwareAU/NEAT-AI-Backpropagation",
  issueNumber: 94,
  allowedVerbs: ["edit"],
};

const OTHER_REPO = "stSoftwareAU/VibeCoder";

/** Guard context with the claim seeded and the allowlist active. */
function ctx(claimedIssue: ClaimedIssue = CLAIM) {
  return {
    active: true,
    allowedRepos: [CLAIM.repo, OTHER_REPO],
    claimedIssue,
  };
}

/** The same context with no claim seeded — the guard must be inert. */
function ctxWithoutClaim() {
  return { active: true, allowedRepos: [CLAIM.repo, OTHER_REPO] };
}

/** Classify through the real mutation classifier, as the guard does. */
function classify(args: readonly string[]) {
  const info = classifyGhMutation(args);
  return info ? classifyPrLifecycle(args, info) : undefined;
}

// ---------------------------------------------------------------------------
// The refusal the issue names
// ---------------------------------------------------------------------------

Deno.test("gh guard refuses `gh pr merge` on the claimed repo", () => {
  const decision = evaluateGhCommand(
    ["pr", "merge", "12", "--repo", CLAIM.repo, "--squash"],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
  assertStringIncludes(decision.reason ?? "", "pr-merge");
  assertStringIncludes(decision.reason ?? "", CLAIM.repo);
});

Deno.test("gh guard refuses `gh pr merge` with no explicit repo (gh's cwd form)", () => {
  const decision = evaluateGhCommand(["pr", "merge", "12", "--auto"], ctx());
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
});

Deno.test("gh guard refuses every PR-lifecycle verb on the claimed repo", () => {
  for (const verb of ["merge", "close", "reopen", "ready"]) {
    const decision = evaluateGhCommand(
      ["pr", verb, "12", "--repo", CLAIM.repo],
      ctx(),
    );
    assertEquals(decision.allowed, false, `pr ${verb} should be refused`);
    assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
  }
});

Deno.test("gh guard refuses an approving review in every spelling", () => {
  for (
    const args of [
      ["pr", "review", "12", "--repo", CLAIM.repo, "--approve"],
      ["pr", "review", "12", "--repo", CLAIM.repo, "--approve=true"],
      ["pr", "review", "12", "--repo", CLAIM.repo, "-a"],
      ["pr", "review", "12", "--repo", CLAIM.repo, "-ab", "ship it"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ctx());
    assertEquals(decision.allowed, false, `${args.join(" ")} should refuse`);
    assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
  }
});

Deno.test("gh guard leaves a non-approving review alone", () => {
  for (
    const args of [
      ["pr", "review", "12", "--repo", CLAIM.repo, "--comment", "-b", "note"],
      [
        "pr",
        "review",
        "12",
        "--repo",
        CLAIM.repo,
        "--request-changes",
        "-b",
        "no",
      ],
      // The body's value must not be scanned as a shorthand group.
      ["pr", "review", "12", "--repo", CLAIM.repo, "--comment", "--body", "-a"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ctx());
    assertEquals(decision.allowed, true, `${args.join(" ")} should be allowed`);
  }
});

// ---------------------------------------------------------------------------
// The REST spellings — argv-only coverage would be an obvious bypass
// ---------------------------------------------------------------------------

Deno.test("gh guard refuses the REST merge, close, reopen and approve", () => {
  const cases: Array<{ args: string[]; verb: string }> = [
    {
      args: ["api", "-X", "PUT", `repos/${CLAIM.repo}/pulls/12/merge`],
      verb: "merge",
    },
    {
      args: [
        "api",
        "-X",
        "PATCH",
        `repos/${CLAIM.repo}/pulls/12`,
        "-f",
        "state=closed",
      ],
      verb: "close",
    },
    {
      args: [
        "api",
        "-X",
        "PATCH",
        `repos/${CLAIM.repo}/pulls/12`,
        "-f",
        "state=open",
      ],
      verb: "reopen",
    },
    {
      args: [
        "api",
        "-X",
        "POST",
        `repos/${CLAIM.repo}/pulls/12/reviews`,
        "-f",
        "event=APPROVE",
      ],
      verb: "review --approve",
    },
  ];
  for (const { args, verb } of cases) {
    assertEquals(classify(args)?.verb, verb, `${args.join(" ")} → ${verb}`);
    const decision = evaluateGhCommand(args, ctx());
    assertEquals(decision.allowed, false, `${args.join(" ")} should refuse`);
    assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
  }
});

Deno.test("gh guard refuses the REST merge in gh's placeholder repo form", () => {
  const decision = evaluateGhCommand(
    ["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/12/merge"],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
});

Deno.test("gh guard refuses the REST merge in its attached-shorthand spelling", () => {
  const decision = evaluateGhCommand(
    ["api", "-XPUT", `repos/${CLAIM.repo}/pulls/12/merge`],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
});

Deno.test("gh guard refuses the REST merge against an absolute GitHub endpoint", () => {
  const decision = evaluateGhCommand(
    [
      "api",
      "-X",
      "PUT",
      `https://api.github.com/repos/${CLAIM.repo}/pulls/12/merge`,
    ],
    ctx(),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
});

Deno.test("classifyPrLifecycle ignores the REST shapes that decide nothing", () => {
  // A title/body edit — the agent legitimately rewrites its own PR body.
  assertEquals(
    classify([
      "api",
      "-X",
      "PATCH",
      `repos/${CLAIM.repo}/pulls/12`,
      "-f",
      "title=x",
    ]),
    undefined,
  );
  // A review that is not an approval.
  assertEquals(
    classify([
      "api",
      "-X",
      "POST",
      `repos/${CLAIM.repo}/pulls/12/reviews`,
      "-f",
      "event=COMMENT",
    ]),
    undefined,
  );
  // A comment on the PR.
  assertEquals(
    classify([
      "api",
      "-X",
      "POST",
      `repos/${CLAIM.repo}/issues/12/comments`,
      "-f",
      "body=hi",
    ]),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// The other direction — the agent's normal PR surface must keep working
// ---------------------------------------------------------------------------

Deno.test("gh guard still allows the agent to create, read and describe a PR", () => {
  for (
    const args of [
      ["pr", "create", "--repo", CLAIM.repo, "--title", "t", "--body", "b"],
      ["pr", "create", "--fill"],
      ["pr", "view", "12"],
      ["pr", "list", "--repo", CLAIM.repo],
      ["pr", "diff", "12"],
      ["pr", "checks", "12"],
      ["pr", "comment", "12", "--repo", CLAIM.repo, "--body", "note"],
      ["pr", "edit", "12", "--repo", CLAIM.repo, "--body", "revised"],
    ]
  ) {
    const decision = evaluateGhCommand(args, ctx());
    assertEquals(decision.allowed, true, `${args.join(" ")} should be allowed`);
  }
});

Deno.test("classifyPrLifecycle ignores non-lifecycle PR and issue mutations", () => {
  assertEquals(classify(["pr", "create", "--fill"]), undefined);
  assertEquals(
    classify(["pr", "comment", "12", "--repo", CLAIM.repo, "-b", "hi"]),
    undefined,
  );
  assertEquals(
    classify(["issue", "close", "94", "--repo", CLAIM.repo]),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Scope — a different repo, and no claim at all
// ---------------------------------------------------------------------------

Deno.test("a PR verb naming a different repo is left to the write-repo allowlist", () => {
  // On the allowlist: allowed, exactly as before — this guard does not
  // double-refuse another repo's PRs, matching the issue-lifecycle refusal.
  const onAllowlist = evaluateGhCommand(
    ["pr", "merge", "12", "--repo", OTHER_REPO],
    ctx(),
  );
  assertEquals(onAllowlist.allowed, true);

  // Off the allowlist: refused by the allowlist, with its own marker.
  const offAllowlist = evaluateGhCommand(
    ["pr", "merge", "12", "--repo", "attacker/evil"],
    ctx(),
  );
  assertEquals(offAllowlist.allowed, false);
  assertEquals(offAllowlist.marker, "WRITE_REPO_BLOCKED");
});

Deno.test("with no claim seeded the PR guard is inert", () => {
  for (
    const args of [
      ["pr", "merge", "12", "--repo", CLAIM.repo],
      ["api", "-X", "PUT", `repos/${CLAIM.repo}/pulls/12/merge`],
    ]
  ) {
    const decision = evaluateGhCommand(args, ctxWithoutClaim());
    assertEquals(decision.allowed, true, `${args.join(" ")} unchanged`);
  }
});

Deno.test("the claim's allowed issue verbs never unlock a PR verb", () => {
  // A route that permitted `close` on its own issue must not thereby permit
  // `gh pr close`: `--allow-issue-verb` is an issue-verb allowance.
  const decision = evaluateGhCommand(
    ["pr", "close", "12", "--repo", CLAIM.repo],
    ctx({ ...CLAIM, allowedVerbs: ["edit", "close", "merge"] }),
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "PR_LIFECYCLE_REFUSED");
});

// ---------------------------------------------------------------------------
// The guard CLI — the contract the shim actually re-enters
// ---------------------------------------------------------------------------

Deno.test("guard CLI refuses a claimed-repo pr merge and reports the marker", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    CLAIM.repo,
    "--claimed-issue",
    `${CLAIM.repo}#94`,
    "--allow-issue-verb",
    "edit",
    "--",
    "pr",
    "merge",
    "12",
    "--repo",
    CLAIM.repo,
    "--squash",
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "[PR_LIFECYCLE_REFUSED]");
});

Deno.test("guard CLI still allows the agent to open its pull request", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    CLAIM.repo,
    "--claimed-issue",
    `${CLAIM.repo}#94`,
    "--allow-issue-verb",
    "edit",
    "--",
    "pr",
    "create",
    "--repo",
    CLAIM.repo,
    "--title",
    "fix: something",
    "--body",
    "Fixes #94",
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
});
