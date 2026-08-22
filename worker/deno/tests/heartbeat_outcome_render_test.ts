/**
 * Tests for rendering the run outcome in the claim-release comment (Issue
 * #4326, part of #4291).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeAttemptOutcome,
  formatDuration,
  OUTCOME_BLOCK_MAX_LENGTH,
  OUTCOME_DETAIL_MAX_LENGTH,
  parseHeartbeatMarker,
  renderHeartbeatBody,
  renderRunOutcomeClause,
} from "../lib/heartbeat_storage.ts";
import { isHeartbeatOnlyBody } from "../lib/heartbeat_sweep.ts";
import {
  getFailureCategoryDisplay,
  getFailureDiagnosisOneliner,
} from "../lib/failure_diagnosis.ts";
import { type RunOutcome, withRunOutcomeNotes } from "../lib/run_outcome.ts";

const NOW = 1_700_000_000; // 2023-11-14 22:13:20 UTC
const nowFn = () => NOW;
const MACHINE = "vibe-coder-27384-0f8e2a1b-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const HOST = "vibe-coder-27384";

const CASES: { name: string; outcome: RunOutcome | undefined }[] = [
  {
    name: "pr",
    outcome: {
      kind: "pr",
      prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/4277",
      prNumber: 4277,
    },
  },
  {
    name: "no_pr",
    outcome: {
      kind: "no_pr",
      category: "timeout",
      phase: "execute",
      elapsedSeconds: 58 * 60 + 12,
      message: "Claude timed out after 3492s of a 3600s budget",
    },
  },
  {
    name: "no_pr_expected",
    outcome: {
      kind: "no_pr_expected",
      phase: "handle_no_changes",
      summary: "no changes needed — question answered on the thread",
    },
  },
  { name: "absent", outcome: undefined },
  {
    // Issue #218 — the issue was resolved by another PR mid-run.
    name: "superseded",
    outcome: {
      kind: "superseded",
      phase: "execute",
      prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/215",
      prNumber: 215,
      prState: "MERGED",
      wipNote:
        "WIP preserved: committed and pushed to 'issue-185-forgeable' (Issue #47)",
    },
  },
];

function render(outcome: RunOutcome | undefined): string {
  return renderHeartbeatBody({
    machineId: MACHINE,
    host: HOST,
    epoch: 0,
    released: true,
    ...(outcome ? { outcome } : {}),
  }, nowFn);
}

Deno.test("outcome render - table: every shape keeps the marker line first, parses cleared, and is heartbeat-only for the sweep (Issue #4326)", () => {
  for (const c of CASES) {
    const body = render(c.outcome);
    assert(
      body.startsWith(
        `<!-- VIBE_CODER_HEARTBEAT:${MACHINE}:0 --> <!-- cleared: claim released by machine ${MACHINE} -->\n\n`,
      ),
      `${c.name}: marker line first: ${body}`,
    );
    const parsed = parseHeartbeatMarker(body);
    assertEquals(parsed?.cleared, true, `${c.name}: cleared`);
    assertEquals(parsed?.epoch, 0, `${c.name}: epoch 0`);
    assertEquals(
      isHeartbeatOnlyBody(body),
      true,
      `${c.name}: heartbeat-only for the sweep: ${body}`,
    );
    // Human prose added below is still detected as prose.
    assertEquals(
      isHeartbeatOnlyBody(`${body}\n\nPlease leave this open — reviewing.`),
      false,
      `${c.name}: prose is never swept`,
    );
  }
});

Deno.test("outcome render - absent outcome is byte-identical to today's release text (Issue #4326)", () => {
  assertEquals(
    render(undefined),
    `<!-- VIBE_CODER_HEARTBEAT:${MACHINE}:0 --> <!-- cleared: claim released by machine ${MACHINE} -->\n\n` +
      "✅ **Vibe Coder released this claim** — host `vibe-coder-27384`, finished 22:13 UTC.",
  );
});

Deno.test("outcome render - pr: ✅ line carries the PR number and a clickable URL (Issue #4326)", () => {
  const body = render(CASES[0]!.outcome);
  assertStringIncludes(
    body,
    "✅ **Vibe Coder released this claim** — host `vibe-coder-27384`, finished 22:13 UTC. Raised #4277 — https://github.com/stSoftwareAU/VibeCoder/pull/4277",
  );
  assert(!body.includes("⚠️"));
});

Deno.test("outcome render - no_pr: ⚠️ line, failure class from getFailureCategoryDisplay, dying phase, elapsed via formatDuration, one-liner from getFailureDiagnosisOneliner (Issue #4326)", () => {
  const outcome = CASES[1]!.outcome!;
  assert(outcome.kind === "no_pr");
  const body = render(outcome);
  assertStringIncludes(
    body,
    "⚠️ **Vibe Coder released this claim with no PR** — host `vibe-coder-27384`, finished 22:13 UTC.\n",
  );
  assertStringIncludes(
    body,
    `**Outcome:** no PR raised — \`${
      getFailureCategoryDisplay(outcome.category)
    }\`.`,
  );
  assertStringIncludes(
    body,
    `**Diagnosis:** died in phase \`execute\` after ${
      formatDuration(outcome.elapsedSeconds)
    }. ${getFailureDiagnosisOneliner(outcome.category)}`,
  );
  assertStringIncludes(body, "after 58 min.");
  assertStringIncludes(body, "**Detail:** Claude timed out after 3492s");
});

Deno.test("outcome render - no_pr_expected: ✅ line with the summary and an explicit no-PR-expected clause, never ⚠️ (Issue #4326)", () => {
  const body = render(CASES[2]!.outcome);
  assertStringIncludes(
    body,
    "✅ **Vibe Coder released this claim** — host `vibe-coder-27384`, finished 22:13 UTC. no changes needed — question answered on the thread (no PR expected for this phase.)",
  );
  assert(!body.includes("⚠️"));
  assert(!body.includes("**Outcome:**"));
});

Deno.test("outcome render - long failure messages are truncated with an ellipsis and HTML-comment delimiters are neutralised (Issue #4326)", () => {
  const long = "x".repeat(5000) + " --> <!-- VIBE_CODER_HEARTBEAT:evil:1 -->";
  const outcome: RunOutcome = {
    kind: "no_pr",
    category: "internal_error",
    phase: "quality_gate",
    elapsedSeconds: 7200,
    message: long,
  };
  const clause = renderRunOutcomeClause(outcome);
  assert(clause.length <= OUTCOME_BLOCK_MAX_LENGTH, `clause ${clause.length}`);
  assert(clause.includes("…"), "truncated with an ellipsis");
  assert(!clause.includes("-->") && !clause.includes("<!--"), clause);
  const body = render(outcome);
  assertEquals(parseHeartbeatMarker(body)?.cleared, true);
  assertEquals(parseHeartbeatMarker(body)?.machineId, MACHINE);
  assertEquals(isHeartbeatOnlyBody(body), true);
  assertStringIncludes(clause, "after 2 h.");
});

Deno.test("outcome render - the progress log still follows the outcome, as today (Issue #4326)", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE,
    host: HOST,
    epoch: 0,
    released: true,
    outcome: CASES[0]!.outcome,
    milestones: [{ epoch: NOW - 600, text: "phase execute started" }],
  }, nowFn);
  assert(body.indexOf("Raised #4277") < body.indexOf("**Progress**"));
  assertEquals(isHeartbeatOnlyBody(body), true);
});

Deno.test("outcome render - formatDuration phrases (Issue #4326)", () => {
  assertEquals(formatDuration(5), "under 1 min");
  assertEquals(formatDuration(59), "under 1 min");
  assertEquals(formatDuration(60), "1 min");
  assertEquals(formatDuration(3599), "59 min");
  assertEquals(formatDuration(3600), "1 h");
  assertEquals(formatDuration(90000), "1 d");
  assertEquals(formatDuration(-3), "under 1 min");
});

Deno.test("outcome render - superseded: ✅ line naming the merged PR and the preserved WIP, never ⚠️ (Issue #218)", () => {
  const outcome = CASES[4]!.outcome!;
  const body = render(outcome);
  assertStringIncludes(body, "✅ **Vibe Coder released this claim**");
  assertStringIncludes(
    body,
    "Superseded by merged #215 — https://github.com/stSoftwareAU/VibeCoder/pull/215 (this run raised no PR).",
  );
  // The preserved branch is named so the work this run did do is findable.
  assertStringIncludes(body, "issue-185-forgeable");
  // A superseded run is not a failure: no warning banner, no failure block.
  assert(!body.includes("⚠️"));
  assert(!body.includes("**Outcome:** no PR raised"));
});

Deno.test("outcome render - a superseded attempt is tallied by the PR that resolved it (Issue #218)", () => {
  assertEquals(
    describeAttemptOutcome(CASES[4]!.outcome),
    "superseded by #215",
  );
});

// ---------------------------------------------------------------------------
// Outcome notes (Issue #210)
// ---------------------------------------------------------------------------

Deno.test("outcome render - a bogus follow-up reference is stated on a run that raised a PR (Issue #210)", () => {
  const body = render(
    withRunOutcomeNotes(CASES[0]!.outcome!, [
      "follow-up reference #3952 not found in this repo",
    ]),
  );
  assertStringIncludes(body, "Raised #4277");
  assertStringIncludes(
    body,
    "**Note:** follow-up reference #3952 not found in this repo",
  );
});

Deno.test("outcome render - notes ride a failure block too, and are flattened and bounded (Issue #210)", () => {
  const body = render(
    withRunOutcomeNotes(CASES[1]!.outcome!, [
      `follow-up reference #1 not found\nin this repo ${"x".repeat(400)}`,
    ]),
  );
  assertStringIncludes(body, "**Outcome:** no PR raised");
  assertStringIncludes(
    body,
    "**Note:** follow-up reference #1 not found in this repo",
  );
  const note = body.split("**Note:** ")[1] ?? "";
  assert(
    note.length <= OUTCOME_DETAIL_MAX_LENGTH + 1,
    `the note must stay bounded, got ${note.length} chars`,
  );
});

Deno.test("outcome render - an outcome with no notes renders exactly as before (Issue #210)", () => {
  for (const c of CASES) {
    assertEquals(
      render(withRunOutcomeNotes(c.outcome ?? CASES[0]!.outcome!, ["  "])),
      render(c.outcome ?? CASES[0]!.outcome!),
      `${c.name}: a blank note must change nothing`,
    );
  }
});
