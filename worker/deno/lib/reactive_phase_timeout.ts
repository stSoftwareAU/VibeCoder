/**
 * The wall-clock budget for a reactive phase (Issue #213, root cause of the
 * `ci_fix_timeout` discrepancy).
 *
 * A *reactive* phase services an existing PR — PR feedback and CI fix — as
 * opposed to the issue work `claude_timeout` sizes. Issue #1824 gave each its
 * own key precisely so it would not inherit the hour-long issue-work budget,
 * and `docs/CONFIGURATION.md` documents them as 1800 s.
 *
 * The run-core dispatch path did not honour that: it handed the processors
 * `config.claudeTimeout`, so a host with `claude_timeout: 3600` logged
 * "Running Claude Code with 3600s timeout" for a CI fix — twice the documented
 * budget, and long enough to hold the whole cycle. (The single-shot CLI path
 * always used the dedicated key.) Resolving the budget here means the two
 * paths cannot drift again.
 *
 * The fallback deliberately lands on the phase's own operational default, not
 * on `claude_timeout`: a phase budget that has gone missing must degrade to
 * the documented reactive value, never quietly to the issue-work one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { WorkerConfig } from "../types.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

/** A phase that services an open PR rather than working a claimed issue. */
export type ReactivePhase = "pr-feedback" | "ci-fix";

/** The documented default for each reactive phase. */
const PHASE_DEFAULT: Record<ReactivePhase, number> = {
  "pr-feedback": OPERATIONAL_DEFAULTS.prFeedbackTimeout,
  "ci-fix": OPERATIONAL_DEFAULTS.ciFixTimeout,
};

/**
 * Seconds a reactive phase's agent may run.
 *
 * @param config - The loaded worker configuration.
 * @param phase - Which reactive phase is about to run.
 * @returns The phase's configured budget, or its own documented default when
 *   the configured value is missing or not a positive number.
 */
export function reactivePhaseTimeout(
  config: Pick<WorkerConfig, "prFeedbackTimeout" | "ciFixTimeout">,
  phase: ReactivePhase,
): number {
  const configured = phase === "ci-fix"
    ? config.ciFixTimeout
    : config.prFeedbackTimeout;
  return typeof configured === "number" && configured > 0
    ? configured
    : PHASE_DEFAULT[phase];
}
