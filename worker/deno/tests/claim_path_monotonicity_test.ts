/**
 * Monotonicity of the claim path (Issue #524).
 *
 * The cheapest property on the list, and the one #499 violated directly:
 *
 * > Adding an issue to a repo must never take away a claim the scan was
 * > already making.
 *
 * No generator and no fixtures are needed — two states are enough. On
 * `stSoftwareAU/NEAT-AI-Rebase` a single `work-on` issue, refused for ever
 * because a merged PR named it, removed all 28 `low-priority` candidates: the
 * repo went from "claims work every cycle" to "claims nothing, ever", and the
 * only instrument that noticed was a fleet alert three cycles later.
 *
 * Note this is *not* the same as "the candidate set never shrinks". Tier-3
 * suppression legitimately shrinks it: an eligible `work-on` issue parks the
 * `low-priority` backlog on purpose, and the covering test below pins that.
 * What must never happen is the scan being left with **nothing** to claim
 * because of an issue that was itself unclaimable.
 *
 * The converse direction is pinned too: blocking an issue must not conjure
 * work in its own tier out of nothing.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { SKIP_REASON_CLEARING } from "../lib/skip_reason_clearing.ts";
import {
  MODELLED_GATES,
  type ModelledGate,
  type RepoState,
  runClaimScan,
  type StateIssue,
} from "./fixtures/claim_path_state.ts";

/** A backlog the scan certainly claims from, so a regression is visible. */
const BACKLOG: StateIssue[] = [
  { number: 60, tier: "low-priority" },
  { number: 61, tier: "low-priority" },
  { number: 62, tier: "low-priority" },
];

/** Gates whose refusal never clears without an outside actor. */
const NON_CLEARING_GATES: ModelledGate[] = [
  "merged-pr-permanent",
  "dependency-blocked",
];

Deno.test(
  "claim path - a work-on issue nothing can claim must not starve the backlog (Issue #524)",
  async () => {
    const before = await runClaimScan({
      repo: "owner/monotone",
      issues: BACKLOG,
    });
    assertEquals(before.claimed, true, "baseline backlog must be claimable");

    for (const gate of NON_CLEARING_GATES) {
      const after = await runClaimScan({
        repo: "owner/monotone",
        issues: [{ number: 48, tier: "work-on", gate }, ...BACKLOG],
      });
      assertEquals(
        after.claimed,
        true,
        `adding a work-on issue held by '${gate}' — which never clears by ` +
          `itself — starved a backlog the scan was claiming from`,
      );
    }
  },
);

Deno.test(
  "claim path - a work-on issue refused for an untrusted label must not starve the backlog (Issue #524)",
  async () => {
    // `label-author-not-allowed` is not a gate the census can see, so no
    // differential test reaches it — only the invariant does. The scan strips
    // the untrusted label and explains itself (#3575), which means the issue
    // is not work anybody is waiting on, and it must not park the backlog.
    const after = await runClaimScan({
      repo: "owner/monotone",
      issues: [
        { number: 48, tier: "work-on", untrustedLabel: true },
        ...BACKLOG,
      ],
    });
    assertEquals(after.claimed, true);
  },
);

Deno.test(
  "claim path - adding an eligible issue of any tier never removes the claim (Issue #524)",
  async () => {
    for (const tier of ["work-on", "low-priority"] as const) {
      const after = await runClaimScan({
        repo: "owner/monotone",
        issues: [{ number: 48, tier }, ...BACKLOG],
      });
      assertEquals(
        after.claimed,
        true,
        `adding an eligible ${tier} issue removed the claim`,
      );
    }
  },
);

Deno.test(
  "claim path - a gate parks the backlog exactly when it is declared self-clearing (Issue #524)",
  async () => {
    // The general sweep, and the contract behind the whole classification: a
    // gate may park the lower tiers **iff** its refusal clears by itself. A
    // bounded wait (an occupied stream frees, a PR lands) is serialisation and
    // is meant to suppress; an unbounded one is the #499 deadlock. Checked at
    // the loop's own altitude — "given a repo in this state, does the scan
    // claim anything?" — so a collector that forgets to consult the map fails
    // here even though every per-gate test still passes.
    for (const gate of MODELLED_GATES) {
      const parksBacklog = SKIP_REASON_CLEARING[gate] === "self";
      const withWorkOn = await runClaimScan({
        repo: "owner/monotone",
        issues: [{ number: 48, tier: "work-on", gate }, ...BACKLOG],
      });
      assertEquals(
        withWorkOn.claimed,
        !parksBacklog,
        `a work-on issue held by '${gate}' (declared ` +
          `'${SKIP_REASON_CLEARING[gate]}') left the scan claiming ` +
          `${withWorkOn.claimedIssue} — the declaration and the behaviour ` +
          `disagree`,
      );

      // A gated tier-3 issue suppresses nothing, so the rest of the backlog
      // stays claimable whatever refused it.
      const withLowPriority = await runClaimScan({
        repo: "owner/monotone",
        issues: [{ number: 48, tier: "low-priority", gate }, ...BACKLOG],
      });
      assertEquals(
        withLowPriority.claimed,
        true,
        `adding a low-priority issue held by '${gate}' removed the claim`,
      );
    }
  },
);

Deno.test(
  "claim path - tier-3 suppression still parks the backlog behind claimable work-on (Issue #524)",
  async () => {
    // The covering test for the invariant above: monotonicity must not be
    // "read" as "nothing may ever suppress". An eligible `work-on` issue is a
    // genuine serialisation signal, so the scan claims *it* and leaves the
    // backlog alone.
    const state: RepoState = {
      repo: "owner/monotone",
      issues: [{ number: 48, tier: "work-on" }, ...BACKLOG],
    };
    const outcome = await runClaimScan(state);
    assertEquals(outcome.claimedIssue, 48);
  },
);

Deno.test(
  "claim path - blocking an issue never grows its own tier (Issue #524)",
  async () => {
    // The other direction. Blocking a `low-priority` issue must not make some
    // *other* `low-priority` issue claimable that was not claimable before —
    // the tier can only lose members, never gain them.
    const open = await runClaimScan({
      repo: "owner/monotone",
      issues: BACKLOG,
    });
    assertEquals(open.claimed, true);

    for (const gate of MODELLED_GATES) {
      const blocked = await runClaimScan({
        repo: "owner/monotone",
        issues: BACKLOG.map((issue) =>
          issue.number === open.claimedIssue ? { ...issue, gate } : issue
        ),
      });
      assertEquals(
        blocked.claimedIssue === open.claimedIssue,
        false,
        `'${gate}' was applied to #${open.claimedIssue}, yet the scan still ` +
          `claimed it`,
      );
      assertEquals(
        blocked.claimed,
        true,
        `blocking one backlog issue removed the whole tier under '${gate}'`,
      );
    }
  },
);
