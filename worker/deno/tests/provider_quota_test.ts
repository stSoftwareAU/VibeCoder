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

/** 20% of a week resetting in six hours against 90% resetting in six days. */
function soonSmallAgainstLateLarge(
  providerId: string,
  windowName: string,
): QuotaCandidate[] {
  return [
    known("soon-small", providerId, [
      { name: "five_hour", remainingFraction: 0.9, resetAt: NOW + 5 * HOUR },
      { name: windowName, remainingFraction: 0.2, resetAt: NOW + 6 * HOUR },
    ]),
    known("late-large", providerId, [
      { name: "five_hour", remainingFraction: 0.9, resetAt: NOW + 5 * HOUR },
      {
        name: windowName,
        remainingFraction: 0.9,
        resetAt: NOW + 6 * 24 * HOUR,
      },
    ]),
  ];
}

Deno.test("rankQuotaCandidates - Claude policy spends the most seven-day quota left (Issue #4504)", () => {
  // Rewritten for Issue #4504: under #1623's per-hour
  // rule 20%/6h (3.33%/h) beat 90%/144h (0.63%/h); now the larger share wins.
  const ranking = rankQuotaCandidates(
    soonSmallAgainstLateLarge("claude", "seven_day"),
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "late-large");
  assertEquals(ranking.reason, "most-remaining");
});

Deno.test("rankQuotaCandidates - Codex policy still ranks by remaining per hour", () => {
  // Issue #4504 changes Claude; Codex keeps the per-hour
  // rate, so the same figures pick the other credential.
  const ranking = rankQuotaCandidates(
    soonSmallAgainstLateLarge("codex", "primary"),
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(ranking.winner?.credentialLabel, "soon-small");
  assertEquals(ranking.reason, "highest-remaining-per-hour");
});

Deno.test("rankQuotaCandidates - equal Claude weekly shares prefer the sooner reset over discovery order", () => {
  const ranking = rankQuotaCandidates(
    [
      known("later-discovered-first", "claude", [
        {
          name: "seven_day",
          remainingFraction: 0.4,
          resetAt: NOW + 100 * HOUR,
        },
      ]),
      known("sooner-discovered-last", "claude", [
        { name: "seven_day", remainingFraction: 0.4, resetAt: NOW + 24 * HOUR },
      ]),
    ],
    NOW,
    CLAUDE_QUOTA_POLICY,
  );
  assertEquals(ranking.ranked.map((c) => c.credentialLabel), [
    "sooner-discovered-last",
    "later-discovered-first",
  ]);
  assertEquals(ranking.reason, "equal-remaining-soonest-reset");
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

Deno.test("rankQuotaCandidates - all-low-but-usable still selects the most left (soft guard)", () => {
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
  // Rewritten for Issue #4504: Claude has no low floor
  // any more and no rate, so b's 8% beats a's 5% although a resets sooner.
  assertEquals(ranking.winner?.credentialLabel, "b");
  assertEquals(ranking.reason, "most-remaining");
  assertEquals(ranking.winner?.eligible, true);
});

Deno.test("rankQuotaCandidates - Codex demotes a sub-10% primary window despite its higher rate", () => {
  const ranking = rankQuotaCandidates(
    [
      known("low-fast", "codex", [
        { name: "primary", remainingFraction: 0.05, resetAt: NOW + HOUR },
      ]),
      known("healthy", "codex", [
        { name: "primary", remainingFraction: 0.1, resetAt: NOW + 100 * HOUR },
      ]),
    ],
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(ranking.ranked.map((c) => c.credentialLabel), [
    "healthy",
    "low-fast",
  ]);
  assertEquals(ranking.reason, "highest-remaining-per-hour");
  assertEquals(ranking.winner?.eligible, true);
});

Deno.test("rankQuotaCandidates - Codex all-low primary windows keep the highest rate and low-floor reason", () => {
  const ranking = rankQuotaCandidates(
    [
      known("a", "codex", [
        { name: "primary", remainingFraction: 0.05, resetAt: NOW + 12 * HOUR },
      ]),
      known("b", "codex", [
        { name: "primary", remainingFraction: 0.08, resetAt: NOW + 48 * HOUR },
      ]),
    ],
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(ranking.ranked.map((c) => c.credentialLabel), ["a", "b"]);
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
