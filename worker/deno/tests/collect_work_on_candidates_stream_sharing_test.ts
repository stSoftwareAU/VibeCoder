/**
 * Stream-sharing selection for the two tiers a human asked for now
 * (Issue #2532).
 *
 * Issue #2530 let a `top-priority`/`work-on` claim join a busy milestone
 * stream in its own fresh conversation. Selection still refused those
 * candidates one gate earlier — `isMilestoneOccupied` → `milestone-occupied`
 * — so the ladder never reached the claim and the fleet fell through to
 * `low-priority` elsewhere. These tests pin the new split:
 *
 *   - the work-on collector shares an occupied stream;
 *   - the low-priority collector still serialises on it;
 *   - host-local exclusion is untouched — `applyInFlightClaims` still makes
 *     a sibling slot's live claim visible to the occupancy check that
 *     remains, and the blank-stream lock still refuses a second
 *     no-milestone issue of the same repository on this host.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { collectLowPriorityCandidates } from "../lib/collect_low_priority_candidates.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import { applyInFlightClaims } from "../lib/work_stream.ts";
import { BlankStreamLockRegistry } from "../lib/stream_lock.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "owner/repo";
const MILESTONE = "Priority streams";

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "stream-sharing-test-" });
  return new IssueCache(dir, 600);
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "stream-sharing-workdir-" }),
  };
}

/** One open issue as `gh issue list --json` renders it. */
function ghIssue(
  number: number,
  label: string,
  milestone: string | null,
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    assignees: [],
    labels: [{ name: label }],
    createdAt: "2024-03-01T00:00:00Z",
    author: { login: "alice" },
    milestone: milestone === null ? null : { title: milestone },
  };
}

/** The same issue as the all-issues listing the occupancy check reads. */
function allIssue(
  number: number,
  label: string,
  milestone: string,
  assignees: string[] = [],
): FilterableIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    author: "alice",
    assignees,
    labels: [label],
    createdAt: "2024-03-01T00:00:00Z",
    milestone,
  };
}

function createMockGh(
  issues: Record<string, unknown>[],
  labels: string[],
): (args: string[]) => Promise<string> {
  const timeline = labels.map((name) => ({
    event: "labeled",
    label: { name },
    actor: { login: "alice" },
    created_at: "2024-03-01T00:00:00Z",
  }));
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(issues));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify({ title: "", body: "" }));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(timeline));
    }
    return Promise.resolve("[]");
  };
}

function buildOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): FindIssuesOptions {
  return {
    githubUser: "bot",
    ghCommandFn,
    cache: createTestCache(),
  };
}

const NO_PRS: OpenPR[] = [];
const NO_CLOSED_PRS: ClosedPR[] = [];

// ---------------------------------------------------------------------------
// The work-on collector shares an occupied stream
// ---------------------------------------------------------------------------

Deno.test(
  "collect_work_on_candidates - a work-on issue shares an occupied milestone stream (Issue #2532)",
  async () => {
    const mockGh = createMockGh(
      [ghIssue(843, "work-on", MILESTONE), ghIssue(844, "work-on", MILESTONE)],
      ["work-on"],
    );
    // #837 is in flight in the same milestone, assigned to the fleet.
    const repoAllIssues = [
      allIssue(837, "work-on", MILESTONE, ["bot"]),
      allIssue(843, "work-on", MILESTONE),
      allIssue(844, "work-on", MILESTONE),
    ];

    const result = await collectWorkOnCandidates(
      REPO,
      makeConfig(),
      buildOptions(mockGh),
      NO_PRS,
      repoAllIssues,
      createIssueFetcher(mockGh),
      NO_CLOSED_PRS,
    );

    assertEquals(result.candidates.map((c) => c.number), [843, 844]);
    assertEquals(
      result.blockedDetails.filter((b) => b.reason === "milestone-occupied"),
      [],
    );
  },
);

// ---------------------------------------------------------------------------
// The low-priority collector still serialises — and still sees this host's
// live claims through `applyInFlightClaims`
// ---------------------------------------------------------------------------

Deno.test(
  "collect_low_priority_candidates - a low-priority sibling is still refused milestone-occupied (Issue #2532)",
  async () => {
    const mockGh = createMockGh(
      [ghIssue(845, "low-priority", MILESTONE)],
      ["low-priority"],
    );
    // The sibling slot's claim has not reached GitHub yet, so the listing
    // shows #837 unassigned; `applyInFlightClaims` is what makes the hold
    // visible to `isMilestoneOccupied` (Issue #1091).
    const repoAllIssues = applyInFlightClaims(
      REPO,
      [
        allIssue(837, "work-on", MILESTONE),
        allIssue(845, "low-priority", MILESTONE),
      ],
      [{ repo: REPO, milestone: MILESTONE, issueNumber: 837 }],
      "bot",
    );
    assertEquals(repoAllIssues[0]!.assignees, ["bot"]);

    const diag = createDiagnostics({ enabled: false, write: () => {} });
    const result = await collectLowPriorityCandidates(
      REPO,
      makeConfig(),
      { ...buildOptions(mockGh), diagnostics: diag },
      NO_PRS,
      repoAllIssues,
      createIssueFetcher(mockGh),
      NO_CLOSED_PRS,
    );

    assertEquals(result.candidates, []);
    assertEquals(result.hasOpenIssues, true);
    assertEquals(
      diag.getSummary().skippedByReason["milestone-occupied"],
      1,
    );
  },
);

// ---------------------------------------------------------------------------
// The blank-stream claim-time lock is untouched
// ---------------------------------------------------------------------------

Deno.test(
  "stream_lock - the blank-stream lock still refuses a sibling slot's no-milestone issue (Issue #2532)",
  () => {
    const registry = new BlankStreamLockRegistry();
    const first = registry.tryAcquire({
      repo: REPO,
      issueNumber: 829,
      slotId: "s1",
    });
    assert(first.acquired);

    const second = registry.tryAcquire({
      repo: REPO,
      issueNumber: 849,
      slotId: "s2",
    });
    assertEquals(second.acquired, false);
    assertEquals(
      second.acquired === false ? second.holder.issueNumber : -1,
      829,
    );

    // A milestone issue is gated by the fleet-wide lock instead, so it is
    // never refused here.
    assert(
      registry.tryAcquire({
        repo: REPO,
        milestoneTitle: MILESTONE,
        issueNumber: 843,
        slotId: "s3",
      }).acquired,
    );
  },
);
