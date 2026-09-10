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
  buildConflictEscalationReason,
  buildResolvedComment,
  buildRuleResolutionSection,
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
} from "../lib/pr_merge_conflict_scan.ts";
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

  return {
    runGitCommand: ((args: string[]) => {
      captured.gitArgs.push(args);
      captured.events.push(`git:${args.slice(0, 2).join(" ")}`);

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
        return Promise.resolve({
          ok: true,
          value: {
            code: mergeDone ? script.ancestorCode : 1,
            stdout: "",
            stderr: "",
          },
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
): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "comment") {
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
        // The stand-down guard reads the thread before it comments, and an
        // unreadable thread posts nothing (Issue #1772).
        return Promise.resolve(
          JSON.stringify({
            comments: existingPrComments.map((body) => ({ body })),
          }),
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
  };

  const deps = createMockDeps({
    git: makeGit(script, captured),
    github: makeGithub(
      captured,
      opts?.postedCommentId,
      opts?.existingPrComments ?? [],
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
        return Promise.resolve({ outcome: "abandoned", issueNumber: 16 });
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
        return Promise.resolve({ outcome: "abandoned", issueNumber: 16 });
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
        return Promise.resolve({ outcome: "abandoned", issueNumber: 16 });
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

Deno.test("processMergeConflict - an abandon the worker cannot re-label names the issue and label (Issue #1773)", async () => {
  // The rung closed the PR and reopened the issue; the label a trusted author
  // must re-apply is the operator-facing fact, and `needs-human` belongs on
  // that issue rather than on the PR the rung has already closed.
  const { captured, result } = await runProcessor(
    makeInput({ attemptCount: DEFAULT_MAX_CONFLICT_ATTEMPTS - 1 }),
    makeGitScript({ markersAfterAgent: true }),
    {
      abandonRestartFn: () =>
        Promise.resolve({
          outcome: "abandoned-unlabelled",
          issueNumber: 16,
          workLabel: "work-on",
        }),
    },
  );

  assert(result.ok);
  assertEquals(result.value.escalated, false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertStringIncludes(result.value.summary, "reopened issue #16");
  assertStringIncludes(result.value.summary, "`work-on`");
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
