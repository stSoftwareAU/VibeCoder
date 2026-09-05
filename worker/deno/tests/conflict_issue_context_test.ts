/**
 * Tests for conflict_issue_context.ts — resolving the originating issues of
 * both sides of a conflicting PR (Issue #1113, parent #1076).
 *
 * The properties under test are the ones the downstream intent-aware resolver
 * depends on: the precedence order of the PR-side signals, the branch-shape
 * trap (`issue-1160-…` must never resolve to issue 116), absence reported
 * explicitly rather than as an empty list, and every bound both enforced and
 * declared.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS,
  gatherConflictIssueContext,
  prNumberFromCommitSubject,
} from "../lib/conflict_issue_context.ts";
import type { GitRunner } from "../lib/git_base_ref.ts";
import type { Result } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";

/** A commit as the fake base-branch history reports it. */
interface FakeCommit {
  sha: string;
  subject: string;
  /** Paths this commit touched. */
  paths: string[];
}

/** A PR as the fake `gh` knows it. */
interface FakePr {
  title?: string;
  body?: string;
  closingIssues?: number[];
}

/** An issue as the fake `gh` knows it. */
interface FakeIssue {
  title: string;
  state: string;
  body: string;
}

interface FakeWorld {
  /** Base-branch commits, newest first. */
  commits?: FakeCommit[];
  prs?: Record<number, FakePr>;
  issues?: Record<number, FakeIssue>;
  /** Refs `git rev-parse --verify` resolves; defaults to every ref asked for. */
  unresolvableRefs?: string[];
  /** When true, `git merge-base` fails. */
  mergeBaseFails?: boolean;
  /** gh argument fragments that make the call throw. */
  ghFailsFor?: string[];
}

/** Build a git runner over the fake world. */
function makeGit(world: FakeWorld): GitRunner {
  const unresolvable = new Set(world.unresolvableRefs ?? []);
  return (
    args: string[],
  ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
    const ok = (stdout: string) =>
      Promise.resolve(
        { ok: true as const, value: { code: 0, stdout, stderr: "" } },
      );
    const fail = (stderr = "boom") =>
      Promise.resolve(
        { ok: true as const, value: { code: 1, stdout: "", stderr } },
      );

    if (args[0] === "rev-parse") {
      const ref = (args.find((a) => a.endsWith("^{commit}")) ?? "").replace(
        "^{commit}",
        "",
      );
      return unresolvable.has(ref) ? fail() : ok("a".repeat(40));
    }
    if (args[0] === "fetch") return ok("");
    if (args[0] === "merge-base") {
      return world.mergeBaseFails ? fail("no merge base") : ok("b".repeat(40));
    }
    if (args[0] === "log") {
      const maxCount = Number(
        (args.find((a) => a.startsWith("--max-count=")) ?? "--max-count=0")
          .slice("--max-count=".length),
      );
      const sepIndex = args.indexOf("--");
      const path = sepIndex >= 0 ? args[sepIndex + 1] : undefined;
      const matching = (world.commits ?? []).filter((c) =>
        path === undefined || c.paths.includes(path)
      );
      const lines = matching
        .slice(0, maxCount)
        .map((c) => `${c.sha}\x1f${c.subject}`);
      return ok(lines.join("\n"));
    }
    return fail(`unexpected git command: ${args.join(" ")}`);
  };
}

/** Build a gh runner over the fake world, recording every call. */
function makeGh(
  world: FakeWorld,
  calls: string[][] = [],
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const fragment of world.ghFailsFor ?? []) {
      if (joined.includes(fragment)) {
        return Promise.reject(new Error(`gh failed: ${fragment}`));
      }
    }

    if (args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      const pr = world.prs?.[number];
      if (!pr) return Promise.reject(new Error(`no such PR #${number}`));
      return Promise.resolve(JSON.stringify({
        number,
        title: pr.title ?? `PR ${number}`,
        body: pr.body ?? "",
        closingIssuesReferences: (pr.closingIssues ?? []).map((n) => ({
          number: n,
        })),
      }));
    }

    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const issue = world.issues?.[number];
      if (!issue) return Promise.reject(new Error(`no such issue #${number}`));
      return Promise.resolve(JSON.stringify({
        number,
        title: issue.title,
        state: issue.state,
        body: issue.body,
      }));
    }

    return Promise.reject(new Error(`unexpected gh command: ${joined}`));
  };
}

/** Standard request over the fake world. */
function request(overrides: Partial<{
  prNumber: number;
  prBranch: string;
  baseBranch: string;
  conflictedPaths: string[];
  prBody: string;
}> = {}) {
  return {
    repo: REPO,
    prNumber: overrides.prNumber ?? 5,
    prBranch: overrides.prBranch ?? "issue-116-do-the-thing",
    baseBranch: overrides.baseBranch ?? "main",
    conflictedPaths: overrides.conflictedPaths ?? [],
    ...(overrides.prBody === undefined ? {} : { prBody: overrides.prBody }),
  };
}

function issue(body = "why this change matters"): FakeIssue {
  return { title: "An issue", state: "OPEN", body };
}

// ---------------------------------------------------------------------------
// PR-side precedence
// ---------------------------------------------------------------------------

Deno.test("conflict issue context - branch shape names the PR-side issue", async () => {
  const world: FakeWorld = { issues: { 116: issue() } };
  const calls: string[][] = [];
  const context = await gatherConflictIssueContext(
    request({ prBranch: "issue-116-foo" }),
    { git: makeGit(world), gh: makeGh(world, calls) },
  );

  assert(context.prSide.resolved);
  assertEquals(context.prSide.signal, "branch");
  assertEquals(context.prSide.issue.number, 116);
  assertEquals(context.prSide.issue.title, "An issue");
  assertEquals(context.prSide.issue.state, "OPEN");
  // The branch shape is free: no PR view was needed to find the number.
  assertEquals(calls.filter((c) => c[0] === "pr").length, 0);
});

Deno.test("conflict issue context - PR body closing keyword names the issue", async () => {
  const world: FakeWorld = {
    prs: { 5: { body: "Some work.\n\nCloses #42" } },
    issues: { 42: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "hotfix/no-number" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assert(context.prSide.resolved);
  assertEquals(context.prSide.signal, "body");
  assertEquals(context.prSide.issue.number, 42);
});

Deno.test("conflict issue context - GitHub linkage is the last PR-side signal", async () => {
  const world: FakeWorld = {
    prs: { 5: { body: "No keywords here", closingIssues: [7] } },
    issues: { 7: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "hotfix/no-number" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assert(context.prSide.resolved);
  assertEquals(context.prSide.signal, "linkage");
  assertEquals(context.prSide.issue.number, 7);
});

Deno.test("conflict issue context - branch shape wins over a contradicting body", async () => {
  const world: FakeWorld = {
    prs: { 5: { body: "Closes #42", closingIssues: [7] } },
    issues: { 116: issue(), 42: issue(), 7: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "issue-116-foo" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assert(context.prSide.resolved);
  assertEquals(context.prSide.signal, "branch");
  assertEquals(context.prSide.issue.number, 116);
});

Deno.test("conflict issue context - issue-1160 does not resolve to issue 116", async () => {
  const world: FakeWorld = { issues: { 1160: issue(), 116: issue() } };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "issue-1160-something-else" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assert(context.prSide.resolved);
  assertEquals(context.prSide.issue.number, 1160);
});

Deno.test("conflict issue context - a namespaced branch carries no issue number", async () => {
  const world: FakeWorld = {
    prs: { 5: { body: "no keywords" } },
    issues: { 220: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "wip/issue-220-nested" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assert(!context.prSide.resolved);
  assertEquals(context.prSide.reason, "no-signal");
});

// ---------------------------------------------------------------------------
// Explicit absence
// ---------------------------------------------------------------------------

Deno.test("conflict issue context - no discoverable PR issue is stated, not empty", async () => {
  const world: FakeWorld = { prs: { 5: { body: "nothing to see" } } };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/tidy" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.prSide, { resolved: false, reason: "no-signal" });
});

Deno.test("conflict issue context - an unreadable PR-side issue is not silence", async () => {
  const world: FakeWorld = { issues: {}, ghFailsFor: ["issue view 116"] };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "issue-116-foo" }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assert(!context.prSide.resolved);
  assertEquals(context.prSide.reason, "lookup-failed");
  assertEquals(context.warnings.length, 1);
  assertStringIncludes(context.warnings[0]!, "116");
});

// ---------------------------------------------------------------------------
// Base side
// ---------------------------------------------------------------------------

Deno.test("conflict issue context - a base merge commit resolves to its issue", async () => {
  const world: FakeWorld = {
    commits: [{
      sha: "c".repeat(40),
      subject: "Merge pull request #99 from stSoftwareAU/issue-77-rename",
      paths: ["lib/config.ts"],
    }],
    prs: { 5: { body: "" }, 99: { closingIssues: [77] } },
    issues: { 116: issue(), 77: issue("supersedes the constant") },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "issue-116-foo", conflictedPaths: ["lib/config.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide.length, 1);
  const entry = context.baseSide[0]!;
  assertEquals(entry.path, "lib/config.ts");
  assertEquals(entry.prNumbers, [99]);
  assertEquals(entry.issues.map((i) => i.number), [77]);
  assertEquals(entry.issues[0]!.body, "supersedes the constant");
  assertEquals(entry.unresolved, null);
});

Deno.test("conflict issue context - a squash-merge subject resolves to its issue", async () => {
  const world: FakeWorld = {
    commits: [{
      sha: "d".repeat(40),
      subject: "Rename the constant (#99)",
      paths: ["lib/config.ts"],
    }],
    prs: {
      5: { body: "" },
      // No closing references recorded — the body keywords are the fallback.
      99: { title: "Rename the constant (#77)", body: "Work done. Closes #77" },
    },
    issues: { 77: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/config.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide[0]!.issues.map((i) => i.number), [77]);
});

Deno.test("conflict issue context - a base PR title is never read as an issue", async () => {
  const world: FakeWorld = {
    commits: [{
      sha: "a".repeat(40),
      subject: "Merge pull request #99 from someone/tidy",
      paths: ["lib/config.ts"],
    }],
    // A trailing `(#204)` in a PR title is a PR cross-reference as often as an
    // issue number — a confidently wrong origin is worse than none.
    prs: { 5: { body: "" }, 99: { title: "Fix the thing (#204)", body: "" } },
    issues: { 204: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/config.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide[0]!.issues, []);
  assertEquals(context.baseSide[0]!.unresolved, "no-issue");
});

Deno.test("conflict issue context - a partly-resolved path says it is partial", async () => {
  const world: FakeWorld = {
    commits: [{
      sha: "b".repeat(40),
      subject: "Merge pull request #99 from x/y",
      paths: ["lib/config.ts"],
    }],
    prs: { 5: { body: "" }, 99: { closingIssues: [77, 78] } },
    issues: { 77: issue() },
    // Issue 78 cannot be read: one of the two intents is missing.
    ghFailsFor: ["issue view 78"],
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/config.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  const entry = context.baseSide[0]!;
  assertEquals(entry.issues.map((i) => i.number), [77]);
  assertEquals(entry.unresolved, null);
  assert(entry.partial, "a short issue list must not read as a whole one");
});

Deno.test("conflict issue context - base commits with no PR yield an unresolved entry", async () => {
  const world: FakeWorld = {
    commits: [{
      sha: "e".repeat(40),
      subject: "Direct push, no PR reference",
      paths: ["lib/config.ts"],
    }],
    prs: { 5: { body: "" } },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/config.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide.length, 1);
  assertEquals(context.baseSide[0]!.unresolved, "no-pr");
  assertEquals(context.baseSide[0]!.commitsInspected, 1);
  assertEquals(context.baseSide[0]!.issues, []);
});

Deno.test("conflict issue context - a path with no base commits says so", async () => {
  const world: FakeWorld = { commits: [], prs: { 5: { body: "" } } };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/untouched.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide[0]!.unresolved, "no-commits");
});

Deno.test("conflict issue context - a base PR with no issue says so", async () => {
  const world: FakeWorld = {
    commits: [{
      sha: "f".repeat(40),
      subject: "Merge pull request #99 from someone/tidy",
      paths: ["lib/config.ts"],
    }],
    prs: { 5: { body: "" }, 99: { title: "Tidy up" } },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/config.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide[0]!.prNumbers, [99]);
  assertEquals(context.baseSide[0]!.unresolved, "no-issue");
});

Deno.test("conflict issue context - an unusable merge base is reported per path", async () => {
  const world: FakeWorld = {
    mergeBaseFails: true,
    prs: { 5: { body: "" } },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["a.ts", "b.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(
    context.baseSide.map((e) => e.unresolved),
    ["merge-base-unavailable", "merge-base-unavailable"],
  );
  assert(context.warnings.some((w) => w.includes("merge base")));
});

Deno.test("conflict issue context - an unresolvable base branch is reported per path", async () => {
  const world: FakeWorld = {
    unresolvableRefs: ["main", "origin/main"],
    prs: { 5: { body: "" } },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["a.ts"] }),
    { git: makeGit(world), gh: makeGh(world) },
  );

  assertEquals(context.baseSide[0]!.unresolved, "merge-base-unavailable");
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

Deno.test("conflict issue context - the per-path commit cap truncates and says so", async () => {
  const commits: FakeCommit[] = Array.from({ length: 12 }, (_, i) => ({
    sha: String(i).padStart(40, "0"),
    subject: `Direct commit ${i}`,
    paths: ["lib/config.ts"],
  }));
  const world: FakeWorld = { commits, prs: { 5: { body: "" } } };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["lib/config.ts"] }),
    {
      git: makeGit(world),
      gh: makeGh(world),
      bounds: { maxCommitsPerPath: 3 },
    },
  );

  assertEquals(context.baseSide[0]!.commitsInspected, 3);
  assertEquals(context.truncation.commitCapPaths, ["lib/config.ts"]);
});

Deno.test("conflict issue context - the total issue cap truncates and says so", async () => {
  const commits: FakeCommit[] = [1, 2, 3].map((n) => ({
    sha: String(n).padStart(40, "0"),
    subject: `Merge pull request #${900 + n} from x/y`,
    paths: [`lib/f${n}.ts`],
  }));
  const world: FakeWorld = {
    commits,
    prs: {
      5: { body: "" },
      901: { closingIssues: [11] },
      902: { closingIssues: [12] },
      903: { closingIssues: [13] },
    },
    issues: { 11: issue(), 12: issue(), 13: issue() },
  };
  const context = await gatherConflictIssueContext(
    request({
      prBranch: "chore/x",
      conflictedPaths: ["lib/f1.ts", "lib/f2.ts", "lib/f3.ts"],
    }),
    { git: makeGit(world), gh: makeGh(world), bounds: { maxIssues: 2 } },
  );

  const returned = context.baseSide.flatMap((e) => e.issues);
  assertEquals(returned.length, 2);
  assert(context.truncation.issueCapHit);
  assertEquals(context.baseSide[2]!.unresolved, "budget-exhausted");
});

Deno.test("conflict issue context - the issue text budget truncates and says so", async () => {
  const world: FakeWorld = {
    issues: { 116: { title: "Long", state: "OPEN", body: "x".repeat(500) } },
  };
  const context = await gatherConflictIssueContext(
    request({ prBranch: "issue-116-foo" }),
    {
      git: makeGit(world),
      gh: makeGh(world),
      bounds: { maxIssueTextChars: 100 },
    },
  );

  assert(context.prSide.resolved);
  assertEquals(context.prSide.issue.body.length, 100);
  assert(context.prSide.issue.bodyTruncated);
  assertEquals(context.truncation.textTruncatedIssues, [116]);
});

Deno.test("conflict issue context - the gh call budget stops the walk and says so", async () => {
  const commits: FakeCommit[] = [1, 2, 3].map((n) => ({
    sha: String(n).padStart(40, "0"),
    subject: `Merge pull request #${900 + n} from x/y`,
    paths: [`lib/f${n}.ts`],
  }));
  const world: FakeWorld = {
    commits,
    prs: {
      5: { body: "" },
      901: { closingIssues: [11] },
      902: { closingIssues: [12] },
      903: { closingIssues: [13] },
    },
    issues: { 11: issue(), 12: issue(), 13: issue() },
  };
  const calls: string[][] = [];
  const context = await gatherConflictIssueContext(
    request({
      prBranch: "issue-116-foo",
      conflictedPaths: ["lib/f1.ts", "lib/f2.ts", "lib/f3.ts"],
    }),
    {
      git: makeGit(world),
      gh: makeGh(world, calls),
      bounds: { maxGhCalls: 2 },
    },
  );

  assertEquals(calls.length, 2);
  assertEquals(context.ghCallsUsed, 2);
  assert(context.truncation.ghCallCapHit);
  assert(
    context.baseSide.some((e) => e.unresolved === "budget-exhausted"),
    "a path beyond the gh budget must say it was cut short",
  );
});

Deno.test("conflict issue context - documented bound defaults", () => {
  assertEquals(DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS, {
    maxCommitsPerPath: 20,
    maxIssues: 8,
    maxIssueTextChars: 4000,
    maxGhCalls: 30,
  });
});

// ---------------------------------------------------------------------------
// Reuse and de-duplication
// ---------------------------------------------------------------------------

Deno.test("conflict issue context - one issue touched by two paths is fetched once", async () => {
  const world: FakeWorld = {
    commits: [
      {
        sha: "1".repeat(40),
        subject: "Merge pull request #99 from x/y",
        paths: ["a.ts", "b.ts"],
      },
    ],
    prs: { 5: { body: "" }, 99: { closingIssues: [77] } },
    issues: { 77: issue() },
  };
  const calls: string[][] = [];
  const context = await gatherConflictIssueContext(
    request({ prBranch: "chore/x", conflictedPaths: ["a.ts", "b.ts"] }),
    { git: makeGit(world), gh: makeGh(world, calls) },
  );

  const issueViews = calls.filter((c) => c[0] === "issue" && c[2] === "77");
  assertEquals(issueViews.length, 1);
  // The PR behind both paths is viewed once too — the gh budget is not spent
  // re-reading the same base PR per conflicted path.
  assertEquals(calls.filter((c) => c[0] === "pr" && c[2] === "99").length, 1);
  assertEquals(context.baseSide.map((e) => e.issues[0]?.number), [77, 77]);
});

// ---------------------------------------------------------------------------
// Commit subject parsing
// ---------------------------------------------------------------------------

Deno.test("prNumberFromCommitSubject - merge, squash and neither", () => {
  assertEquals(
    prNumberFromCommitSubject("Merge pull request #99 from a/b"),
    99,
  );
  assertEquals(prNumberFromCommitSubject("Do the thing (#1234)"), 1234);
  assertEquals(prNumberFromCommitSubject("Fix issue #99 in the parser"), null);
  assertEquals(prNumberFromCommitSubject("Plain subject"), null);
  assertEquals(
    prNumberFromCommitSubject("Merge pull request #0 from a/b"),
    null,
  );
});
