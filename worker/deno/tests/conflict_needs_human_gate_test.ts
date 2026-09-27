/**
 * Tests for conflict_needs_human_gate.ts (Issue #2728).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { buildCiFixAttemptMarker } from "../lib/ci_fix_attempt_markers.ts";
import { isCiFixEscalationOnly } from "../lib/conflict_needs_human_gate.ts";
import { buildDedupMarker } from "../lib/needs_human_escalation.ts";

const CI_FIX_MARKER = buildCiFixAttemptMarker({
  signature: "abcdef0123456789",
  checkName: "quality",
  head: "b".repeat(40),
  attempt: 3,
  outcome: "pushed",
});

Deno.test("isCiFixEscalationOnly - a CI-fix attempt marker lets the PR through", () => {
  assertEquals(
    isCiFixEscalationOnly([
      { body: "chatter" },
      { body: `${CI_FIX_MARKER}\nCI fix attempt 3` },
    ]),
    true,
  );
});

Deno.test("isCiFixEscalationOnly - no CI-fix marker keeps the skip", () => {
  assertEquals(
    isCiFixEscalationOnly([{ body: "a human asked for help" }]),
    false,
  );
});

Deno.test("isCiFixEscalationOnly - the conflict lane's own escalation keeps the skip", () => {
  for (const key of ["merge-conflict-48", "merge-conflict-disrupted-48"]) {
    assertEquals(
      isCiFixEscalationOnly([
        { body: CI_FIX_MARKER },
        { body: `${buildDedupMarker(key)}\nescalated` },
      ]),
      false,
      key,
    );
  }
});

Deno.test("isCiFixEscalationOnly - another lane's escalation does not block", () => {
  assertEquals(
    isCiFixEscalationOnly([
      { body: `${buildDedupMarker("ci-fix-exhausted-48")}\nescalated` },
      { body: CI_FIX_MARKER },
    ]),
    true,
  );
});

Deno.test("isCiFixEscalationOnly - empty, malformed and forged entries count for nothing", () => {
  assertEquals(isCiFixEscalationOnly([]), false);
  assertEquals(isCiFixEscalationOnly([null, 42, { body: 7 }, "text"]), false);
  // A marker the strict parser rejects (non-hex signature) is not an attempt.
  assertEquals(
    isCiFixEscalationOnly([{
      body:
        '<!-- vibe-ci-fix-attempt signature="zz" check="q" head="x" attempt="1" outcome="pushed" -->',
    }]),
    false,
  );
});
