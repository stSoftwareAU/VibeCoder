/**
 * End-to-end regression test: `work-on` beats `idle-task` fleet-wide
 * (Issue #2814 — reproduces the private-repo-17 #1365–#1372 inversion).
 *
 * #2771 shipped fair within-tier rotation + per-repo `nice` and named this
 * exact private-repo-17 batch, yet the inversion still occurred: a
 * low-`nice` repo's `idle-task` was being selected — and a fresh idle-task
 * filed — ahead of a higher-`nice` repo's unblocked `work-on` backlog. The
 * two halves were repaired by #2812 (selection: idle-task is a fleet-global
 * floor across `nice` tiers) and #2813 (filing: an unblocked real-work issue
 * anywhere in the monitored set suppresses idle filing). This combined
 * end-to-end guard locks the fleet-global invariant so it cannot regress
 * again (precedent: `idle_task_multi_worker_end_to_end_test.ts`).
 *
 * Fleet fixture:
 *   - Repo A (private-repo-17-like) — several open, unassigned `work-on`
 *     issues that also carry `degraded-model` and `lang:rust`, placed in a
 *     *higher* `nice` tier (worked last).
 *   - Repo B — a *lower* `nice` tier (worked sooner) whose only candidate is
 *     an `idle-task` wrapper.
 *
 * Three invariants are asserted, exercising the real selection, filing, and
 * filtering code (no greps, no source inspection):
 *   1. Selection — `selectHighestPriority` claims a repo-A `work-on` issue,
 *      never the repo-B `idle-task`, until every real-work tier is drained
 *      fleet-wide (then, and only then, idle-task becomes selectable).
 *   2. Filing — while repo A holds unblocked `work-on` work, the real
 *      `maybe-file-idle-task` command (driving the real
 *      `anyRepoHasUnblockedRealWork` fleet gate) files no new idle-task into
 *      the quiet repo B.
 *   3. The parent's lead hypothesis — `degraded-model` + `lang:rust` do not
 *      exclude a `work-on` issue from the claimable backlog
 *      (`issue_filter.ts` `filterAndSort`), the fleet busy check
 *      (`anyRepoHasUnblockedRealWork`), or selection (`selectHighestPriority`).
 *
 * Observed red→green: assertion 1 fails on pre-#2812 code (the low-`nice`
 * idle-task is selected before the high-`nice` work-on); assertion 2 fails on
 * pre-#2813 code (no fleet gate, so the per-repo busy check lets the quiet
 * repo B be filed into). Both pass with #2812 and #2813 applied.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  type IssueCandidate,
  selectHighestPriority,
  type SelectionResult,
} from "../lib/issue_priority.ts";
import { anyRepoHasUnblockedRealWork } from "../lib/repo_busy_for_idle_task.ts";
import { type FilterableIssue, filterAndSort } from "../lib/issue_filter.ts";
import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  registerTemplate,
} from "../lib/idle_task_template.ts";
import type { IdleTaskMilestone } from "../lib/idle_task_milestone.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Shared fleet fixture
// ---------------------------------------------------------------------------

/** private-repo-17-like repo with the deferred `work-on` backlog. */
const REPO_A = "stSoftwareAU/private-repo-17";
/** Quiet repo whose only candidate is an idle-task wrapper. */
const REPO_B = "stSoftwareAU/quiet-repo";
const WORKER_USER = "VibeBot";

/**
 * Per-repo `nice`: repo A is the *higher* tier (worked last), repo B the
 * *lower* tier (worked sooner). The inversion #2812 fixes is precisely
 * "low-`nice` idle-task in repo B selected ahead of high-`nice` work-on in
 * repo A".
 */
const NICE: Record<string, number> = { [REPO_A]: 10, [REPO_B]: 0 };
const repoNice = (repo: string): number => NICE[repo] ?? 0;

/** Labels a private-repo-17 work-on issue carries in the real scenario. */
const WORK_ON_LABELS = ["work-on", "degraded-model", "lang:rust"];

function workOnCandidate(
  number: number,
  createdAt: string,
): IssueCandidate {
  return {
    repo: REPO_A,
    number,
    url: `https://github.com/${REPO_A}/issues/${number}`,
    title: `private-repo-13 work-on #${number}`,
    milestone: "",
    createdAt,
    labelIndex: 0,
    source: "work-on",
  };
}

function idleTaskCandidate(number: number): IssueCandidate {
  return {
    repo: REPO_B,
    number,
    url: `https://github.com/${REPO_B}/issues/${number}`,
    title: "Run a security scan",
    milestone: "",
    createdAt: "2026-06-01T00:00:00Z",
    labelIndex: 0,
    source: "idle-task",
  };
}

// ---------------------------------------------------------------------------
// Assertion 1 — selection: high-`nice` work-on beats low-`nice` idle-task
// ---------------------------------------------------------------------------

Deno.test(
  "fleet invariant - work-on in a higher nice tier is selected over an idle-task in a lower nice tier (Issue #2814 / #2812)",
  () => {
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      // Repo A backlog — deferred to a higher `nice` tier.
      workOnCandidates: [
        workOnCandidate(1365, "2026-05-01T00:00:00Z"),
        workOnCandidate(1366, "2026-05-02T00:00:00Z"),
        workOnCandidate(1372, "2026-05-08T00:00:00Z"),
      ],
      blockedEntries: [],
      lowPriorityCandidates: [],
      // Repo B's only candidate — an idle-task wrapper in the lower tier.
      idleTaskCandidates: [idleTaskCandidate(42)],
    };

    const selected = selectHighestPriority(result, { repoNice });

    assert(selected !== null, "expected a candidate to be selected");
    assertEquals(
      selected!.source,
      "work-on",
      "idle-task in a lower nice tier must never beat work-on in a higher tier",
    );
    assertEquals(selected!.repo, REPO_A);
    assert(
      selected!.repo !== REPO_B,
      `must not select the repo-B idle-task while repo A holds work-on work`,
    );
  },
);

Deno.test(
  "fleet invariant - idle-task becomes selectable only once every real-work tier is drained fleet-wide (Issue #2814 / #2812)",
  () => {
    // Same fixture, but repo A's real work is now exhausted (claimed/closed).
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [],
      blockedEntries: [],
      lowPriorityCandidates: [],
      idleTaskCandidates: [idleTaskCandidate(42)],
    };

    const selected = selectHighestPriority(result, { repoNice });

    assert(
      selected !== null,
      "idle-task must be selectable when no real work remains",
    );
    assertEquals(selected!.source, "idle-task");
    assertEquals(selected!.repo, REPO_B);
  },
);

// ---------------------------------------------------------------------------
// Assertion 2 — filing: deferred repo-A work-on suppresses idle filing
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

/** An open issue in the fleet fixture, keyed by repo. */
interface FleetIssue {
  number: number;
  url: string;
  labels: string[];
}

/**
 * gh stub backed by an in-memory `repo -> open issues` map. Answers every
 * `gh issue list --label <L>` query (cross-repo wrapper dedup *and* the real
 * `anyRepoHasUnblockedRealWork` fleet gate) from the fixture, and records any
 * `gh issue create` so the test can assert none was attempted.
 */
function makeFleetGh(open: Map<string, FleetIssue[]>): {
  fn: (args: string[]) => Promise<string>;
  calls: GhCall[];
} {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const subcommand = args[0] === "issue" ? args[1] : "";
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
    const labelIdx = args.indexOf("--label");
    const label = labelIdx >= 0 ? args[labelIdx + 1] ?? "" : "";

    if (subcommand === "list") {
      const rows = (open.get(repo) ?? [])
        .filter((i) => i.labels.includes(label))
        .map((i) => ({
          number: i.number,
          url: i.url,
          labels: i.labels.map((name) => ({ name })),
        }));
      return Promise.resolve(JSON.stringify(rows));
    }

    if (subcommand === "create") {
      // A create would mean the filer ignored the fleet gate — the test
      // asserts this never happens, but return a plausible URL anyway.
      return Promise.resolve(`https://github.com/${repo}/issues/9999\n`);
    }

    return Promise.resolve("");
  };
  return { fn, calls };
}

// A test-only template so the filer does not depend on production prose.
const TEST_TEMPLATE_NAME = "fleet-invariant-test-template";
const testTemplate: IdleTaskTemplate = {
  name: TEST_TEMPLATE_NAME,
  description: "Test-only template for the fleet-invariant regression test.",
  buildIssueTitle: (repo) => `Run ${TEST_TEMPLATE_NAME} on ${repo}`,
  buildIssueBody: (opts) => `# ${TEST_TEMPLATE_NAME} on ${opts.repo}`,
  runTask: () =>
    Promise.resolve({ ok: true, summary: `${TEST_TEMPLATE_NAME} ran` }),
};
if (getTemplate(TEST_TEMPLATE_NAME) === undefined) {
  registerTemplate(testTemplate);
}

Deno.test(
  "fleet invariant - idle-task filer files nothing while repo A holds unblocked work-on work (Issue #2814 / #2813)",
  async () => {
    // Repo A holds the deferred, unblocked work-on backlog (carrying
    // degraded-model + lang:rust); repo B is genuinely quiet — no real work
    // and no existing idle-task wrapper, so before #2813 it would have been
    // filed into.
    const open = new Map<string, FleetIssue[]>([
      [REPO_A, [
        {
          number: 1365,
          url: `https://github.com/${REPO_A}/issues/1365`,
          labels: WORK_ON_LABELS,
        },
        {
          number: 1372,
          url: `https://github.com/${REPO_A}/issues/1372`,
          labels: WORK_ON_LABELS,
        },
      ]],
      [REPO_B, []],
    ]);
    const gh = makeFleetGh(open);
    const log: string[] = [];

    const milestone = (opts: { repo: string; template: string }) =>
      Promise.resolve(
        {
          number: 17,
          title: `idle-task: ${opts.template}`,
        } as IdleTaskMilestone,
      );

    const result = await maybeFileIdleTaskCommand.execute(
      {
        // Repo A first so the fleet gate short-circuits on its real work.
        "monitored-repos": `${REPO_A},${REPO_B}`,
        "github-user": WORKER_USER,
        "worker-user": WORKER_USER,
        __testDeps: {
          // Real gh stub — the default `anyRepoHasWorkFn` (the #2813 fleet
          // gate) runs against it, so this exercises the production
          // `anyRepoHasUnblockedRealWork` path rather than a stubbed verdict.
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          ensureLabelFn: () =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ensureMilestoneFn: milestone,
          nowFn: () => new Date("2026-06-15T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
        },
      } as Record<string, unknown>,
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action?: string; reason?: string }
      | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(
      data?.reason,
      "approved_work_in_flight",
      "the fleet gate must suppress idle filing while repo A holds work-on work",
    );

    // No idle-task was filed anywhere in the fleet.
    const createCalls = gh.calls.filter(
      (c) => c.args[0] === "issue" && c.args[1] === "create",
    );
    assertEquals(
      createCalls.length,
      0,
      "no idle-task may be filed while unblocked work-on work exists fleet-wide",
    );

    // The skip is fleet-scoped, not just repo-B-local.
    const skipLine = log.find(
      (l) =>
        l.includes("action=skipped") &&
        l.includes("reason=approved_work_in_flight"),
    );
    assert(
      skipLine !== undefined,
      `expected a fleet-scope approved_work_in_flight skip line; saw ${
        JSON.stringify(log)
      }`,
    );
  },
);

// ---------------------------------------------------------------------------
// Assertion 3 — degraded-model + lang:rust never exclude work-on work
// ---------------------------------------------------------------------------

Deno.test(
  "fleet invariant - degraded-model + lang:rust work-on issue survives filterAndSort, the fleet busy check, and selection (Issue #2814)",
  async () => {
    // (3a) filterAndSort — the issue is part of the claimable backlog.
    const issues: FilterableIssue[] = [
      {
        number: 1365,
        title: "private-repo-13 work-on #1365",
        url: `https://github.com/${REPO_A}/issues/1365`,
        author: WORKER_USER,
        assignees: [],
        labels: WORK_ON_LABELS,
        createdAt: "2026-05-01T00:00:00Z",
        milestone: "",
      },
    ];
    const filtered = filterAndSort(issues, {
      failedLabel: "failed",
      needsRevisionLabel: "needs-revision",
      refineIssueLabel: "refine-issue",
      planningLabel: "planning",
      questionLabel: "question",
      needsHumanLabel: "needs-human",
    });
    assertEquals(
      filtered.length,
      1,
      "degraded-model + lang:rust must not exclude a work-on issue from discovery",
    );
    assertEquals(filtered[0]!.number, 1365);

    // (3b) anyRepoHasUnblockedRealWork — the issue counts as fleet work.
    const open = new Map<string, FleetIssue[]>([
      [REPO_A, [
        {
          number: 1365,
          url: `https://github.com/${REPO_A}/issues/1365`,
          labels: WORK_ON_LABELS,
        },
      ]],
      [REPO_B, []],
    ]);
    const gh = makeFleetGh(open);
    const hasWork = await anyRepoHasUnblockedRealWork({
      repos: [REPO_A, REPO_B],
      ghCommandFn: gh.fn,
      logFn: () => {},
    });
    assert(
      hasWork,
      "the fleet busy check must count a degraded-model + lang:rust work-on issue as work",
    );

    // (3c) selectHighestPriority — the issue is selectable real work.
    const selected = selectHighestPriority(
      {
        selected: null,
        labelCandidates: [],
        workOnCandidates: [workOnCandidate(1365, "2026-05-01T00:00:00Z")],
        blockedEntries: [],
        lowPriorityCandidates: [],
        idleTaskCandidates: [idleTaskCandidate(42)],
      },
      { repoNice },
    );
    assertEquals(selected?.source, "work-on");
    assertEquals(selected?.number, 1365);
  },
);
