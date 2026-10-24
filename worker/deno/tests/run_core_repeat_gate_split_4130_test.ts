/**
 * Issue #4130: a repeat worker-gate failure that reaches the main loop splits
 * the parent issue into sub-issues, and a split is not a failed attempt.
 *
 * Drives the real `processIssue` main loop with an injected `workOnIssue`:
 *   - a repeat pre-push, summary or security-fix gate failure hands
 *     `handleIssueFailure` a split hook when the run holds a branch
 *     (`branchContext`), and no hook when it does not;
 *   - a split outcome records no cooldown kind (`failureKind` absent), while
 *     a recorded repeat keeps `non_transient`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  type FailureCategory,
  PRE_PUSH_GATE_MARKER,
  SECURITY_FIX_GATE_MARKER,
  SUMMARY_RULE_GATE_MARKER,
} from "../lib/failure_diagnosis.ts";
import type {
  HandleFailureOptions,
  HandleFailureResult,
} from "../lib/label_types.ts";
import type {
  IssueContext,
  WorkOnIssueResult,
} from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";
import { envFrom } from "./support/env_lookup.ts";
import { captureContentSnapshot } from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";

const REPO = "org/repo";
const ISSUE = 4130;
const USER = "fleet-bot";
const BRANCH = "issue-4130-repeat-gate";
const SUB_ISSUE_URL = "https://github.com/org/repo/issues/4131";
const TITLE = "Repeat gate";
const BODY = "Gate it.";

/** The three worker gates that split on a repeat (Issue #4130). */
const GATE_CASES: ReadonlyArray<{ category: FailureCategory; reason: string }> =
  [
    {
      category: "pre_push_gate",
      reason: `${PRE_PUSH_GATE_MARKER} the branch carries no change.`,
    },
    {
      category: "summary_incomplete",
      reason: `${SUMMARY_RULE_GATE_MARKER} section 'Evidence' is missing.`,
    },
    {
      category: "security_fix_gate",
      reason: `${SECURITY_FIX_GATE_MARKER} the fix is not evidenced.`,
    },
  ];

function silentLogger(): Logger {
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

/** A logger that keeps every `info` line and its context. */
function capturingLogger(
  infos: Array<{ message: string; context: unknown }>,
): Logger {
  return {
    ...silentLogger(),
    info: (message: string, context?: unknown) => {
      infos.push({ message, context });
    },
  };
}

interface FailedRun {
  /** Every options object `handleIssueFailure` received. */
  handled: HandleFailureOptions[];
  /** Every `info` line the main loop logged, and its context. */
  infos: Array<{ message: string; context: unknown }>;
  /** Every git command the split hook ran, when `invokeHook` is set. */
  gitCalls: string[][];
  /** The cooldown kind the main loop recorded for the run, if any. */
  failureKind: string | undefined;
}

/**
 * Runs one failed issue through `processIssue`. `split` makes the stubbed
 * handler report a split; `withBranch` decides whether the run holds a branch.
 */
async function runFailedIssue(
  category: FailureCategory,
  reason: string,
  opts: {
    withBranch: boolean;
    split: boolean;
    /** The run's milestone branch, when it is on one. */
    milestoneBranch?: string;
    /** A phase already stepped the ladder and split: the loop steps nothing. */
    phaseSplit?: boolean;
    /** Runs the real split hook from the stubbed handler. */
    invokeHook?: boolean;
  },
): Promise<FailedRun> {
  const root = await Deno.makeTempDir();
  const handled: HandleFailureOptions[] = [];
  const infos: Array<{ message: string; context: unknown }> = [];
  const gitCalls: string[][] = [];
  const config = {
    ...buildDefaultWorkerConfig(),
    workDir: root,
    allowedAuthors: [USER],
  };
  // Pickup refuses an issue with no approved content snapshot, so the fixture
  // captures one for the content it serves before the run starts.
  const snapshot = await captureContentSnapshot(
    resolveContentApprovalStateDir(root),
    REPO,
    ISSUE,
    TITLE,
    BODY,
    USER,
  );
  assert(snapshot.ok);
  const worker = createMockDeps({
    logger: silentLogger(),
    git: {
      runGitCommand: ((args: string[]) => {
        gitCalls.push(args);
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }) as never,
    },
    github: {
      // A thread with a fleet-authored failure record, so the real hook gets
      // as far as summarising the branch.
      createClient: (() => ({
        getIssueComments: () =>
          Promise.resolve([{
            id: 1,
            body: "## Automated Processing Failed (First Attempt)",
            author: USER,
            createdAt: "2026-10-01T00:00:00Z",
            reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
          }]),
      })) as never,
      runGhCommand: (args: string[]) =>
        Promise.resolve(
          args[0] === "issue"
            ? JSON.stringify({
              title: TITLE,
              body: BODY,
              author: { login: USER },
              labels: [{ name: "work-on" }],
              comments: [],
              state: "OPEN",
            })
            : "",
        ),
      handleIssueFailure: (async (options: HandleFailureOptions) => {
        handled.push(options);
        if (opts.invokeHook) {
          await options.splitOnRepeatGate?.({ category, gateOutput: reason });
        }
        const value: HandleFailureResult = opts.split
          ? {
            markedAsFailedOnce: false,
            failureCategory: category,
            isInfrastructure: false,
            split: { subIssueUrls: [SUB_ISSUE_URL], notes: [] },
          }
          : {
            markedAsFailedOnce: true,
            failureCategory: category,
            isInfrastructure: false,
          };
        return { ok: true as const, value };
      }) as never,
    },
  });
  const production = await createProductionRunCoreDeps({
    repoDir: root,
    workDir: root,
    githubUser: USER,
    logger: capturingLogger(infos),
    config,
    workerDeps: worker,
    env: envFrom({ HOME: root }),
    workOnIssue: (_ctx: IssueContext) =>
      Promise.resolve<WorkOnIssueResult>({
        success: false,
        category,
        expectedSkip: false,
        phase: "completion",
        reason,
        timings: {},
        ...(opts.phaseSplit ? { ladderApplied: true, issueSplit: true } : {}),
        ...(opts.withBranch
          ? {
            branchContext: {
              branchName: BRANCH,
              repoPath: root,
              defaultBranch: "main",
              ...(opts.milestoneBranch
                ? { milestoneBranch: opts.milestoneBranch }
                : {}),
              reapproved: false,
            },
          }
          : {}),
      }),
  });
  try {
    const processed = await production.deps.processIssue({
      repo: REPO,
      issueNumber: ISSUE,
      issueTitle: TITLE,
      milestoneTitle: "",
    });
    assert(processed.ok, "processIssue must complete");
    return {
      handled,
      infos,
      gitCalls,
      failureKind: processed.value.failureKind,
    };
  } finally {
    production.cleanup();
    await Deno.remove(root, { recursive: true });
  }
}

for (const gate of GATE_CASES) {
  Deno.test(
    `main loop - a repeat ${gate.category} failure with a branch supplies a split hook (Issue #4130)`,
    async () => {
      const { handled } = await runFailedIssue(gate.category, gate.reason, {
        withBranch: true,
        split: false,
      });
      assertEquals(handled.length, 1, "handleIssueFailure must be reached");
      assertEquals(typeof handled[0]?.splitOnRepeatGate, "function");
    },
  );

  Deno.test(
    `main loop - a repeat ${gate.category} failure without a branch supplies no split hook (Issue #4130)`,
    async () => {
      const { handled } = await runFailedIssue(gate.category, gate.reason, {
        withBranch: false,
        split: false,
      });
      assertEquals(handled.length, 1, "handleIssueFailure must be reached");
      assertEquals(handled[0]?.splitOnRepeatGate, undefined);
    },
  );

  Deno.test(
    `main loop - a split ${gate.category} failure records no cooldown kind (Issue #4130)`,
    async () => {
      const { failureKind } = await runFailedIssue(
        gate.category,
        gate.reason,
        { withBranch: true, split: true },
      );
      assertEquals(failureKind, undefined);
    },
  );

  Deno.test(
    `main loop - a recorded repeat ${gate.category} failure keeps non_transient (Issue #4130)`,
    async () => {
      const { failureKind } = await runFailedIssue(
        gate.category,
        gate.reason,
        { withBranch: true, split: false },
      );
      assertEquals(failureKind, "non_transient");
    },
  );
}

const SPLIT_LOG = "Repeat worker-gate failure split into sub-issues";
const DISPOSITION_LOG = "Coding-run failure disposition";

Deno.test("main loop - a ladder split logs the split with its sub-issues and not a disposition (Issue #4130)", async () => {
  const gate = GATE_CASES[0]!;
  const { infos } = await runFailedIssue(gate.category, gate.reason, {
    withBranch: true,
    split: true,
  });

  const splitLogs = infos.filter((line) => line.message === SPLIT_LOG);
  assertEquals(splitLogs.length, 1, "the split is logged once");
  assertEquals(
    (splitLogs[0]?.context as { subIssueUrls?: string[] }).subIssueUrls,
    [SUB_ISSUE_URL],
  );
  assertEquals(
    infos.filter((line) => line.message === DISPOSITION_LOG),
    [],
    "a split has no failure disposition to report",
  );
});

Deno.test("main loop - a recorded repeat logs its disposition and no split (Issue #4130)", async () => {
  const gate = GATE_CASES[0]!;
  const { infos } = await runFailedIssue(gate.category, gate.reason, {
    withBranch: true,
    split: false,
  });

  assertEquals(infos.filter((line) => line.message === SPLIT_LOG), []);
  assertEquals(
    infos.filter((line) => line.message === DISPOSITION_LOG).length,
    1,
  );
});

Deno.test("main loop - a split a phase already made records no cooldown kind and is logged (Issue #4130)", async () => {
  const gate = GATE_CASES[0]!;
  const { handled, infos, failureKind } = await runFailedIssue(
    gate.category,
    gate.reason,
    { withBranch: true, split: false, phaseSplit: true },
  );

  assertEquals(handled.length, 0, "the phase already stepped the ladder");
  assertEquals(failureKind, undefined);
  const splitLogs = infos.filter((line) => line.message === SPLIT_LOG);
  assertEquals(splitLogs.length, 1);
  assertEquals(
    (splitLogs[0]?.context as { subIssueUrls?: string[] }).subIssueUrls,
    undefined,
    "the phase's hook logged the sub-issues; the loop has none to add",
  );
});

for (
  const c of [
    {
      name: "a milestone branch",
      milestone: "milestone/m1",
      base: "milestone/m1",
    },
    { name: "no milestone branch", milestone: undefined, base: "main" },
  ]
) {
  Deno.test(`main loop - the split hook compares the run branch with ${c.name} as its base (Issue #4130)`, async () => {
    const gate = GATE_CASES[0]!;
    const { gitCalls } = await runFailedIssue(gate.category, gate.reason, {
      withBranch: true,
      split: false,
      invokeHook: true,
      ...(c.milestone ? { milestoneBranch: c.milestone } : {}),
    });

    const log = gitCalls.find((args) => args[0] === "log");
    assertEquals(log?.at(-1), `origin/${c.base}..refs/heads/${BRANCH}`);
  });
}
