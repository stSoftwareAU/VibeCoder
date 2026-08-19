/**
 * Tests for branch_head_tracker.ts — detecting branch HEAD movement
 * across a Claude run (Issue #1861, part of #1855).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  branchHeadChanged,
  captureBranchHead,
  type GitRunner,
} from "../lib/branch_head_tracker.ts";
import type { Result } from "../types.ts";
import type {
  GitCommandOptions,
  GitCommandOutput,
} from "../lib/git_timeout.ts";

// ---------------------------------------------------------------------------
// Mock runner helpers
// ---------------------------------------------------------------------------

interface MockCall {
  args: string[];
  options?: GitCommandOptions;
}

interface MockResponse {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Fail with this Result.error instead of returning output. */
  fail?: Error;
}

/**
 * Build a queue-based mock runner. Each call dequeues the next response.
 */
function queuedMockRunner(
  responses: MockResponse[],
): { runner: GitRunner; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const queue = [...responses];

  const runner: GitRunner = (
    args: string[],
    options?: GitCommandOptions,
  ): Promise<Result<GitCommandOutput>> => {
    calls.push({ args: [...args], options });
    const next = queue.shift();
    if (!next) {
      throw new Error(`No mock response queued for: git ${args.join(" ")}`);
    }
    if (next.fail) {
      return Promise.resolve({ ok: false, error: next.fail });
    }
    return Promise.resolve({
      ok: true,
      value: {
        code: next.code ?? 0,
        stdout: next.stdout ?? "",
        stderr: next.stderr ?? "",
      },
    });
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// captureBranchHead
// ---------------------------------------------------------------------------

Deno.test("captureBranchHead - returns trimmed SHA on success", async () => {
  const sha = "abc1234567890abcdef1234567890abcdef12345";
  const { runner, calls } = queuedMockRunner([
    { code: 0, stdout: `${sha}\n` },
  ]);

  const result = await captureBranchHead("feature-branch", {
    gitRunner: runner,
    cwd: "/tmp/repo",
  });

  assert(result.ok, "expected ok result");
  assertEquals(result.value, sha);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args, ["rev-parse", "HEAD"]);
  assertEquals(calls[0]!.options?.cwd, "/tmp/repo");
});

Deno.test("captureBranchHead - surfaces non-zero exit code via Result.error", async () => {
  const { runner } = queuedMockRunner([
    {
      code: 128,
      stdout: "",
      stderr: "fatal: ambiguous argument 'HEAD': unknown revision",
    },
  ]);

  const result = await captureBranchHead("missing", { gitRunner: runner });

  assert(!result.ok, "expected error result");
  assertStringIncludes(result.error.message, "rev-parse");
  assertStringIncludes(result.error.message, "fatal");
});

Deno.test("captureBranchHead - returns error when git runner fails", async () => {
  const { runner } = queuedMockRunner([
    { fail: new Error("spawn EACCES") },
  ]);

  const result = await captureBranchHead("any", { gitRunner: runner });

  assert(!result.ok, "expected error result");
  assertStringIncludes(result.error.message, "spawn EACCES");
});

Deno.test("captureBranchHead - returns error on empty stdout (detached/empty branch)", async () => {
  const { runner } = queuedMockRunner([
    { code: 0, stdout: "   \n" },
  ]);

  const result = await captureBranchHead("orphan", { gitRunner: runner });

  assert(!result.ok, "expected error result for empty SHA");
  assertStringIncludes(result.error.message.toLowerCase(), "empty");
});

// ---------------------------------------------------------------------------
// branchHeadChanged
// ---------------------------------------------------------------------------

Deno.test("branchHeadChanged - returns false when HEAD has not moved", async () => {
  const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const { runner } = queuedMockRunner([
    { code: 0, stdout: `${sha}\n` },
  ]);

  const result = await branchHeadChanged(sha, "feature", { gitRunner: runner });

  assert(result.ok, "expected ok result");
  assertEquals(result.value, false);
});

Deno.test("branchHeadChanged - returns true when HEAD has moved", async () => {
  const before = "1111111111111111111111111111111111111111";
  const after = "2222222222222222222222222222222222222222";
  const { runner } = queuedMockRunner([
    { code: 0, stdout: `${after}\n` },
  ]);

  const result = await branchHeadChanged(before, "feature", {
    gitRunner: runner,
  });

  assert(result.ok, "expected ok result");
  assertEquals(result.value, true);
});

Deno.test("branchHeadChanged - degrades safely (false) when read fails", async () => {
  // The contract: read failure must never throw and must report `false`
  // so callers do not misinterpret a transient failure as a HEAD change.
  const { runner } = queuedMockRunner([
    { fail: new Error("git rev-parse exploded") },
  ]);

  const result = await branchHeadChanged("anything", "feature", {
    gitRunner: runner,
  });

  assert(result.ok, "expected ok result with safe-default value");
  assertEquals(result.value, false);
});

Deno.test("branchHeadChanged - degrades safely (false) when rev-parse exits non-zero", async () => {
  const { runner } = queuedMockRunner([
    { code: 128, stdout: "", stderr: "fatal: not a git repository" },
  ]);

  const result = await branchHeadChanged("anything", "feature", {
    gitRunner: runner,
  });

  assert(result.ok, "expected ok result with safe-default value");
  assertEquals(result.value, false);
});

Deno.test("branchHeadChanged - returns true after a fresh commit moves HEAD", async () => {
  // Simulates the integration scenario: capture, fresh commit, re-check.
  const before = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const after = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const { runner } = queuedMockRunner([
    { code: 0, stdout: `${before}\n` },
    { code: 0, stdout: `${after}\n` },
  ]);

  const captured = await captureBranchHead("feature", { gitRunner: runner });
  assert(captured.ok);
  assertEquals(captured.value, before);

  const moved = await branchHeadChanged(captured.value, "feature", {
    gitRunner: runner,
  });
  assert(moved.ok);
  assertEquals(moved.value, true);
});
