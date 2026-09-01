/**
 * Tests for the canonical content-label table (Issue #368).
 *
 * The fleet's `severity:*` / `confidence:*` / `security` / `lang:*` labels
 * drifted to a different colour in every repo because nine call sites each
 * hard-coded their own literal. These tests pin the canonical table and the
 * lookup helpers that replaced those literals.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  ALL_LABEL_DEFINITIONS,
  CONTENT_LABEL_DEFINITIONS,
  DEFAULT_LABEL_COLOUR,
  getApplicableLabels,
  getLabelByName,
  getLabelColour,
  getLabelDescription,
  LABEL_DEFINITIONS,
} from "../setup/label_definitions.ts";

// ── Table shape ─────────────────────────────────────────────────────────

Deno.test("CONTENT_LABEL_DEFINITIONS - every colour is lower-case 6-char hex", () => {
  const hexRegex = /^[0-9a-f]{6}$/;
  for (const label of CONTENT_LABEL_DEFINITIONS) {
    assertEquals(
      hexRegex.test(label.colour),
      true,
      `Invalid colour for ${label.name}: ${label.colour}`,
    );
  }
});

Deno.test("CONTENT_LABEL_DEFINITIONS - every label has name, description and content category", () => {
  for (const label of CONTENT_LABEL_DEFINITIONS) {
    assertNotEquals(label.name, "");
    assertNotEquals(label.description, "");
    assertEquals(label.category, "content", `Wrong category: ${label.name}`);
  }
});

Deno.test("ALL_LABEL_DEFINITIONS - no duplicate names across workflow and content halves", () => {
  const seen = new Set<string>();
  for (const label of ALL_LABEL_DEFINITIONS) {
    assertEquals(
      seen.has(label.name),
      false,
      `Duplicate label definition: ${label.name}`,
    );
    seen.add(label.name);
  }
  assertEquals(
    ALL_LABEL_DEFINITIONS.length,
    LABEL_DEFINITIONS.length + CONTENT_LABEL_DEFINITIONS.length,
  );
});

// ── Families read as families ───────────────────────────────────────────

Deno.test("severity ramp - red → orange → yellow → green as severity falls", () => {
  assertEquals(getLabelColour("severity:critical"), "b60205");
  assertEquals(getLabelColour("severity:high"), "d93f0b");
  assertEquals(getLabelColour("severity:medium"), "fbca04");
  assertEquals(getLabelColour("severity:low"), "0e8a16");
});

Deno.test("severity ramp - every step is a distinct colour", () => {
  const ramp = [
    getLabelColour("severity:critical"),
    getLabelColour("severity:high"),
    getLabelColour("severity:medium"),
    getLabelColour("severity:low"),
  ];
  assertEquals(new Set(ramp).size, 4);
});

Deno.test("confidence ramp - defined as a ramp, not one flat colour", () => {
  const ramp = [
    getLabelColour("confidence:high"),
    getLabelColour("confidence:medium"),
    getLabelColour("confidence:low"),
  ];
  assertEquals(new Set(ramp).size, 3);
});

Deno.test("security label - carries the critical-severity red, not GitHub's default grey", () => {
  assertEquals(getLabelColour("security"), "b60205");
  assertNotEquals(getLabelColour("security"), "ededed");
});

Deno.test("lang bucket labels - the best-practices buckets are all named", () => {
  for (
    const bucket of [
      "general",
      "design",
      "rust",
      "typescript",
      "react",
      "java",
      "html",
      "aws-cloudformation",
      "terraform",
    ]
  ) {
    assertNotEquals(
      getLabelByName(`lang:${bucket}`),
      undefined,
      `lang:${bucket} missing from the canonical table`,
    );
  }
});

// ── Lookup helpers ──────────────────────────────────────────────────────

Deno.test("getLabelColour - resolves workflow labels from the same table", () => {
  assertEquals(getLabelColour("work-on"), "5319e7");
  assertEquals(getLabelColour("needs-human"), "fbca04");
});

Deno.test("getLabelColour - matches case-insensitively (GitHub label names are)", () => {
  assertEquals(getLabelColour("Severity:Critical"), "b60205");
  assertEquals(getLabelColour("SECURITY"), "b60205");
});

Deno.test("getLabelColour - falls back to the default for an unmanaged label", () => {
  assertEquals(getLabelColour("some-humans-own-label"), DEFAULT_LABEL_COLOUR);
});

Deno.test("getLabelDescription - returns the canonical description, empty for unknown", () => {
  assertEquals(
    getLabelDescription("merge-conflict"),
    "PR conflicts with its base branch and needs a real merge",
  );
  assertEquals(getLabelDescription("some-humans-own-label"), "");
});

Deno.test("getLabelByName - finds content labels as well as workflow labels", () => {
  assertEquals(getLabelByName("severity:medium")?.category, "content");
  assertEquals(getLabelByName("work-on")?.category, "workflow");
});

// ── Onboarding is unchanged ─────────────────────────────────────────────

Deno.test("getApplicableLabels - content labels are never seeded onto a repo", () => {
  for (const hasUi of [true, false]) {
    const seeded = getApplicableLabels(hasUi);
    assertEquals(
      seeded.some((l) => l.category === "content"),
      false,
      `content labels leaked into onboarding (hasUi=${hasUi})`,
    );
  }
});
