/**
 * Tests for the two `gh api` shapes that classified as reads (Issue #3937).
 *
 * `gh api <endpoint> --input <file>` really issues a POST, and
 * `gh api graphql -F query=@<file>` hands `gh` a document the argv cannot
 * show. Both previously returned `null` from {@link classifyGhMutation}, and
 * every downstream control — the audit journal, the write-repo allowlist and
 * the agent-side guard — short-circuits on `null`, so all three were bypassed
 * at once.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  enforceGhWriteAllowlist,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteRepoBlockedError,
  WriteTargetUndeterminableError,
} from "../lib/write_repo_allowlist.ts";
import type { AuditMutation } from "../lib/audit_journal.ts";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";

// ---------------------------------------------------------------------------
// Shape A — `--input` with no `-X`
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - api --input implies POST without -X", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input",
    "-",
  ]);
  assertEquals(info?.verb, "api-post");
  assertEquals(info?.repo, "o/r");
  assertEquals(info?.scope, "explicit");
});

Deno.test("classifyGhMutation - api --input=<file> implies POST", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input=/tmp/body.json",
  ]);
  assertEquals(info?.verb, "api-post");
  assertEquals(info?.repo, "o/r");
});

Deno.test("classifyGhMutation - an explicit method still wins over --input", () => {
  assertEquals(
    classifyGhMutation([
      "api",
      "repos/o/r/issues",
      "-X",
      "GET",
      "--input",
      "-",
    ]),
    null,
  );
  assertEquals(
    classifyGhMutation([
      "api",
      "repos/o/r/issues/1",
      "--method=PATCH",
      "--input",
      "-",
    ])?.verb,
    "api-patch",
  );
});

Deno.test("classifyGhMutation - --input does not turn its value into the endpoint", () => {
  const info = classifyGhMutation([
    "api",
    "--input",
    "/tmp/body.json",
    "repos/o/r/issues",
  ]);
  assertEquals(info?.target, "repos/o/r/issues");
  assertEquals(info?.repo, "o/r");
});

// ---------------------------------------------------------------------------
// `unreadableBody` on the REST return path (Issue #89)
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - REST --input surfaces unreadableBody", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input",
    "/tmp/b.json",
  ]);
  assertEquals(info, {
    verb: "api-post",
    repo: "o/r",
    target: "repos/o/r/issues/1/labels",
    scope: "explicit",
    unreadableBody: true,
  });
});

Deno.test("classifyGhMutation - REST --input=<file> surfaces unreadableBody", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input=/tmp/b.json",
  ]);
  assertEquals(info?.unreadableBody, true);
});

Deno.test("classifyGhMutation - a REST @file query= field surfaces unreadableBody", () => {
  // `gh` reads a `@`-prefixed `query=` value from that file, so the body it
  // sends is not the one the argv shows — true on a REST endpoint too, not
  // just on `graphql`.
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "-f",
    "query=@/tmp/b.json",
  ]);
  assertEquals(info?.unreadableBody, true);
});

Deno.test("classifyGhMutation - an argv-visible REST body leaves unreadableBody absent", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "-f",
    "labels[]=bug",
  ]);
  assertEquals(info?.unreadableBody, undefined);
  // Deep equality: the field must be absent, not `false`, so existing
  // assertions on argv-visible mutations keep passing.
  assertEquals(info, {
    verb: "api-post",
    repo: "o/r",
    target: "repos/o/r/issues/1/labels",
    scope: "explicit",
  });
});

Deno.test("classifyGhMutation - a GET with --input stays a read, flag or not", () => {
  assertEquals(
    classifyGhMutation([
      "api",
      "repos/o/r/issues",
      "-X",
      "GET",
      "--input",
      "/tmp/b.json",
    ]),
    null,
  );
});

Deno.test("classifyGhMutation - an explicit PATCH with --input surfaces unreadableBody", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1",
    "--method=PATCH",
    "--input",
    "-",
  ]);
  assertEquals(info?.verb, "api-patch");
  assertEquals(info?.unreadableBody, true);
});

// ---------------------------------------------------------------------------
// Shape B — a GraphQL document `gh` reads from a file
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - graphql query=@file is undeterminable, not a read", () => {
  for (const flag of ["-F", "-f", "--field", "--raw-field"]) {
    const info = classifyGhMutation([
      "api",
      "graphql",
      flag,
      "query=@/tmp/q.graphql",
    ]);
    assertEquals(info?.scope, "unknown", `flag ${flag}`);
    assertEquals(info?.verb, "api-graphql-unknown", `flag ${flag}`);
  }
});

Deno.test("classifyGhMutation - graphql query=@- (stdin) is undeterminable", () => {
  const info = classifyGhMutation([
    "api",
    "graphql",
    "--field=query=@-",
  ]);
  assertEquals(info?.scope, "unknown");
});

Deno.test("classifyGhMutation - graphql --input body is undeterminable", () => {
  const info = classifyGhMutation(["api", "graphql", "--input", "-"]);
  assertEquals(info?.scope, "unknown");
  assertEquals(info?.verb, "api-graphql-unknown");
});

Deno.test("classifyGhMutation - an unreadable document sinks a sanctioned mutation", () => {
  // A visible sanctioned mutation alongside an unreadable one must not be
  // waved through on the strength of the half the argv shows.
  const info = classifyGhMutation([
    "api",
    "graphql",
    "-f",
    "query=mutation($m:String!){changeUserStatus(input:{message:$m}){status{message}}}",
    "--input",
    "-",
  ]);
  assertEquals(info?.verb, "api-graphql-mutation");
  assertEquals(info?.scope, "unknown");
});

Deno.test("classifyGhMutation - inline graphql documents are unaffected", () => {
  assertEquals(
    classifyGhMutation(["api", "graphql", "-f", "query=query{viewer{login}}"]),
    null,
  );
  const info = classifyGhMutation([
    "api",
    "graphql",
    "-f",
    "query=mutation($m:String!){changeUserStatus(input:{message:$m}){status{message}}}",
  ]);
  assertEquals(info?.scope, "non-repo");
});

// ---------------------------------------------------------------------------
// The three controls that short-circuited on `null`
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

Deno.test("enforceGhWriteAllowlist - refuses an off-allowlist --input POST", async () => {
  const { entries, logs } = captureSinks();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        enforceGhWriteAllowlist([
          "api",
          "repos/attacker/evil/issues",
          "--input",
          "-",
        ]),
      WriteRepoBlockedError,
    );
    assertEquals(entries[0]?.verb, "blocked-api-post");
    assertStringIncludes(logs[0] ?? "", "[WRITE_REPO_BLOCKED]");
    // The on-allowlist repo still passes.
    await enforceGhWriteAllowlist([
      "api",
      "repos/me/target/issues",
      "--input",
      "-",
    ]);
  } finally {
    resetWriteRepoAllowlist();
    _resetWriteRepoAllowlistSinks();
  }
});

Deno.test("enforceGhWriteAllowlist - refuses a graphql document read from a file", async () => {
  const { entries } = captureSinks();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        enforceGhWriteAllowlist([
          "api",
          "graphql",
          "-F",
          "query=@/tmp/q.graphql",
        ]),
      WriteTargetUndeterminableError,
    );
    assertEquals(entries[0]?.verb, "blocked-api-graphql-unknown");
  } finally {
    resetWriteRepoAllowlist();
    _resetWriteRepoAllowlistSinks();
  }
});

Deno.test("evaluateGhCommand - refuses the agent's --input write to another repo", () => {
  const ctx = { active: true, allowedRepos: ["me/target"] };
  const decision = evaluateGhCommand(
    ["api", "repos/attacker/evil/issues/1/labels", "--input", "-"],
    ctx,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_REPO_BLOCKED");
});

Deno.test("evaluateGhCommand - refuses an unreadable graphql document", () => {
  const ctx = { active: true, allowedRepos: ["me/target"] };
  const decision = evaluateGhCommand(
    ["api", "graphql", "-F", "query=@/tmp/q.graphql"],
    ctx,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WRITE_TARGET_UNDETERMINABLE");
});

Deno.test("evaluateGhCommand - refuses a reserved label added via --input POST argv", () => {
  const ctx = { active: true, allowedRepos: ["me/target"] };
  const decision = evaluateGhCommand(
    [
      "api",
      "repos/me/target/issues/1/labels",
      "--input",
      "-",
      "-f",
      "labels[]=work-on",
    ],
    ctx,
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
});

Deno.test("evaluateGhCommand - a GET with --input stays a read", () => {
  const ctx = { active: true, allowedRepos: ["me/target"] };
  assertEquals(
    evaluateGhCommand(
      ["api", "repos/attacker/evil/issues", "-X", "GET", "--input", "-"],
      ctx,
    ).allowed,
    true,
  );
});
