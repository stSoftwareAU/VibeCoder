/**
 * The Claude credential scheduling policy, pinned as a table (Issue #1686,
 * parent #1653).
 *
 * Issue #1685 clarified what the pool actually decides, and the distinction it
 * drew is easy to lose the next time quota handling is touched. This file
 * exists to make that impossible to lose quietly:
 *
 * - **seven-day remaining quota per hour until reset is the primary balancing
 *   rule** — nothing overrides it for a usable credential, in particular no
 *   weekly floor, so a nearly spent week resetting within the hour outranks a
 *   full one resetting days away;
 * - **under 20% of the five-hour window is a soft guard**, biting only while
 *   another non-exhausted credential holds at least 20%;
 * - **explicit exhaustion is the hard exclusion** — and the only one;
 * - **every credential being below 20% must not stop the fleet**: the guard
 *   steps aside and the weekly rule still names a credential to spawn on.
 *
 * Each row below is stated once and asserted on **both** surfaces that read
 * the policy, so neither can drift from the other:
 *
 * 1. `rankClaudeTokenBudgets` — the pure ranking, which names the winner and
 *    the reason it won;
 * 2. `ClaudeCredentialPool.selectEligible` — the spawn decision, which
 *    answers "is there a credential worth running a child on right now?".
 *
 * Two regressions these rows are written to catch, because both looked like a
 * quota fix at the time:
 *
 * - the old `all <= 20% => no eligible credential` behaviour, which idled a
 *   host holding usable quota (rows 3, 9 and 11 would return no credential);
 * - the old `< 10% weekly => always rank behind >= 10%` override, which spent
 *   the fuller week first and let the urgent one lapse (row 8 would invert).
 *
 * Every row uses deterministic timestamps and synthetic budget snapshots
 * recorded straight into the pool, so nothing here touches the network, the
 * clock, the filesystem or the process environment.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import type {
  ClaudeTokenBudget,
  ClaudeTokenBudgetUnknownReason,
  ClaudeTokenBudgetWindow,
} from "../lib/claude_token_budget.ts";
import {
  CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING,
  type ClaudeTokenSelectionReason,
  rankClaudeTokenBudgets,
} from "../lib/claude_token_selection.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

/** A fixed "now" for every row — 2026-09-09T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 9, 0, 0, 0);

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

const CLAUDE: AgentProviderDescriptor = resolveAgentProvider(
  CLAUDE_PROVIDER_ID,
);

/** One window of a synthetic snapshot, stated as a share and an offset. */
interface Window {
  /** Unused share of the window, in `[0, 1]`. */
  readonly remaining: number;
  /** Hours from {@link NOW} until it resets; negative means already past. */
  readonly resetInHours: number;
}

/** One credential in a row, exactly as the probe would have reported it. */
interface Candidate {
  /** The file stem the pool identifies it by. */
  readonly label: string;
  /** Its five-hour window, or absent when the response reported none. */
  readonly fiveHour?: Window;
  /** Its seven-day window, or absent when the response reported none. */
  readonly sevenDay?: Window;
  /** Set instead of the windows for a credential that could not be probed. */
  readonly unknown?: ClaudeTokenBudgetUnknownReason;
}

/** One row of the policy matrix. */
interface Row {
  /** What the row is about, used as the test name. */
  readonly name: string;
  /** The pool, in discovery order — the tie-break of last resort. */
  readonly candidates: readonly Candidate[];
  /** The label the ranking must put first. */
  readonly winner: string;
  /** Why it won, as the log records it. */
  readonly reason: ClaudeTokenSelectionReason;
  /**
   * The credential a child may be spawned on, or null when no spawn is
   * allowed because every candidate is spent.
   */
  readonly spawn: string | null;
}

/** Resolve one window offset against {@link NOW}. */
function window(
  name: ClaudeTokenBudgetWindow["window"],
  spec: Window,
): ClaudeTokenBudgetWindow {
  return {
    window: name,
    remainingFraction: spec.remaining,
    resetAt: NOW + spec.resetInHours * HOUR,
  };
}

/** The probe result a candidate stands for. */
function snapshotOf(candidate: Candidate): ClaudeTokenBudget {
  if (candidate.unknown !== undefined) {
    return { known: false, label: candidate.label, reason: candidate.unknown };
  }
  const windows: ClaudeTokenBudgetWindow[] = [];
  if (candidate.fiveHour) {
    windows.push(window("five_hour", candidate.fiveHour));
  }
  if (candidate.sevenDay) {
    windows.push(window("seven_day", candidate.sevenDay));
  }
  if (windows.length === 0) {
    throw new Error(`${candidate.label}: a known snapshot needs a window`);
  }
  // The headline is the most constrained window, exactly as #918 reports it.
  const headline = windows.reduce((best, candidate) =>
    candidate.remainingFraction < best.remainingFraction ? candidate : best
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

/** The discovered file for a candidate, as credential discovery returns it. */
function tokenFile(label: string): ProviderTokenFile {
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
async function spawnDecision(
  candidates: readonly Candidate[],
): Promise<{ label: string | null; probes: number }> {
  let probes = 0;
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    now: () => NOW,
    discover: () =>
      Promise.resolve(
        candidates.map((candidate) => tokenFile(candidate.label)),
      ),
    fetchFn: () => {
      probes += 1;
      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  });
  for (const candidate of candidates) {
    pool.recordBudget(candidate.label, snapshotOf(candidate), NOW);
  }
  const chosen = await pool.selectEligible(NOW);
  return { label: chosen?.label ?? null, probes };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** Comfortable five-hour headroom, for a row that is about the week. */
const HEALTHY_FIVE_HOUR: Window = { remaining: 0.7, resetInHours: 4 };

const MATRIX: readonly Row[] = [
  {
    // The primary balancing rule, with nothing else in play: A holds 60% of
    // its week for one more day (2.5%/h), B holds 90% for six more days
    // (0.63%/h). Both clear the guard, so the week decides.
    name: "weekly urgency wins normally",
    candidates: [
      {
        label: "provider",
        fiveHour: HEALTHY_FIVE_HOUR,
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.9, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 144 },
      },
    ],
    winner: "provider",
    reason: "highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // The soft guard doing its job: A has four times B's weekly rate and
    // still loses, because 19% of five hours will not carry an hour-long run
    // while B's 60% will.
    name: "the five-hour guard overrides weekly urgency while another " +
      "credential clears it",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.19, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.6, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 144 },
      },
    ],
    winner: "provider-2",
    reason: "highest-remaining-per-hour",
    spawn: "provider-2",
  },
  {
    // The regression this file exists for: under the old rule neither of
    // these was eligible and the fleet stopped. The guard has nothing to
    // prefer, so it steps aside and the week decides between them.
    name: "every credential below the guard still runs, on the best week",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.19, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.18, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 144 },
      },
    ],
    winner: "provider",
    reason: "below-five-hour-guard-highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // Exhaustion is the hard exclusion: 15% can serve the next call and 0%
    // cannot, whatever the week behind each one holds.
    name: "an exhausted credential loses to a low-but-usable one",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.15, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 144 },
      },
    ],
    winner: "provider-2",
    reason: "below-five-hour-guard-highest-remaining-per-hour",
    spawn: "provider-2",
  },
  {
    // The boundary from below and above, two percentage points apart.
    name: "19% loses to 21% of the five-hour window, whatever the week says",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.19, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.21, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 144 },
      },
    ],
    winner: "provider-2",
    reason: "highest-remaining-per-hour",
    spawn: "provider-2",
  },
  {
    // Exactly at the boundary is usable, so the week decides again and the
    // 20% credential beats the 21% one on its far better rate. A comparison
    // that had become `<= 20%` would invert this row.
    name: "exactly 20% of the five-hour window is usable, so the week decides",
    candidates: [
      {
        label: "provider",
        fiveHour: {
          remaining: CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING,
          resetInHours: 4,
        },
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.21, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 144 },
      },
    ],
    winner: "provider",
    reason: "highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // Use it or lose it: 15% that lapses in three hours is 5%/h, while 90%
    // spread over six days is 0.63%/h.
    name: "an imminent weekly reset beats a far larger balance days away",
    candidates: [
      {
        label: "provider",
        fiveHour: HEALTHY_FIVE_HOUR,
        sevenDay: { remaining: 0.15, resetInHours: 3 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.9, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 144 },
      },
    ],
    winner: "provider",
    reason: "highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // The second regression this file exists for: 8% is under the old 10%
    // weekly floor, and under that floor it would have ranked behind B
    // however soon it lapsed. 8% in two hours is 4%/h against B's 0.56%/h.
    name: "a very low weekly balance is still the urgent one",
    candidates: [
      {
        label: "provider",
        fiveHour: HEALTHY_FIVE_HOUR,
        sevenDay: { remaining: 0.08, resetInHours: 2 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.9, resetInHours: 4 },
        sevenDay: { remaining: 0.8, resetInHours: 144 },
      },
    ],
    winner: "provider",
    reason: "highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // The real fleet shape, all of it low: four credentials between 1% and
    // 19% of five hours, none spent. provider-2's 60% week resetting in a day
    // is 2.5%/h, the best of them.
    name: "a four-credential pool with every five-hour window low still runs",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.19, resetInHours: 4 },
        sevenDay: { remaining: 0.4, resetInHours: 100 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.05, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 24 },
      },
      {
        label: "provider-3",
        fiveHour: { remaining: 0.12, resetInHours: 4 },
        sevenDay: { remaining: 0.1, resetInHours: 5 },
      },
      {
        label: "provider-4",
        fiveHour: { remaining: 0.01, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 150 },
      },
    ],
    winner: "provider-2",
    reason: "below-five-hour-guard-highest-remaining-per-hour",
    spawn: "provider-2",
  },
  {
    // The same fleet, mixed: the two that clear the guard are the only
    // candidates, so provider's spectacular 45%/h week is not reachable and
    // provider-3's 1.25%/h beats provider-4's 0.42%/h.
    name: "a four-credential pool picks the best week of the pair that " +
      "clears the guard",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.19, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 2 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.1, resetInHours: 4 },
        sevenDay: { remaining: 0.5, resetInHours: 3 },
      },
      {
        label: "provider-3",
        fiveHour: { remaining: 0.25, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 24 },
      },
      {
        label: "provider-4",
        fiveHour: { remaining: 0.8, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 144 },
      },
    ],
    winner: "provider-3",
    reason: "highest-remaining-per-hour",
    spawn: "provider-3",
  },
  {
    // One survivor in a spent pool. 5% is far under the guard and still the
    // only credential that can serve a call, so the fleet keeps running.
    name: "one usable credential among three exhausted ones still spawns",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0, resetInHours: 4 },
        sevenDay: { remaining: 0.5, resetInHours: 100 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0, resetInHours: 2 },
        sevenDay: { remaining: 0.5, resetInHours: 100 },
      },
      {
        label: "provider-3",
        fiveHour: { remaining: 0, resetInHours: 6 },
        sevenDay: { remaining: 0.5, resetInHours: 100 },
      },
      {
        label: "provider-4",
        fiveHour: { remaining: 0.05, resetInHours: 4 },
        sevenDay: { remaining: 0.5, resetInHours: 100 },
      },
    ],
    winner: "provider-4",
    reason: "below-five-hour-guard-highest-remaining-per-hour",
    spawn: "provider-4",
  },
  {
    // Nothing can be spent now, so no child is spawned. The ranking still
    // names the credential that recovers first — provider-2's last spent
    // window reopens in two hours against provider's hundred — which is what
    // the existing usage-limit wait is timed against.
    name: "with every credential exhausted no child is spawned, and the " +
      "soonest recovery is still named",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0, resetInHours: 6 },
        sevenDay: { remaining: 0, resetInHours: 100 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0, resetInHours: 2 },
        sevenDay: { remaining: 0.2, resetInHours: 100 },
      },
    ],
    winner: "provider-2",
    reason: "exhausted-soonest-reset",
    spawn: null,
  },
];

for (const row of MATRIX) {
  Deno.test(`claude pool policy - ${row.name} (Issue #1686)`, async () => {
    const ranking = rankClaudeTokenBudgets(
      row.candidates.map(snapshotOf),
      NOW,
    );
    assertEquals(ranking.winner?.label, row.winner);
    assertEquals(ranking.reason, row.reason);

    const decision = await spawnDecision(row.candidates);
    assertEquals(decision.label, row.spawn);
    // Recorded snapshots are fresh, so the decision costs no request at all.
    assertEquals(decision.probes, 0);
  });
}

// ---------------------------------------------------------------------------
// Boundary precision: the comparison must not become `<= 20%`
// ---------------------------------------------------------------------------

Deno.test("claude pool policy - 19.999%, 20% and 20.001% land on the right side of the guard (Issue #1686)", () => {
  const contender: Candidate = {
    label: "provider-2",
    fiveHour: { remaining: 0.5, resetInHours: 4 },
    // A deliberately poor week: only the guard can make this one win.
    sevenDay: { remaining: 0.05, resetInHours: 150 },
  };
  const urgentWeek: Window = { remaining: 0.9, resetInHours: 2 };

  const outcomes = [0.19999, 0.2, 0.20001].map((remaining) => {
    const ranking = rankClaudeTokenBudgets([
      snapshotOf({
        label: "provider",
        fiveHour: { remaining, resetInHours: 4 },
        sevenDay: urgentWeek,
      }),
      snapshotOf(contender),
    ], NOW);
    return {
      remaining,
      winner: ranking.winner?.label,
      guard: ranking.ranked.find((c) => c.label === "provider")
        ?.meetsFiveHourGuard,
    };
  });

  assertEquals(outcomes, [
    // Below: the guard bites and the far better week does not save it.
    { remaining: 0.19999, winner: "provider-2", guard: false },
    // At: usable, so the week decides and the urgent credential wins.
    { remaining: 0.2, winner: "provider", guard: true },
    // Above: usable for the same reason.
    { remaining: 0.20001, winner: "provider", guard: true },
  ]);
});

// ---------------------------------------------------------------------------
// Additional edge cases named by Issue #1686
// ---------------------------------------------------------------------------

Deno.test("claude pool policy - a reset already in the past is a full window, never a negative rate (Issue #1686)", () => {
  const ranking = rankClaudeTokenBudgets([
    // Both windows rolled over after the figures were produced, so the stale
    // near-exhausted shares describe windows that no longer exist.
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.02, resetInHours: -1 },
      sevenDay: { remaining: 0.05, resetInHours: -2 },
    }),
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.5, resetInHours: 144 },
    }),
  ], NOW);

  const rolled = ranking.ranked.find((c) => c.label === "provider");
  assert(rolled !== undefined);
  // Counted as full over the window's nominal length — never divided by a
  // zero or negative hours-until-reset.
  assertEquals(rolled.remainingFraction, 1);
  assertEquals(rolled.rateWindow?.hoursUntilReset, 168);
  assertEquals(rolled.ratePerHour, 1 / 168);
  assert(rolled.ratePerHour !== null && rolled.ratePerHour > 0);
  // A rolled-over 0% window is not an exhaustion: the quota is back.
  assertEquals(rolled.exhausted, false);
  assertEquals(rolled.meetsFiveHourGuard, true);
  assertEquals(ranking.winner?.label, "provider");
});

Deno.test("claude pool policy - a reset landing exactly on now is already rolled over (Issue #1686)", () => {
  const ranking = rankClaudeTokenBudgets([
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0, resetInHours: 0 },
      sevenDay: { remaining: 0, resetInHours: 0 },
    }),
  ], NOW);

  const onTheBoundary = ranking.ranked[0];
  assert(onTheBoundary !== undefined);
  assertEquals(onTheBoundary.exhausted, false);
  assertEquals(onTheBoundary.rateWindow?.hoursUntilReset, 168);
  assertEquals(onTheBoundary.ratePerHour, 1 / 168);
});

Deno.test("claude pool policy - equal weekly rates break towards the soonest reset, then discovery order (Issue #1686)", () => {
  // Same rate, different resets: 30% in six hours and 60% in twelve are both
  // 5%/h, so the one that lapses first is spent first.
  const differentResets = rankClaudeTokenBudgets([
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.6, resetInHours: 12 },
    }),
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.3, resetInHours: 6 },
    }),
  ], NOW);
  assertEquals(differentResets.winner?.label, "provider-2");
  assertEquals(
    differentResets.reason,
    "equal-remaining-per-hour-soonest-reset",
  );

  // Identical rate AND reset: discovery order decides, so the run starts on
  // today's primary `provider.env` and the same host decides the same way
  // every time.
  const identical: readonly Candidate[] = [
    {
      label: "provider",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.6, resetInHours: 12 },
    },
    {
      label: "provider-2",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.6, resetInHours: 12 },
    },
  ];
  const tied = rankClaudeTokenBudgets(identical.map(snapshotOf), NOW);
  assertEquals(tied.winner?.label, "provider");
  assertEquals(tied.reason, "tied-discovery-order");

  // Deterministic, not incidental: the same pool discovered the other way
  // round names the other credential, and neither answer wanders between
  // runs.
  const reversed = rankClaudeTokenBudgets(
    [...identical].reverse().map(snapshotOf),
    NOW,
  );
  assertEquals(reversed.winner?.label, "provider-2");
  assertEquals(reversed.reason, "tied-discovery-order");
});

Deno.test("claude pool policy - a credential reporting no seven-day window is ranked on the window it did report (Issue #1686)", () => {
  const ranking = rankClaudeTokenBudgets([
    // Five-hour only: the documented fallback ranks it on that window's rate,
    // 60% over four hours = 15%/h, rather than dropping it.
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.6, resetInHours: 4 },
    }),
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.5, resetInHours: 144 },
    }),
  ], NOW);

  const fallback = ranking.ranked.find((c) => c.label === "provider");
  assertEquals(fallback?.rateWindow?.window, "five_hour");
  assertEquals(fallback?.ratePerHour, 0.6 / 4);
  assertEquals(ranking.winner?.label, "provider");
});

Deno.test("claude pool policy - an unknown budget ranks last without being dropped, and cannot outrank a healthy credential (Issue #1686)", () => {
  const ranking = rankClaudeTokenBudgets([
    // First in discovery order, so only the band rule can demote it.
    snapshotOf({ label: "provider", unknown: "http-401" }),
    snapshotOf({
      label: "provider-2",
      // Deliberately meagre: even the least attractive known credential
      // outranks a credential nobody has measured.
      fiveHour: { remaining: 0.01, resetInHours: 4 },
      sevenDay: { remaining: 0.01, resetInHours: 150 },
    }),
  ], NOW);

  assertEquals(ranking.ranked.map((c) => c.label), [
    "provider-2",
    "provider",
  ]);
  assertEquals(ranking.winner?.label, "provider-2");

  // Nothing is dropped: with every budget unknown the run still starts, on
  // discovery order.
  const allUnknown = rankClaudeTokenBudgets([
    snapshotOf({ label: "provider", unknown: "network-error" }),
    snapshotOf({ label: "provider-2", unknown: "timeout" }),
  ], NOW);
  assertEquals(allUnknown.ranked.length, 2);
  assertEquals(allUnknown.winner?.label, "provider");
  assertEquals(allUnknown.reason, "budget-unknown-discovery-order");
});

Deno.test("claude pool policy - a credential reporting no five-hour window has no guard to fall under (Issue #1686)", async () => {
  const candidates: readonly Candidate[] = [
    // Seven-day only. The documented fallback is that an absent window is not
    // a failed guard, so this ranks in the top band on its 1.25%/h week.
    { label: "provider", sevenDay: { remaining: 0.3, resetInHours: 24 } },
    {
      label: "provider-2",
      fiveHour: { remaining: 0.19, resetInHours: 4 },
      sevenDay: { remaining: 0.9, resetInHours: 144 },
    },
  ];
  const ranking = rankClaudeTokenBudgets(candidates.map(snapshotOf), NOW);
  const absent = ranking.ranked.find((c) => c.label === "provider");
  assertEquals(absent?.fiveHour, null);
  assertEquals(absent?.meetsFiveHourGuard, true);
  assertEquals(ranking.winner?.label, "provider");

  // The fallback is a pass on the guard, not a bonus on the rate: a
  // credential that clears the guard on real figures and holds the better
  // week still wins.
  const better = rankClaudeTokenBudgets([
    snapshotOf(candidates[0]!),
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.6, resetInHours: 24 },
    }),
  ], NOW);
  assertEquals(better.winner?.label, "provider-2");

  // And the spawn decision agrees with the ranking on both.
  assertEquals((await spawnDecision(candidates)).label, "provider");
});

Deno.test("claude pool policy - a freshly recorded exhaustion beats a cached snapshot that still showed quota (Issue #1686)", async () => {
  let probes = 0;
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    now: () => NOW,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: () => {
      probes += 1;
      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  });

  // Both measured moments ago; provider is the better week, so it is chosen.
  pool.recordBudget(
    "provider",
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.6, resetInHours: 24 },
    }),
    NOW,
  );
  pool.recordBudget(
    "provider-2",
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.9, resetInHours: 4 },
      sevenDay: { remaining: 0.5, resetInHours: 144 },
    }),
    NOW,
  );
  assertEquals((await pool.selectEligible(NOW))?.label, "provider");

  // The run then hits a usage limit on provider. The API has just said the
  // window is gone, so the structured result must override the cached
  // figures immediately — waiting for the snapshot to go stale would send the
  // next call straight back to the credential that just refused it.
  pool.recordExhaustion("provider", [
    { window: "five_hour", resetAt: NOW + 3 * HOUR },
  ]);

  assertEquals((await pool.selectEligible(NOW))?.label, "provider-2");
  // Still within the snapshot's life, so the switch cost no request.
  assertEquals(probes, 0);
});
