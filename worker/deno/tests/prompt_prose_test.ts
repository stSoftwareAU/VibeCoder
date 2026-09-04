/**
 * Tests for the prompt prose and heading projections (Issue #840).
 *
 * `tests/support/prompt_prose.ts` is what two drift gates see the templates
 * through, so a bug in it does not fail a gate — it turns one green. A
 * projection that swallowed the whole template would make every "assert this
 * phrase is absent" rule pass while reading nothing, and a line map that
 * drifted from the flattened text would report the wrong line in a failure
 * message a maintainer is meant to act on.
 *
 * These cases drive the real functions with template-shaped text and assert
 * on what comes back: the happy path for each, the exemptions the gates rely
 * on (fences, code spans), the boundaries (a phrase split by the hard wrap,
 * an unterminated fence), and each of the four faults the module raises
 * rather than swallowing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  fencedBlocks,
  flattenAll,
  flattenProse,
  headings,
  hitsIn,
} from "./support/prompt_prose.ts";

const TEMPLATE = [
  "## Issue Implementation Mode",
  "",
  "Run `./quality.sh` before the PR, and never call the",
  "executor by that name.",
  "",
  "```markdown",
  "## Why this matters",
  "",
  "the executor is fine inside a fence",
  "```",
  "",
  "### Worked Examples",
].join("\n");

Deno.test("prompt prose - fences and code spans are dropped from the prose", () => {
  const { flat } = flattenProse(TEMPLATE);
  assertEquals(flat.includes("./quality.sh"), false, "code span kept");
  assertEquals(flat.includes("## Why this matters"), false, "fence kept");
  assertEquals(flat.includes("Run "), true, "surrounding prose lost");
});

Deno.test("prompt prose - the fenced example is searched only when the code is kept", () => {
  // A scan states the footer contract inside the issue body it files, so a
  // rule about that contract has to read the fence the prose projection drops.
  assertEquals(hitsIn(TEMPLATE, /\bfence\b/g), []);
  assertEquals(hitsIn(TEMPLATE, /\bfence\b/g, true), ["line 9: fence"]);
  // Kept means kept: the code span the prose projection blanks out is back.
  assertEquals(flattenAll(TEMPLATE).flat.includes("./quality.sh"), true);
});

Deno.test("prompt prose - the line map reports the source line a hit came from", () => {
  // Line 3 in the template above, and it is the wrapped phrase: the projection
  // joins the hard wrap, so the match starts on the line the phrase starts on.
  assertEquals(hitsIn(TEMPLATE, /\b[Tt]he\s+executors?\b/g), [
    "line 3: the executor",
  ]);
});

Deno.test("prompt prose - an empty template yields no hits rather than throwing", () => {
  assertEquals(hitsIn("", /\bexecutor\b/g), []);
  // One empty line in, one newline out — the projection is line-based, so it
  // never returns less than the newline it was given.
  assertEquals(flattenProse("").flat, "\n");
});

Deno.test("prompt prose - the line map raises rather than mislabelling an offset", () => {
  const { lineAt } = flattenProse("one line\n");
  assertThrows(
    () => lineAt(9_999),
    Error,
    "prose line map has no entry for offset",
  );
});

Deno.test("prompt prose - a non-global pattern is rejected", () => {
  // Without `g` only the first hit is found, so a template with two banned
  // phrases would report one and look half-clean.
  assertThrows(
    () => hitsIn("the executor and the executor", /\bexecutor\b/),
    Error,
    "must be global",
  );
});

Deno.test("prompt prose - a pattern with a literal space is rejected", () => {
  // The prose is flattened across a ~70-column hard wrap, so a literal space
  // silently under-matches wherever the wrap falls between the words.
  assertThrows(
    () => hitsIn("idle task", /\bidle task\b/g),
    Error,
    "literal space",
  );
});

Deno.test("prompt prose - fenced blocks are returned without their fence lines", () => {
  assertEquals(fencedBlocks(TEMPLATE), [
    "## Why this matters\n\nthe executor is fine inside a fence",
  ]);
  assertEquals(fencedBlocks("no fences here"), []);
});

Deno.test("prompt prose - an unterminated fence raises rather than dropping the rest of the file", () => {
  // The fault a gate cannot survive quietly: one stray fence inverts the
  // parity, so every later line reads as fenced and disappears from the prose
  // a rule is asserted against. Both projections raise on it.
  const stray = ["```", "", "The executor runs quality.sh on an idle task."]
    .join("\n");
  assertThrows(() => flattenProse(stray), Error, "unbalanced fences");
  assertThrows(() => hitsIn(stray, /\bexecutors?\b/g), Error, "line 1");
  assertThrows(() => fencedBlocks("```sh\nrunning\n"), Error, "line 1");

  // A balanced pair either side of prose is not unbalanced, however many
  // blocks there are — the guard must not fire on an ordinary template.
  assertEquals(
    hitsIn(
      "```\nfenced\n```\nthe executor\n```\nmore\n```\n",
      /\bexecutors?\b/g,
    ),
    ["line 4: executor"],
  );
});

Deno.test("prompt prose - headings are listed with level, line and written form", () => {
  assertEquals(
    headings(TEMPLATE).map((h) => [h.line, h.level, h.written]),
    [
      [1, 2, "## Issue Implementation Mode"],
      [7, 2, "## Why this matters"],
      [12, 3, "### Worked Examples"],
    ],
    "fenced headings are governed too, and indentation is stripped",
  );
});

Deno.test("prompt prose - an indented fenced heading keeps its written form", () => {
  // A scan shows the body it files as an indented fenced example, so its slot
  // headings arrive indented and must still compare equal to the house form.
  assertEquals(
    headings("   ```\n   ## Suggested fix\n   ```\n").map((h) => h.written),
    ["## Suggested fix"],
  );
});

Deno.test("prompt prose - a shell comment in a fence is not read as a heading", () => {
  // `# best-practice-ignore: …` inside a fenced snippet is a comment. Level 1
  // is excluded for exactly this reason.
  assertEquals(
    headings("```sh\n# best-practice-ignore: BP-0123456789ab\n```\n"),
    [],
  );
});
