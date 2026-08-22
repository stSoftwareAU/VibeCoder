/**
 * Tests for `lib/already_resolved_outcome.ts` (Issue #241).
 *
 * The rule under test: a no-code-change run that verified the issue is already
 * fixed closes it **with cited evidence**; a bare claim with no commit or PR
 * hands off instead.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  type AlreadyResolvedDetection,
  detectAlreadyResolved,
  formatAlreadyResolvedEvidence,
} from "../lib/already_resolved_outcome.ts";

const SELF = { repo: "stSoftwareAU/NEAT-AI-Backpropagation", issueNumber: 96 };

/** Narrow to the resolved branch, failing the test when it is not. */
function resolved(detection: AlreadyResolvedDetection) {
  assertEquals(detection.status, "resolved", JSON.stringify(detection));
  return (detection as Extract<
    AlreadyResolvedDetection,
    { status: "resolved" }
  >).outcome;
}

// -------------------------------------------------------------------------
// Marker path — the primary signal
// -------------------------------------------------------------------------

Deno.test("already_resolved - marker with commit, PR and verification resolves", () => {
  const outcome = resolved(detectAlreadyResolved(
    [
      "This has already been fixed.",
      "",
      '<!-- vibe-already-resolved commit="4c6f932" pr="#97" ' +
      'verified="ran deno test tests/backprop_test.ts — passes on Develop" -->',
    ].join("\n"),
    SELF,
  ));

  assertEquals(outcome.source, "marker");
  assertEquals(outcome.evidence.commit, "4c6f932");
  assertEquals(outcome.evidence.pr, "#97");
  assertEquals(
    outcome.evidence.verification,
    "ran deno test tests/backprop_test.ts — passes on Develop",
  );
});

Deno.test("already_resolved - marker needs no keyword phrase in the prose", () => {
  const outcome = resolved(detectAlreadyResolved(
    'Nothing to do here.\n<!-- vibe-already-resolved pr="owner/other#12" ' +
      'verified="re-ran the failing test, it passes" -->',
    SELF,
  ));

  assertEquals(outcome.evidence.pr, "owner/other#12");
  assertEquals(outcome.evidence.commit, undefined);
});

Deno.test("already_resolved - marker accepts a PR URL", () => {
  const outcome = resolved(detectAlreadyResolved(
    '<!-- vibe-already-resolved pr="https://github.com/owner/other/pull/12" ' +
      'verified="read the merged diff and ran the suite" -->',
    SELF,
  ));

  assertEquals(outcome.evidence.pr, "owner/other#12");
});

Deno.test("already_resolved - marker without evidence is unverified", () => {
  const detection = detectAlreadyResolved(
    '<!-- vibe-already-resolved verified="I read the code" -->',
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - marker without a verification note is unverified", () => {
  const detection = detectAlreadyResolved(
    '<!-- vibe-already-resolved commit="4c6f932" -->',
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - marker citing the issue itself is not evidence", () => {
  const detection = detectAlreadyResolved(
    '<!-- vibe-already-resolved pr="#96" verified="ran the test" -->',
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - a non-hex commit attribute is not evidence", () => {
  const detection = detectAlreadyResolved(
    '<!-- vibe-already-resolved commit="the-fix-commit" verified="ran it" -->',
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - marker fields are flattened for a public comment", () => {
  const outcome = resolved(detectAlreadyResolved(
    '<!-- vibe-already-resolved commit="`4C6F932`" ' +
      'verified="ran the\ttest\nsuite   twice" -->',
    SELF,
  ));

  assertEquals(outcome.evidence.commit, "4c6f932");
  assertEquals(outcome.evidence.verification, "ran the test suite twice");
});

Deno.test("already_resolved - a field that breaks out of the comment is not usable evidence", () => {
  // The marker ends at the first `-->`, so a field carrying one truncates the
  // declaration rather than smuggling markup into the close comment.
  const detection = detectAlreadyResolved(
    '<!-- vibe-already-resolved commit="4c6f932" ' +
      'verified="ran it --> <script>alert(1)</script>" -->',
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

// -------------------------------------------------------------------------
// Keyword fallback — older prompts, evidence still required
// -------------------------------------------------------------------------

// The wording from NEAT-AI-Backpropagation#96 that the #519 list missed.
const NEAT_96_OUTPUT =
  "Issue #96 was resolved on `Develop` by commit `4c6f932` (PR #97). I " +
  "verified this by reading the code and running the test, not by inference.";

Deno.test("already_resolved - keyword claim with a cited commit and PR resolves", () => {
  const outcome = resolved(detectAlreadyResolved(NEAT_96_OUTPUT, SELF));

  assertEquals(outcome.source, "keyword");
  assertEquals(outcome.evidence.commit, "4c6f932");
  assertEquals(outcome.evidence.pr, "#97");
});

Deno.test("already_resolved - 'no code change was required' counts as a claim", () => {
  const outcome = resolved(detectAlreadyResolved(
    "No code change was required — commit 1a2b3c4d already covers it.",
    SELF,
  ));

  assertEquals(outcome.evidence.commit, "1a2b3c4d");
});

Deno.test("already_resolved - the #519 phrasings still resolve when evidence is cited", () => {
  const outcome = resolved(detectAlreadyResolved(
    "The implementation is already complete; see PR #401.",
    SELF,
  ));

  assertEquals(outcome.evidence.pr, "#401");
});

Deno.test("already_resolved - a bare already-fixed claim is unverified", () => {
  const detection = detectAlreadyResolved(
    "This has already been fixed and no code change was required.",
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - a claim citing only the issue itself is unverified", () => {
  const detection = detectAlreadyResolved(
    "This has already been fixed — see PR #96 in this repo.",
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - a SHA-shaped token off a commit line is not evidence", () => {
  const detection = detectAlreadyResolved(
    "This has already been fixed. The cache key is deadbeef1234.",
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - an all-digit token on a commit line is not a SHA", () => {
  const detection = detectAlreadyResolved(
    "This has already been fixed by the commit from 20260101 onwards.",
    SELF,
  );

  assertEquals(detection.status, "unverified");
});

Deno.test("already_resolved - output making no completion claim is 'none'", () => {
  const detection = detectAlreadyResolved(
    "I refactored the parser in commit 4c6f932 and raised PR #97.",
    SELF,
  );

  assertEquals(detection.status, "none");
});

Deno.test("already_resolved - empty output is 'none'", () => {
  assertEquals(detectAlreadyResolved("   ", SELF).status, "none");
  assertEquals(detectAlreadyResolved(undefined, SELF).status, "none");
});

// -------------------------------------------------------------------------
// Evidence rendering
// -------------------------------------------------------------------------

Deno.test("already_resolved - evidence renders as auditable markdown bullets", () => {
  const rendered = formatAlreadyResolvedEvidence({
    commit: "4c6f932",
    pr: "#97",
    verification: "ran the regression test",
  });

  assertEquals(
    rendered,
    [
      "- **Commit:** `4c6f932`",
      "- **PR:** #97",
      "- **Verified by:** ran the regression test",
    ].join("\n"),
  );
});

Deno.test("already_resolved - only the cited fields are rendered", () => {
  assertEquals(
    formatAlreadyResolvedEvidence({ pr: "owner/other#12" }),
    "- **PR:** owner/other#12",
  );
});
