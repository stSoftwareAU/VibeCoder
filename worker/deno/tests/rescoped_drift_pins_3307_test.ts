/**
 * Issue #3307 — converting an existing whole-file drift test to `section()`
 * can drop coverage while every pinned string survives. Review rounds sent
 * two fleet PRs back for it: one of VibeCoder#3297 had moved the pin "In an
 * issue run" into a list where a longer pin already contained it, and one of
 * VibeCoder#3240 had narrowed absence checks to one section. `assertPins`
 * refuses a subsumed pin; the docs cases pin the re-scoping rule in the
 * standard and in each surface that points to it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { AssertionError, assertThrows } from "@std/assert";
import {
  assertPins,
  type DocSection,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const DOC = [
  "# Page",
  "",
  "## Blocked",
  "",
  "In an issue run, the worker recognises that shape and defers",
  "the issue.",
  "",
  "## Escape Hatch",
  "",
  "In an issue run, this free-text hand-off is honoured only when",
  "the run leaves no commit.",
  "",
].join("\n");

function blocked(): DocSection {
  return section(DOC, "Blocked");
}

function escapeHatch(): DocSection {
  return section(DOC, "Escape Hatch");
}

Deno.test("assertPins - passes when every pin is present, including one that spans the line wrap", () => {
  assertPins(blocked(), [
    "In an issue run, the worker recognises that shape and defers the issue.",
  ]);
});

Deno.test("assertPins - refuses a pin subsumed by a longer pin in the same list", () => {
  assertThrows(
    () =>
      assertPins(escapeHatch(), [
        "In an issue run",
        "In an issue run, this free-text hand-off is honoured",
      ]),
    AssertionError,
    "is subsumed by pin",
  );
});

Deno.test("assertPins - the same section passes once the subsumed pin is dropped", () => {
  assertPins(escapeHatch(), [
    "In an issue run, this free-text hand-off is honoured",
  ]);
});

Deno.test("assertPins - a duplicate pin is subsumed by itself", () => {
  assertThrows(
    () => assertPins(blocked(), ["defers the issue", "defers the issue"]),
    AssertionError,
    "is subsumed by pin",
  );
});

Deno.test("assertPins - a missing pin names itself in the failure, and passes against the right section", () => {
  assertThrows(
    () => assertPins(escapeHatch(), ["defers the issue"]),
    AssertionError,
    'section is missing pin "defers the issue"',
  );
  assertPins(blocked(), ["defers the issue"]);
});

Deno.test("assertPins - an empty pins list pins nothing and throws", () => {
  assertThrows(
    () => assertPins(blocked(), []),
    AssertionError,
    "no pins given",
  );
});

// Documentation-drift tests (CODING-STANDARDS.md § Documentation-drift
// tests): the re-scoping rule itself, in the standard and in each surface
// that points to it. Each reads one section and asserts through
// `assertPins` itself.

Deno.test("CODING-STANDARDS - re-scoping an existing drift test keeps every check's reach", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Documentation-drift tests",
    ),
    [
      "Re-scoping an existing drift test.",
      "Map each pin to its rule.",
      "scope the pin to the heading that holds that sentence",
      "A pin that is a substring of another pin in the same scoped list checks nothing",
      `\`${assertPins.name}(section, pins)\` from`,
      "that read the whole file stays on `flatWholeFile`",
      "Red-check each moved check, not the test.",
      "one line per moved check",
    ],
  );
});

Deno.test("issue prompt - the Test Plan points a moved pin at the re-scoping rule", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "A pin the diff only moves, while converting an existing whole-file drift test to `section()`",
      "keep each whole-file absence check on `flatWholeFile`",
      "record here one line per moved check",
    ],
  );
});

Deno.test("pr_feedback prompt - a moved pin follows the re-scoping rule", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "A pin you only moved while converting an existing whole-file drift test",
      "keeps every whole-file absence check whole-file",
    ],
  );
});

Deno.test("test_audit prompt - a whole-file absence check is not a finding", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/test_audit/prompt.md"),
      "Source-text greps used as assertions",
    ),
    [
      "an absence check may read the whole file, since the absence must hold in every section",
    ],
  );
});

Deno.test("CONTRIBUTING - a moved pin is red-checked in its own section", async () => {
  assertPins(
    section(await readRepoDoc("CONTRIBUTING.md"), "Test layout"),
    [
      "A pin moved by converting an existing whole-file drift test to `section()` is meant to be on base",
    ],
  );
});
