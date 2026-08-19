/**
 * Integration tests for unworkable-work-on escalation in
 * `collectWorkOnCandidates` (Issue #2752).
 *
 * Verifies that:
 *   - a dependency cycle (A→B→A) escalates every issue on the cycle
 *     (needs-human + one comment naming the loop), drops them from
 *     candidates, and still selects a separate eligible work-on issue in the
 *     same pass (continue past the cycle, do not stall);
 *   - a milestone-tracking issue carrying `work-on` is escalated as a
 *     self-suppressing dead label and dropped;
 *   - re-scanning an already-escalated issue (carrying `needs-human`) posts
 *     no duplicate comment and does not re-apply the label.
 *
 * The GitHub label/comment calls are mocked via an injected recording client
 * and their payloads asserted.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createIssueFetcher,
  type FindIssuesOptions,
} from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { GitHubClient, GitHubComment, WorkerConfig } from "../types.ts";
import type { EscalateUnworkableDeps } from "../lib/escalate_unworkable_work_on.ts";

interface Recorder {
  labels: Array<{ issue: number; label: string }>;
  comments: Array<{ issue: number; body: string }>;
}

function recordingClient(recorder: Recorder): GitHubClient {
  const notImpl = (m: string) => () => Promise.reject(new Error(`${m} unused`));
  return {
    getIssue: notImpl("getIssue"),
    getIssueComments: (): Promise<GitHubComment[]> => Promise.resolve([]),
    addLabel: (_repo: string, issue: number, label: string) => {
      recorder.labels.push({ issue, label });
      return Promise.resolve();
    },
    removeLabel: notImpl("removeLabel"),
    postComment: (_repo: string, issue: number, body: string) => {
      recorder.comments.push({ issue, body });
      return Promise.resolve(undefined);
    },
    editIssue: notImpl("editIssue"),
    assignIssue: notImpl("assignIssue"),
    unassignIssue: notImpl("unassignIssue"),
    closeIssue: notImpl("closeIssue"),
  };
}

function escalateDeps(recorder: Recorder): EscalateUnworkableDeps {
  return {
    ghClient: recordingClient(recorder),
    ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
  };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
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
) {
  const cache = new IssueCache(
    Deno.makeTempDirSync({ prefix: "work-on-escalation-cache-" }),
    600,
  );
  const options: FindIssuesOptions = {
    githubUser: "bot",
    ghCommandFn: mockGh,
    cache,
    escalateDeps: escalateDeps(recorder),
  };
  const fetcher = createIssueFetcher(mockGh);
  const repoPRs: OpenPR[] = [];
  const repoClosedPRs: ClosedPR[] = [];
  const repoAllIssues: FilterableIssue[] = [];
  return await collectWorkOnCandidates(
    "owner/repo",
    config,
    options,
    repoPRs,
    repoAllIssues,
    fetcher,
    repoClosedPRs,
  );
}

// ---------------------------------------------------------------------------
// Cycle escalation + continue past the cycle
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - escalates a dependency cycle and still selects the eligible issue",
  async () => {
    const config = makeConfig();
    const recorder: Recorder = { labels: [], comments: [] };
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

    // The eligible issue is selected in the same pass.
    assertEquals(result.candidates.length, 1);
    assertEquals(result.candidates[0]!.number, 10);

    // Both cyclic issues escalated exactly once with needs-human.
    const escalatedIssues = recorder.labels.map((l) => l.issue).sort();
    assertEquals(escalatedIssues, [340, 341]);
    assertEquals(recorder.labels.every((l) => l.label === "needs-human"), true);

    // Exactly one comment per cyclic issue, naming the loop.
    assertEquals(recorder.comments.length, 2);
    const byIssue = new Map(recorder.comments.map((c) => [c.issue, c.body]));
    assertStringIncludes(byIssue.get(340)!, "#340 → #341 → #340");
    assertStringIncludes(byIssue.get(341)!, "#341 → #340 → #341");

    // The cyclic issues are escalated, not suppressing — but the genuine
    // eligible candidate keeps the suppression signal true.
    assertEquals(result.hasSuppressingWorkOn, true);
  },
);

Deno.test(
  "collectWorkOnCandidates - a repo whose only work-on issues form a cycle does not suppress",
  async () => {
    const config = makeConfig();
    const recorder: Recorder = { labels: [], comments: [] };
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

    assertEquals(result.candidates, []);
    assertEquals(recorder.labels.map((l) => l.issue).sort(), [340, 341]);
    // Both surviving work-on issues were escalated and dropped, so the repo
    // must not keep its backlog suppressed.
    assertEquals(result.hasSuppressingWorkOn, false);
  },
);

// ---------------------------------------------------------------------------
// Dead-label tracker escalation
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - escalates a milestone-tracking work-on issue (dead label)",
  async () => {
    const config = makeConfig();
    const recorder: Recorder = { labels: [], comments: [] };
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
    assertEquals(recorder.labels, [{ issue: 20, label: "needs-human" }]);
    assertEquals(recorder.comments.length, 1);
    assertStringIncludes(recorder.comments[0]!.body, "Relabel or close");
    assertEquals(result.hasSuppressingWorkOn, false);
  },
);

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

Deno.test(
  "collectWorkOnCandidates - an already-escalated tracker is not re-escalated",
  async () => {
    const config = makeConfig();
    const recorder: Recorder = { labels: [], comments: [] };
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
    // No duplicate comment, no label re-apply.
    assertEquals(recorder.labels, []);
    assertEquals(recorder.comments, []);
    assertEquals(result.hasSuppressingWorkOn, false);
  },
);
