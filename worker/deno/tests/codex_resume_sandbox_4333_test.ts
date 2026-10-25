/**
 * Resumed orchestrated Codex runs must not pass `--sandbox` (Issue #4333).
 *
 * `codex exec resume` rejects `--sandbox` (confirmed against `codex exec resume
 * --help` on CLI 0.163/0.164). The sandbox mode still has to reach the CLI, so
 * a resumed orchestrated run sets `sandbox_mode` with `-c`. A fresh
 * orchestrated run keeps `--sandbox`. A resumed run with no orchestration role
 * keeps the bypass flag and does not invent a sandbox mode.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { buildCodexArgs } from "../lib/codex_executor.ts";

const EXECUTOR_SESSION = "11111111-4333-4333-4333-111111111111";
const REVIEWER_SESSION = "22222222-4333-4333-4333-222222222222";
const PLAIN_SESSION = "33333333-4333-4333-4333-333333333333";

/**
 * Flags `codex exec resume --help` lists. Written here so the test does not
 * spawn Codex. Short and long forms are both accepted.
 */
const RESUME_ACCEPTED_FLAGS = new Set([
  "-c",
  "--config",
  "--last",
  "--all",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "--strict-config",
  "-m",
  "--model",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--worktree",
  "--thread-source",
  "--cyber-access-program",
  "--skip-git-repo-check",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--json",
  "-o",
  "--output-last-message",
  "-h",
  "--help",
]);

/** Index of a config value that must sit immediately after `-c`. */
function configValueIndex(args: readonly string[], value: string): number {
  const index = args.indexOf(value);
  assert(index > 0, `missing config value ${value}`);
  assertEquals(args[index - 1], "-c");
  return index;
}

/**
 * After `resume`, every token that starts with `-` must be a flag the resume
 * subcommand accepts. The session id and the prompt are arguments.
 */
function assertResumeFlagsAccepted(args: readonly string[]): void {
  const resumeAt = args.indexOf("resume");
  assert(resumeAt >= 0, "resume subcommand missing");
  for (const token of args.slice(resumeAt + 1)) {
    if (!token.startsWith("-")) continue;
    assert(
      RESUME_ACCEPTED_FLAGS.has(token),
      `codex exec resume rejects ${token}`,
    );
  }
  assertEquals(args.includes("--sandbox"), false);
}

Deno.test("resumed orchestrated executor sets sandbox_mode and omits --sandbox (Issue #4333)", () => {
  const args = buildCodexArgs({
    prompt: "continue the executor run",
    resumeSessionId: EXECUTOR_SESSION,
    orchestrationRole: "executor",
  });

  assertEquals(args.slice(0, 3), ["exec", "resume", EXECUTOR_SESSION]);
  assertEquals(args.includes("--sandbox"), false);
  configValueIndex(args, 'sandbox_mode="workspace-write"');
  assert(args.includes("sandbox_workspace_write.network_access=false"));
  assert(args.includes('approval_policy="never"'));
  assert(args.includes("features.multi_agent=false"));
  assertResumeFlagsAccepted(args);
});

Deno.test("resumed orchestrated reviewer sets a read-only sandbox_mode (Issue #4333)", () => {
  const args = buildCodexArgs({
    prompt: "continue the review",
    resumeSessionId: REVIEWER_SESSION,
    orchestrationRole: "reviewer",
  });

  assertEquals(args.includes("--sandbox"), false);
  configValueIndex(args, 'sandbox_mode="read-only"');
  assertEquals(args.includes('sandbox_mode="workspace-write"'), false);
  assertResumeFlagsAccepted(args);
});

Deno.test("resumed orchestrated manager keeps the read-only sandbox mode (Issue #4333)", () => {
  const args = buildCodexArgs({
    prompt: "continue the manager run",
    resumeSessionId: REVIEWER_SESSION,
    orchestrationRole: "manager",
  });

  assertEquals(args.includes("--sandbox"), false);
  configValueIndex(args, 'sandbox_mode="read-only"');
  assertResumeFlagsAccepted(args);
});

Deno.test("fresh orchestrated executor still passes --sandbox workspace-write (Issue #4333)", () => {
  const args = buildCodexArgs({
    prompt: "start the executor run",
    orchestrationRole: "executor",
  });

  const sandboxAt = args.indexOf("--sandbox");
  assert(sandboxAt >= 0, "--sandbox missing on a fresh orchestrated run");
  assertEquals(args[sandboxAt + 1], "workspace-write");
  assertEquals(args.includes("resume"), false);
  assertEquals(
    args.some((arg) => arg.includes("sandbox_mode=")),
    false,
  );
});

Deno.test("resumed non-orchestrated run keeps the sandbox bypass (Issue #4333)", () => {
  const args = buildCodexArgs({
    prompt: "continue a plain run",
    resumeSessionId: PLAIN_SESSION,
  });

  assertEquals(args.slice(0, 3), ["exec", "resume", PLAIN_SESSION]);
  assert(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assertEquals(
    args.some((arg) => arg.includes("sandbox_mode=")),
    false,
  );
  assertResumeFlagsAccepted(args);
});
