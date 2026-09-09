/**
 * Missing seven-day telemetry must not outrank a known weekly quota
 * (Issue #1731, parent #1653).
 *
 * A five-hour remaining share divided by hours-until-reset and a seven-day
 * remaining share divided by hours-until-reset are numbers on different
 * scales. Ranking compared them directly, so a credential whose probe simply
 * omitted the weekly header looked forty times more urgent than a healthy one
 * and was selected over it — 60% of five hours resetting in four hours is
 * 15%/h against a genuine week's 0.35%/h.
 *
 * The policy these rows pin, on top of the #1685 bands they do not change:
 *
 * - **exhaustion is still the hard exclusion**, and the five-hour 20% figure
 *   is still the soft guard — both are decided *before* telemetry quality, so
 *   a missing weekly window never becomes a third eligibility gate;
 * - inside a band, **every candidate with seven-day telemetry ranks ahead of
 *   every candidate without it**, whatever the two rates say;
 * - when a whole band lacks seven-day telemetry the pool still runs: those
 *   candidates are ranked against each other on the same-scale window they
 *   did report, then the existing stable tie-breaks;
 * - the degradation carries no memory — a later snapshot that reports a week
 *   ranks normally again immediately.
 *
 * Every row is asserted on both surfaces that read the policy, the pure
 * `rankClaudeTokenBudgets` and `ClaudeCredentialPool.selectEligible`, from
 * synthetic snapshots recorded rather than probed, so nothing here touches the
 * network, the clock, the filesystem or the process environment.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ClaudeTokenSelectionReason,
  formatClaudeTokenSelectionLog,
  rankClaudeTokenBudgets,
} from "../lib/claude_token_selection.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import {
  CLAUDE_PROVIDER,
  POOL_NOW as NOW,
  type PoolCandidate as Candidate,
  poolTokenFile as tokenFile,
  type PoolWindow as Window,
  snapshotOf,
  spawnDecision,
} from "./support/claude_pool_fixtures.ts";

/** One row of the telemetry-quality matrix. */
interface Row {
  /** What the row is about, used as the test name. */
  readonly name: string;
  /** The pool, in discovery order — the tie-break of last resort. */
  readonly candidates: readonly Candidate[];
  /** The order the ranking must produce, best first. */
  readonly order: readonly string[];
  /** Why the winner won, as the log records it. */
  readonly reason: ClaudeTokenSelectionReason;
  /** The credential a child may be spawned on, or null when none may be. */
  readonly spawn: string | null;
}

/** Comfortable five-hour headroom, for a row that is about the week. */
const HEALTHY_FIVE_HOUR: Window = { remaining: 0.7, resetInHours: 4 };

const MATRIX: readonly Row[] = [
  {
    // The bug, exactly as the issue states it: 0.5/144 = 0.35%/h of a real
    // week against 0.6/4 = 15%/h of five hours. The larger number describes a
    // different window, so it must not win.
    name: "a known week beats a missing one whose five-hour rate is far larger",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.6, resetInHours: 4 },
      },
      {
        label: "provider-2",
        fiveHour: HEALTHY_FIVE_HOUR,
        sevenDay: { remaining: 0.5, resetInHours: 144 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "seven-day-telemetry-preferred",
    spawn: "provider-2",
  },
  {
    // Telemetry quality decides nothing when both have it: the #1685 weekly
    // urgency rule is untouched.
    name: "two credentials with weekly telemetry still rank on weekly urgency",
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
    order: ["provider", "provider-2"],
    reason: "highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // Degraded but working: nobody reported a week, so the reported five-hour
    // windows are compared with each other — like for like — and the pool
    // still names a credential rather than idling.
    name: "with no weekly telemetry anywhere the pool still selects, on the " +
      "same-scale window",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.4, resetInHours: 4 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.9, resetInHours: 4 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "no-seven-day-telemetry-degraded-fallback",
    spawn: "provider-2",
  },
  {
    // The soft guard is decided first: a missing week at 60% of five hours is
    // usable now, a known week at 5% of five hours is not, so the guard —
    // not the telemetry — orders these two.
    name: "the five-hour guard is applied before the telemetry tie-break",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.05, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 6 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.6, resetInHours: 4 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "no-seven-day-telemetry-degraded-fallback",
    spawn: "provider-2",
  },
  {
    // And the other way round: a missing week under the guard does not jump
    // a known week that clears it.
    name: "a missing week under the guard stays behind a known week above it",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.05, resetInHours: 4 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.6, resetInHours: 4 },
        sevenDay: { remaining: 0.5, resetInHours: 144 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "highest-remaining-per-hour",
    spawn: "provider-2",
  },
  {
    // The guard's exact boundary, with the telemetry gap across it: 20% is
    // usable and 19.999% is not, so the credential missing a week leads on
    // the band alone. A guard applied after the telemetry tie-break would
    // invert this row.
    name: "at the guard's boundary the band decides, not the telemetry gap",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.19999, resetInHours: 4 },
        sevenDay: { remaining: 0.9, resetInHours: 2 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.2, resetInHours: 4 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "no-seven-day-telemetry-degraded-fallback",
    spawn: "provider-2",
  },
  {
    // Both under the guard, so it steps aside; inside that band the known
    // week still outranks the absent one.
    name: "inside the below-guard band a known week still beats a missing one",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.1, resetInHours: 4 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.15, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 150 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "seven-day-telemetry-preferred",
    spawn: "provider-2",
  },
  {
    // The two signals colliding: the guard has stepped aside because nothing
    // clears it, and neither survivor reported a week either. The pool must
    // still run, on the like-for-like five-hour figures — 15%/h against
    // 2.5%/h — and the reason names the degraded fallback it actually used
    // rather than a weekly rate neither credential has.
    name: "a below-guard pool with no weekly telemetry anywhere still runs",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0.1, resetInHours: 4 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.15, resetInHours: 1 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "no-seven-day-telemetry-degraded-fallback",
    spawn: "provider-2",
  },
  {
    // Exhaustion is still the hard exclusion, and it is decided above
    // telemetry quality: a spent week cannot be spent from, however well
    // measured it is, so the unmeasured-but-usable credential runs.
    name: "an exhausted credential with weekly telemetry loses to a usable " +
      "one without it",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0, resetInHours: 3 },
        sevenDay: { remaining: 0.9, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.5, resetInHours: 4 },
      },
    ],
    order: ["provider-2", "provider"],
    reason: "no-seven-day-telemetry-degraded-fallback",
    spawn: "provider-2",
  },
  {
    // A missing five-hour window is not a missing week: #1686 says an absent
    // guard window is a pass, and this credential's week is measured, so it
    // ranks normally on 0.3/24 = 1.25%/h.
    name: "a missing five-hour window is not conflated with a missing week",
    candidates: [
      {
        label: "provider",
        sevenDay: { remaining: 0.3, resetInHours: 24 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.9, resetInHours: 4 },
        sevenDay: { remaining: 0.5, resetInHours: 144 },
      },
    ],
    order: ["provider", "provider-2"],
    reason: "highest-remaining-per-hour",
    spawn: "provider",
  },
  {
    // The real fleet shape, mixed: provider-3 and provider-4 have weeks and
    // clear the guard, so they lead on weekly urgency (1.25%/h against
    // 0.42%/h); provider-2 has no week and follows them; provider is spent
    // and comes last however healthy its week looks.
    name: "a four-credential pool orders exhaustion, guard, telemetry and " +
      "then the week",
    candidates: [
      {
        label: "provider",
        fiveHour: { remaining: 0, resetInHours: 2 },
        sevenDay: { remaining: 0.9, resetInHours: 3 },
      },
      {
        label: "provider-2",
        fiveHour: { remaining: 0.8, resetInHours: 4 },
      },
      {
        label: "provider-3",
        fiveHour: { remaining: 0.25, resetInHours: 4 },
        sevenDay: { remaining: 0.3, resetInHours: 24 },
      },
      {
        label: "provider-4",
        fiveHour: { remaining: 0.9, resetInHours: 4 },
        sevenDay: { remaining: 0.6, resetInHours: 144 },
      },
    ],
    order: ["provider-3", "provider-4", "provider-2", "provider"],
    reason: "highest-remaining-per-hour",
    spawn: "provider-3",
  },
];

for (const row of MATRIX) {
  Deno.test(`claude pool telemetry quality - ${row.name} (Issue #1731)`, async () => {
    const ranking = rankClaudeTokenBudgets(
      row.candidates.map(snapshotOf),
      NOW,
    );
    assertEquals(ranking.ranked.map((c) => c.label), row.order);
    assertEquals(ranking.reason, row.reason);

    const decision = await spawnDecision(row.candidates);
    assertEquals(decision.label, row.spawn);
    // Recorded snapshots are fresh, so the decision costs no request at all.
    assertEquals(decision.probes, 0);
  });
}

Deno.test("claude pool telemetry quality - the ranking view says which candidates carry a week (Issue #1731)", () => {
  const ranking = rankClaudeTokenBudgets([
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.6, resetInHours: 4 },
    }),
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.7, resetInHours: 4 },
      sevenDay: { remaining: 0.5, resetInHours: 144 },
    }),
    snapshotOf({ label: "provider-3", unknown: "http-401" }),
  ], NOW);

  const view = new Map(
    ranking.ranked.map((c) => [c.label, c.hasSevenDayTelemetry]),
  );
  assertEquals(view.get("provider-2"), true);
  // Degraded, not exhausted and not unknown: it is still a usable candidate.
  assertEquals(view.get("provider"), false);
  const degraded = ranking.ranked.find((c) => c.label === "provider");
  assertEquals(degraded?.exhausted, false);
  assertEquals(degraded?.rateWindow?.window, "five_hour");
  // A probe that failed reports no window at all, so it carries no week
  // either — and it still ranks last, behind the degraded candidate.
  assertEquals(view.get("provider-3"), false);
  assertEquals(ranking.ranked.at(-1)?.label, "provider-3");
});

Deno.test("claude pool telemetry quality - the degraded fallback is deterministic and total (Issue #1731)", () => {
  // Identical five-hour figures, no week anywhere: the reported reset breaks
  // the rate tie, then discovery order, so the same pool decides the same way
  // every run.
  const same: Window = { remaining: 0.5, resetInHours: 4 };
  const forwards = rankClaudeTokenBudgets([
    snapshotOf({ label: "provider", fiveHour: same }),
    snapshotOf({ label: "provider-2", fiveHour: same }),
  ], NOW);
  assertEquals(forwards.ranked.map((c) => c.label), ["provider", "provider-2"]);
  // Level on every comparable figure, so the existing stable tie-break — not
  // the telemetry gap — is what named the winner.
  assertEquals(forwards.reason, "tied-discovery-order");

  const backwards = rankClaudeTokenBudgets([
    snapshotOf({ label: "provider-2", fiveHour: same }),
    snapshotOf({ label: "provider", fiveHour: same }),
  ], NOW);
  assertEquals(backwards.ranked.map((c) => c.label), [
    "provider-2",
    "provider",
  ]);

  // Same rate, different resets: the window that lapses first is spent first.
  const resets = rankClaudeTokenBudgets([
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.5, resetInHours: 4 },
    }),
    snapshotOf({
      label: "provider-2",
      fiveHour: { remaining: 0.25, resetInHours: 2 },
    }),
  ], NOW);
  assertEquals(resets.ranked.map((c) => c.label), ["provider-2", "provider"]);
  assertEquals(resets.reason, "equal-remaining-per-hour-soonest-reset");
});

Deno.test("claude pool telemetry quality - a later snapshot with a week restores normal ranking, with no lingering penalty (Issue #1731)", async () => {
  let probes = 0;
  const pool = createClaudeCredentialPool({
    provider: CLAUDE_PROVIDER,
    now: () => NOW,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: () => {
      probes += 1;
      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  });

  // provider's probe omitted the weekly header, so the measured credential
  // runs even though provider's five-hour rate is the larger number.
  pool.recordBudget(
    "provider",
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.6, resetInHours: 4 },
    }),
    NOW,
  );
  pool.recordBudget(
    "provider-2",
    snapshotOf({
      label: "provider-2",
      fiveHour: HEALTHY_FIVE_HOUR,
      sevenDay: { remaining: 0.5, resetInHours: 144 },
    }),
    NOW,
  );
  assertEquals((await pool.selectEligible(NOW))?.label, "provider-2");

  // The next probe carries the week. Nothing is remembered about the gap, so
  // provider's genuine 2.5%/h urgency wins immediately.
  pool.recordBudget(
    "provider",
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.6, resetInHours: 4 },
      sevenDay: { remaining: 0.6, resetInHours: 24 },
    }),
    NOW,
  );
  assertEquals((await pool.selectEligible(NOW))?.label, "provider");
  assertEquals(probes, 0, "recorded snapshots are fresh, so nothing is probed");
});

Deno.test("claude pool telemetry quality - the decision log names the absent week and the reason (Issue #1731)", () => {
  const lines = formatClaudeTokenSelectionLog(rankClaudeTokenBudgets([
    snapshotOf({
      label: "provider",
      fiveHour: { remaining: 0.6, resetInHours: 4 },
    }),
    snapshotOf({
      label: "provider-2",
      fiveHour: HEALTHY_FIVE_HOUR,
      sevenDay: { remaining: 0.5, resetInHours: 144 },
    }),
  ], NOW));

  const joined = lines.join("\n");
  assert(
    joined.includes("seven_day=absent"),
    `the absent week is named: ${joined}`,
  );
  assert(
    joined.includes(
      "selected provider-2 (#2) of 2: seven-day-telemetry-preferred",
    ),
    `the winning reason is logged: ${joined}`,
  );
});
