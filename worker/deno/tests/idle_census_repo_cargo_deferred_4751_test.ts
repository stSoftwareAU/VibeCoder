/**
 * A repository the host cannot build yet was not refused by the scan (Issue #4751).
 *
 * # The incident
 *
 * The claim scan drops a Rust repository when the host has the disk floor but
 * not the cargo build headroom. `findNextIssue` unions
 * `cargoClaimDeferredRepos()` (Issue #4540) into `findOldestIssue`'s
 * `excludeRepos`, so no collector runs for it and it records no per-issue
 * skip reason at all. The census therefore reported claimable work it could
 * not have seen as an inversion, and the escalation carried no "what the
 * claim scan did with them" section. Issue #2085 fixed the identical gap for
 * the fast-failure back-off (`repo_backed_off`); this mirrors it for
 * `repo_cargo_deferred`.
 *
 * # What these tests pin
 *
 * A cargo-deferred repo is recorded as `repo_cargo_deferred`, reported in its
 * own bucket with a note that names the disk and cargo headroom, and never
 * escalated. The inversion signal itself is unchanged, so the idle-task filer
 * stays suppressed while real work waits (Issue #2813).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
  formatIdleDecisionCensus,
  isRepoCargoDeferredSkipReason,
  type RepoCensusInput,
  resolveRepoScanState,
} from "../lib/idle_decision_census.ts";

const SUBJECT = "stSoftwareAU/GRQ-AutoTrader";
const SIBLING = "stSoftwareAU/GRQ";

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

/** A cargo-deferred repo carrying claimable work the scan never looked at. */
function cargoDeferredSubject(): RepoCensusInput {
  return repoInput({
    repo: SUBJECT,
    scannedThisCycle: false,
    skipReason: "repo_cargo_deferred",
    issues: [201, 202, 203].map((n) => issue(n, ["work-on"])),
  });
}

// ---------------------------------------------------------------------------
// The scan state the loop builds for each repo
// ---------------------------------------------------------------------------

Deno.test("resolveRepoScanState - a cargo-deferred repo is unscanned and named (Issue #4751)", () => {
  assertEquals(
    resolveRepoScanState({
      repo: SUBJECT,
      claimScanCompleted: true,
      scanExcludedRepos: new Set(),
      scanCargoDeferredRepos: new Set([SUBJECT]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_cargo_deferred" },
  );
});

Deno.test("resolveRepoScanState - the back-off outranks the cargo deferral (Issue #4751)", () => {
  // A back-off is the durable fault an operator must act on, so it is named
  // ahead of the cargo deferral, mirroring how it is named ahead of a lease.
  assertEquals(
    resolveRepoScanState({
      repo: SUBJECT,
      claimScanCompleted: true,
      scanExcludedRepos: new Set(),
      scanBackedOffRepos: new Set([SUBJECT]),
      scanCargoDeferredRepos: new Set([SUBJECT]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_backed_off" },
  );
});

Deno.test("resolveRepoScanState - the cargo deferral outranks a lease (Issue #4751)", () => {
  // The lease clears in minutes; the cargo deferral clears when disk is freed.
  // Named ahead of the lease, as a back-off is.
  assertEquals(
    resolveRepoScanState({
      repo: SUBJECT,
      claimScanCompleted: true,
      scanExcludedRepos: new Set([SUBJECT]),
      scanCargoDeferredRepos: new Set([SUBJECT]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: false, skipReason: "repo_cargo_deferred" },
  );
});

Deno.test("resolveRepoScanState - a repo outside the cargo set is scanned (Issue #4751)", () => {
  assertEquals(
    resolveRepoScanState({
      repo: SIBLING,
      claimScanCompleted: true,
      scanExcludedRepos: new Set(),
      scanCargoDeferredRepos: new Set([SUBJECT]),
      claimGateReason: () => "cycle_deadline",
    }),
    { scannedThisCycle: true },
  );
});

// ---------------------------------------------------------------------------
// The census builder
// ---------------------------------------------------------------------------

Deno.test("census - a cargo-deferred repo's inversion is never escalated (Issue #4751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [cargoDeferredSubject()],
  });

  const entry = census.perRepo[0]!;
  assertEquals(
    entry.unblocked.workOn,
    3,
    "the backlog is real and still counted",
  );
  assertEquals(entry.inversionSignal, true);
  // The work is real, so the idle-task filer stays suppressed (Issue #2813).
  assertEquals(census.inversionDetected, true);
  assertEquals(census.inversionRepos, [SUBJECT]);
  // But the scan never looked at it, so it refused nothing (Issue #437).
  assertEquals(census.escalationRepos, []);
  assertEquals(census.cargoDeferredInversionRepos, [SUBJECT]);
});

Deno.test("census - a cargo-deferred repo is in no other bucket (Issue #4751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [cargoDeferredSubject()],
  });

  // `deferredInversionRepos` carries the "the cycle stopped early" note, which
  // is not what happened; `heldInversionRepos` and `backedOffInversionRepos`
  // name a lease and a back-off that do not exist here.
  assertEquals(census.deferredInversionRepos, []);
  assertEquals(census.heldInversionRepos, []);
  assertEquals(census.backedOffInversionRepos, []);
  assertEquals(census.gatedInversionRepos, []);
});

Deno.test("census - a scanned sibling with the same backlog is still escalated (Issue #4751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      cargoDeferredSubject(),
      repoInput({
        repo: SIBLING,
        issues: [301, 302, 303].map((n) => issue(n, ["work-on"])),
      }),
    ],
  });

  // The scan evaluated the sibling and refused it, so it is still escalated.
  assertEquals(census.escalationRepos, [SIBLING]);
  // The cargo bucket names only the repo the host cannot build.
  assertEquals(census.cargoDeferredInversionRepos, [SUBJECT]);
  assert(!census.cargoDeferredInversionRepos.includes(SIBLING));
  assertEquals(census.inversionRepos, [SUBJECT, SIBLING]);
});

Deno.test("census - a cargo-deferred repo with nothing claimable appears in no bucket (Issue #4751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: SUBJECT,
        scannedThisCycle: false,
        skipReason: "repo_cargo_deferred",
        issues: [issue(1, ["idle-task"])],
      }),
    ],
  });

  assertEquals(census.inversionDetected, false);
  assertEquals(census.cargoDeferredInversionRepos, []);
  assertEquals(census.escalationRepos, []);
});

// ---------------------------------------------------------------------------
// The formatter
// ---------------------------------------------------------------------------

Deno.test("formatter - names the cargo deferral instead of the deferral note (Issue #4751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [cargoDeferredSubject()],
  });

  const lines = formatIdleDecisionCensus(census, "vibe-coder-76707:80");
  const repoLine = lines.find((l) => l.includes(`repo=${SUBJECT}`))!;
  assert(repoLine.includes("scanned=false"));
  assert(repoLine.includes("skip_reason=repo_cargo_deferred"), repoLine);

  const note = lines.find((l) =>
    l.includes("NOTE inversion_repo_cargo_deferred")
  )!;
  assert(note.includes(`repos=${SUBJECT}`));
  assert(note.includes("host=vibe-coder-76707:80"));
  assert(note.includes("disk floor"));
  assert(note.includes("cargo build headroom"));
  // Neither misleading note may also appear.
  assert(!lines.some((l) => l.includes("NOTE inversion_not_escalated ")));
  assert(!lines.some((l) => l.includes("NOTE inversion_repo_held")));
  assert(!lines.some((l) => l.includes("NOTE inversion_repo_backed_off")));
  // The inversion itself is still alerted — the work is real.
  assert(lines.some((l) => l.includes("ALERT inversion")));
});

Deno.test("formatter - no cargo note on a healthy census (Issue #4751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: SIBLING, issues: [issue(1, ["work-on"])] }),
    ],
  });

  const lines = formatIdleDecisionCensus(census);
  assertEquals(census.cargoDeferredInversionRepos, []);
  assert(
    !lines.some((l) => l.includes("NOTE inversion_repo_cargo_deferred")),
  );
  assert(lines.some((l) => l.includes("ALERT inversion")));
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

Deno.test("isRepoCargoDeferredSkipReason - only the cargo deferral qualifies (Issue #4751)", () => {
  assertEquals(isRepoCargoDeferredSkipReason("repo_cargo_deferred"), true);
  assertEquals(isRepoCargoDeferredSkipReason("repo_backed_off"), false);
  assertEquals(isRepoCargoDeferredSkipReason("repo_held_in_flight"), false);
  assertEquals(isRepoCargoDeferredSkipReason("cycle_deadline"), false);
  assertEquals(isRepoCargoDeferredSkipReason("host_disk_low"), false);
  assertEquals(isRepoCargoDeferredSkipReason("scanned"), false);
  assertEquals(isRepoCargoDeferredSkipReason(undefined), false);
});
