/**
 * Heartbeat progress lines for non-agent phases (Issue #4305).
 *
 * Issue #4169 gave the *agent* phases periodic progress lines, but the
 * phases around the agent became the silent stretch: observed live, a
 * claim of VibeCoder#4281 logged `Processing issue …` and then nothing
 * for 43+ minutes while setup/clone/baseline work ran — from the outside
 * indistinguishable from a wedged VM, which is precisely the #4169
 * complaint one layer down.
 *
 * Every phase now logs a start line, a heartbeat while it runs (~60 s
 * cadence), and a completion line with elapsed time — so a wedged phase
 * is visible as a *stopped* heartbeat rather than a silent log, and the
 * cycle log never has an unattributed gap.
 *
 * Timer-based (unlike agent_progress.ts there is no output stream to
 * piggyback on), so the caller MUST call `done()` — typically in a
 * `finally` — or the interval leaks past the phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Default milliseconds between heartbeat lines. */
export const PHASE_PROGRESS_INTERVAL_MS = 60_000;

/** Options for {@link startPhaseProgress}. */
export interface PhaseProgressOptions {
  /** What is running, e.g. `setup (o/r#7)`. Shown on every line. */
  label: string;
  /** Sink for the lines (the worker logger's info). */
  log: (message: string) => void;
  /** Milliseconds between heartbeats. Defaults to one minute. */
  intervalMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Handle for a running phase heartbeat. */
export interface PhaseProgressHandle {
  /**
   * Stop the heartbeat and log the completion line. Idempotent — only
   * the first call logs. `outcome` names how the phase ended (defaults
   * to "completed").
   */
  done(outcome?: string): void;
}

/** Compact duration: 45s, 1m3s, 12m0s. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/**
 * Start a phase heartbeat: a start line now, a `still running` line every
 * interval, and a completion line when `done()` is called.
 */
export function startPhaseProgress(
  options: PhaseProgressOptions,
): PhaseProgressHandle {
  const intervalMs = options.intervalMs ?? PHASE_PROGRESS_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const startMs = now();
  let finished = false;

  options.log(`[phase] ${options.label}: started`);

  const timer = setInterval(() => {
    options.log(
      `[phase] ${options.label}: still running · ${
        formatDuration(now() - startMs)
      } elapsed`,
    );
  }, intervalMs);

  return {
    done(outcome?: string): void {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      options.log(
        `[phase] ${options.label}: ${outcome ?? "completed"} in ${
          formatDuration(now() - startMs)
        }`,
      );
    },
  };
}
