/**
 * The repeat-gate split hook (Issue #4130): a repeat worker-gate failure splits
 * the parent into sub-issues instead of being recorded again.
 *
 * Every GitHub and git call is recorded, so each test can say what the hook
 * did and, as importantly, what it did not do. The planning round is replaced
 * by the `planHeldIssue` seam. The fake GitHub keeps the state a real one would:
 * a closed PR leaves the open set, and a closed parent reads as CLOSED.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";
import {
  type FailureCategory,
  getFailureCategoryDisplay,
} from "../lib/failure_diagnosis.ts";
import type { PlanningResult } from "../lib/planning_processor.ts";
import {
  createRepeatGateSplitHook,
  type RepeatGateBranch,
} from "../lib/repeat_gate_split.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import type { GitHubClient, GitHubComment, Result } from "../types.ts";
import type { RepeatGateSplitOutcome } from "../lib/label_types.ts";

const REPO = "org/repo";
const PARENT = 4130;
const FLEET = "testbot";
const BRANCH = "issue-4130-run-2";
const REPO_PATH = "/tmp/repeat-gate-4130/repo";
const SUB_1 = "https://github.com/org/repo/issues/101";
const SUB_2 = "https://github.com/org/repo/issues/102";
const SEED_HEADING =
  "### Worker split context (Issue #4130) — written by the worker";
const GATE_OUTPUT = "GATE-MARKER: quality check failed in foo_test.ts";
const PREV_OUTPUT = "PREV-MARKER: the earlier assertion mismatch";
const REFUSED_NOT_BACKED =
  "failed-once is not backed by a fleet-authored failure record";
const ALL_CATEGORIES: FailureCategory[] = [
  "summary_incomplete",
  "quality_check",
  "pre_push_gate",
  "security_fix_gate",
];

type GitResponder = (
  args: string[],
) => Promise<Result<GitCommandOutput>>;

/** A pull request as the fake `gh pr list` knows it. */
interface FakePr {
  number: number;
  isDraft?: boolean;
  isCrossRepository?: boolean;
}

/** What a scenario can change. Anything left out takes the default. */
interface Scenario {
  category?: FailureCategory;
  gateOutput?: string;
  /** The parent's comments; defaults to one fleet-authored failure record. */
  comments?: GitHubComment[];
  /** Makes reading the parent's comments fail. */
  commentsUnreadable?: boolean;
  issueComments?: string;
  issues?: Record<number, { body: string; labels?: string[] }>;
  planned?: Result<PlanningResult> | "throw";
  subIssueUrls?: string[];
  uncoveredAsks?: string[];
  /** JSON array of the open PRs on the run branch. */
  prs?: string;
  parentState?: "OPEN" | "CLOSED";
  branchName?: string;
  baseBranch?: string;
  defaultBranch?: string;
  git?: GitResponder;
  /** Overrides a `gh` call; return `undefined` to take the default answer. */
  gh?: (args: string[]) => Promise<string> | undefined;
  createClientThrows?: boolean;
  /** The parent's number; defaults to PARENT. */
  parent?: number;
}

interface Recording {
  gh: string[][];
  git: string[][];
  edits: { issue: number; body: string }[];
  labelsAdded: { issue: number; label: string }[];
  labelsRemoved: { issue: number; label: string }[];
  planningContexts: IssueContext[];
  /** Every warning the hook logged, in order. */
  warns: string[];
  /** Every `info` line the hook logged, and its context. */
  infos: string[];
  infoContexts: unknown[];
}

interface Run {
  outcome: RepeatGateSplitOutcome;
  rec: Recording;
}

function okGit(stdout = "", code = 0, stderr = ""): Result<GitCommandOutput> {
  return { ok: true, value: { code, stdout, stderr } };
}

/** A branch whose ref resolves, and whose log, stat and names all answer. */
function defaultGit(args: string[]): Promise<Result<GitCommandOutput>> {
  if (args[0] === "rev-parse") return Promise.resolve(okGit("", 0));
  if (args[0] === "log") {
    return Promise.resolve(
      okGit("abc1234 Add the thing\ndef5678 Fix the other thing\n"),
    );
  }
  if (args[0] === "diff" && args[1] === "--stat") {
    return Promise.resolve(okGit(" src/a.ts | 4 ++--\n 1 file changed\n"));
  }
  if (args[0] === "diff" && args[1] === "--name-only") {
    return Promise.resolve(okGit("src/a.ts\nsrc/b.ts\n"));
  }
  return Promise.resolve(okGit());
}

function comment(author: string, body: string, id = 1): GitHubComment {
  return {
    id,
    body,
    author,
    createdAt: "2026-10-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

/** A failure record shaped as `markIssueAsFailedOnce` writes it. */
function failureRecord(attempt: string, output: string): string {
  return [
    `## Automated Processing Failed (${attempt})`,
    "",
    "**Category:** `quality-failure`",
    "",
    "The automated worker failed.",
    "",
    "### Error Output",
    "> key error line",
    "",
    "<details>",
    "<summary>Full output (click to expand)</summary>",
    "",
    output,
    "</details>",
    "",
    "### What this means",
    "Something went wrong.",
  ].join("\n");
}

/** A failure record whose body is `raw`, placed after its quoted key line. */
function recordWithRawBody(raw: string): string {
  return [
    "## Automated Processing Failed (First Attempt)",
    "",
    "### Error Output",
    "> key error line",
    "",
    raw,
  ].join("\n");
}

/** A body that carries the other two acceptance sections. */
function bodyWithSections(partOfLine: string): string {
  return [
    partOfLine,
    "",
    "## Failing gate output",
    "x",
    "",
    "## What the branch got done",
    "y",
  ].join("\n");
}

/** Every recorded `pr` sub-command, `pr list` included. */
function prCommands(rec: Recording): string[][] {
  return rec.gh.filter((args) => args[0] === "pr");
}

/** Calls that mutate GitHub state or the remote: what a clean-up may do. */
function mutations(rec: Recording): string[] {
  const gh = rec.gh
    .filter((args) => args[0] === "pr" && args[1] !== "list")
    .map((args) => `gh ${args.join(" ")}`);
  const removals = rec.git
    .filter((args) => args[0] === "push")
    .map((args) => `git ${args.join(" ")}`);
  return [...gh, ...removals];
}

/** The `issue close` call the hook made, if any. */
function parentCloseCall(rec: Recording): string[] | undefined {
  return rec.gh.find((args) => args[0] === "issue" && args[1] === "close");
}

/** The value after `--comment` in a recorded call. */
function commentArg(args: string[]): string {
  const at = args.indexOf("--comment");
  return at < 0 ? "" : (args[at + 1] ?? "");
}

async function runSplit(s: Scenario = {}): Promise<Run> {
  const rec: Recording = {
    gh: [],
    git: [],
    edits: [],
    labelsAdded: [],
    labelsRemoved: [],
    planningContexts: [],
    warns: [],
    infos: [],
    infoContexts: [],
  };
  const issues = s.issues ?? { 101: { body: "" }, 102: { body: "" } };
  const comments = s.comments ??
    [comment(FLEET, failureRecord("First Attempt", PREV_OUTPUT))];
  const prs: FakePr[] = JSON.parse(s.prs ?? "[]");
  const openPrs = new Set(prs.map((pr) => pr.number));
  let parentState: "OPEN" | "CLOSED" = s.parentState ?? "OPEN";

  const client: GitHubClient = {
    getIssue: (_repo, number) => {
      const issue = issues[number];
      if (issue === undefined) {
        return Promise.reject(new Error(`no fake issue #${number}`));
      }
      return Promise.resolve({
        number,
        title: `Sub-issue ${number}`,
        body: issue.body,
        labels: issue.labels ?? [],
        author: FLEET,
        assignees: [],
        createdAt: "",
        updatedAt: "",
        state: "OPEN",
      });
    },
    getIssueComments: () =>
      s.commentsUnreadable
        ? Promise.reject(new Error("gh timed out reading comments"))
        : Promise.resolve(comments),
    addLabel: (_repo, number, label) => {
      rec.labelsAdded.push({ issue: number, label });
      return Promise.resolve();
    },
    removeLabel: (_repo, number, label) => {
      rec.labelsRemoved.push({ issue: number, label });
      return Promise.resolve();
    },
    postComment: () => Promise.resolve(undefined),
    editIssue: (_repo, number, updates) => {
      rec.edits.push({ issue: number, body: updates.body ?? "" });
      return Promise.resolve();
    },
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };

  /** The default answers, with the open PRs and the parent's state kept. */
  const ghDefault = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") {
      if (args.includes("--jq")) {
        // The branch-deletion assessment: the first open PR by head name.
        if (!args.includes("--head")) return "";
        const first = [...openPrs].sort((a, b) => a - b)[0];
        return first === undefined ? "" : String(first);
      }
      return JSON.stringify(
        prs
          .filter((pr) => openPrs.has(pr.number))
          .map((pr) => ({
            number: pr.number,
            isCrossRepository: pr.isCrossRepository ?? false,
          })),
      );
    }
    if (args[0] === "pr" && args[1] === "close") {
      openPrs.delete(Number(args[2]));
      return "";
    }
    if (args[0] === "issue" && args[1] === "view" && args.includes("state")) {
      return JSON.stringify({ state: parentState });
    }
    if (args[0] === "issue" && args[1] === "close") {
      parentState = "CLOSED";
      return "";
    }
    return "";
  };

  const deps = createMockDeps({
    logger: {
      warn: (message) => {
        rec.warns.push(message);
      },
      info: (message, context) => {
        rec.infos.push(message);
        rec.infoContexts.push(context);
      },
    },
    github: {
      createClient: () => {
        if (s.createClientThrows) throw new Error("no GitHub client");
        return client;
      },
      runGhCommand: (args: string[]) => {
        rec.gh.push(args);
        return s.gh?.(args) ?? Promise.resolve(ghDefault(args));
      },
    },
    git: {
      runGitCommand: (args: string[]) => {
        rec.git.push(args);
        return (s.git ?? defaultGit)(args);
      },
    },
  });

  const config = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: s.parent ?? PARENT,
    issueTitle: "Big issue",
    issueBody: "The body of the big issue.",
    issueLabels: ["failed-once"],
    issueComments: s.issueComments ?? "",
    githubUser: FLEET,
    config,
  };
  const branch: RepeatGateBranch = {
    branchName: s.branchName ?? BRANCH,
    repoPath: REPO_PATH,
    baseBranch: s.baseBranch ?? "main",
    defaultBranch: s.defaultBranch ?? "main",
  };
  const urls = s.subIssueUrls ?? [SUB_1, SUB_2];
  const hook = createRepeatGateSplitHook({
    ctx,
    deps,
    branch,
    planHeldIssue: async (plannedCtx) => {
      rec.planningContexts.push(plannedCtx);
      if (s.planned === "throw") throw new Error("planner exploded");
      if (s.planned !== undefined) return s.planned;
      return {
        ok: true,
        value: {
          processed: true,
          subIssueCount: urls.length,
          subIssueUrls: urls,
          summary: "planned",
          ...(s.uncoveredAsks ? { uncoveredAsks: s.uncoveredAsks } : {}),
        },
      };
    },
  });
  const outcome = await hook({
    category: s.category ?? "quality_check",
    gateOutput: s.gateOutput ?? GATE_OUTPUT,
  });
  return { outcome, rec };
}

function seedOf(rec: Recording): string {
  assertEquals(rec.planningContexts.length, 1, "the planner runs once");
  const [first] = rec.planningContexts;
  assert(first, "the planner received a context");
  return first.issueComments;
}

// ---------------------------------------------------------------------------
// (a) every splittable category seeds the planner and returns the sub-issues
// ---------------------------------------------------------------------------

for (const category of ALL_CATEGORIES) {
  Deno.test(`repeat gate split (${category}): splits and seeds the planner`, async () => {
    const { outcome, rec } = await runSplit({
      category,
      comments: [comment(FLEET, failureRecord("First Attempt", PREV_OUTPUT))],
    });
    assert(outcome.split, "the hook splits the issue");
    assertEquals(outcome.subIssueUrls, [SUB_1, SUB_2]);

    const seed = seedOf(rec);
    assertStringIncludes(seed, SEED_HEADING);
    assertStringIncludes(seed, GATE_OUTPUT);
    assertStringIncludes(seed, PREV_OUTPUT);
    assertStringIncludes(seed, "abc1234 Add the thing");
    assertStringIncludes(seed, "src/b.ts");
    assertStringIncludes(seed, getFailureCategoryDisplay(category));
  });
}

Deno.test("repeat gate split: says the previous run's output is unavailable when the fleet record quotes none", async () => {
  const { outcome, rec } = await runSplit({
    comments: [
      comment(
        FLEET,
        "## Automated Processing Failed (First Attempt)\n\nNo error output here.",
      ),
    ],
  });
  assert(outcome.split);
  assert(
    /Previous run's output unavailable/.test(seedOf(rec)),
    "the block states the previous run's output is unavailable",
  );
});

Deno.test("repeat gate split: the seed is prepended and keeps the existing comments", async () => {
  const { rec } = await runSplit({ issueComments: "EXISTING-COMMENT-TEXT" });
  const seed = seedOf(rec);
  assert(seed.indexOf(SEED_HEADING) < seed.indexOf("EXISTING-COMMENT-TEXT"));
});

// ---------------------------------------------------------------------------
// (p) provenance: failed-once must be backed by a fleet-authored record
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a failed-once label with only a human-authored record is refused, with no planning and no mutation", async () => {
  const { outcome, rec } = await runSplit({
    comments: [comment("outsider", failureRecord("First Attempt", "X"))],
    prs: JSON.stringify([{ number: 201 }]),
  });
  assertEquals(outcome, { split: false, reason: REFUSED_NOT_BACKED });
  assertEquals(rec.planningContexts, [], "the planner never runs");
  assertEquals(rec.gh, [], "no GitHub call beyond reading the comments");
  assertEquals(rec.git, [], "no git call");
  assertEquals(mutations(rec), []);
  assertEquals(rec.labelsRemoved, []);
  assertEquals(rec.edits, []);
});

Deno.test("repeat gate split: a failed-once label with zero comments is refused, with no planning and no mutation", async () => {
  const { outcome, rec } = await runSplit({
    comments: [],
    prs: JSON.stringify([{ number: 201 }]),
  });
  assertEquals(outcome, { split: false, reason: REFUSED_NOT_BACKED });
  assertEquals(rec.planningContexts, []);
  assertEquals(mutations(rec), []);
  assertEquals(rec.labelsRemoved, []);
});

Deno.test("repeat gate split: an unreadable comment thread refuses the split as unverified", async () => {
  const { outcome, rec } = await runSplit({ commentsUnreadable: true });
  assertEquals(outcome.split, false);
  assertStringIncludes(
    outcome.split ? "" : outcome.reason,
    "could not verify failed-once",
  );
  assertEquals(rec.planningContexts, []);
  assertEquals(mutations(rec), []);
  assertEquals(rec.labelsRemoved, []);
});

// ---------------------------------------------------------------------------
// (b) sub-issue acceptance sections are appended only when missing
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a bare sub-issue gets the missing sections and the label", async () => {
  const { outcome, rec } = await runSplit({
    issues: { 101: { body: "Planner's own text." }, 102: { body: "" } },
  });
  assert(outcome.split);
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit, "sub-issue #101 is edited");
  assert(
    edit.body.startsWith("Planner's own text."),
    "the planner's text is kept",
  );
  assertStringIncludes(edit.body, `Part of #${PARENT}`);
  assertStringIncludes(edit.body, "## Failing gate output");
  assertStringIncludes(edit.body, GATE_OUTPUT);
  assertStringIncludes(edit.body, "## What the branch got done");
  assertStringIncludes(edit.body, "abc1234 Add the thing");
  assert(
    rec.labelsAdded.some((l) => l.issue === 101 && l.label === "enhancement"),
  );
});

Deno.test("repeat gate split: a complete sub-issue is not edited at all", async () => {
  const complete = [
    `Part of #${PARENT}`,
    "",
    "## Failing gate output",
    "already here",
    "",
    "## What the branch got done",
    "already here too",
  ].join("\n");
  const { outcome, rec } = await runSplit({
    issues: {
      101: { body: complete, labels: ["enhancement"] },
      102: { body: "" },
    },
  });
  assert(outcome.split);
  assertEquals(
    rec.edits.filter((e) => e.issue === 101),
    [],
    "no editIssue call for the complete sub-issue",
  );
  assertEquals(
    rec.labelsAdded.filter((l) => l.issue === 101),
    [],
    "no label call for a sub-issue that already has enhancement",
  );
  assert(
    rec.edits.some((e) => e.issue === 102),
    "the bare one is still edited",
  );
});

Deno.test("repeat gate split: a Part of line for another issue does not satisfy the parent's", async () => {
  const { rec } = await runSplit({
    issues: { 101: { body: "Part of #41300 and Part of #413" } },
    subIssueUrls: [SUB_1],
  });
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit);
  assertStringIncludes(edit.body, `Part of #${PARENT}`);
});

Deno.test("repeat gate split: Part of #123 does not satisfy parent #12; Part of #12. and #12, do", async () => {
  const urls = [101, 102, 103, 104].map((n) =>
    `https://github.com/org/repo/issues/${n}`
  );
  const { rec } = await runSplit({
    parent: 12,
    subIssueUrls: urls,
    issues: {
      101: { body: bodyWithSections("Part of #123") },
      102: { body: bodyWithSections("Part of #12.") },
      103: { body: bodyWithSections("Part of #12,") },
      104: { body: bodyWithSections("Part of #12abc") },
    },
  });
  assertEquals(
    rec.edits.map((e) => e.issue),
    [101, 104],
    "only the sub-issues without a Part of #12 line are edited",
  );
  for (const issue of [101, 104]) {
    const edit = rec.edits.find((e) => e.issue === issue);
    assert(edit);
    assert(
      edit.body.split("\n").includes("Part of #12"),
      `#${issue} gets a Part of #12 line appended`,
    );
  }
});

Deno.test("repeat gate split: a failed read of one sub-issue is a warning, and the rest still count", async () => {
  const { outcome, rec } = await runSplit({
    issues: { 101: { body: "" } },
    prs: JSON.stringify([{ number: 201 }]),
  });
  assert(outcome.split, "the split still stands");
  assert(
    rec.warns.some((w) => w.includes("could not read sub-issue #102")),
    "the failed read is warned at the point it happens",
  );
  assert(
    rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === "201"),
    "the PR is closed, because sub-issue #101 was completed",
  );
});

Deno.test("repeat gate split: no completed sub-issue means no PR close and no branch delete, with a warning", async () => {
  const { outcome, rec } = await runSplit({
    issues: {},
    prs: JSON.stringify([{ number: 201 }]),
  });
  assert(outcome.split, "the parent still closes and the split stands");
  assertEquals(mutations(rec), [], "no PR close and no branch delete");
  assert(
    !rec.gh.some((a) => a[0] === "pr"),
    "not even a pr list is issued",
  );
  assert(
    rec.warns.some((w) =>
      w.includes("no sub-issue in this repository was completed")
    ),
    "a loud warning says why",
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
});

Deno.test("repeat gate split: a sub-issue in another repository does not count as completed", async () => {
  const other = "https://github.com/other/thing/issues/9";
  const { outcome, rec } = await runSplit({
    subIssueUrls: [other],
    issues: {},
    prs: JSON.stringify([{ number: 201 }]),
  });
  assert(outcome.split);
  assertEquals(mutations(rec), []);
});

Deno.test("repeat gate split: an invalid sub-issue URL is skipped with a note and a warning", async () => {
  const bad = "https://example.com/not-an-issue";
  const { outcome, rec } = await runSplit({ subIssueUrls: [SUB_1, bad] });
  assert(outcome.split);
  assert(
    outcome.notes.some((n) =>
      n.includes(`skipped ${bad}: not a GitHub issue URL`)
    ),
  );
  assert(rec.warns.some((w) => w.includes(bad)));
});

// ---------------------------------------------------------------------------
// (c) clean-up: PRs closed, remote branch deleted, failed-once removed
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: closes every open PR including a draft, deletes the remote branch, clears failed-once", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([
      { number: 201, isDraft: false, isCrossRepository: false },
      { number: 202, isDraft: true, isCrossRepository: false },
    ]),
  });
  assert(outcome.split);
  assert(
    rec.gh.some((a) =>
      a.join(" ") ===
        "pr list --repo org/repo --head issue-4130-run-2 --state open --json number,isCrossRepository"
    ),
    "lists open PRs on the run branch, with only the fields it reads",
  );
  for (const number of ["201", "202"]) {
    assert(
      rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === number),
      `closes PR #${number}`,
    );
  }
  assert(
    rec.git.some((a) =>
      a.join(" ") === `push --delete --end-of-options origin ${BRANCH}`
    ),
    "deletes the remote branch once no open PR is left on it",
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
  assert(parentCloseCall(rec), "closes the parent that planning left open");
});

Deno.test("repeat gate split: a cross-repository PR with the same head name is NOT closed, a same-repo one is", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([
      { number: 301, isCrossRepository: true },
      { number: 302, isCrossRepository: false },
    ]),
  });
  assert(outcome.split, "the split still stands");
  assert(
    !rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === "301"),
    "the fork's PR #301 is not closed",
  );
  assert(
    rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === "302"),
    "the same-repo PR #302 is closed",
  );
  assert(
    outcome.notes.some((n) =>
      n.includes("left open a cross-repository pull request #301")
    ),
    "a note says the cross-repository PR was left open",
  );
});

Deno.test("repeat gate split: the parent is closed even though planning reported open items, and the comment names them", async () => {
  const { outcome, rec } = await runSplit({ uncoveredAsks: ["the migration"] });
  assert(outcome.split);
  const close = parentCloseCall(rec);
  assert(close, "the parent is closed");
  assertStringIncludes(commentArg(close), "uncovered ask(s)");
  assertStringIncludes(commentArg(close), SUB_1);
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
});

Deno.test("repeat gate split: an already-closed parent is not closed again, and failed-once is still cleared", async () => {
  const { outcome, rec } = await runSplit({ parentState: "CLOSED" });
  assert(outcome.split);
  assertEquals(parentCloseCall(rec), undefined, "no issue close call");
  assert(
    outcome.notes.some((n) => n.includes("was already closed")),
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
});

// ---------------------------------------------------------------------------
// (d) no sub-issues or a failed planning round: refused, nothing cleaned up
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: zero published sub-issues refuses and cleans up nothing", async () => {
  const { outcome, rec } = await runSplit({
    subIssueUrls: [],
    prs: JSON.stringify([{ number: 201 }]),
  });
  assertEquals(outcome, {
    split: false,
    reason: "planning published no sub-issues",
  });
  assertEquals(mutations(rec), [], "no PR close and no branch delete");
  assertEquals(rec.labelsRemoved, [], "failed-once is not removed");
  assertEquals(rec.edits, [], "no sub-issue is edited");
});

Deno.test("repeat gate split: a planning result that is not ok refuses and cleans up nothing", async () => {
  const { outcome, rec } = await runSplit({
    planned: { ok: false, error: new Error("claude exploded") },
    prs: JSON.stringify([{ number: 201 }]),
  });
  assertEquals(outcome.split, false);
  assertStringIncludes(
    outcome.split ? "" : outcome.reason,
    "planning failed: claude exploded",
  );
  assertEquals(mutations(rec), []);
  assertEquals(rec.labelsRemoved, []);
});

Deno.test("repeat gate split: a thrown planning round refuses and cleans up nothing", async () => {
  const { outcome, rec } = await runSplit({
    planned: "throw",
    prs: JSON.stringify([{ number: 201 }]),
  });
  assertEquals(outcome.split, false);
  assertStringIncludes(
    outcome.split ? "" : outcome.reason,
    "planning failed: planner exploded",
  );
  assertEquals(mutations(rec), []);
  assertEquals(rec.labelsRemoved, []);
});

Deno.test("repeat gate split: a client that cannot be created refuses rather than throwing", async () => {
  const { outcome, rec } = await runSplit({ createClientThrows: true });
  assertEquals(outcome.split, false);
  assertEquals(rec.planningContexts, [], "planning never runs");
});

Deno.test("repeat gate split: a sub-issue in another repository is skipped and not edited", async () => {
  const other = "https://github.com/other/thing/issues/9";
  const { outcome, rec } = await runSplit({
    subIssueUrls: [SUB_1, other],
    issues: { 101: { body: "" } },
  });
  assert(outcome.split);
  assert(
    outcome.notes.some((n) =>
      n.includes(other) && n.includes("another repository")
    ),
  );
  assert(!rec.edits.some((e) => e.issue === 9));
});

// ---------------------------------------------------------------------------
// (e) branch guard: refused branches have no PR closed and no branch deleted,
// and the split still stands
// ---------------------------------------------------------------------------

const GUARDED: { name: string; base: string; defaultBranch: string }[] = [
  { name: "main", base: "main", defaultBranch: "main" },
  { name: "milestone/x", base: "main", defaultBranch: "main" },
  { name: "Milestone/X", base: "main", defaultBranch: "main" },
  { name: "milestone/x", base: "milestone/x", defaultBranch: "main" },
  { name: "feature/base-x", base: "feature/base-x", defaultBranch: "main" },
  { name: "-oops", base: "main", defaultBranch: "main" },
  { name: "", base: "main", defaultBranch: "main" },
];

for (const g of GUARDED) {
  Deno.test(`repeat gate split: never deletes branch '${g.name}' (base '${g.base}')`, async () => {
    const { outcome, rec } = await runSplit({
      branchName: g.name,
      baseBranch: g.base,
      defaultBranch: g.defaultBranch,
    });
    assert(outcome.split, "the split still stands");
    assert(
      !rec.git.some((a) => a[0] === "push" && a.includes("--delete")),
      "no remote delete was attempted",
    );
    assert(
      outcome.notes.some((n) => n.includes("left the remote branch in place")),
      "a note records the refusal",
    );
  });
}

for (const g of GUARDED) {
  Deno.test(`repeat gate split: leaves the PRs on branch '${g.name}' (base '${g.base}') alone`, async () => {
    const { outcome, rec } = await runSplit({
      branchName: g.name,
      baseBranch: g.base,
      defaultBranch: g.defaultBranch,
      prs: JSON.stringify([{ number: 401, isCrossRepository: false }]),
    });
    assert(outcome.split, "the split still stands");
    assert(
      !rec.gh.some((a) => a[0] === "pr"),
      "no gh pr list and no gh pr close is issued",
    );
    assert(
      outcome.notes.some((n) => n.includes("left the pull requests in place")),
      "a note records the refusal",
    );
  });
}

// ---------------------------------------------------------------------------
// (f) failures in clean-up are notes and warnings, and the rest still runs
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a failed PR close leaves its head PR open, which blocks the branch delete, and the rest still runs", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([{ number: 201 }, { number: 202 }]),
    gh: (args) =>
      args[0] === "pr" && args[1] === "close" && args[2] === "201"
        ? Promise.reject(new Error("GraphQL: pull request is locked"))
        : undefined,
  });
  assert(outcome.split, "a failed clean-up does not flip the result");
  assert(
    rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === "202"),
    "PR #202 is still closed",
  );
  assert(
    !rec.git.some((a) => a[0] === "push"),
    "no remote delete while PR #201 is still open on the branch",
  );
  assert(
    outcome.notes.some((n) =>
      n.includes("left the remote branch in place: open PR #201")
    ),
  );
  assert(
    outcome.notes.some((n) => n.includes("could not close pull request #201")),
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
});

Deno.test("repeat gate split: a failed remote delete is a note and a warning", async () => {
  const { outcome, rec } = await runSplit({
    git: (args) =>
      args[0] === "push"
        ? Promise.resolve(okGit("", 1, "fatal: unable to access 'remote'\n"))
        : defaultGit(args),
  });
  assert(outcome.split);
  assert(
    outcome.notes.some((n) =>
      n ===
        `could not delete remote branch ${BRANCH}: fatal: unable to access 'remote'`
    ),
  );
  assert(
    rec.warns.some((w) => w.includes("could not delete remote branch")),
  );
});

Deno.test("repeat gate split: a remote ref that is already gone counts as deleted", async () => {
  const { outcome, rec } = await runSplit({
    git: (args) =>
      args[0] === "push"
        ? Promise.resolve(
          okGit(
            "",
            1,
            `error: unable to delete '${BRANCH}': remote ref does not exist\n`,
          ),
        )
        : defaultGit(args),
  });
  assert(outcome.split);
  assert(
    outcome.notes.some((n) =>
      n === `remote branch ${BRANCH} was already deleted`
    ),
  );
  assert(!rec.warns.some((w) => w.includes("could not delete remote branch")));
});

Deno.test("repeat gate split: a PR list that is not an array fails its step with a note and a warning, and the split proceeds", async () => {
  const { outcome, rec } = await runSplit({
    gh: (args) =>
      args[0] === "pr" && args[1] === "list" && !args.includes("--jq")
        ? Promise.resolve("{}")
        : undefined,
  });
  assert(outcome.split, "the split proceeds");
  assert(
    outcome.notes.some((n) =>
      n ===
        "closing the run's pull requests failed: gh pr list did not return an array"
    ),
  );
  assert(
    rec.warns.some((w) => w.includes("gh pr list did not return an array")),
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
});

Deno.test("repeat gate split: a PR row without a number fails its step with a note and a warning", async () => {
  const { outcome, rec } = await runSplit({
    gh: (args) =>
      args[0] === "pr" && args[1] === "list" && !args.includes("--jq")
        ? Promise.resolve('[{"isCrossRepository":false}]')
        : undefined,
  });
  assert(outcome.split);
  assert(
    outcome.notes.some((n) =>
      n ===
        "closing the run's pull requests failed: gh pr list returned a row without a PR number"
    ),
  );
  assertEquals(
    mutations(rec).filter((m) => m.startsWith("gh ")),
    [],
    "no PR is closed on a list that cannot be trusted",
  );
});

// ---------------------------------------------------------------------------
// (g) parent closure: a split stands only when the parent is confirmed closed
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a parent that cannot be closed refuses the split, keeps failed-once, and says what was published", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([{ number: 201 }]),
    gh: (args) =>
      args[0] === "issue" && args[1] === "close"
        ? Promise.reject(new Error("GraphQL: not permitted"))
        : undefined,
  });
  assertEquals(outcome.split, false);
  assertEquals(
    outcome.split ? "" : outcome.reason,
    `2 sub-issue(s) were published (${SUB_1}, ${SUB_2}) but parent #${PARENT} could not be closed: GraphQL: not permitted`,
  );
  assertEquals(rec.labelsRemoved, [], "failed-once is kept");
  assert(
    rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === "201"),
    "the clean-up that did not depend on the parent still ran",
  );
  assert(rec.warns.some((w) => w.includes("could not close parent")));
});

Deno.test("repeat gate split: a close that is accepted but reads back open refuses the split as still open", async () => {
  const { outcome, rec } = await runSplit({
    gh: (args) =>
      args[0] === "issue" && args[1] === "close"
        ? Promise.resolve("")
        : undefined,
  });
  assertEquals(outcome.split, false);
  assertStringIncludes(
    outcome.split ? "" : outcome.reason,
    "still reads as open",
  );
  assertEquals(rec.labelsRemoved, [], "failed-once is kept");
});

// ---------------------------------------------------------------------------
// (h) shallow or no-merge-base history is reported, never as an empty branch
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a shallow clone where log succeeds and diff fails with no merge base reports the summary unavailable", async () => {
  const { outcome, rec } = await runSplit({
    branchName: "issue-1-x",
    git: (args) =>
      args[0] === "diff" && args[1] === "--stat"
        ? Promise.resolve(
          okGit(
            "",
            128,
            "fatal: origin/main...issue-1-x: no merge base\n",
          ),
        )
        : defaultGit(args),
  });
  assert(outcome.split, "the split is not refused over the summary");
  const seed = seedOf(rec);
  assertStringIncludes(
    seed,
    "unavailable: fatal: origin/main...issue-1-x: no merge base",
  );
  assert(!seed.includes("Commits on"), "no empty branch is claimed");
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit);
  assertStringIncludes(
    edit.body,
    "unavailable: fatal: origin/main...issue-1-x: no merge base",
  );
});

Deno.test("repeat gate split: a branch in neither the local nor the remote ref is reported unavailable", async () => {
  const { outcome, rec } = await runSplit({
    git: (args) =>
      args[0] === "rev-parse"
        ? Promise.resolve(okGit("", 1))
        : defaultGit(args),
  });
  assert(outcome.split);
  assertStringIncludes(
    seedOf(rec),
    "unavailable: branch not found locally or on origin",
  );
});

Deno.test("repeat gate split: a git call that throws reports the summary unavailable and does not throw", async () => {
  const { outcome, rec } = await runSplit({
    git: (args) =>
      args[0] === "rev-parse"
        ? Promise.reject(new Error("spawn failed"))
        : defaultGit(args),
  });
  assert(outcome.split);
  assertStringIncludes(seedOf(rec), "unavailable: spawn failed");
});

// ---------------------------------------------------------------------------
// (h) only fleet-authored previous-run records count
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a previous-run record from a non-fleet account is ignored", async () => {
  const { outcome, rec } = await runSplit({
    comments: [
      comment(
        FLEET,
        "## Automated Processing Failed (First Attempt)\n\nNo output quoted.",
        1,
      ),
      comment(
        "outsider",
        failureRecord("Repeat Attempt", "OUTSIDER-MARKER"),
        2,
      ),
    ],
  });
  assert(outcome.split);
  const seed = seedOf(rec);
  assert(
    !seed.includes("OUTSIDER-MARKER"),
    "the outsider's output is not used",
  );
  assert(/Previous run's output unavailable/.test(seed));
});

Deno.test("repeat gate split: the latest fleet-authored record wins over an older one and a newer outsider one", async () => {
  const { rec } = await runSplit({
    comments: [
      comment(FLEET, failureRecord("First Attempt", "OLD-FLEET-MARKER"), 1),
      comment(FLEET, failureRecord("Repeat Attempt", "NEW-FLEET-MARKER"), 2),
      comment(
        "outsider",
        failureRecord("Repeat Attempt", "OUTSIDER-MARKER"),
        3,
      ),
    ],
  });
  const seed = seedOf(rec);
  assertStringIncludes(seed, "NEW-FLEET-MARKER");
  assert(!seed.includes("OLD-FLEET-MARKER"));
  assert(!seed.includes("OUTSIDER-MARKER"));
});

// ---------------------------------------------------------------------------
// (i) secrets are redacted in the seed and in the sub-issue bodies
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: secrets in the gate output, previous output and branch are redacted", async () => {
  const ghp = "ghp_" + "A".repeat(36);
  const anthropic = "sk-ant-api03-" + "x".repeat(40);
  const { outcome, rec } = await runSplit({
    gateOutput: `GATE-MARKER token ${ghp} leaked here`,
    comments: [
      comment(
        FLEET,
        failureRecord("First Attempt", `PREV-MARKER key ${anthropic}`),
      ),
    ],
    git: (args) =>
      args[0] === "log"
        ? Promise.resolve(okGit(`abc1234 Add ${ghp}\n`))
        : defaultGit(args),
  });
  assert(outcome.split);
  const seed = seedOf(rec);
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit);
  for (const body of [seed, edit.body]) {
    assert(!body.includes(ghp), "the GitHub token is not written");
    assert(!body.includes(anthropic), "the Anthropic key is not written");
  }
  assertStringIncludes(seed, REDACTION_PLACEHOLDER);
  assertStringIncludes(seed, "GATE-MARKER");
  assertStringIncludes(seed, "PREV-MARKER");
});

// ---------------------------------------------------------------------------
// (j) invariant: the split only ever closes PRs; it never readies, merges or
// arms auto-merge
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a full successful split never readies, merges or arms auto-merge", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([
      { number: 201, isDraft: false },
      { number: 202, isDraft: true },
    ]),
  });
  assert(outcome.split);
  for (const cmd of prCommands(rec)) {
    if (cmd[1] === "list") continue;
    assertEquals(
      cmd[1],
      "close",
      `only pr close mutates a PR, saw: ${cmd.join(" ")}`,
    );
  }
  const everything = [...rec.gh, ...rec.git].flat();
  assert(!everything.includes("ready"), "no pr ready");
  assert(!everything.includes("merge"), "no pr merge");
  assert(!everything.includes("--auto"), "no --auto");
  assert(!everything.includes("--delete-branch"), "no gh --delete-branch");
});

// ---------------------------------------------------------------------------
// (k) logging: each failure warns where it happens; one info line at the end
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a failed PR close warns at the failure, and the hook logs one info line with all the notes", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([{ number: 201 }, { number: 202 }]),
    gh: (args) =>
      args[0] === "pr" && args[1] === "close" && args[2] === "201"
        ? Promise.reject(new Error("GraphQL: locked"))
        : undefined,
  });
  assert(outcome.split);
  assert(
    rec.warns.some((w) =>
      w.includes("could not close pull request #201: GraphQL: locked")
    ),
    "the failed close is warned",
  );
  assertEquals(rec.infos.length, 1, "exactly one info line");
  const context = rec.infoContexts[0] as { notes: string[] };
  assertEquals(context.notes, outcome.split ? outcome.notes : []);
  assert(
    context.notes.some((n) => n === "closed pull request #202"),
  );
});

Deno.test("repeat gate split: a refused branch delete warns, naming the refusal", async () => {
  const { rec } = await runSplit({
    branchName: "milestone/x",
    baseBranch: "main",
  });
  assert(
    rec.warns.some((w) =>
      w.includes("left the remote branch in place: 'milestone/x'")
    ),
  );
  assert(
    rec.warns.some((w) => w.includes("left the pull requests in place")),
  );
});

// ---------------------------------------------------------------------------
// (l) hostile input: the extraction and the marker search finish, linearly,
// on inputs that backtracking would never return on
// ---------------------------------------------------------------------------

/**
 * A hostile-input test must finish well inside this budget. The linear scan
 * takes milliseconds; a quadratic pattern takes seconds on these inputs.
 */
const LINEAR_BUDGET_MS = 1000;

function assertWithinBudget(startedAt: number): void {
  const elapsed = performance.now() - startedAt;
  assert(
    elapsed < LINEAR_BUDGET_MS,
    `finished in ${
      Math.round(elapsed)
    }ms, over the ${LINEAR_BUDGET_MS}ms linear budget`,
  );
}

Deno.test("repeat gate split: 50 000 unclosed <details><summary> openers do not hang extraction", async () => {
  const started = performance.now();
  const { outcome, rec } = await runSplit({
    comments: [
      comment(
        FLEET,
        recordWithRawBody("<details><summary>".repeat(50_000)),
      ),
    ],
  });
  assert(outcome.split);
  assertStringIncludes(seedOf(rec), "key error line");
  assertWithinBudget(started);
});

Deno.test("repeat gate split: 50 000 </summary> closers with no <details> do not hang extraction", async () => {
  const started = performance.now();
  const { outcome, rec } = await runSplit({
    comments: [
      comment(FLEET, recordWithRawBody("</summary>".repeat(50_000))),
    ],
  });
  assert(outcome.split);
  assertStringIncludes(seedOf(rec), "key error line");
  assertWithinBudget(started);
});

Deno.test("repeat gate split: a long Part of # digit run with no match is appended, not hung on", async () => {
  const started = performance.now();
  const body = "Part of #" + "1".repeat(50_000) + "x";
  const { rec } = await runSplit({
    issues: { 101: { body } },
    subIssueUrls: [SUB_1],
  });
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit);
  assert(
    edit.body.split("\n").includes(`Part of #${PARENT}`),
    "the parent's Part of line is appended",
  );
  assertWithinBudget(started);
});

Deno.test("repeat gate split: 50 000 '## Failing gate output' lines are scanned without a hang", async () => {
  const started = performance.now();
  const body = Array.from({ length: 50_000 }, () => "## Failing gate output ")
    .join("\n");
  const { rec } = await runSplit({
    issues: { 101: { body } },
    subIssueUrls: [SUB_1],
  });
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit);
  assert(
    edit.body.startsWith(body.trimEnd()),
    "the planner's body is kept as it was, trailing blanks aside",
  );
  assertStringIncludes(edit.body, "## What the branch got done");
  assertWithinBudget(started);
});
