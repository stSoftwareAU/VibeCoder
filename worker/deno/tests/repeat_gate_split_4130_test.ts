/**
 * The repeat-gate split hook (Issue #4130): a repeat worker-gate failure splits
 * the parent into sub-issues instead of being recorded again.
 *
 * Every GitHub and git call is recorded, so each test can say what the hook
 * did and, as importantly, what it did not do. The planning round is replaced
 * by the `planHeldIssue` seam.
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
const ALL_CATEGORIES: FailureCategory[] = [
  "summary_incomplete",
  "quality_check",
  "pre_push_gate",
  "security_fix_gate",
];

type GitResponder = (
  args: string[],
) => Promise<Result<GitCommandOutput>>;

/** What a scenario can change. Anything left out takes the default. */
interface Scenario {
  category?: FailureCategory;
  gateOutput?: string;
  comments?: GitHubComment[];
  issueComments?: string;
  issues?: Record<number, { body: string; labels?: string[] }>;
  planned?: Result<PlanningResult> | "throw";
  subIssueUrls?: string[];
  uncoveredAsks?: string[];
  prs?: string;
  parentState?: "OPEN" | "CLOSED";
  branchName?: string;
  baseBranch?: string;
  defaultBranch?: string;
  git?: GitResponder;
  /** Overrides a `gh` call; return `undefined` to take the default answer. */
  gh?: (args: string[]) => Promise<string> | undefined;
  createClientThrows?: boolean;
}

interface Recording {
  gh: string[][];
  git: string[][];
  edits: { issue: number; body: string }[];
  labelsAdded: { issue: number; label: string }[];
  labelsRemoved: { issue: number; label: string }[];
  planningContexts: IssueContext[];
}

interface Run {
  outcome: RepeatGateSplitOutcome;
  rec: Recording;
}

function okGit(stdout = "", code = 0, stderr = ""): Result<GitCommandOutput> {
  return { ok: true, value: { code, stdout, stderr } };
}

/** A shallow-free branch: ref resolves, log, stat and names all answer. */
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

function defaultGh(s: Scenario, args: string[]): string {
  if (args[0] === "pr" && args[1] === "list") return s.prs ?? "[]";
  if (args[0] === "issue" && args[1] === "view" && args.includes("state")) {
    return JSON.stringify({ state: s.parentState ?? "OPEN" });
  }
  return "";
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

async function runSplit(s: Scenario = {}): Promise<Run> {
  const rec: Recording = {
    gh: [],
    git: [],
    edits: [],
    labelsAdded: [],
    labelsRemoved: [],
    planningContexts: [],
  };
  const issues = s.issues ?? { 101: { body: "" }, 102: { body: "" } };
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
    getIssueComments: () => Promise.resolve(s.comments ?? []),
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

  const deps = createMockDeps({
    github: {
      createClient: () => {
        if (s.createClientThrows) throw new Error("no GitHub client");
        return client;
      },
      runGhCommand: (args: string[]) => {
        rec.gh.push(args);
        return s.gh?.(args) ?? Promise.resolve(defaultGh(s, args));
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
    issueNumber: PARENT,
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

Deno.test("repeat gate split: says the previous run's output is unavailable when none is recorded", async () => {
  const { outcome, rec } = await runSplit({ comments: [] });
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
        "pr list --repo org/repo --head issue-4130-run-2 --state open --json number,isDraft,isCrossRepository"
    ),
    "lists open PRs on the run branch",
  );
  for (const number of ["201", "202"]) {
    assert(
      rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === number),
      `closes PR #${number}`,
    );
  }
  assert(
    rec.git.some((a) =>
      a.join(" ") ===
        `push --delete --end-of-options origin ${BRANCH}`
    ),
    "deletes the remote branch",
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
  assert(
    rec.gh.some((a) =>
      a[0] === "issue" && a[1] === "close" && a[2] === String(PARENT)
    ),
    "closes the parent that planning left open",
  );
});

Deno.test("repeat gate split: a cross-repository PR with the same head name is NOT closed, a same-repo one is", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([
      { number: 301, isDraft: false, isCrossRepository: true },
      { number: 302, isDraft: false, isCrossRepository: false },
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

Deno.test("repeat gate split: the parent left open by an uncovered ask stays open", async () => {
  const { outcome, rec } = await runSplit({ uncoveredAsks: ["the migration"] });
  assert(outcome.split);
  assert(
    !rec.gh.some((a) => a[0] === "issue" && a[1] === "close"),
    "no close for the parent",
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
});

// ---------------------------------------------------------------------------
// (d) no sub-issues or a failed planning round: refused, nothing cleaned up
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: zero published sub-issues refuses and cleans up nothing", async () => {
  const { outcome, rec } = await runSplit({
    subIssueUrls: [],
    prs: JSON.stringify([{ number: 201, isDraft: false }]),
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
    prs: JSON.stringify([{ number: 201, isDraft: false }]),
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
    prs: JSON.stringify([{ number: 201, isDraft: false }]),
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
// (e) branch guard: the base, the default and milestone branches are never
// deleted, and the split still stands
// ---------------------------------------------------------------------------

const GUARDED: { name: string; base: string; defaultBranch: string }[] = [
  { name: "main", base: "main", defaultBranch: "main" },
  { name: "milestone/x", base: "main", defaultBranch: "main" },
  { name: "milestone/x", base: "milestone/x", defaultBranch: "main" },
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
      prs: JSON.stringify([{
        number: 401,
        isDraft: false,
        isCrossRepository: false,
      }]),
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
// (f) a failing PR close or branch delete does not stop the rest
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a failing PR close and a failing branch delete do not stop the rest", async () => {
  const { outcome, rec } = await runSplit({
    prs: JSON.stringify([
      { number: 201, isDraft: false },
      { number: 202, isDraft: false },
    ]),
    gh: (args) =>
      args[0] === "pr" && args[1] === "close" && args[2] === "201"
        ? Promise.reject(new Error("GraphQL: pull request is locked"))
        : undefined,
    git: (args) =>
      args[0] === "push"
        ? Promise.resolve({
          ok: false,
          error: new Error("network down"),
        })
        : defaultGit(args),
  });
  assert(outcome.split, "a failed clean-up does not flip the result");
  assert(
    rec.gh.some((a) => a[0] === "pr" && a[1] === "close" && a[2] === "202"),
    "PR #202 is still closed",
  );
  assertEquals(rec.labelsRemoved, [{ issue: PARENT, label: "failed-once" }]);
  assert(
    outcome.notes.some((n) => n.includes("could not close pull request #201")),
  );
  assert(
    outcome.notes.some((n) => n.includes("could not delete remote branch")),
  );
});

// ---------------------------------------------------------------------------
// (g) shallow or no-merge-base history is reported, never as an empty branch
// ---------------------------------------------------------------------------

Deno.test("repeat gate split: a shallow clone with no merge base says the summary is unavailable", async () => {
  const { outcome, rec } = await runSplit({
    git: (args) =>
      args[0] === "log"
        ? Promise.resolve(
          okGit("", 128, "fatal: no merge base\nsecond line of stderr\n"),
        )
        : defaultGit(args),
  });
  assert(outcome.split, "the split is not refused over the summary");
  const seed = seedOf(rec);
  assertStringIncludes(seed, "unavailable: fatal: no merge base");
  assert(!seed.includes("Commits on"), "no empty branch is claimed");
  const edit = rec.edits.find((e) => e.issue === 101);
  assert(edit);
  assertStringIncludes(edit.body, "unavailable: fatal: no merge base");
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
      comment("outsider", failureRecord("First Attempt", "OUTSIDER-MARKER")),
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
