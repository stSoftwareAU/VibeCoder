/**
 * Tests for the fail-closed `gh` mutation classification and the write-repo
 * allowlist's refusal of undeterminable targets (Issue #3703).
 *
 * Covers the two halves of SEC-5f4e0d268ba9: the classifier now derives a
 * {@link MutationScope} (so a GraphQL mutation, an absolute API endpoint or an
 * unlisted root verb is no longer invisible), and `enforceGhWriteAllowlist`
 * refuses a mutation it cannot attribute to a repo instead of returning early.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  classifyGhMutation,
  classifyGitMutation,
  graphqlMutationFields,
} from "../lib/audit_mutation_classifier.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  enforceGhWriteAllowlist,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteTargetUndeterminableError,
} from "../lib/write_repo_allowlist.ts";
import type { AuditMutation } from "../lib/audit_journal.ts";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";

// ---------------------------------------------------------------------------
// Classifier — scope derivation
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - explicit repo flag yields explicit scope", () => {
  const info = classifyGhMutation([
    "issue",
    "close",
    "7",
    "-R",
    "org/other",
  ]);
  assertEquals(info?.scope, "explicit");
  assertEquals(info?.repo, "org/other");
});

Deno.test("classifyGhMutation - repo-scoped verb without -R is cwd scope", () => {
  const info = classifyGhMutation(["pr", "merge", "12", "--squash"]);
  assertEquals(info?.scope, "cwd");
  assertEquals(info?.repo, undefined);
});

Deno.test("classifyGhMutation - absolute API endpoint still derives the repo", () => {
  const info = classifyGhMutation([
    "api",
    "-X",
    "PATCH",
    "https://api.github.com/repos/acme/widget/issues/5",
    "-f",
    "state=closed",
  ]);
  assertEquals(info?.repo, "acme/widget");
  assertEquals(info?.scope, "explicit");
});

Deno.test("classifyGhMutation - repos placeholder endpoint is cwd scope", () => {
  const info = classifyGhMutation([
    "api",
    "-X",
    "POST",
    "repos/{owner}/{repo}/issues/5/comments",
    "-f",
    "body=hi",
  ]);
  assertEquals(info?.repo, undefined);
  assertEquals(info?.scope, "cwd");
});

Deno.test("classifyGhMutation - non-repo endpoint fails closed as unknown scope", () => {
  const info = classifyGhMutation(["api", "-X", "POST", "gists", "-f", "x=1"]);
  assertEquals(info?.verb, "api-post");
  assertEquals(info?.scope, "unknown");
});

Deno.test("classifyGhMutation - unlisted root verb with a mutating sub-verb is classified", () => {
  const info = classifyGhMutation(["gist", "create", "leak.txt"]);
  assertEquals(info?.verb, "gist-create");
  assertEquals(info?.scope, "unknown");
});

Deno.test("classifyGhMutation - unlisted root verb read is still a read", () => {
  assertEquals(classifyGhMutation(["ruleset", "list"]), null);
  assertEquals(classifyGhMutation(["gist", "view", "abc"]), null);
});

Deno.test("classifyGhMutation - workflow run is a cwd-scoped mutation", () => {
  const info = classifyGhMutation(["workflow", "run", "ci.yml"]);
  assertEquals(info?.verb, "workflow-run");
  assertEquals(info?.scope, "cwd");
});

Deno.test("classifyGhMutation - gh repo delete names its target positionally", () => {
  const info = classifyGhMutation(["repo", "delete", "org/victim", "--yes"]);
  assertEquals(info?.repo, "org/victim");
  assertEquals(info?.scope, "explicit");
});

Deno.test("classifyGhMutation - bare gh repo create cannot be attributed", () => {
  const info = classifyGhMutation(["repo", "create", "sneaky", "--public"]);
  assertEquals(info?.verb, "repo-create");
  assertEquals(info?.scope, "unknown");
});

Deno.test("classifyGitMutation - push is cwd scoped", () => {
  assertEquals(classifyGitMutation(["push", "origin", "main"])?.scope, "cwd");
});

// ---------------------------------------------------------------------------
// Classifier — GraphQL
// ---------------------------------------------------------------------------

Deno.test("graphqlMutationFields - returns null for a read query", () => {
  assertEquals(
    graphqlMutationFields("query($o:String!){repository(owner:$o){id}}"),
    null,
  );
});

Deno.test("graphqlMutationFields - extracts only top-level mutation fields", () => {
  const fields = graphqlMutationFields(
    `mutation($id:ID!){addComment(input:{subjectId:$id,body:"x"}){` +
      `commentEdge{node{id}}}}`,
  );
  assertEquals(fields, ["addComment"]);
});

Deno.test("classifyGhMutation - graphql read query is not a mutation", () => {
  const info = classifyGhMutation([
    "api",
    "graphql",
    "-f",
    "query=query{viewer{login}}",
  ]);
  assertEquals(info, null);
});

Deno.test("classifyGhMutation - graphql mutation fails closed", () => {
  const info = classifyGhMutation([
    "api",
    "graphql",
    "-f",
    'query=mutation{addComment(input:{subjectId:"x",body:"leak"}){clientMutationId}}',
  ]);
  assertEquals(info?.verb, "api-graphql-mutation");
  assertEquals(info?.scope, "unknown");
});

Deno.test("classifyGhMutation - sanctioned non-repo graphql mutation is allowed", () => {
  const info = classifyGhMutation([
    "api",
    "graphql",
    "-f",
    "query=mutation($emoji:String!,$message:String!,$busy:Boolean!){" +
    "changeUserStatus(input:{emoji:$emoji,message:$message,limitedAvailability:$busy})" +
    "{status{message}}}",
    "-f",
    "emoji=:robot:",
  ]);
  assertEquals(info?.verb, "api-graphql-mutation");
  assertEquals(info?.scope, "non-repo");
});

// ---------------------------------------------------------------------------
// Allowlist — fail closed
// ---------------------------------------------------------------------------

/** Capture journal entries and security log lines for one enforcement call. */
function captureSinks(): { entries: AuditMutation[]; logs: string[] } {
  const entries: AuditMutation[] = [];
  const logs: string[] = [];
  _setWriteRepoAllowlistSinks({
    record: (m) => {
      entries.push(m);
      return Promise.resolve({ ok: true, value: undefined as never });
    },
    log: (m) => logs.push(m),
  });
  return { entries, logs };
}

Deno.test("enforceGhWriteAllowlist - refuses a graphql mutation and journals it", async () => {
  const { entries, logs } = captureSinks();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        enforceGhWriteAllowlist([
          "api",
          "graphql",
          "-f",
          'query=mutation{addComment(input:{subjectId:"x",body:"leak"}){id}}',
        ]),
      WriteTargetUndeterminableError,
    );
    assertEquals(entries.length, 1);
    assertEquals(entries[0]?.verb, "blocked-api-graphql-mutation");
    assertEquals(entries[0]?.outcome, "error");
    assertStringIncludes(logs[0] ?? "", "[WRITE_TARGET_UNDETERMINABLE]");
  } finally {
    resetWriteRepoAllowlist();
    _resetWriteRepoAllowlistSinks();
  }
});

Deno.test("enforceGhWriteAllowlist - refuses gist create and an unlisted root verb", async () => {
  captureSinks();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () => enforceGhWriteAllowlist(["gist", "create", "secrets.txt"]),
      WriteTargetUndeterminableError,
    );
    await assertRejects(
      () => enforceGhWriteAllowlist(["api", "-X", "POST", "gists"]),
      WriteTargetUndeterminableError,
    );
  } finally {
    resetWriteRepoAllowlist();
    _resetWriteRepoAllowlistSinks();
  }
});

Deno.test("enforceGhWriteAllowlist - allows cwd writes, reads and sanctioned status mutations", async () => {
  captureSinks();
  seedWriteRepoAllowlist("me/target");
  try {
    // cwd-scoped write (no explicit repo) — the run's own clone.
    await enforceGhWriteAllowlist(["issue", "comment", "5", "--body", "hi"]);
    // Read.
    await enforceGhWriteAllowlist(["issue", "view", "5"]);
    // GraphQL read.
    await enforceGhWriteAllowlist([
      "api",
      "graphql",
      "-f",
      "query=query{viewer{login}}",
    ]);
    // Sanctioned non-repo mutation (worker profile status).
    await enforceGhWriteAllowlist([
      "api",
      "graphql",
      "-f",
      "query=mutation($m:String!){changeUserStatus(input:{message:$m}){status{message}}}",
    ]);
    // Explicit, on-allowlist repo.
    await enforceGhWriteAllowlist([
      "issue",
      "comment",
      "5",
      "-R",
      "me/target",
      "--body",
      "hi",
    ]);
  } finally {
    resetWriteRepoAllowlist();
    _resetWriteRepoAllowlistSinks();
  }
});

Deno.test("enforceGhWriteAllowlist - stays inert until a run seeds the allowlist", async () => {
  captureSinks();
  resetWriteRepoAllowlist();
  try {
    // No seed — even an undeterminable target passes (fail-open until seeded).
    await enforceGhWriteAllowlist(["gist", "create", "secrets.txt"]);
  } finally {
    _resetWriteRepoAllowlistSinks();
  }
});

// ---------------------------------------------------------------------------
// Agent-side guard mirrors the same decision
// ---------------------------------------------------------------------------

Deno.test("evaluateGhCommand - refuses an undeterminable agent mutation", () => {
  const decision = evaluateGhCommand(
    ["gist", "create", "dump.txt"],
    { active: true, allowedRepos: ["me/target"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_TARGET_UNDETERMINABLE");
});

Deno.test("evaluateGhCommand - allows cwd-scoped agent writes and reads", () => {
  const ctx = { active: true, allowedRepos: ["me/target"] };
  assertEquals(
    evaluateGhCommand(["issue", "comment", "5", "--body", "hi"], ctx).allowed,
    true,
  );
  assertEquals(evaluateGhCommand(["issue", "list"], ctx).allowed, true);
});

Deno.test("evaluateGhCommand - inert guard allows an undeterminable mutation", () => {
  const decision = evaluateGhCommand(
    ["gist", "create", "dump.txt"],
    { active: false, allowedRepos: [] },
  );
  assertEquals(decision.allowed, true);
});
