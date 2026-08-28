/**
 * Tier 2b — self-scheduled worker diagnostics (Issue #505).
 *
 * The tier sits below both human-scheduled tiers and above the backlog, so
 * these tests pin it from both sides: a human's intent always wins, and a
 * diagnostic always beats `low-priority` and `idle-task`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  type IssueCandidate,
  selectHighestPriority,
  type SelectionResult,
} from "../lib/issue_priority.ts";
import { SELF_DIAGNOSTIC_LABEL_INDEX } from "../lib/collect_self_diagnostic_candidates.ts";

function candidate(
  overrides: Partial<IssueCandidate> & Pick<IssueCandidate, "source">,
): IssueCandidate {
  return {
    repo: "stSoftwareAU/VibeCoder",
    number: 1,
    url: "",
    title: "",
    milestone: "",
    createdAt: "2026-08-01T00:00:00Z",
    labelIndex: 99,
    ...overrides,
  };
}

const diagnostic = candidate({
  source: "self-diagnostic",
  number: 39,
  labelIndex: SELF_DIAGNOSTIC_LABEL_INDEX,
  // Deliberately the youngest candidate: the tier, not the age, decides.
  createdAt: "2026-08-28T00:00:00Z",
});

function result(overrides: Partial<SelectionResult> = {}): SelectionResult {
  return {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    selfDiagnosticCandidates: [diagnostic],
    lowPriorityCandidates: [],
    idleTaskCandidates: [],
    blockedEntries: [],
    ...overrides,
  };
}

Deno.test("tier 2b - a diagnostic is selected when no human-scheduled work exists", () => {
  assertEquals(selectHighestPriority(result())?.number, 39);
});

Deno.test("tier 2b - a work-on candidate outranks a diagnostic", () => {
  const workOn = candidate({ source: "work-on", number: 7 });
  assertEquals(
    selectHighestPriority(result({ workOnCandidates: [workOn] }))?.number,
    7,
  );
});

Deno.test("tier 2b - a configured-label candidate outranks a diagnostic", () => {
  const label = candidate({ source: "configured-label", number: 3 });
  assertEquals(
    selectHighestPriority(result({ labelCandidates: [label] }))?.number,
    3,
  );
});

Deno.test("tier 2b - a diagnostic outranks low-priority and idle-task", () => {
  const low = candidate({
    source: "low-priority",
    number: 5,
    labelIndex: 199,
    createdAt: "2020-01-01T00:00:00Z",
  });
  const idle = candidate({ source: "idle-task", number: 6, labelIndex: 299 });
  assertEquals(
    selectHighestPriority(
      result({ lowPriorityCandidates: [low], idleTaskCandidates: [idle] }),
    )?.number,
    39,
  );
});

Deno.test("tier 2b - a suppressed work-on tier falls through to the diagnostic", () => {
  const workOn = candidate({
    source: "work-on",
    number: 7,
    milestone: "m1",
  });
  const selected = selectHighestPriority(result({
    workOnCandidates: [workOn],
    blockedEntries: [{ repo: "stSoftwareAU/VibeCoder", milestone: "m1" }],
  }));
  assertEquals(selected?.number, 39);
});

Deno.test("tier 2b - absent candidates leave selection exactly as it was", () => {
  const low = candidate({ source: "low-priority", number: 5, labelIndex: 199 });
  const selected = selectHighestPriority({
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    lowPriorityCandidates: [low],
    idleTaskCandidates: [],
    blockedEntries: [],
  });
  assertEquals(selected?.number, 5);
});
