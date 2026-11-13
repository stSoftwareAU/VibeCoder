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

/**
 * How long the setup phase may run before the run abandons it (Issue #5128).
 *
 * Every setup subprocess is already bounded (git 60-120s, pre-setup command
 * 300s by default), so a setup that is still running after an hour is wedged
 * on a step that will not return. On `GRQ-25` one sat in setup for over two
 * hours, holding its claim, until the launcher's watchdog reaped the
 * container and the run never released the claim. Abandoning setup at this
 * deadline ends the run with a `timeout` failure, so the normal failure path
 * releases the claim while the worker is still alive.
 */
export const SETUP_PHASE_DEADLINE_MS = 60 * 60 * 1000;

let setupPhaseDeadlineMs = SETUP_PHASE_DEADLINE_MS;

/** Override the setup deadline; omit to restore the default. Tests only. */
export function setSetupPhaseDeadlineForTests(ms?: number): void {
  setupPhaseDeadlineMs = ms ?? SETUP_PHASE_DEADLINE_MS;
}

/** The setup-phase result a run ends with when setup misses its deadline. */
export interface SetupDeadlineFailure {
  status: "failure";
  category: "timeout";
  reason: string;
}

/**
 * Run the setup phase under {@link SETUP_PHASE_DEADLINE_MS} (Issue #5128).
 *
 * Returns the phase's own result when it settles first. Otherwise returns a
 * `timeout` failure and stops waiting: the wedged step is left behind, and the
 * run goes on to release its claim. A rejection after the deadline is
 * swallowed, because nothing is waiting for it.
 */
export async function runSetupWithDeadline<T>(
  setup: () => Promise<T>,
): Promise<T | SetupDeadlineFailure> {
  const deadlineMs = setupPhaseDeadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = setup();
  const expired = new Promise<SetupDeadlineFailure>((resolve) => {
    timer = setTimeout(() => {
      pending.catch(() => {});
      resolve({
        status: "failure",
        category: "timeout",
        reason:
          `Setup did not finish within ${
            Math.round(deadlineMs / 60000)
          } minutes, so the run abandoned it to release its claim ` +
          "(Issue #5128).",
      });
    }, deadlineMs);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}
