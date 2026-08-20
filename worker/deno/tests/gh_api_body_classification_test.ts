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
    bodyFilePath: "/tmp/b.json",
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
  // `gh` reads a `@`-prefixed `-F`/`--field` value from that file, so the body
  // it sends is not the one the argv shows — true on a REST endpoint too, not
  // just on `graphql`. Only `-F`/`--field` expand `@` (Issue #93).
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "-F",
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

Deno.test("classifyGhMutation - graphql query=@file on -F/--field is undeterminable, not a read", () => {
  // Only `-F`/`--field` read the document from the file, so only they hide it
  // from the argv and must fail closed (Issue #93).
  for (const flag of ["-F", "--field"]) {
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

Deno.test("classifyGhMutation - graphql query=@file on -f/--raw-field is a visible literal, not a file read", () => {
  // `-f`/`--raw-field` send `@/tmp/q.graphql` verbatim as the document — gh
  // does not expand `@` — so it is argv-visible, not a mutation, hence a read
  // (`classifyGhMutation` returns null). The argv shows exactly what gh sends.
  for (const flag of ["-f", "--raw-field"]) {
    const info = classifyGhMutation([
      "api",
      "graphql",
      flag,
      "query=@/tmp/q.graphql",
    ]);
    assertEquals(info, null, `flag ${flag}`);
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

Deno.test("evaluateGhCommand - an --input write is refused for its unreadable body, before the repo check even runs (Issue #90)", () => {
  const ctx = { active: true, allowedRepos: ["me/target"] };
  const decision = evaluateGhCommand(
    ["api", "repos/attacker/evil/issues/1/labels", "--input", "-"],
    ctx,
  );
  assertEquals(decision.allowed, false);
  // The fail-closed unreadable-body backstop (#90) fires in the unconditional
  // block before the write-repo allowlist, so this now reports the stronger,
  // earlier marker rather than WRITE_REPO_BLOCKED.
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("evaluateGhCommand - fails closed on an --input REST mutation to the OWN repo, allowlist inert (Issue #90)", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "--input", "/tmp/b.json"],
    { active: false, allowedRepos: [] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
  if (!decision.allowed) {
    assertStringIncludes(decision.reason ?? "", "--input");
    assertStringIncludes(decision.reason ?? "", "-f");
  }
});

Deno.test("evaluateGhCommand - the unreadable-body refusal holds with an active allowlist naming the repo (Issue #90)", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "--input", "/tmp/b.json"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "GH_BODY_UNREADABLE");
});

Deno.test("evaluateGhCommand - a visible reserved label still wins over the unreadable-body marker (order preserved)", () => {
  const decision = evaluateGhCommand(
    [
      "api",
      "repos/o/r/issues/1/labels",
      "--input",
      "-",
      "-f",
      "labels[]=top-priority",
    ],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, false);
  assertEquals(decision.marker, "WORKER_LABEL_REFUSED");
});

Deno.test("evaluateGhCommand - an argv-visible body (-f only) is not blocked by the unreadable-body backstop", () => {
  const decision = evaluateGhCommand(
    ["api", "repos/o/r/issues/1/labels", "-f", "labels[]=bug"],
    { active: true, allowedRepos: ["o/r"] },
  );
  assertEquals(decision.allowed, true);
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

// ---------------------------------------------------------------------------
// Issue #91 — the classifier surfaces a readable `--input` path so the guard
// can scan it, and leaves it absent for the unscannable `-` (stdin) form.
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation - captures a readable --input path as bodyFilePath (#91)", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input",
    "/tmp/body.json",
  ]);
  assertEquals(info?.unreadableBody, true);
  assertEquals(info?.bodyFilePath, "/tmp/body.json");
});

Deno.test("classifyGhMutation - captures the --input=<path> equals form too (#91)", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input=/tmp/body.json",
  ]);
  assertEquals(info?.bodyFilePath, "/tmp/body.json");
});

Deno.test("classifyGhMutation - leaves bodyFilePath absent for --input - (stdin) (#91)", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--input",
    "-",
  ]);
  assertEquals(info?.unreadableBody, true);
  assertEquals(info?.bodyFilePath, undefined);
});

// ---------------------------------------------------------------------------
// Issue #93 — a `@file`-sourced `-F`/`--field` value is unreadable too
//
// `gh -F 'labels[]=@/tmp/l.txt'` reads the value from a file, so the argv
// cannot show it — the same blind spot as `--input`, on the field path.
// Verified against gh 2.97.0: only `-F`/`--field` expand a leading `@`;
// `-f`/`--raw-field` add a static string and never expand it.
// ---------------------------------------------------------------------------

Deno.test("classifyGhMutation #93 - an @file -F field value is unreadable", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "-F",
    "labels[]=@/tmp/l.txt",
  ]);
  assertEquals(info?.unreadableBody, true);
});

Deno.test("classifyGhMutation #93 - the --field=key=@path equals form is unreadable too", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "--field=labels[]=@/tmp/l.txt",
  ]);
  assertEquals(info?.unreadableBody, true);
});

Deno.test("classifyGhMutation #93 - a raw-field -f @literal value is NOT unreadable (no @ expansion)", () => {
  // `-f`/`--raw-field` send the value literally; `@literal` is a real string,
  // not a file, so the body stays argv-visible.
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "-f",
    "labels[]=@literal",
  ]);
  assertEquals(info?.unreadableBody, undefined);
});

Deno.test("classifyGhMutation #93 - a plain -F value with no @ is unchanged", () => {
  const info = classifyGhMutation([
    "api",
    "repos/o/r/issues/1/labels",
    "-F",
    "labels[]=bug",
  ]);
  assertEquals(info?.unreadableBody, undefined);
});
