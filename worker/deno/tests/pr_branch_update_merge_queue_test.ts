/**
 * Tests for the merge-queue exception in the branch-update maintenance loop
 * (Issue #4424). A PR behind a queued base is not updated for being behind;
 * a conflicting one still is. Every case that is not queued keeps today's
 * behaviour, and the fixture for each queued case has an unqueued twin.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  decidePrUpdateAction,
  type PrBranchEntry,
  type PrBranchStateEntry,
  type PrBranchUpdateDeps,
  scanPrBranchUpdates,
} from "../lib/pr_branch_update.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";

const PR: PrBranchEntry = {
  number: 42,
  headRefName: "issue-42-fix-bug",
  baseRefName: "main",
};

/** A logger that keeps its info lines for assertions. */
function recordingLogger(infos: string[]): Logger {
  const noop = () => {};
  return {
    info: (message: string) => {
      infos.push(message);
    },
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface ScanFixture {
  prs?: PrBranchEntry[];
  queued: boolean | "throws";
  behindBy?: number;
  mergeable?: string;
  batch?: Map<number, PrBranchStateEntry> | null;
}

interface ActionSummary {
  prNumber: number;
  reason: string;
  behindBy: number;
}

interface ScanRun {
  actions: ActionSummary[];
  skippedCount: number;
  queueQuestions: string[];
  behindReads: number;
  mergeableReads: number;
  infos: string[];
}

function extractActions(actions: ActionSummary[]): ActionSummary[] {
  return actions.map((a) => ({
    prNumber: a.prNumber,
    reason: a.reason,
    behindBy: a.behindBy,
  }));
}

/** Run the real scan over one fixture and report what it asked and did. */
async function runScan(f: ScanFixture): Promise<ScanRun> {
  const infos: string[] = [];
  const queueQuestions: string[] = [];
  let behindReads = 0;
  let mergeableReads = 0;
  const deps: PrBranchUpdateDeps = {
    repos: [REPO],
    logger: recordingLogger(infos),
    isRepoAllowed: () => true,
    getDefaultBranch: () => Promise.resolve("main"),
    listPrs: () => Promise.resolve(f.prs ?? [PR]),
    getBehindBy: () => {
      behindReads++;
      return Promise.resolve(f.behindBy ?? 3);
    },
    getMergeableStatus: () => {
      mergeableReads++;
      return Promise.resolve(f.mergeable ?? "MERGEABLE");
    },
    isMergeQueueBase: (repo: string, baseBranch: string) => {
      queueQuestions.push(`${repo}#${baseBranch}`);
      if (f.queued === "throws") {
        return Promise.reject(new Error("rules endpoint down"));
      }
      return Promise.resolve(f.queued);
    },
    ...(f.batch !== undefined
      ? {
        fetchBranchStateBatch: () => Promise.resolve(f.batch ?? null),
      }
      : {}),
  };
  const result = await scanPrBranchUpdates(deps);
  if (!result.ok) throw result.error;
  return {
    actions: extractActions(result.value.actions),
    skippedCount: result.value.skippedCount,
    queueQuestions,
    behindReads,
    mergeableReads,
    infos,
  };
}

// ---------------------------------------------------------------------------
// decidePrUpdateAction — the pure decision
// ---------------------------------------------------------------------------

Deno.test("decidePrUpdateAction - a PR behind an unqueued base yields a behind action", () => {
  const action = decidePrUpdateAction(REPO, PR, "main", 3, "MERGEABLE", false);
  assertEquals(action?.reason, "behind");
  assertEquals(action?.behindBy, 3);
});

Deno.test("decidePrUpdateAction - the same PR behind a queued base yields no action", () => {
  const action = decidePrUpdateAction(REPO, PR, "main", 3, "MERGEABLE", true);
  assertEquals(action, null);
});

Deno.test("decidePrUpdateAction - a conflicting PR behind a queued base yields a conflicting action with the real behind count", () => {
  const action = decidePrUpdateAction(REPO, PR, "main", 3, "CONFLICTING", true);
  assertEquals(action?.reason, "conflicting");
  assertEquals(action?.behindBy, 3);
  assertEquals(action?.baseBranch, "main");
});

// ---------------------------------------------------------------------------
// scanPrBranchUpdates — the per-PR REST path (no batch fetcher)
// ---------------------------------------------------------------------------

Deno.test("scan (REST) - behind-only PR on an unqueued base yields a behind action and reads no mergeable status", async () => {
  const run = await runScan({ queued: false });
  assertEquals(run.actions, [{ prNumber: 42, reason: "behind", behindBy: 3 }]);
  assertEquals(run.mergeableReads, 0);
});

Deno.test("scan (REST) - behind-only PR on a queued base yields no action", async () => {
  const run = await runScan({ queued: true });
  assertEquals(run.actions, []);
  assertEquals(run.skippedCount, 1);
});

Deno.test("scan (REST) - a queued base's behind PR still has its mergeable status read", async () => {
  const run = await runScan({ queued: true, mergeable: "MERGEABLE" });
  assertEquals(run.mergeableReads, 1);
});

Deno.test("scan (REST) - conflicting PR behind a queued base yields a conflicting action", async () => {
  const run = await runScan({ queued: true, mergeable: "CONFLICTING" });
  assertEquals(run.actions, [{
    prNumber: 42,
    reason: "conflicting",
    behindBy: 3,
  }]);
});

// ---------------------------------------------------------------------------
// scanPrBranchUpdates — the batched state path (Issue #1807)
// ---------------------------------------------------------------------------

Deno.test("scan (batch) - conflicting PR behind a queued base is updated, from the batch cache alone", async () => {
  const batch = new Map<number, PrBranchStateEntry>([
    [42, { behindBy: 3, mergeable: "CONFLICTING" }],
  ]);
  const run = await runScan({ queued: true, batch });
  assertEquals(run.actions, [{
    prNumber: 42,
    reason: "conflicting",
    behindBy: 3,
  }]);
  assertEquals(run.behindReads, 0);
  assertEquals(run.mergeableReads, 0);
});

Deno.test("scan (batch) - behind PR on a queued base, mergeable MERGEABLE, yields no action", async () => {
  const batch = new Map<number, PrBranchStateEntry>([
    [42, { behindBy: 3, mergeable: "MERGEABLE" }],
  ]);
  const run = await runScan({ queued: true, batch });
  assertEquals(run.actions, []);
  assertEquals(run.skippedCount, 1);
});

Deno.test("scan (batch) - the same behind PR on an unqueued base yields a behind action", async () => {
  const batch = new Map<number, PrBranchStateEntry>([
    [42, { behindBy: 3, mergeable: "MERGEABLE" }],
  ]);
  const run = await runScan({ queued: false, batch });
  assertEquals(run.actions, [{ prNumber: 42, reason: "behind", behindBy: 3 }]);
});

// ---------------------------------------------------------------------------
// scanPrBranchUpdates — the question, the logging, and the failure mode
// ---------------------------------------------------------------------------

Deno.test("scan - asks the merge-queue question once per repo and base", async () => {
  const prs: PrBranchEntry[] = [
    PR,
    { number: 43, headRefName: "issue-43", baseRefName: "main" },
    { number: 44, headRefName: "issue-44", baseRefName: "milestone/v1" },
  ];
  const run = await runScan({ queued: false, prs });
  // Two PRs share `main`, one targets `milestone/v1`: two questions, not three.
  assertEquals(run.queueQuestions, [`${REPO}#main`, `${REPO}#milestone/v1`]);
});

Deno.test("scan - a behind-only PR on a queued base is logged at info naming the merge queue", async () => {
  const run = await runScan({ queued: true });
  const line = run.infos.find((m) => m.includes("#42"));
  assertEquals(
    line?.includes("merge queue"),
    true,
    `expected a merge-queue info line, got: ${JSON.stringify(run.infos)}`,
  );
});

Deno.test("scan - a failing merge-queue read is treated as not queued, so a behind PR is still updated", async () => {
  const run = await runScan({ queued: "throws" });
  assertEquals(run.actions, [{ prNumber: 42, reason: "behind", behindBy: 3 }]);
});
