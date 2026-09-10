/**
 * The claim scan skips a milestone whose branch ledger paces it (Issue #1780).
 *
 * A child run brings the milestone branch level with the default branch before
 * it cuts its issue branch. A charged conflict failure writes `deferUntil`, and
 * until it passes no child of that milestone can start — so the scan must not
 * offer one. Without this gate the loop claimed, deferred and commented on one
 * of the milestone's issues every 30 seconds.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { milestonePacedUntil } from "../lib/milestone_presync.ts";
import type { SyncStreaks } from "../lib/milestone_sync_streak.ts";
import type { WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };
const MILESTONE_TITLE = "#1730 Resolve merge conflicts";
const NOW = Date.parse("2026-09-10T12:00:00.000Z");

/** Temp directories each test removes when it finishes. */
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = Deno.makeTempDirSync({ prefix });
  tempDirs.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // A directory another test already removed is not a failure.
    }
  }
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir: tempDir("paced-selector-workdir-"),
    repos: ["owner/repo-a"],
    issueLabels: ["help-wanted"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    shuffleRepos: false,
  };
}

function createTestCache(): IssueCache {
  return new IssueCache(tempDir("paced-selector-cache-"), 600);
}

/** Two `work-on` issues: #10 in the paced milestone, #11 in none. */
function mockGh(): (args: string[]) => Promise<string> {
  const issues = [
    {
      number: 10,
      title: "Child of the paced milestone",
      url: "https://github.com/owner/repo-a/issues/10",
      assignees: [],
      labels: [{ name: "work-on" }],
      createdAt: "2024-01-01T00:00:00Z",
      author: ALICE,
      milestone: { title: MILESTONE_TITLE },
    },
    {
      number: 11,
      title: "Unrelated work",
      url: "https://github.com/owner/repo-a/issues/11",
      assignees: [],
      labels: [{ name: "work-on" }],
      createdAt: "2024-06-01T00:00:00Z",
      author: ALICE,
      milestone: null,
    },
  ];
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(issues));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(
        JSON.stringify([
          { event: "labeled", label: { name: "work-on" }, actor: ALICE },
        ]),
      );
    }
    return Promise.resolve("[]");
  };
}

/** The ledger a charged conflict failure leaves behind. */
function pacedLedger(deferUntil: string): SyncStreaks {
  return {
    "owner/repo-a|milestone/1730-resolve-merge-conflicts": {
      count: 1,
      escalated: false,
      conflictAttempts: 1,
      deferUntil,
      lastAttempt: {
        at: new Date(NOW - 60_000).toISOString(),
        outcome: "failed",
        reason: "conflict unresolved at rung agent",
        defaultSha: "d".repeat(40),
      },
    },
  };
}

Deno.test(
  "findOldestIssue - a paced milestone's issue is skipped and the unpaced one selected (Issue #1780)",
  async () => {
    const deferUntil = new Date(NOW + 3600_000).toISOString();
    const ledger = pacedLedger(deferUntil);
    const asked: string[] = [];

    try {
      const result = await findOldestIssue(makeConfig(), {
        githubUser: "bot",
        ghCommandFn: mockGh(),
        cache: createTestCache(),
        milestonePacedUntil: (repo, milestone) => {
          asked.push(`${repo}|${milestone}`);
          return milestonePacedUntil(ledger, repo, milestone, NOW);
        },
      });

      assertEquals(result.found, true);
      // #10 is older, so it would have won without the gate.
      assertEquals(result.output.includes("|11|"), true);
      assertEquals(result.output.includes("|10|"), false);
      assert(
        asked.includes(`owner/repo-a|${MILESTONE_TITLE}`),
        "the gate is asked about the milestone-assigned candidate",
      );

      const blocked = (result.blockedDetails ?? []).find((d) =>
        d.issueNumber === 10
      );
      assertEquals(blocked?.reason, "milestone-behind");
      assertEquals(
        result.diagnosticSummary?.skippedByReason["milestone-behind"],
        1,
      );
    } finally {
      cleanup();
    }
  },
);

Deno.test(
  "findOldestIssue - a deferral that has passed leaves the milestone claimable (Issue #1780)",
  async () => {
    const ledger = pacedLedger(new Date(NOW - 1000).toISOString());

    try {
      const result = await findOldestIssue(makeConfig(), {
        githubUser: "bot",
        ghCommandFn: mockGh(),
        cache: createTestCache(),
        milestonePacedUntil: (repo, milestone) =>
          milestonePacedUntil(ledger, repo, milestone, NOW),
        // Pin the selection pool so the oldest candidate wins deterministically.
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });

      assertEquals(result.found, true);
      assertEquals(result.output.includes("|10|"), true);
      assertEquals(
        result.diagnosticSummary?.skippedByReason["milestone-behind"],
        undefined,
      );
    } finally {
      cleanup();
    }
  },
);

Deno.test(
  "findOldestIssue - no pacing function leaves the scan exactly as it was (Issue #1780)",
  async () => {
    try {
      const result = await findOldestIssue(makeConfig(), {
        githubUser: "bot",
        ghCommandFn: mockGh(),
        cache: createTestCache(),
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });

      assertEquals(result.found, true);
      assertEquals(result.output.includes("|10|"), true);
    } finally {
      cleanup();
    }
  },
);
