/**
 * Tests for reviewer suppression on milestone-targeted PRs (Issue #2438).
 *
 * The fleet raises two kinds of PR into a `milestone/**` branch — a
 * completion-phase child-issue PR and a `sync/milestone-*` sync PR — and
 * neither has a reviewer who acts on it: the `milestone/**` ruleset requires
 * status checks only, and the review that matters sits on the milestone →
 * default-branch PR. A pending request on those PRs is noise.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  clearMilestoneReviewRequests,
  reviewersForBase,
} from "../lib/milestone_pr_reviewers.ts";
import { createPullRequestViaRest } from "../lib/pr_create_rest.ts";

/** Record every gh invocation so the calls made can be asserted on. */
function recorder(
  handler: (args: string[]) => Promise<string> | string,
): { calls: string[][]; fn: (args: string[]) => Promise<string> } {
  const calls: string[][] = [];
  return {
    calls,
    fn: async (args: string[]) => {
      calls.push(args);
      return await handler(args);
    },
  };
}

/** The `requested_reviewers` calls made, by HTTP verb. */
function reviewerCalls(calls: string[][], verb: string): string[][] {
  return calls.filter((a) =>
    a.includes(verb) && a.some((v) => v.endsWith("/requested_reviewers"))
  );
}

// ---------------------------------------------------------------------------
// 1. A milestone base asks for no reviewers at all
// ---------------------------------------------------------------------------

Deno.test("reviewersForBase - a milestone base drops every configured reviewer", () => {
  assertEquals(reviewersForBase("milestone/v2", ["alice", "bob"]), []);
  assertEquals(reviewersForBase("milestone/2026-Q1/rollout", ["alice"]), []);
});

Deno.test("createPullRequestViaRest - a milestone base requests no reviewers", async () => {
  const rec = recorder(() => "https://github.com/acme/widgets/pull/11");

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "issue-1-child",
    base: "milestone/v2",
    reviewers: ["alice", "bob"],
  }, { ghCommandFn: rec.fn });

  assert(result.ok, `expected success, got: ${!result.ok && result.error}`);
  assertEquals(
    reviewerCalls(rec.calls, "POST").length,
    0,
    `reviewers were requested: ${JSON.stringify(rec.calls)}`,
  );
});

Deno.test("clearMilestoneReviewRequests - no auto-request costs no extra call", async () => {
  const rec = recorder(() => '{"users":[],"teams":[]}');

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 11,
    base: "milestone/v2",
  }, { ghCommandFn: rec.fn });

  assertEquals(outcome, "none-requested");
  // One read, and nothing else — the common case must not spend quota on a
  // DELETE that would remove nothing (Issue #2409).
  assertEquals(rec.calls.length, 1);
  assertEquals(reviewerCalls(rec.calls, "DELETE").length, 0);
});

// ---------------------------------------------------------------------------
// 2. A CODEOWNERS team request on a milestone base is cleared
// ---------------------------------------------------------------------------

Deno.test("clearMilestoneReviewRequests - one DELETE carries both users and teams", async () => {
  const logs: string[] = [];
  const rec = recorder((args) =>
    args.includes("GET")
      ? '{"users":[{"login":"alice"}],"teams":[{"slug":"platform"}]}'
      : "{}"
  );

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 12,
    base: "milestone/v2",
  }, { ghCommandFn: rec.fn, log: (m) => logs.push(m) });

  assertEquals(outcome, "cleared");
  const deletes = reviewerCalls(rec.calls, "DELETE");
  assertEquals(deletes.length, 1, "the removal must be a single call");
  const args = deletes[0]!;
  assertEquals(args[0], "api");
  assert(
    args.includes("repos/acme/widgets/pulls/12/requested_reviewers"),
    args.join(" "),
  );
  assert(args.includes("reviewers[]=alice"), args.join(" "));
  assert(args.includes("team_reviewers[]=platform"), args.join(" "));
  // One line, naming the repo and the PR number.
  assertEquals(logs.length, 1);
  assert(logs[0]!.includes("acme/widgets"), logs[0]);
  assert(logs[0]!.includes("12"), logs[0]);
});

Deno.test("clearMilestoneReviewRequests - a CODEOWNERS team alone is cleared", async () => {
  const rec = recorder((args) =>
    args.includes("GET")
      ? '{"users":[],"teams":[{"slug":"code-owners"}]}'
      : "{}"
  );

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 13,
    base: "milestone/v2",
  }, { ghCommandFn: rec.fn });

  assertEquals(outcome, "cleared");
  const args = reviewerCalls(rec.calls, "DELETE")[0]!;
  assert(args.includes("team_reviewers[]=code-owners"), args.join(" "));
  assertEquals(
    args.some((v) => v.startsWith("reviewers[]=")),
    false,
    `an empty user list must not be sent: ${args.join(" ")}`,
  );
});

// ---------------------------------------------------------------------------
// 3. A default base is untouched
// ---------------------------------------------------------------------------

Deno.test("reviewersForBase - a default base keeps its reviewer list", () => {
  assertEquals(reviewersForBase("main", ["alice", "bob"]), ["alice", "bob"]);
  assertEquals(reviewersForBase("develop", ["alice"]), ["alice"]);
  // "milestone" without a name under it is a plain branch, not a milestone.
  assertEquals(reviewersForBase("milestone/", ["alice"]), ["alice"]);
});

Deno.test("createPullRequestViaRest - a default base still requests its reviewers", async () => {
  const rec = recorder((args) =>
    args.some((v) => v.endsWith("/requested_reviewers"))
      ? "{}"
      : "https://github.com/acme/widgets/pull/14"
  );

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "issue-1-fix",
    base: "main",
    reviewers: ["alice", "bob"],
  }, { ghCommandFn: rec.fn });

  assert(result.ok);
  const posts = reviewerCalls(rec.calls, "POST");
  assertEquals(posts.length, 1);
  assert(posts[0]!.includes("reviewers[]=alice"), posts[0]!.join(" "));
  assert(posts[0]!.includes("reviewers[]=bob"), posts[0]!.join(" "));
  // Nothing is removed from a default-branch PR.
  assertEquals(reviewerCalls(rec.calls, "DELETE").length, 0);
});

Deno.test("clearMilestoneReviewRequests - a default base reads nothing at all", async () => {
  const rec = recorder(() => {
    throw new Error("gh must not be called for a default-branch PR");
  });

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 14,
    base: "main",
  }, { ghCommandFn: rec.fn });

  assertEquals(outcome, "not-milestone-base");
  assertEquals(rec.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 4. A failed removal warns once and changes nothing else
// ---------------------------------------------------------------------------

Deno.test("clearMilestoneReviewRequests - a failed DELETE warns once and carries on", async () => {
  const logs: string[] = [];
  const warnings: string[] = [];
  const rec = recorder((args) => {
    if (args.includes("GET")) return '{"users":[{"login":"alice"}],"teams":[]}';
    throw new Error("HTTP 403: Resource not accessible by integration");
  });

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 15,
    base: "milestone/v2",
  }, {
    ghCommandFn: rec.fn,
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
  });

  // Fail-soft: the caller's exit code is the caller's business.
  assertEquals(outcome, "failed");
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.includes("acme/widgets"), warnings[0]);
  assert(warnings[0]!.includes("15"), warnings[0]);
  assert(warnings[0]!.includes("403"), warnings[0]);
  assertEquals(logs.length, 0, "a failure is not also reported as success");
  // Exactly one attempt — no retry (Issue #2409).
  assertEquals(reviewerCalls(rec.calls, "DELETE").length, 1);
});

Deno.test("clearMilestoneReviewRequests - a failed read warns once and never deletes", async () => {
  const warnings: string[] = [];
  const rec = recorder(() => {
    throw new Error("HTTP 502: Bad gateway");
  });

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 16,
    base: "milestone/v2",
  }, { ghCommandFn: rec.fn, warn: (m) => warnings.push(m) });

  assertEquals(outcome, "failed");
  assertEquals(warnings.length, 1);
  assertEquals(reviewerCalls(rec.calls, "DELETE").length, 0);
});

Deno.test("createPullRequestViaRest - a failed removal still returns the PR URL", async () => {
  const warnings: string[] = [];
  const rec = recorder((args) => {
    if (args.some((v) => v.endsWith("/requested_reviewers"))) {
      if (args.includes("GET")) {
        return '{"users":[],"teams":[{"slug":"platform"}]}';
      }
      throw new Error("HTTP 403: Resource not accessible by integration");
    }
    return "https://github.com/acme/widgets/pull/17";
  });

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "issue-1-child",
    base: "milestone/v2",
    reviewers: ["alice"],
  }, { ghCommandFn: rec.fn, log: (m) => warnings.push(m) });

  assert(result.ok, `expected success, got: ${!result.ok && result.error}`);
  assertEquals(result.value, "https://github.com/acme/widgets/pull/17");
  assertEquals(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Argument hygiene — values come back from GitHub but still reach a gh argv
// ---------------------------------------------------------------------------

Deno.test("clearMilestoneReviewRequests - refuses a malformed repo or PR number", async () => {
  const rec = recorder(() => "{}");

  assertEquals(
    await clearMilestoneReviewRequests({
      repo: "acme/widgets; rm -rf /",
      prNumber: 18,
      base: "milestone/v2",
    }, { ghCommandFn: rec.fn }),
    "invalid-target",
  );
  assertEquals(
    await clearMilestoneReviewRequests({
      repo: "acme/widgets",
      prNumber: 0,
      base: "milestone/v2",
    }, { ghCommandFn: rec.fn }),
    "invalid-target",
  );
  assertEquals(rec.calls.length, 0);
});

Deno.test("clearMilestoneReviewRequests - drops a reviewer name that is not a login", async () => {
  const rec = recorder((args) =>
    args.includes("GET")
      ? '{"users":[{"login":"--jq=$(id)"},{"login":"alice"}],"teams":[]}'
      : "{}"
  );

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 19,
    base: "milestone/v2",
  }, { ghCommandFn: rec.fn });

  assertEquals(outcome, "cleared");
  const args = reviewerCalls(rec.calls, "DELETE")[0]!;
  assert(args.includes("reviewers[]=alice"), args.join(" "));
  assertEquals(
    args.some((v) => v.includes("$(id)")),
    false,
    `a non-login value reached the argv: ${args.join(" ")}`,
  );
});

Deno.test("clearMilestoneReviewRequests - unreadable JSON warns rather than deleting blindly", async () => {
  const warnings: string[] = [];
  const rec = recorder(() => "not json at all");

  const outcome = await clearMilestoneReviewRequests({
    repo: "acme/widgets",
    prNumber: 20,
    base: "milestone/v2",
  }, { ghCommandFn: rec.fn, warn: (m) => warnings.push(m) });

  assertEquals(outcome, "failed");
  assertEquals(warnings.length, 1);
  assertEquals(reviewerCalls(rec.calls, "DELETE").length, 0);
});
