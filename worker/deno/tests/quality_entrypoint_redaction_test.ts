/**
 * Tests for the `quality.ts` entry point's output path (Issue #1280).
 *
 * The gate's transcript is assembled from the raw `stdout + stderr` of every
 * check, so a test or lint step that echoes a credential puts that credential
 * on this process's stdout. `quality.ts` is a separate process from `mod.ts`,
 * where the console patch used to be installed — these tests drive the real
 * print path and assert the credential never reaches the underlying console.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { printGateOutput } from "../quality.ts";
import { restoreConsole } from "../lib/console_redaction.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

/**
 * Capture what `printGateOutput` writes to the underlying console.
 *
 * The sink is swapped in *before* the call, so the patch the entry point
 * installs wraps the sink exactly as it wraps the real console in production.
 *
 * @param result - The gate result to print.
 * @returns One string per `console.log` call the underlying console received.
 */
function capturePrintedLines(
  result: { summary: { text: string }; output: string },
): string[] {
  const target = globalThis.console as unknown as Record<string, unknown>;
  const real = target.log;
  const seen: string[] = [];
  target.log = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  try {
    printGateOutput(result as Parameters<typeof printGateOutput>[0]);
  } finally {
    restoreConsole();
    target.log = real;
  }
  return seen;
}

Deno.test("printGateOutput - masks a token echoed by a check into the transcript", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const lines = capturePrintedLines({
    summary: { text: "Quality gate: FAILED (1 of 42 checks)" },
    output: [
      "=== Running Quality Checks ===",
      "deno tests: FAILED",
      `fatal: could not read from 'https://x-access-token:${token}@github.com/o/r.git'`,
    ].join("\n"),
  });

  const printed = lines.join("\n");
  assertEquals(
    printed.includes(token),
    false,
    "the check's captured token must not reach stdout",
  );
  assertStringIncludes(printed, REDACTION_PLACEHOLDER);
  // The surrounding transcript is still printed — redaction is targeted.
  assertStringIncludes(printed, "deno tests: FAILED");
});

Deno.test("printGateOutput - masks an exported token in a check's stderr", () => {
  const lines = capturePrintedLines({
    summary: { text: "Quality gate: FAILED (2 of 42 checks)" },
    output: "+ export ANTHROPIC_API_KEY=sk-ant-api03-" + "b".repeat(80),
  });

  assertEquals(
    lines.join("\n").includes("b".repeat(80)),
    false,
    "an exported key in captured stderr must not reach stdout",
  );
});

Deno.test("printGateOutput - prints the summary and skips an empty transcript", () => {
  const lines = capturePrintedLines({
    summary: { text: "Quality gate: PASSED (42 checks in 3m 7s)" },
    output: "",
  });

  assertEquals(lines, ["Quality gate: PASSED (42 checks in 3m 7s)"]);
});
