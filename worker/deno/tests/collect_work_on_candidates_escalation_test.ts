/**
 * Integration tests for unworkable-work-on escalation in
 * `collectWorkOnCandidates` (Issue #2752).
 *
 * Verifies that (Issue #4298 — nothing here hands an issue to a human):
 *   - a dependency cycle (A→B→A) is broken in issue-number order: the
 *     lowest-numbered member is worked, the rest wait on it as an ordinary
 *     dependency, and a separate eligible issue is still selected;
 *   - a cycle member that also waits on an open issue outside the cycle is
 *     not released;
 *   - a milestone-tracking issue carrying `work-on` has the dead label
 *     stripped;
 *   - a tracker carrying another blocking label is left alone;
 *   - an ordinary (claimable) dependency block records the blockers the stall
 *     check read on the blocked entry (Issue #2494).
 *
 * The GitHub label/comment calls are mocked via an injected recording client
 * and their payloads asserted.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

/** Every write the collector sent: label adds, removals and comments. */
interface Recorder {
  labels: Array<{ issue: number; label: string }>;
  removed: Array<{ issue: number; label: string }>;
  comments: Array<{ issue: number; body: string }>;
}

function newRecorder(): Recorder {
  return { labels: [], removed: [], comments: [] };
}

/** Wrap a mock `gh` so the writes it receives land on `recorder`. */
function recordingGh(
  gh: (args: string[]) => Promise<string>,
  recorder: Recorder,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const issue = parseInt(args[2] ?? "", 10);
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    if (args[0] === "issue" && args[1] === "edit") {
      if (args.includes("--add-label")) {
        recorder.labels.push({ issue, label: value("--add-label") });
      }
      if (args.includes("--remove-label")) {
        recorder.removed.push({ issue, label: value("--remove-label") });
      }
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      recorder.comments.push({ issue, body: value("--body") });
      return Promise.resolve("");
    }
    return gh(args);
  };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    // Issue #2663: cap 1 reproduces the one-fleet-PR stream these tests pin.
    fleetPrSlots: 1,
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "work-on-escalation-workdir-" }),
  };
}

interface IssueSpec {
  number: number;
  title: string;
  labels: string[];
  assignees?: string[];
  body?: string;
}

function buildFilterableIssue(spec: IssueSpec): FilterableIssue {
  return {
    number: spec.number,
    title: spec.title,
    url: `https://github.com/owner/repo/issues/${spec.number}`,
    assignees: spec.assignees ?? [],
    labels: spec.labels,
    createdAt: `2024-06-0${spec.number % 9}T00:00:00Z`,
    author: "alice",
    milestone: "",
    body: spec.body ?? "",
  };
}

function buildListEntry(spec: IssueSpec): Record<string, unknown> {
  return {
    number: spec.number,
    title: spec.title,
    url: `https://github.com/owner/repo/issues/${spec.number}`,
    assignees: (spec.assignees ?? []).map((login) => ({ login })),
    labels: spec.labels.map((name) => ({ name })),
    createdAt: `2024-06-0${spec.number % 9}T00:00:00Z`,
    author: { login: "alice" },
    milestone: null,
    body: spec.body ?? "",
  };
}

function issueNumberFromView(args: string[]): number | null {
  if (args[0] === "issue" && args[1] === "view") {
    const n = parseInt(args[2] ?? "", 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function createMockGh(opts: {
  specs: IssueSpec[];
  /** Labelled-event actors keyed by label name (default: alice). */
  labelActors?: Record<string, string>;
}): (args: string[]) => Promise<string> {
  const bodyByNumber = new Map(opts.specs.map((s) => [s.number, s.body ?? ""]));
  const titleByNumber = new Map(opts.specs.map((s) => [s.number, s.title]));
  const labelActors = opts.labelActors ?? { "work-on": "alice" };
  const timeline = Object.entries(labelActors).map(([label, actor], i) => ({
    event: "labeled",
    label: { name: label },
    actor: { login: actor },
    created_at: `2024-05-0${i + 1}T00:00:00Z`,
  }));

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (command.includes("issue list")) {
      return Promise.resolve(
        JSON.stringify(opts.specs.map(buildListEntry)),
      );
    }

    const viewNum = issueNumberFromView(args);
    if (viewNum !== null && command.includes("--json body")) {
      return Promise.resolve(
        JSON.stringify({ body: bodyByNumber.get(viewNum) ?? "" }),
      );
    }
    if (viewNum !== null && command.includes("number,state,title")) {
      return Promise.resolve(
        JSON.stringify({ number: viewNum, state: "OPEN", title: "" }),
      );
    }
    if (viewNum !== null && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({
          title: titleByNumber.get(viewNum) ?? "",
          body: bodyByNumber.get(viewNum) ?? "",
        }),
      );
    }

    // Native sub-issues API — none in these fixtures.
    if (command.includes("/sub_issues")) {
      return Promise.resolve("[]");
    }

    if (command.includes("timeline") || command.includes("timelineItems")) {
      return Promise.resolve(JSON.stringify(timeline));
    }

    return Promise.resolve("[]");
  };
}

async function collect(
  mockGh: (args: string[]) => Promise<string>,
  config: WorkerConfig,
  recorder: Recorder,
  repoAllIssues?: FilterableIssue[],
  repoClosedPRs: ClosedPR[] = [],
  repoPRs: OpenPR[] = [],
) {
  const cache = new IssueCache(
    Deno.makeTempDirSync({ prefix: "work-on-escalation-cache-" }),
    600,
  );
  const gh = recordingGh(mockGh, recorder);
  const options: FindIssuesOptions = {
    githubUser: "bot",
    ghCommandFn: gh,
    cache,
  };
  const fetcher = createIssueFetcher(gh);
  const issues = repoAllIssues ?? [];
  return await collectWorkOnCandidates(
    "owner/repo",
    config,
    options,
    repoPRs,
    issues,
    fetcher,
    repoClosedPRs,
  );
}

// ---------------------------------------------------------------------------
// Cycle escalation + continue past the cycle
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - breaks a dependency cycle in issue-number order and still selects the eligible issue (Issue #4298)",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 10,
          title: "Eligible feature",
          labels: ["work-on"],
          body: "No dependencies",
        },
        {
          number: 340,
          title: "Half of a loop",
          labels: ["work-on"],
          body: "Depends on #341",
        },
        {
          number: 341,
          title: "Other half",
          labels: ["work-on"],
          body: "Depends on #340",
        },
      ],
    });

    const result = await collect(mockGh, config, recorder);

    // The eligible issue and the lowest-numbered cycle member are worked; the
    // other member waits on it as an ordinary dependency.
    assertEquals(result.candidates.map((c) => c.number).sort(), [10, 340]);
    assertEquals(
      result.blockedDetails.map((b) => [b.issueNumber, b.reason]),
      [[341, "dependency-blocked"]],
    );
    // Nothing is handed to a human.
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
    assertEquals(result.hasSuppressingWorkOn, true);
  },
);

Deno.test(
  "collectWorkOnCandidates - a repo whose only work-on issues form a cycle works the lowest-numbered one (Issue #4298)",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 340,
          title: "Half of a loop",
          labels: ["work-on"],
          body: "Depends on #341",
        },
        {
          number: 341,
          title: "Other half",
          labels: ["work-on"],
          body: "Depends on #340",
        },
      ],
    });

    const result = await collect(mockGh, config, recorder);

    assertEquals(result.candidates.map((c) => c.number), [340]);
    assertEquals(recorder.labels, []);
    // A cycle member is now real work, so the repo's lower tiers wait for it.
    assertEquals(result.hasSuppressingWorkOn, true);
  },
);

Deno.test(
  "collectWorkOnCandidates - a cycle member that also waits on an open issue outside the cycle stays blocked (Issue #4298)",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const specs: IssueSpec[] = [
      {
        number: 340,
        title: "Half of a loop",
        labels: ["work-on"],
        body: "Depends on #341\nDepends on #500",
      },
      {
        number: 341,
        title: "Other half",
        labels: ["work-on"],
        body: "Depends on #340",
      },
      { number: 500, title: "Unrelated open prerequisite", labels: [] },
    ];

    const result = await collect(
      createMockGh({ specs }),
      config,
      recorder,
      specs.map(buildFilterableIssue),
    );

    // #340 is the lowest on the cycle, but it also waits on #500, which is a
    // real wait; releasing it would skip that dependency.
    assertEquals(result.candidates, []);
    assertEquals(recorder.labels, []);
  },
);

// ---------------------------------------------------------------------------
// Dead-label tracker: the label is stripped (Issue #4298)
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - strips the dead work-on label from a milestone-tracking issue (Issue #4298)",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 20,
          title: "Merge milestone 'v21' to main",
          labels: ["work-on"],
        },
      ],
    });

    const result = await collect(mockGh, config, recorder);

    assertEquals(result.candidates, []);
    assertEquals(recorder.removed, [{ issue: 20, label: "work-on" }]);
    assertEquals(recorder.labels, [], "never handed to a human");
    assertEquals(recorder.comments, []);
    assertEquals(result.hasSuppressingWorkOn, false);
  },
);

// ---------------------------------------------------------------------------
// A tracker with another blocking label is left to that label
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - a tracker carrying another blocking label is left alone",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 20,
          title: "Merge milestone 'v21' to main",
          labels: ["work-on", "needs-human"],
        },
      ],
      // needs-human added by a trusted author so verifyOperationalLabels
      // keeps it on the issue.
      labelActors: { "work-on": "alice", "needs-human": "alice" },
    });

    const result = await collect(mockGh, config, recorder);

    assertEquals(result.candidates, []);
    // Nothing written: the blocking label already keeps it out of the pool.
    assertEquals(recorder.labels, []);
    assertEquals(recorder.removed, []);
    assertEquals(recorder.comments, []);
    assertEquals(result.hasSuppressingWorkOn, false);
  },
);

// ---------------------------------------------------------------------------
// A stalled dependency is an ordinary wait, never `needs-human` (Issue #2545)
//
// Issue #2473 labelled a work-on issue `needs-human` whenever its dependency
// carried `needs-human`, was assigned outside a configured list, or had a
// merged PR. On 2026-09-23 that parked VibeCoder #2532 (dependency #2530 had
// a merged PR and had already closed), #2534 (dependency #2532 had just been
// given the label) and #2535 (dependency #2531 was being worked by the fleet
// account VibeCoderST). Each would have been worked unattended the moment
// its dependency closed. A dependency wait clears by itself; the label never
// does.
// ---------------------------------------------------------------------------

async function stalledBlockerCase(
  blocker: Omit<IssueSpec, "number" | "title">,
  repoClosedPRs: ClosedPR[] = [],
): Promise<{
  recorder: Recorder;
  result: Awaited<ReturnType<typeof collect>>;
}> {
  const config = makeConfig();
  const recorder = newRecorder();
  const specs: IssueSpec[] = [
    {
      number: 100,
      title: "Feature depending on fix",
      labels: ["work-on"],
      body: "Depends on #200",
    },
    { number: 200, title: "The fix", ...blocker },
  ];
  const result = await collect(
    createMockGh({ specs }),
    config,
    recorder,
    specs.map(buildFilterableIssue),
    repoClosedPRs,
  );
  return { recorder, result };
}

function assertOrdinaryWait(
  { recorder, result }: Awaited<ReturnType<typeof stalledBlockerCase>>,
): void {
  assertEquals(result.candidates, []);
  assertEquals(
    recorder.labels,
    [],
    "a dependency wait must never park the dependant with needs-human",
  );
  assertEquals(recorder.comments, []);
  assertEquals(
    result.blockedDetails.find((b) => b.issueNumber === 100)?.reason,
    "dependency-blocked",
  );
}

Deno.test(
  "collectWorkOnCandidates - a dependency carrying needs-human does not spread the label to its dependant (Issue #2545)",
  async () => {
    assertOrdinaryWait(await stalledBlockerCase({ labels: ["needs-human"] }));
  },
);

Deno.test(
  "collectWorkOnCandidates - a dependency a sibling fleet account is working is an ordinary wait (Issue #2545)",
  async () => {
    assertOrdinaryWait(
      await stalledBlockerCase({ labels: [], assignees: ["VibeCoderST"] }),
    );
  },
);

Deno.test(
  "collectWorkOnCandidates - a dependency whose PR merged is an ordinary wait until it closes (Issue #2545)",
  async () => {
    assertOrdinaryWait(
      await stalledBlockerCase({ labels: ["work-on"] }, [
        {
          number: 2541,
          title: "Let claims share a busy milestone stream (Issue #200)",
          closedAt: "2026-09-23T11:02:21Z",
          merged: true,
        },
      ]),
    );
  },
);

Deno.test(
  "collectWorkOnCandidates - does not escalate when blocking dependency is claimable",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 100,
          title: "Feature depending on claimable fix",
          labels: ["work-on"],
          body: "Depends on #200",
        },
        {
          number: 200,
          title: "Claimable fix",
          labels: [],
          assignees: ["alice"],
        },
      ],
    });

    const repoAllIssues: FilterableIssue[] = [
      buildFilterableIssue({
        number: 100,
        title: "Feature depending on claimable fix",
        labels: ["work-on"],
        body: "Depends on #200",
      }),
      buildFilterableIssue({
        number: 200,
        title: "Claimable fix",
        labels: [],
        assignees: ["alice"],
      }),
    ];

    const result = await collect(mockGh, config, recorder, repoAllIssues);

    // The candidate should be dropped due to ordinary dependency block (not escalated).
    assertEquals(result.candidates, []);

    // No escalation: no labels or comments posted.
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
  },
);

// ---------------------------------------------------------------------------
// Dependency blockers are recorded on the blocked entry (Issue #2494)
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - a dependency-blocked candidate records the blockers the stall check used",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const body = "Depends on #200\nDepends on other/repo#9";
    const mockGh = createMockGh({
      specs: [
        {
          number: 100,
          title: "Feature depending on claimable fixes",
          labels: ["work-on"],
          body,
        },
        {
          number: 200,
          title: "Claimable fix",
          labels: [],
          assignees: ["alice"],
        },
      ],
    });

    const repoAllIssues: FilterableIssue[] = [
      buildFilterableIssue({
        number: 100,
        title: "Feature depending on claimable fixes",
        labels: ["work-on"],
        body,
      }),
      buildFilterableIssue({
        number: 200,
        title: "Claimable fix",
        labels: [],
        assignees: ["alice"],
      }),
    ];

    const result = await collect(mockGh, config, recorder, repoAllIssues);

    assertEquals(result.candidates, []);
    const entry = result.blockedDetails.find((b) => b.issueNumber === 100);
    assertEquals(entry?.reason, "dependency-blocked");
    // The cross-repo blocker keeps its own repo.
    assertEquals(entry?.blockers, [
      { repo: "owner/repo", number: 200, kind: "depends-on" },
      { repo: "other/repo", number: 9, kind: "depends-on" },
    ]);
    // Issue #2534: a non-`pr-blocked` skip records no blocking PR.
    assertEquals(entry?.blockingPr, undefined);
  },
);

// ---------------------------------------------------------------------------
// The blocking PR is recorded on the blocked entry (Issue #2534)
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - a pr-blocked candidate records the blocking PR number",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 110,
          title: "Held by an open fleet PR",
          labels: ["work-on"],
          body: "No dependencies",
        },
      ],
    });

    // A fleet-authored PR on the default branch blocks a non-milestone issue.
    const repoPRs: OpenPR[] = [{
      number: 914,
      title: "Fleet work in flight",
      baseRefName: "main",
      headRefName: "issue-109-something",
      author: "bot",
    }];

    const result = await collect(
      mockGh,
      config,
      recorder,
      undefined,
      [],
      repoPRs,
    );

    assertEquals(result.candidates, []);
    const entry = result.blockedDetails.find((b) => b.issueNumber === 110);
    assertEquals(entry?.reason, "pr-blocked");
    assertEquals(entry?.blockingPr, 914);
  },
);

// ---------------------------------------------------------------------------
// The blocking PR is recorded on the blocked entry (Issue #2534)
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - a pr-blocked candidate records the blocking PR number",
  async () => {
    const config = makeConfig();
    const recorder = newRecorder();
    const mockGh = createMockGh({
      specs: [
        {
          number: 110,
          title: "Held by an open fleet PR",
          labels: ["work-on"],
          body: "No dependencies",
        },
      ],
    });

    // A fleet-authored PR on the default branch blocks a non-milestone issue.
    const repoPRs: OpenPR[] = [{
      number: 914,
      title: "Fleet work in flight",
      baseRefName: "main",
      headRefName: "issue-109-something",
      author: "bot",
    }];

    const result = await collect(
      mockGh,
      config,
      recorder,
      undefined,
      [],
      repoPRs,
    );

    assertEquals(result.candidates, []);
    const entry = result.blockedDetails.find((b) => b.issueNumber === 110);
    assertEquals(entry?.reason, "pr-blocked");
    assertEquals(entry?.blockingPr, 914);
  },
);
