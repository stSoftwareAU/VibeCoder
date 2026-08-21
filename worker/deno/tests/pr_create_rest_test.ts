/**
 * Tests for REST-backed pull-request creation (Issue #42).
 *
 * `gh pr create` is GraphQL-backed, so a run that has just spent 26 minutes
 * of agent time and passed the quality gate loses its PR the moment the
 * primary GraphQL quota is exhausted — the branch is pushed but orphaned.
 * The REST `pulls` endpoint rides the separate core quota, which is
 * typically still healthy, so it is the fallback that lands the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createPullRequestViaRest,
  findOpenPrUrlViaRest,
  isPrAlreadyExistsError,
} from "../lib/pr_create_rest.ts";

/** Record every gh invocation so we can assert on the calls made. */
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

Deno.test("createPullRequestViaRest - posts to the REST pulls endpoint and returns the URL", async () => {
  const rec = recorder(() => "https://github.com/acme/widgets/pull/7\n");

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "Fix the parser",
    body: "Closes #42",
    head: "issue-42-fix",
    base: "main",
  }, { ghCommandFn: rec.fn });

  assert(result.ok, `expected success, got: ${!result.ok && result.error}`);
  assertEquals(result.value, "https://github.com/acme/widgets/pull/7");

  assertEquals(rec.calls.length, 1);
  const args = rec.calls[0]!;
  assertEquals(args[0], "api");
  assert(args.includes("repos/acme/widgets/pulls"), args.join(" "));
  assert(args.includes("POST"), args.join(" "));
  assert(args.includes("title=Fix the parser"), args.join(" "));
  assert(args.includes("body=Closes #42"), args.join(" "));
  assert(args.includes("head=issue-42-fix"), args.join(" "));
  assert(args.includes("base=main"), args.join(" "));
});

Deno.test("createPullRequestViaRest - never issues a GraphQL-backed call", async () => {
  const rec = recorder((args) =>
    args.some((a) => a.includes("requested_reviewers"))
      ? ""
      : "https://github.com/acme/widgets/pull/8"
  );

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "branch",
    base: "main",
    reviewers: ["reviewer-one"],
  }, { ghCommandFn: rec.fn });

  assert(result.ok);
  // Every call must ride the core REST quota: `gh api <rest-path>`, never a
  // `gh <subcommand>` and never `gh api graphql`.
  for (const args of rec.calls) {
    assertEquals(args[0], "api", `not a REST call: ${args.join(" ")}`);
    assertEquals(
      args.includes("graphql"),
      false,
      `GraphQL call issued: ${args.join(" ")}`,
    );
  }
});

Deno.test("createPullRequestViaRest - requests reviewers via REST", async () => {
  const rec = recorder((args) =>
    args.includes("repos/acme/widgets/pulls/9/requested_reviewers")
      ? "{}"
      : "https://github.com/acme/widgets/pull/9"
  );

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "branch",
    base: "main",
    reviewers: ["alice", "bob"],
  }, { ghCommandFn: rec.fn });

  assert(result.ok);
  const reviewerCall = rec.calls.find((a) =>
    a.includes("repos/acme/widgets/pulls/9/requested_reviewers")
  );
  assert(reviewerCall, `no reviewer call made: ${JSON.stringify(rec.calls)}`);
  assert(reviewerCall.includes("reviewers[]=alice"), reviewerCall.join(" "));
  assert(reviewerCall.includes("reviewers[]=bob"), reviewerCall.join(" "));
});

Deno.test("createPullRequestViaRest - a failed reviewer request still returns the PR", async () => {
  const warnings: string[] = [];
  const rec = recorder((args) => {
    if (args.some((a) => a.includes("requested_reviewers"))) {
      throw new Error("HTTP 422: Reviewer is not a collaborator");
    }
    return "https://github.com/acme/widgets/pull/10";
  });

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "branch",
    base: "main",
    reviewers: ["stranger"],
  }, { ghCommandFn: rec.fn, log: (m) => warnings.push(m) });

  assert(result.ok, "a reviewer failure must not lose the created PR");
  assertEquals(result.value, "https://github.com/acme/widgets/pull/10");
  assert(
    warnings.some((w) => w.includes("Reviewer")),
    `reviewer failure must be logged, got: ${warnings.join(" | ")}`,
  );
});

Deno.test("createPullRequestViaRest - recovers the existing PR on a 422 already-exists", async () => {
  // The GraphQL pre-checks in the completion phase are skipped while the
  // quota is latched, so the REST create can race an existing PR. GitHub
  // answers 422; the existing PR is then read back over REST.
  const rec = recorder((args) => {
    if (args.includes("POST")) {
      throw new Error(
        "gh command failed (exit 1): HTTP 422: A pull request already exists for acme:issue-42-fix.",
      );
    }
    return "https://github.com/acme/widgets/pull/11";
  });

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "issue-42-fix",
    base: "main",
  }, { ghCommandFn: rec.fn });

  assert(result.ok, `expected recovery, got: ${!result.ok && result.error}`);
  assertEquals(result.value, "https://github.com/acme/widgets/pull/11");
});

Deno.test("createPullRequestViaRest - surfaces the underlying error on failure", async () => {
  const rec = recorder(() => {
    throw new Error("HTTP 403: Resource not accessible by integration");
  });

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "branch",
    base: "main",
  }, { ghCommandFn: rec.fn });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "HTTP 403");
    assertStringIncludes(result.error.message, "acme/widgets");
  }
});

Deno.test("createPullRequestViaRest - fails loudly when the response carries no URL", async () => {
  const rec = recorder(() => "null\n");

  const result = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "branch",
    base: "main",
  }, { ghCommandFn: rec.fn });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "html_url");
  }
});

Deno.test("createPullRequestViaRest - rejects a malformed repo before calling gh", async () => {
  const rec = recorder(() => "https://github.com/acme/widgets/pull/1");

  for (const repo of ["widgets", "", "acme/widgets/extra", "acme/../etc"]) {
    const result = await createPullRequestViaRest({
      repo,
      title: "T",
      body: "B",
      head: "branch",
      base: "main",
    }, { ghCommandFn: rec.fn });
    assertEquals(result.ok, false, `repo '${repo}' must be rejected`);
  }
  assertEquals(rec.calls.length, 0, "no gh call may be made for a bad repo");
});

Deno.test("createPullRequestViaRest - rejects an empty head or base before calling gh", async () => {
  const rec = recorder(() => "https://github.com/acme/widgets/pull/1");

  const noHead = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "",
    base: "main",
  }, { ghCommandFn: rec.fn });
  const noBase = await createPullRequestViaRest({
    repo: "acme/widgets",
    title: "T",
    body: "B",
    head: "branch",
    base: "",
  }, { ghCommandFn: rec.fn });

  assertEquals(noHead.ok, false);
  assertEquals(noBase.ok, false);
  assertEquals(rec.calls.length, 0);
});

Deno.test("findOpenPrUrlViaRest - queries the open PR for the head branch", async () => {
  const rec = recorder(() => "https://github.com/acme/widgets/pull/12\n");

  const result = await findOpenPrUrlViaRest(
    "acme/widgets",
    "issue-42-fix",
    rec.fn,
  );

  assert(result.ok);
  assertEquals(result.value, "https://github.com/acme/widgets/pull/12");
  const args = rec.calls[0]!;
  assertEquals(args[0], "api");
  assert(args.includes("repos/acme/widgets/pulls"), args.join(" "));
  assert(args.includes("head=acme:issue-42-fix"), args.join(" "));
  assert(args.includes("state=open"), args.join(" "));
});

Deno.test("findOpenPrUrlViaRest - reports no open PR rather than returning empty", async () => {
  const rec = recorder(() => "null\n");

  const result = await findOpenPrUrlViaRest("acme/widgets", "branch", rec.fn);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "No open PR");
  }
});

Deno.test("isPrAlreadyExistsError - matches GitHub's 422 wording only", () => {
  assert(isPrAlreadyExistsError("A pull request already exists for acme:x."));
  assert(isPrAlreadyExistsError("HTTP 422: a pull request already exists"));
  assertEquals(isPrAlreadyExistsError("HTTP 403: forbidden"), false);
  assertEquals(
    isPrAlreadyExistsError("GraphQL: API rate limit already exceeded"),
    false,
  );
});
