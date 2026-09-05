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
 * The information is not lost by skipping: CI runs the same checks on the PR
 * in parallel shards on dedicated runners, and the worker runs its own gate
 * (`phases/quality_gate_remediation_phase.ts`) after the agent stops. The
 * agent's run is the third copy — the one paid for out of the run budget.
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
    "and the tests covering the change) were run instead; CI runs the full " +
    "gate on this PR, and the worker runs it again before the PR is raised.",
  ].join("\n");
}

/**
 * The gate instruction an agent's prompt carries (Issue #1138).
 *
 * One source of truth for every prompt that has a `{{QUALITY_INSTRUCTIONS}}`
 * placeholder, so the fleet cannot drift back to "run the gate before you
 * push" in one template while another is budget-aware.
 *
 * @param command - The repository's gate command (`./quality.sh` unless the
 *   repo configured its own).
 * @param typicalGateSeconds - What the gate took on this repository this run,
 *   when it was measured.
 * @returns One prompt bullet per line, ready to join.
 */
export function buildQualityGateBudgetLines(
  command: string,
  typicalGateSeconds?: number,
): string[] {
  const decision = decideQualityGateRun(
    typicalGateSeconds === undefined ? {} : { typicalGateSeconds },
  );
  const duration = describeGateDuration(decision.gateSeconds);
  const cost = decision.measured
    ? `it took ${duration} on this repository this run (measured)`
    : `it takes about ${duration}`;

  return [
    `   - Before you finish, and only when the run budget covers it (next line), run ${command} < /dev/null once, in the foreground, and fix whatever it reports. Re-run it after a fix — never on a timer.`,
    `   - The gate is not free: ${cost}, so it needs about ${decision.requiredSeconds}s of run budget including the time to fix, commit and push what it reports. Read \`.vibe-run-budget.md\` before you start it — the worker writes that file once the runway can no longer cover the gate, and it says so explicitly. If it exists and refuses the gate, do NOT start it; if it does not exist, the run still has the runway and the gate is yours to run.`,
    `   - A skipped gate must be recorded, never silent. Put the \`${GATE_SKIP_MARKER} … -->\` note in the PR summary (or \`.pr_response_message\`) saying the gate was skipped for budget, and push what you have. CI runs the same checks on the PR and the worker runs the gate again before the PR is raised.`,
  ];
}
