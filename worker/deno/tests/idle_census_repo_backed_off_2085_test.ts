/**
 * A repository this host has backed off refused nothing (Issue #2085).
 *
 * # The incident
 *
 * `stSoftwareAU/GRQ-FX-validation` escalated on three consecutive cycles
 * with eight `low-priority` issues the census called claimable:
 *
 * ```
 * [idle-census] host=vibe-coder-76707:80 decision_point=filing
 *               repo=stSoftwareAU/GRQ-FX-validation monitored=true
 *               scanned=true skip_reason=scanned low_priority=8
 *               run_local_hold=10 inversion_signal=true
 * [idle-census] ALERT inversion repos=stSoftwareAU/GRQ-FX-validation
 * ```
 *
 * The filed issue carried no "What the claim scan did with them" section at
 * all — the scan had recorded no reason for a single one of the eight,
 * because it never reached them. Three of that repository's runs had died at
 * setup inside a minute, so the durable fast-failure tracker backed the
 * repository off (Issue #1950, diagnostic VibeCoder#2079, "backed off until
 * 2026-09-16T09:10:31.000Z", same host). `findNextIssue` unions
 * `backedOffRepos()` into `findOldestIssue`'s `excludeRepos`, which skips the
 * repository before any collector runs — but that union is computed inside
 * the scan and never reported, so `pool.scanExcludedRepos` carried only the
 * maintenance lane's leases and the census read `scanned=true`.
 *
 * # What these tests pin
 *
 * A backed-off repo is recorded as `repo_backed_off`, reported in its own
 * bucket with a note that names the back-off, and never escalated — Issue
 * #437's rule ("only a scan that actually refused the work may be
 * escalated") applied to the second way a repository goes unscanned. The
 * inversion signal itself is unchanged, so the idle-task filer stays
 * suppressed while real work waits (Issue #2813).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
  formatIdleDecisionCensus,
  isRepoBackedOffSkipReason,
  type RepoCensusInput,
  resolveRepoScanState,
} from "../lib/idle_decision_census.ts";

const SUBJECT = "stSoftwareAU/GRQ-FX-validation";

function issue(number: number, labels: string[]): CensusIssue {
  return { number, labels, assignees: [], milestone: "Scan 20260910" };
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

/** The reported incident: eight claimable issues, backed off, escalated. */
function backedOffSubject(): RepoCensusInput {
  return repoInput({
    repo: SUBJECT,
    scannedThisCycle: false,
    skipReason: "repo_backed_off",
    issues: [149, 147, 145, 144, 143, 142, 141, 140].map((n) =>
      issue(n, ["low-priority"])
    ),
  });
}

Deno.test("census - a backed-off repo's inversion is never escalated (Issue #2085)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [backedOffSubject()],
  });

  const entry = census.perRepo[0]!;
  assertEquals(
    entry.unblocked.lowPriority,
    8,
    "the backlog is real and still counted",
  );
  assertEquals(entry.inversionSignal, true);
  // The work is real, so the idle-task filer stays suppressed (Issue #2813).
  assertEquals(census.inversionDetected, true);
  assertEquals(census.inversionRepos, [SUBJECT]);
  // But the scan never looked at it, so it refused nothing (Issue #437).
  assertEquals(census.escalationRepos, []);
  assertEquals(census.backedOffInversionRepos, [SUBJECT]);
});

Deno.test("census - a backed-off repo is not reported as a plain deferral (Issue #2085)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [backedOffSubject()],
  });

  // `deferredInversionRepos` carries the "nothing refused this work" note,
  // and `heldInversionRepos` names a maintenance-lane lease that does not
  // exist here. Issue #479's lesson: name the gate that actually applies.
  assertEquals(census.deferredInversionRepos, []);
  assertEquals(census.heldInversionRepos, []);
  assertEquals(census.gatedInversionRepos, []);
});

Deno.test("census - back-off is decided per repo, beside held and scanned repos (Issue #2085)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/scanned", issues: [issue(1, ["work-on"])] }),
      repoInput({
        repo: "org/backed-off",
        scannedThisCycle: false,
        skipReason: "repo_backed_off",
        issues: [issue(2, ["work-on"])],
      }),
      repoInput({
        repo: "org/held",
        scannedThisCycle: false,
        skipReason: "repo_held_in_flight",
        issues: [issue(3, ["work-on"])],
      }),
      repoInput({
        repo: "org/deadline",
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(4, ["top-priority"])],
      }),
    ],
  });

  assertEquals(census.escalationRepos, ["org/scanned"]);
  assertEquals(census.backedOffInversionRepos, ["org/backed-off"]);
  assertEquals(census.heldInversionRepos, ["org/held"]);
  assertEquals(census.deferredInversionRepos, ["org/deadline"]);
});

Deno.test("census - a backed-off repo with nothing claimable appears in no bucket (Issue #2085)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/backed-off",
        scannedThisCycle: false,
        skipReason: "repo_backed_off",
        issues: [issue(1, ["idle-task"])],
      }),
    ],
  });

  assertEquals(census.inversionDetected, false);
  assertEquals(census.backedOffInversionRepos, []);
  assertEquals(census.escalationRepos, []);
});

Deno.test("formatter - names the back-off instead of the deferral note (Issue #2085)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [backedOffSubject()],
  });

  const lines = formatIdleDecisionCensus(census, "vibe-coder-76707:80");
  const repoLine = lines.find((l) => l.includes(`repo=${SUBJECT}`))!;
  assert(repoLine.includes("scanned=false"));
  assert(repoLine.includes("skip_reason=repo_backed_off"));

  const note = lines.find((l) => l.includes("NOTE inversion_repo_backed_off"))!;
  assert(note.includes(`repos=${SUBJECT}`));
  assert(note.includes("host=vibe-coder-76707:80"));
  // Neither misleading note may also appear.
  assert(!lines.some((l) => l.includes("NOTE inversion_not_escalated ")));
  assert(!lines.some((l) => l.includes("NOTE inversion_repo_held")));
  // The inversion itself is still alerted — the work is real.
  assert(lines.some((l) => l.includes("ALERT inversion")));
});

Deno.test("formatter - no back-off note when nothing was backed off (Issue #2085)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/scanned", issues: [issue(1, ["work-on"])] }),
    ],
  });

  assert(
    !formatIdleDecisionCensus(census).some((l) =>
      l.includes("NOTE inversion_repo_backed_off")
    ),
  );
});

Deno.test("isRepoBackedOffSkipReason - only the back-off qualifies (Issue #2085)", () => {
  assertEquals(isRepoBackedOffSkipReason("repo_backed_off"), true);
  assertEquals(isRepoBackedOffSkipReason("repo_held_in_flight"), false);
  assertEquals(isRepoBackedOffSkipReason("cycle_deadline"), false);
  assertEquals(isRepoBackedOffSkipReason("host_disk_low"), false);
  assertEquals(isRepoBackedOffSkipReason("scanned"), false);
  assertEquals(isRepoBackedOffSkipReason(undefined), false);
});

// ---------------------------------------------------------------------------
// The census input the loop builds for each repo
// ---------------------------------------------------------------------------

Deno.test("resolveRepoScanState - a backed-off repo is unscanned and named (Issue #2085)", () => {
  assertEquals(
    resolveRepoScanState({
      repo: SUBJECT,
      claimScanCompleted: true,
      scanExcludedRepos: new Set(),
      scanBackedOffRepos: new Set([SUBJECT]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_backed_off" },
  );
});

Deno.test("resolveRepoScanState - the back-off outranks a lease (Issue #2085)", () => {
  // Both skip the repository, but the lease clears in minutes while the
  // back-off is the durable condition that sustained the streak — and the
  // one an operator must act on.
  assertEquals(
    resolveRepoScanState({
      repo: SUBJECT,
      claimScanCompleted: true,
      scanExcludedRepos: new Set([SUBJECT]),
      scanBackedOffRepos: new Set([SUBJECT]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_backed_off" },
  );
});

Deno.test("resolveRepoScanState - an omitted back-off set keeps today's behaviour (Issue #2085)", () => {
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
      repo: "org/held",
      claimScanCompleted: true,
      scanExcludedRepos: new Set(["org/held"]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_held_in_flight" },
  );
});

Deno.test("regression - the backed-off repo the loop escalated no longer does (Issue #2085)", () => {
  const issues = [149, 147, 145].map((n) => issue(n, ["low-priority"]));
  const backedOff = new Set([SUBJECT]);

  // What the loop passed before the fix: the scan's own exclusion set never
  // reached the census, so a repository it skipped wholesale read as one it
  // had evaluated and refused.
  const before = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: SUBJECT,
        ...resolveRepoScanState({
          repo: SUBJECT,
          claimScanCompleted: true,
          scanExcludedRepos: new Set(),
          claimGateReason: () => "cycle_deadline",
        }),
        issues,
      }),
    ],
  });
  assertEquals(
    before.escalationRepos,
    [SUBJECT],
    "the fault: a repo the scan never saw counted as one it refused",
  );

  // What it passes now: the back-off decides the repo's scan state.
  const after = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: SUBJECT,
        issues,
        ...resolveRepoScanState({
          repo: SUBJECT,
          claimScanCompleted: true,
          scanExcludedRepos: new Set(),
          scanBackedOffRepos: backedOff,
          claimGateReason: () => "cycle_deadline",
        }),
      }),
    ],
  });
  assertEquals(after.escalationRepos, []);
  assertEquals(after.backedOffInversionRepos, [SUBJECT]);
  // The work is still real, so the idle-task filer stays suppressed.
  assertEquals(after.inversionDetected, true);
});
