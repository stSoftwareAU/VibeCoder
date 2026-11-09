/**
 * Tests for the `cleanup-stale` command batching (Issue #4822).
 *
 * `executeCleanupStale` passes the durable on-volume scan cache (Issue #4303),
 * so the worker's merged PRs come from one batched `gh pr list --author` query
 * per repo, and a later run is answered from that cache. The per-branch safety
 * check (`assessRemoteBranchDeletion`) is unchanged.
 *
 * The fake `gh` answers with the argument shapes that `lib/issue_query.ts` and
 * `lib/remote_branch_delete.ts` really send.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { executeCleanupStale } from "../commands/branch_cleanup.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeGhOptions {
  /** Remote `issue-*` branch names the repo lists. */
  branches: string[];
  /** The worker's merged PRs, as the batched `--author` query returns them. */
  mergedByAuthor?: { number: number; headRefName: string }[];
  /** Merged PR number per head branch (the per-branch `--head` fallback). */
  mergedByHead?: Record<string, number>;
  /** Open PR number per head branch (safety check, `--head`). */
  openByHead?: Record<string, number>;
  /** Open PR number per base branch (safety check, `--base`: stacked child). */
  openByBase?: Record<string, number>;
}

interface FakeGh {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
  /** The ref path of each DELETE call, in order. */
  deleted: string[];
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function refPath(branch: string): string {
  return `repos/o/r/git/refs/heads/${branch}`;
}

/** Every merged-PR list query, batched or per-branch. */
function mergedListCalls(calls: string[][]): string[][] {
  return calls.filter((args) =>
    args[0] === "pr" && args[1] === "list" &&
    flagValue(args, "--state") === "merged"
  );
}

function makeFakeGh(options: FakeGhOptions): FakeGh {
  const calls: string[][] = [];
  const deleted: string[] = [];

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);

    // Branch listing: `gh api repos/<repo>/branches --paginate --jq ...`.
    if (args[0] === "api" && args.includes("--paginate")) {
      return Promise.resolve(options.branches.map((b) => `${b}\n`).join(""));
    }

    // Branch deletion: `gh api -X DELETE repos/<repo>/git/refs/heads/<branch>`.
    if (args[0] === "api" && args.includes("DELETE")) {
      deleted.push(args[args.length - 1] ?? "");
      return Promise.resolve("");
    }

    if (args[0] === "pr" && args[1] === "list") {
      const state = flagValue(args, "--state");
      const head = flagValue(args, "--head");
      const base = flagValue(args, "--base");
      const hasJq = args.includes("--jq");

      // Batched merged listing: `--state merged --author <user> --search ...`.
      if (state === "merged" && flagValue(args, "--author") !== undefined) {
        return Promise.resolve(
          JSON.stringify(
            (options.mergedByAuthor ?? []).map((pr) => ({
              number: pr.number,
              title: `PR ${pr.number}`,
              headRefName: pr.headRefName,
              mergedAt: "2026-11-01T00:00:00Z",
              body: "",
            })),
          ),
        );
      }

      // Per-branch merged lookup. The uncached path asks with
      // `--jq .[0].number` (a bare number, or nothing); the cached path,
      // `fetchPRsByBranch`, asks for JSON.
      if (state === "merged" && head !== undefined) {
        const number = options.mergedByHead?.[head];
        if (hasJq) {
          return Promise.resolve(number === undefined ? "" : `${number}`);
        }
        return Promise.resolve(
          number === undefined ? "[]" : JSON.stringify([{
            number,
            title: `PR ${number}`,
            baseRefName: "main",
            headRefName: head,
          }]),
        );
      }

      // Open PRs by author: `--state open --author <user>` (cache prefetch).
      if (state === "open" && flagValue(args, "--author") !== undefined) {
        return Promise.resolve("[]");
      }

      // Safety check, `firstOpenPrNumber`: `--state open --head|--base <b> --jq .[0].number`.
      if (state === "open" && head !== undefined) {
        const number = options.openByHead?.[head];
        return Promise.resolve(number === undefined ? "" : `${number}`);
      }
      if (state === "open" && base !== undefined) {
        const number = options.openByBase?.[base];
        return Promise.resolve(number === undefined ? "" : `${number}`);
      }
    }

    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  return { ghCommandFn, calls, deleted };
}

function configFor(workDir: string): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), repos: ["o/r"], workDir };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

Deno.test("cleanup-stale - one batched merged query, then the cache answers the next run", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "branch-cleanup-stale-batch-",
  });
  try {
    // Run 1: two stale branches, both merged by the worker.
    const first = makeFakeGh({
      branches: ["issue-1-alpha", "issue-2-beta"],
      mergedByAuthor: [
        { number: 11, headRefName: "issue-1-alpha" },
        { number: 12, headRefName: "issue-2-beta" },
      ],
    });
    const run1 = await executeCleanupStale(
      { "github-user": "bot" },
      configFor(workDir),
      first.ghCommandFn,
    );

    assertEquals(run1, {
      success: true,
      message: "Stale remote branch cleanup complete: 2 deleted, 0 skipped",
      data: { deletedCount: 2, skippedCount: 0 },
    });
    // (1) One batched merged-PR list for the repo, not one per branch.
    const run1Merged = mergedListCalls(first.calls);
    assertEquals(run1Merged.length, 1);
    assertEquals(flagValue(run1Merged[0]!, "--author"), "bot");
    assertEquals(first.deleted, [
      refPath("issue-1-alpha"),
      refPath("issue-2-beta"),
    ]);

    // Run 2: a fresh gh. issue-2-beta is still listed on the remote, and the
    // worker's merged list from run 1 is still in the durable cache.
    const second = makeFakeGh({ branches: ["issue-2-beta"] });
    const run2 = await executeCleanupStale(
      { "github-user": "bot" },
      configFor(workDir),
      second.ghCommandFn,
    );

    assertEquals(run2, {
      success: true,
      message: "Stale remote branch cleanup complete: 1 deleted, 0 skipped",
      data: { deletedCount: 1, skippedCount: 0 },
    });
    // (2) Answered from the cache: no merged-PR list query at all, and the
    // still-present branch is deleted.
    assertEquals(mergedListCalls(second.calls).length, 0);
    assertEquals(second.deleted, [refPath("issue-2-beta")]);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("cleanup-stale - a branch with an open head PR or a stacked child is not deleted", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "branch-cleanup-stale-batch-",
  });
  try {
    // (3) Both branches are merged by the worker, so only the safety check
    // stands between them and deletion.
    const fake = makeFakeGh({
      branches: ["issue-3-open", "issue-4-base"],
      mergedByAuthor: [
        { number: 13, headRefName: "issue-3-open" },
        { number: 14, headRefName: "issue-4-base" },
      ],
      openByHead: { "issue-3-open": 42 },
      openByBase: { "issue-4-base": 77 },
    });
    const result = await executeCleanupStale(
      { "github-user": "bot" },
      configFor(workDir),
      fake.ghCommandFn,
    );

    assertEquals(result, {
      success: true,
      message: "Stale remote branch cleanup complete: 0 deleted, 2 skipped",
      data: { deletedCount: 0, skippedCount: 2 },
    });
    assertEquals(fake.deleted, []);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("cleanup-stale - a branch missing from the batched list is found by the per-branch fallback", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "branch-cleanup-stale-batch-",
  });
  try {
    // (4) issue-6-human is not in the worker's batched list, but has a merged
    // PR, so the per-branch lookup finds it and the branch is deleted.
    const fake = makeFakeGh({
      branches: ["issue-5-batched", "issue-6-human"],
      mergedByAuthor: [{ number: 15, headRefName: "issue-5-batched" }],
      mergedByHead: { "issue-6-human": 16 },
    });
    const result = await executeCleanupStale(
      { "github-user": "bot" },
      configFor(workDir),
      fake.ghCommandFn,
    );

    assertEquals(result, {
      success: true,
      message: "Stale remote branch cleanup complete: 2 deleted, 0 skipped",
      data: { deletedCount: 2, skippedCount: 0 },
    });
    assertEquals(fake.deleted, [
      refPath("issue-5-batched"),
      refPath("issue-6-human"),
    ]);
    // Only the branch missing from the batched list gets a per-branch query.
    const perBranch = mergedListCalls(fake.calls).filter((args) =>
      flagValue(args, "--head") !== undefined
    );
    assertEquals(perBranch.map((args) => flagValue(args, "--head")), [
      "issue-6-human",
    ]);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("cleanup-stale - a missing --github-user is refused before any gh call", async () => {
  const fake = makeFakeGh({ branches: ["issue-1-alpha"] });
  const result = await executeCleanupStale(
    {},
    configFor("/unused"),
    fake.ghCommandFn,
  );

  assertEquals(result, {
    success: false,
    message: "Missing required argument: --github-user",
  });
  assertEquals(fake.calls.length, 0);
});
