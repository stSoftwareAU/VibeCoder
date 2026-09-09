/**
 * Does any OTHER subscription in this host's token pool still have budget?
 * (Issue #919 follow-up.)
 *
 * A quota pause belongs to the **token** that ran out, not to the host. Worker
 * start already ranks the pool and takes the token worth the most per hour
 * (Issue #1623, corrected by #1685), so once a second subscription still has
 * quota the only thing keeping the host idle is the supervisor's hour-long
 * re-probe cadence. On 2026-09-06 a host slept 59
 * minutes waiting for the spent token's window while its other subscription
 * sat at 99% of its five-hour budget — the exact outcome a pool is bought to
 * prevent.
 *
 * This module answers one narrow question for
 * `container_restart_backoff.ts`, and deliberately does no more:
 *
 * - It does **not** choose a token. Selection stays where it is, at worker
 *   start, unchanged, so the run's environment still carries exactly one
 *   subscription's credential and the Issue #919 guarantee is untouched.
 * - It is asked **only** on a quota pause, so a healthy run costs nothing.
 * - A host with fewer than two pool candidates makes **no request at all** and
 *   answers `false` — every single-subscription host behaves as it always has.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  type ClaudeTokenBudget,
  probeClaudeTokenBudget,
} from "./claude_token_budget.ts";
import {
  providerPoolCandidates,
  type ProviderTokenFile,
} from "./credential_preflight.ts";

/**
 * At or below this share of a window, a token is not worth restarting for:
 * **exhaustion**, and nothing above it (Issue #1685).
 *
 * "Worth restarting for" and "worth switching to" are still one question —
 * can this subscription serve the next call? — and exhaustion is the only
 * answer that says no. Issue #1668 read the 20% five-hour figure here, but
 * that figure is a selection *preference* between credentials
 * (`CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING`), so applying it to this yes/no
 * question idled a host whose other subscription still held usable quota —
 * the exact outcome a pool is bought to prevent.
 */
export const POOL_BUDGET_FLOOR = 0;

/**
 * The five-hour share {@link POOL_BUDGET_FLOOR} is read against.
 *
 * The next call is spent against the five-hour window, so that is the window
 * the floor reads (Issue #1668). The headline `remainingFraction` is the
 * *most constrained* window, so measuring against it would refuse a restart
 * for a token with a fresh five hours and a nearly spent week — which
 * `rankClaudeTokenBudgets` would happily select and run against.
 *
 * @param budget - A known probe result.
 * @returns The five-hour remaining share, or the headline figure for a
 *   response that reported no five-hour window.
 */
function fiveHourRemaining(
  budget: Extract<ClaudeTokenBudget, { known: true }>,
): number {
  const fiveHour = budget.windows.find((window) =>
    window.window === "five_hour"
  );
  return Math.max(0, fiveHour?.remainingFraction ?? budget.remainingFraction);
}

/** Injection points; production passes nothing. */
export interface PoolBudgetOptions {
  /** Injected `fetch`, forwarded to the probe. */
  fetchFn?: Parameters<typeof probeClaudeTokenBudget>[1]["fetchFn"];
  /** Per-probe timeout, forwarded to the probe. */
  timeoutMs?: number;
  /** Endpoint override, for tests that assert what was called. */
  url?: string;
  /** Share a five-hour window must exceed to be worth restarting for. */
  floor?: number;
  /** Sink for the decision line; defaults to discarding it. */
  log?: (message: string) => void;
}

/**
 * True when a pool token OTHER than `spentLabel` has budget worth going back
 * for.
 *
 * Never throws: every failure path answers `false`, because an unshortened
 * pause is exactly the behaviour the host has always had, while a wrong
 * `true` spends a restart on a token that cannot serve.
 *
 * @param tokens - Every discovered token file for the provider.
 * @param spentLabel - Label of the token whose exhaustion caused the pause;
 *   it is excluded from the answer even if it probes as having budget, since
 *   it is the one that just failed.
 * @param options - Injected bounds, endpoint, floor and log sink.
 * @returns Whether another subscription is worth restarting for.
 */
export async function poolHasAnotherTokenWithBudget(
  tokens: readonly ProviderTokenFile[],
  spentLabel: string | undefined,
  options: PoolBudgetOptions = {},
): Promise<boolean> {
  const log = options.log ?? (() => {});
  const floor = options.floor ?? POOL_BUDGET_FLOOR;

  const pool = providerPoolCandidates(tokens);
  // Fewer than two subscriptions is nothing to go back for. Checked on the
  // whole pool rather than on the candidates, so a single-token host makes no
  // request even when the spent token is unknown — every such host stays
  // byte-for-byte on the behaviour it has always had.
  if (pool.length < 2) return false;

  const candidates = pool.filter((token) => token.label !== spentLabel);
  if (candidates.length === 0) return false;

  const probes = await Promise.all(
    candidates.map(async (token) => {
      try {
        const budget = await probeClaudeTokenBudget(token.value ?? "", {
          label: token.label,
          fetchFn: options.fetchFn,
          timeoutMs: options.timeoutMs,
          url: options.url,
        });
        return { label: token.label, budget };
      } catch {
        // A probe that throws is an unknown budget, never an assumed one.
        return { label: token.label, budget: { known: false as const } };
      }
    }),
  );

  for (const { label, budget } of probes) {
    if (!budget.known) continue;
    const remaining = fiveHourRemaining(budget);
    // Strictly above: at precisely the floor the window is spent and the
    // token cannot serve the next call at all.
    if (remaining > floor) {
      log(
        `[SECURITY] claude token pool: ${label} still has ` +
          `${(remaining * 100).toFixed(1)}% of its five-hour window — ` +
          `restarting rather than waiting out ${
            spentLabel ?? "the spent token"
          }`,
      );
      return true;
    }
  }
  return false;
}
