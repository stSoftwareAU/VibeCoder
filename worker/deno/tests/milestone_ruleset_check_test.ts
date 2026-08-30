/**
 * Tests for milestone_ruleset_check.ts — setup's read-only verification of
 * the `milestone/**` ruleset (Issue #586).
 *
 * The configuration has to satisfy two things that pull against each other: a
 * milestone PR must be auto-mergeable (which needs the branch gated), and the
 * worker must still be able to push the branch directly (which a gate blocks
 * unless it can bypass). These pin both halves.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assessMilestoneRuleset,
  coversMilestoneBranches,
  createMilestoneRuleset,
  type RulesetDetail,
  serviceAccountCanBypass,
} from "../lib/milestone_ruleset_check.ts";

const ACCOUNT = { login: "VibeCoderST", permission: "write" };

function ruleset(overrides: Partial<RulesetDetail> = {}): RulesetDetail {
  return {
    id: 1,
    name: "main",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/milestone/**"] },
    },
    rules: [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "semgrep" }] },
      },
    ],
    bypass_actors: [],
    ...overrides,
  };
}

function codes(findings: { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

Deno.test("coversMilestoneBranches - recognises the patterns that reach a milestone branch", () => {
  const cover = [
    "refs/heads/milestone/**",
    "refs/heads/milestone/*",
    "refs/heads/milestone/523-something",
    "~ALL",
  ];
  for (const pattern of cover) {
    assert(
      coversMilestoneBranches({
        conditions: { ref_name: { include: [pattern] } },
      }),
      `${pattern} should cover milestone branches`,
    );
  }
  assertEquals(
    coversMilestoneBranches({
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
    }),
    false,
  );
});

Deno.test("assessMilestoneRuleset - no covering ruleset means auto-merge cannot be armed", () => {
  const findings = assessMilestoneRuleset(
    [ruleset({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } })],
    ACCOUNT,
  );
  assertEquals(codes(findings), ["no-milestone-ruleset"]);
  assertStringIncludes(findings[0]!.message, "auto-merge");
});

Deno.test("assessMilestoneRuleset - a gated branch the service account cannot push is reported against the WORKER", () => {
  // The operator's live configuration: `main` extended to cover
  // `milestone/**`, with a RepositoryRole(admin) bypass — and a service
  // account holding only `write`. The milestone sync's direct push dies.
  const findings = assessMilestoneRuleset(
    [ruleset({
      rules: [
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 0 },
        },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "semgrep" }] },
        },
      ],
      bypass_actors: [
        { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
      ],
    })],
    ACCOUNT,
  );

  const blocked = findings.find((f) => f.code === "direct-push-blocked");
  assert(blocked, "the blocked push must be reported");
  // Refusing the service account is the intended policy — an admin may
  // bypass, the fleet may not — so this is not an error against the ruleset.
  assertEquals(blocked.severity, "warning");
  assertStringIncludes(blocked.message, "REJECTED");
  assertStringIncludes(blocked.message, "RULESET is right");
});

Deno.test("assessMilestoneRuleset - a RepositoryRole bypass the account satisfies is clean", () => {
  const findings = assessMilestoneRuleset(
    [ruleset({
      bypass_actors: [
        { actor_type: "RepositoryRole", actor_id: 3, bypass_mode: "always" },
      ],
    })],
    ACCOUNT,
  );
  assertEquals(codes(findings), ["configured"]);
});

Deno.test("assessMilestoneRuleset - an unresolvable bypass is a warning, not an error", () => {
  // A User/Team/Integration bypass cannot be matched to a login from here.
  // Claiming a break that may not exist would be worse than saying so.
  const findings = assessMilestoneRuleset(
    [ruleset({
      bypass_actors: [
        { actor_type: "User", actor_id: 99, bypass_mode: "always" },
      ],
    })],
    ACCOUNT,
  );
  const blocked = findings.find((f) => f.code === "direct-push-blocked");
  assert(blocked);
  assertEquals(blocked.severity, "warning");
  assertStringIncludes(blocked.message, "cannot resolve");
});

Deno.test("assessMilestoneRuleset - a review requirement off the default branch is reported", () => {
  const findings = assessMilestoneRuleset(
    [ruleset({
      rules: [
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 1 },
        },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "semgrep" }] },
        },
      ],
      bypass_actors: [
        { actor_type: "RepositoryRole", actor_id: 3, bypass_mode: "always" },
      ],
    })],
    ACCOUNT,
  );
  const review = findings.find((f) => f.code === "review-required");
  assert(review, "a review gate on milestone branches must be reported");
  assertStringIncludes(review.message, "wait for a human");
});

Deno.test("assessMilestoneRuleset - a covering ruleset with no checks cannot arm auto-merge", () => {
  const findings = assessMilestoneRuleset(
    [ruleset({ rules: [{ type: "deletion" }] })],
    ACCOUNT,
  );
  assertEquals(codes(findings), ["no-required-checks"]);
});

Deno.test("assessMilestoneRuleset - a disabled ruleset gates nothing and says so", () => {
  const findings = assessMilestoneRuleset(
    [ruleset({ enforcement: "disabled" })],
    ACCOUNT,
  );
  assertEquals(codes(findings), ["ruleset-disabled"]);
});

Deno.test("serviceAccountCanBypass - a pull_request-mode bypass does not cover a direct push", () => {
  // `bypass_mode: "pull_request"` exempts the actor only when merging a PR,
  // which is not what the milestone sync does.
  const result = serviceAccountCanBypass(
    ruleset({
      bypass_actors: [
        {
          actor_type: "RepositoryRole",
          actor_id: 3,
          bypass_mode: "pull_request",
        },
      ],
    }),
    ACCOUNT,
  );
  assertEquals(result.bypasses, false);
});

// ---------------------------------------------------------------------------
// Creating the ruleset when it is missing. Setup runs with the operator's own
// credentials, so it can write what the service account cannot.
// ---------------------------------------------------------------------------

Deno.test("createMilestoneRuleset - mirrors the default-branch check set", async () => {
  const posted: { args: string[]; body?: string }[] = [];
  const result = await createMilestoneRuleset(
    "org/repo",
    (args, stdin) => {
      posted.push({ args, ...(stdin !== undefined ? { body: stdin } : {}) });
      return Promise.resolve("42");
    },
    {
      rulesets: [ruleset({
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [{
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "semgrep" },
              { context: "gitleaks" },
            ],
          },
        }],
        bypass_actors: [
          { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
        ],
      })],
    },
  );

  assert(result.ok && result.created);
  assertEquals(result.contexts, ["semgrep", "gitleaks"]);

  const body = JSON.parse(posted[0]!.body!);
  assertEquals(body.conditions.ref_name.include, ["refs/heads/milestone/**"]);
  // No `pull_request` rule: review belongs on the default branch, not in
  // front of every child PR the fleet raises.
  assertEquals(
    (body.rules as { type: string }[]).some((r) => r.type === "pull_request"),
    false,
  );
  // The default branch's bypass actors carry over, so whoever could push
  // there can still push a milestone branch.
  assertEquals(body.bypass_actors.length, 1);
});

Deno.test("createMilestoneRuleset - does nothing when milestone branches are already covered", async () => {
  const result = await createMilestoneRuleset(
    "org/repo",
    () => Promise.reject(new Error("must not call gh")),
    { rulesets: [ruleset()] },
  );
  assert(result.ok && !result.created);
  assertStringIncludes(result.reason, "already covered");
});

Deno.test("createMilestoneRuleset - refuses to guess a check set", async () => {
  // Requiring a context nothing reports would block every milestone PR for
  // ever, which is worse than the gap it would close.
  const result = await createMilestoneRuleset(
    "org/repo",
    () => Promise.reject(new Error("must not call gh")),
    {
      rulesets: [ruleset({
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [{ type: "deletion" }],
      })],
    },
  );
  assert(result.ok && !result.created);
  assertStringIncludes(result.reason, "no check set to mirror");
});
