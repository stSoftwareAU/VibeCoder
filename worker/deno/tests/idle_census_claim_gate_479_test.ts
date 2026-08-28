/**
 * The census must name the gate that actually refused the work (Issue #479).
 *
 * # The incident
 *
 * While host GRQ-23 sat below its disk floor, every repo in its census read:
 *
 * ```
 * [idle-census] repo=stSoftwareAU/GRQ monitored=true scanned=false
 *               skip_reason=cycle_deadline work_on=9 inversion_signal=true
 * [idle-census] NOTE inversion_not_escalated repos=... — the claim scan did
 *               not complete an eligibility pass this cycle, so nothing
 *               refused this work
 * ```
 *
 * Both statements were false. The cycle deadline was not why the scan stopped
 * — the host-disk gate was, and it logged so one line earlier:
 *
 * ```
 * ERROR: [HOST_DISK_LOW] ... below the floor — claiming no new issues this
 *        cycle; maintenance continues (Issue #226).
 * ```
 *
 * And something very much *did* refuse the work. Because the skip was
 * recorded as `cycle_deadline`, #437's carve-out ("a cycle that ended on the
 * deadline is not counted, because nothing refused the work") correctly
 * declined to escalate — on a false premise. So the genuine cause was never
 * named, and an operator reading the census went looking at cycle duration
 * instead of at disk.
 *
 * # What these tests pin
 *
 * A claim gate is recorded as itself, and reported in its own bucket with a
 * note that names it. It is deliberately **not** routed into the per-repo
 * issue-filing escalation: the gate is one host-level fault, and fanning it
 * out into an "idle inversion" issue per repo would file N issues for one
 * problem that the host's own fleet-board report (Issue #477) already names
 * once, correctly, at the level it actually occurs.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
  formatIdleDecisionCensus,
  type RepoCensusInput,
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
    openPRs: partial.openPRs,
    mergedPRs: partial.mergedPRs,
  };
}

/** A repo with real claimable work that the scan never reached. */
function gatedRepo(repo: string, skipReason: RepoCensusInput["skipReason"]) {
  return repoInput({
    repo,
    scannedThisCycle: false,
    skipReason,
    issues: [issue(1, ["work-on"]), issue(2, ["low-priority"])],
  });
}

Deno.test("census - a host-disk gate is carried through as its own skip reason (Issue #479)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [gatedRepo("org/a", "host_disk_low")],
  });

  assertEquals(
    census.perRepo[0]!.skipReason,
    "host_disk_low",
    "recording the disk gate as `cycle_deadline` sent operators to look at " +
      "cycle duration for three days (Issue #479)",
  );
});

Deno.test("census - a claim-gated repo is not reported as nothing-refused (Issue #479)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [gatedRepo("org/a", "host_disk_low")],
  });

  assert(census.inversionDetected, "the repo has unblocked work-on issues");
  assertEquals(
    census.deferredInversionRepos,
    [],
    "`deferredInversionRepos` prints 'nothing refused this work' — the disk " +
      "gate refused it, so the repo must not land in that bucket",
  );
  assertEquals(
    census.gatedInversionRepos,
    ["org/a"],
    "a claim gate gets its own bucket so the note can name it",
  );
});

Deno.test("census - a genuine cycle deadline still reports as deferred (Issue #479)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [gatedRepo("org/a", "cycle_deadline")],
  });

  assertEquals(
    census.deferredInversionRepos,
    ["org/a"],
    "#437's carve-out is correct when the deadline really is the reason",
  );
  assertEquals(census.gatedInversionRepos, []);
});

Deno.test("census - a work-volume fault is a claim gate too (Issue #479)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [gatedRepo("org/a", "work_volume_fault")],
  });

  assertEquals(census.gatedInversionRepos, ["org/a"]);
  assertEquals(census.deferredInversionRepos, []);
});

Deno.test("census - a claim gate does not fan out into per-repo escalations (Issue #479)", () => {
  // The gate is one host-level fault. Filing an "idle inversion" issue per
  // repo would raise N issues for one problem the host's own fleet-board
  // report (Issue #477) already names once, at the level it occurs.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [
      gatedRepo("org/a", "host_disk_low"),
      gatedRepo("org/b", "host_disk_low"),
      gatedRepo("org/c", "host_disk_low"),
    ],
  });

  assertEquals(
    census.escalationRepos,
    [],
    "three repos on one disk-gated host must not become three issues",
  );
});

Deno.test("census formatter - the note names the gate rather than denying a refusal (Issue #479)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [gatedRepo("org/a", "host_disk_low")],
  });
  const text = formatIdleDecisionCensus(census, "host-1").join("\n");

  assert(
    text.includes("host_disk_low"),
    `the operator must see the gate in the census itself; got: ${text}`,
  );
  assert(
    !text.includes("so nothing refused this work"),
    `the disk gate refused this work; claiming otherwise is what stopped ` +
      `the condition being filed for three days; got: ${text}`,
  );
});

Deno.test("census formatter - an ordinary deadline keeps its historical note (Issue #479)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "bot",
    repos: [gatedRepo("org/a", "cycle_deadline")],
  });
  const text = formatIdleDecisionCensus(census, "host-1").join("\n");

  assert(
    text.includes("so nothing refused this work"),
    `#437's wording is correct for a real deadline and must not change; ` +
      `got: ${text}`,
  );
});
