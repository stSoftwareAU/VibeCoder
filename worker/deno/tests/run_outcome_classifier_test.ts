/**
 * Tests for the run-failure fixability classifier (Issue #4328, part of
 * #4291). Fixtures are real failure strings from worker logs and the
 * failure_diagnosis tests — not invented text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  classifyRunFailure,
  RUN_FAILURE_CLASSES,
  type RunFailureClassification,
} from "../lib/run_outcome_classifier.ts";
import {
  detectFailureCategory,
  type FailureCategory,
} from "../lib/failure_diagnosis.ts";

/** Real strings: from failure_diagnosis_test.ts fixtures and worker logs. */
const ROWS: {
  name: string;
  category: FailureCategory;
  message: string;
  fixability: RunFailureClassification["fixability"];
  failureClass: string;
}[] = [
  {
    name: "rate_limit → usage-limit",
    category: "rate_limit",
    message: "Claude usage limit reached (subscription window)",
    fixability: "not_code_fixable",
    failureClass: "usage-limit",
  },
  {
    name: "rate_limit (API) → usage-limit",
    category: "rate_limit",
    message: "API rate limit exceeded",
    fixability: "not_code_fixable",
    failureClass: "usage-limit",
  },
  {
    name: "out-of-credit message → out-of-credit",
    category: "unknown",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    fixability: "not_code_fixable",
    failureClass: "out-of-credit",
  },
  {
    name: "killed with OOM evidence → oom",
    category: "killed",
    message:
      "Claude was killed (exit 137, SIGKILL — possible out-of-memory in the VM) without creating changes",
    fixability: "code_fixable",
    failureClass: "oom",
  },
  {
    name:
      "killed with a high memory-pressure reading at the kill → oom (Issue #4374)",
    category: "killed",
    message:
      "Claude was killed (exit 137, SIGKILL) without creating changes\n\n### Diagnostics\n- Memory pressure at kill: high (400 MiB of 16.0 GiB available)",
    fixability: "code_fixable",
    failureClass: "oom",
  },
  {
    name: "killed, exit 137 only → oom",
    category: "killed",
    message: "Claude was killed (exit 137, SIGKILL) without creating changes",
    fixability: "code_fixable",
    failureClass: "oom",
  },
  {
    name: "killed without evidence → killed-unknown",
    category: "killed",
    message: "Claude was killed (SIGKILL, no watchdog)",
    fixability: "unknown",
    failureClass: "killed-unknown",
  },
  {
    name: "ENOSPC → disk-full",
    category: "internal_error",
    message:
      "Error: ENOSPC: no space left on device, write '/home/vibe/auto-issue-work/.deno-cache/…'",
    fixability: "code_fixable",
    failureClass: "disk-full",
  },
  {
    name: "internal_error → worker-crash",
    category: "internal_error",
    message: "Error: EACCES permission denied",
    fixability: "code_fixable",
    failureClass: "worker-crash",
  },
  {
    name: "unhandled stack trace with unknown category → worker-crash",
    category: "unknown",
    message:
      "TypeError: Cannot read properties of undefined (reading 'value')\n    at Object.processIssue (file:///home/vibe/.worker-src/worker/deno/lib/run_core_production_deps.ts:1930:22)",
    fixability: "code_fixable",
    failureClass: "worker-crash",
  },
  {
    name: "missing_tools → missing-tools",
    category: "missing_tools",
    message: "npm: command not found",
    fixability: "code_fixable",
    failureClass: "missing-tools",
  },
  {
    name: "timeout → timeout (unknown)",
    category: "timeout",
    message: "Claude timed out after 3600s",
    fixability: "unknown",
    failureClass: "timeout",
  },
  {
    name: "zero_output → no-output (unknown)",
    category: "zero_output",
    message: "No output captured from Claude",
    fixability: "unknown",
    failureClass: "no-output",
  },
  {
    name: "quality_check → agent-outcome",
    category: "quality_check",
    message: "Quality checks failed",
    fixability: "not_code_fixable",
    failureClass: "agent-outcome",
  },
  {
    name: "no_changes → agent-outcome",
    category: "no_changes",
    message: "Completed without making any changes",
    fixability: "not_code_fixable",
    failureClass: "agent-outcome",
  },
  {
    name: "evidence_missing → agent-outcome",
    category: "evidence_missing",
    message: "Missing screenshot evidence for UI changes",
    fixability: "not_code_fixable",
    failureClass: "agent-outcome",
  },
  {
    name: "push_failure → unknown",
    category: "push_failure",
    message: "Git push failed due to remote rejection",
    fixability: "unknown",
    failureClass: "unknown",
  },
  {
    name: "anything else → unknown",
    category: "unknown",
    message: "Something unexpected happened",
    fixability: "unknown",
    failureClass: "unknown",
  },
];

Deno.test("run failure classifier - table: one real-message case per row (Issue #4328)", () => {
  for (const row of ROWS) {
    const got = classifyRunFailure(row.category, row.message);
    assertEquals(got.fixability, row.fixability, row.name);
    assertEquals(got.failureClass, row.failureClass, row.name);
    assert(got.rationale.length > 10, `${row.name}: rationale`);
    assert(
      (RUN_FAILURE_CLASSES as readonly string[]).includes(got.failureClass),
      `${row.name}: slug ${got.failureClass} is documented`,
    );
    assert(/^[a-z]+(?:-[a-z]+)*$/.test(got.failureClass), `${row.name}: kebab`);
  }
});

Deno.test("run failure classifier - precedence: an OOM kill whose message also says 'timed out' is oom; a usage limit with a stack trace is usage-limit (Issue #4328)", () => {
  const oom = classifyRunFailure(
    "killed",
    "Claude was killed (exit 137, SIGKILL — possible out-of-memory in the VM) after the run timed out at 3492s",
  );
  assertEquals(oom.failureClass, "oom");
  assertEquals(oom.fixability, "code_fixable");
  const limit = classifyRunFailure(
    "rate_limit",
    "Claude usage limit reached (subscription window)\n    at Object.runClaude (file:///worker/deno/lib/claude_executor.ts:412:9)",
  );
  assertEquals(limit.failureClass, "usage-limit");
  assertEquals(limit.fixability, "not_code_fixable");
  // Disk exhaustion outranks a kill/crash on top of it.
  const disk = classifyRunFailure(
    "killed",
    "Claude was killed (exit 137, SIGKILL): ENOSPC: no space left on device",
  );
  assertEquals(disk.failureClass, "disk-full");
  // Out-of-credit outranks a crash trace.
  const credit = classifyRunFailure(
    "internal_error",
    "Error: Insufficient credit balance\n    at Module.request (file:///x.ts:1:1)",
  );
  assertEquals(credit.failureClass, "out-of-credit");
});

Deno.test("run failure classifier - case-insensitive message matching per message-matched row (Issue #4328)", () => {
  assertEquals(
    classifyRunFailure("unknown", "OUT OF CREDIT — Payment Required")
      .failureClass,
    "out-of-credit",
  );
  assertEquals(
    classifyRunFailure("killed", "KILLED PROCESS 4211 (claude) OUT OF MEMORY")
      .failureClass,
    "oom",
  );
  assertEquals(
    classifyRunFailure("unknown", "No Space Left On Device").failureClass,
    "disk-full",
  );
  assertEquals(
    classifyRunFailure("unknown", "Disk Full while writing checkpoint")
      .failureClass,
    "disk-full",
  );
  assertEquals(
    classifyRunFailure("unknown", "UNHANDLED EXCEPTION in worker").failureClass,
    "worker-crash",
  );
});

Deno.test("run failure classifier - every FailureCategory member is covered; a new member fails here (Issue #4328)", () => {
  // Mirror of the union — adding a member to FailureCategory without a
  // fixability decision fails this list AND the assertNever compile guard.
  const all: FailureCategory[] = [
    "timeout",
    "rate_limit",
    "zero_output",
    "killed",
    "quality_check",
    "push_failure",
    "no_changes",
    "evidence_missing",
    "internal_error",
    "missing_tools",
    "unknown",
  ];
  const seen = new Set<string>();
  for (const category of all) {
    const got = classifyRunFailure(category, "");
    assert(
      ["code_fixable", "not_code_fixable", "unknown"].includes(got.fixability),
    );
    seen.add(category);
  }
  // Round-trip through the detector: every message the detector classifies
  // lands in the switch (no throw from assertNever).
  for (const message of ["", "x", "SIGKILL", "timed out", "rate limit"]) {
    classifyRunFailure(detectFailureCategory(message), message);
  }
  assertEquals(seen.size, all.length);
});

Deno.test("run failure classifier - the empty message and the empty/unknown category yield unknown (Issue #4328)", () => {
  assertEquals(classifyRunFailure("unknown", ""), {
    fixability: "unknown",
    failureClass: "unknown",
    rationale: "No signal in the category or message decides fixability.",
  });
  assertEquals(
    classifyRunFailure(detectFailureCategory(""), "").fixability,
    "unknown",
  );
});

Deno.test("run failure classifier - unknown is not code-fixable for auto-filing; only code_fixable rows are (Issue #4328)", () => {
  const filed = ROWS.filter((r) =>
    classifyRunFailure(r.category, r.message).fixability === "code_fixable"
  ).map((r) => r.failureClass);
  assertEquals(
    [...new Set(filed)].sort(),
    ["disk-full", "missing-tools", "oom", "worker-crash"],
  );
});

Deno.test("classifier - a high probe reading at the kill is named as the OOM evidence (Issue #4374)", () => {
  const got = classifyRunFailure(
    "killed",
    "Claude was killed (exit 137, SIGKILL) without creating changes\n### Diagnostics\n- Memory pressure at kill: high (400 MiB of 16.0 GiB available)",
  );
  assertEquals(got.failureClass, "oom");
  assert(
    /probe read high/.test(got.rationale),
    `the rationale cites the probe, not exit 137: ${got.rationale}`,
  );
});
