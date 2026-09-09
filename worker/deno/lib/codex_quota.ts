/**
 * Map a Codex budget snapshot onto the shared quota candidate
 * (Issues #1696, #1698, parent #1694).
 *
 * The snapshot comes from `codex_budget.ts` — a file the CLI already wrote,
 * or an explicit unknown. This module does not probe, invent a percentage,
 * or open a token.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { CodexBudget, CodexBudgetWindow } from "./codex_budget_source.ts";
import type { CodexBudgetSnapshot } from "./codex_budget.ts";
import type { QuotaCandidate, QuotaWindow } from "./provider_quota.ts";

export const CODEX_PROVIDER_ID = "codex";

function mapWindow(window: CodexBudgetWindow): QuotaWindow {
  return {
    name: window.window,
    remainingFraction: window.remainingFraction,
    resetAt: window.resetAt,
    nominalHours: window.windowMinutes === undefined
      ? undefined
      : window.windowMinutes / 60,
  };
}

/** Turn a Codex budget (known or unknown) into a shared candidate. */
export function quotaCandidateFromCodexBudget(
  label: string,
  budget: CodexBudget,
): QuotaCandidate {
  if (!budget.known) {
    return {
      providerId: CODEX_PROVIDER_ID,
      credentialLabel: label,
      budget: { known: false, reason: budget.reason },
    };
  }
  return {
    providerId: CODEX_PROVIDER_ID,
    credentialLabel: label,
    budget: { known: true, windows: budget.windows.map(mapWindow) },
  };
}

/** Same mapping from a cached adapter snapshot. */
export function quotaCandidateFromCodexSnapshot(
  label: string,
  snapshot: CodexBudgetSnapshot,
): QuotaCandidate {
  return quotaCandidateFromCodexBudget(label, snapshot.budget);
}
