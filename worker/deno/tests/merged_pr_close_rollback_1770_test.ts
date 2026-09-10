/**
 * The merged-PR closers honour a milestone roll-back (Issue #1770).
 *
 * A child issue reopened because a milestone roll-back reverted its merged PR
 * must stay open: its PR is still `merged` for ever, so without this check the
 * priority-1.67 closer shut the issue again on the very next cycle, undoing
 * the roll-back's own decision to re-queue the work.
 *
 * Both closers are covered — `pr_issue_linking.closeIssuesForMergedPrs`, which
 * is what priority 1.67 runs, and the `pr_maintenance` closer of the same
 * name. The sweep's half lives in `merged_pr_issue_sweep_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { closeIssuesForMergedPrs } from "../lib/pr_issue_linking.ts";
import { closeIssuesForMergedPrs as closeViaMaintenance } from "../lib/pr_maintenance.ts";
import { buildRollbackMarker } from "../lib/milestone_rollback_marker.ts";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";
import type { Logger } from "../types.ts";

const PR_MERGED_AT = "2026-09-01T10:00:00Z";
const FLEET = ["vibe-bot"];

const ROLLBACK = buildRollbackMarker({
  prNumber: 476,
  revertSha: "beefca7",
  branch: "milestone/1730-resolve-merge-conflicts",
});

function makeLogger(lines: string[] = []): Logger {
  return {
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

interface Harness {
  closed: string[];
  fn: (args: string[]) => Promise<string>;
}

/** A merged PR #476 fixing issue #477, with one comment on that issue. */
function harness(comments: Array<Record<string, unknown>>): Harness {
  const closed: string[] = [];
  return {
    closed,
    fn: (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 476,
          title: "fix: the child (Issue #477)",
          headRefName: "issue-477",
          mergedAt: PR_MERGED_AT,
        }]));
      }
      if (args[0] === "issue" && args[1] === "view") {
        // `pr_maintenance` asks for the bare state via `--jq .state`.
        const jq = args[args.indexOf("--jq") + 1] ?? "";
        if (jq === ".state") return Promise.resolve("OPEN");
        return Promise.resolve(JSON.stringify({
          state: "OPEN",
          labels: [],
          createdAt: "2026-08-27T10:00:00Z",
        }));
      }
      if (args[0] === "api" && (args[1] ?? "").includes("/comments")) {
        return Promise.resolve(
          JSON.stringify((args[1] ?? "").includes("page=1") ? comments : []),
        );
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(args[2]!);
      }
      return Promise.resolve("");
    },
  };
}

/** The same world, but the comment thread cannot be read. */
function unreadableThread(h: Harness): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] === "api" && (args[1] ?? "").includes("/comments")) {
      return Promise.reject(new Error("gh: comments unavailable (500)"));
    }
    return h.fn(args);
  };
}

function fleetRollbackComment(): Record<string, unknown> {
  return {
    user: { login: "vibe-bot" },
    created_at: "2026-09-02T08:00:00Z",
    body: `Rolled back by the milestone.\n\n${ROLLBACK}`,
  };
}

// ---------------------------------------------------------------------------
// pr_issue_linking.closeIssuesForMergedPrs — the priority-1.67 closer
// ---------------------------------------------------------------------------

Deno.test("closeIssuesForMergedPrs - a fleet roll-back after the merge keeps the child open (Issue #1770)", async () => {
  const lines: string[] = [];
  const h = harness([fleetRollbackComment()]);

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    {
      verifyMergeLandedFn: alwaysLanded,
      fleetAuthors: FLEET,
      logFn: (m) => lines.push(m),
    },
  );

  assertEquals(h.closed, []);
  assertEquals(count, 0);
  assert(
    lines.some((l) => l.includes("rolled-back")),
    `expected a rolled-back log line, got ${JSON.stringify(lines)}`,
  );
});

Deno.test("closeIssuesForMergedPrs - the same marker from a non-fleet author still closes (Issue #1770)", async () => {
  const h = harness([{
    user: { login: "drive-by" },
    created_at: "2026-09-02T08:00:00Z",
    body: ROLLBACK,
  }]);

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded, fleetAuthors: FLEET },
  );

  assertEquals(h.closed, ["477"]);
  assertEquals(count, 1);
});

Deno.test("closeIssuesForMergedPrs - a roll-back marker predating the merge does not block the close (Issue #1770)", async () => {
  const h = harness([{
    user: { login: "vibe-bot" },
    created_at: "2026-08-30T08:00:00Z",
    body: ROLLBACK,
  }]);

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded, fleetAuthors: FLEET },
  );

  assertEquals(h.closed, ["477"]);
  assertEquals(count, 1);
});

Deno.test("closeIssuesForMergedPrs - no fleet identity spends no call and closes as before (Issue #1770)", async () => {
  const seen: string[][] = [];
  const inner = harness([fleetRollbackComment()]);
  const fn = (args: string[]): Promise<string> => {
    seen.push(args);
    return inner.fn(args);
  };

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  assertEquals(inner.closed, ["477"]);
  assertEquals(count, 1);
  assertEquals(
    seen.some((a) => a[0] === "api" && (a[1] ?? "").includes("/comments")),
    false,
    "an unresolved fleet identity must not spend a comment fetch",
  );
});

Deno.test("closeIssuesForMergedPrs - an unreadable comment thread leaves the child open, loudly (Issue #1770)", async () => {
  const lines: string[] = [];
  const h = harness([]);

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    unreadableThread(h),
    "planning",
    undefined,
    {
      verifyMergeLandedFn: alwaysLanded,
      fleetAuthors: FLEET,
      logFn: (m) => lines.push(m),
    },
  );

  assertEquals(h.closed, []);
  assertEquals(count, 0);
  assert(
    lines.some((l) => l.includes("comments unavailable")),
    `expected the cause to be named, got ${JSON.stringify(lines)}`,
  );
});

// ---------------------------------------------------------------------------
// pr_maintenance.closeIssuesForMergedPrs — the same check
// ---------------------------------------------------------------------------

function maintenanceOptions(
  fn: (args: string[]) => Promise<string>,
  fleetAuthors?: string[],
) {
  return {
    githubUser: "bot-user",
    repos: ["owner/repo"],
    logger: makeLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn: fn,
    extractIssueNumber: (title: string) =>
      title.match(/Issue #(\d+)/)?.[1] ?? null,
    verifyMergeLandedFn: alwaysLanded,
    ...(fleetAuthors ? { fleetAuthors } : {}),
  };
}

Deno.test("pr_maintenance closeIssuesForMergedPrs - a fleet roll-back after the merge keeps the child open (Issue #1770)", async () => {
  const h = harness([fleetRollbackComment()]);

  const result = await closeViaMaintenance(maintenanceOptions(h.fn, FLEET));

  assert(result.ok);
  assertEquals(result.value.closedCount, 0);
  assertEquals(h.closed, []);
});

Deno.test("pr_maintenance closeIssuesForMergedPrs - an unreadable comment thread leaves the child open, loudly (Issue #1770)", async () => {
  const lines: string[] = [];
  const h = harness([]);
  const options = maintenanceOptions(unreadableThread(h), FLEET);
  options.logger = makeLogger(lines);

  const result = await closeViaMaintenance(options);

  assert(result.ok);
  assertEquals(result.value.closedCount, 0);
  assertEquals(h.closed, []);
  assert(
    lines.some((l) => l.includes("comments unavailable")),
    `expected the cause to be named, got ${JSON.stringify(lines)}`,
  );
});

Deno.test("pr_maintenance closeIssuesForMergedPrs - a non-fleet marker still closes (Issue #1770)", async () => {
  const h = harness([{
    user: { login: "drive-by" },
    created_at: "2026-09-02T08:00:00Z",
    body: ROLLBACK,
  }]);

  const result = await closeViaMaintenance(maintenanceOptions(h.fn, FLEET));

  assert(result.ok);
  assertEquals(result.value.closedCount, 1);
  assertEquals(h.closed, ["477"]);
});
