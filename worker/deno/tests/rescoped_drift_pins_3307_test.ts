/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
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
      "Review each moved check's scope.",
      "do not mutate every rule merely to produce a proof log",
    ],
  );
});

Deno.test("issue prompt keeps whole-file absence checks whole-file", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "keep whole-file absence checks whole-file",
      "section-scoping",
    ],
  );
});

Deno.test("feedback applies documentation section-scoping rules", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "section-scoping and live-source rules",
    ],
  );
});

Deno.test("guidelines refer moved checks to canonical scoping rules", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
    [
      "section-scoping and live-value rules",
      "Documentation-drift tests",
    ],
  );
});

Deno.test("new-test rule refers moved checks to canonical scoping rules", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Test coverage expectations",
    ),
    [
      "section-scoping and live-value rules",
      "Documentation-drift tests",
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

Deno.test("contributor guide preserves scope of moved checks", async () => {
  assertPins(section(await readRepoDoc("CONTRIBUTING.md"), "Test layout"), [
    "review its section scope and run the existing drift tests",
    "Keep whole-file absence checks whole-file",
  ]);
});
