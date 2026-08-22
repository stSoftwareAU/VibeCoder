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
  splitAgentNarration,
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

// Issue #108 — an interrupted run is transient infrastructure, never auto-filed.
Deno.test("classifyRunFailure - interrupted is not_code_fixable and classed 'interrupted'", () => {
  const c = classifyRunFailure(
    "interrupted",
    "Run interrupted before completing — the agent was still working",
  );
  assertEquals(c.fixability, "not_code_fixable");
  assertEquals(c.failureClass, "interrupted");
  assert(RUN_FAILURE_CLASSES.includes("interrupted"));
});

// ===========================================================================
// Issue #249 — agent narration is not worker crash evidence
// ===========================================================================

/**
 * The message that filed Issue #249, reproduced from the issue body.
 *
 * A clean deadline stop on GRQ#4204: category `timeout`, exit 143 (SIGTERM),
 * two WIP checkpoints pushed. The only thing resembling a crash is inside the
 * quoted agent output, where Claude is describing a concurrency bug in the
 * *user's* code it was in the middle of fixing.
 */
const ISSUE_249_MESSAGE = [
  "Claude timed out at the cycle deadline with its work preserved on the " +
  "branch — WIP preserved: 2 checkpoint commits pushed to " +
  "'issue-4204-fix-the-1h55m-pre-scoring-load-the-daily-history-r' — the " +
  "next claim resumes from that branch (Issue #4170)",
  "",
  "### Diagnostics",
  "- Elapsed: 2932s",
  "- Output: partial (2459 characters captured before timeout)",
  "- Timeout: 2924s",
  "- Watchdog: hard-timeout",
  "- Raw exit code: 143 (SIGTERM)",
  "- Clarity: assessed as clear",
  "",
  "<details>",
  "<summary>Last output from Claude (click to expand)</summary>",
  "",
  "```",
  " running (that ✅ was a sub-stage). Let me review the final diff while it " +
  "finishes.One correctness gap in the concurrency driver: on a failure the " +
  "remaining workers keep pulling, so a second failure surfaces as an " +
  "unhandled rejection. Tightening it to stop dispatch and re-throw.Let me " +
  "add a test pinning that dispatch actually stops, then re-run the History " +
  "suite.Let me commit this refinement while the gate finishes.The gate is " +
  "cloning the share-price data repo (`worker/repos.sh`). Waiting it out.",
  "```",
  "",
  "</details>",
].join("\n");

Deno.test("classify #249 - a deadline timeout is not a worker crash because Claude said 'unhandled rejection'", () => {
  const result = classifyRunFailure("timeout", ISSUE_249_MESSAGE);
  assertEquals(
    result.failureClass,
    "timeout",
    "the run stopped cleanly at its deadline with WIP preserved; the only " +
      "'unhandled rejection' is Claude describing the user's code",
  );
  assertEquals(result.fixability, "unknown");
});

Deno.test("classify #249 - the same prose in the worker's own words IS a crash", () => {
  // The fix must not blind the classifier: outside the quoted agent block
  // the identical phrase is exactly the signal it was written to catch.
  const result = classifyRunFailure(
    "timeout",
    "Claude timed out after 3600s\nunhandled rejection in the worker loop",
  );
  assertEquals(result.failureClass, "worker-crash");
  assertEquals(result.fixability, "code_fixable");
});

Deno.test("classify #249 - a real stack frame inside the agent block still counts", () => {
  // A Claude CLI crash dump reaches us through the agent's stdout. A frame
  // naming a function and a file:// URL is a crash, not prose about one.
  const message = [
    "Claude exited unexpectedly",
    "",
    "<details>",
    "<summary>Last output from Claude (click to expand)</summary>",
    "",
    "```",
    "TypeError: Cannot read properties of undefined (reading 'value')",
    "    at Object.run (file:///usr/lib/claude/cli.js:120:9)",
    "```",
    "",
    "</details>",
  ].join("\n");
  assertEquals(
    classifyRunFailure("unknown", message).failureClass,
    "worker-crash",
  );
});

Deno.test("classify #249 - prose alone inside the agent block never reaches worker-crash", () => {
  for (
    const prose of [
      "so a second failure surfaces as an unhandled rejection",
      "this throws a TypeError: bad input, which we should catch",
      "the old code raised a ReferenceError: x is not defined",
      "I will add an unhandled exception handler around the pool",
    ]
  ) {
    const message = [
      "Claude timed out after 2924s",
      "<details>",
      "<summary>Last output from Claude (click to expand)</summary>",
      "",
      "```",
      prose,
      "```",
      "",
      "</details>",
    ].join("\n");
    assertEquals(
      classifyRunFailure("timeout", message).failureClass,
      "timeout",
      `agent prose must not classify as a crash: ${prose}`,
    );
  }
});

Deno.test("classify #249 - the 'Processes at the kill' block stays worker evidence", () => {
  // The sibling <details> block is written by the worker, not the agent —
  // the narration strip must not swallow it.
  const message = [
    "Claude was killed",
    "<details>",
    "<summary>Last output from Claude (click to expand)</summary>",
    "",
    "```",
    "just tidying up the imports now",
    "```",
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Processes at the kill (click to expand)</summary>",
    "",
    "```",
    "unhandled exception in the supervisor",
    "```",
    "",
    "</details>",
  ].join("\n");
  assertEquals(
    classifyRunFailure("unknown", message).failureClass,
    "worker-crash",
  );
});

Deno.test("splitAgentNarration - removes the agent block and keeps everything else", () => {
  const { worker, agent } = splitAgentNarration(ISSUE_249_MESSAGE);
  assert(worker.includes("Raw exit code: 143"), "diagnostics are worker text");
  assert(worker.includes("WIP preserved"), "the summary line is worker text");
  assert(
    !worker.includes("unhandled rejection"),
    "the agent's prose is not worker text",
  );
  assert(agent.includes("unhandled rejection"), "and it is captured, not lost");
});

Deno.test("splitAgentNarration - a message with no agent block is unchanged", () => {
  const { worker, agent } = splitAgentNarration("Claude timed out after 60s");
  assertEquals(worker, "Claude timed out after 60s");
  assertEquals(agent, "");
});

Deno.test("classify #249 - disk exhaustion in the agent block is still real evidence", () => {
  // The deliberate asymmetry: ENOSPC reaching us through the agent's stdout
  // means the run genuinely hit a full disk. That is environmental evidence
  // the worker can act on, unlike a mention of an exception.
  const message = [
    "Claude timed out after 2924s",
    "<details>",
    "<summary>Last output from Claude (click to expand)</summary>",
    "",
    "```",
    "Error: ENOSPC: no space left on device, write",
    "```",
    "",
    "</details>",
  ].join("\n");
  assertEquals(
    classifyRunFailure("timeout", message).failureClass,
    "disk-full",
  );
});
