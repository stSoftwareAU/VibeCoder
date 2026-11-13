/**
 * The setup phase's potentially blocking steps and the one fixed line each
 * logs as it starts (Issue #5128).
 *
 * A container hard-kill in setup used to report "Last step logged: unknown",
 * because the phase logged only a 60s ticker the report skips as noise. The
 * hard-kill report maps these lines to fixed labels, so a wedge names the step.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The setup steps, in run order. The names are fixed words, never log or issue
 * text, because the hard-kill report publishes the label on a public issue.
 */
export const SETUP_STEPS = [
  "issue claim",
  "claim churn check",
  "repository setup",
  "heartbeat start",
  "default branch sync",
  "feature branch",
  "pre-setup command",
] as const;

/** One of {@link SETUP_STEPS}. */
export type SetupStep = typeof SETUP_STEPS[number];

/** The line a setup step logs as it starts: `[setup-step] <step>: started`. */
export function setupStepStartLine(step: SetupStep): string {
  return `[setup-step] ${step}: started`;
}
