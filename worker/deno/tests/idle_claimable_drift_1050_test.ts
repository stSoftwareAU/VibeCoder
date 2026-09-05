/**
 * The audit and the claim scan must agree about what is claimable
 * (Issue #1050).
 *
 * `classifyIssues` in `idle_detect_diagnostics.ts` decides whether the
 * idle-task filer is suppressed. `collectWorkOnCandidates` decides what the
 * worker actually claims. They are two implementations of one question, and
 * every time they have drifted apart the fleet has paid for it:
 *
 *   - #2751 — the backlog signal counted assigned issues and milestone
 *     trackers the scan permanently skips; whole repositories froze.
 *   - #655 — the audit counted issues this run was itself holding back;
 *     `mis_classification` fired for the life of the process.
 *   - #1050 — the audit's stream-occupancy gate matched `workerUser` alone
 *     while the scan's `isMilestoneOccupied` matches every trusted account.
 *     One issue assigned to a colleague made a 24-issue backlog unclaimable
 *     to the scan while the audit went on counting all 24, and no idle task
 *     was filed anywhere in the fleet for ten days.
 *
 * So this test does not assert either verdict in isolation. It builds one
 * issue set, hands it to both definitions, and asserts the two claimable
 * sets are equal — across every axis the two have drifted on: discovery
 * label, blocking label, assignee, milestone tracker and work-stream
 * occupancy, with the streams both free and occupied.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { classifyIssues } from "../lib/idle_detect_diagnostics.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createIssueFetcher } from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "owner/repo";
const WORKER_USER = "bot";
/** The `.config.json` `allowed_authors` set both definitions must honour. */
const ALLOWED_AUTHORS = ["alice", WORKER_USER];

/** One open issue, in the shape both definitions read. */
interface DriftIssue {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  /** Milestone title, or "" for the default-branch work stream. */
  milestone: string;
  body?: string;
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    allowedAuthors: ALLOWED_AUTHORS,
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "claimable-drift-workdir-" }),
  };
}

/** Deterministic, oldest-first ordering without inventing invalid dates. */
function createdAt(issue: DriftIssue): string {
  const day = String((issue.number % 27) + 1).padStart(2, "0");
  return `2026-01-${day}T00:00:00Z`;
}

function toFilterable(issue: DriftIssue): FilterableIssue {
  return {
    number: issue.number,
    title: issue.title,
    url: `https://github.com/${REPO}/issues/${issue.number}`,
    author: "alice",
    assignees: issue.assignees,
    labels: issue.labels,
    createdAt: createdAt(issue),
    milestone: issue.milestone,
    ...(issue.body === undefined ? {} : { body: issue.body }),
  };
}

/** The raw `gh issue list --json ...` row shape, as GitHub returns it. */
function toGhRow(issue: DriftIssue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    url: `https://github.com/${REPO}/issues/${issue.number}`,
    author: { login: "alice" },
    assignees: issue.assignees.map((login) => ({ login })),
    labels: issue.labels.map((name) => ({ name })),
    createdAt: createdAt(issue),
    milestone: issue.milestone === "" ? null : { title: issue.milestone },
    body: issue.body ?? "",
  };
}

/**
 * What the claim scan would take from `issues`, in ascending issue order.
 *
 * `issue list` answers with the work-on subset, exactly as the label fetch
 * does in production, while the whole open set is passed as `repoAllIssues`
 * — the list `isMilestoneOccupied` reads, and the one the occupying issue
 * (which carries no discovery label at all) lives in.
 */
async function scanClaimable(issues: DriftIssue[]): Promise<number[]> {
  const workOn = issues.filter((i) => i.labels.includes("work-on"));
  const gh = (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(workOn.map(toGhRow)));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify({ title: "", body: "" }));
    }
    if (command.includes("timeline")) {
      // Every label was applied by a trusted human, so neither the
      // label-author gate nor the operational-label trust check strips
      // anything: the fixture's own labels are what both definitions read.
      return Promise.resolve(JSON.stringify(
        ["work-on", "needs-human"].map((name) => ({
          event: "labeled",
          label: { name },
          actor: { login: "alice" },
          created_at: "2026-01-01T00:00:00Z",
        })),
      ));
    }
    return Promise.resolve("[]");
  };
  const cache = new IssueCache(
    Deno.makeTempDirSync({ prefix: "claimable-drift-cache-" }),
    600,
  );
  const result = await collectWorkOnCandidates(
    REPO,
    makeConfig(),
    { githubUser: WORKER_USER, ghCommandFn: gh, cache },
    [],
    issues.map(toFilterable),
    createIssueFetcher(gh),
    [],
  );
  return result.candidates.map((c) => c.number).sort((a, b) => a - b);
}

/** What the idle-detect audit counts as claimable, over the same set. */
function auditClaimable(issues: DriftIssue[]): number[] {
  const verdicts = classifyIssues(
    issues.map((i) => ({
      number: i.number,
      title: i.title,
      labels: i.labels,
      assignees: i.assignees,
      milestone: i.milestone,
      ...(i.body === undefined ? {} : { body: i.body }),
    })),
    {
      workerUser: WORKER_USER,
      allowedAuthors: ALLOWED_AUTHORS,
      // The scan collector under test covers the work-on tier only.
      claimableLabels: ["work-on"],
    },
  );
  return verdicts.filter((v) => v.claimable).map((v) => v.number).sort((a, b) =>
    a - b
  );
}

/**
 * Assert the two definitions reach the same verdict on `issues`, and that it
 * is the verdict `expected` names — so a scenario cannot pass by both sides
 * being wrong in the same direction.
 */
async function assertAgree(
  issues: DriftIssue[],
  expected: number[],
  what: string,
): Promise<void> {
  const scan = await scanClaimable(issues);
  const audit = auditClaimable(issues);
  assertEquals(
    scan,
    expected,
    `${what}: the claim scan's verdict changed`,
  );
  assertEquals(
    audit,
    scan,
    `${what}: the audit and the claim scan disagree ` +
      `(audit=[${audit}] scan=[${scan}])`,
  );
}

/** The issue that occupies the default-branch stream — no labels, as live. */
const OCCUPYING_ISSUE: DriftIssue = {
  number: 99,
  title: "Something a colleague is already doing",
  labels: [],
  assignees: ["alice"],
  milestone: "",
};

Deno.test(
  "claimable drift - a free work stream: both definitions take the work-on issues",
  async () => {
    await assertAgree(
      [
        {
          number: 10,
          title: "Implement one thing",
          labels: ["work-on"],
          assignees: [],
          milestone: "",
        },
        {
          number: 11,
          title: "Implement another thing",
          labels: ["work-on"],
          assignees: [],
          milestone: "",
        },
      ],
      [10, 11],
      "free default-branch stream",
    );
  },
);

Deno.test(
  "claimable drift - a stream occupied by a trusted account: both take nothing (Issue #1050)",
  async () => {
    await assertAgree(
      [
        {
          number: 10,
          title: "Implement one thing",
          labels: ["work-on"],
          assignees: [],
          milestone: "",
        },
        {
          number: 11,
          title: "Implement another thing",
          labels: ["work-on"],
          assignees: [],
          milestone: "",
        },
        OCCUPYING_ISSUE,
      ],
      [],
      "default-branch stream occupied by a colleague",
    );
  },
);

Deno.test(
  "claimable drift - an occupied stream does not occupy a milestone beside it",
  async () => {
    await assertAgree(
      [
        {
          number: 10,
          title: "Blocked by the occupied default stream",
          labels: ["work-on"],
          assignees: [],
          milestone: "",
        },
        {
          number: 30,
          title: "In its own milestone, and free",
          labels: ["work-on"],
          assignees: [],
          milestone: "M1",
        },
        OCCUPYING_ISSUE,
      ],
      [30],
      "milestone beside an occupied default stream",
    );
  },
);

Deno.test(
  "claimable drift - assignees, blocking labels and trackers (Issue #2751)",
  async () => {
    await assertAgree(
      [
        {
          number: 10,
          title: "Eligible",
          labels: ["work-on"],
          assignees: [],
          milestone: "M1",
        },
        {
          number: 11,
          title: "Assigned to a colleague",
          labels: ["work-on"],
          assignees: ["alice"],
          milestone: "M2",
        },
        {
          number: 12,
          title: "Handed back to a human",
          labels: ["work-on", "needs-human"],
          assignees: [],
          milestone: "M3",
        },
        {
          number: 13,
          title: "Merge milestone 'M4' to main",
          labels: ["work-on"],
          assignees: [],
          milestone: "M4",
        },
        {
          number: 14,
          title: "Carries the tracker marker in its body",
          labels: ["work-on"],
          assignees: [],
          milestone: "M5",
          body:
            "<!-- milestone-tracking-issue — do not process as regular work -->",
        },
      ],
      [10],
      "assignee, blocking-label and milestone-tracker axes",
    );
  },
);

Deno.test(
  "claimable drift - an issue without a discovery label is invisible to both",
  async () => {
    await assertAgree(
      [
        {
          number: 20,
          title: "Just an open issue",
          labels: [],
          assignees: [],
          milestone: "",
        },
        {
          number: 21,
          title: "Low priority, not the work-on tier",
          labels: ["low-priority"],
          assignees: [],
          milestone: "",
        },
      ],
      [],
      "unlabelled and lower-tier issues",
    );
  },
);
