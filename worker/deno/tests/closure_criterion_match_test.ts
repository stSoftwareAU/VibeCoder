/**
 * Tests for closure_criterion_match.ts — matching PR-summary closure entries
 * to the criteria they assess by content, not list position (Issue #3128).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { parseClosureEntries } from "../lib/acceptance_criteria_gate.ts";
import {
  matchClosureEntries,
  matchClosureStatuses,
} from "../lib/closure_criterion_match.ts";

const CRITERIA = [
  "The router sends planning to opus.",
  "The docs table lists opus for planning.",
  "The release floor is 1.9.0.",
];

function entriesFrom(body: string) {
  return parseClosureEntries(
    `## Acceptance Criteria\n\n${body}\n`,
  );
}

Deno.test("matchClosureStatuses - entries quoted in a different order from the criteria still match by content", () => {
  const entries = entriesFrom(
    [
      "- **missing** — the release floor is 1.9.0 — reviewer: missing — reason: ran out of turns",
      "- **met** — the router sends planning to opus — evidence: `x` — reviewer: met",
      "- **met** — the docs table lists opus for planning — evidence: `y` — reviewer: met",
    ].join("\n"),
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    "met",
    "met",
    "missing",
  ]);
});

Deno.test("matchClosureStatuses - an abbreviated subject (a subset of the criterion's words) still matches", () => {
  const entries = entriesFrom(
    "- **met** — the floor — evidence: `x` — reviewer: met",
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    undefined,
    undefined,
    "met",
  ]);
});

Deno.test("matchClosureStatuses - an entry quoting the criterion plus extra words still matches", () => {
  const entries = entriesFrom(
    "- **met** — the router sends planning to opus, as the config now routes it — evidence: `x` — reviewer: met",
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    "met",
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureStatuses - an entry about something else matches nothing", () => {
  const entries = entriesFrom(
    "- **met** — unrelated subject entirely — evidence: `x` — reviewer: met",
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    undefined,
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureStatuses - an entry equally close to two criteria is ambiguous and matches neither", () => {
  const criteria = ["Ship the router update.", "Ship the docs update."];
  const entries = entriesFrom(
    "- **met** — ship the update — evidence: `x` — reviewer: met",
  );
  assertEquals(matchClosureStatuses(criteria, entries), [
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureStatuses - a criterion split across a met and a missing entry reads missing", () => {
  const entries = entriesFrom(
    [
      "- **met** — the router sends planning to opus for the eight phases — evidence: `x` — reviewer: met",
      "- **missing** — the router sends planning to opus for the ninth phase — reviewer: missing — reason: forgot one",
    ].join("\n"),
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    "missing",
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureStatuses - a criterion split across a met and a partial entry reads partial", () => {
  const entries = entriesFrom(
    [
      "- **met** — the router sends planning to opus for the eight phases — evidence: `x` — reviewer: met",
      "- **partial** — the router sends planning to opus for the ninth phase — evidence: `y` — reviewer: partial — reason: half done",
    ].join("\n"),
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    "partial",
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureStatuses - unrequested entries are ignored entirely", () => {
  const entries = entriesFrom(
    "- **unrequested** — the router sends planning to opus — reason: scope creep",
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    undefined,
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureEntries - an empty-subject partial or missing entry is a gap named by its reason", () => {
  const entries = entriesFrom(
    [
      "- **partial** — reviewer: partial — reason: the table names the wrong model",
      "- **missing** — reviewer: missing — reason: the docs table still says sonnet",
    ].join("\n"),
  );
  assertEquals(matchClosureEntries(CRITERIA, entries), {
    statuses: [undefined, undefined, undefined],
    unassignedGaps: [
      { status: "partial", subject: "the table names the wrong model" },
      { status: "missing", subject: "the docs table still says sonnet" },
    ],
  });
});

Deno.test("matchClosureEntries - a missing entry tied between two criteria is kept as a gap", () => {
  const criteria = ["Ship the router update.", "Ship the docs update."];
  const entries = entriesFrom(
    "- **missing** — ship the update — reviewer: missing — reason: either file could be the one",
  );
  assertEquals(matchClosureEntries(criteria, entries), {
    statuses: [undefined, undefined],
    unassignedGaps: [
      { status: "missing", subject: "ship the update —" },
    ],
  });
});

Deno.test("matchClosureStatuses - an entry with no subject words matches nothing", () => {
  const entries = entriesFrom(
    "- **met** — evidence: x — reviewer: met",
  );
  assertEquals(matchClosureStatuses(CRITERIA, entries), [
    undefined,
    undefined,
    undefined,
  ]);
});

Deno.test("matchClosureStatuses - criterion markdown, punctuation and case are ignored", () => {
  const criteria = ["The `router` sends planning to `opus`."];
  const entries = entriesFrom(
    "- **met** — THE ROUTER SENDS PLANNING TO OPUS — evidence: `x` — reviewer: met",
  );
  assertEquals(matchClosureStatuses(criteria, entries), ["met"]);
});
