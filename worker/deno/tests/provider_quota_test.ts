/**
 * Tests for the shared provider-quota ranker (Issue #1696, parent #1694).
 *
 * The Claude five-hour / seven-day rule stays the Claude policy. This suite
 * pins the *extracted* ranker so a Codex (or mixed) pool can use the same
 * remaining-fraction / hours-to-reset comparison without inventing a
 * percentage for an unknown budget, and without a Claude-only window name
 * leaking into another vendor.
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  CLAUDE_QUOTA_POLICY,
  CODEX_QUOTA_POLICY,
  formatQuotaSelectionLog,
  type QuotaCandidate,
  type QuotaWindow,
  rankQuotaCandidates,
} from "../lib/provider_quota.ts";

/** A fixed "now" — 2026-09-10T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 10, 0, 0, 0);
const HOUR = 3_600_000;

function known(
  label: string,
  providerId: string,
  windows: readonly QuotaWindow[],
): QuotaCandidate {
  return {
    providerId,
    credentialLabel: label,
    budget: { known: true, windows },
  };
}

function unknown(
  label: string,
  providerId: string,
  reason: string,
): QuotaCandidate {
  return {
    providerId,
    credentialLabel: label,
    budget: { known: false, reason },
  };
}

Deno.test("rankQuotaCandidates - Claude policy spends the highest remaining per hour", () => {
  const ranking = rankQuotaCandidates(
    [
      known("provider", "claude", [
        { name: "five_hour", remainingFraction: 0.9, resetAt: NOW + 5 * HOUR },
        {
          name: "seven_day",
          remainingFraction: 0.2,
          resetAt: NOW + 168 * HOUR,
        },
      ]),
      known("provider-2", "claude", [
        { name: "five_hour", remainingFraction: 0.9, resetAt: NOW + 5 * HOUR },
        { name: "seven_day", remainingFraction: 0.5, resetAt: NOW + 24 * HOUR },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "provider-2");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("rankQuotaCandidates - Claude five-hour gate is a filter, not a score", () => {
  const ranking = rankQuotaCandidates(
    [
      known("burned", "claude", [
        { name: "five_hour", remainingFraction: 0.1, resetAt: NOW + 5 * HOUR },
        { name: "seven_day", remainingFraction: 0.9, resetAt: NOW + 24 * HOUR },
      ]),
      known("fresh", "claude", [
        { name: "five_hour", remainingFraction: 0.5, resetAt: NOW + 5 * HOUR },
        {
          name: "seven_day",
          remainingFraction: 0.3,
          resetAt: NOW + 168 * HOUR,
        },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "fresh");
  assertEquals(ranking.ranked[0]?.eligible, true);
  assertEquals(ranking.ranked[1]?.eligible, false);
});

Deno.test("rankQuotaCandidates - all-low-but-usable still selects (soft guard)", () => {
  const ranking = rankQuotaCandidates(
    [
      known("a", "claude", [
        { name: "five_hour", remainingFraction: 0.25, resetAt: NOW + 5 * HOUR },
        {
          name: "seven_day",
          remainingFraction: 0.05,
          resetAt: NOW + 12 * HOUR,
        },
      ]),
      known("b", "claude", [
        { name: "five_hour", remainingFraction: 0.3, resetAt: NOW + 5 * HOUR },
        {
          name: "seven_day",
          remainingFraction: 0.08,
          resetAt: NOW + 48 * HOUR,
        },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "a");
  assertEquals(ranking.reason, "low-rank-window-remaining-highest-rate");
  assertEquals(ranking.winner?.eligible, true);
});

Deno.test("rankQuotaCandidates - unknown budget ranks last and is never zero", () => {
  const ranking = rankQuotaCandidates(
    [
      unknown("blind", "claude", "probe-failed"),
      known("seen", "claude", [
        { name: "five_hour", remainingFraction: 0.4, resetAt: NOW + 5 * HOUR },
        { name: "seven_day", remainingFraction: 0.4, resetAt: NOW + 48 * HOUR },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "seen");
  assertEquals(ranking.ranked[1]?.credentialLabel, "blind");
  assertEquals(ranking.ranked[1]?.remainingFraction, null);
});

Deno.test("rankQuotaCandidates - a rolled-over window counts as full", () => {
  const ranking = rankQuotaCandidates(
    [
      known("stale", "claude", [
        { name: "five_hour", remainingFraction: 0.05, resetAt: NOW - HOUR },
        { name: "seven_day", remainingFraction: 0.05, resetAt: NOW - HOUR },
      ]),
      known("current", "claude", [
        { name: "five_hour", remainingFraction: 0.4, resetAt: NOW + 5 * HOUR },
        {
          name: "seven_day",
          remainingFraction: 0.4,
          resetAt: NOW + 168 * HOUR,
        },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "stale");
});

Deno.test("rankQuotaCandidates - Codex has no five-hour gate; API-key stays unknown", () => {
  const ranking = rankQuotaCandidates(
    [
      unknown("api", "codex", "api-key-account"),
      known("sub", "codex", [
        {
          name: "primary",
          remainingFraction: 0.4,
          resetAt: NOW + 7 * 24 * HOUR,
          nominalHours: 168,
        },
      ]),
    ],
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "sub");
  assertEquals(ranking.ranked[1]?.budget.known, false);
  if (ranking.ranked[1]?.budget.known === false) {
    assertEquals(ranking.ranked[1].budget.reason, "api-key-account");
  }
});

Deno.test("rankQuotaCandidates - truly exhausted Codex is ineligible", () => {
  const ranking = rankQuotaCandidates(
    [
      known("spent", "codex", [
        {
          name: "primary",
          remainingFraction: 0,
          resetAt: NOW + 24 * HOUR,
          nominalHours: 168,
        },
      ]),
      known("ok", "codex", [
        {
          name: "primary",
          remainingFraction: 0.3,
          resetAt: NOW + 48 * HOUR,
          nominalHours: 168,
        },
      ]),
    ],
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "ok");
  assertEquals(
    ranking.ranked.find((c) => c.credentialLabel === "spent")?.eligible,
    false,
  );
});

Deno.test("formatQuotaSelectionLog - names every candidate without a token value", () => {
  const ranking = rankQuotaCandidates(
    [
      known("provider", "claude", [
        { name: "five_hour", remainingFraction: 0.5, resetAt: NOW + 5 * HOUR },
        { name: "seven_day", remainingFraction: 0.4, resetAt: NOW + 48 * HOUR },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  const log = formatQuotaSelectionLog(ranking);
  assertEquals(log.includes("provider"), true);
  assertEquals(log.includes("claude"), true);
  assertEquals(log.includes("sk-ant"), false);
});
