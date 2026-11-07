/**
 * Does the full quality gate fit in what is left of the run? (Issue #1138)
 *
 * The gate is the most expensive thing an agent can start. Across 407
 * observations of a run's most recent tool call being `./quality.sh`, the
 * median elapsed time was 17 minutes and agents were still inside it at 49–68
 * minutes — inside a budget of roughly an hour. An agent that starts it with
 * ten minutes left cannot finish it, cannot act on what it reports, and loses
 * the runway it needed to commit and push.
 *
 * For issue completion, the information is not lost by skipping: the worker
 * runs its own gate (`phases/quality_gate_remediation_phase.ts`) after the
 * agent stops, before the PR is raised. Other flows describe their own push
 * checks through `GatePushGuarantee` below.
 *
 * So the rule this module encodes is: run the gate when the remaining budget
 * covers it *and* the tail needed to fix, commit and push what it reports;
 * otherwise skip it and say so where a reviewer will see it. Silence is not an
 * option — a skipped gate that nobody records reads exactly like a gate that
 * passed.
 *
 * Pure: no clock, no I/O. Every input is passed in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * What the full gate is assumed to cost when nothing has measured it.
 *
 * 900s is the median of the 407 observations in Issue #1138, rounded down to
 * the nearest quarter hour. It is deliberately an assumption of the *typical*
 * run, not the worst case: a measured duration always wins over it.
 */
export const ASSUMED_GATE_SECONDS = 900;

/**
 * Runway kept back for what happens *after* the gate — fixing what it
 * reported, re-running the targeted check, committing and pushing.
 *
 * Without it a run that fits the gate exactly still ends with the findings
 * unfixed and nothing pushed, which is the worst of both outcomes: the whole
 * cost of the gate paid, and none of its value taken.
 */
export const GATE_TAIL_SECONDS = 180;

/** Marker a skipped gate is recorded under, on the PR or in the reply. */
export const GATE_SKIP_MARKER = "<!-- vibe-quality-gate-skipped";

/** What the decision is made against. */
export interface GateBudget {
  /**
   * Seconds of run budget left, as reported by the wind-down notice
   * (`.vibe-run-budget.md`). `undefined` means no notice exists, which means
   * the run is nowhere near its cap.
   */
  remainingSeconds?: number;
  /**
   * What the gate actually took on this repository, when something measured
   * it — the baseline gate run this cycle. Anything non-finite or
   * non-positive is ignored in favour of {@link ASSUMED_GATE_SECONDS}.
   */
  typicalGateSeconds?: number;
}

/** Whether to start the gate, and the figures the answer was reached with. */
export interface GateBudgetDecision {
  /** True when the gate fits the remaining budget. */
  run: boolean;
  /** Duration used for the gate itself — measured when known, assumed otherwise. */
  gateSeconds: number;
  /** `gateSeconds` plus {@link GATE_TAIL_SECONDS}. */
  requiredSeconds: number;
  /** Seconds of budget the decision saw; `undefined` when no notice existed. */
  remainingSeconds?: number;
  /** True when {@link gateSeconds} came from a measurement rather than the assumption. */
  measured: boolean;
  /** One sentence naming the figures and the verdict. */
  reason: string;
}

/** A positive, finite duration, or `undefined`. */
function usableSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

/**
 * Render a duration the way an operator reads it: minutes once it is long
 * enough for minutes to be the useful unit, seconds below that.
 */
export function describeGateDuration(seconds: number): string {
  if (seconds >= 120) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * Decide whether the full gate should be started.
 *
 * A budget that is absent means no wind-down notice has been written, so the
 * run is not near its cap and the gate runs — refusing on an unknown budget
 * would skip the gate on every healthy run. A budget that is present but
 * nonsense (negative, NaN) is treated as exhausted: the safe reading of a
 * broken figure is that there is no time left, not that there is plenty.
 *
 * @param budget - Remaining run budget and the gate's typical duration.
 * @returns The verdict and the figures behind it.
 */
export function decideQualityGateRun(budget: GateBudget): GateBudgetDecision {
  const measuredSeconds = usableSeconds(budget.typicalGateSeconds);
  const gateSeconds = measuredSeconds ?? ASSUMED_GATE_SECONDS;
  const requiredSeconds = gateSeconds + GATE_TAIL_SECONDS;
  const source = measuredSeconds === undefined
    ? `assumed ${describeGateDuration(gateSeconds)}`
    : `measured ${describeGateDuration(gateSeconds)}`;

  if (budget.remainingSeconds === undefined) {
    return {
      run: true,
      gateSeconds,
      requiredSeconds,
      measured: measuredSeconds !== undefined,
      reason:
        `Run the full gate: no run-budget notice exists, so the run is not ` +
        `near its cap (gate ${source}).`,
    };
  }

  const remainingSeconds = Number.isFinite(budget.remainingSeconds)
    ? Math.max(0, Math.round(budget.remainingSeconds))
    : 0;
  const run = remainingSeconds >= requiredSeconds;

  return {
    run,
    gateSeconds,
    requiredSeconds,
    remainingSeconds,
    measured: measuredSeconds !== undefined,
    reason: run
      ? `Run the full gate: ${remainingSeconds}s of run budget remain and it ` +
        `needs ${requiredSeconds}s (gate ${source} plus ${GATE_TAIL_SECONDS}s ` +
        `to fix, commit and push).`
      : `The full gate is skipped: it needs ${requiredSeconds}s (gate ` +
        `${source} plus ${GATE_TAIL_SECONDS}s to fix, commit and push) and ` +
        `only ${remainingSeconds}s of run budget remain.`,
  };
}

/**
 * The note a skipped gate is recorded with, for the PR summary or the reply.
 *
 * Returns `""` for a decision that ran the gate, so a caller can emit it
 * unconditionally without having to re-test the verdict.
 *
 * @param decision - The verdict from {@link decideQualityGateRun}.
 * @returns Markdown carrying {@link GATE_SKIP_MARKER}, or `""`.
 */
export function formatQualityGateSkipNote(
  decision: GateBudgetDecision,
): string {
  if (decision.run) return "";
  const remaining = decision.remainingSeconds ?? 0;
  return [
    `${GATE_SKIP_MARKER} required="${decision.requiredSeconds}s" ` +
    `remaining="${remaining}s" -->`,
    "",
    "**Full quality gate skipped — not enough run budget.** " +
    `${decision.reason} The targeted checks (formatter, linter, type check ` +
    "and the tests covering the change) were run instead; the worker runs the " +
    "full gate again before the PR is raised.",
  ].join("\n");
}

/**
 * What the worker runs before it pushes, which decides what a skipped gate's
 * record may promise (Issue #4876).
 *
 * - `"full-gate"`: issue completion runs the full gate before PR creation.
 * - `"ci-fix"`: the worker attempts the full gate when Claude leaves
 *   uncommitted changes, then runs configured pre-flight commands before its
 *   push.
 * - `"pre-flight-only"`: PR feedback and spelling fixes do not run a full
 *   gate. Configured pre-flight commands enable changed-file checks; PR-review
 *   feedback also runs an independent fix verifier without that configuration.
 * - `"agent-pre-push"`: a custom PR prompt's agent hook runs changed-file
 *   checks and configured pre-flight commands when the agent pushes.
 */
export type GatePushGuarantee =
  | "full-gate"
  | "ci-fix"
  | "pre-flight-only"
  | "agent-pre-push";

/**
 * The gate instruction an agent's prompt carries (Issue #1138).
 *
 * One source of truth for prompts that have a `{{QUALITY_INSTRUCTIONS}}`
 * placeholder, so the budget decision and push-path record stay together.
 *
 * A caller may pass the whole run's budget at prompt-build time. If the gate
 * cannot fit, it is refused outright; the record then describes the checks
 * that caller's push path actually performs. A live budget notice can make
 * the same decision during issue execution.
 *
 * @param command - The repository's gate command (`./quality.sh` unless the
 *   repo configured its own).
 * @param typicalGateSeconds - What the gate took on this repository this run,
 *   when it was measured.
 * @param runBudgetSeconds - The whole run's wall-clock budget, when the
 *   caller knows it.
 * @param pushGuarantee - What the worker runs before it pushes, which names
 *   what the skip record may promise: `"full-gate"` (issue completion) says
 *   the worker runs the gate before the PR is raised; `"ci-fix"` says the
 *   worker attempts it when Claude leaves uncommitted changes, then runs configured
 *   pre-flight commands before its push; `"pre-flight-only"` (feedback and
 *   spelling fixes) excludes a full gate, while describing conditional
 *   pre-flight/changed-file checks and the PR-review fix verifier;
 *   `"agent-pre-push"` (custom PR prompts) describes the agent's hook, which
 *   runs changed-file checks and configured pre-flight commands when the
 *   agent pushes.
 * @returns One prompt bullet per line, ready to join.
 */
export function buildQualityGateBudgetLines(
  command: string,
  typicalGateSeconds?: number,
  runBudgetSeconds?: number,
  pushGuarantee: GatePushGuarantee = "full-gate",
): string[] {
  const decision = decideQualityGateRun({
    ...(typicalGateSeconds === undefined ? {} : { typicalGateSeconds }),
    ...(runBudgetSeconds === undefined
      ? {}
      : { remainingSeconds: runBudgetSeconds }),
  });
  const duration = describeGateDuration(decision.gateSeconds);
  const cost = decision.measured
    ? `it took ${duration} on this repository this run (measured)`
    : `it takes about ${duration}`;
  const recordCore =
    `   - A skipped gate must be recorded, never silent. Put the \`${GATE_SKIP_MARKER} … -->\` note in the PR summary (or \`.pr_response_message\`) saying the gate was skipped for budget, and push what you have.`;
  const record = pushGuarantee === "pre-flight-only"
    ? `${recordCore} This PR already exists. The worker does not run the full gate before this push. Configured pre-flight commands enable changed-file checks and run before the worker push. PR-review feedback also runs its fix verifier, even without configured pre-flight commands. Name exactly which checks you ran, and do not say the worker will run the full gate.`
    : pushGuarantee === "ci-fix"
    ? `${recordCore} The worker attempts the full gate if Claude leaves uncommitted changes after the fix; before its push, it also runs the repository's configured pre-flight commands, if any. If Claude leaves no uncommitted changes and no pre-flight commands are configured, the worker runs no checks before that push. Name exactly which checks you ran.`
    : pushGuarantee === "agent-pre-push"
    ? `${recordCore} This custom PR flow's agent pre-push hook runs changed-file checks and the repository's configured pre-flight commands, if any, when the agent pushes. The worker verifies the push after the agent finishes; it does not run a full gate before that push. Name exactly which checks you ran.`
    : `${recordCore} The worker runs the gate again before the PR is raised.`;

  // The gate cannot fit this run at all — no live signal can rescue that, so
  // it is settled here rather than left to the agent's judgement.
  if (!decision.run) {
    return [
      `   - Do NOT run ${command} in this run. ${decision.reason} Run the targeted checks instead — formatter, linter, type check and the tests covering what you changed.`,
      record,
    ];
  }

  const share = runBudgetSeconds === undefined
    ? ""
    : ` — about ${
      Math.round((decision.requiredSeconds / runBudgetSeconds) * 100)
    }% of this run's ${runBudgetSeconds}s budget, so start it while you can still see that much runway ahead`;

  return [
    `   - Before you finish, and only when the run budget covers it (next line), run ${command} < /dev/null once, in the foreground, and fix whatever it reports. Re-run it after a fix — never on a timer.`,
    `   - The gate is not free: ${cost}, so it needs about ${decision.requiredSeconds}s of run budget including the time to fix, commit and push what it reports${share}. Read \`.vibe-run-budget.md\` before you start it — the worker writes that file once the runway can no longer cover the gate, and it says so explicitly. If it exists and refuses the gate, do NOT start it.`,
    record,
  ];
}
