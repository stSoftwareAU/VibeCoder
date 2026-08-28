/**
 * Provenance recognition for auto-filed worker diagnostics (Issue #505).
 *
 * The recogniser is the gate that decides whether an issue may be
 * scheduled without a human, so these tests pin what it accepts: a whole
 * marker comment from a known family, and nothing else.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSelfScheduleAnnouncement,
  buildUnschedulableDiagnosticEscalation,
  formatSelfScheduleMarker,
  isSelfDiagnosticRepo,
  recogniseSelfDiagnostic,
  SELF_DIAGNOSTIC_FAMILIES,
  SELF_DIAGNOSTIC_REPO,
  SELF_SCHEDULE_AUDIT_VERB,
} from "../lib/self_diagnostic_provenance.ts";
import {
  formatIdleInversionBody,
  IDLE_INVERSION_TARGET_REPO,
} from "../lib/idle_inversion_streak.ts";
import { formatRunFailureMarker } from "../lib/run_failure_issue.ts";

Deno.test("recogniseSelfDiagnostic - accepts a real idle-inversion body", () => {
  const body = formatIdleInversionBody({
    repo: "owner/subject",
    consecutiveCycles: 3,
    claimable: 26,
    detail: "census detail",
  });
  const family = recogniseSelfDiagnostic(body);
  assert(family !== null);
  assertEquals(family.id, "idle-inversion");
});

Deno.test("recogniseSelfDiagnostic - accepts a run-failure marker", () => {
  const family = recogniseSelfDiagnostic(
    `${formatRunFailureMarker("worker-crash")}\n\nAuto-filed.`,
  );
  assert(family !== null);
  assertEquals(family.id, "run-failure");
});

Deno.test("recogniseSelfDiagnostic - rejects prose naming the marker", () => {
  assertEquals(
    recogniseSelfDiagnostic(
      "The worker files VIBE_IDLE_INVERSION: owner/repo when it detects this.",
    ),
    null,
  );
});

Deno.test("recogniseSelfDiagnostic - rejects an empty or missing body", () => {
  assertEquals(recogniseSelfDiagnostic(""), null);
  assertEquals(recogniseSelfDiagnostic(undefined), null);
});

Deno.test("recogniseSelfDiagnostic - rejects an unknown marker family", () => {
  assertEquals(
    recogniseSelfDiagnostic("<!-- VIBE_SOMETHING_ELSE:owner/repo -->"),
    null,
  );
});

Deno.test("recogniseSelfDiagnostic - rejects a marker without its value", () => {
  assertEquals(recogniseSelfDiagnostic("<!-- VIBE_IDLE_INVERSION -->"), null);
});

Deno.test("isSelfDiagnosticRepo - only the worker's own repo, case-insensitively", () => {
  assertEquals(isSelfDiagnosticRepo(SELF_DIAGNOSTIC_REPO), true);
  assertEquals(isSelfDiagnosticRepo(SELF_DIAGNOSTIC_REPO.toUpperCase()), true);
  assertEquals(isSelfDiagnosticRepo("stSoftwareAU/NEAT-AI-Rebase"), false);
});

Deno.test("SELF_DIAGNOSTIC_REPO - tracks the filer's own target repo", () => {
  assertEquals(SELF_DIAGNOSTIC_REPO, IDLE_INVERSION_TARGET_REPO);
});

Deno.test("buildSelfScheduleAnnouncement - carries its dedup marker and the cap", () => {
  const family = SELF_DIAGNOSTIC_FAMILIES[0]!;
  const body = buildSelfScheduleAnnouncement({
    family,
    maxInFlight: 1,
    githubUser: "vibe-bot",
  });
  assertStringIncludes(body, formatSelfScheduleMarker(family.id));
  assertStringIncludes(body, "vibe-bot");
  assertStringIncludes(body, "**1**");
  assertStringIncludes(body, SELF_SCHEDULE_AUDIT_VERB);
  assertStringIncludes(body, "self_schedule_diagnostics_enabled");
});

Deno.test("buildUnschedulableDiagnosticEscalation - dedups per issue and names the next step", () => {
  const escalation = buildUnschedulableDiagnosticEscalation({
    issueNumber: 39,
    family: SELF_DIAGNOSTIC_FAMILIES[0]!,
    reason: "a merged fleet PR names it, which blocks it permanently",
  });
  assertEquals(escalation.dedupKey, "self-diagnostic-unschedulable-39");
  assertStringIncludes(escalation.reason, "merged fleet PR");
  assertStringIncludes(escalation.nextStep, "work-on");
});
