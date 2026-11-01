/**
 * Tests for the behind-only deferral in the branch-update maintenance loop.
 * A PR merely behind its base is not updated for being behind — on a queued
 * base (Issue #4424) and, since Issue #4613, on an unqueued base too — while a
 * conflicting one still is. The merge-queue answer only changes the log line.
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

/** A logger that keeps its info and warning lines for assertions. */
function recordingLogger(infos: string[], warns: string[]): Logger {
  const noop = () => {};
  return {
    info: (message: string) => {
      infos.push(message);
    },
    warn: (message: string) => {
      warns.push(message);
    },
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
  warns: string[];
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
  const warns: string[] = [];
  const queueQuestions: string[] = [];
  let behindReads = 0;
  let mergeableReads = 0;
  const batch = f.batch;
  const deps: PrBranchUpdateDeps = {
    repos: [REPO],
    logger: recordingLogger(infos, warns),
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
    ...(batch !== undefined
      ? {
        fetchBranchStateBatch: () => Promise.resolve(batch),
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
    warns,
  };
}

// ---------------------------------------------------------------------------
// decidePrUpdateAction — the pure decision
// ---------------------------------------------------------------------------

// Issue #4613: the scan never updates a merely-behind PR, on any base. This
// replaces the former "behind action" assertion (reason "behind", behindBy 3).
Deno.test("decidePrUpdateAction - a PR merely behind an unqueued base yields no action (Issue #4613)", () => {
  const action = decidePrUpdateAction(REPO, PR, "main", 3, "MERGEABLE");
  assertEquals(action, null);
});

// Issue #4613: the decision takes no queue input any more, so the former
// "same PR behind a queued base" case is the same call as the test above and
// is removed rather than duplicated.

Deno.test("decidePrUpdateAction - a conflicting PR behind a base yields a conflicting action with the real behind count", () => {
  const action = decidePrUpdateAction(REPO, PR, "main", 3, "CONFLICTING");
  assertEquals(action?.reason, "conflicting");
  assertEquals(action?.behindBy, 3);
  assertEquals(action?.baseBranch, "main");
});

// ---------------------------------------------------------------------------
// scanPrBranchUpdates — the per-PR REST path (no batch fetcher)
// ---------------------------------------------------------------------------

Deno.test("scan (REST) - behind-only PR on an unqueued base yields no action and still reads its mergeable status (Issue #4613)", async () => {
  const run = await runScan({ queued: false });
  assertEquals(run.actions, []);
  assertEquals(run.skippedCount, 1);
  assertEquals(run.mergeableReads, 1);
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

Deno.test("scan (batch) - the same behind PR on an unqueued base yields no action (Issue #4613)", async () => {
  const batch = new Map<number, PrBranchStateEntry>([
    [42, { behindBy: 3, mergeable: "MERGEABLE" }],
  ]);
  const run = await runScan({ queued: false, batch });
  assertEquals(run.actions, []);
  assertEquals(run.skippedCount, 1);
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

Deno.test("scan - a failing merge-queue read is treated as not queued, so a behind PR is left alone with the Issue #4613 wording", async () => {
  const run = await runScan({ queued: "throws" });
  assertEquals(run.actions, []);
  const line = run.infos.find((m) => m.includes("#42"));
  assertEquals(
    line?.includes("(Issue #4613)"),
    true,
    `expected the unqueued Issue #4613 info line, got: ${
      JSON.stringify(run.infos)
    }`,
  );
});

Deno.test("scan - a failing merge-queue read is logged at warning, naming the repo, base and cause (fail loud)", async () => {
  const run = await runScan({ queued: "throws" });
  assertEquals(
    run.warns.length,
    1,
    `expected one warning, got: ${JSON.stringify(run.warns)}`,
  );
  const line = run.warns[0] ?? "";
  assertEquals(line.includes(REPO), true);
  assertEquals(line.includes("main"), true);
  assertEquals(line.includes("rules endpoint down"), true);
});
