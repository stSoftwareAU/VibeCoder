/**
 * Tests for worker_label_guard.ts (Issue #2382 — Rule of Two).
 *
 * Covers the positive allowlist (literals + prefixes), the explicit
 * forbidden list, the assert helper's audit-line emission, and the
 * Result error shape.
 *
 * Australian English throughout (behaviour, organisation, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assertWorkerCanApplyLabel,
  isWorkerAppliableLabel,
  WORKER_APPLIABLE_CONTENT_LABELS,
  WORKER_APPLIABLE_LABEL_LITERALS,
  WORKER_APPLIABLE_LABEL_PREFIXES,
  WORKER_FORBIDDEN_LABEL_LITERALS,
} from "../lib/worker_label_guard.ts";

Deno.test("worker_label_guard - every literal in the allowlist is appliable", () => {
  for (const label of WORKER_APPLIABLE_LABEL_LITERALS) {
    assert(
      isWorkerAppliableLabel(label),
      `expected literal '${label}' to be appliable`,
    );
  }
});

Deno.test("worker_label_guard - prefix labels are appliable when non-empty", () => {
  for (const prefix of WORKER_APPLIABLE_LABEL_PREFIXES) {
    assert(
      isWorkerAppliableLabel(`${prefix}example`),
      `expected '${prefix}example' to be appliable`,
    );
  }
});

Deno.test("worker_label_guard - bare prefix without value is rejected", () => {
  for (const prefix of WORKER_APPLIABLE_LABEL_PREFIXES) {
    assertEquals(
      isWorkerAppliableLabel(prefix),
      false,
      `bare prefix '${prefix}' must be rejected`,
    );
  }
});

Deno.test("worker_label_guard - every forbidden literal is rejected", () => {
  for (const label of WORKER_FORBIDDEN_LABEL_LITERALS) {
    assertEquals(
      isWorkerAppliableLabel(label),
      false,
      `forbidden label '${label}' must be rejected`,
    );
  }
});

Deno.test("worker_label_guard - canonical scan-derived labels are appliable", () => {
  // The four scan templates apply these classification labels — confirm
  // the guard does not regress on them.
  const fixtures = [
    "severity:high",
    "severity:medium",
    "severity:low",
    "lang:rust",
    "lang:typescript",
    "lang:react",
    "supply-chain:quarantine-missing",
    "supply-chain:quarantine-misconfigured",
  ];
  for (const label of fixtures) {
    assert(
      isWorkerAppliableLabel(label),
      `expected scan-derived label '${label}' to be appliable`,
    );
  }
});

Deno.test("worker_label_guard - degraded-model is appliable (Issue #2650)", () => {
  // The planning flow applies degraded-model to the parent issue and every
  // sub-issue on a degraded run. best-model is reserved and cannot be reused;
  // degraded-model is the non-reserved replacement and must pass the guard.
  assert(
    isWorkerAppliableLabel("degraded-model"),
    "degraded-model must be worker-appliable",
  );
  assertEquals(
    isWorkerAppliableLabel("best-model"),
    false,
    "best-model must remain non-appliable (reserved)",
  );
  const result = assertWorkerCanApplyLabel("degraded-model", {
    caller: "test",
  });
  assert(result.ok, "assert guard must permit degraded-model");
});

Deno.test("worker_label_guard - random unrelated label is rejected", () => {
  // Issue #1276 moved `bug` onto the allowlist — the run-failure filer
  // applies it at `gh issue create` time — so this case now uses a label the
  // worker genuinely never applies. Everything else here is unchanged.
  assertEquals(isWorkerAppliableLabel("wontfix"), false);
  assertEquals(isWorkerAppliableLabel(""), false);
  assertEquals(isWorkerAppliableLabel("custom-label"), false);
  assertEquals(isWorkerAppliableLabel("severity"), false); // missing colon
});

Deno.test("worker_label_guard - membership is case-insensitive (Issue #3088)", () => {
  // GitHub treats label names case-insensitively, so a non-lower-case form of
  // an appliable literal or prefix must still be recognised.
  assertEquals(isWorkerAppliableLabel("FAILED"), true);
  assertEquals(isWorkerAppliableLabel("Idle-Task"), true);
  assertEquals(isWorkerAppliableLabel("Needs-Human"), true);
  assertEquals(isWorkerAppliableLabel("Severity:High"), true);
  assertEquals(isWorkerAppliableLabel("LANG:rust"), true);
  // A non-lower-case form of a forbidden label stays rejected.
  assertEquals(isWorkerAppliableLabel("Planning"), false);
  assertEquals(isWorkerAppliableLabel("Work-On"), false);
});

Deno.test("worker_label_guard - assertWorkerCanApplyLabel returns ok for allowed label", () => {
  const captured: string[] = [];
  const result = assertWorkerCanApplyLabel("failed", {
    caller: "test",
    logFn: (line) => captured.push(line),
  });
  assert(result.ok);
  assertEquals(captured.length, 0, "no audit line on allowed label");
});

Deno.test("worker_label_guard - assertWorkerCanApplyLabel rejects forbidden label with audit line", () => {
  const captured: string[] = [];
  const result = assertWorkerCanApplyLabel("top-priority", {
    caller: "worker/deno/lib/claim_issue.ts",
    logFn: (line) => captured.push(line),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "not authorised");
  assertStringIncludes(result.error.message, "top-priority");
  assertEquals(captured.length, 1);
  assertStringIncludes(captured[0]!, "[SECURITY] [WORKER_LABEL_REFUSED]");
  assertStringIncludes(captured[0]!, "label=top-priority");
  assertStringIncludes(captured[0]!, "caller=worker/deno/lib/claim_issue.ts");
});

Deno.test("worker_label_guard - assertWorkerCanApplyLabel uses 'unknown' when no caller given", () => {
  const captured: string[] = [];
  const result = assertWorkerCanApplyLabel("planning", {
    logFn: (line) => captured.push(line),
  });
  assert(!result.ok);
  assertStringIncludes(captured[0]!, "caller=unknown");
});

Deno.test("worker_label_guard - assertWorkerCanApplyLabel rejects empty label", () => {
  const captured: string[] = [];
  const result = assertWorkerCanApplyLabel("", {
    logFn: (line) => captured.push(line),
  });
  assert(!result.ok);
  assertEquals(captured.length, 1);
});

Deno.test("worker_label_guard - allowlist and forbidden list are disjoint", () => {
  // Defensive: refactors must not introduce overlap.
  for (const label of WORKER_FORBIDDEN_LABEL_LITERALS) {
    assertEquals(
      WORKER_APPLIABLE_LABEL_LITERALS.has(label),
      false,
      `forbidden label '${label}' must not appear in the allowlist`,
    );
    // Issue #1276: the content set widened the guard, so it must be
    // disjoint from the forbidden list too.
    assertEquals(
      WORKER_APPLIABLE_CONTENT_LABELS.has(label),
      false,
      `forbidden label '${label}' must not appear in the content set`,
    );
  }
});

Deno.test("worker_label_guard - every content label is appliable (Issue #1276)", () => {
  for (const label of WORKER_APPLIABLE_CONTENT_LABELS) {
    assert(
      isWorkerAppliableLabel(label),
      `expected content label '${label}' to be appliable`,
    );
  }
});

Deno.test("worker_label_guard - content labels are matched case-insensitively", () => {
  assert(isWorkerAppliableLabel("Dead-Code"));
  assert(isWorkerAppliableLabel("CONFIDENCE:high"));
});
