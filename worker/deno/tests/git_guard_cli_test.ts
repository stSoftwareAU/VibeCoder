/**
 * Tests for the `git` guard CLI the agent-side shim invokes (Issue #1284).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  encodeGitGuardStdout,
  GIT_GUARD_ALLOW_MARKER,
  GIT_GUARD_REFUSE_MARKER,
  runGitGuardCli,
} from "../lib/git_guard_cli.ts";

/** A known-shaped fake GitHub token — never a real credential. */
const FAKE_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

/** The placeholder `redactSecrets` substitutes. */
const MASK = "***REDACTED***";

Deno.test("git guard cli - returns the redacted argv for a commit message", () => {
  const result = runGitGuardCli([
    "--",
    "commit",
    "-m",
    `chore: ${FAKE_TOKEN}`,
  ]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.stdout, GIT_GUARD_ALLOW_MARKER);
  assertEquals(result.gitArgs, ["commit", "-m", `chore: ${MASK}`]);
  assertStringIncludes(result.stderr, "GIT_MESSAGE_REDACTED");
});

Deno.test("git guard cli - masks a clustered -am message", () => {
  const result = runGitGuardCli(["--", "commit", "-am", FAKE_TOKEN]);
  assertEquals(result.gitArgs, ["commit", "-am", MASK]);
});

Deno.test("git guard cli - reads a -F message file through the injected reader", () => {
  const result = runGitGuardCli(
    ["--", "commit", "-F", "/tmp/msg.txt"],
    () => `subject\n\n${FAKE_TOKEN}\n`,
  );
  assertEquals(result.gitArgs, ["commit", "-m", `subject\n\n${MASK}\n`]);
});

Deno.test("git guard cli - passes an ordinary command through unchanged", () => {
  const result = runGitGuardCli(["--", "status", "--short"]);
  assertEquals(result.exitCode, 0);
  assertEquals(result.gitArgs, ["status", "--short"]);
  assertEquals(result.stderr, "");
});

Deno.test("git guard cli - refuses a message it cannot scan", () => {
  const result = runGitGuardCli(["--", "commit", "-F", "-"]);
  assertEquals(result.exitCode, 1);
  assertEquals(result.stdout, GIT_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "GIT_MESSAGE_UNREDACTABLE");
  assertEquals(result.gitArgs, undefined);
});

Deno.test("git guard cli - a malformed invocation refuses", () => {
  const result = runGitGuardCli(["commit", "-m", "no separator"]);
  assertEquals(result.exitCode, 2);
  assertEquals(result.stdout, GIT_GUARD_REFUSE_MARKER);
  assertStringIncludes(result.stderr, "GIT_GUARD_ERROR");
});

Deno.test("git guard cli - frames the verdict as NUL-terminated fields", () => {
  assertEquals(
    encodeGitGuardStdout({
      exitCode: 0,
      stdout: GIT_GUARD_ALLOW_MARKER,
      stderr: "",
      gitArgs: ["commit", "-m", "line one\nline two"],
    }),
    `${GIT_GUARD_ALLOW_MARKER}\0commit\0-m\0line one\nline two\0`,
  );
});

Deno.test("git guard cli - a refusal frames the marker alone", () => {
  assertEquals(
    encodeGitGuardStdout({
      exitCode: 1,
      stdout: GIT_GUARD_REFUSE_MARKER,
      stderr: "why",
    }),
    `${GIT_GUARD_REFUSE_MARKER}\0`,
  );
});
