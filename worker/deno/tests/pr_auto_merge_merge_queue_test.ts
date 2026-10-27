/**
 * Tests for the auto-merge arming hold on a merge-queue removal (Issue #4424).
 *
 * A PR the merge queue removed at its current head must not be re-armed, or
 * handed to a direct merge, on a queued base. A removal that names another
 * head, a read error, and an unqueued base must all leave arming unchanged.
 * Every test drives the real `enableAutoMerge` against a recording `gh` stub.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetBaseProtectionMemo,
  AutoMergeResult,
  enableAutoMerge,
  type EnableAutoMergeResult,
} from "../lib/pr_auto_merge.ts";
import type { MergeBlockedReason } from "../lib/direct_merge.ts";
import { _resetMergeQueueMemo } from "../lib/merge_queue_runtime.ts";

const REPO = "org/repo";
const PR_NUMBER = 42;
const HEAD = `abcdef0123456789${"0".repeat(24)}`;
const OTHER_HEAD = "f".repeat(40);
const REASON = "Required status check failed in the merge group";
const REMOVED_AT = "2026-10-02T00:00:00Z";
const COMMITTED_AT = "2026-10-01T00:00:00Z";

/** The GraphQL response shape `readQueueRemoval` parses. */
function removalResponse(beforeCommitOid?: string) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: HEAD,
          commits: { nodes: [{ commit: { committedDate: COMMITTED_AT } }] },
          timelineItems: {
            nodes: beforeCommitOid === undefined ? [] : [{
              __typename: "RemovedFromMergeQueueEvent",
              reason: REASON,
              createdAt: REMOVED_AT,
              beforeCommit: { oid: beforeCommitOid },
            }],
          },
        },
      },
    },
  };
}

interface ArmOptions {
  /** Whether the base is behind a merge queue. */
  queued: boolean;
  /** `undefined`: no removal. A string: removed when the queue built it. */
  removedAtCommit?: string;
  /** The removal read fails with a `gh` error. */
  readError?: boolean;
  /** The base enforces required checks (GitHub's `--auto` path). */
  protectedBase?: boolean;
  /** The `gh pr merge --auto` call is refused with this message. */
  autoMergeError?: string;
  /** What the gated direct merge returns (default: merged). */
  directMerge?: { merged: boolean; blocked?: MergeBlockedReason };
}

interface ArmRun {
  result: EnableAutoMergeResult;
  calls: string[][];
  logs: string[];
  directMergeCalls: number;
}

/** Arm the PR once, recording every gh call and log line. */
async function arm(options: ArmOptions): Promise<ArmRun> {
  _resetMergeQueueMemo();
  _resetBaseProtectionMemo();
  const calls: string[][] = [];
  const logs: string[] = [];
  let directMergeCalls = 0;

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("REMOVED_FROM_MERGE_QUEUE_EVENT")) {
      if (options.readError) {
        return Promise.reject(new Error("HTTP 502 Bad Gateway"));
      }
      return Promise.resolve(JSON.stringify(
        removalResponse(
          options.removedAtCommit === undefined
            ? undefined
            : options.removedAtCommit === "head"
            ? HEAD
            : options.removedAtCommit,
        ),
      ));
    }
    if (key.includes("/comments")) return Promise.resolve("[]");
    if (key.includes("pr merge") && options.autoMergeError !== undefined) {
      return Promise.reject(new Error(options.autoMergeError));
    }
    if (key.includes("pr view")) return Promise.resolve("{}");
    return Promise.resolve("");
  };

  const result = await enableAutoMerge({
    repo: REPO,
    prNumber: PR_NUMBER,
    baseRefName: "main",
    headRefName: "issue-42-fix",
    maxRetries: 0,
    ghCommandFn,
    isBaseMergeQueuedFn: () => Promise.resolve(options.queued),
    isBaseProtectedFn: () => Promise.resolve(options.protectedBase ?? true),
    directMergeFn: () => {
      directMergeCalls++;
      return Promise.resolve({
        ok: true,
        value: options.directMerge ?? { merged: true },
      });
    },
    log: (message: string) => void logs.push(message),
  });
  return { result, calls, logs, directMergeCalls };
}

/** The `gh pr merge` calls, i.e. the arming attempts. */
function mergeCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "pr" && args[1] === "merge");
}

/** The GraphQL removal reads. */
function removalReads(calls: string[][]): string[][] {
  return calls.filter((args) =>
    args.join(" ").includes("REMOVED_FROM_MERGE_QUEUE_EVENT")
  );
}

Deno.test("enableAutoMerge - a queue removal at the current head on a queued base is not armed and not merged (Issue #4424)", async () => {
  const run = await arm({ queued: true, removedAtCommit: "head" });

  assertEquals(run.result.result, AutoMergeResult.Deferred);
  assertEquals(run.result.deferral, "merge-queue-removed");
  assertStringIncludes(run.result.message, "merge queue");
  assertStringIncludes(run.result.message, REASON);
  assertStringIncludes(run.result.message, "new head");
  assertEquals(mergeCalls(run.calls), []);
  // The removal really was read before the hold was decided.
  assertEquals(removalReads(run.calls).length, 1);
});

Deno.test("enableAutoMerge - a queue removal is not a route to the direct merge on a queued base either (Issue #4424)", async () => {
  const run = await arm({
    queued: true,
    removedAtCommit: "head",
    protectedBase: false,
  });

  assertEquals(run.result.result, AutoMergeResult.Deferred);
  assertEquals(run.result.deferral, "merge-queue-removed");
  assertEquals(run.directMergeCalls, 0);
  assertEquals(mergeCalls(run.calls), []);
});

Deno.test("enableAutoMerge - the same removal on an unqueued base arms exactly as before (Issue #4424)", async () => {
  const run = await arm({ queued: false, removedAtCommit: "head" });

  assertEquals(run.result.result, AutoMergeResult.Enabled);
  const merges = mergeCalls(run.calls);
  assertEquals(merges.length, 1);
  assert(merges[0]?.includes("--auto"));
  // An unqueued base costs no removal read at all.
  assertEquals(removalReads(run.calls), []);
});

Deno.test("enableAutoMerge - a queued base with no queue removal arms as before (Issue #4424)", async () => {
  const run = await arm({ queued: true });

  assertEquals(run.result.result, AutoMergeResult.Enabled);
  assertEquals(mergeCalls(run.calls).length, 1);
  assertEquals(removalReads(run.calls).length, 1);
});

Deno.test("enableAutoMerge - a removal that names another head does not hold arming on the current head (Issue #4424)", async () => {
  const run = await arm({ queued: true, removedAtCommit: OTHER_HEAD });

  assertEquals(run.result.result, AutoMergeResult.Enabled);
  assertEquals(mergeCalls(run.calls).length, 1);
});

Deno.test("enableAutoMerge - a failed removal read is logged and arming proceeds (Issue #4424)", async () => {
  const run = await arm({ queued: true, readError: true });

  assertEquals(run.result.result, AutoMergeResult.Enabled);
  assertEquals(mergeCalls(run.calls).length, 1);
  const logged = run.logs.find((line) => line.includes("merge queue removal"));
  assert(logged !== undefined, "the read error must be logged");
  assertStringIncludes(logged, "org/repo#42");
  assertStringIncludes(logged, "HTTP 502 Bad Gateway");
});

Deno.test("enableAutoMerge - a gated direct merge the merge queue holds is left for the queue, never called unprotected (Issue #4424)", async () => {
  const run = await arm({
    queued: true,
    protectedBase: false,
    directMerge: { merged: false, blocked: "merge_queue" },
  });

  assertEquals(run.result.result, AutoMergeResult.Deferred);
  assertEquals(run.result.directMergeDeferred, true);
  assertEquals(run.directMergeCalls, 1);
  assertEquals(mergeCalls(run.calls), []);
  assertEquals(run.result.message.includes("unprotected"), false);
  assertStringIncludes(run.result.message, "merge queue");
  assertStringIncludes(run.result.message, "never bypasses it");
  assertStringIncludes(run.result.message, "left for the merge queue");
});

Deno.test("enableAutoMerge - auto-merge off on the repo, direct merge held by the merge queue: left for the queue, not 'did not merge it yet' (Issue #4424)", async () => {
  const run = await arm({
    queued: true,
    protectedBase: true,
    autoMergeError: "auto-merge is not enabled on this repository",
    directMerge: { merged: false, blocked: "merge_queue" },
  });

  assertEquals(run.result.result, AutoMergeResult.NotEnabledOnRepo);
  assertEquals(run.directMergeCalls, 1);
  assertEquals(run.result.message.includes("(merge_queue)"), false);
  assertEquals(run.result.message.includes("did not merge it yet"), false);
  assertStringIncludes(run.result.message, "left for the merge queue");
});
