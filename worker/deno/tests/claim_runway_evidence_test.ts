/**
 * Tests for the adaptive claim-runway floor (Issues #245/#425).
 *
 * The plain floor (#4304) knows nothing about the issue it is about to claim,
 * so a 933 s slice was handed to VibeCoder#222 — a 21-file change with a
 * timed-out attempt already behind it — and burned a whole Fable-tier run that
 * could never finish. These tests drive the pure decision function that
 * refuses such a claim, one evidence source at a time.
 *
 * Post-#397 the runway is the runway to the supervisor hard cap, and the
 * window it is clamped against is that cap's own window rather than the cycle
 * length — the cycle stopped bounding an execute at Issue #420.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideAdaptiveClaim,
  DEFAULT_LONG_JOB_LABELS,
  describeClaimEvidence,
  evidenceFromIssueSignals,
  issueClaimKey,
  LONG_JOB_BUDGET_SHARE,
} from "../lib/claim_runway_evidence.ts";

/** A four-hour hard cap with the default one-hour execute budget. */
const LONG_CAP = {
  fullExecuteBudgetSeconds: 3600,
  runwayWindowSeconds: 4 * 3600,
};

/** A short-cap host: the cap can never fit the configured budget. */
const SHORT_CAP_HOST = {
  fullExecuteBudgetSeconds: 3600,
  runwayWindowSeconds: 3600,
};

// ---------------------------------------------------------------------------
// No evidence — unchanged behaviour (acceptance: fresh small issues still
// claim late in the cycle)
// ---------------------------------------------------------------------------

Deno.test("adaptive floor #245 - a fresh issue with no history claims on a short runway", () => {
  const decision = decideAdaptiveClaim({
    evidence: {},
    remainingRunwaySeconds: 933,
    ...LONG_CAP,
  });
  assertEquals(decision.claim, true);
  assertEquals(decision.evidence, []);
  assertEquals(decision.requiredRunwaySeconds, 0);
});

Deno.test("adaptive floor #245 - an unknown execute budget cannot gate anything", () => {
  const decision = decideAdaptiveClaim({
    evidence: { preservedWip: true },
    remainingRunwaySeconds: 60,
    fullExecuteBudgetSeconds: 0,
    runwayWindowSeconds: 4 * 3600,
  });
  assertEquals(decision.claim, true);
  assertEquals(decision.requiredRunwaySeconds, 0);
});

// ---------------------------------------------------------------------------
// Each evidence source refuses a doomed slice
// ---------------------------------------------------------------------------

Deno.test("adaptive floor #245 - preserved WIP requires the full execute budget", () => {
  const decision = decideAdaptiveClaim({
    evidence: { preservedWip: true },
    remainingRunwaySeconds: 933,
    ...LONG_CAP,
  });
  assertEquals(decision.claim, false);
  assertEquals(decision.requiredRunwaySeconds, 2700);
  assert(decision.reason !== undefined);
  assertStringIncludes(decision.reason!, "preserved WIP");
  assertStringIncludes(decision.reason!, "933s");
  assertStringIncludes(decision.reason!, "next cycle");
});

Deno.test("adaptive floor #245 - a prior execute timeout requires the full execute budget", () => {
  const decision = decideAdaptiveClaim({
    evidence: { previousExecuteTimeout: true },
    remainingRunwaySeconds: 933,
    ...LONG_CAP,
  });
  assertEquals(decision.claim, false);
  assertStringIncludes(decision.reason!, "timed out in the execute phase");
});

Deno.test("adaptive floor #245 - a long-job size label requires the full execute budget", () => {
  const decision = decideAdaptiveClaim({
    evidence: { longJobLabels: ["size/L"] },
    remainingRunwaySeconds: 933,
    ...LONG_CAP,
  });
  assertEquals(decision.claim, false);
  assertStringIncludes(decision.reason!, "size/L");
});

Deno.test("adaptive floor #245 - evidenced issues still claim once the budget fits", () => {
  const decision = decideAdaptiveClaim({
    evidence: { preservedWip: true, previousExecuteTimeout: true },
    remainingRunwaySeconds: 3400,
    ...LONG_CAP,
  });
  assertEquals(decision.claim, true);
  assertEquals(decision.requiredRunwaySeconds, 2700);
  assertEquals(decision.reason, undefined);
  assertEquals(decision.evidence.length, 2);
});

Deno.test("adaptive floor #245 - the boundary claims, one second below it skips", () => {
  const at = decideAdaptiveClaim({
    evidence: { preservedWip: true },
    remainingRunwaySeconds: 2700,
    ...LONG_CAP,
  });
  const below = decideAdaptiveClaim({
    evidence: { preservedWip: true },
    remainingRunwaySeconds: 2699,
    ...LONG_CAP,
  });
  assertEquals(at.claim, true);
  assertEquals(below.claim, false);
});

// ---------------------------------------------------------------------------
// The short-cap host
// ---------------------------------------------------------------------------

Deno.test("adaptive floor #425 - a short-cap host requires the cap's own equivalent, not the configured budget", () => {
  // The configured 3600 s budget never fits a 3600 s hard-cap window, so
  // requiring it would refuse every claim this host could ever make. The
  // window's equivalent is required instead, and the reason says so.
  const skipped = decideAdaptiveClaim({
    evidence: { previousExecuteTimeout: true },
    remainingRunwaySeconds: 933,
    ...SHORT_CAP_HOST,
  });
  assertEquals(skipped.claim, false);
  assertEquals(skipped.requiredRunwaySeconds, 2700);
  assertStringIncludes(skipped.reason!, "can never offer");

  const claimed = decideAdaptiveClaim({
    evidence: { previousExecuteTimeout: true },
    remainingRunwaySeconds: 3360,
    ...SHORT_CAP_HOST,
  });
  assertEquals(claimed.claim, true);
});

Deno.test("adaptive floor #245 - a share of 1 would idle a short-cap host, so the share is bounded below 1", () => {
  assert(
    LONG_JOB_BUDGET_SHARE > 0 && LONG_JOB_BUDGET_SHARE < 1,
    `the share must leave a short-cap host claimable, got ${LONG_JOB_BUDGET_SHARE}`,
  );
});

// ---------------------------------------------------------------------------
// The VibeCoder#222 timeline (acceptance)
// ---------------------------------------------------------------------------

Deno.test("adaptive floor #245 - on the #222 timeline attempt 1 is skipped and attempts 2-3 are unaffected", () => {
  // Attempt 1: 933 s of runway, and the issue already carried the evidence of
  // a long job (21 files of WIP from the attempt before it, `size/L`).
  const attempt1 = decideAdaptiveClaim({
    evidence: { previousExecuteTimeout: true, longJobLabels: ["size/L"] },
    remainingRunwaySeconds: 933,
    ...SHORT_CAP_HOST,
  });
  assertEquals(attempt1.claim, false);

  // Attempt 2: 56 minutes — nearly the whole window, and it produced the WIP
  // attempt 3 resumed from.
  const attempt2 = decideAdaptiveClaim({
    evidence: { previousExecuteTimeout: true, longJobLabels: ["size/L"] },
    remainingRunwaySeconds: 56 * 60,
    ...SHORT_CAP_HOST,
  });
  assertEquals(attempt2.claim, true);

  // Attempt 3: 49 minutes, resuming the preserved WIP — the run that finished.
  const attempt3 = decideAdaptiveClaim({
    evidence: {
      preservedWip: true,
      previousExecuteTimeout: true,
      longJobLabels: ["size/L"],
    },
    remainingRunwaySeconds: 49 * 60,
    ...SHORT_CAP_HOST,
  });
  assertEquals(attempt3.claim, true);
});

// ---------------------------------------------------------------------------
// Evidence derived from the issue's own signals
// ---------------------------------------------------------------------------

Deno.test("adaptive floor #245 - a release comment naming preserved WIP is evidence", () => {
  const evidence = evidenceFromIssueSignals({
    commentBodies: [
      "⚠️ **Vibe Coder released this claim with no PR** — host `grq-23`.\n" +
      "**Detail:** WIP preserved: 21 files on issue-222-adaptive",
    ],
  });
  assertEquals(evidence.preservedWip, true);
  assertEquals(evidence.previousExecuteTimeout, false);
});

Deno.test("adaptive floor #245 - a collapsed attempt tally naming a timeout in execute is evidence", () => {
  const evidence = evidenceFromIssueSignals({
    commentBodies: [
      "**Attempts on this issue:** 2\n" +
      "- 21:49 `vibe-coder-1736` — no PR (`timeout`, phase `execute`)\n" +
      "- 01:52 `vibe-coder-83028` — raised #223",
    ],
  });
  assertEquals(evidence.previousExecuteTimeout, true);
});

Deno.test("adaptive floor #245 - a release outcome block naming a timeout in execute is evidence", () => {
  const evidence = evidenceFromIssueSignals({
    commentBodies: [
      "**Outcome:** no PR raised — `timeout`.\n" +
      "**Diagnosis:** died in phase `execute` after 58 min.",
    ],
  });
  assertEquals(evidence.previousExecuteTimeout, true);
});

Deno.test("adaptive floor #245 - a timeout in another phase is not execute evidence", () => {
  const evidence = evidenceFromIssueSignals({
    commentBodies: [
      "- 21:49 `vibe-coder-1736` — no PR (`timeout`, phase `setup`)",
    ],
  });
  assertEquals(evidence.previousExecuteTimeout, false);
});

Deno.test("adaptive floor #245 - a successful attempt is not evidence of a long job", () => {
  const evidence = evidenceFromIssueSignals({
    commentBodies: [
      "✅ **Vibe Coder released this claim** — host `grq-23`. Raised #223",
    ],
    labels: ["enhancement", "work-on"],
  });
  assertEquals(describeClaimEvidence(evidence).length, 0);
});

Deno.test("adaptive floor #245 - size labels are matched case-insensitively against the configured set", () => {
  const defaults = evidenceFromIssueSignals({ labels: ["Size/L", "bug"] });
  assertEquals(defaults.longJobLabels, ["Size/L"]);

  const configured = evidenceFromIssueSignals({
    labels: ["size/l", "needs-a-week"],
    longJobLabels: ["needs-a-week"],
  });
  // The configured set replaces the defaults, so `size/l` no longer counts.
  assertEquals(configured.longJobLabels, ["needs-a-week"]);

  assert(DEFAULT_LONG_JOB_LABELS.includes("epic"));
});

Deno.test("adaptive floor #245 - the claim key names the repository and the issue", () => {
  assertEquals(
    issueClaimKey("stSoftwareAU/VibeCoder", 222),
    "stSoftwareAU/VibeCoder#222",
  );
});
