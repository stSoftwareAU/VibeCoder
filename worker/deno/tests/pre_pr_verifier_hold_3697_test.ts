/**
 * The held-PR marker (Issue #3697): the line the worker writes first on the
 * comment that holds a PR for a pre-PR verifier finding, and its parser.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  parsePrePrVerifierHeldMarker,
  prePrVerifierHeldMarkerLine,
} from "../lib/pre_pr_verifier_hold.ts";

Deno.test("the marker line round-trips through the parser for both values (Issue #3697)", () => {
  assertEquals(
    prePrVerifierHeldMarkerLine(true),
    '<!-- vibe-pre-pr-verifier-held releasable="true" -->',
  );
  assertEquals(
    prePrVerifierHeldMarkerLine(false),
    '<!-- vibe-pre-pr-verifier-held releasable="false" -->',
  );
  assertEquals(
    parsePrePrVerifierHeldMarker(prePrVerifierHeldMarkerLine(true)),
    { releasable: true },
  );
  assertEquals(
    parsePrePrVerifierHeldMarker(prePrVerifierHeldMarkerLine(false)),
    { releasable: false },
  );
  assertEquals(
    parsePrePrVerifierHeldMarker(
      prePrVerifierHeldMarkerLine(false) + "\nbody text",
    ),
    { releasable: false },
  );
});

Deno.test("the parser returns null when the marker is not at index 0 (Issue #3697)", () => {
  const line = prePrVerifierHeldMarkerLine(true);
  assertEquals(parsePrePrVerifierHeldMarker(" " + line), null);
  assertEquals(parsePrePrVerifierHeldMarker("\n" + line), null);
  assertEquals(parsePrePrVerifierHeldMarker("text\n" + line), null);
  assertEquals(parsePrePrVerifierHeldMarker("text " + line), null);
});

Deno.test("the parser returns null for a different attribute value, marker name, or an empty body (Issue #3697)", () => {
  assertEquals(
    parsePrePrVerifierHeldMarker(
      '<!-- vibe-pre-pr-verifier-held releasable="yes" -->',
    ),
    null,
  );
  assertEquals(
    parsePrePrVerifierHeldMarker(
      '<!-- vibe-pre-pr-verifier-other releasable="true" -->',
    ),
    null,
  );
  assertEquals(parsePrePrVerifierHeldMarker(""), null);
});

Deno.test("the parser rejects a hostile run of spaces before the marker quickly (Issue #3697)", () => {
  const hostile = " ".repeat(100_000) + "x";
  assertEquals(parsePrePrVerifierHeldMarker(hostile), null);
});

Deno.test("the parser reads the first marker when a later line repeats it with another value (Issue #3697)", () => {
  const body = prePrVerifierHeldMarkerLine(true) + "\n" +
    prePrVerifierHeldMarkerLine(false) + "\nFix each finding.";
  assertStringIncludes(body, prePrVerifierHeldMarkerLine(false));
  assertEquals(parsePrePrVerifierHeldMarker(body), { releasable: true });
});
