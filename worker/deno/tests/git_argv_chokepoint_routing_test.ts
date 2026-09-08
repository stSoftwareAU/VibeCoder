/**
 * Tests for routing a full `git …` argv through the shared chokepoint
 * (Issue #1553).
 *
 * The generic pass-through runners across the worker take an argv whose head
 * is the binary. When that head is `git` the call must reach
 * `runGitCommand` — otherwise it runs outside the `AbortController` timeout
 * (Issue #619), the git-mutation audit journal (Issue #2380) and the
 * work-volume fault detector (Issue #229).
 *
 * The observable used here is the chokepoint's own message-redaction refusal
 * (Issue #1284): `git commit -F <unreadable>` is refused with a
 * `[GIT_MESSAGE_UNREDACTABLE]` marker *before* any subprocess is spawned. A
 * runner that spawns `git` itself cannot produce that marker, so the marker
 * is proof the argv went through the chokepoint.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runGitArgv } from "../lib/git_timeout.ts";
import { defaultRunCommand } from "../commands/resolve_cross_repo_dep.ts";

/** A message file that cannot exist, so the chokepoint refuses loudly. */
const UNREADABLE_MESSAGE_ARGV = [
  "git",
  "commit",
  "-F",
  "/nonexistent/vibe-1553/message.txt",
];

Deno.test("runGitArgv - drops the git head and runs the rest through the chokepoint", async () => {
  const output = await runGitArgv(["git", "--version"]);
  assertEquals(output.success, true);
  assertStringIncludes(output.stdout, "git version");
});

Deno.test("runGitArgv - a non-zero git exit is reported as a failure", async () => {
  const output = await runGitArgv([
    "git",
    "rev-parse",
    "--verify",
    "refs/heads/vibe-1553-no-such-branch",
  ]);
  assertEquals(output.success, false);
});

Deno.test("runGitArgv - the chokepoint's message-redaction refusal is surfaced", async () => {
  const output = await runGitArgv(UNREADABLE_MESSAGE_ARGV);
  assertEquals(output.success, false);
  assertStringIncludes(output.stderr, "[GIT_MESSAGE_UNREDACTABLE]");
});

Deno.test("resolve-cross-repo-dep defaultRunCommand - a git argv is routed through the chokepoint", async () => {
  const output = await defaultRunCommand(UNREADABLE_MESSAGE_ARGV);
  assertEquals(output.success, false);
  assertStringIncludes(output.stderr, "[GIT_MESSAGE_UNREDACTABLE]");
});

Deno.test("resolve-cross-repo-dep defaultRunCommand - a non-git binary is still spawned directly", async () => {
  const output = await defaultRunCommand(["echo", "vibe-1553"]);
  assertEquals(output.success, true);
  assertEquals(output.stdout, "vibe-1553");
});
