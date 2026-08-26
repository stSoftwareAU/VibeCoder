/**
 * Tests for pr_merge_conflict_processor.ts (Issue #84).
 *
 * The processor is the receiver Issue #4373 deferred to: it merges the base
 * branch into a conflicting PR for real, refuses to push a tree that is not
 * fully resolved, bounds its attempts, and escalates with `needs-human` when
 * the budget is spent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildConflictEscalationReason,
  type MergeConflictInput,
  type MergeConflictProcessorDeps,
  parseUnmergedPaths,
  processMergeConflict,
} from "../lib/pr_merge_conflict_processor.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  MERGE_CONFLICT_LABEL,
} from "../lib/pr_merge_conflict_scan.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface Captured {
  /** `gh`/`git` events in the order they happened. */
  events: string[];
  comments: string[];
  labelsAdded: string[];
  labelsRemoved: string[];
  gitArgs: string[][];
  commitAndPushCalls: number;
  agentRuns: number;
  /** Lock-comment refreshes (Issue #395). */
  lockRenewals: number[];
}

interface GitScript {
  /** Exit code for `git merge origin/<base>`. */
  mergeCode: number;
  /** Unmerged paths reported after the merge (empty = clean). */
  unmergedAfterMerge: string[];
  /** Unmerged paths reported after the agent has run. */
  unmergedAfterAgent: string[];
  /** Whether `git grep` finds leftover conflict markers after the agent. */
  markersAfterAgent: boolean;
  /** Exit code for `git merge-base --is-ancestor`. */
  ancestorCode: number;
}

function makeGitScript(overrides?: Partial<GitScript>): GitScript {
  return {
    mergeCode: 1,
    unmergedAfterMerge: ["SECURITY.md"],
    unmergedAfterAgent: [],
    markersAfterAgent: false,
    ancestorCode: 0,
    ...overrides,
  };
}

function makeGit(
  script: GitScript,
  captured: Captured,
): Partial<GitDeps> {
  let unmergedQueries = 0;
  let mergeDone = false;

  return {
    runGitCommand: ((args: string[]) => {
      captured.gitArgs.push(args);
      captured.events.push(`git:${args.slice(0, 2).join(" ")}`);

      if (args[0] === "merge" && args[1]?.startsWith("origin/")) {
        mergeDone = true;
        return Promise.resolve({
          ok: true,
          value: {
            code: script.mergeCode,
            stdout: "",
            stderr: script.mergeCode === 0 ? "" : "CONFLICT (content)",
          },
        });
      }

      if (args[0] === "diff" && args.includes("--diff-filter=U")) {
        const paths = unmergedQueries === 0
          ? script.unmergedAfterMerge
          : script.unmergedAfterAgent;
        unmergedQueries++;
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: paths.join("\n"), stderr: "" },
        });
      }

      if (args[0] === "grep") {
        return Promise.resolve({
          ok: true,
          value: script.markersAfterAgent
            ? { code: 0, stdout: "SECURITY.md\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
        });
      }

      if (args[0] === "merge-base") {
        return Promise.resolve({
          ok: true,
          value: {
            code: mergeDone ? script.ancestorCode : 1,
            stdout: "",
            stderr: "",
          },
        });
      }

      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    }) as unknown as GitDeps["runGitCommand"],

    commitAndPushPending: ((..._args: unknown[]) => {
      captured.commitAndPushCalls++;
      captured.events.push("git:commitAndPushPending");
      return Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: true,
          commitsPushed: 1,
          finalUnpushedCount: 0,
        },
      });
    }) as unknown as GitDeps["commitAndPushPending"],
  };
}

function makeGithub(captured: Captured): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0) {
          captured.comments.push(String(args[idx + 1] ?? ""));
          captured.events.push("gh:comment");
        }
      }
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        const verb = args[xIdx + 1];
        const endpoint = String(args[xIdx + 2] ?? "");
        if (verb === "POST" && endpoint.includes("/labels")) {
          const fIdx = args.indexOf("-f");
          const flag = String(args[fIdx + 1] ?? "");
          if (flag.startsWith("labels[]=")) {
            captured.labelsAdded.push(flag.slice("labels[]=".length));
            captured.events.push("gh:label-add");
          }
        }
        if (verb === "POST" && endpoint.includes("/comments")) {
          for (let i = 0; i < args.length - 1; i++) {
            if (args[i] === "-f" && String(args[i + 1]).startsWith("body=")) {
              captured.comments.push(String(args[i + 1]).slice("body=".length));
              captured.events.push("gh:comment");
            }
          }
        }
        if (verb === "PATCH" && endpoint.includes("/issues/comments/")) {
          captured.lockRenewals.push(
            Number(endpoint.split("/issues/comments/")[1] ?? 0),
          );
          captured.events.push("gh:lock-renew");
        }
        if (verb === "DELETE" && endpoint.includes("/labels/")) {
          captured.labelsRemoved.push(endpoint.split("/labels/")[1] ?? "");
          captured.events.push("gh:label-remove");
        }
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function makeClaude(captured: Captured, delayMs = 0): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry: (async () => {
      captured.agentRuns++;
      captured.events.push("agent:run");
      // A real resolution runs for minutes; a few milliseconds is enough for
      // a test to observe what happens *while* it runs (Issue #395).
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        ok: true,
        value: { output: "resolved", exitCode: 0, timedOut: false },
      };
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
}

function makeInput(
  overrides?: Partial<MergeConflictInput>,
): MergeConflictInput {
  return {
    repo: "org/repo",
    prNumber: 48,
    branchName: "issue-16-fix",
    baseBranch: "main",
    attemptCount: 0,
    ...overrides,
  };
}

async function runProcessor(
  input: MergeConflictInput,
  script: GitScript,
  depOverrides?: Partial<MergeConflictProcessorDeps>,
  opts?: { claudeDelayMs?: number },
): Promise<{
  captured: Captured;
  result: Awaited<
    ReturnType<typeof processMergeConflict>
  >;
}> {
  const captured: Captured = {
    events: [],
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
    gitArgs: [],
    commitAndPushCalls: 0,
    agentRuns: 0,
    lockRenewals: [],
  };

  const deps = createMockDeps({
    git: makeGit(script, captured),
    github: makeGithub(captured),
    claude: makeClaude(captured, opts?.claudeDelayMs ?? 0),
  });

  const result = await processMergeConflict(input, {
    logger: makeSilentLogger(),
    deps,
    workDir: await Deno.makeTempDir({ prefix: "vibe-merge-conflict-" }),
    // Pin the prompts directory: the checkout under test, not whatever
    // VIBE_BASE_DIR/PROMPTS_DIR the host happens to export.
    promptsDir: new URL("../../../prompts", import.meta.url).pathname,
    ...depOverrides,
  });

  return { captured, result };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("parseUnmergedPaths - trims and drops blank lines", () => {
  assertEquals(parseUnmergedPaths("a.ts\n b.ts \n\n"), ["a.ts", "b.ts"]);
  assertEquals(parseUnmergedPaths(""), []);
});

Deno.test("buildConflictEscalationReason - names the files and the failure", () => {
  const reason = buildConflictEscalationReason(
    makeInput(),
    ["SECURITY.md", "docs/archive/pr-summaries/pr-summary-50.md"],
    "the agent left 1 path(s) unmerged",
    2,
  );
  assertStringIncludes(reason, "SECURITY.md");
  assertStringIncludes(reason, "pr-summary-50.md");
  assertStringIncludes(reason, "the agent left 1 path(s) unmerged");
  assertStringIncludes(reason, "never side-picks");
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - resolves a conflict, pushes, comments and clears the label", async () => {
  const { captured, result } = await runProcessor(makeInput(), makeGitScript());

  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.agentRuns, 1);
  assertEquals(captured.commitAndPushCalls, 1);
  assertEquals(captured.labelsRemoved, [MERGE_CONFLICT_LABEL]);

  const resolved = captured.comments.at(-1) ?? "";
  assertStringIncludes(resolved, CONFLICT_RESOLVED_MARKER);
});

Deno.test("processMergeConflict - records the attempt before touching the branch", async () => {
  const { captured } = await runProcessor(makeInput(), makeGitScript());

  const firstComment = captured.comments[0] ?? "";
  assertStringIncludes(firstComment, CONFLICT_ATTEMPT_MARKER);
  assertStringIncludes(firstComment, "attempt 1 of 2");

  const commentIndex = captured.events.indexOf("gh:comment");
  const mergeIndex = captured.events.indexOf("git:merge origin/main");
  assert(commentIndex >= 0 && mergeIndex >= 0);
  assert(
    commentIndex < mergeIndex,
    `attempt must be recorded before the merge; got ${
      captured.events.join(",")
    }`,
  );
});

Deno.test("processMergeConflict - a clean merge needs no agent", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ mergeCode: 0, unmergedAfterMerge: [] }),
  );

  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(captured.agentRuns, 0);
  assertEquals(captured.commitAndPushCalls, 1);
});

Deno.test("processMergeConflict - refuses to push a tree that still has conflict markers", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ markersAfterAgent: true }),
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.commitAndPushCalls, 0);
  assert(
    captured.gitArgs.some((a) => a[0] === "merge" && a[1] === "--abort"),
    "the in-progress merge must be aborted so the branch is left untouched",
  );
});

Deno.test("processMergeConflict - refuses to push when the agent leaves paths unmerged", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterAgent: ["SECURITY.md"] }),
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(captured.commitAndPushCalls, 0);
  assert(captured.gitArgs.some((a) => a[0] === "merge" && a[1] === "--abort"));
});

Deno.test("processMergeConflict - a base that is still not an ancestor fails the attempt", async () => {
  const { result } = await runProcessor(
    makeInput(),
    makeGitScript({ ancestorCode: 1 }),
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
});

Deno.test("processMergeConflict - the final failed attempt escalates to a human", async () => {
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: 1 }),
    makeGitScript({ markersAfterAgent: true }),
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, true);
  assertEquals(captured.labelsAdded.includes("needs-human"), true);

  const escalation = captured.comments.at(-1) ?? "";
  assertStringIncludes(escalation, "**Why:**");
  assertStringIncludes(escalation, "**Next step:**");
  assertStringIncludes(escalation, "SECURITY.md");
});

// ---------------------------------------------------------------------------
// Disruption robustness (Issue #395)
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - a failed attempt posts an explicit conclusion", async () => {
  // Without this conclusion the attempt is indistinguishable from one a
  // dying worker abandoned — the GRQ#4408/#4409 silence.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ markersAfterAgent: true }),
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);

  const conclusion = captured.comments.at(-1) ?? "";
  assertStringIncludes(conclusion, CONFLICT_FAILED_MARKER);
  assertStringIncludes(conclusion, "attempt 1 of 2 failed");
  assertStringIncludes(conclusion, "conflict markers");
  assertStringIncludes(conclusion, "SECURITY.md");
});

Deno.test("processMergeConflict - the escalating attempt also posts its conclusion", async () => {
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: 1 }),
    makeGitScript({ markersAfterAgent: true }),
  );

  assert(result.ok);
  assertEquals(result.value.escalated, true);
  assert(
    captured.comments.some((c) => c.includes(CONFLICT_FAILED_MARKER)),
    `a failure conclusion must be posted; got ${captured.comments.length} comments`,
  );
});

Deno.test("processMergeConflict - a disrupted earlier attempt is surfaced on the PR", async () => {
  const { captured } = await runProcessor(
    makeInput({ attemptCount: 0, disruptedCount: 2 }),
    makeGitScript(),
  );

  const attempt = captured.comments[0] ?? "";
  assertStringIncludes(attempt, CONFLICT_ATTEMPT_MARKER);
  assertStringIncludes(attempt, "attempt 1 of 2");
  assertStringIncludes(attempt, "2 earlier attempt(s) were disrupted");
  assertStringIncludes(attempt, "does not spend");
});

Deno.test("processMergeConflict - a clean history says nothing about disruption", async () => {
  const { captured } = await runProcessor(makeInput(), makeGitScript());
  const attempt = captured.comments[0] ?? "";
  assertEquals(attempt.includes("disrupted"), false);
});

Deno.test("processMergeConflict - the PR lock is refreshed while the agent works", async () => {
  // Issue #395: the lock TTL is 5 minutes and a resolution runs for up to
  // the agent timeout, so without renewal a second host cleans the lock as
  // stale and starts a competing attempt on the same branch — which reads
  // as a disruption on the first attempt and races its push.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    {
      workerId: "worker-a",
      acquireLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: { acquired: true, lockCommentId: 4242 },
        })) as unknown as MergeConflictProcessorDeps["acquireLockFn"],
      releaseLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: undefined,
        })) as unknown as MergeConflictProcessorDeps["releaseLockFn"],
      lockRenewalIntervalMs: 10,
    },
    { claudeDelayMs: 80 },
  );

  assert(result.ok);
  assert(
    captured.lockRenewals.length >= 2,
    `the lock must be refreshed while the agent runs; got ${captured.lockRenewals.length} renewals`,
  );
  assertEquals(captured.lockRenewals[0], 4242);

  // And renewal stops with the run — a timer outliving it would refresh a
  // lock the worker no longer holds.
  const afterRun = captured.lockRenewals.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(captured.lockRenewals.length, afterRun);
});

Deno.test("processMergeConflict - a PR locked by another worker is left alone", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    {
      workerId: "worker-b",
      acquireLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: { acquired: false, winnerId: "worker-a" },
        })) as unknown as MergeConflictProcessorDeps["acquireLockFn"],
      releaseLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: undefined,
        })) as unknown as MergeConflictProcessorDeps["releaseLockFn"],
    },
  );

  assert(result.ok);
  assertEquals(result.value.processed, false);
  assertEquals(captured.gitArgs.length, 0);
  assertEquals(captured.comments.length, 0);
});
