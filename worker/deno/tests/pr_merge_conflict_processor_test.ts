/**
 * Tests for pr_merge_conflict_processor.ts (Issue #84).
 *
 * The processor is the receiver Issue #4373 deferred to: it merges the base
 * branch into a conflicting PR for real, refuses to push a tree that is not
 * fully resolved, bounds its attempts, and escalates with `needs-human` when
 * the budget is spent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 *
 * The fixtures embed conflict markers at column 0, which is exactly what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file, and prints the exemption. Nothing here is
 * an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildAttemptComment,
  buildConflictEscalationReason,
  buildFailedComment,
  buildNudgeComment,
  buildNudgeCommitMessage,
  buildRebaseComment,
  buildResolvedComment,
  buildRuleResolutionSection,
  buildRungFailedComment,
  describeDependencyDecision,
  type MergeConflictInput,
  type MergeConflictProcessorDeps,
  parseUnmergedPaths,
  processMergeConflict,
} from "../lib/pr_merge_conflict_processor.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
  MERGE_CONFLICT_LABEL,
  parseConflictAttempts,
} from "../lib/pr_merge_conflict_scan.ts";
import {
  CONFLICT_NUDGE_MARKER,
  CONFLICT_REBASE_MARKER,
  CONFLICT_RUNG_FAILED_MARKER,
  conflictNudgeMarker,
  conflictRebaseMarker,
  conflictRungFailedMarker,
} from "../lib/merge_conflict_markers.ts";
import type { AbandonRestartRequest } from "../lib/conflict_abandon_restart.ts";
import { resetGatedHeadReportsForTest } from "../lib/gated_head_guard.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  CrashHandlingDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import {
  heartbeatFilePath,
  markerStateFilePath,
} from "../lib/heartbeat_storage.ts";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import type { LogContext, Logger } from "../types.ts";

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
  /** Prompts the agent was actually given (Issue #466). */
  agentPrompts: string[];
  /** Lock-comment refreshes (Issue #395). */
  lockRenewals: number[];
  /** Comment ids withdrawn with `DELETE` (Issues #1458, #1693). */
  commentsDeleted: number[];
  /** `git commit --allow-empty` invocations (Issue #2278). */
  emptyCommits: string[][];
  /** Real `git push` invocations — the dry run is excluded (Issue #2278). */
  pushes: string[][];
  /** Revisions `git reset --hard` was pointed at (Issue #2279). */
  resets: string[];
  /** `git commit-tree` invocations — the squash fallback (Issue #2279). */
  commitTrees: string[][];
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
  /**
   * What `git rev-parse --is-shallow-repository` answers (Issue #1458). The
   * default is a full clone, so the deepen step is a no-op and the rest of
   * this suite exercises the merge exactly as before.
   */
  shallow: boolean;
  /**
   * Whether a merge base exists BEFORE the merge, for the deepen step's own
   * `git merge-base` probe (Issue #1458). Irrelevant on a full clone.
   */
  mergeBaseBeforeMerge: boolean;
  /** Whether `git fetch --deepen` / `--unshallow` produces that merge base. */
  mergeBaseAfterDeepen: boolean;
  /** stderr of a failing merge (default: a content conflict). */
  mergeStderr?: string;
  /** Error message `commitAndPushPending` fails with (default: it succeeds). */
  commitPushError?: string;
  /** Commits left unpushed after the push (default: 0 — a clean push). */
  finalUnpushedCount?: number;
  /** What `git push --dry-run` reports on stderr (Issue #1772). */
  pushDryRunStderr?: string;
  /**
   * What `git merge-base --is-ancestor origin/<base> HEAD` answers **before**
   * the merge (Issue #2278). `true` is GitHub's stale-verdict case: the base is
   * already in, so the resolver runs the ladder instead of opening an attempt.
   */
  baseIsAncestorBeforeMerge: boolean;
  /** `git rev-parse HEAD` before anything moves it. */
  headSha: string;
  /** `git rev-parse HEAD` once the merge has run. */
  headAfterMerge: string;
  /** `git rev-parse HEAD` once the nudge's empty commit has run. */
  headAfterNudge: string;
  /** `git rev-parse origin/<base>`. */
  baseSha: string;
  /** Exit code for the nudge's `git commit --allow-empty` (Issue #2278). */
  emptyCommitCode?: number;
  /** Exit code for the nudge's `git push` (Issue #2278). */
  pushCode?: number;
  /** Whether `git diff --cached --quiet` reports a dirty index (Issue #2278). */
  indexDirty?: boolean;
  /** Exit code for the rebase rung's `git rebase` (Issue #2279). */
  rebaseCode?: number;
  /** Paths reported unmerged while that rebase is stopped (Issue #2279). */
  rebaseUnmerged?: string[];
  /** `git rev-parse HEAD` once the replay has run (Issue #2279). */
  headAfterRebase?: string;
  /** Whether `git diff --quiet OLD HEAD` after the replay exits 0. */
  rebaseTreeIdentical?: boolean;
  /** The sha `git commit-tree` prints for the squash fallback (Issue #2279). */
  squashSha?: string;
  /** Whether `git diff --quiet OLD NEW` on the fallback exits 0. */
  squashTreeIdentical?: boolean;
}

function makeGitScript(overrides?: Partial<GitScript>): GitScript {
  return {
    mergeCode: 1,
    unmergedAfterMerge: ["SECURITY.md"],
    unmergedAfterAgent: [],
    markersAfterAgent: false,
    ancestorCode: 0,
    shallow: false,
    mergeBaseBeforeMerge: true,
    mergeBaseAfterDeepen: true,
    baseIsAncestorBeforeMerge: false,
    headSha: "1111111111111111111111111111111111111111",
    headAfterMerge: "2222222222222222222222222222222222222222",
    headAfterNudge: "3333333333333333333333333333333333333333",
    baseSha: "4444444444444444444444444444444444444444",
    headAfterRebase: "5555555555555555555555555555555555555555",
    squashSha: "6666666666666666666666666666666666666666",
    ...overrides,
  };
}

function makeGit(
  script: GitScript,
  captured: Captured,
): Partial<GitDeps> {
  let unmergedQueries = 0;
  let mergeDone = false;
  let deepened = false;
  let nudged = false;
  // The rebase rung's clone state (Issue #2279): where `HEAD` has been moved
  // to, and whether a stopped rebase is still in progress.
  let headOverride: string | null = null;
  let rebaseStopped = false;

  return {
    runGitCommand: ((args: string[]) => {
      captured.gitArgs.push(args);
      captured.events.push(`git:${args.slice(0, 2).join(" ")}`);

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        const sha = headOverride ??
          (nudged
            ? script.headAfterNudge
            : mergeDone
            ? script.headAfterMerge
            : script.headSha);
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: `${sha}\n`, stderr: "" },
        });
      }

      if (args[0] === "rebase" && args.includes("--abort")) {
        rebaseStopped = false;
        captured.events.push("git:rebase-abort");
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }

      if (args[0] === "rebase") {
        const code = script.rebaseCode ?? 0;
        if (code === 0) headOverride = script.headAfterRebase ?? null;
        else rebaseStopped = true;
        return Promise.resolve({
          ok: true,
          value: {
            code,
            stdout: "",
            stderr: code === 0 ? "" : "CONFLICT (content): SECURITY.md",
          },
        });
      }

      if (args[0] === "commit-tree") {
        captured.commitTrees.push(args);
        captured.events.push("git:commit-tree");
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: `${script.squashSha}\n`, stderr: "" },
        });
      }

      if (args[0] === "reset" && args[1] === "--hard") {
        const revision = args[2] ?? "";
        captured.resets.push(revision);
        captured.events.push("git:reset-hard");
        headOverride = revision;
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }

      if (
        args[0] === "diff" && args.includes("--quiet") &&
        !args.includes("--cached")
      ) {
        // `[.., "--quiet", OLD, "HEAD"]` is the replay's identity guard;
        // `[.., "--quiet", OLD, NEW]` is the fallback's own assertion.
        const identical = args[3] === "HEAD"
          ? script.rebaseTreeIdentical ?? true
          : script.squashTreeIdentical ?? true;
        return Promise.resolve({
          ok: true,
          value: { code: identical ? 0 : 1, stdout: "", stderr: "" },
        });
      }

      if (args[0] === "rev-parse" && args[1]?.startsWith("origin/")) {
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: `${script.baseSha}\n`, stderr: "" },
        });
      }

      if (args[0] === "diff" && args.includes("--cached")) {
        return Promise.resolve({
          ok: true,
          value: {
            code: script.indexDirty ? 1 : 0,
            stdout: "",
            stderr: "",
          },
        });
      }

      if (args[0] === "commit" && args.includes("--allow-empty")) {
        const code = script.emptyCommitCode ?? 0;
        if (code === 0) nudged = true;
        captured.emptyCommits.push(args);
        captured.events.push("git:commit-empty");
        return Promise.resolve({
          ok: true,
          value: {
            code,
            stdout: "",
            stderr: code === 0 ? "" : "commit failed",
          },
        });
      }

      if (args[0] === "push" && !args.includes("--dry-run")) {
        const code = script.pushCode ?? 0;
        captured.pushes.push(args);
        captured.events.push("git:push");
        return Promise.resolve({
          ok: true,
          value: { code, stdout: "", stderr: code === 0 ? "" : "push failed" },
        });
      }

      if (args[0] === "rev-parse" && args.includes("--is-shallow-repository")) {
        return Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: script.shallow ? "true" : "false",
            stderr: "",
          },
        });
      }

      if (
        args[0] === "fetch" &&
        args.some((a) => a.startsWith("--deepen=") || a === "--unshallow")
      ) {
        deepened = true;
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }

      if (args[0] === "merge" && args[1]?.startsWith("origin/")) {
        mergeDone = true;
        return Promise.resolve({
          ok: true,
          value: {
            code: script.mergeCode,
            stdout: "",
            stderr: script.mergeCode === 0
              ? ""
              : script.mergeStderr ?? "CONFLICT (content)",
          },
        });
      }

      if (args[0] === "diff" && args.includes("--diff-filter=U")) {
        if (rebaseStopped) {
          // The rebase rung reads the unmerged paths while the replay is
          // still stopped (Issue #2279) — it is a different question from the
          // merge's own, so it is answered from its own script field.
          return Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout: (script.rebaseUnmerged ?? ["SECURITY.md"]).join("\n"),
              stderr: "",
            },
          });
        }
        const paths = unmergedQueries === 0
          ? script.unmergedAfterMerge
          : script.unmergedAfterAgent;
        unmergedQueries++;
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: paths.join("\n"), stderr: "" },
        });
      }

      if (args[0] === "push" && args.includes("--dry-run")) {
        const stderr = script.pushDryRunStderr ?? "";
        return Promise.resolve({
          ok: true,
          value: { code: stderr === "" ? 0 : 1, stdout: "", stderr },
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

      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        // Before the merge this is the stale-verdict pre-check (Issue #2278);
        // after it, the "did the base's changes really land" guard.
        const code = mergeDone
          ? script.ancestorCode
          : script.baseIsAncestorBeforeMerge
          ? 0
          : 1;
        return Promise.resolve({
          ok: true,
          value: { code, stdout: "", stderr: "" },
        });
      }

      if (args[0] === "merge-base") {
        // The deepen step's probe (Issue #1458): does a common ancestor exist
        // in the clone yet?
        const present = deepened
          ? script.mergeBaseAfterDeepen
          : script.mergeBaseBeforeMerge;
        return Promise.resolve({
          ok: true,
          value: {
            code: present ? 0 : 1,
            stdout: present ? "abc123\n" : "",
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
      if (script.commitPushError !== undefined) {
        return Promise.resolve({
          ok: false,
          error: new Error(script.commitPushError),
        });
      }
      return Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: true,
          commitsPushed: 1,
          finalUnpushedCount: script.finalUnpushedCount ?? 0,
        },
      });
    }) as unknown as GitDeps["commitAndPushPending"],
  };
}

function makeGithub(
  captured: Captured,
  /**
   * Id `gh pr comment` reports for every comment it posts (Issue #1693).
   * Without one the processor holds no comment id and cannot withdraw the
   * attempt marker, so a test about withdrawal needs the URL `gh` really
   * prints.
   */
  postedCommentId?: number,
  /** Comment bodies already on the PR, as `gh pr view` would report them. */
  existingPrComments: readonly string[] = [],
  /**
   * What `gh pr view --json headRefOid,mergeable,author` reports (Issue
   * #2278) — the head and the verdict the stale-verdict ladder decides on,
   * plus the author the rebase rung is gated on (Issue #2279). `author`
   * defaults to the fleet login; `null` is a PR whose author `gh` did not
   * report.
   */
  prHeadState?: {
    headRefOid: string;
    mergeable: string;
    author?: string | null;
  },
  /**
   * The raw REST comment thread `fetchIssueCommentPages` reads (Issue #2278),
   * author and all — a rung marker only counts when the fleet wrote it.
   */
  threadComments: readonly { body: string; author: string }[] = [],
  /** Error `gh pr comment` rejects with, when the post must fail. */
  commentPostError?: string,
): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "comment") {
        if (commentPostError !== undefined) {
          return Promise.reject(new Error(commentPostError));
        }
        const idx = args.indexOf("--body");
        if (idx >= 0) {
          captured.comments.push(String(args[idx + 1] ?? ""));
          captured.events.push("gh:comment");
        }
        if (postedCommentId !== undefined) {
          return Promise.resolve(
            `https://github.com/org/repo/pull/48#issuecomment-${postedCommentId}`,
          );
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
        if (verb === "DELETE" && endpoint.includes("/issues/comments/")) {
          captured.commentsDeleted.push(
            Number(endpoint.split("/issues/comments/")[1] ?? 0),
          );
          captured.events.push("gh:comment-delete");
        }
        if (verb === "DELETE" && endpoint.includes("/labels/")) {
          captured.labelsRemoved.push(endpoint.split("/labels/")[1] ?? "");
          captured.events.push("gh:label-remove");
        }
      }
      if (args[0] === "pr" && args[1] === "view") {
        if (args.some((a) => a.includes("headRefOid"))) {
          // The stale-verdict ladder reads the head and the verdict together
          // (Issue #2278).
          if (prHeadState === undefined) return Promise.resolve("{}");
          const { author, ...head } = prHeadState;
          return Promise.resolve(
            JSON.stringify(
              author === null
                ? head
                : { ...head, author: { login: author ?? "vibe-coder" } },
            ),
          );
        }
        // The stand-down guard reads the thread before it comments, and an
        // unreadable thread posts nothing (Issue #1772).
        return Promise.resolve(
          JSON.stringify({
            comments: existingPrComments.map((body) => ({ body })),
          }),
        );
      }
      if (
        args[0] === "api" && !args.includes("-X") &&
        String(args[1] ?? "").includes("/comments?")
      ) {
        // `fetchIssueCommentPages` walks explicit pages; page 2 onwards is
        // empty, which is what ends the walk (Issue #2278).
        const page = /[?&]page=(\d+)/.exec(String(args[1]))?.[1] ?? "1";
        return Promise.resolve(
          JSON.stringify(
            page === "1"
              ? threadComments.map(({ body, author }) => ({
                body,
                user: { login: author },
              }))
              : [],
          ),
        );
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function makeClaude(
  captured: Captured,
  delayMs = 0,
  /**
   * Fields merged over the successful run's result — `terminated: true` is
   * the watchdog SIGTERM the run-end delivers (Issue #1693).
   */
  resultOverrides?: Partial<ClaudeRunResult>,
): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry: (async (options: { prompt?: string }) => {
      captured.agentRuns++;
      captured.agentPrompts.push(options?.prompt ?? "");
      captured.events.push("agent:run");
      // A real resolution runs for minutes; a few milliseconds is enough for
      // a test to observe what happens *while* it runs (Issue #395).
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        ok: true,
        value: {
          output: "resolved",
          exitCode: 0,
          timedOut: false,
          ...resultOverrides,
        },
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
  opts?: {
    claudeDelayMs?: number;
    workDirFiles?: Record<string, string>;
    crashHandling?: Partial<CrashHandlingDeps>;
    /** Fields merged over the agent result (Issue #1693). */
    claudeResult?: Partial<ClaudeRunResult>;
    /** Id `gh pr comment` reports for each posted comment (Issue #1693). */
    postedCommentId?: number;
    /** Comment bodies already on the PR (Issue #1772). */
    existingPrComments?: string[];
    /** Head sha, verdict and author `gh pr view` reports (Issues #2278, #2279). */
    prHeadState?: {
      headRefOid: string;
      mergeable: string;
      author?: string | null;
    };
    /** The raw REST comment thread with its authors (Issue #2278). */
    threadComments?: { body: string; author: string }[];
    /** Error `gh pr comment` rejects with (Issue #2278). */
    commentPostError?: string;
  },
): Promise<{
  captured: Captured;
  result: Awaited<
    ReturnType<typeof processMergeConflict>
  >;
  /** The clone the merge runs in. */
  workDir: string;
  /** The `WORK_DIR` root that holds heartbeat and marker state. */
  workRoot: string;
}> {
  const captured: Captured = {
    events: [],
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
    gitArgs: [],
    commitAndPushCalls: 0,
    agentRuns: 0,
    agentPrompts: [],
    lockRenewals: [],
    commentsDeleted: [],
    emptyCommits: [],
    pushes: [],
    resets: [],
    commitTrees: [],
  };

  const deps = createMockDeps({
    git: makeGit(script, captured),
    github: makeGithub(
      captured,
      opts?.postedCommentId,
      opts?.existingPrComments ?? [],
      opts?.prHeadState,
      opts?.threadComments ?? [],
      opts?.commentPostError,
    ),
    claude: makeClaude(
      captured,
      opts?.claudeDelayMs ?? 0,
      opts?.claudeResult,
    ),
    crashHandling: opts?.crashHandling,
  });

  // Issue #1660: the work root and the clone are separate directories, so a
  // heartbeat written into the clone is visible as a wrong location.
  const workRoot = await Deno.makeTempDir({ prefix: "vibe-work-root-" });
  const workDir = await Deno.makeTempDir({ prefix: "vibe-merge-conflict-" });
  for (const [path, content] of Object.entries(opts?.workDirFiles ?? {})) {
    await Deno.writeTextFile(`${workDir}/${path}`, content);
  }

  const result = await processMergeConflict(input, {
    logger: makeSilentLogger(),
    deps,
    workDir,
    workRoot,
    // Pin the prompts directory: the checkout under test, not whatever
    // VIBE_BASE_DIR/PROMPTS_DIR the host happens to export.
    promptsDir: new URL("../../../prompts", import.meta.url).pathname,
    ...depOverrides,
  });

  return { captured, result, workDir, workRoot };
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
  assertStringIncludes(
    firstComment,
    `attempt 1 of ${DEFAULT_MAX_CONFLICT_ATTEMPTS}`,
  );

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

Deno.test("processMergeConflict - the heartbeat state lands in the work root, not the clone (Issue #1660)", async () => {
  const recordDirs: string[] = [];
  const clearDirs: string[] = [];

  const { result, workDir, workRoot } = await runProcessor(
    makeInput(),
    makeGitScript(),
    undefined,
    {
      crashHandling: {
        // The real recorder writes both state files off the directory it is
        // given, so writing them here shows where the pass points it.
        recordHeartbeat: async (dir, repo, issueNumber) => {
          recordDirs.push(dir);
          await Deno.writeTextFile(
            heartbeatFilePath(dir, repo, issueNumber),
            `${Date.now()}`,
          );
          await Deno.writeTextFile(
            markerStateFilePath(dir, repo, issueNumber),
            "{}",
          );
          return { ok: true, value: undefined };
        },
        clearHeartbeat: (dir) => {
          clearDirs.push(dir);
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    },
  );

  assert(result.ok);
  assertEquals(recordDirs, [workRoot]);
  assertEquals(clearDirs, [workRoot]);

  // The state files land under the work root …
  const heartbeat = await Deno.stat(
    heartbeatFilePath(workRoot, "org/repo", 48),
  );
  assert(heartbeat.isFile);
  const marker = await Deno.stat(markerStateFilePath(workRoot, "org/repo", 48));
  assert(marker.isFile);

  // … and the clone's top level gains neither.
  const strays: string[] = [];
  for await (const entry of Deno.readDir(workDir)) {
    if (
      entry.name.startsWith(".heartbeat_") ||
      entry.name.startsWith(".heartbeat-marker_")
    ) {
      strays.push(entry.name);
    }
  }
  assertEquals(strays, []);
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

Deno.test("processMergeConflict - the marker check is scoped to the conflicted files (Issue #584)", async () => {
  // A tree-wide grep rejects a correct resolution in any repository that
  // legitimately contains marker-shaped lines. GRQ carries
  // `docs/JSON_Merge_Conflict_Prevention.md` — a document *about* merge
  // conflicts whose worked example opens `<<<<<<< Updated upstream` — so
  // every conflict there was aborted after being resolved.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
  );

  assert(result.ok);
  const grep = captured.gitArgs.find((a) => a[0] === "grep");
  assert(grep, "the marker check must run");
  const separator = grep.indexOf("--");
  assert(
    separator !== -1,
    `the grep must be path-scoped, got: ${grep.join(" ")}`,
  );
  // Exactly the files this merge conflicted in, and nothing else.
  assertEquals(grep.slice(separator + 1), ["SECURITY.md"]);
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

// ---------------------------------------------------------------------------
// Issue #1458: the depth-1 clone must hold the merge base before merging
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - a full clone is not deepened (Issue #1458)", async () => {
  const { captured, result } = await runProcessor(makeInput(), makeGitScript());
  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(
    captured.gitArgs.some((a) =>
      a[0] === "fetch" &&
      a.some((x) => x.startsWith("--deepen") || x === "--unshallow")
    ),
    false,
    "no deepen or unshallow on a full clone",
  );
});

Deno.test("processMergeConflict - a shallow clone is deepened to the merge base before the merge (Issue #1458)", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      shallow: true,
      mergeBaseBeforeMerge: false,
      mergeBaseAfterDeepen: true,
    }),
  );
  assert(result.ok);
  assertEquals(result.value.merged, true, result.value.summary);
  const deepenAt = captured.events.findIndex((e) =>
    e === "git:fetch --deepen=50"
  );
  const mergeAt = captured.events.findIndex((e) =>
    e.startsWith("git:merge origin/")
  );
  assert(deepenAt >= 0, `no deepen recorded: ${captured.events.join(", ")}`);
  assert(deepenAt < mergeAt, "the deepen must precede the merge");
});

Deno.test("processMergeConflict - no common ancestor even after unshallow escalates without spending an attempt (Issue #1458)", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      shallow: true,
      mergeBaseBeforeMerge: false,
      mergeBaseAfterDeepen: false,
    }),
  );
  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, true, result.value.summary);
  assert(
    result.value.summary.includes("common ancestor"),
    result.value.summary,
  );
  // No merge was tried, no attempt marker was posted, no failed-attempt
  // conclusion spent the budget — the clone, not the PR, is the problem.
  assertEquals(
    captured.events.some((e) => e.startsWith("git:merge origin/")),
    false,
  );
  assertEquals(
    captured.comments.some((c) =>
      c.includes("Merge-conflict resolution — attempt")
    ),
    false,
    "an attempt must not be opened for a clone problem",
  );
  assertEquals(
    captured.labelsAdded.includes("needs-human"),
    true,
    captured.labelsAdded.join(","),
  );
  assert(
    captured.comments.some((c) =>
      c.includes("common ancestor") && c.includes("Issue #1458")
    ),
    captured.comments.join("\n---\n"),
  );
});

Deno.test("processMergeConflict - 'refusing to merge unrelated histories' is a clone fault, not a failed attempt (Issue #1458)", async () => {
  // Belt and braces: should git still refuse after the deepen step, the
  // refusal is classified for what it is rather than as a generic
  // "did not conflict but failed" that spends an attempt.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      mergeCode: 128,
      unmergedAfterMerge: [],
      mergeStderr: "fatal: refusing to merge unrelated histories",
    }),
  );
  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, true, result.value.summary);
  assertEquals(
    captured.comments.some((c) =>
      c.includes(`attempt 1 of ${DEFAULT_MAX_CONFLICT_ATTEMPTS} failed`)
    ),
    false,
    "the refusal must not be posted as a failed attempt",
  );
  assertEquals(captured.labelsAdded.includes("needs-human"), true);
});

Deno.test("processMergeConflict - the final failed attempt escalates to a human", async () => {
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
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
// Abandon-and-restart before a human (Issue #1115)
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - the final failure abandons and restarts rather than escalating", async () => {
  // The rung sits *here*, not only in the scan: the processor is what
  // concludes the last attempt, and escalating from it would put
  // `needs-human` on the PR before anything could try the restart.
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: (request) => {
        seen.push(request);
        return Promise.resolve({
          outcome: "abandoned",
          issueNumber: 16,
          label: { kept: "work-on" },
        });
      },
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertStringIncludes(result.value.summary, "re-queued issue #16");

  // The rung is handed the PR it is closing, and the thread it quotes.
  assertEquals(seen.length, 1);
  assertEquals(seen[0]?.prNumber, 48);
  assertEquals(seen[0]?.branchName, "issue-16-fix");
  assertEquals(seen[0]?.baseBranch, "main");

  // The failure conclusion is still posted: it is what spends the attempt.
  assert(captured.comments.some((c) => c.includes(CONFLICT_FAILED_MARKER)));
});

Deno.test("processMergeConflict - the third attempt is the one that abandons (Issue #1766)", async () => {
  // The budget of three, read end to end: the attempt after two concluded
  // failures announces itself as the last one and, on failing, runs the
  // abandon rung rather than a fourth attempt.
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: (request) => {
        seen.push(request);
        return Promise.resolve({
          outcome: "abandoned",
          issueNumber: 16,
          label: { kept: "work-on" },
        });
      },
    },
  );

  assert(result.ok);
  assertStringIncludes(
    captured.comments[0] ?? "",
    `attempt ${DEFAULT_MAX_CONFLICT_ATTEMPTS} of ${DEFAULT_MAX_CONFLICT_ATTEMPTS}`,
  );
  assertEquals(seen.length, 1, "the abandon rung ran on the third failure");
  assertEquals(result.value.escalated, false);
});

Deno.test("processMergeConflict - the second failure neither escalates nor abandons (Issue #1766)", async () => {
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 2 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: (request) => {
        seen.push(request);
        return Promise.resolve({
          outcome: "abandoned",
          issueNumber: 16,
          label: { kept: "work-on" },
        });
      },
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, false);
  assertEquals(seen.length, 0, "budget is left, so nothing is abandoned");
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assert(
    captured.comments.some((c) => c.includes(CONFLICT_FAILED_MARKER)),
    "the failure still concludes, spending one attempt",
  );
});

Deno.test("processMergeConflict - an abandon names the label the issue was re-queued with (Issue #2277)", async () => {
  // The rung closed the PR and re-queued the issue with `idle-task`, since it
  // carried no pickup label. Nobody is waiting on a human to re-apply one.
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "abandoned",
          issueNumber: 16,
          label: { applied: "idle-task" },
        }),
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertStringIncludes(result.value.summary, "re-queued issue #16");
  assertStringIncludes(result.value.summary, "`idle-task`");
});

Deno.test("processMergeConflict - a spent restart budget asks no human (Issue #2312)", async () => {
  // The one route out of the spent-budget branch that used to end at a
  // person. It no longer does: the scan parks the PR on `merge-conflict` and
  // re-attempts it when the base tip moves, and `needs-human` would take the
  // PR out of the very lane that clears it.
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "declined",
          reason: {
            kind: "already-restarted",
            issueNumber: 16,
            samePr: false,
            restartCount: 2,
          },
        }),
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertStringIncludes(result.value.summary, "spent its restarts");
  assertStringIncludes(result.value.summary, "parked");
});

Deno.test("processMergeConflict - an abandon that fails escalates naming the step", async () => {
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "failed",
          step: "pr-close",
          message: "gh refused",
        }),
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, true);
  assertEquals(captured.labelsAdded.includes("needs-human"), true);
  const escalation = captured.comments.at(-1) ?? "";
  assertStringIncludes(escalation, "`pr-close` step");
});

Deno.test("processMergeConflict - a declined abandon escalates saying why", async () => {
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "declined",
          reason: { kind: "no-originating-issue", detail: "no-signal" },
        }),
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, true);
  const escalation = captured.comments.at(-1) ?? "";
  assertStringIncludes(escalation, "names no originating issue");
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
  assertStringIncludes(
    conclusion,
    `attempt 1 of ${DEFAULT_MAX_CONFLICT_ATTEMPTS} failed`,
  );
  assertStringIncludes(conclusion, "conflict markers");
  assertStringIncludes(conclusion, "SECURITY.md");
});

Deno.test("processMergeConflict - the escalating attempt also posts its conclusion", async () => {
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
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
  assertStringIncludes(
    attempt,
    `attempt 1 of ${DEFAULT_MAX_CONFLICT_ATTEMPTS}`,
  );
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

Deno.test("processMergeConflict - a locked PR records lock-held and its holder", async () => {
  // Issue #1109: the lock gate is one more exit a labelled PR can leave a
  // pass through, so it records against the same closed taxonomy.
  const records: Array<{ message: string; context?: LogContext }> = [];
  const logger: Logger = {
    ...makeSilentLogger(),
    info: (message, context) => records.push({ message, ...{ context } }),
  };

  await runProcessor(makeInput(), makeGitScript(), {
    logger,
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
  });

  const record = records.find((entry) =>
    entry.message.startsWith("merge_conflict_decision=")
  );
  assert(record, "the lock gate left no decision record");
  assertEquals(record.context?.reason, "lock-held");
  assertEquals(record.context?.lockHolder, "worker-a");
  assertEquals(record.context?.prNumber, makeInput().prNumber);
});

// ---------------------------------------------------------------------------
// Deterministic dependency rules before the agent (Issue #466)
// ---------------------------------------------------------------------------

/** A conflicted `deno.json` whose only difference is a version bump. */
const DENO_JSON_CONFLICT = `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  }
}
`;

/** A stub pass with a fixed verdict, so the processor's wiring is isolated. */
function stubRules(
  resolved: readonly { path: string; kind: "manifest" | "lock" }[],
  deferred: readonly string[] = [],
): MergeConflictProcessorDeps["applyDependencyRulesFn"] {
  return () =>
    Promise.resolve({
      resolved: resolved.map((file) => ({
        path: file.path,
        kind: file.kind,
        resolvedBy: file.kind === "lock" ? "deno install" : "deno.json",
        decisions: [],
        decisionsUnattributed: false,
      })),
      deferred: deferred.map((path) => ({ path, reason: "no rule" })),
    });
}

Deno.test("processMergeConflict - a deno.json/deno.lock conflict is resolved with no agent call", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterMerge: ["deno.json", "deno.lock"] }),
    {
      applyDependencyRulesFn: stubRules([
        { path: "deno.json", kind: "manifest" },
        { path: "deno.lock", kind: "lock" },
      ]),
    },
  );

  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(captured.agentRuns, 0);
  assertEquals(captured.commitAndPushCalls, 1);

  const resolved = captured.comments.at(-1) ?? "";
  assertStringIncludes(resolved, CONFLICT_RESOLVED_MARKER);
  assertStringIncludes(resolved, "`deno.json`");
  assertStringIncludes(resolved, "`deno.lock`");
  assertStringIncludes(resolved, "deno install");
});

Deno.test("processMergeConflict - the real rules resolve a version bump and name the decision", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterMerge: ["deno.json"] }),
    {},
    { workDirFiles: { "deno.json": DENO_JSON_CONFLICT } },
  );

  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(captured.agentRuns, 0);
  assert(
    captured.gitArgs.some((a) => a[0] === "add" && a.includes("deno.json")),
    `the rule-resolved path must be staged; got ${
      JSON.stringify(captured.gitArgs)
    }`,
  );

  const resolved = captured.comments.at(-1) ?? "";
  assertStringIncludes(resolved, "no AI decision was involved");
  assertStringIncludes(resolved, "`@std/fs`");
  assertStringIncludes(resolved, "jsr:@std/fs@^1.0.0");
  assertStringIncludes(resolved, "jsr:@std/fs@^1.2.0");
  assertStringIncludes(resolved, "taken from `main`");
});

Deno.test("processMergeConflict - the agent is asked only about the files the rules deferred", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterMerge: ["deno.json", "src/app.ts"] }),
    {},
    { workDirFiles: { "deno.json": DENO_JSON_CONFLICT } },
  );

  assert(result.ok);
  assertEquals(captured.agentRuns, 1);
  const prompt = captured.agentPrompts[0] ?? "";
  assertStringIncludes(prompt, "- `src/app.ts`");
  assertEquals(
    prompt.includes("- `deno.json`"),
    false,
    "the agent must not be asked to re-reason about a rule-resolved file",
  );
});

Deno.test("processMergeConflict - a conflict with no rule-eligible file reaches the agent unchanged", async () => {
  const { captured, result } = await runProcessor(makeInput(), makeGitScript());

  assert(result.ok);
  assertEquals(captured.agentRuns, 1);
  assertStringIncludes(captured.agentPrompts[0] ?? "", "- `SECURITY.md`");

  const resolved = captured.comments.at(-1) ?? "";
  assertEquals(resolved.includes("no AI decision was involved"), false);
});

Deno.test("processMergeConflict - leftover markers still fail a rule-resolved tree", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      unmergedAfterMerge: ["deno.json"],
      markersAfterAgent: true,
    }),
    {
      applyDependencyRulesFn: stubRules([{
        path: "deno.json",
        kind: "manifest",
      }]),
    },
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(captured.agentRuns, 0);
  assertEquals(captured.commitAndPushCalls, 0);
  assert(captured.gitArgs.some((a) => a[0] === "merge" && a[1] === "--abort"));
  assertStringIncludes(captured.comments.at(-1) ?? "", "conflict markers");
});

Deno.test("processMergeConflict - an unmerged path left by the rules fails the attempt", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      unmergedAfterMerge: ["deno.json"],
      unmergedAfterAgent: ["deno.json"],
    }),
    {
      applyDependencyRulesFn: stubRules([{
        path: "deno.json",
        kind: "manifest",
      }]),
    },
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(captured.commitAndPushCalls, 0);
  assertStringIncludes(
    captured.comments.at(-1) ?? "",
    "the deterministic rules left 1 path(s) unmerged",
  );
});

// ---------------------------------------------------------------------------
// Comment rendering (Issue #466)
// ---------------------------------------------------------------------------

Deno.test("buildAttemptComment - promises no in-run quality gate (Issue #2306)", () => {
  const body = buildAttemptComment(1, 3, "main");
  assertEquals(
    /quality gate/i.test(body),
    false,
    "the agent no longer runs the repository's quality gate in the run",
  );
  // What does gate the result is named instead, so removing the promise does
  // not read as "nothing checks this merge".
  assertStringIncludes(body, "CI on the pushed merge");
  assertStringIncludes(body, "judgement call is named file by file");
});

Deno.test("buildResolvedComment - carries the agent's judgement lines verbatim (Issue #2306)", () => {
  const reply = "Merged `main` in.\n" +
    "Judgement: worker/deno/lib/a.ts — kept both guards; dropped nothing; " +
    "because the two sides guard different inputs\n" +
    "Judgement: worker/deno/lib/b.ts — kept the 10s timeout; dropped the 60s " +
    "default; because only the interactive path reads it";
  const body = buildResolvedComment("main", "issue-16-fix", reply);
  assertStringIncludes(
    body,
    "Judgement: worker/deno/lib/a.ts — kept both guards",
  );
  assertStringIncludes(
    body,
    "Judgement: worker/deno/lib/b.ts — kept the 10s timeout",
  );
});

Deno.test("buildResolvedComment - says nothing extra when the rules resolved nothing", () => {
  assertEquals(
    buildResolvedComment("main", "issue-16-fix", "merged by hand"),
    buildResolvedComment("main", "issue-16-fix", "merged by hand", []),
  );
});

Deno.test("describeDependencyDecision - renders each decision shape", () => {
  const base = { key: "@std/fs", ours: "^1.0.0", theirs: "^1.2.0" };
  assertStringIncludes(
    describeDependencyDecision(
      { ...base, kept: "^1.2.0" },
      "main",
      "pr-branch",
    ),
    "`^1.0.0` → `^1.2.0` (taken from `main`)",
  );
  assertStringIncludes(
    describeDependencyDecision(
      { ...base, kept: "^1.0.0" },
      "main",
      "pr-branch",
    ),
    "kept from `pr-branch`",
  );
  assertStringIncludes(
    describeDependencyDecision(
      { key: "@std/path", ours: null, theirs: "^1.1.0", kept: "^1.1.0" },
      "main",
      "pr-branch",
    ),
    "added by `main`",
  );
});

// ---------------------------------------------------------------------------
// Issue #1673: repo context comes from the clone, not <clone>/<repo>
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - injects the clone's CLAUDE.md into the agent prompt (Issue #1673)", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    {},
    {
      workDirFiles: {
        "CLAUDE.md":
          "# Repo guidance\n\nSENTINEL-1673-MERGE: prefer Australian English.\n",
      },
    },
  );

  assert(result.ok);
  assertEquals(captured.agentRuns, 1);
  assertStringIncludes(captured.agentPrompts[0] ?? "", "SENTINEL-1673-MERGE");
});

Deno.test("processMergeConflict - warns when the checkout directory is missing (Issue #1673)", async () => {
  const warnings: string[] = [];
  const logger = makeSilentLogger();
  logger.warn = (message: string) => {
    warnings.push(message);
  };

  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    { logger, workDir: "/nonexistent/vibe-1673-clone" },
  );

  assert(result.ok);
  assertEquals(captured.agentRuns, 1);
  assertEquals(
    warnings.some((w) => w.includes("Repo context directory does not exist")),
    true,
    `expected a missing-directory warning, got: ${warnings.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// A run the worker itself ended (Issue #1693)
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - a watchdog SIGTERM withdraws the attempt instead of failing it", async () => {
  // GRQ-25, NEAT-AI-core#637: the maintenance-lane watchdog abandoned the
  // handler at the cycle end and SIGTERMed the agent mid-edit. The half-merged
  // tree was then read as "the agent left 6 path(s) unmerged" and spent one of
  // the PR's two attempts.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterAgent: ["SECURITY.md"] }),
    undefined,
    { claudeResult: { terminated: true }, postedCommentId: 9001 },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(
    result.value.runEnded,
    true,
    "the drain stops on this withdrawal, and only on this one",
  );
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);
  assertEquals(result.value.processed, false);

  // The attempt marker is withdrawn, so the next scan counts neither a
  // concluded attempt nor a disrupted one.
  assertEquals(captured.commentsDeleted, [9001]);

  // No conclusion of any kind was posted on the PR.
  const conclusions = captured.comments.filter((c) =>
    c.includes(CONFLICT_FAILED_MARKER) || c.includes(CONFLICT_RESOLVED_MARKER)
  );
  assertEquals(conclusions, []);

  // The branch is left exactly as its author pushed it.
  assertEquals(captured.commitAndPushCalls, 0);
  assert(
    captured.gitArgs.some((args) =>
      args[0] === "merge" && args.includes("--abort")
    ),
    "the half-resolved merge was not aborted",
  );
});

Deno.test("processMergeConflict - a provider outage withdraws the attempt instead of failing it (Issue #2613)", async () => {
  // A 402 Insufficient Balance ended the agent before it looked at the
  // conflict. That is the provider's failure, not the PR's: nothing is spent,
  // no failure is posted, and the drain stops rather than burning the next PR.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterAgent: ["SECURITY.md"] }),
    undefined,
    {
      claudeResult: {
        exitCode: 2,
        output: "API Error: 402 Insufficient Balance",
        usageLimit: { waitSeconds: 60 },
        agentFailure: {
          category: "quota-exhausted",
          message: "API Error: 402 Insufficient Balance",
          evidence: "prose",
          terminal: true,
          httpStatus: 402,
          errors: [],
        },
      },
      postedCommentId: 9004,
    },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(result.value.runEnded, true);
  assertEquals(result.value.escalated, false);
  assertStringIncludes(result.value.summary, "provider");
  assertEquals(captured.commentsDeleted, [9004]);
  const conclusions = captured.comments.filter((c) =>
    c.includes(CONFLICT_FAILED_MARKER) || c.includes(CONFLICT_RESOLVED_MARKER)
  );
  assertEquals(conclusions, []);
  assertEquals(captured.commitAndPushCalls, 0);
});

Deno.test("processMergeConflict - an agent that runs out its own timeout spends its attempt (Issue #2305)", async () => {
  // The other ending of an agent run: the agent's own 30-minute ceiling, not
  // the handler deadline. The rung was climbed and the conflict beat it, so
  // this is a judged failure — a failed marker on the PR, and the attempt
  // marker left standing rather than withdrawn.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({}),
    undefined,
    {
      claudeResult: { timedOut: true, timeoutReason: "hard-timeout" },
      postedCommentId: 9003,
    },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, undefined);
  assertEquals(
    result.value.runEnded,
    undefined,
    "an agent timeout does not end the drain — only a worker kill does",
  );
  assertEquals(captured.commentsDeleted, [], "the marker is not withdrawn");

  const failed = captured.comments.filter((c) =>
    c.includes(CONFLICT_FAILED_MARKER)
  );
  assertEquals(failed.length, 1);
  assertStringIncludes(failed[0] ?? "", "timed out");
  assertEquals(captured.commitAndPushCalls, 0);
});

Deno.test("processMergeConflict - an agent that finishes still spends its attempt", async () => {
  // The other side of the same guard: only a terminated run is withdrawn. An
  // agent that ran to a conclusion and left the tree unmerged is judged.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterAgent: ["SECURITY.md"] }),
    undefined,
    { postedCommentId: 9002 },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, undefined);
  assertEquals(captured.commentsDeleted, []);
  const failed = captured.comments.filter((c) =>
    c.includes(CONFLICT_FAILED_MARKER)
  );
  assertEquals(failed.length, 1);
  assertStringIncludes(failed[0] ?? "", "left 1 path(s) unmerged");
});

Deno.test("processMergeConflict - a marker that cannot be withdrawn is never silent", async () => {
  // Issue #1693: `gh pr comment` reported no comment URL, so the attempt
  // marker on the PR cannot be addressed. The attempt still spends nothing,
  // but the orphaned marker must be said out loud — it is what the next scan
  // reads as a disrupted attempt.
  const warnings: string[] = [];
  const logger: Logger = {
    ...makeSilentLogger(),
    warn: (message: string, _context?: LogContext) => {
      warnings.push(message);
    },
  };

  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterAgent: ["SECURITY.md"] }),
    { logger },
    { claudeResult: { terminated: true } },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(captured.commentsDeleted, []);
  assert(
    warnings.some((w) => w.includes("Could not withdraw the attempt marker")),
    `an unwithdrawable marker must warn, got: ${warnings.join(" | ")}`,
  );
});

Deno.test("buildRuleResolutionSection - a ledger resolution says both additions were kept, not a version pick (Issue #1768)", () => {
  const section = buildRuleResolutionSection(
    [
      {
        path: "CHANGELOG.md",
        kind: "manifest",
        resolvedBy: "both-inserted",
        decisions: [],
        decisionsUnattributed: false,
      },
    ],
    "main",
    "issue-1768",
  ).join("\n");

  assertStringIncludes(section, "CHANGELOG.md");
  assertStringIncludes(section, "both additions were kept");
  assertEquals(
    section.includes("higher published version"),
    false,
    "no dependency was decided, so the comment must not claim one was",
  );
});

Deno.test("buildRuleResolutionSection - a manifest resolution still explains the version rule (Issue #466)", () => {
  const section = buildRuleResolutionSection(
    [
      {
        path: "deno.json",
        kind: "manifest",
        resolvedBy: "deno.json",
        decisions: [],
        decisionsUnattributed: false,
      },
    ],
    "main",
    "issue-1768",
  ).join("\n");

  assertStringIncludes(section, "higher published version");
});

// ---------------------------------------------------------------------------
// A ruleset-refused push spends no attempt (Issue #1772)
// ---------------------------------------------------------------------------

/** A logger that records every line, so a "not charged" claim is checkable. */
function makeRecordingLogger(lines: string[]): Logger {
  const record = (message: string, _context?: LogContext) => {
    lines.push(message);
  };
  return {
    ...makeSilentLogger(),
    info: record,
    warn: record,
    error: record,
  };
}

Deno.test("processMergeConflict - a push refused by a ruleset spends no attempt (Issue #1772)", async () => {
  // GH013 recurs identically on every run for as long as the rule stands, so
  // charging it burned the PR's budget on a push that could never land.
  const lines: string[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      commitPushError:
        "Failed to push unpushed commits: remote: error: GH013: Repository " +
        "rule violations found for refs/heads/issue-16-fix.\n" +
        "remote: - 2 of 2 required status checks are expected.",
    }),
    { logger: makeRecordingLogger(lines) },
    { postedCommentId: 7001 },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(
    result.value.runEnded,
    undefined,
    "a ruleset refusal says nothing about the run's time — the drain carries on",
  );
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);

  // The attempt marker is withdrawn, so the next scan counts zero attempts.
  assertEquals(captured.commentsDeleted, [7001]);
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_FAILED_MARKER)),
    [],
    "a ruleset refusal must post no failed conclusion",
  );
  assert(
    lines.some((line) =>
      line.includes("not charged: push rejected by ruleset")
    ),
    `the refusal must be named in the log; got ${JSON.stringify(lines)}`,
  );
});

Deno.test("processMergeConflict - a ruleset refusal reported by the dry run also spends no attempt (Issue #1772)", async () => {
  // The other shape: the push helper returned ok but left commits unpushed,
  // and only the dry run names the rule.
  const lines: string[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      finalUnpushedCount: 1,
      pushDryRunStderr:
        "remote: error: GH013: Repository rule violations found for " +
        "refs/heads/issue-16-fix.\nremote: - Changes must be made through a " +
        "pull request.",
    }),
    { logger: makeRecordingLogger(lines) },
    { postedCommentId: 7002 },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(captured.commentsDeleted, [7002]);
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_FAILED_MARKER)),
    [],
  );
  assert(
    lines.some((line) =>
      line.includes("not charged: push rejected by ruleset")
    ),
  );
});

Deno.test("processMergeConflict - an ordinary push failure is still charged (Issue #1772)", async () => {
  // The boundary: only a rule violation is uncharged. A network fault is the
  // failure it always was, conclusion and all.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      commitPushError:
        "Failed to push unpushed commits: fatal: unable to access origin: " +
        "Could not resolve host: github.com",
    }),
    undefined,
    { postedCommentId: 7003 },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, undefined);
  assertEquals(captured.commentsDeleted, []);
  const failed = captured.comments.filter((c) =>
    c.includes(CONFLICT_FAILED_MARKER)
  );
  assertEquals(failed.length, 1);
  assertStringIncludes(failed[0] ?? "", "commit/push failed");
});

// ---------------------------------------------------------------------------
// A milestone head is left to the milestone sync (Issue #1772)
// ---------------------------------------------------------------------------

Deno.test("processMergeConflict - a milestone head is left to the milestone sync (Issue #1772)", async () => {
  // GRQ#4702's shape. The every-cycle sync owns `default -> milestone/*`, so
  // running the ladder here would duplicate that merge and race its push.
  resetGatedHeadReportsForTest();
  const lines: string[] = [];
  const { captured, result } = await runProcessor(
    makeInput({ branchName: "milestone/1730-resolve-merge-conflicts" }),
    makeGitScript(),
    { logger: makeRecordingLogger(lines) },
    { postedCommentId: 7004 },
  );

  assert(result.ok);
  assertEquals(result.value.processed, false);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);

  // No merge ran and no attempt was opened.
  assertEquals(captured.agentRuns, 0);
  assertEquals(captured.commitAndPushCalls, 0);
  assertEquals(
    captured.gitArgs.filter((args) => args[0] === "merge"),
    [],
    "no merge is attempted on a milestone head",
  );
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_ATTEMPT_MARKER)),
    [],
    "no attempt marker is posted, so no attempt is spent",
  );

  // One stand-down comment naming the sync, and one skip log line.
  assertEquals(captured.comments.length, 1);
  assertStringIncludes(captured.comments[0] ?? "", "milestone branch sync");
  assertStringIncludes(
    captured.comments[0] ?? "",
    '<!-- vibe-milestone-head branch="milestone/1730-resolve-merge-conflicts" -->',
  );
  assertEquals(
    lines.filter((line) =>
      line.includes(
        "skipped: milestone head — resolved by the milestone branch sync",
      )
    ).length,
    1,
  );
});

Deno.test("processMergeConflict - the milestone stand-down comments once per branch (Issue #1772)", async () => {
  // A PR already carrying the marker is left silent: one comment per branch,
  // not one per run.
  resetGatedHeadReportsForTest();
  const input = makeInput({ branchName: "milestone/1730-already-told" });
  const marker =
    '<!-- vibe-milestone-head branch="milestone/1730-already-told" -->';
  const { captured } = await runProcessor(
    input,
    makeGitScript(),
    undefined,
    { postedCommentId: 7005, existingPrComments: [marker] },
  );

  assertEquals(captured.comments, []);
});

Deno.test("processMergeConflict - a non-milestone head is worked as before (Issue #1772)", async () => {
  // The boundary: an ordinary feature head still merges, pushes and concludes.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    undefined,
    { postedCommentId: 7006 },
  );

  assert(result.ok);
  assertEquals(result.value.merged, true);
  assertEquals(captured.commitAndPushCalls, 1);
  assertEquals(captured.commentsDeleted, []);
  assert(captured.comments.some((c) => c.includes(CONFLICT_ATTEMPT_MARKER)));
});

// ---------------------------------------------------------------------------
// The stale-verdict ladder (Issues #2272, #2278)
// ---------------------------------------------------------------------------

/** A `GitScript` whose pre-merge ancestry check says the verdict is stale. */
function staleVerdictScript(overrides?: Partial<GitScript>): GitScript {
  return makeGitScript({ baseIsAncestorBeforeMerge: true, ...overrides });
}

/** The fleet login whose marker comments the ladder trusts in these tests. */
const FLEET_AUTHOR = "vibe-coder";

Deno.test("processMergeConflict - a stale CONFLICTING verdict nudges instead of opening an attempt (Issue #2278)", async () => {
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9001,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
    },
  );

  assert(result.ok);
  assertEquals(result.value.rung, "nudge");
  assertEquals(result.value.processed, true);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);
  assertEquals(result.value.attemptCharged, false);

  // Nothing was spent and nothing claimed to be resolved.
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_ATTEMPT_MARKER)),
    [],
    "no attempt is opened on the stale route",
  );
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_RESOLVED_MARKER)),
    [],
    "a no-op merge must never post a resolved marker",
  );
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_FAILED_MARKER)),
    [],
  );
  assertEquals(
    captured.labelsRemoved,
    [],
    "the label stays until GitHub agrees",
  );
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.commitAndPushCalls, 0, "no merge was committed");

  // Exactly one empty commit and one plain push.
  assertEquals(captured.emptyCommits.length, 1);
  assertEquals(captured.pushes.length, 1);
  const pushArgs = captured.pushes[0] ?? [];
  assertEquals(
    pushArgs.filter((a) => a.startsWith("--force")),
    [],
    "the nudge never forces",
  );
  assert(pushArgs.includes("origin") && pushArgs.includes("issue-16-fix"));

  // The commit message evidences the ancestry and is attributable.
  const commitMessage = captured.emptyCommits[0]?.at(-1) ?? "";
  assertStringIncludes(commitMessage, "Issue #2272");
  assertStringIncludes(commitMessage, script.baseSha);
  assertStringIncludes(commitMessage, "Vibe-Coder-Run-Id:");

  // Exactly one comment, carrying the marker for the NEW head.
  assertEquals(captured.comments.length, 1);
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, CONFLICT_NUDGE_MARKER);
  assertStringIncludes(comment, `head="${script.headAfterNudge}"`);
  assertStringIncludes(comment, script.baseSha);
  assertStringIncludes(comment, script.headSha);
  assertStringIncludes(comment, "ancestor");
});

Deno.test("processMergeConflict - an unknown verdict on the stale route runs nothing (Issue #2278)", async () => {
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9002,
      prHeadState: { headRefOid: script.headSha, mergeable: "UNKNOWN" },
    },
  );

  assert(result.ok);
  assertEquals(result.value.processed, false);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(result.value.rung, undefined);
  assertEquals(captured.pushes, []);
  assertEquals(captured.emptyCommits, []);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processMergeConflict - a MERGEABLE verdict on the stale route only clears the label (Issue #2278)", async () => {
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9003,
      prHeadState: { headRefOid: script.headSha, mergeable: "MERGEABLE" },
    },
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(captured.labelsRemoved, [MERGE_CONFLICT_LABEL]);
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.pushes, []);
  assertEquals(captured.emptyCommits, []);
  assertEquals(
    captured.comments,
    [],
    "no marker is posted when GitHub catches up",
  );
});

Deno.test("processMergeConflict - a nudge marker naming the current head climbs to the rebase rung (Issues #2278, #2279)", async () => {
  // Behaviour change recorded in Issue #2279: this case asserted the unwired
  // rebase placeholder (nothing pushed, `processed: false`). The rung is wired
  // now, so what it asserts is the ladder *climbing* — no second nudge at this
  // head, and the rebase rung taking over.
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9004,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
      threadComments: [{
        body: conflictNudgeMarker(script.headSha),
        author: FLEET_AUTHOR,
      }],
    },
  );

  assert(result.ok);
  assertEquals(result.value.rung, "rebase");
  assertEquals(result.value.attemptCharged, false);
  assertEquals(captured.emptyCommits, [], "one nudge per head, not two");
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processMergeConflict - an outsider's nudge marker does not advance the ladder (Issue #1247)", async () => {
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9005,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
      threadComments: [{
        body: conflictNudgeMarker(script.headSha),
        author: "drive-by-account",
      }],
    },
  );

  assert(result.ok);
  assertEquals(result.value.rung, "nudge");
  assertEquals(captured.emptyCommits.length, 1);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a nudge leaves the next real attempt's number unchanged (Issue #2278)", async () => {
  // The rung markers share no literal with the attempt vocabulary, so a
  // scripted thread counts the same with the nudge comment in it.
  const withoutNudge = [
    { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->` },
    { body: `${CONFLICT_FAILED_MARKER} n="1" -->` },
  ];
  const withNudge = [
    ...withoutNudge,
    // The body the rung really posts, not a hand-rolled stand-in.
    {
      body: buildNudgeComment(
        "main",
        "4444444444444444444444444444444444444444",
        "1111111111111111111111111111111111111111",
        "3333333333333333333333333333333333333333",
      ),
    },
  ];
  assertEquals(
    parseConflictAttempts(withNudge).count,
    parseConflictAttempts(withoutNudge).count,
  );
  assertEquals(parseConflictAttempts(withNudge).count, 1);

  // And the attempt comment the resolver posts next says "attempt 2 of 3".
  const { captured } = await runProcessor(
    makeInput({ attemptCount: parseConflictAttempts(withNudge).count }),
    makeGitScript(),
    { trustedAuthors: [FLEET_AUTHOR] },
  );
  const attempt =
    captured.comments.find((c) => c.includes(CONFLICT_ATTEMPT_MARKER)) ?? "";
  assertStringIncludes(
    attempt,
    `attempt 2 of ${DEFAULT_MAX_CONFLICT_ATTEMPTS}`,
  );
});

Deno.test("processMergeConflict - a merge that succeeds without moving HEAD fails loud (Issue #2278)", async () => {
  // The pre-check ruled out "the base is already in", so a zero-exit merge
  // that leaves HEAD where it was cannot be reported as resolved.
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({
      mergeCode: 0,
      unmergedAfterMerge: [],
      headAfterMerge: "1111111111111111111111111111111111111111",
    }),
    undefined,
    { postedCommentId: 9006 },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "Invariant violated");
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_RESOLVED_MARKER)),
    [],
  );
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("buildNudgeCommitMessage - evidences the ancestry and stays attributable (Issue #2278)", () => {
  const message = buildNudgeCommitMessage("main", "abc1234", "vibe-test-run");
  assertStringIncludes(message, "Issue #2272");
  assertStringIncludes(message, "`origin/main` (abc1234)");
  assertStringIncludes(message, "empty");
  assertStringIncludes(message, "Vibe-Coder-Run-Id: vibe-test-run");
});

Deno.test("buildNudgeComment - names the new head, the base and why the commit exists (Issue #2278)", () => {
  const body = buildNudgeComment("main", "abc1234", "def5678", "0123abc");
  assertStringIncludes(body, conflictNudgeMarker("0123abc"));
  assertStringIncludes(body, "abc1234");
  assertStringIncludes(body, "def5678");
  assertStringIncludes(body, "ancestor");
  assertStringIncludes(body, "empty commit");
  // The rung must stay invisible to the attempt budget.
  assertEquals(body.includes(CONFLICT_ATTEMPT_MARKER), false);
  assertEquals(body.includes(CONFLICT_RESOLVED_MARKER), false);
});

Deno.test("processMergeConflict - a nudge commit that fails posts nothing (Issue #2278)", async () => {
  const script = staleVerdictScript({ emptyCommitCode: 1 });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9007,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "nudge commit");
  assertEquals(captured.pushes, [], "nothing is pushed when the commit failed");
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processMergeConflict - a nudge push that fails posts no marker (Issue #2278)", async () => {
  const script = staleVerdictScript({ pushCode: 1 });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9008,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "push the nudge commit");
  assertEquals(
    captured.comments,
    [],
    "a marker naming a head nobody can see is worse than none",
  );
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processMergeConflict - a nudge commit that does not move HEAD fails loud (Issue #2278)", async () => {
  const script = staleVerdictScript({
    headAfterNudge: "1111111111111111111111111111111111111111",
  });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9009,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "did not move HEAD");
  assertEquals(captured.pushes, []);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - an unreadable head/verdict pair stops the stale route (Issue #2278)", async () => {
  const { captured, result } = await runProcessor(
    makeInput(),
    staleVerdictScript(),
    { trustedAuthors: [FLEET_AUTHOR] },
    { postedCommentId: 9010 },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "head sha and merge verdict");
  assertEquals(captured.emptyCommits, []);
  assertEquals(captured.pushes, []);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processMergeConflict - no configured fleet identity runs no rung (Issues #1247, #2278)", async () => {
  // With no trusted author every marker is unattributable, so the ladder could
  // never see its own nudge and would re-nudge each new head for ever.
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [] },
    {
      postedCommentId: 9011,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
    },
  );

  assert(result.ok);
  assertEquals(result.value.processed, false);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(result.value.rung, undefined);
  assertStringIncludes(result.value.summary, "trusted author");
  assertEquals(captured.emptyCommits, []);
  assertEquals(captured.pushes, []);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a clone that is not at the PR head refuses to nudge (Issue #2278)", async () => {
  // The ancestry was checked against the clone's HEAD; claiming it for a head
  // git never looked at would be evidence for the wrong commit.
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9012,
      prHeadState: {
        headRefOid: "9999999999999999999999999999999999999999",
        mergeable: "CONFLICTING",
      },
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "the clone is at");
  assertEquals(captured.emptyCommits, []);
  assertEquals(captured.pushes, []);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a dirty index refuses the nudge rather than committing it (Issue #2278)", async () => {
  const script = staleVerdictScript({ indexDirty: true });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      postedCommentId: 9013,
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "index is not clean");
  assertEquals(captured.emptyCommits, []);
  assertEquals(captured.pushes, []);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a nudge whose marker cannot be posted fails loud (Issue #2278)", async () => {
  // The marker is the bound: an unrecorded nudge would be repeated at every
  // new head instead of climbing, which is the loop this ladder replaces.
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    {
      prHeadState: { headRefOid: script.headSha, mergeable: "CONFLICTING" },
      commentPostError: "gh: 503 Service Unavailable",
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "could not post its marker");
  assertStringIncludes(result.error.message, script.headAfterNudge);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

// ---------------------------------------------------------------------------
// The rebase rung (Issue #2279)
// ---------------------------------------------------------------------------

/**
 * Options that put the ladder on the rebase rung: GitHub still says
 * `CONFLICTING` at `head`, and the fleet's own nudge marker already names it.
 */
function atRebaseRung(
  head: string,
  overrides?: { author?: string | null; commentId?: number },
) {
  return {
    postedCommentId: overrides?.commentId ?? 9100,
    prHeadState: {
      headRefOid: head,
      mergeable: "CONFLICTING",
      author: overrides?.author,
    },
    threadComments: [{
      body: conflictNudgeMarker(head),
      author: FLEET_AUTHOR,
    }],
  };
}

/** The leased force-push the rung must use, pinned to the judged head. */
function leaseFor(head: string): string {
  return `--force-with-lease=issue-16-fix:${head}`;
}

Deno.test("processMergeConflict - an identical tree pushes the replay once, with the pinned lease (Issue #2279)", async () => {
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    atRebaseRung(script.headSha),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "rebase");
  assertEquals(result.value.processed, true);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);
  assertEquals(result.value.attemptCharged, false);

  assertEquals(captured.pushes.length, 1, "exactly one push");
  const push = captured.pushes[0] ?? [];
  assert(push.includes(leaseFor(script.headSha)), `got ${push.join(" ")}`);
  assertEquals(push.filter((a) => a === "--force" || a === "-f"), []);
  assertEquals(captured.commitTrees, [], "no fallback when the tree matches");

  // One comment, carrying both shas and the route it took.
  assertEquals(captured.comments.length, 1);
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, CONFLICT_REBASE_MARKER);
  assertStringIncludes(comment, `old="${script.headSha}"`);
  assertStringIncludes(comment, `new="${script.headAfterRebase}"`);
  assertStringIncludes(comment, "route: `rebase`");
  assertStringIncludes(comment, "tree is identical to the previous head");

  // Nothing is spent and nothing claims a resolution.
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_ATTEMPT_MARKER)),
    [],
  );
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_RESOLVED_MARKER)),
    [],
  );
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processMergeConflict - a replayed tree that differs is reset to OLD and the old tree squashed (Issue #2279)", async () => {
  const script = staleVerdictScript({ rebaseTreeIdentical: false });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    atRebaseRung(script.headSha, { commentId: 9101 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "rebase");
  assertEquals(
    captured.resets[0],
    script.headSha,
    "the differing replay is thrown away before anything else",
  );

  // The fallback carries OLD's tree onto the base.
  assertEquals(captured.commitTrees.length, 1);
  const commitTree = captured.commitTrees[0] ?? [];
  assertEquals(commitTree[1], `${script.headSha}^{tree}`);
  assertEquals(commitTree[3], "origin/main");

  assertEquals(captured.pushes.length, 1);
  assert((captured.pushes[0] ?? []).includes(leaseFor(script.headSha)));

  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, `new="${script.squashSha}"`);
  assertStringIncludes(comment, "route: `squash`");
});

Deno.test("processMergeConflict - a replay conflict aborts and pushes the squash of OLD's tree (Issue #2279)", async () => {
  const script = staleVerdictScript({
    rebaseCode: 1,
    rebaseUnmerged: ["SECURITY.md"],
  });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    atRebaseRung(script.headSha, { commentId: 9102 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "rebase");
  assert(
    captured.events.includes("git:rebase-abort"),
    `the replay must be aborted; got ${captured.events.join(",")}`,
  );

  assertEquals(captured.commitTrees.length, 1);
  assertEquals(
    (captured.commitTrees[0] ?? [])[1],
    `${script.headSha}^{tree}`,
  );

  assertEquals(captured.pushes.length, 1);
  const push = captured.pushes[0] ?? [];
  assert(push.includes(leaseFor(script.headSha)));
  assertEquals(
    push.filter((a) => a === "--force" || a === "-f"),
    [],
    "a bare force would breach the no-destructive-push contract",
  );

  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, "route: `squash`");
  assertStringIncludes(comment, `new="${script.squashSha}"`);
});

Deno.test("processMergeConflict - a clone that is not at the judged head pushes nothing and reports the rung failed (Issue #2279)", async () => {
  const judged = "9999999999999999999999999999999999999999";
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    atRebaseRung(judged, { commentId: 9103 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "rebase");
  assertEquals(result.value.processed, false);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(captured.pushes, [], "nothing is pushed");
  assertEquals(captured.resets, [], "nothing is reset");
  assertEquals(captured.commitTrees, []);

  assertEquals(captured.comments.length, 1);
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, CONFLICT_RUNG_FAILED_MARKER);
  assertStringIncludes(comment, 'rung="rebase"');
  assertStringIncludes(comment, `head="${judged}"`);
  assertStringIncludes(comment, script.headSha);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a refused push restores OLD and reports the rung failed (Issue #2279)", async () => {
  const script = staleVerdictScript({ pushCode: 1 });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    atRebaseRung(script.headSha, { commentId: 9104 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "rebase");
  assertEquals(result.value.processed, false);
  assertEquals(
    captured.resets.at(-1),
    script.headSha,
    "the replay is never left on the branch",
  );

  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, CONFLICT_RUNG_FAILED_MARKER);
  assertStringIncludes(comment, `head="${script.headSha}"`);
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_REBASE_MARKER)),
    [],
    "a refused push never claims a rebase",
  );
});

Deno.test("processMergeConflict - a rung fault still records the rung as failed (Issue #2279)", async () => {
  // A replay that fails with no unmerged paths is a broken clone, not a
  // conflict. Without the marker the next scan re-decides `rebase` at this
  // same head and hits the same fault for ever — the loop the ladder exists
  // to break — so the fault is loud *and* recorded.
  const script = staleVerdictScript({ rebaseCode: 1, rebaseUnmerged: [] });
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    { trustedAuthors: [FLEET_AUTHOR] },
    atRebaseRung(script.headSha, { commentId: 9107 }),
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "no unmerged paths");
  assertEquals(captured.pushes, [], "a broken clone pushes nothing");

  assertEquals(captured.comments.length, 1);
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, CONFLICT_RUNG_FAILED_MARKER);
  assertStringIncludes(comment, `head="${script.headSha}"`);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a rung-failed comment renders a marker-shaped git message inert (Issue #2260)", async () => {
  const forged = `${CONFLICT_REBASE_MARKER} old="${"a".repeat(40)}" new="${
    "b".repeat(40)
  }" -->`;
  const body = buildRungFailedComment(
    "rebase",
    "abc1234",
    `git said: ${forged}`,
  );
  assertEquals(
    body.includes(`${CONFLICT_REBASE_MARKER} old=`),
    false,
    "a quoted marker must not read back as the fleet's own ladder memory",
  );
  assertStringIncludes(body, conflictRungFailedMarker("rebase", "abc1234"));
});

Deno.test("processMergeConflict - a human-authored PR is never rebased (Issue #2279)", async () => {
  // Behaviour change recorded in Issue #2280: this case asserted the unwired
  // abandon placeholder (`rung: undefined`, nothing called). The rung is wired
  // now, so what it asserts is the ladder going *straight* to the abandon —
  // still without a single rebase command on a branch the fleet does not own.
  const script = staleVerdictScript();
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: recordingAbandon(seen, {
        outcome: "abandoned",
        issueNumber: 234,
        label: { kept: "top-priority" },
      }),
    },
    atRebaseRung(script.headSha, { author: "a-human", commentId: 9105 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  assertEquals(seen.length, 1);
  assertEquals(
    captured.gitArgs.filter((args) => args[0] === "rebase"),
    [],
    "no rebase command is issued for a branch the fleet does not own",
  );
  assertEquals(captured.pushes, []);
  assertEquals(captured.commitTrees, []);
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - an unreadable PR author is never rebased (Issue #2279)", async () => {
  const script = staleVerdictScript();
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: recordingAbandon(seen, {
        outcome: "abandoned",
        issueNumber: 234,
        label: { kept: "top-priority" },
      }),
    },
    atRebaseRung(script.headSha, { author: null, commentId: 9106 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  assertEquals(seen.length, 1, "the ladder climbs rather than stopping");
  assertEquals(
    captured.gitArgs.filter((args) => args[0] === "rebase"),
    [],
    "a rebase needs a positive fleet attribution, not the absence of one",
  );
  assertEquals(captured.pushes, []);
});

Deno.test("processMergeConflict - the rebase rung leaves the next real attempt's number unchanged (Issue #2279)", async () => {
  const withoutRebase = [
    { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->` },
    { body: `${CONFLICT_FAILED_MARKER} n="1" -->` },
  ];
  const withRebase = [
    ...withoutRebase,
    // The bodies the rung really posts, not hand-rolled stand-ins.
    {
      body: buildRebaseComment(
        "main",
        "1111111111111111111111111111111111111111",
        "5555555555555555555555555555555555555555",
        "squash",
      ),
    },
    {
      body: buildRungFailedComment(
        "rebase",
        "1111111111111111111111111111111111111111",
        "the push was refused",
      ),
    },
  ];
  assertEquals(
    parseConflictAttempts(withRebase).count,
    parseConflictAttempts(withoutRebase).count,
  );
  assertEquals(parseConflictAttempts(withRebase).count, 1);
});

Deno.test("buildRebaseComment - names both shas, the route and the identity the push rests on (Issue #2279)", () => {
  const body = buildRebaseComment("Develop", "abc1234", "def5678", "rebase");
  assertStringIncludes(body, conflictRebaseMarker("abc1234", "def5678"));
  assertStringIncludes(body, "abc1234");
  assertStringIncludes(body, "def5678");
  assertStringIncludes(body, "route: `rebase`");
  assertStringIncludes(body, "tree is identical to the previous head");
  assertStringIncludes(body, "--force-with-lease");
  // The rung must stay invisible to the attempt budget.
  assertEquals(body.includes(CONFLICT_ATTEMPT_MARKER), false);
  assertEquals(body.includes(CONFLICT_RESOLVED_MARKER), false);
});

Deno.test("buildRungFailedComment - names the rung, the head and where the branch is (Issue #2279)", () => {
  const body = buildRungFailedComment("rebase", "abc1234", "the push bounced");
  assertStringIncludes(body, conflictRungFailedMarker("rebase", "abc1234"));
  assertStringIncludes(body, "the push bounced");
  assertStringIncludes(body, "abc1234");
  assertEquals(body.includes(CONFLICT_ATTEMPT_MARKER), false);
  assertEquals(body.includes(CONFLICT_FAILED_MARKER), false);
  assertEquals(body.includes(CONFLICT_RESOLVED_MARKER), false);
});

// ---------------------------------------------------------------------------
// The abandon rung (Issue #2280)
// ---------------------------------------------------------------------------

/**
 * Options that put the ladder on its last rung: the fleet's own rebase marker
 * already names `head` as the head it produced, and GitHub still calls the PR
 * `CONFLICTING` there.
 */
function atAbandonRung(
  head: string,
  overrides?: {
    commentId?: number;
    author?: string | null;
    threadComments?: { body: string; author: string }[];
  },
) {
  return {
    postedCommentId: overrides?.commentId ?? 9200,
    prHeadState: {
      headRefOid: head,
      mergeable: "CONFLICTING",
      author: overrides?.author,
    },
    threadComments: overrides?.threadComments ?? [
      { body: conflictNudgeMarker(head), author: FLEET_AUTHOR },
      {
        body: conflictRebaseMarker(
          "1111111111111111111111111111111111111111",
          head,
        ),
        author: FLEET_AUTHOR,
      },
    ],
  };
}

/** An abandon rung that records what it was asked to abandon. */
function recordingAbandon(
  seen: AbandonRestartRequest[],
  outcome: Awaited<
    ReturnType<NonNullable<MergeConflictProcessorDeps["abandonRestartFn"]>>
  >,
): NonNullable<MergeConflictProcessorDeps["abandonRestartFn"]> {
  return (request) => {
    seen.push(request);
    return Promise.resolve(outcome);
  };
}

Deno.test("processMergeConflict - a rebased head GitHub still calls CONFLICTING is abandoned (Issue #2280)", async () => {
  const script = staleVerdictScript();
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: recordingAbandon(seen, {
        outcome: "abandoned",
        issueNumber: 234,
        label: { kept: "top-priority" },
      }),
    },
    atAbandonRung(script.headSha),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  assertEquals(result.value.processed, true);
  assertEquals(result.value.merged, false);
  assertEquals(result.value.escalated, false);
  assertEquals(result.value.attemptCharged, false);
  assertStringIncludes(result.value.summary, "issue #234");
  assertStringIncludes(result.value.summary, "`top-priority`");

  // The rung is handed this PR, and fetches its own thread.
  assertEquals(seen.length, 1);
  assertEquals(seen[0]?.repo, "org/repo");
  assertEquals(seen[0]?.prNumber, 48);
  assertEquals(seen[0]?.branchName, "issue-16-fix");
  assertEquals(seen[0]?.baseBranch, "main");
  assertEquals(seen[0]?.prComments, undefined);

  // Nothing is spent, nothing is labelled, nothing is pushed.
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
  assertEquals(captured.pushes, []);
  assertEquals(captured.emptyCommits, []);
  assertEquals(
    captured.comments,
    [],
    "the rung posts its own comments; the processor adds none",
  );
});

Deno.test("processMergeConflict - a rebase rung-failed marker at this head climbs to abandon (Issue #2280)", async () => {
  const script = staleVerdictScript();
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: recordingAbandon(seen, {
        outcome: "abandoned",
        issueNumber: 234,
        label: { applied: "idle-task" },
      }),
    },
    atAbandonRung(script.headSha, {
      commentId: 9201,
      threadComments: [
        { body: conflictNudgeMarker(script.headSha), author: FLEET_AUTHOR },
        {
          body: buildRungFailedComment(
            "rebase",
            script.headSha,
            "the leased push was refused",
          ),
          author: FLEET_AUTHOR,
        },
      ],
    }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  assertEquals(seen.length, 1, "a failed rebase at this head is not retried");
  assertStringIncludes(result.value.summary, "`idle-task`");
  assertEquals(
    captured.gitArgs.filter((args) => args[0] === "rebase"),
    [],
    "the rebase rung already ran at this head",
  );
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - a declined abandon records the rung and adds no label (Issue #2280)", async () => {
  const script = staleVerdictScript();
  const seen: AbandonRestartRequest[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: recordingAbandon(seen, {
        outcome: "declined",
        reason: {
          kind: "already-restarted",
          issueNumber: 234,
          samePr: false,
          restartCount: 2,
        },
      }),
    },
    atAbandonRung(script.headSha, { commentId: 9202 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  assertEquals(result.value.processed, false);
  assertEquals(result.value.escalated, false);
  assertEquals(result.value.attemptCharged, false);
  assertEquals(seen.length, 1);

  // One comment, carrying the marker that exhausts the ladder at this head.
  assertEquals(captured.comments.length, 1);
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, CONFLICT_RUNG_FAILED_MARKER);
  assertStringIncludes(comment, 'rung="abandon"');
  assertStringIncludes(comment, `head="${script.headSha}"`);
  // Issue #2312: the spent-restart decline reads as an ordinary decline now,
  // and says the PR is left on the queue label rather than handed anywhere.
  assertStringIncludes(comment, "spent its 2 restarts");

  // No rung applies `needs-human`, on the PR or on the issue (Issue #2280).
  assertEquals(captured.labelsAdded, []);
  assertEquals(captured.labelsRemoved, []);
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_ATTEMPT_MARKER)),
    [],
  );
  assertEquals(
    captured.comments.filter((c) => c.includes(CONFLICT_RESOLVED_MARKER)),
    [],
  );

  // The next scan at this same head reads that marker back and runs nothing.
  const second = await runProcessor(
    makeInput(),
    staleVerdictScript(),
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: recordingAbandon(seen, {
        outcome: "declined",
        reason: {
          kind: "already-restarted",
          issueNumber: 234,
          samePr: false,
          restartCount: 2,
        },
      }),
    },
    atAbandonRung(script.headSha, {
      commentId: 9203,
      threadComments: [
        { body: conflictNudgeMarker(script.headSha), author: FLEET_AUTHOR },
        { body: comment, author: FLEET_AUTHOR },
      ],
    }),
  );

  assert(second.result.ok);
  assertEquals(second.result.value.processed, false);
  assertEquals(second.result.value.rung, undefined);
  assertStringIncludes(second.result.value.summary, "ladder-exhausted");
  assertEquals(seen.length, 1, "the abandon rung runs once per head");
  assertEquals(second.captured.comments, []);
  assertEquals(second.captured.labelsAdded, []);
});

Deno.test("processMergeConflict - an abandon that fails records the rung without a human (Issue #2280)", async () => {
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "failed",
          step: "pr-close",
          message: "gh refused",
        }),
    },
    atAbandonRung(script.headSha, { commentId: 9204 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  assertEquals(result.value.processed, false);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.comments.length, 1);
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, 'rung="abandon"');
  assertStringIncludes(comment, "`pr-close` step");
  assertEquals(
    captured.labelsAdded,
    [],
    "the stall watchdog is the backstop here, not `needs-human`",
  );
});

Deno.test("processMergeConflict - a failure after the close never claims nothing was closed (Issue #2280)", async () => {
  // `issue-label` runs *after* the PR is closed, so the comment must not say
  // the PR is still open — it would be a permanent public claim about state
  // nobody checked, and it would contradict the route's own paragraphs above
  // it.
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "failed",
          step: "issue-label",
          message: "gh refused the label",
          issueNumber: 234,
        }),
    },
    atAbandonRung(script.headSha, { commentId: 9206 }),
  );

  assert(result.ok);
  assertEquals(result.value.rung, "abandon");
  const comment = captured.comments[0] ?? "";
  assertStringIncludes(comment, "`issue-label` step");
  assertEquals(
    comment.includes("Nothing was closed"),
    false,
    "the close had already run by this step",
  );
  assertEquals(
    result.value.summary.includes("still open"),
    false,
  );
  assertEquals(captured.labelsAdded, []);
});

Deno.test("processMergeConflict - an abandon whose marker cannot be posted fails loud (Issue #2280)", async () => {
  // Without the marker the next scan re-decides `abandon` at this same head
  // and calls a rung that has already declined — the loop the ladder replaces.
  const script = staleVerdictScript();
  const { captured, result } = await runProcessor(
    makeInput(),
    script,
    {
      trustedAuthors: [FLEET_AUTHOR],
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "declined",
          reason: { kind: "no-originating-issue", detail: "no-signal" },
        }),
    },
    {
      ...atAbandonRung(script.headSha, { commentId: 9205 }),
      commentPostError: "gh: 503 Service Unavailable",
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "no record of it");
  assertEquals(captured.comments, []);
  assertEquals(captured.labelsAdded, []);
});

Deno.test("buildRungFailedComment - the abandon rung says the ladder waits rather than climbs (Issue #2280)", () => {
  const body = buildRungFailedComment(
    "abandon",
    "abc1234",
    "the restart was declined",
  );
  assertStringIncludes(body, conflictRungFailedMarker("abandon", "abc1234"));
  assertStringIncludes(body, "waits");
  assertEquals(
    body.includes("climbs to the following rung"),
    false,
    "there is no rung above the abandon",
  );
  assertEquals(body.includes(CONFLICT_ATTEMPT_MARKER), false);
  assertEquals(body.includes(CONFLICT_RESOLVED_MARKER), false);
});

// ---------------------------------------------------------------------------
// Stage timings and host (Issue #2308)
// ---------------------------------------------------------------------------

/** A logger that keeps every `info` record, so the timings one can be read. */
function makeTimingsLogger(
  records: { message: string; context?: LogContext }[],
): Logger {
  const base = makeSilentLogger();
  return {
    ...base,
    info: (message: string, context?: LogContext) => {
      records.push({ message, context });
    },
  };
}

/** The one structured timings record an attempt emits. */
function timingsRecord(
  records: { message: string; context?: LogContext }[],
): { message: string; context?: LogContext } | undefined {
  return records.find((r) => r.message === "Merge-conflict stage timings");
}

Deno.test("processMergeConflict - the resolved comment carries the stage timings and the host (Issue #2308)", async () => {
  const records: { message: string; context?: LogContext }[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    { logger: makeTimingsLogger(records), hostFn: () => "mel-01" },
  );

  assert(result.ok);
  assertEquals(result.value.merged, true);

  const resolved = captured.comments.at(-1) ?? "";
  assertStringIncludes(resolved, CONFLICT_RESOLVED_MARKER);
  assertStringIncludes(resolved, "Timings (host `mel-01`):");
  // Every stage this attempt ran is named — the deepen, the rules, the issue
  // context, the agent and the push.
  for (const stage of ["deepen", "rules", "issue-context", "agent", "push"]) {
    assertStringIncludes(resolved, stage);
  }
});

Deno.test("processMergeConflict - the structured log record carries the same host and stages (Issue #2308)", async () => {
  const records: { message: string; context?: LogContext }[] = [];
  // An injected clock, advanced five seconds per reading. A stage is bounded
  // by exactly two readings — its start and its stop — so each one costs five
  // seconds and the assertion below never touches a wall clock.
  let clockMs = 0;
  const { result } = await runProcessor(
    makeInput(),
    makeGitScript(),
    {
      logger: makeTimingsLogger(records),
      hostFn: () => "mel-01",
      nowMsFn: () => (clockMs += 5_000),
    },
  );

  assert(result.ok);
  const record = timingsRecord(records);
  assert(record, "the attempt must emit one structured timings record");
  assertEquals(record.context?.host, "mel-01");

  const timings = record.context?.timings as
    | { stage: string; seconds: number | null }[]
    | undefined;
  assert(Array.isArray(timings), "the record must carry the stage report");
  assertEquals(
    timings.map((t) => t.stage),
    ["deepen", "rules", "issue-context", "agent", "push"],
  );
  // Five injected seconds per stage, and every stage finished: a stage that
  // silently went missing, or reported `unfinished`, fails here.
  for (const timing of timings) assertEquals(timing.seconds, 5);
});

Deno.test("processMergeConflict - a failed attempt's conclusion carries the stage timings (Issue #2308)", async () => {
  const records: { message: string; context?: LogContext }[] = [];
  const { captured, result } = await runProcessor(
    makeInput(),
    makeGitScript({ markersAfterAgent: true }),
    { logger: makeTimingsLogger(records), hostFn: () => "syd-07" },
  );

  assert(result.ok);
  assertEquals(result.value.merged, false);

  const conclusion = captured.comments.at(-1) ?? "";
  assertStringIncludes(conclusion, CONFLICT_FAILED_MARKER);
  assertStringIncludes(conclusion, "Timings (host `syd-07`):");
  assertStringIncludes(conclusion, "agent");

  const record = timingsRecord(records);
  assert(record, "a failed attempt must emit its timings record too");
  assertEquals(record.context?.host, "syd-07");
});

Deno.test("buildResolvedComment - appends the timings line last, and omits it when there is none (Issue #2308)", () => {
  const line = "Timings (host `mel-01`): deepen 3s · agent 212s";
  const withTimings = buildResolvedComment(
    "main",
    "issue-16-fix",
    "Merged cleanly.",
    [],
    null,
    line,
  );
  assertStringIncludes(withTimings, line);
  assertEquals(withTimings.trimEnd().endsWith(line), true);

  const without = buildResolvedComment("main", "issue-16-fix");
  assertEquals(without.includes("Timings (host"), false);
});

Deno.test("buildFailedComment - appends the timings line, and omits it when there is none (Issue #2308)", () => {
  const line = "Timings (host `syd-07`): deepen 3s · agent unfinished";
  const withTimings = buildFailedComment(
    1,
    2,
    "main",
    "the agent left 1 path(s) unmerged",
    ["SECURITY.md"],
    line,
  );
  assertStringIncludes(withTimings, line);

  const without = buildFailedComment(1, 2, "main", "boom", ["SECURITY.md"]);
  assertEquals(without.includes("Timings (host"), false);
});

Deno.test("processMergeConflict - an attempt the run ended still logs where its minutes went (Issue #2308)", async () => {
  // The pass that spent twenty minutes under the agent and then died is the
  // one a reader most needs the breakdown for. It concludes on no comment —
  // the marker is deleted and the attempt withdrawn — so the log is the only
  // sink, and an exit that logged nothing would hide exactly that pass.
  const records: { message: string; context?: LogContext }[] = [];
  let clockMs = 0;
  const { result } = await runProcessor(
    makeInput(),
    makeGitScript({ unmergedAfterAgent: ["SECURITY.md"] }),
    {
      logger: makeTimingsLogger(records),
      hostFn: () => "syd-07",
      nowMsFn: () => (clockMs += 5_000),
    },
    { claudeResult: { terminated: true } },
  );

  assert(result.ok);
  assertEquals(result.value.attemptCharged, false);
  const record = timingsRecord(records);
  assert(record, "a withdrawn attempt must still emit its timings record");
  assertEquals(record.context?.host, "syd-07");
  const timings = record.context?.timings as
    | { stage: string; seconds: number | null }[]
    | undefined;
  assert(Array.isArray(timings), "the record carries the stage report");
  assertEquals(
    timings.map((t) => t.stage),
    ["deepen", "rules", "issue-context", "agent"],
  );
  for (const timing of timings) assertEquals(timing.seconds, 5);
});
