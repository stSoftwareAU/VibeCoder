/**
 * Synthetic Claude credential-pool snapshots, shared by the policy suites
 * (Issues #1686 and #1731).
 *
 * Both suites state a pool as a list of credentials with their two windows
 * and assert the outcome on the two surfaces that read the policy: the pure
 * `rankClaudeTokenBudgets`, and `ClaudeCredentialPool.selectEligible`. The
 * fixtures that turn a row into those inputs live here once, so the two
 * cannot drift into disagreeing about what a "credential with no seven-day
 * window" looks like.
 *
 * Everything here is deterministic and offline: {@link POOL_NOW} is a fixed
 * instant, snapshots are recorded rather than probed, and
 * {@link spawnDecision} counts any request its pool would have made so a
 * caller can assert that it made none.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  ClaudeTokenBudget,
  ClaudeTokenBudgetUnknownReason,
  ClaudeTokenBudgetWindow,
} from "../../lib/claude_token_budget.ts";
import { createClaudeCredentialPool } from "../../lib/claude_credential_pool.ts";
import type { ProviderTokenFile } from "../../lib/credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../../lib/agent_provider.ts";

/** A fixed "now" for every row — 2026-09-09T00:00:00Z. */
export const POOL_NOW = Date.UTC(2026, 8, 9, 0, 0, 0);

/** One hour, in milliseconds. */
export const POOL_HOUR = 3_600_000;

/** The Claude provider descriptor every pool fixture is built against. */
export const CLAUDE_PROVIDER: AgentProviderDescriptor = resolveAgentProvider(
  CLAUDE_PROVIDER_ID,
);

/** One window of a synthetic snapshot, stated as a share and an offset. */
export interface PoolWindow {
  /** Unused share of the window, in `[0, 1]`. */
  readonly remaining: number;
  /** Hours from {@link POOL_NOW} until it resets; negative means past. */
  readonly resetInHours: number;
}

/** One credential in a row, exactly as the probe would have reported it. */
export interface PoolCandidate {
  /** The file stem the pool identifies it by. */
  readonly label: string;
  /** Its five-hour window, or absent when the response reported none. */
  readonly fiveHour?: PoolWindow;
  /** Its seven-day window, or absent when the response reported none. */
  readonly sevenDay?: PoolWindow;
  /** Set instead of the windows for a credential that could not be probed. */
  readonly unknown?: ClaudeTokenBudgetUnknownReason;
}

/**
 * Resolve one window offset against {@link POOL_NOW}.
 *
 * @param name - Which window this is.
 * @param spec - Its remaining share and reset offset in hours.
 * @returns The window as the probe would have reported it.
 */
export function poolWindow(
  name: ClaudeTokenBudgetWindow["window"],
  spec: PoolWindow,
): ClaudeTokenBudgetWindow {
  return {
    window: name,
    remainingFraction: spec.remaining,
    resetAt: POOL_NOW + spec.resetInHours * POOL_HOUR,
  };
}

/**
 * The probe result a candidate stands for.
 *
 * @param candidate - The credential to describe.
 * @returns Its probe outcome, with the headline set to the most constrained
 *   window exactly as #918 reports it.
 * @throws When a known candidate names no window at all, which is a fixture
 *   mistake rather than a shape the probe can produce.
 */
export function snapshotOf(candidate: PoolCandidate): ClaudeTokenBudget {
  if (candidate.unknown !== undefined) {
    return { known: false, label: candidate.label, reason: candidate.unknown };
  }
  const windows: ClaudeTokenBudgetWindow[] = [];
  if (candidate.fiveHour) {
    windows.push(poolWindow("five_hour", candidate.fiveHour));
  }
  if (candidate.sevenDay) {
    windows.push(poolWindow("seven_day", candidate.sevenDay));
  }
  if (windows.length === 0) {
    throw new Error(`${candidate.label}: a known snapshot needs a window`);
  }
  const headline = windows.reduce((best, current) =>
    current.remainingFraction < best.remainingFraction ? current : best
  );
  return {
    known: true,
    label: candidate.label,
    remainingFraction: headline.remainingFraction,
    resetAt: headline.resetAt,
    window: headline.window,
    windows,
  };
}

/**
 * The discovered file for a candidate, as credential discovery returns it.
 *
 * @param label - The credential's file stem.
 * @returns The discovered token file, whose value is a synthetic stand-in
 *   that never leaves the test process.
 */
export function poolTokenFile(label: string): ProviderTokenFile {
  const name = "CLAUDE_CODE_OAUTH_TOKEN";
  const value = `sk-ant-oat01-${label}`;
  return {
    label,
    path: `/creds/claude/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: true,
    entries: [{ name, value }],
  };
}

/**
 * Ask the pool which credential a child may be spawned on, from snapshots
 * recorded rather than probed.
 *
 * @param candidates - The pool, in discovery order.
 * @returns The chosen label, or null when no spawn is allowed, plus the
 *   number of probes the decision cost.
 */
export async function spawnDecision(
  candidates: readonly PoolCandidate[],
): Promise<{ label: string | null; probes: number }> {
  let probes = 0;
  const pool = createClaudeCredentialPool({
    provider: CLAUDE_PROVIDER,
    now: () => POOL_NOW,
    discover: () =>
      Promise.resolve(candidates.map((c) => poolTokenFile(c.label))),
    fetchFn: () => {
      probes += 1;
      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  });
  for (const candidate of candidates) {
    pool.recordBudget(candidate.label, snapshotOf(candidate), POOL_NOW);
  }
  const chosen = await pool.selectEligible(POOL_NOW);
  return { label: chosen?.label ?? null, probes };
}
