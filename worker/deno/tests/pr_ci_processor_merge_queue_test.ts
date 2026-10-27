/**
 * The CI-fix processor never asks GitHub about a merge-queue removal's
 * synthetic check id (Issue #4424).
 *
 * A queue removal has no check run or Actions job behind its id, so a lookup
 * under that id would 404 and warn. These tests drive the real
 * `processCiFailure` against recorded `gh` calls: the no-change reply path
 * (which re-runs the failing check for a real id) and the spent-retry path.
 * A real numeric id runs as a control, so the recording is shown to work.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { mergeQueueCheckId } from "../lib/merge_queue_check_id.ts";
import { recordCiCheckRetry } from "../lib/pr_ci_checks.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const REPO = "org/repo";
const HEAD = `abcdef0123456789${"0".repeat(24)}`;
const SYNTH_ID = mergeQueueCheckId(HEAD);
const REAL_ID = "5150";

/** Records every warn message; other levels are discarded. */
function recordingLogger(warns: string[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => void warns.push(message),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface RunRecord {
  ok: boolean;
  summary: string;
  calls: string[][];
  warns: string[];
  actionsLogCalls: number;
}

/**
 * Run one CI fix for `checkRunId` whose agent reply needs no change.
 *
 * `spentRetries` pre-records the retry budget for that id, as a check that
 * has already used all of its attempts would have it.
 */
async function runFix(
  checkRunId: string,
  options: { spentRetries?: boolean } = {},
): Promise<RunRecord> {
  const workDir = await Deno.makeTempDir({ prefix: "ci-mq-processor-" });
  const calls: string[][] = [];
  const warns: string[] = [];
  let actionsLogCalls = 0;
  try {
    const stateDir = `${workDir}/.ci_check_state`;
    if (options.spentRetries) {
      for (let i = 0; i < 3; i++) {
        await recordCiCheckRetry(stateDir, REPO, checkRunId);
      }
    }

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "reviewed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: ((args: string[]) => {
        calls.push(args);
        if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
        return Promise.resolve("");
      }) as GitHubDeps["runGhCommand"],
      createClient: (logger: Logger) => ({
        ...createMockDeps().github.createClient(logger),
        // A fresh pull request: no prior markers to read.
        getIssueComments: () => Promise.resolve([]),
      }),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Nothing committed, nothing pushed: the no-change reply path.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: recordingLogger(warns),
      deps,
      stateDir,
      workDir,
      workRoot: workDir,
      fleetLogins: ["stservice"],
      maxAutoFixAttempts: 3,
      maxCiRetries: 3,
      actionsLogFn: () => {
        actionsLogCalls++;
        return Promise.resolve(
          { kind: "not-applicable", reason: "test" } as const,
        );
      },
    };
    const input: CiFixInput = {
      repo: REPO,
      prNumber: 77,
      branchName: "issue-77-fix",
      checkRunId,
      checkName: "merge queue",
      encodedAnnotations: btoa(JSON.stringify([{
        path: "",
        start_line: 0,
        message: "Removed from the merge queue (test) at 2026-10-02T00:00:00Z",
      }])),
    };
    const result = await processCiFailure(input, processorDeps);
    return {
      ok: result.ok,
      summary: result.ok ? result.value.summary : result.error.message,
      calls,
      warns,
      actionsLogCalls,
    };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/** Every recorded gh call that names an Actions job, a re-run or a check run. */
function actionsOrRerunCalls(calls: string[][]): string[] {
  return calls.map((args) => args.join(" ")).filter((line) =>
    /actions\/jobs|run rerun|check-runs\//.test(line)
  );
}

Deno.test("processCiFailure - a queue removal's synthetic id makes no Actions, check-run or re-run call on the reply path (Issue #4424)", async () => {
  const run = await runFix(SYNTH_ID);

  assertEquals(run.ok, true);
  assertEquals(
    run.calls.filter((a) => a.some((x) => x.includes(SYNTH_ID))),
    [],
  );
  assertEquals(actionsOrRerunCalls(run.calls), []);
  assertEquals(run.actionsLogCalls, 0);
  assertEquals(
    run.warns.filter((w) => w.includes("Could not resolve the Actions run")),
    [],
  );
});

Deno.test("processCiFailure - control: a real check id on the same reply path is re-run and asks for its log (Issue #4424)", async () => {
  const run = await runFix(REAL_ID);

  assertEquals(run.ok, true);
  // The reply path does re-run a real check, so the recording above is live.
  assert(
    actionsOrRerunCalls(run.calls).some((line) =>
      line.includes(`actions/jobs/${REAL_ID}`) || line.includes("run rerun")
    ),
  );
  assertEquals(run.actionsLogCalls, 1);
});

Deno.test("processCiFailure - a spent retry budget on the synthetic id is not re-run and names no lookup (Issue #4424)", async () => {
  const run = await runFix(SYNTH_ID, { spentRetries: true });

  assertEquals(run.ok, true);
  assert(run.summary.includes("exceeded max retries"));
  assertEquals(actionsOrRerunCalls(run.calls), []);
  assertEquals(
    run.calls.filter((a) => a.some((x) => x.includes(SYNTH_ID))),
    [],
  );
  // A re-run under the synthetic id would warn that it could not resolve the
  // Actions run behind that id; the warning must not appear.
  assertEquals(run.warns.filter((w) => w.includes(SYNTH_ID)), []);
});
