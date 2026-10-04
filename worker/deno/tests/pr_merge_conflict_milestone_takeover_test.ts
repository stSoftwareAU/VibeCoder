/**
 * Tests for the merge-conflict processor's `milestone/**` route (Issue #3031).
 *
 * A conflicted milestone PR used to get a stand-down comment and nothing
 * more (GRQ-AutoTrader#2028, #1957). It now goes through the conflict
 * takeover in the same cycle: one `milestone-fix/**` PR into the milestone
 * branch, reused on later cycles, skipped only while another host holds a
 * live lock, and a failed run spends one attempt from the shared budget.
 *
 * The fake `gh` below is stateful — posted comments and opened PRs are read
 * back — so a second cycle sees exactly what the first one left behind.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MergeConflictInput,
  type MergeConflictProcessorDeps,
  type MergeConflictResult,
  processMergeConflict,
} from "../lib/pr_merge_conflict_processor.ts";
import type { TakeoverResolution } from "../lib/conflict_takeover.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  readResolutionAttempts,
  spentConflictAttempts,
} from "../lib/merge_conflict_markers.ts";
import type { BranchUpdateLockResult } from "../lib/pr_branch_lock.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { LogContext, Logger, Result } from "../types.ts";

const REPO = "org/repo";
const PR_NUMBER = 2028;
const MILESTONE_HEAD = "milestone/3013-fleet-lands-its-own";
const HEAD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const FLEET = "vibe-bot";
const WORKER_ID = "vibe@host-a";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface LogLine {
  message: string;
  context?: LogContext;
}

function makeLogger(lines: LogLine[]): Logger {
  const record = (message: string, context?: LogContext) => {
    lines.push({ message, ...(context ? { context } : {}) });
  };
  return {
    info: record,
    warn: record,
    error: record,
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

interface FakePr {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  isCrossRepository: boolean;
}

/** A stateful `gh` covering what the takeover and fix-PR helpers call. */
class FakeGh {
  readonly calls: string[][] = [];
  readonly comments: Array<
    { id: number; body: string; user: { login: string }; created_at: string }
  > = [];
  readonly prs: FakePr[] = [];
  private nextId = 1000;
  private nextPr = 900;

  run = (args: string[]): Promise<string> => {
    this.calls.push(args);
    const [a0, a1] = args;

    if (a0 === "api" && String(args[1]).includes("/comments?")) {
      const page = Number(/[?&]page=(\d+)/.exec(String(args[1]))?.[1] ?? 1);
      return Promise.resolve(
        page > 1 ? "[]" : JSON.stringify(this.comments),
      );
    }
    if (a0 === "api" && String(args[1]).includes("/rules/branches/")) {
      return Promise.resolve(JSON.stringify([{ type: "pull_request" }]));
    }
    if (a0 === "pr" && a1 === "view") {
      if (args.includes("headRefOid")) {
        return Promise.resolve(JSON.stringify({ headRefOid: HEAD_SHA }));
      }
      return Promise.resolve("");
    }
    if (a0 === "pr" && a1 === "list") {
      const base = args[args.indexOf("--base") + 1];
      return Promise.resolve(
        JSON.stringify(this.prs.filter((pr) => pr.baseRefName === base)),
      );
    }
    if (a0 === "pr" && a1 === "create") {
      const number = this.nextPr++;
      const url = `https://github.com/${REPO}/pull/${number}`;
      this.prs.push({
        number,
        url,
        headRefName: args[args.indexOf("--head") + 1]!,
        baseRefName: args[args.indexOf("--base") + 1]!,
        author: { login: FLEET },
        isCrossRepository: false,
      });
      return Promise.resolve(`${url}\n`);
    }
    if (a0 === "pr" && a1 === "comment") {
      const id = this.nextId++;
      this.comments.push({
        id,
        body: args[args.indexOf("--body") + 1] ?? "",
        user: { login: FLEET },
        created_at: new Date().toISOString(),
      });
      return Promise.resolve(
        `https://github.com/${REPO}/pull/${PR_NUMBER}#issuecomment-${id}\n`,
      );
    }
    if (a0 === "label" && a1 === "list") return Promise.resolve("[]");
    if (args.includes("GET")) {
      return Promise.resolve('{"users":[],"teams":[]}');
    }
    return Promise.resolve("");
  };

  prCreates(): string[][] {
    return this.calls.filter((a) => a[0] === "pr" && a[1] === "create");
  }
}

function makeInput(): MergeConflictInput {
  return {
    repo: REPO,
    prNumber: PR_NUMBER,
    branchName: MILESTONE_HEAD,
    baseBranch: "Develop",
    attemptCount: 0,
  };
}

interface Harness {
  gh: FakeGh;
  lines: LogLine[];
  fixBranches: string[];
  locksReleased: number;
  run: () => Promise<Result<MergeConflictResult>>;
}

function makeHarness(options: {
  resolution?: TakeoverResolution;
  lock?: BranchUpdateLockResult;
  overrides?: Partial<MergeConflictProcessorDeps>;
} = {}): Harness {
  const gh = new FakeGh();
  const lines: LogLine[] = [];
  const fixBranches: string[] = [];
  const harness: Harness = {
    gh,
    lines,
    fixBranches,
    locksReleased: 0,
    run: () =>
      processMergeConflict(makeInput(), {
        logger: makeLogger(lines),
        deps: createMockDeps({ github: { runGhCommand: gh.run } }),
        workDir: "/nonexistent-clone",
        workRoot: "/nonexistent-root",
        workerId: WORKER_ID,
        trustedAuthors: [FLEET],
        acquireLockFn: () =>
          Promise.resolve({
            ok: true,
            value: options.lock ?? { acquired: true, lockCommentId: 1 },
          }),
        releaseLockFn: () => {
          harness.locksReleased++;
          return Promise.resolve({ ok: true, value: undefined });
        },
        startLockRenewalFn: () => ({ stop: () => {} }),
        takeoverResolvers: {
          resolveViaLadder: () => {
            throw new Error("a milestone head must never take the ladder");
          },
          resolveOnFixBranch: (_pr, fixBranch) => {
            fixBranches.push(fixBranch);
            return Promise.resolve(
              options.resolution ?? { resolved: true, detail: "resolved" },
            );
          },
        },
        ...options.overrides,
      }),
  };
  return harness;
}

function assertNoStandDown(gh: FakeGh): void {
  for (const comment of gh.comments) {
    assert(
      !comment.body.includes("vibe-milestone-head"),
      `a milestone stand-down was posted: ${comment.body}`,
    );
    assert(
      !comment.body.includes("Standing down"),
      `a stand-down was posted: ${comment.body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - a conflicted milestone PR gets exactly one milestone-fix PR in the first cycle, no stand-down (Issue #3031)", async () => {
  const h = makeHarness();

  const result = await h.run();

  assert(result.ok);
  assertEquals(result.value.processed, true);
  assertEquals(result.value.merged, false);
  assertStringIncludes(result.value.summary, "fix PR");

  const creates = h.gh.prCreates();
  assertEquals(creates.length, 1);
  const create = creates[0]!;
  assertEquals(create[create.indexOf("--base") + 1], MILESTONE_HEAD);
  assert(create[create.indexOf("--head") + 1]!.startsWith("milestone-fix/"));
  assertEquals(h.fixBranches.length, 1);

  assertNoStandDown(h.gh);
  assertEquals(h.locksReleased, 1);
});

Deno.test("processMergeConflict - a second cycle reuses the open milestone-fix PR and opens no other (Issue #3031)", async () => {
  const h = makeHarness();

  const first = await h.run();
  const second = await h.run();

  assert(first.ok && second.ok);
  assertEquals(h.gh.prCreates().length, 1, "only one fix PR is ever opened");
  assertEquals(h.fixBranches.length, 1, "the second cycle resolves nothing");
  assertEquals(second.value.processed, false);
  assertStringIncludes(second.value.summary, "reused");
  assertStringIncludes(second.value.summary, `#${h.gh.prs[0]!.number}`);
  assertNoStandDown(h.gh);
});

Deno.test("processMergeConflict - another host's live lock skips the milestone takeover and logs the host and lock age (Issue #3031)", async () => {
  const lockedAt = Math.floor(Date.now() / 1000) - 42;
  const h = makeHarness({
    lock: {
      acquired: false,
      winnerId: "vibe@host-b",
      winnerLockedAt: lockedAt,
    },
  });

  const result = await h.run();

  assert(result.ok);
  assertEquals(result.value.processed, false);
  assertStringIncludes(result.value.summary, "vibe@host-b");
  assertEquals(h.gh.prCreates(), []);
  assertEquals(h.gh.comments, [], "nothing is posted while the lock is held");
  assertEquals(h.fixBranches, []);

  const skip = h.lines.find((line) =>
    line.message.includes("Milestone-fix takeover skipped")
  );
  assert(skip !== undefined, "the lock skip was not logged");
  assertStringIncludes(skip.message, "host vibe@host-b");
  assertStringIncludes(skip.message, "lock age");
  assertEquals(skip.context?.lockHolder, "vibe@host-b");
  const age = skip.context?.lockAgeSeconds as number;
  assert(age >= 42 && age < 120, `unexpected lock age ${age}`);
});

Deno.test("processMergeConflict - a failed milestone takeover records one failed attempt against the shared budget (Issue #3031)", async () => {
  const h = makeHarness({
    resolution: { resolved: false, detail: "conflict could not be resolved" },
  });

  const result = await h.run();

  assert(result.ok);
  assertEquals(result.value.processed, true);
  assertEquals(result.value.merged, false);
  assertEquals(h.gh.prCreates(), []);

  const attempts = readResolutionAttempts(
    h.gh.comments,
    (login) => login === FLEET,
  );
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0]!.outcome, "failed");
  assertEquals(spentConflictAttempts(attempts), 1);
  assertEquals(
    h.gh.comments.filter((c) => c.body.includes(CONFLICT_ATTEMPT_MARKER))
      .length,
    1,
  );
  assertNoStandDown(h.gh);
});

Deno.test("processMergeConflict - a milestone head with no takeover resolvers fails loudly (Issue #3031)", async () => {
  const h = makeHarness({ overrides: { takeoverResolvers: undefined } });

  const result = await h.run();

  assert(!result.ok);
  assertStringIncludes(result.error.message, "takeoverResolvers");
  assertEquals(h.gh.comments, []);
});
