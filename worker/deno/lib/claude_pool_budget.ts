/**
 * Does any OTHER subscription in this host's token pool still have budget?
 * (Issue #919 follow-up.)
 *
 * A quota pause belongs to the **token** that ran out, not to the host. Worker
 * start already ranks the pool and takes the most-remaining token, so once a
 * second subscription still has quota the only thing keeping the host idle is
 * the supervisor's hour-long re-probe cadence. On 2026-09-06 a host slept 59
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

import { probeClaudeTokenBudget } from "./claude_token_budget.ts";
import type { ProviderTokenFile } from "./credential_preflight.ts";

/**
 * Below this share of a window, a token is not worth restarting for.
 *
 * A token with a sliver left would be selected, exhaust almost immediately and
 * pause again — turning the hour-long wait into a restart loop, which is worse
 * than waiting. Five per cent is comfortably above that and far below anything
 * a run could use up in one cycle.
 */
export const POOL_BUDGET_FLOOR = 0.05;

/** Injection points; production passes nothing. */
export interface PoolBudgetOptions {
  /** Injected `fetch`, forwarded to the probe. */
  fetchFn?: Parameters<typeof probeClaudeTokenBudget>[1]["fetchFn"];
  /** Per-probe timeout, forwarded to the probe. */
  timeoutMs?: number;
  /** Endpoint override, for tests that assert what was called. */
  url?: string;
  /** Minimum remaining share worth restarting for. */
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

  const pool = tokens.filter((token) =>
    token.poolMember && (token.value ?? "").trim().length > 0
  );
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
    const remaining = Math.max(0, budget.remainingFraction);
    if (remaining >= floor) {
      log(
        `[SECURITY] claude token pool: ${label} still has ` +
          `${(remaining * 100).toFixed(1)}% of its most constrained window — ` +
          `restarting rather than waiting out ${
            spentLabel ?? "the spent token"
          }`,
      );
      return true;
    }
  }
  return false;
}
