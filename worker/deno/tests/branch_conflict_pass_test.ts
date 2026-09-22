/**
 * Tests for lib/branch_conflict_pass.ts — the one in-run agent rebase-and-fix
 * pass that runs when the pre-PR rebase declines (Issue #2459).
 *
 * Every test drives the real functions through fake seams — a fake agent, a
 * fake git runner and a fake comment poster. Nothing inspects source text, and
 * nothing sleeps or polls: the deadline is an injected clock.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AgentRebaseRequest,
  type DeclinedRebasePassOptions,
  MIN_REBASE_PASS_RUNWAY_SECONDS,
  postBranchConflictComment,
  runDeclinedRebasePass,
} from "../lib/branch_conflict_pass.ts";
import type { Result } from "../types.ts";

const OK = (
  stdout: string,
): Result<{ code: number; stdout: string; stderr: string }> => ({
  ok: true,
  value: { code: 0, stdout, stderr: "" },
});

/** A git runner that answers from a prefix table and records every call. */
// deno-lint-ignore no-explicit-any
function fakeGit(answers: Record<string, any>, calls: string[][] = []) {
  // deno-lint-ignore no-explicit-any
  const runGit = (args: string[]): Promise<any> => {
    calls.push(args);
    const key = args.join(" ");
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    return Promise.resolve(hit ? hit[1] : OK(""));
  };
  return { runGit, calls };
}

/** The git answers a healthy declined branch gives, before the agent runs. */
function baselineAnswers(behindAfter: string) {
  return {
    "rev-parse": OK("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
    "rev-list": OK(behindAfter),
    "diff --name-only --end-of-options origin/main...feature": OK(
      "lib/a.ts\nlib/b.ts\n",
    ),
    "diff --name-only --end-of-options feature...origin/main": OK(
      "lib/b.ts\ndocs/c.md\n",
    ),
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    branch: "feature",
    baseBranch: "main",
    detail: "'feature' is 2 commit(s) behind 'origin/main': cherry-pick conflict",
    runAgentFn: () => Promise.resolve({ ok: true as const, value: {} }),
    ...overrides,
  };
}

Deno.test("runDeclinedRebasePass - exactly one agent pass, carrying branch, base and deadline", async () => {
  const requests: AgentRebaseRequest[] = [];
  const git = fakeGit(baselineAnswers("0\t3\n"));
  const nowMs = 1_000_000;
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
    deadlineEpochMs: nowMs + 900_000,
    now: () => nowMs,
    runAgentFn: (request: AgentRebaseRequest) => {
      requests.push(request);
      return Promise.resolve({ ok: true as const, value: {} });
    },
  }));

  assertEquals(outcome.kind, "resolved");
  assertEquals(requests.length, 1, "exactly one agent pass, never a retry loop");
  assertEquals(requests[0]?.branch, "feature");
  assertEquals(requests[0]?.baseRef, "origin/main");
  assertEquals(requests[0]?.deadlineEpochMs, nowMs + 900_000);
  assertEquals(requests[0]?.budgetSeconds, 900);
});

Deno.test("runDeclinedRebasePass - a landed rebase resolves the decline, with no comment and no restore", async () => {
  const git = fakeGit(baselineAnswers("0\t3\n"));
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
  }));

  assertEquals(outcome.kind, "resolved");
  // Re-measured, not assumed: `behind === 0` is what makes this a resolution.
  const measured = git.calls.filter((c) => c[0] === "rev-list");
  assertEquals(measured.length, 1);
  assertEquals(
    git.calls.some((c) => c[0] === "reset"),
    false,
    "a resolved pass must never throw away the work it just did",
  );
});

Deno.test("runDeclinedRebasePass - a failed agent restores the pre-attempt tip and hands off", async () => {
  const git = fakeGit(baselineAnswers("2\t3\n"));
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
    runAgentFn: () =>
      Promise.resolve({ ok: false as const, error: new Error("agent died") }),
  }));

  assertEquals(outcome.kind, "handed-off");
  assertEquals(
    git.calls.some((c) =>
      c.join(" ") ===
        "reset --hard --end-of-options aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ),
    true,
    "the branch tip is put back exactly where it was",
  );
  if (outcome.kind !== "handed-off") return;
  assertStringIncludes(outcome.detail, "agent died");
  // Only the paths both sides touched are named.
  assertEquals(outcome.conflictPaths, ["lib/b.ts"]);
  assertStringIncludes(outcome.comment, "lib/b.ts");
  assertStringIncludes(outcome.comment, "conflict ladder");
});

Deno.test("runDeclinedRebasePass - an agent that claims success but leaves the branch behind hands off", async () => {
  // Success is measured, never taken on the agent's word.
  const git = fakeGit(baselineAnswers("2\t3\n"));
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
  }));

  assertEquals(outcome.kind, "handed-off");
  assertEquals(
    git.calls.some((c) => c[0] === "reset" && c[1] === "--hard"),
    true,
  );
});

Deno.test("runDeclinedRebasePass - no runway before the deadline means no agent pass at all", async () => {
  let invoked = 0;
  const git = fakeGit(baselineAnswers("2\t3\n"));
  const nowMs = 2_000_000;
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
    deadlineEpochMs: nowMs + (MIN_REBASE_PASS_RUNWAY_SECONDS - 1) * 1000,
    now: () => nowMs,
    runAgentFn: () => {
      invoked += 1;
      return Promise.resolve({ ok: true as const, value: {} });
    },
  }));

  assertEquals(invoked, 0, "a pass that cannot finish is never started");
  assertEquals(outcome.kind, "handed-off");
  if (outcome.kind !== "handed-off") return;
  assertStringIncludes(outcome.detail, "deadline");
});

Deno.test("runDeclinedRebasePass - an unreadable branch tip hands off without running the agent", async () => {
  // With no tip recorded there is nothing to restore to, so the pass is not
  // started: an unrestorable branch is worse than an extra CI run.
  let invoked = 0;
  const git = fakeGit({
    "rev-parse": { ok: false, error: new Error("bad revision") },
  });
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
    runAgentFn: () => {
      invoked += 1;
      return Promise.resolve({ ok: true as const, value: {} });
    },
  }));

  assertEquals(invoked, 0);
  assertEquals(outcome.kind, "handed-off");
});

Deno.test("runDeclinedRebasePass - unreadable diffs still hand off, naming no paths it cannot prove", async () => {
  const git = fakeGit({
    "rev-parse": OK("abc1234\n"),
    "rev-list": OK("2\t3\n"),
    "diff": { ok: false, error: new Error("bad revision") },
  });
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
    runAgentFn: () =>
      Promise.resolve({ ok: false as const, error: new Error("agent died") }),
  }));

  assertEquals(outcome.kind, "handed-off");
  if (outcome.kind !== "handed-off") return;
  assertEquals(outcome.conflictPaths, []);
  assertStringIncludes(outcome.comment, "conflict ladder");
});

Deno.test("runDeclinedRebasePass - no deadline means no budget, and the pass still runs", async () => {
  const requests: AgentRebaseRequest[] = [];
  const git = fakeGit(baselineAnswers("0\t1\n"));
  const outcome = await runDeclinedRebasePass(baseOptions({
    runGit: git.runGit,
    runAgentFn: (request: AgentRebaseRequest) => {
      requests.push(request);
      return Promise.resolve({ ok: true as const, value: {} });
    },
  }));

  assertEquals(outcome.kind, "resolved");
  assertEquals(requests.length, 1);
  assertEquals(requests[0]?.budgetSeconds, undefined);
  assertEquals(requests[0]?.deadlineEpochMs, undefined);
});

Deno.test("postBranchConflictComment - posts exactly one comment on the raised PR", async () => {
  const posted: Array<[string, number, string]> = [];
  const sent = await postBranchConflictComment({
    repo: "org/repo",
    prNumber: 7,
    comment: "behind its base",
    postComment: (repo: string, prNumber: number, body: string) => {
      posted.push([repo, prNumber, body]);
      return Promise.resolve();
    },
  });

  assertEquals(sent, true);
  assertEquals(posted.length, 1);
  assertEquals(posted[0], ["org/repo", 7, "behind its base"]);
});

Deno.test("postBranchConflictComment - nothing to say, or no PR to say it on, posts nothing", async () => {
  let posts = 0;
  const post = () => {
    posts += 1;
    return Promise.resolve();
  };
  assertEquals(
    await postBranchConflictComment({
      repo: "org/repo",
      prNumber: 7,
      comment: null,
      postComment: post,
    }),
    false,
  );
  assertEquals(
    await postBranchConflictComment({
      repo: "org/repo",
      prNumber: 0,
      comment: "behind its base",
      postComment: post,
    }),
    false,
  );
  assertEquals(posts, 0);
});

Deno.test("postBranchConflictComment - a failed post warns and never throws", async () => {
  const warnings: string[] = [];
  const sent = await postBranchConflictComment({
    repo: "org/repo",
    prNumber: 7,
    comment: "behind its base",
    postComment: () => Promise.reject(new Error("GitHub said no")),
    warn: (m: string) => warnings.push(m),
  });

  assertEquals(sent, false);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "GitHub said no");
});
