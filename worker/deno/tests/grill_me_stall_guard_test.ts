/**
 * Tests for the grill-me stall guard and runaway ceiling (Issue #1933).
 *
 * A productive grilling — every round asking at least one question stem not
 * asked before — is never halted by a fixed round count. The stop rule is a
 * stall guard (the latest round repeats every stem it already asked) plus a
 * runaway ceiling, and when either trips the next round is a forced final one
 * that must post the Ready comment.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  decideGrillMeStop,
  forcedFinalTriggerLine,
  isRoundStalled,
  normaliseQuestionStem,
  parseQuestionStems,
} from "../lib/grill_me_stall_guard.ts";

function round(...stems: string[]): string {
  const questions = stems
    .map((stem, i) =>
      `${
        i + 1
      }. ${stem}\n   - [x] yes\n   - [ ] other — please describe in a reply`
    )
    .join("\n\n");
  return [
    "## Grill-Me Round 1",
    "",
    "**TL;DR:** something",
    "",
    "### Understanding",
    "",
    "Some prose that is not a question.",
    "",
    "### Questions",
    "",
    questions,
    "",
    "**⏳ Awaiting your reply.**",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// parseQuestionStems
// ---------------------------------------------------------------------------

Deno.test("parseQuestionStems - reads each numbered stem under the Questions heading", () => {
  const body = round("What is the stop rule?", "Which ceiling default?");
  assertEquals(parseQuestionStems(body), [
    "What is the stop rule?",
    "Which ceiling default?",
  ]);
});

Deno.test("parseQuestionStems - ignores numbered lines outside the Questions section", () => {
  const body = [
    "## Grill-Me Round 2",
    "",
    "### Understanding",
    "",
    "1. This is a numbered fact, not a question.",
    "",
    "### Questions",
    "",
    "1. Which format do you want?",
    "   - [x] CSV",
    "",
    "### Notes",
    "",
    "2. Another numbered line after the section ends.",
  ].join("\n");
  assertEquals(parseQuestionStems(body), ["Which format do you want?"]);
});

Deno.test("parseQuestionStems - returns nothing when the round has no Questions section", () => {
  assertEquals(parseQuestionStems("## Grill-Me Round 3\n\nJust prose."), []);
});

Deno.test("parseQuestionStems - handles CRLF line endings", () => {
  const body = "### Questions\r\n\r\n1. Which ceiling?\r\n   - [x] 20\r\n";
  assertEquals(parseQuestionStems(body), ["Which ceiling?"]);
});

// ---------------------------------------------------------------------------
// normaliseQuestionStem
// ---------------------------------------------------------------------------

Deno.test("normaliseQuestionStem - lower-cases, collapses whitespace and strips trailing punctuation", () => {
  assertEquals(
    normaliseQuestionStem("  What   is the   Stop Rule?  "),
    "what is the stop rule",
  );
});

Deno.test("normaliseQuestionStem - strips Markdown emphasis markers", () => {
  assertEquals(
    normaliseQuestionStem("**What** is the `stop rule`_?_"),
    "what is the stop rule",
  );
});

Deno.test("normaliseQuestionStem - two stems differing only by emphasis and case match exactly", () => {
  assertEquals(
    normaliseQuestionStem("Runaway ceiling default?"),
    normaliseQuestionStem("*Runaway  Ceiling* default!"),
  );
});

Deno.test("normaliseQuestionStem - a reworded stem does not match (no similarity threshold)", () => {
  const a = normaliseQuestionStem("What is the runaway ceiling default?");
  const b = normaliseQuestionStem(
    "What should the runaway ceiling default be?",
  );
  assertEquals(a === b, false);
});

// ---------------------------------------------------------------------------
// isRoundStalled
// ---------------------------------------------------------------------------

Deno.test("isRoundStalled - a round with one new stem is productive", () => {
  const bodies = [
    round("What is the stop rule?", "Which ceiling?"),
    round("What is the stop rule?", "How strict is the stem match?"),
  ];
  assertEquals(isRoundStalled(bodies), false);
});

Deno.test("isRoundStalled - a round repeating every earlier stem is stalled", () => {
  const bodies = [
    round("What is the stop rule?", "Which ceiling?"),
    round("How strict is the stem match?"),
    round("*Which  Ceiling?*", "What is the stop rule!"),
  ];
  assertEquals(isRoundStalled(bodies), true);
});

Deno.test("isRoundStalled - the first round of a grilling is never stalled", () => {
  assertEquals(isRoundStalled([round("What is the stop rule?")]), false);
});

Deno.test("isRoundStalled - a round with no parseable stems is never stalled", () => {
  const bodies = [
    round("What is the stop rule?"),
    "## Grill-Me Round 2\n\nNo questions section at all.",
  ];
  assertEquals(isRoundStalled(bodies), false);
});

Deno.test("isRoundStalled - only the latest round is tested", () => {
  // Round 2 repeated Round 1 but Round 3 asked something new: the grilling
  // is productive again, so the guard does not trip on the stale middle round.
  const bodies = [
    round("What is the stop rule?"),
    round("What is the stop rule?"),
    round("Which ceiling?"),
  ];
  assertEquals(isRoundStalled(bodies), false);
});

// ---------------------------------------------------------------------------
// decideGrillMeStop
// ---------------------------------------------------------------------------

Deno.test("decideGrillMeStop - five answered productive rounds do not stop the grilling (GRQ#4754)", () => {
  const bodies = [1, 2, 3, 4, 5].map((n) => round(`Question ${n}?`));
  assertEquals(
    decideGrillMeStop({
      roundBodies: bodies,
      latestRoundNumber: 5,
      maxRounds: 20,
    }),
    null,
  );
});

Deno.test("decideGrillMeStop - a stalled latest round forces a final round naming it", () => {
  const bodies = [
    round("What is the stop rule?"),
    round("What is the stop rule?"),
  ];
  assertEquals(
    decideGrillMeStop({
      roundBodies: bodies,
      latestRoundNumber: 2,
      maxRounds: 20,
    }),
    { kind: "stall", roundNumber: 2 },
  );
});

Deno.test("decideGrillMeStop - the ceiling round itself is the forced final round", () => {
  // 19 productive rounds posted: the next round is the 20th, so it is forced.
  const bodies = Array.from({ length: 19 }, (_, i) => round(`Question ${i}?`));
  assertEquals(
    decideGrillMeStop({
      roundBodies: bodies,
      latestRoundNumber: 19,
      maxRounds: 20,
    }),
    { kind: "ceiling", ceiling: 20 },
  );
  // At 18 rounds the next round is the 19th — still an ordinary round.
  assertEquals(
    decideGrillMeStop({
      roundBodies: bodies.slice(0, 18),
      latestRoundNumber: 18,
      maxRounds: 20,
    }),
    null,
  );
});

Deno.test("decideGrillMeStop - a grilling already past the ceiling still forces a final round", () => {
  const bodies = Array.from({ length: 25 }, (_, i) => round(`Question ${i}?`));
  assertEquals(
    decideGrillMeStop({
      roundBodies: bodies,
      latestRoundNumber: 25,
      maxRounds: 20,
    }),
    { kind: "ceiling", ceiling: 20 },
  );
});

Deno.test("decideGrillMeStop - the stall guard is reported ahead of the ceiling", () => {
  const bodies = Array.from(
    { length: 19 },
    (_, i) => round(`Question ${i % 2}?`),
  );
  assertEquals(
    decideGrillMeStop({
      roundBodies: bodies,
      latestRoundNumber: 19,
      maxRounds: 20,
    }),
    { kind: "stall", roundNumber: 19 },
  );
});

// ---------------------------------------------------------------------------
// forcedFinalTriggerLine
// ---------------------------------------------------------------------------

Deno.test("forcedFinalTriggerLine - names the stall round", () => {
  assertEquals(
    forcedFinalTriggerLine({ kind: "stall", roundNumber: 6 }),
    "Forced final round: stall guard tripped at Round 6",
  );
});

Deno.test("forcedFinalTriggerLine - names the ceiling", () => {
  assertEquals(
    forcedFinalTriggerLine({ kind: "ceiling", ceiling: 20 }),
    "Forced final round: round ceiling (20) reached",
  );
});
