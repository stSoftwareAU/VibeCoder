/**
 * Tests for the `gh issue create` label chokepoint (Issue #1276).
 *
 * These are the regression tests for the scope gap: before the fix, a label
 * applied at creation time never reached `assertWorkerCanApplyLabel`, so a
 * reserved or unknown label reached `gh issue create` unchecked. The helper
 * now refuses it loudly.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { guardedLabelArgs } from "../lib/guarded_issue_labels.ts";
import { WORKER_FORBIDDEN_LABEL_LITERALS } from "../lib/worker_label_guard.ts";

Deno.test("guardedLabelArgs - builds argv for allowed content labels", () => {
  assertEquals(
    guardedLabelArgs(
      ["bash-syntax-audit", "severity:high"],
      "worker/deno/lib/idle_task_templates/bash_syntax_audit_template.ts",
    ),
    ["--label", "bash-syntax-audit", "--label", "severity:high"],
  );
});

Deno.test("guardedLabelArgs - empty label list yields no arguments", () => {
  assertEquals(guardedLabelArgs([], "worker/deno/lib/example.ts"), []);
});

Deno.test("guardedLabelArgs - refuses every reserved workflow label", () => {
  for (const label of WORKER_FORBIDDEN_LABEL_LITERALS) {
    const error = assertThrows(
      () => guardedLabelArgs([label], "worker/deno/lib/example.ts"),
      Error,
    );
    assert(
      error.message.includes(`'${label}'`),
      `refusal must name the offending label, got: ${error.message}`,
    );
  }
});

Deno.test("guardedLabelArgs - refuses an off-list label derived from scan data", () => {
  // The regression the check exists to stop: a template interpolating scan
  // data into a label argument that never passed the allowlist.
  assertThrows(
    () =>
      guardedLabelArgs(
        ["alert-feed", `owner:${"attacker"}`],
        "worker/deno/lib/idle_task_templates/alert_feed_template.ts",
      ),
    Error,
    "owner:attacker",
  );
});

Deno.test("guardedLabelArgs - refuses the whole call, not just the bad label", () => {
  assertThrows(
    () =>
      guardedLabelArgs(
        ["dead-code", "top-priority", "severity:low"],
        "worker/deno/lib/example.ts",
      ),
    Error,
    "top-priority",
  );
});

Deno.test("guardedLabelArgs - refusal names every off-list label", () => {
  const error = assertThrows(
    () =>
      guardedLabelArgs(
        ["work-on", "best-model"],
        "worker/deno/lib/example.ts",
      ),
    Error,
  );
  assert(error.message.includes("'work-on'"));
  assert(error.message.includes("'best-model'"));
});
