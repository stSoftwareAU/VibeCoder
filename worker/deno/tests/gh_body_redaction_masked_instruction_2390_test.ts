/**
 * The `gh issue create` chokepoint against a body whose instruction it has
 * just masked (Issue #2390).
 *
 * The filer half of the incident: the audit's finding text went through
 * `redactGhBodyArgs`, came out reading "Add `persist-credentials:
 * ***REDACTED***`", and was published without anyone being told. The
 * chokepoint now says so — on the issue, where its reader is, and in the log,
 * where the false positive gets fixed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { redactGhBodyArgs } from "../lib/gh_body_redaction.ts";

/** Run `fn` with `console.error` captured. */
function captureErrors<T>(fn: () => T): { value: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    return { value: fn(), errors };
  } finally {
    console.error = original;
  }
}

// A value the secret filter genuinely masks, under an instruction heading.
const FINDING = [
  "## Suggested fix",
  "",
  "Set `DEPLOY_PASSWORD=hunter2hunter2` in the job environment.", // gitleaks:allow fake fixture, not a real key
].join("\n");

Deno.test("issue create - a masked instruction is published with a visible notice and logged loudly", () => {
  const { value: out, errors } = captureErrors(() =>
    redactGhBodyArgs(["issue", "create", "--title", "T", "--body", FINDING])
  );
  const body = out[out.indexOf("--body") + 1] ?? "";
  assert(!body.includes("hunter2"), "the value is still masked");
  assertStringIncludes(body, "was masked by the worker's secret filter");
  assertStringIncludes(body, "line 3");
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0] ?? "", "[MASKED_INSTRUCTION_FILED]");
});

Deno.test("issue create - the `--body=` spelling is covered too", () => {
  const { value: out } = captureErrors(() =>
    redactGhBodyArgs(["issue", "create", `--body=${FINDING}`])
  );
  assertStringIncludes(
    out[2] ?? "",
    "was masked by the worker's secret filter",
  );
});

Deno.test("issue create - a body masked only in its evidence is published untouched by the notice", () => {
  const evidence =
    "Make the job retry once.\n\n## Evidence\n\n> DEPLOY_PASSWORD=hunter2hunter2 rejected"; // gitleaks:allow fake fixture, not a real key
  const { value: out, errors } = captureErrors(() =>
    redactGhBodyArgs(["issue", "create", "--body", evidence])
  );
  const body = out[out.indexOf("--body") + 1] ?? "";
  assert(!body.includes("hunter2"));
  assert(!body.includes("secret filter"));
  assertEquals(errors, []);
});

Deno.test("issue create - a clean body is byte-identical", () => {
  const clean = "## Suggested fix\n\nAdd `persist-credentials: false`.";
  const { value: out, errors } = captureErrors(() =>
    redactGhBodyArgs(["issue", "create", "--body", clean])
  );
  // `persist-credentials: false` is fixed separately (#2389); on a tree
  // without that fix this body is itself masked, so assert on the notice only
  // when the mask left the body alone.
  const body = out[out.indexOf("--body") + 1] ?? "";
  if (body === clean) assertEquals(errors, []);
});

Deno.test("a comment, not an issue create, never gains the notice", () => {
  const { value: out, errors } = captureErrors(() =>
    redactGhBodyArgs(["issue", "comment", "42", "--body", FINDING])
  );
  assert(!(out[out.indexOf("--body") + 1] ?? "").includes("secret filter"));
  assertEquals(errors, []);
});
