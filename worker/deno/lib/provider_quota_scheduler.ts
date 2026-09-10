/**
 * Per-spawn quota selection (Issue #1696 / #1698).
 *
 * Ranks one provider's credentials, logs every candidate, and returns the
 * winner only when it is eligible. A start-up selector that must never
 * refuse should call {@link rankQuotaCandidates} directly and take the
 * winner regardless of the soft gate — that is Claude's `selectToken`
 * behaviour, left in `claude_credential_pool.ts`.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  formatQuotaSelectionLog,
  type QuotaCandidate,
  type QuotaPolicy,
  type RankedQuotaCandidate,
  rankQuotaCandidates,
} from "./provider_quota.ts";

/** Select the best *eligible* credential, or null when none can run now. */
export function selectEligibleQuota(
  candidates: readonly QuotaCandidate[],
  now: number,
  policy: QuotaPolicy,
  log?: (line: string) => void,
): RankedQuotaCandidate | null {
  const ranking = rankQuotaCandidates(candidates, now, policy);
  log?.(formatQuotaSelectionLog(ranking));
  const winner = ranking.winner;
  if (winner === null || !winner.eligible) return null;
  return winner;
}
