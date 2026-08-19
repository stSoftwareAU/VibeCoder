/**
 * Daily spend-ceiling configuration and run-loop wiring (Issue #3684).
 *
 * Issue #3648 added the pure comparison (`checkDailySpendCeiling`) and the
 * `checkSpendCeiling` hook in the run loop, but nothing resolved the
 * documented configuration or supplied the hook — the ceiling was documented
 * yet inert, so wall-clock remained the only backpressure on model spend.
 * This module closes that gap: it resolves the operator's configuration,
 * fails loudly on a malformed value, and builds the check the run loop calls
 * before claiming any further billed work.
 *
 * Policy (the human decisions from #3684):
 *   1. Scope    — per worker per UTC day, in USD, summed from that worker's
 *                 own credit log directory.
 *   2. Default  — opt-in: `0` (disabled), so existing deployments are
 *                 unaffected until an operator sets a value.
 *   3. Breach   — stop the cycle before claiming further work; the run ends
 *                 with `Daily spend ceiling reached` and the next scheduled
 *                 run re-checks (spend resets at the UTC date rollover).
 *   4. Notify   — a `[SPEND_CEILING]` error line in the worker log plus a
 *                 hash-chained audit journal entry. Never a silent skip.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { checkDailySpendCeiling } from "./credit_tracker.ts";
import { recordMutation, resolveRunId } from "./audit_journal.ts";

/** Environment variable holding the daily ceiling in USD. */
export const SPEND_CEILING_ENV = "VIBE_DAILY_SPEND_CEILING_USD";

/** Environment variable overriding the credit log directory. */
export const CREDIT_LOG_DIR_ENV = "VIBE_CREDIT_LOG_DIR";

/** Audit verb recorded when the ceiling stops a cycle. */
export const SPEND_CEILING_AUDIT_VERB = "spend-ceiling-stop";

/** Details of a ceiling breach, as recorded in the audit journal. */
export interface SpendCeilingAuditEvent {
  /** Estimated spend for the day, in USD. */
  spentUsd: number;
  /** The ceiling that was breached, in USD. */
  ceilingUsd: number;
  /** Human-readable explanation. */
  message: string;
}

/** Options for {@link createSpendCeilingCheck}. */
export interface SpendCeilingCheckOptions {
  /** Directory holding the `.credit_log_YYYY-MM-DD.json` files. */
  logDir: string;
  /** Ceiling in USD. Values `<= 0` leave the hook unwired. */
  ceilingUsd: number;
  /** Loud failure channel — the worker's error logger. */
  logError: (message: string) => void;
  /** Audit sink; defaults to the hash-chained audit journal. */
  recordEvent?: (event: SpendCeilingAuditEvent) => Promise<void>;
}

/**
 * Parse the configured daily ceiling.
 *
 * An unset or blank value means "disabled" (`0`). Anything that is not a
 * finite, non-negative number is a configuration error and throws, so a typo
 * fails loudly at start-up rather than silently disabling the guard.
 *
 * @param raw - Raw environment value
 * @returns The ceiling in USD (`0` when disabled)
 */
export function resolveSpendCeilingUsd(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return 0;

  // `Number()` accepts "Infinity" and "" — reject anything that is not a
  // plain finite decimal amount before parsing.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `${SPEND_CEILING_ENV} must be a non-negative number of US dollars ` +
        `(e.g. "50" or "12.50"), got "${trimmed}".`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${SPEND_CEILING_ENV} must be a finite number, got "${trimmed}".`,
    );
  }
  return parsed;
}

/**
 * Resolve the credit log directory, defaulting to the worker's work dir.
 *
 * @param workDir - Worker work directory
 * @param raw - Raw environment override
 * @returns The directory holding the credit logs
 */
export function resolveCreditLogDir(
  workDir: string,
  raw: string | undefined,
): string {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? workDir : trimmed;
}

/** Default audit sink — a hash-chained journal entry for the breach. */
async function recordAuditEvent(event: SpendCeilingAuditEvent): Promise<void> {
  const result = await recordMutation({
    runId: resolveRunId(),
    verb: SPEND_CEILING_AUDIT_VERB,
    outcome: "error",
    target: `${event.spentUsd.toFixed(2)}/${event.ceilingUsd.toFixed(2)} USD`,
    caller: "worker/deno/lib/spend_ceiling.ts",
  });
  if (!result.ok) throw result.error;
}

/**
 * Build the run loop's `checkSpendCeiling` hook.
 *
 * @param options - Ceiling configuration and output channels
 * @returns The check, or `undefined` when no ceiling is configured
 */
export function createSpendCeilingCheck(
  options: SpendCeilingCheckOptions,
): (() => Promise<{ exceeded: boolean; message?: string }>) | undefined {
  const { logDir, ceilingUsd, logError } = options;
  if (ceilingUsd <= 0) return undefined;
  const recordEvent = options.recordEvent ?? recordAuditEvent;

  return async () => {
    const result = await checkDailySpendCeiling({ logDir, ceilingUsd });

    if (!result.ok) {
      // A monitoring fault must not halt the fleet, but it must never be
      // silent either — the absence of a breach signal is not proof of
      // being under budget.
      logError(
        `[SPEND_CEILING] Could not read the credit log in ${logDir} — ` +
          `spend is UNVERIFIED this iteration: ${result.error.message}`,
      );
      return { exceeded: false };
    }

    // Spend charged at the unpriced upper bound means the pricing table is
    // missing a model id: the figure is an over-estimate now, but it used to
    // be a silent $0 (Issue #3870). Report it whether or not the ceiling was
    // reached, so the missing row gets added.
    if (result.value.unpricedSpendUsd > 0) {
      logError(
        `[SPEND_CEILING] $${
          result.value.unpricedSpendUsd.toFixed(2)
        } of today's estimated spend was charged at the unpriced upper bound ` +
          `for model id(s) ${result.value.unpricedModels.join(", ")} — add ` +
          `them to MODEL_PRICING in worker/deno/lib/token_usage.ts.`,
      );
    }

    if (!result.value.exceeded) return { exceeded: false };

    const message = result.value.message ?? "Daily spend ceiling reached";
    try {
      await recordEvent({
        spentUsd: result.value.spentUsd,
        ceilingUsd: result.value.ceilingUsd,
        message,
      });
    } catch (error: unknown) {
      // The stop still stands; only the audit trail is degraded. Say so.
      logError(
        `[SPEND_CEILING] Failed to record the audit event for the breach: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { exceeded: true, message };
  };
}
