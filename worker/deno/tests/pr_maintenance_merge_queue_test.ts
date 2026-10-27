/**
 * Tests for the CI-fix scan's handling of a merge-queue removal (Issue #4424).
 *
 * A GitHub merge queue that removes a PR is a red check on that PR's head.
 * These tests drive the real `findFailedCiChecks` against an injected `gh`
 * stub that records every call, so they can prove the synthetic check is
 * handed to the CI-fix lane and that its synthetic id never reaches an
 * Actions, check-run or re-run endpoint.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import {
  describeQueueRemoval,
  MERGE_QUEUE_CHECK_NAME,
} from "../lib/merge_queue_removal.ts";
import { mergeQueueCheckId } from "../lib/merge_queue_check_id.ts";
import { _resetMergeQueueMemo } from "../lib/merge_queue_runtime.ts";
import { type FailedCiCheck, recordCiCheckRetry } from "../lib/pr_ci_checks.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const HEAD_42 = `abcdef0123456789${"0".repeat(24)}`;
const HEAD_43 = `1234567890abcdef${"0".repeat(24)}`;
const OTHER_HEAD = "f".repeat(40);
const SYNTH_42 = mergeQueueCheckId(HEAD_42);
const COMMITTED_AT = "2026-10-01T00:00:00Z";
const REMOVED_AT = "2026-10-02T00:00:00Z";
const REASON = "Required status check failed in the merge group";
const MAX_RETRIES = 3;

interface PrFixture {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
}

interface Fixture {
  prs: PrFixture[];
  /** Bases whose effective rules include a merge queue. */
  queuedBases: string[];
  /** The rules read fails for every base (a null queue state). */
  rulesError?: boolean;
  /** PR number → the `beforeCommit` oid of its queue removal. */
  removals?: Record<number, string>;
  /** PR numbers whose removal read fails with a `gh` error. */
  readErrors?: number[];
  /** Head branch name → its red check runs. */
  redChecks?: Record<string, Array<{ id: number; name: string }>>;
}

/** The GraphQL response shape `readQueueRemoval` parses. */
function removalResponse(headRefOid: string, beforeCommitOid?: string) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid,
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

/** A `gh` stub that answers the scan from `fx` and records every call. */
function ghStub(
  fx: Fixture,
  calls: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify(fx.prs));
    }
    if (key.includes("rules/branches/")) {
      if (fx.rulesError) return Promise.reject(new Error("HTTP 503"));
      const segment = args.find((a) => a.includes("rules/branches/")) ?? "";
      const base = decodeURIComponent(
        segment.split("rules/branches/")[1] ?? "",
      );
      return Promise.resolve(
        fx.queuedBases.includes(base) ? "merge_queue" : "",
      );
    }
    if (key.includes("REMOVED_FROM_MERGE_QUEUE_EVENT")) {
      const number = Number(
        (args.find((a) => a.startsWith("number=")) ?? "").slice(
          "number=".length,
        ),
      );
      if (fx.readErrors?.includes(number)) {
        return Promise.reject(new Error("HTTP 502 Bad Gateway"));
      }
      const pr = fx.prs.find((p) => p.number === number);
      if (pr === undefined) return Promise.reject(new Error("no such PR"));
      const oid = fx.removals?.[number];
      return Promise.resolve(
        JSON.stringify(removalResponse(pr.headRefOid, oid)),
      );
    }
    if (key.includes("check-runs") && !key.includes("annotations")) {
      const pr = fx.prs.find((p) => key.includes(`commits/${p.headRefName}/`));
      const checks = pr === undefined
        ? []
        : fx.redChecks?.[pr.headRefName] ?? [];
      return Promise.resolve(JSON.stringify(
        checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: "completed",
          conclusion: "failure",
        })),
      ));
    }
    // Everything else (batched check-run GraphQL, annotations, comments)
    // answers empty, which the scan treats as "nothing found".
    return Promise.resolve("[]");
  };
}

/** Records every warn message; other levels are discarded. */
function makeLogger(warns: string[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => void warns.push(message),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface ScanRun {
  found: FailedCiCheck | null;
  calls: string[][];
  warns: string[];
}

/**
 * Run the real scan against `fx`. `spentRetries` pre-records the retry budget
 * for the synthetic check id, as a head that has already been handed over
 * `MAX_RETRIES` times would have it.
 */
async function scan(
  fx: Fixture,
  options: { spentRetries?: boolean } = {},
): Promise<ScanRun> {
  _resetMergeQueueMemo();
  const calls: string[][] = [];
  const warns: string[] = [];
  const stateDir = await Deno.makeTempDir({ prefix: "mq-maintenance-" });
  try {
    if (options.spentRetries) {
      for (let i = 0; i < MAX_RETRIES; i++) {
        await recordCiCheckRetry(stateDir, REPO, SYNTH_42);
      }
    }
    const scanOptions: CiCheckScanOptions = {
      githubUser: "testbot",
      repos: [REPO],
      logger: makeLogger(warns),
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: ghStub(fx, calls),
      stateDir,
      maxRetries: MAX_RETRIES,
    };
    const result = await findFailedCiChecks(scanOptions);
    assertEquals(result.ok, true);
    return {
      found: result.ok ? result.value : null,
      calls,
      warns,
    };
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

/** Every gh call's joined arguments. */
function joined(calls: string[][]): string[] {
  return calls.map((args) => args.join(" "));
}

/** Calls that reach an Actions job, a check-run by id, or a re-run. */
function endpointCalls(calls: string[][]): string[] {
  return joined(calls).filter((line) =>
    /actions\/jobs|run rerun|check-runs\/|annotations/.test(line)
  );
}

/** Calls that carry the synthetic id anywhere in their arguments. */
function syntheticIdCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args.some((a) => a.includes(SYNTH_42)));
}

const QUEUED_42: Fixture = {
  prs: [{
    number: 42,
    headRefName: "issue-42-fix",
    headRefOid: HEAD_42,
    baseRefName: "main",
  }],
  queuedBases: ["main"],
  removals: { 42: HEAD_42 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a queue removal at the current head on a queued base is handed over as a red check named 'merge queue'", async () => {
  const { found, calls } = await scan(QUEUED_42);

  assert(found !== null);
  assertEquals(found.checkName, MERGE_QUEUE_CHECK_NAME);
  assertEquals(found.checkId, SYNTH_42);
  assertEquals(found.prNumber, 42);
  assertEquals(found.repo, REPO);
  assertEquals(found.branchName, "issue-42-fix");
  assertEquals(found.baseRef, "main");
  assertEquals(found.siblingFailedCheckNames, []);

  const annotations = JSON.parse(atob(found.encodedAnnotations));
  assertEquals(annotations, [{
    path: "",
    start_line: 0,
    message: describeQueueRemoval({
      reason: REASON,
      removedAt: REMOVED_AT,
      beforeCommitOid: HEAD_42,
    }),
  }]);
  assertStringIncludes(annotations[0].message, "merge queue");

  // The removal was really read (a positive control for the rest).
  assert(
    joined(calls).some((line) =>
      line.includes("REMOVED_FROM_MERGE_QUEUE_EVENT")
    ),
  );
  // The synthetic id never reaches GitHub.
  assertEquals(syntheticIdCalls(calls), []);
  assertEquals(endpointCalls(calls), []);
});

Deno.test("findFailedCiChecks - the same removal on an unqueued base is not a failure and is not read", async () => {
  const { found, calls } = await scan({
    ...QUEUED_42,
    queuedBases: [],
  });

  assertEquals(found, null);
  assertEquals(
    joined(calls).some((line) =>
      line.includes("REMOVED_FROM_MERGE_QUEUE_EVENT")
    ),
    false,
  );
  assertEquals(syntheticIdCalls(calls), []);
});

Deno.test("findFailedCiChecks - a removal that names another head is not a failure of the current head", async () => {
  const { found, calls } = await scan({
    ...QUEUED_42,
    removals: { 42: OTHER_HEAD },
  });

  assertEquals(found, null);
  // It was read, and then discarded as not applying to this head.
  assert(
    joined(calls).some((line) =>
      line.includes("REMOVED_FROM_MERGE_QUEUE_EVENT")
    ),
  );
  assertEquals(syntheticIdCalls(calls), []);
});

Deno.test("findFailedCiChecks - a failed removal read is logged with the PR and the cause, and is not taken as a failure", async () => {
  const { found, calls, warns } = await scan({
    ...QUEUED_42,
    readErrors: [42],
  });

  assertEquals(found, null);
  const logged = warns.find((w) => w.includes("merge queue removal"));
  assert(logged !== undefined, "the read error must be logged");
  assertStringIncludes(logged, "org/repo#42");
  assertStringIncludes(logged, "HTTP 502 Bad Gateway");
  assertEquals(syntheticIdCalls(calls), []);
});

Deno.test("findFailedCiChecks - a spent retry budget on the synthetic id is still handed over, so the fleet cap can abandon the PR (Issue #4424)", async () => {
  const { found, calls, warns } = await scan(QUEUED_42, {
    spentRetries: true,
  });

  assertEquals(found?.checkId, SYNTH_42);
  assertEquals(found?.prNumber, 42);
  assertEquals(
    warns.filter((w) => w.includes("exceeded max retries")),
    [],
  );
  // Nothing is looked up or re-run under the synthetic id.
  assertEquals(endpointCalls(calls), []);
  assertEquals(warns.filter((w) => w.includes(SYNTH_42)), []);
});

Deno.test("findFailedCiChecks - the queue state is asked once per base per scan, even when the read fails", async () => {
  const { calls } = await scan({
    prs: [
      {
        number: 42,
        headRefName: "issue-42-fix",
        headRefOid: HEAD_42,
        baseRefName: "main",
      },
      {
        number: 43,
        headRefName: "issue-43-fix",
        headRefOid: HEAD_43,
        baseRefName: "main",
      },
    ],
    queuedBases: [],
    rulesError: true,
  });

  // A failed read is not memoised by the runtime, so only the scan's own memo
  // keeps the second PR on this base from asking again.
  const rulesCalls = joined(calls).filter((line) =>
    line.includes("rules/branches/main")
  );
  assertEquals(rulesCalls.length, 1);
});

Deno.test("findFailedCiChecks - a default-branch queue removal is returned ahead of another PR's real failure", async () => {
  const { found, calls } = await scan({
    prs: [
      {
        number: 43,
        headRefName: "issue-43-fix",
        headRefOid: HEAD_43,
        baseRefName: "release",
      },
      {
        number: 42,
        headRefName: "issue-42-fix",
        headRefOid: HEAD_42,
        baseRefName: "main",
      },
    ],
    queuedBases: ["main"],
    removals: { 42: HEAD_42 },
    redChecks: {
      "issue-43-fix": [{ id: 900, name: "Project Validation" }],
    },
  });

  assert(found !== null);
  assertEquals(found.prNumber, 42);
  assertEquals(found.checkName, MERGE_QUEUE_CHECK_NAME);
  assertEquals(found.checkId, SYNTH_42);
  assertEquals(syntheticIdCalls(calls), []);
});

Deno.test("findFailedCiChecks - without a queue removal the other PR's real failure is returned (control for the priority test)", async () => {
  const { found } = await scan({
    prs: [
      {
        number: 43,
        headRefName: "issue-43-fix",
        headRefOid: HEAD_43,
        baseRefName: "release",
      },
      {
        number: 42,
        headRefName: "issue-42-fix",
        headRefOid: HEAD_42,
        baseRefName: "main",
      },
    ],
    queuedBases: ["main"],
    redChecks: {
      "issue-43-fix": [{ id: 900, name: "Project Validation" }],
    },
  });

  assert(found !== null);
  assertEquals(found.prNumber, 43);
  assertEquals(found.checkName, "Project Validation");
  assertEquals(found.checkId, "900");
});
