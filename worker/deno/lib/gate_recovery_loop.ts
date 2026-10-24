/**
 * Bounded completion-gate recovery loop (Issue #4234).
 *
 * Issue #4146 gave the unmet-criteria check its own recovery rounds: a
 * blocked summary got a turn to fix itself, and the round count alone decided
 * when to stop. Every other completion summary gate (docs sweep, branch
 * outcomes, removed assertions, the pre-PR verifier) had only a single retry
 * or none, so a run that the gates kept sending back ended with whichever
 * gate happened to fire last. This module generalises those rounds into one
 * bounded recovery loop for every completion summary gate.
 *
 * The loop is a pure decision over the history of blocking-finding counts:
 * one count per gate pass, oldest first. The first block always earns a
 * recovery turn. A later turn is granted only while the count keeps falling,
 * and never past the turn limit. A recovery turn's agent timeout is clamped
 * to the run's remaining time budget, and a turn that cannot get the minimum
 * runway is skipped rather than started and cut off.
 *
 * Pure functions only: no I/O, no clock reads (the caller passes `nowMs`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Blocking findings one gate pass reported. */
export interface FindingCountParts {
  /**
   * One entry per blocked gate section; `findings` defaults to 1 (the
   * pre-PR verifier passes its finding count).
   */
  sections: readonly { gate: string; findings?: number }[];
  unmetCriteria: number;
  standingViolations: number;
}

/**
 * The blocking-finding count for one gate pass: each blocked section counts
 * at least one, plus the unmet criteria and the standing violations.
 */
export function countBlockingFindings(parts: FindingCountParts): number {
  let total = 0;
  for (const section of parts.sections) {
    total += Math.max(1, section.findings ?? 1);
  }
  return total + parts.unmetCriteria + parts.standingViolations;
}

/**
 * Whether the loop grants one more recovery turn.
 *
 * `counts` holds the blocking-finding count of each recorded gate pass, oldest
 * first. The first block always earns a turn. After that a turn is granted
 * only while the latest pass reported strictly fewer blocking findings than
 * the pass before it, and the turns spent so far are below `maxTurns`.
 */
export function shouldRunRecoveryTurn(
  counts: readonly number[],
  maxTurns: number,
): boolean {
  if (counts.length === 0 || !(maxTurns >= 1)) return false;
  if (counts.length === 1) return true;
  const turnsSpent = counts.length - 1;
  if (turnsSpent >= maxTurns) return false;
  return counts[counts.length - 1]! < counts[counts.length - 2]!;
}

/** Why the recovery loop stopped, once at least one turn was spent. */
export type RecoveryEndReason = "no-progress" | "turn-limit" | "recovered";

/** The reason the loop ended, or undefined when no recovery turn was spent. */
function recoveryEndReason(
  counts: readonly number[],
  maxTurns: number,
): RecoveryEndReason | undefined {
  if (counts.length < 2) return undefined;
  const last = counts[counts.length - 1]!;
  const previous = counts[counts.length - 2]!;
  if (last >= previous) return "no-progress";
  if (counts.length - 1 >= maxTurns) return "turn-limit";
  return "recovered";
}

/** `1 turn` or `2 turns`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One sentence naming why recovery ended, quoting the blocking-finding counts
 * (`5 → 3 → 3`). Undefined when no recovery turn was spent (`counts.length < 2`).
 */
export function describeRecoveryEnd(
  counts: readonly number[],
  maxTurns: number,
): string | undefined {
  const reason = recoveryEndReason(counts, maxTurns);
  if (reason === undefined) return undefined;
  const turnsSpent = counts.length - 1;
  const last = counts[counts.length - 1]!;
  const sequence = counts.join(" → ");
  switch (reason) {
    case "no-progress":
      return `recovery stopped after ${
        plural(turnsSpent, "turn")
      }: blocking findings did not decrease (${sequence})`;
    case "turn-limit":
      return `recovery stopped at the ${turnsSpent}-turn limit with ${
        plural(last, "blocking finding")
      } left (${sequence})`;
    case "recovered":
      if (last === 0) {
        return `recovery cleared every blocking finding after ${
          plural(turnsSpent, "turn")
        } (${sequence})`;
      }
      return `recovery is still making progress after ${
        plural(turnsSpent, "turn")
      }: blocking findings fell (${sequence})`;
  }
}

/** Minimum seconds of runway a recovery turn needs; below it the turn is skipped. */
export const MIN_RECOVERY_TURN_SECONDS = 120;

/** The agent timeout a recovery turn gets, or a skip. */
export interface TurnTimeout {
  skip: boolean;
  timeoutSeconds: number;
  reason?: string;
}

/**
 * Clamp one recovery turn's agent timeout to the run's time budget.
 *
 * `ceilingMs` is the epoch-ms past which the run may not work; undefined means
 * uncapped, so the configured timeout stands. With less than
 * {@link MIN_RECOVERY_TURN_SECONDS} of runway the turn is skipped. Otherwise
 * the timeout is the configured one or the remaining runway, whichever is
 * shorter. Non-finite inputs and a non-positive configured timeout throw, so a
 * bad budget fails loud rather than silently running uncapped.
 */
export function clampTurnTimeout(opts: {
  configuredSeconds: number;
  nowMs: number;
  ceilingMs?: number;
}): TurnTimeout {
  const { configuredSeconds, nowMs, ceilingMs } = opts;
  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
    throw new RangeError(
      `configuredSeconds must be a positive finite number, got ${configuredSeconds}`,
    );
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`nowMs must be finite, got ${nowMs}`);
  }
  if (ceilingMs === undefined) {
    return { skip: false, timeoutSeconds: configuredSeconds };
  }
  if (!Number.isFinite(ceilingMs)) {
    throw new RangeError(`ceilingMs must be finite, got ${ceilingMs}`);
  }
  const remaining = Math.floor((ceilingMs - nowMs) / 1000);
  if (remaining < MIN_RECOVERY_TURN_SECONDS) {
    return {
      skip: true,
      timeoutSeconds: 0,
      reason:
        `only ${remaining} seconds of run time remain, below the ${MIN_RECOVERY_TURN_SECONDS}-second minimum for a recovery turn`,
    };
  }
  return {
    skip: false,
    timeoutSeconds: Math.min(configuredSeconds, remaining),
  };
}
