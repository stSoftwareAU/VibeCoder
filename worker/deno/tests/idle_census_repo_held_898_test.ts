/**
 * A repository the claim scan never looked at refused nothing (Issue #898).
 *
 * # The incident
 *
 * `stSoftwareAU/VibeCoder` escalated on three consecutive cycles with nine
 * `work-on` issues the census called claimable:
 *
 * ```
 * [idle-census] repo=stSoftwareAU/VibeCoder monitored=true scanned=true
 *               skip_reason=scanned work_on=9 inversion_signal=true
 * [idle-census] ALERT inversion repos=stSoftwareAU/VibeCoder
 * ```
 *
 * The filed issue's "What the claim scan did with them" section was empty —
 * the scan had recorded no reason for a single one of the nine, because it
 * never reached them. `findOldestIssue` skips a repository outright when it
 * appears in `excludeRepos` (`logRepoClassification(repo, "in-flight")`,
 * Issue #4176), and that set is `InFlightRepoRegistry.heldRepos()`: every
 * repository an issue slot **or** the maintenance lane (Issue #213) holds.
 * The lane servicing one VibeCoder PR therefore made the whole repository
 * invisible to the pool's scan; the scan then found nothing anywhere else,
 * set `eligibilityScanCompleted`, and the census — which is told one
 * cycle-wide boolean and applies it to every repo — read `scanned=true`.
 *
 * # What these tests pin
 *
 * A repo held in flight is recorded as `repo_held_in_flight`, reported in its
 * own bucket with a note that names the hold, and never escalated: it is
 * Issue #437's rule ("only a scan that actually refused the work may be
 * escalated") applied per repo instead of per cycle. The inversion signal
 * itself is unchanged, so the idle-task filer stays suppressed while real
 * work waits (Issue #2813).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
  formatIdleDecisionCensus,
  isRepoHeldSkipReason,
  type RepoCensusInput,
  resolveRepoScanState,
} from "../lib/idle_decision_census.ts";

function issue(number: number, labels: string[]): CensusIssue {
  return { number, labels, assignees: [], milestone: "" };
}

function repoInput(
  partial: Partial<RepoCensusInput> & { repo: string },
): RepoCensusInput {
  return {
    repo: partial.repo,
    monitored: partial.monitored ?? true,
    scannedThisCycle: partial.scannedThisCycle ?? true,
    nice: partial.nice ?? 0,
    skipReason: partial.skipReason,
    issues: partial.issues ?? [],
  };
}

/** The reported incident: nine claimable issues, held, escalated anyway. */
function heldVibeCoder(): RepoCensusInput {
  return repoInput({
    repo: "stSoftwareAU/VibeCoder",
    scannedThisCycle: false,
    skipReason: "repo_held_in_flight",
    issues: [870, 869, 847, 841, 839, 838, 837, 835, 796].map((n) =>
      issue(n, ["work-on"])
    ),
  });
}

Deno.test("census - a held repo's inversion is never escalated (Issue #898)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [heldVibeCoder()],
  });

  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 9, "the work is real and still counted");
  assertEquals(entry.inversionSignal, true);
  // The work is real, so the idle-task filer stays suppressed (Issue #2813).
  assertEquals(census.inversionDetected, true);
  assertEquals(census.inversionRepos, ["stSoftwareAU/VibeCoder"]);
  // But the scan never looked at it, so it refused nothing (Issue #437).
  assertEquals(census.escalationRepos, []);
  assertEquals(census.heldInversionRepos, ["stSoftwareAU/VibeCoder"]);
});

Deno.test("census - a held repo is not reported as a plain deferral (Issue #898)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [heldVibeCoder()],
  });

  // `deferredInversionRepos` carries the "nothing refused this work" note,
  // which is true here but says nothing about *why* the scan never looked.
  // Issue #479's lesson: name the gate, or an operator reads cycle duration.
  assertEquals(census.deferredInversionRepos, []);
  assertEquals(census.gatedInversionRepos, []);
});

Deno.test("census - held is decided per repo, beside scanned and deadline repos (Issue #898)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/scanned", issues: [issue(1, ["work-on"])] }),
      repoInput({
        repo: "org/held",
        scannedThisCycle: false,
        skipReason: "repo_held_in_flight",
        issues: [issue(2, ["work-on"])],
      }),
      repoInput({
        repo: "org/deadline",
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(3, ["top-priority"])],
      }),
    ],
  });

  assertEquals(census.inversionRepos, [
    "org/scanned",
    "org/held",
    "org/deadline",
  ]);
  assertEquals(census.escalationRepos, ["org/scanned"]);
  assertEquals(census.heldInversionRepos, ["org/held"]);
  assertEquals(census.deferredInversionRepos, ["org/deadline"]);
});

Deno.test("census - a held repo with nothing claimable appears in no bucket (Issue #898)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/held",
        scannedThisCycle: false,
        skipReason: "repo_held_in_flight",
        issues: [issue(1, ["idle-task"])],
      }),
    ],
  });

  assertEquals(census.inversionDetected, false);
  assertEquals(census.heldInversionRepos, []);
  assertEquals(census.escalationRepos, []);
});

Deno.test("formatter - names the hold instead of the deferral note (Issue #898)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [heldVibeCoder()],
  });

  const lines = formatIdleDecisionCensus(census, "host1:42");
  const repoLine = lines.find((l) =>
    l.includes("repo=stSoftwareAU/VibeCoder")
  )!;
  assert(repoLine.includes("scanned=false"));
  assert(repoLine.includes("skip_reason=repo_held_in_flight"));

  const note = lines.find((l) => l.includes("NOTE inversion_repo_held"))!;
  assert(note.includes("repos=stSoftwareAU/VibeCoder"));
  assert(note.includes("host=host1:42"));
  // The misleading "nothing refused this work" note must not also appear.
  assert(!lines.some((l) => l.includes("NOTE inversion_not_escalated ")));
  // The inversion itself is still alerted — the work is real.
  assert(lines.some((l) => l.includes("ALERT inversion")));
});

Deno.test("formatter - no hold note when nothing was held (Issue #898)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/scanned", issues: [issue(1, ["work-on"])] }),
    ],
  });

  assert(
    !formatIdleDecisionCensus(census).some((l) =>
      l.includes("NOTE inversion_repo_held")
    ),
  );
});

Deno.test("isRepoHeldSkipReason - only the hold qualifies (Issue #898)", () => {
  assertEquals(isRepoHeldSkipReason("repo_held_in_flight"), true);
  assertEquals(isRepoHeldSkipReason("cycle_deadline"), false);
  assertEquals(isRepoHeldSkipReason("host_disk_low"), false);
  assertEquals(isRepoHeldSkipReason("scanned"), false);
  assertEquals(isRepoHeldSkipReason(undefined), false);
});

// ---------------------------------------------------------------------------
// The census input the loop builds for each repo
// ---------------------------------------------------------------------------

Deno.test("resolveRepoScanState - a held repo is unscanned and named (Issue #898)", () => {
  assertEquals(
    resolveRepoScanState({
      repo: "org/held",
      claimScanCompleted: true,
      scanExcludedRepos: new Set(["org/held"]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_held_in_flight" },
  );
});

Deno.test("resolveRepoScanState - the hold outranks a completed pass (Issue #898)", () => {
  // The pass completed for the rest of the fleet; that says nothing about a
  // repository it was never shown.
  const state = resolveRepoScanState({
    repo: "org/held",
    claimScanCompleted: true,
    scanExcludedRepos: new Set(["org/other", "org/held"]),
    claimGateReason: () => "host_disk_low",
  });
  assertEquals(state.scannedThisCycle, false);
  assertEquals(state.skipReason, "repo_held_in_flight");
});

Deno.test("regression - the held repo the loop escalated no longer does (Issue #898)", () => {
  const issues = [870, 869, 847].map((n) => issue(n, ["work-on"]));
  const held = new Set(["stSoftwareAU/VibeCoder"]);

  // What the loop passed before the fix: one cycle-wide boolean, applied to
  // every repo including the one the pass was never shown.
  const before = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/VibeCoder",
        scannedThisCycle: true,
        issues,
      }),
    ],
  });
  assertEquals(
    before.escalationRepos,
    ["stSoftwareAU/VibeCoder"],
    "the fault: a repo the scan never saw counted as one it refused",
  );

  // What it passes now: the hold decides the repo's scan state.
  const after = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/VibeCoder",
        issues,
        ...resolveRepoScanState({
          repo: "stSoftwareAU/VibeCoder",
          claimScanCompleted: true,
          scanExcludedRepos: held,
          claimGateReason: () => "cycle_deadline",
        }),
      }),
    ],
  });
  assertEquals(after.escalationRepos, []);
  assertEquals(after.heldInversionRepos, ["stSoftwareAU/VibeCoder"]);
  // The work is still real, so the idle-task filer stays suppressed.
  assertEquals(after.inversionDetected, true);
});

Deno.test("resolveRepoScanState - an unheld repo keeps today's behaviour (Issue #898)", () => {
  assertEquals(
    resolveRepoScanState({
      repo: "org/free",
      claimScanCompleted: true,
      scanExcludedRepos: new Set(["org/held"]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: true },
  );
  assertEquals(
    resolveRepoScanState({
      repo: "org/free",
      claimScanCompleted: false,
      scanExcludedRepos: new Set(),
      claimGateReason: () => "host_disk_low",
    }),
    { scannedThisCycle: false, skipReason: "host_disk_low" },
  );
});
