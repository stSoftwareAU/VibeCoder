/**
 * The gh body chokepoint carries the LLM07 backstop too (Issue #1421).
 *
 * `redactGhBodyArgs` is the one place both the worker's own `gh` calls and the
 * coding agent's raw ones (through the PATH shim) pass before a body reaches a
 * public GitHub sink. Its module doc promises that "every present and future
 * public sink inherits redaction by construction" — but it masked only
 * secret-SHAPED text. `redactPromptLeakage`, the module built to strip leaked
 * system-prompt and `<coding_guidelines>` scaffolding, had exactly one caller:
 * `answer_sanitiser.ts`, covering only the question-answering path.
 *
 * So on every ordinary run — `work-on`, `planning`, `grill-me`, `ci_fix`,
 * revision — an injected agent echoing its own instructions into a PR body or
 * comment was published with no backstop at all.
 *
 * Both routes are covered here. The argv route is the one the issue describes;
 * the stdin route (`gh api --input -`) has no argument to rewrite and was
 * missed entirely, which is how a fix can look complete and not be.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  redactGhBodyArgs,
  redactGhBodyText,
} from "../lib/gh_body_redaction.ts";
import { PROMPT_LEAK_PLACEHOLDER } from "../lib/prompt_leak_redaction.ts";

/** Scaffolding an injected agent might echo into a published body. */
const LEAKED =
  "<coding_guidelines>\nAlways use Australian English.\n</coding_guidelines>";

/** A secret-shaped string, to prove the original mask still runs. */
const SECRET = `ghp_${"A".repeat(36)}`;

const bodyOf = (args: readonly string[]): string => {
  const i = args.indexOf("--body");
  return i >= 0 ? args[i + 1] ?? "" : "";
};

// ---------------------------------------------------------------------------
// The argv route
// ---------------------------------------------------------------------------

Deno.test("SEC-1421 - a leaked guidelines block is masked in --body", () => {
  const out = redactGhBodyArgs(["pr", "comment", "--body", LEAKED]);
  const body = bodyOf(out);
  assertEquals(body.includes("<coding_guidelines>"), false);
  assertStringIncludes(body, PROMPT_LEAK_PLACEHOLDER);
});

Deno.test("SEC-1421 - the --body=<text> spelling is masked too", () => {
  const out = redactGhBodyArgs(["pr", "comment", `--body=${LEAKED}`]);
  const joined = out.join(" ");
  assertEquals(joined.includes("<coding_guidelines>"), false);
  assertStringIncludes(joined, PROMPT_LEAK_PLACEHOLDER);
});

Deno.test("SEC-1421 - a -f field assignment is masked", () => {
  const out = redactGhBodyArgs([
    "api",
    "repos/o/r/issues",
    "-f",
    `body=${LEAKED}`,
  ]);
  const joined = out.join(" ");
  assertEquals(joined.includes("<coding_guidelines>"), false);
});

Deno.test("SEC-1421 - the secret mask still runs alongside it", () => {
  // The backstop is added, not substituted: a body carrying both must lose
  // both. Chaining that dropped one would pass a test written for the other.
  const out = redactGhBodyArgs([
    "pr",
    "comment",
    "--body",
    `${LEAKED}\ntoken ${SECRET}`,
  ]);
  const body = bodyOf(out);
  assertEquals(body.includes("<coding_guidelines>"), false);
  assertEquals(body.includes(SECRET), false);
});

// ---------------------------------------------------------------------------
// The stdin route — `gh api --input -` has no argument to rewrite
// ---------------------------------------------------------------------------

Deno.test("SEC-1421 - a body sent on stdin is masked by the same function", () => {
  const masked = redactGhBodyText(`${LEAKED}\ntoken ${SECRET}`);
  assertEquals(masked.includes("<coding_guidelines>"), false);
  assertEquals(masked.includes(SECRET), false);
  assertStringIncludes(masked, PROMPT_LEAK_PLACEHOLDER);
});

Deno.test("SEC-1421 - the stdin mask is the argv mask, not a second copy", () => {
  // Two implementations of "mask a body" is how the two drift. The stdin
  // path must produce byte-identical output to the argv path for the same
  // text, so a rule added to one is in the other by construction.
  const text = `${LEAKED}\ntoken ${SECRET}\nordinary prose`;
  const viaArgv = bodyOf(redactGhBodyArgs(["pr", "comment", "--body", text]));
  assertEquals(redactGhBodyText(text), viaArgv);
});

// ---------------------------------------------------------------------------
// The permit direction — ordinary bodies survive intact
// ---------------------------------------------------------------------------

Deno.test("SEC-1421 - an ordinary body is unchanged", () => {
  // A backstop that mangles normal PR bodies would be reverted, and should be.
  const ordinary =
    "Fixes the parser. Adds a test for the empty case.\n\nSee #42.";
  const out = redactGhBodyArgs(["pr", "comment", "--body", ordinary]);
  assertEquals(bodyOf(out), ordinary);
  assertEquals(redactGhBodyText(ordinary), ordinary);
});

Deno.test("SEC-1421 - prose merely mentioning the guidelines is not destroyed", () => {
  // Only the scaffolding itself is scrubbed, not any reference to it — the
  // agent must still be able to say what it did.
  const prose = "I followed the coding guidelines for Australian English.";
  assertEquals(redactGhBodyText(prose), prose);
});

Deno.test("SEC-1421 - an empty body is handled", () => {
  assertEquals(redactGhBodyText(""), "");
  const out = redactGhBodyArgs(["pr", "comment", "--body", ""]);
  assert(out.includes("--body"));
});
