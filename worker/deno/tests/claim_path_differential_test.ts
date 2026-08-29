/**
 * Census-vs-scan differential over generated repo states (Issue #524).
 *
 * The comparison itself is not new — it is the idle-inversion alert, which
 * runs on the live fleet once per cycle, needs three consecutive cycles before
 * it speaks, and then waits for a human. Minimum detection latency: hours, and
 * every incident so far (#319, #375, #429, #437, #499) was found that way
 * rather than by a failing test.
 *
 * The same comparison over generated states runs in milliseconds here.
 * `CENSUS_SCAN_GATE_COVERAGE` makes it well defined: only the `modelled` gates
 * need to agree, with the `run-local` axes held constant — which
 * `runClaimScan` does.
 *
 * Coverage: every **pair** of modelled gates, in both tier arrangements. Every
 * incident to date was a pair or a single; none needed three gates to
 * interact.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  MODELLED_GATES,
  type ModelledGate,
  type RepoState,
  runCensus,
  runClaimScan,
  type StateIssue,
} from "./fixtures/claim_path_state.ts";

/** The gate axis, including "nothing refuses this issue". */
const GATE_AXIS: ModelledGate[] = ["none", ...MODELLED_GATES];

/** Tier arrangements worth pairing — tier-3 suppression makes them differ. */
const TIER_PAIRS: Array<[StateIssue["tier"], StateIssue["tier"]]> = [
  ["work-on", "low-priority"],
  ["work-on", "work-on"],
  ["low-priority", "low-priority"],
];

/**
 * Assert the two instruments agree about a state.
 *
 * The census reports which issues are claimable; the scan claims one of them.
 * A disagreement in either direction is the production signature: the census
 * saying "claimable work is here" while the scan refuses the lot is exactly
 * the `[idle-census] … ALERT inversion` line, and the scan claiming an issue
 * the census called blocked would mean the census suppresses the idle filer
 * for work that is in fact being served.
 */
async function assertInstrumentsAgree(state: RepoState): Promise<void> {
  const entry = runCensus(state);
  const outcome = await runClaimScan(state);
  const claimable = entry.claimableIssues;
  const label = JSON.stringify(state.issues);

  assertEquals(
    outcome.claimed,
    claimable.length > 0,
    `census claimable=[${claimable}] but scan claimed=${outcome.claimedIssue} ` +
      `for ${label}`,
  );
  if (outcome.claimedIssue !== null) {
    assertEquals(
      claimable.includes(outcome.claimedIssue),
      true,
      `scan claimed #${outcome.claimedIssue}, which the census did not count ` +
        `as claimable ([${claimable}]) for ${label}`,
    );
  }
}

for (const [tierA, tierB] of TIER_PAIRS) {
  Deno.test(
    `claim path - census and scan agree over every gate pair (${tierA} × ${tierB}, Issue #524)`,
    async () => {
      for (const gateA of GATE_AXIS) {
        for (const gateB of GATE_AXIS) {
          await assertInstrumentsAgree({
            repo: "owner/differential",
            issues: [
              { number: 11, tier: tierA, gate: gateA },
              { number: 22, tier: tierB, gate: gateB },
            ],
          });
        }
      }
    },
  );
}

Deno.test(
  "claim path - census and scan agree on a single issue behind each gate (Issue #524)",
  async () => {
    for (const gate of GATE_AXIS) {
      for (const tier of ["work-on", "low-priority"] as const) {
        await assertInstrumentsAgree({
          repo: "owner/differential",
          issues: [{ number: 7, tier, gate }],
        });
      }
    }
  },
);

Deno.test(
  "claim path - the #499 shape: a permanently-blocked work-on issue must not hide the backlog (Issue #524)",
  async () => {
    // The `NEAT-AI-Rebase` state, in miniature: one `work-on` issue named by a
    // merged fleet PR, and a `low-priority` backlog behind it. Before #499 the
    // scan claimed nothing here while the census counted the backlog as
    // claimable — three cycles of that filed an issue against a human.
    const state: RepoState = {
      repo: "owner/differential",
      issues: [
        { number: 48, tier: "work-on", gate: "merged-pr-permanent" },
        { number: 60, tier: "low-priority" },
        { number: 61, tier: "low-priority" },
      ],
    };
    const entry = runCensus(state);
    assertEquals(entry.claimableIssues, [60, 61]);
    assertEquals(entry.mergedPrBlocked, 1);
    assertEquals(entry.lowPrioritySuppressed, 0);

    const outcome = await runClaimScan(state);
    assertEquals(outcome.claimed, true);
    assertEquals([60, 61].includes(outcome.claimedIssue ?? -1), true);
  },
);

Deno.test(
  "claim path - an eligible work-on issue does suppress the backlog, and both instruments say so (Issue #524)",
  async () => {
    // The other side of the same rule: a `work-on` issue nothing refuses is a
    // genuine serialisation signal, so tier 3 waits. Over-correcting #499 into
    // "nothing suppresses" would break the one-PR-per-work-stream guarantee.
    const state: RepoState = {
      repo: "owner/differential",
      issues: [
        { number: 48, tier: "work-on" },
        { number: 60, tier: "low-priority" },
      ],
    };
    const entry = runCensus(state);
    assertEquals(entry.claimableIssues, [48]);
    assertEquals(entry.lowPrioritySuppressed, 1);

    const outcome = await runClaimScan(state);
    assertEquals(outcome.claimedIssue, 48);
  },
);
