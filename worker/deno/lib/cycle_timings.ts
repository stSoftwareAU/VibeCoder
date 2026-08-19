/**
 * Per-cycle wall-time telemetry (Issue #4299).
 *
 * The cycle log recorded gh-call counts per priority (gh_call_metrics.ts)
 * but no wall time, so "where did the first 15 minutes go?" needed
 * host-side forensics. This module records how long each named step
 * took — the priority ladder, issue scanning, and (via issue_worker's
 * phase timings) each per-issue phase — and formats one summary line
 * per cycle alongside the gh-call lines:
 *
 *   cycle-timings: total=3412s issue-scanning=2870s pr-feedback=16s …
 *
 * Same lifecycle as the gh-call counters: process-wide, reset by the
 * loop at each iteration boundary. Names are normalised the same way
 * (`pr-feedback`, `issue-scanning`) so the two lines join by key.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

const state = {
  /** Wall milliseconds per step name, in first-seen order. */
  byStep: new Map<string, number>(),
  /** When the current cycle started (epoch ms), or undefined. */
  cycleStartMs: undefined as number | undefined,
};

/** Normalise a step name: lowercase, whitespace → hyphens. */
export function normaliseStepName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Mark the start of a cycle (resets everything). */
export function startCycleTimings(nowMs: number = Date.now()): void {
  state.byStep.clear();
  state.cycleStartMs = nowMs;
}

/** Add wall milliseconds to a named step (accumulates on repeats). */
export function recordStepDuration(name: string, durationMs: number): void {
  const key = normaliseStepName(name);
  state.byStep.set(key, (state.byStep.get(key) ?? 0) + Math.max(0, durationMs));
}

/**
 * Time `fn` under `name`, recording its wall duration even when it
 * throws. Returns whatever `fn` returns.
 */
export async function timeStep<T>(
  name: string,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    recordStepDuration(name, now() - start);
  }
}

/** Snapshot for tests and formatters. */
export function getCycleTimings(): {
  cycleStartMs?: number;
  byStep: Record<string, number>;
} {
  return {
    ...(state.cycleStartMs !== undefined
      ? { cycleStartMs: state.cycleStartMs }
      : {}),
    byStep: Object.fromEntries(state.byStep),
  };
}

/** Reset without starting a new cycle. */
export function resetCycleTimings(): void {
  state.byStep.clear();
  state.cycleStartMs = undefined;
}

/**
 * One-line summary: total cycle wall time (when a start was recorded)
 * followed by every step, longest first, in whole seconds.
 */
export function formatCycleTimingsSummary(
  nowMs: number = Date.now(),
): string {
  const parts: string[] = [];
  if (state.cycleStartMs !== undefined) {
    parts.push(`total=${Math.round((nowMs - state.cycleStartMs) / 1000)}s`);
  }
  const steps = [...state.byStep.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => `${name}=${Math.round(ms / 1000)}s`);
  parts.push(...steps);
  return parts.length === 0
    ? "cycle-timings: none"
    : `cycle-timings: ${parts.join(" ")}`;
}
