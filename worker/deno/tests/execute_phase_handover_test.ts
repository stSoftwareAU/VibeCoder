/**
 * Tests for the handover note the execute phase commits when a run is
 * interrupted (Issue #769, part of #764).
 *
 * The code already survived an interruption; the intent did not. Each
 * preservation path — hard timeout, scheduled release (the worker's own
 * shutdown), and the supervisor's hard-cap wind-down — must leave a
 * portable note in the clone BEFORE the preserving commit runs, so the same
 * `commitAndPushPending` carries it to the claim-locked branch.
 *
 * The three paths are exercised independently rather than assumed to share
 * code: the timeout path is the one that failed on #732, and it is the path
 * where no agent is alive to help.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { handoverNotePath } from "../lib/handover_note.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

const ISSUE = 732;
const BRANCH = "issue-732-preserve-the-intent-too";
const NOTE = handoverNotePath(ISSUE);

/** A hard timeout: the agent's own budget expired. */
const TIMED_OUT = {
  output: "editing the parser, running deno test",
  exitCode: 124,
  rawExitCode: 143,
  timedOut: true,
  timeoutReason: "hard-timeout",
};

/** The supervisor's hard cap stopped a still-progressing run. */
const HARD_CAP_WIND_DOWN = { ...TIMED_OUT, scheduledRelease: "hard-cap" };

/** The worker's own shutdown ended the run: the cycle is over. */
const WORKER_SHUTDOWN = {
  output: "editing the parser, running deno test",
  exitCode: 143,
  rawExitCode: 143,
  terminated: true,
};

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: ISSUE,
    issueTitle: "Preserve the intent too",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now() - 1_800_000,
    executeStartHeadSha: "abc123",
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

interface HandoverRun {
  /** The note as it stood when the preserving commit was made. */
  noteAtCommit?: string;
  /** Commit subjects `commitAndPushPending` was asked to preserve. */
  commits: string[];
  reason: string;
  warns: string[];
}

/**
 * Drive one interrupted execute against a real temporary clone and report
 * what the preserving commit would have carried.
 */
async function runInterrupted(options: {
  runnerValue: Record<string, unknown>;
  /** Files `git status --porcelain` reports as uncommitted. */
  dirty?: string[];
  /** Make the note unwritable, to exercise the non-fatal failure path. */
  blockHandover?: boolean;
}): Promise<HandoverRun> {
  const repoPath = await Deno.makeTempDir();
  const warns: string[] = [];
  const commits: string[] = [];
  let noteAtCommit: string | undefined;
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    if (options.blockHandover) {
      // A file where the handover directory must go: the write fails.
      await Deno.mkdir(`${repoPath}/docs`);
      await Deno.writeTextFile(`${repoPath}/docs/handover`, "in the way");
    }
    const dirty = options.dirty ?? ["worker/deno/lib/parser.ts"];
    const deps = createMockDeps({
      logger: { warn: (m: string) => warns.push(m) },
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({ ok: true, value: options.runnerValue })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: false, error: new Error("No PR") })) as never,
      },
      git: {
        runGitCommand: ((args: string[]) => {
          const ok = (stdout: string) =>
            Promise.resolve({
              ok: true,
              value: { code: 0, stdout, stderr: "" },
            });
          if (args[0] === "status") {
            return ok(
              dirty.map((f) =>
                ` M ${f}`
              ).join("\n"),
            );
          }
          if (args[0] === "rev-list" && args[1] === "--count") return ok("2\n");
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return ok("abc123\n");
          }
          if (args[0] === "log") {
            return ok("wip: earlier snapshot\nWIP checkpoint: snapshot\n");
          }
          if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
            return ok(`${BRANCH}\n`);
          }
          return ok("");
        }) as never,
        commitAndPushPending: ((_branch: string, message: string) => {
          commits.push(message);
          // What `git add -A` would stage: read the tree as it stands now.
          try {
            noteAtCommit = Deno.readTextFileSync(`${repoPath}/${NOTE}`);
          } catch {
            noteAtCommit = undefined;
          }
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 1,
              finalUnpushedCount: 0,
              finalUnpushedSource: "remote-head" as const,
            },
          });
        }) as never,
      },
    });
    const config = makeConfig();
    const result = await workOnIssueExecuteClaude(
      makeContext(config),
      makeState(repoPath),
      deps,
    );
    const reason = "reason" in result ? result.reason ?? "" : "";
    return { noteAtCommit, commits, reason, warns };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("execute_phase #769 - a hard timeout commits the handover note", async () => {
  const run = await runInterrupted({ runnerValue: TIMED_OUT });
  assert(
    run.noteAtCommit,
    `the note must exist when the preserving commit runs; commits: ${
      run.commits.join(" | ")
    }`,
  );
  assertStringIncludes(run.noteAtCommit, `# Handover — issue #${ISSUE}`);
  assertStringIncludes(run.noteAtCommit, "timed out");
  assertStringIncludes(run.noteAtCommit, BRANCH);
  assertStringIncludes(run.noteAtCommit, "worker/deno/lib/parser.ts");
  assertStringIncludes(run.noteAtCommit, "## What remains");
  assertStringIncludes(run.reason, NOTE);
});

Deno.test("execute_phase #769 - a scheduled release commits the handover note", async () => {
  const run = await runInterrupted({ runnerValue: WORKER_SHUTDOWN });
  assert(run.noteAtCommit, "the shutdown path must write the note too");
  assertStringIncludes(run.noteAtCommit, "released on schedule");
  assertEquals(
    run.noteAtCommit.includes("timed out"),
    false,
    "a scheduled release is not a timeout",
  );
  assertStringIncludes(run.reason, NOTE);
});

Deno.test("execute_phase #769 - a hard-cap wind-down commits the handover note", async () => {
  const run = await runInterrupted({ runnerValue: HARD_CAP_WIND_DOWN });
  assert(run.noteAtCommit, "the hard-cap path must write the note too");
  assertStringIncludes(run.noteAtCommit, "released on schedule");
  assertStringIncludes(run.reason, NOTE);
});

Deno.test("execute_phase #769 - the committed note is portable across hosts and providers", async () => {
  const run = await runInterrupted({ runnerValue: TIMED_OUT });
  const note = (run.noteAtCommit ?? "").toLowerCase();
  assert(note.length > 0);
  for (
    const forbidden of [
      "/home/",
      "/users/",
      "/tmp/",
      "/private/var/",
      "session id",
      "sessionid",
      "--resume",
      "claude",
      "codex",
      "${workdir}",
      ".claude-sessions",
    ]
  ) {
    assertEquals(
      note.includes(forbidden),
      false,
      `the committed handover leaked '${forbidden}':\n${note}`,
    );
  }
});

Deno.test("execute_phase #769 - a failed handover write is logged and the work is still preserved", async () => {
  const run = await runInterrupted({
    runnerValue: TIMED_OUT,
    blockHandover: true,
  });
  assertEquals(run.noteAtCommit, undefined);
  // The WIP commit still happened — losing the note never costs the code.
  assertEquals(run.commits.length, 1);
  assertStringIncludes(run.commits[0] ?? "", "wip: execute timed out");
  assert(
    run.warns.some((w) => w.toLowerCase().includes("handover")),
    `expected a logged warning, got: ${run.warns.join(" | ")}`,
  );
  assertEquals(run.reason.includes(NOTE), false, run.reason);
});

Deno.test("execute_phase #769 - a clean tree with checkpoint commits still commits the note", async () => {
  const run = await runInterrupted({ runnerValue: TIMED_OUT, dirty: [] });
  assert(
    run.noteAtCommit,
    "the phase-end checkpoint leaves a clean tree — the note must still land",
  );
  assertEquals(run.commits.length, 1);
  assertStringIncludes(run.commits[0] ?? "", "handover note");
  assertStringIncludes(run.reason, "checkpoint commit");
  assertStringIncludes(run.reason, NOTE);
});
