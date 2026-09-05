/**
 * Intent-aware conflict resolution, end to end through the processor
 * (Issue #1114, parent #1076).
 *
 * Three things are asserted here that the unit tests cannot:
 *
 * - the gathered issue context actually reaches the built agent prompt;
 * - the issues consulted are recorded on the attempt itself — including when
 *   the resolution then fails, which is what separates "the resolver looked
 *   and disagreed" from "the resolver never looked";
 * - the mechanical guards still abort a resolution that carries an intent
 *   justification. An intent-justified merge is not a trusted one.
 *
 * The fixtures embed conflict markers at column 0, which is what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below. Nothing here is an unresolved conflict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 *
 * vibe-allow-conflict-markers
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MergeConflictInput,
  type MergeConflictProcessorDeps,
  parseCommentId,
  processMergeConflict,
} from "../lib/pr_merge_conflict_processor.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_RESOLVED_MARKER,
} from "../lib/pr_merge_conflict_scan.ts";
import type {
  ConflictIssueContext,
  OriginatingIssue,
} from "../lib/conflict_issue_context.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

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

function issue(number: number, title: string, body = ""): OriginatingIssue {
  return { number, title, state: "CLOSED", body, bodyTruncated: false };
}

/** Both sides' issues known for `SECURITY.md` — the eligible case. */
function makeIssueContext(
  overrides?: Partial<ConflictIssueContext>,
): ConflictIssueContext {
  return {
    repo: "org/repo",
    prNumber: 48,
    prSide: {
      resolved: true,
      signal: "branch",
      issue: issue(900, "Retune the timeout", "Supersedes #812: use 10s."),
    },
    baseSide: [{
      path: "SECURITY.md",
      commitsInspected: 2,
      prNumbers: [77],
      issues: [issue(812, "Raise the timeout to 60s")],
      unresolved: null,
      partial: false,
    }],
    truncation: {
      commitCapPaths: [],
      issueCapHit: false,
      textTruncatedIssues: [],
      ghCallCapHit: false,
    },
    ghCallsUsed: 4,
    warnings: [],
    ...overrides,
  };
}

interface Captured {
  /** Comment bodies posted with `gh pr comment`. */
  comments: string[];
  /** Comment bodies written by a PATCH of an existing comment. */
  edits: string[];
  agentPrompts: string[];
  commitAndPushCalls: number;
}

interface Script {
  /** Unmerged paths after the agent has run — non-empty means it failed. */
  unmergedAfterAgent: string[];
  /** Whether `git grep` still finds conflict markers after the agent. */
  markersAfterAgent: boolean;
  /** Exit code of `git merge-base --is-ancestor` once the merge has run. */
  ancestorCode: number;
}

function makeGit(script: Script, captured: Captured): Partial<GitDeps> {
  let unmergedQueries = 0;
  let mergeDone = false;
  return {
    runGitCommand: ((args: string[]) => {
      if (args[0] === "merge" && args[1]?.startsWith("origin/")) {
        mergeDone = true;
        return Promise.resolve({
          ok: true,
          value: { code: 1, stdout: "", stderr: "CONFLICT (content)" },
        });
      }
      if (args[0] === "diff" && args.includes("--diff-filter=U")) {
        const paths = unmergedQueries === 0
          ? ["SECURITY.md"]
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

function makeGithub(
  captured: Captured,
  commentUrl: string | null,
): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0) captured.comments.push(String(args[idx + 1] ?? ""));
        return Promise.resolve(commentUrl ?? "");
      }
      if (args[0] === "api" && args.includes("PATCH")) {
        const idx = args.indexOf("-f");
        if (idx >= 0) {
          captured.edits.push(
            String(args[idx + 1] ?? "").slice("body=".length),
          );
        }
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function makeClaude(captured: Captured): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry: ((options: { prompt?: string }) => {
      captured.agentPrompts.push(options?.prompt ?? "");
      return Promise.resolve({
        ok: true,
        value: { output: "resolved", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
}

function makeInput(
  overrides?: Partial<MergeConflictInput>,
): MergeConflictInput {
  return {
    repo: "org/repo",
    prNumber: 48,
    branchName: "issue-900-retune",
    baseBranch: "main",
    attemptCount: 0,
    ...overrides,
  };
}

async function runProcessor(opts?: {
  script?: Partial<Script>;
  input?: Partial<MergeConflictInput>;
  /** `null` gathers nothing; a thrower exercises the degraded path. */
  issueContext?: ConflictIssueContext | null | "throw";
  /** Contents of `.pr_response_message` the agent leaves behind. */
  agentReply?: string;
  /** URL `gh pr comment` prints, or `null` for a client that prints none. */
  commentUrl?: string | null;
}): Promise<{ captured: Captured; result: unknown; merged: boolean }> {
  const captured: Captured = {
    comments: [],
    edits: [],
    agentPrompts: [],
    commitAndPushCalls: 0,
  };
  const script: Script = {
    unmergedAfterAgent: [],
    markersAfterAgent: false,
    ancestorCode: 0,
    ...opts?.script,
  };

  const deps = createMockDeps({
    git: makeGit(script, captured),
    github: makeGithub(
      captured,
      opts?.commentUrl === undefined
        ? "https://github.com/org/repo/pull/48#issuecomment-5150"
        : opts.commentUrl,
    ),
    claude: makeClaude(captured),
  });

  const workDir = await Deno.makeTempDir({ prefix: "vibe-intent-conflict-" });
  if (opts?.agentReply !== undefined) {
    await Deno.writeTextFile(
      `${workDir}/.pr_response_message`,
      opts.agentReply,
    );
  }

  const wanted = opts?.issueContext === undefined
    ? makeIssueContext()
    : opts.issueContext;
  const gatherIssueContextFn =
    (wanted === "throw"
      ? () => Promise.reject(new Error("gh exploded"))
      : () =>
        Promise.resolve(
          wanted ?? {
            repo: "org/repo",
            prNumber: 48,
            prSide: { resolved: false, reason: "no-signal" },
            baseSide: [],
            truncation: {
              commitCapPaths: [],
              issueCapHit: false,
              textTruncatedIssues: [],
              ghCallCapHit: false,
            },
            ghCallsUsed: 0,
            warnings: [],
          },
        )) as unknown as MergeConflictProcessorDeps["gatherIssueContextFn"];

  const result = await processMergeConflict(makeInput(opts?.input), {
    logger: makeSilentLogger(),
    deps,
    workDir,
    promptsDir: PROMPTS_DIR,
    gatherIssueContextFn,
  });

  return {
    captured,
    result,
    merged: result.ok ? result.value.merged : false,
  };
}

/** Every comment body the PR ended up carrying, edits included. */
const audit = (captured: Captured) =>
  [...captured.comments, ...captured.edits].join("\n---\n");

// --- The prompt seam ---

Deno.test("parseCommentId - reads the id GitHub's comment URL names", () => {
  assertEquals(
    parseCommentId("https://github.com/org/repo/pull/48#issuecomment-5150"),
    5150,
  );
  assertEquals(parseCommentId(""), null);
  assertEquals(parseCommentId(undefined), null);
});

Deno.test("processMergeConflict - the agent prompt carries the issue context", async () => {
  const { captured } = await runProcessor();

  const prompt = captured.agentPrompts[0] ?? "";
  assertStringIncludes(prompt, `<document source="github-issues">`);
  assertStringIncludes(prompt, "Issue #900");
  assertStringIncludes(prompt, "Issue #812");
  assertStringIncludes(prompt, "Where an intent override may even be");
  assertStringIncludes(
    prompt,
    "**both sides' issues are known** (PR side #900",
  );
  assertStringIncludes(prompt, "Supersedes #812");
});

Deno.test("processMergeConflict - one side's issue permits no override in the prompt", async () => {
  const { captured } = await runProcessor({
    issueContext: makeIssueContext({
      prSide: { resolved: false, reason: "no-signal" },
    }),
  });

  const prompt = captured.agentPrompts[0] ?? "";
  assertStringIncludes(
    prompt,
    "**no override is permitted**: this PR's own originating issue is unknown",
  );
  assertEquals(
    prompt.includes("**both sides' issues are known**"),
    false,
    "no path qualifies, so no path may be offered as eligible",
  );
});

Deno.test("processMergeConflict - no issue context leaves the prompt as it was", async () => {
  const { captured } = await runProcessor({ issueContext: "throw" });

  const prompt = captured.agentPrompts[0] ?? "";
  assertEquals(prompt.includes(`<document source="github-issues">`), false);
  assertEquals(
    prompt.includes("Where an intent override may even be considered"),
    false,
  );
  assertStringIncludes(prompt, "The Contract — Both Sides Survive");
  assertStringIncludes(
    audit(captured),
    "No originating issues were found",
  );
});

// --- The audit surface ---

Deno.test("processMergeConflict - the attempt records the issues consulted", async () => {
  const { captured } = await runProcessor();

  assertEquals(captured.edits.length, 1);
  const amended = captured.edits[0] ?? "";
  assertStringIncludes(amended, CONFLICT_ATTEMPT_MARKER);
  assertStringIncludes(amended, "attempt 1 of 2");
  assertStringIncludes(amended, "Issues consulted");
  assertStringIncludes(amended, "#900");
  assertStringIncludes(amended, "`SECURITY.md` — #812");
});

Deno.test("processMergeConflict - a failed attempt still records what was consulted", async () => {
  const { captured, merged } = await runProcessor({
    script: { markersAfterAgent: true },
  });

  assertEquals(merged, false);
  assertStringIncludes(audit(captured), "Issues consulted");
  assertStringIncludes(audit(captured), "`SECURITY.md` — #812");
});

Deno.test("processMergeConflict - an unamendable attempt comment still gets the record", async () => {
  const { captured } = await runProcessor({ commentUrl: null });

  assertEquals(captured.edits, []);
  assertStringIncludes(captured.comments.join("\n"), "Issues consulted");
});

Deno.test("processMergeConflict - paths with no discoverable issue are named", async () => {
  const { captured } = await runProcessor({
    issueContext: makeIssueContext({
      baseSide: [{
        path: "SECURITY.md",
        commitsInspected: 1,
        prNumbers: [],
        issues: [],
        unresolved: "no-pr",
        partial: false,
      }],
    }),
  });

  const amended = captured.edits[0] ?? "";
  assertStringIncludes(amended, "`SECURITY.md` — none found");
  assertStringIncludes(amended, "No originating issue was discoverable");
});

Deno.test("processMergeConflict - the resolved comment names the override", async () => {
  const { captured, merged } = await runProcessor({
    agentReply: "Merged the base in.\n" +
      "Intent override: SECURITY.md — kept #900, superseded #812 — kept the " +
      "10s timeout; #900 retunes the 60s default #812 set",
  });

  assertEquals(merged, true);
  const resolved = captured.comments.at(-1) ?? "";
  assertStringIncludes(resolved, CONFLICT_RESOLVED_MARKER);
  assertStringIncludes(resolved, "Settled by issue intent");
  assertStringIncludes(resolved, "`SECURITY.md`");
  assertStringIncludes(resolved, "kept #900, superseded #812");
  assertStringIncludes(resolved, "60s default");
});

// --- The guards are not relaxed by a justification ---

Deno.test("processMergeConflict - leftover markers abort even with an intent justification", async () => {
  const { captured, merged } = await runProcessor({
    script: { markersAfterAgent: true },
    agentReply: "Intent override: SECURITY.md — kept #900, superseded #812 — " +
      "#900 supersedes #812\n<<<<<<< HEAD",
  });

  assertEquals(merged, false);
  assertEquals(captured.commitAndPushCalls, 0);
  assertStringIncludes(audit(captured), "conflict markers");
  assert(
    !audit(captured).includes("Settled by issue intent"),
    "an aborted resolution must not report an override as landed",
  );
});

Deno.test("processMergeConflict - an unmerged path aborts even with an intent justification", async () => {
  const { captured, merged } = await runProcessor({
    script: { unmergedAfterAgent: ["SECURITY.md"] },
    agentReply: "Intent override: SECURITY.md — kept #900, superseded #812 — " +
      "#900 supersedes #812",
  });

  assertEquals(merged, false);
  assertEquals(captured.commitAndPushCalls, 0);
  assertStringIncludes(audit(captured), "unmerged");
});

Deno.test("processMergeConflict - a base still not an ancestor fails an intent-justified merge", async () => {
  const { captured, merged } = await runProcessor({
    script: { ancestorCode: 1 },
    agentReply: "Intent override: SECURITY.md — kept #900, superseded #812 — " +
      "#900 supersedes #812",
  });

  assertEquals(merged, false);
  assertStringIncludes(audit(captured), "did not produce a mergeable branch");
  assert(
    !audit(captured).includes(CONFLICT_RESOLVED_MARKER),
    "a branch the base is not an ancestor of is not a resolved conflict",
  );
});

Deno.test("processMergeConflict - an override with no evidence is refused, not reported", async () => {
  const { captured, merged } = await runProcessor({
    // Only the PR side's issue is known, so no path qualifies.
    issueContext: makeIssueContext({
      baseSide: [{
        path: "SECURITY.md",
        commitsInspected: 1,
        prNumbers: [],
        issues: [],
        unresolved: "no-pr",
        partial: false,
      }],
    }),
    agentReply: "Intent override: SECURITY.md — kept #900, superseded #812 — " +
      "#900 looks newer so it probably wins",
  });

  assertEquals(merged, false);
  assertEquals(captured.commitAndPushCalls, 0);
  assertStringIncludes(audit(captured), "on issue intent, but both sides'");
  assertStringIncludes(audit(captured), "`SECURITY.md`");
});

Deno.test("processMergeConflict - an evidenced override still lands", async () => {
  const { merged } = await runProcessor({
    agentReply: "Intent override: ./SECURITY.md — kept #900, superseded #812 " +
      "— #900 retunes what #812 set",
  });

  assertEquals(
    merged,
    true,
    "a path written with a ./ prefix is the same file, not an unevidenced pick",
  );
});
