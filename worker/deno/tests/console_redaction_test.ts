/**
 * Tests for lib/console_redaction.ts — process-wide masking of secrets in
 * direct `console.*` output (Issue #3661, SEC-f684a9d954ff).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  installConsoleRedaction,
  restoreConsole,
} from "../lib/console_redaction.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

/**
 * Capture what a console method actually emits while the patch is active.
 *
 * The sink is swapped in *before* `installConsoleRedaction`, so the patch
 * wraps the sink exactly as it wraps the real console in production.
 *
 * @param method - The console method to exercise.
 * @param args - Arguments passed to that method.
 * @returns The arguments the underlying implementation received.
 */
function captureThroughPatch(
  method: "log" | "warn" | "error" | "info" | "debug",
  args: unknown[],
): unknown[] {
  const target = globalThis.console as unknown as Record<string, unknown>;
  const real = target[method];
  const seen: unknown[][] = [];
  target[method] = (...received: unknown[]) => {
    seen.push(received);
  };
  try {
    installConsoleRedaction();
    (target[method] as (...a: unknown[]) => void)(...args);
  } finally {
    restoreConsole();
    target[method] = real;
  }
  return seen[0] ?? [];
}

Deno.test("installConsoleRedaction - masks a GitHub token in console.error", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const seen = captureThroughPatch("error", [`clone failed with ${token}`]);
  assertEquals(seen.length, 1);
  const line = String(seen[0]);
  assertEquals(line.includes(token), false);
  assertStringIncludes(line, REDACTION_PLACEHOLDER);
});

Deno.test("installConsoleRedaction - masks credentials in a clone URL on console.warn", () => {
  const url = "https://x-access-token:ghs_secretvalue123456@github.com/o/r.git";
  const seen = captureThroughPatch("warn", [
    `fatal: unable to access '${url}'`,
  ]);
  assertEquals(String(seen[0]).includes("ghs_secretvalue123456"), false);
});

Deno.test("installConsoleRedaction - covers console.log, info and debug too", () => {
  const key = `sk-ant-api03-${"b".repeat(80)}`;
  for (const method of ["log", "info", "debug"] as const) {
    const seen = captureThroughPatch(method, [`key=${key}`]);
    assertEquals(
      String(seen[0]).includes(key),
      false,
      `console.${method} should be redacted`,
    );
  }
});

Deno.test("installConsoleRedaction - ordinary prose is untouched", () => {
  const message = "Quality gate PASSED: 42 checks in 3m 7s";
  const seen = captureThroughPatch("log", [message]);
  assertEquals(seen[0], message);
});

Deno.test("installConsoleRedaction - non-string arguments pass through unchanged", () => {
  const payload = { repo: "o/r", issue: 3661 };
  const seen = captureThroughPatch("log", ["context", payload, 7]);
  assertEquals(seen[0], "context");
  assertEquals(seen[1], payload);
  assertEquals(seen[2], 7);
});

Deno.test("installConsoleRedaction - is idempotent and restorable", () => {
  const before = globalThis.console.error;
  assert(installConsoleRedaction(), "first install should report true");
  assertEquals(
    installConsoleRedaction(),
    false,
    "second install must not double-wrap",
  );
  assert(restoreConsole(), "restore should report true");
  assertEquals(globalThis.console.error, before);
  assertEquals(restoreConsole(), false, "restore with no patch is a no-op");
});
