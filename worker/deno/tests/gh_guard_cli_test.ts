/**
 * Tests for gh_guard_cli.ts — the entry point the agent-side `gh` shim runs
 * once per `gh` invocation (Issue #3643).
 *
 * The shim trusts a positive verdict marker on stdout, never a bare exit code,
 * so these tests assert the marker/exit-code pair for each outcome: allowed,
 * refused, and malformed invocation (which must fail closed).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  encodeGuardStdout,
  GH_GUARD_ALLOW_MARKER,
  GH_GUARD_REFUSE_MARKER,
  runGhGuardCli,
} from "../lib/gh_guard_cli.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

/** A realistic GitHub token shape used by the redaction assertions (#3938). */
const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

Deno.test("gh-guard-cli - emits the allow marker for a permitted write", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "issue",
    "comment",
    "1",
    "-R",
    "stSoftwareAU/VibeCoder",
    "--body",
    "hi",
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
  assertEquals(result.stderr, "");
});

Deno.test("gh-guard-cli - emits the refuse marker and a reason for a blocked write", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "issue",
    "comment",
    "1",
    "-R",
    "other/repo",
    "--body",
    "leak",
  ]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "[SECURITY] [WRITE_REPO_BLOCKED]");
});

// ---------------------------------------------------------------------------
// Issue #3938 — the guard is the agent's only chokepoint, so it redacts too
// ---------------------------------------------------------------------------

Deno.test("gh-guard-cli - returns the allowed argv with the body redacted", () => {
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    "issue",
    "comment",
    "1",
    "--body",
    `here it is: ${GH_TOKEN_SAMPLE}`,
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GH_GUARD_ALLOW_MARKER);
  assertEquals(result.ghArgs, [
    "issue",
    "comment",
    "1",
    "--body",
    `here it is: ${REDACTION_PLACEHOLDER}`,
  ]);
  // The masking is announced, never silent.
  assertStringIncludes(result.stderr, "GH_BODY_REDACTED");
});

Deno.test("gh-guard-cli - returns a clean command's argv unchanged and silently", () => {
  const argv = ["issue", "comment", "1", "--body", "hello world"];
  const result = runGhGuardCli([
    "--active",
    "--allow-repo",
    "stSoftwareAU/VibeCoder",
    "--",
    ...argv,
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.ghArgs, argv);
  assertEquals(result.stderr, "");
});

Deno.test("gh-guard-cli - redacts a secret carried in a body file", () => {
  const result = runGhGuardCli(
    [
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "issue",
      "comment",
      "1",
      "--body-file",
      "/tmp/body.md",
    ],
    () => `token ${GH_TOKEN_SAMPLE}`,
  );
  assertEquals(result.exitCode, 0);
  assertEquals(result.ghArgs, [
    "issue",
    "comment",
    "1",
    "--body",
    `token ${REDACTION_PLACEHOLDER}`,
  ]);
});

Deno.test("gh-guard-cli - refuses a body it cannot scan for secrets", () => {
  const result = runGhGuardCli(
    [
      "--active",
      "--allow-repo",
      "stSoftwareAU/VibeCoder",
      "--",
      "issue",
      "comment",
      "1",
      "--body-file",
      "/tmp/gone.md",
    ],
    () => {
      throw new Error("no such file");
    },
  );
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
  assertEquals(result.ghArgs, undefined);
  assertStringIncludes(result.stderr, "GH_BODY_UNREDACTABLE");
});

Deno.test("gh-guard-cli - frames the verdict and the argv as NUL-terminated fields", () => {
  assertEquals(
    encodeGuardStdout({
      exitCode: 0,
      stdout: GH_GUARD_ALLOW_MARKER,
      stderr: "",
      ghArgs: ["issue", "comment", "a b"],
    }),
    `${GH_GUARD_ALLOW_MARKER}\0issue\0comment\0a b\0`,
  );
  // A refusal carries the marker alone — there is no argv to run.
  assertEquals(
    encodeGuardStdout({
      exitCode: 1,
      stdout: GH_GUARD_REFUSE_MARKER,
      stderr: "no",
    }),
    `${GH_GUARD_REFUSE_MARKER}\0`,
  );
});

Deno.test("gh-guard-cli - fails closed on a malformed invocation", () => {
  for (
    const argv of [
      ["issue", "comment", "1"], // no `--` separator
      ["--allow-repo"], // flag with no value
      ["--bogus", "--", "issue", "comment", "1"],
    ]
  ) {
    const result = runGhGuardCli(argv);
    assertEquals(result.exitCode, 2, `expected exit 2 for ${argv}`);
    assertEquals(result.stdout, GH_GUARD_REFUSE_MARKER);
    assertStringIncludes(result.stderr, "GH_GUARD_ERROR");
  }
});
