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

interface FailedRun {
  /** Every options object `handleIssueFailure` received. */
  handled: HandleFailureOptions[];
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
  opts: { withBranch: boolean; split: boolean },
): Promise<FailedRun> {
  const root = await Deno.makeTempDir();
  const handled: HandleFailureOptions[] = [];
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
    github: {
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
      handleIssueFailure: ((options: HandleFailureOptions) => {
        handled.push(options);
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
        return Promise.resolve({ ok: true as const, value });
      }) as never,
    },
  });
  const production = await createProductionRunCoreDeps({
    repoDir: root,
    workDir: root,
    githubUser: USER,
    logger: silentLogger(),
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
        ...(opts.withBranch
          ? {
            branchContext: {
              branchName: BRANCH,
              repoPath: root,
              defaultBranch: "main",
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
    return { handled, failureKind: processed.value.failureKind };
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
