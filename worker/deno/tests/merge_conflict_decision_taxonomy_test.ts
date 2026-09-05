/**
 * Tests for the merge-conflict decision taxonomy (Issue #1109).
 *
 * Issue #1076's symptom was "the label went on and then silence": a skipped
 * PR left either nothing behind or an unstructured log line, so a fleet that
 * had stalled and a fleet correctly waiting out a cooldown read the same. The
 * fix is a closed taxonomy — every exit yields exactly one reason, carrying
 * the operands that make the decision checkable afterwards.
 *
 * Two guards live here:
 *
 * 1. **Runtime** — every reason kind renders its own operands, and the pass
 *    summary counts them.
 * 2. **Compile-time** — an exit that returns no reason, and a reason with no
 *    case in the exhaustive switch, are both type errors. That is asserted by
 *    running the real type checker over fixtures, because it is the guard
 *    against the exact regression #1076 was: a new exit path added with no
 *    record, restoring the silence.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CONFLICT_SKIP_REASON_KINDS,
  conflictDecisionContext,
  type ConflictPrDecision,
  conflictReasonOperands,
  type ConflictSkipReason,
  type ConflictSkipReasonKind,
  isQueuedConflictReason,
  recordConflictDecision,
  recordConflictPassSummary,
  summariseConflictDecisions,
} from "../lib/pr_merge_conflict_scan.ts";
import type { LogContext, Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: "info" | "debug";
  message: string;
  context?: LogContext;
}

interface RecordingLogger extends Logger {
  entries: LogEntry[];
}

function makeRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const capture =
    (level: LogEntry["level"]) => (message: string, context?: LogContext) => {
      entries.push({ level, message, ...(context ? { context } : {}) });
    };
  const noop = () => {};
  return {
    entries,
    info: capture("info"),
    debug: capture("debug"),
    warn: noop,
    error: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** One sample per reason kind — the taxonomy, with realistic operands. */
const SAMPLES: Record<ConflictSkipReasonKind, ConflictSkipReason> = {
  "not-conflicting": { kind: "not-conflicting", mergeableState: "MERGEABLE" },
  "out-of-scope-author": { kind: "out-of-scope-author", author: "outsider" },
  "already-handled": { kind: "already-handled" },
  "scan-error": { kind: "scan-error", stage: "labels", message: "gh exploded" },
  "needs-human": { kind: "needs-human", label: "needs-human" },
  "budget-spent": { kind: "budget-spent", attemptsSpent: 2, maxAttempts: 2 },
  "cooldown": { kind: "cooldown", msUntilDue: 90_000 },
  "disrupted-bound": {
    kind: "disrupted-bound",
    disruptedCount: 3,
    maxDisruptedAttempts: 3,
  },
  "lock-held": { kind: "lock-held", lockHolder: "host-b" },
  "repo-leased": { kind: "repo-leased", deferralStreak: 2 },
  "deferred-bound": {
    kind: "deferred-bound",
    bound: "cap",
    deferralStreak: 3,
  },
  "queue-empty": { kind: "queue-empty" },
  "deadline": { kind: "deadline", remainingMs: 60_000 },
  "cap": { kind: "cap", maxPerCycle: 5 },
};

// ---------------------------------------------------------------------------
// The taxonomy at runtime
// ---------------------------------------------------------------------------

Deno.test("ConflictSkipReason - every kind has a sample and renders operands", () => {
  assertEquals(
    Object.keys(SAMPLES).sort(),
    [...CONFLICT_SKIP_REASON_KINDS].sort(),
    "a reason added to the union must be sampled here too",
  );

  for (const kind of CONFLICT_SKIP_REASON_KINDS) {
    // Drives every arm of the exhaustive switch: an arm that threw, or one
    // that fell through to the `never` guard, fails here.
    const operands = conflictReasonOperands(SAMPLES[kind]);
    assert(
      typeof operands === "object" && operands !== null,
      `${kind} rendered no operands object`,
    );
  }
});

Deno.test("conflictReasonOperands - each reason carries what makes it checkable", () => {
  assertEquals(conflictReasonOperands(SAMPLES["cooldown"]), {
    msUntilDue: 90_000,
  });
  assertEquals(conflictReasonOperands(SAMPLES["budget-spent"]), {
    attemptsSpent: 2,
    maxAttempts: 2,
  });
  assertEquals(conflictReasonOperands(SAMPLES["disrupted-bound"]), {
    disruptedCount: 3,
    maxDisruptedAttempts: 3,
  });
  assertEquals(conflictReasonOperands(SAMPLES["lock-held"]), {
    lockHolder: "host-b",
  });
  // Issue #1111: the streak is what separates "deferred once, fine" from
  // "deferred nine times" in the record.
  assertEquals(conflictReasonOperands(SAMPLES["repo-leased"]), {
    deferralStreak: 2,
  });
  assertEquals(conflictReasonOperands({ kind: "repo-leased" }), {});
  assertEquals(conflictReasonOperands(SAMPLES["deferred-bound"]), {
    bound: "cap",
    deferralStreak: 3,
  });
  assertEquals(
    conflictReasonOperands({
      kind: "cooldown",
      msUntilDue: 90_000,
      lastAttemptAt: "2026-09-05T00:00:00Z",
    }),
    { msUntilDue: 90_000, lastAttemptAt: "2026-09-05T00:00:00Z" },
  );
});

Deno.test("isQueuedConflictReason - separates the queue from what never entered it", () => {
  assertEquals(isQueuedConflictReason("not-conflicting"), false);
  assertEquals(isQueuedConflictReason("out-of-scope-author"), false);
  assertEquals(isQueuedConflictReason("queue-empty"), false);
  assertEquals(isQueuedConflictReason("cooldown"), true);
  assertEquals(isQueuedConflictReason("lock-held"), true);
  assertEquals(isQueuedConflictReason("repo-leased"), true);
  // Issue #1111: a PR the deadline or the cap left behind is a queued PR,
  // unlike the pass-level stop of the same name.
  assertEquals(isQueuedConflictReason("deferred-bound"), true);
  assertEquals(isQueuedConflictReason("deadline"), false);
  assertEquals(isQueuedConflictReason("cap"), false);
});

Deno.test("conflictDecisionContext - names the repository, the PR and the reason", () => {
  assertEquals(
    conflictDecisionContext({
      repo: "org/repo",
      prNumber: 48,
      outcome: "skipped",
      reason: SAMPLES["budget-spent"],
    }),
    {
      repo: "org/repo",
      prNumber: 48,
      decision: "skipped",
      reason: "budget-spent",
      attemptsSpent: 2,
      maxAttempts: 2,
    },
  );
  assertEquals(
    conflictDecisionContext({
      repo: "org/repo",
      prNumber: 48,
      outcome: "attempted",
    }),
    {
      repo: "org/repo",
      prNumber: 48,
      decision: "attempted",
      reason: "attempted",
    },
  );
});

Deno.test("recordConflictDecision - queue decisions are INFO, the rest DEBUG", () => {
  const logger = makeRecordingLogger();

  recordConflictDecision(logger, {
    repo: "org/repo",
    prNumber: 1,
    outcome: "skipped",
    reason: SAMPLES["cooldown"],
  });
  recordConflictDecision(logger, {
    repo: "org/repo",
    prNumber: 2,
    outcome: "skipped",
    reason: SAMPLES["not-conflicting"],
  });

  assertEquals(logger.entries[0]?.level, "info");
  assertStringIncludes(
    logger.entries[0]?.message ?? "",
    "merge_conflict_decision=cooldown repo=org/repo pr=1",
  );
  assertEquals(
    logger.entries[1]?.level,
    "debug",
    "a PR that was never in the queue must not cost an INFO line every cycle",
  );
});

Deno.test("summariseConflictDecisions - counts the labelled set and each reason", () => {
  const decisions: ConflictPrDecision[] = [
    { repo: "org/repo", prNumber: 1, outcome: "attempted" },
    {
      repo: "org/repo",
      prNumber: 2,
      outcome: "skipped",
      reason: SAMPLES["cooldown"],
    },
    {
      repo: "org/repo",
      prNumber: 3,
      outcome: "skipped",
      reason: SAMPLES["cooldown"],
    },
    {
      repo: "org/repo",
      prNumber: 4,
      outcome: "skipped",
      reason: SAMPLES["needs-human"],
    },
    {
      repo: "org/repo",
      prNumber: 5,
      outcome: "skipped",
      reason: SAMPLES["not-conflicting"],
    },
  ];

  assertEquals(summariseConflictDecisions(decisions), {
    considered: 5,
    labelled: 4,
    attempted: 1,
    byReason: { cooldown: 2, "needs-human": 1, "not-conflicting": 1 },
  });
});

Deno.test("recordConflictPassSummary - one summary line, counts and all", () => {
  const logger = makeRecordingLogger();

  recordConflictPassSummary(logger, "scan", [
    { repo: "org/repo", prNumber: 1, outcome: "attempted" },
    {
      repo: "org/repo",
      prNumber: 2,
      outcome: "skipped",
      reason: SAMPLES["cooldown"],
    },
  ], { stopReason: "queue-empty" });

  assertEquals(logger.entries.length, 1);
  assertEquals(logger.entries[0]?.level, "info");
  assertStringIncludes(
    logger.entries[0]?.message ?? "",
    "merge_conflict_pass=scan labelled=2 attempted=1 considered=2 cooldown=1",
  );
  assertEquals(logger.entries[0]?.context?.stopReason, "queue-empty");
});

Deno.test("recordConflictPassSummary - an empty queue stays at DEBUG", () => {
  const logger = makeRecordingLogger();
  recordConflictPassSummary(logger, "scan", []);
  assertEquals(logger.entries[0]?.level, "debug");
});

// ---------------------------------------------------------------------------
// The compile-time guard
//
// This is the earliest failure detection point for Issue #1109: a new exit
// added with no reason, or a new reason with no case, must not compile. The
// only honest way to assert that is to run the type checker.
// ---------------------------------------------------------------------------

/** The repo's own `deno check`, run over one fixture file. */
async function typeCheck(
  source: string,
): Promise<{ ok: boolean; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "conflict-taxonomy-" });
  try {
    const file = `${dir}/fixture.ts`;
    await Deno.writeTextFile(file, source);
    const command = new Deno.Command(Deno.execPath(), {
      args: ["check", file],
      // Run from the worker project so the fixture's import of the scan
      // module resolves exactly as it does in production.
      cwd: new URL("../", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    return {
      ok: result.success,
      out: new TextDecoder().decode(result.stderr) +
        new TextDecoder().decode(result.stdout),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const SCAN_MODULE = import.meta.resolve("../lib/pr_merge_conflict_scan.ts");

/** A fixture that decides and switches the way the scan does. */
function fixture(body: string): string {
  return `import type {
  ConflictScanPrOutcome,
  ConflictSkipReason,
} from "${SCAN_MODULE}";

${body}
`;
}

const WELL_FORMED = fixture(`export function decide(
  state: string,
): ConflictScanPrOutcome {
  if (state === "leased") {
    return { outcome: "skipped", reason: { kind: "repo-leased" } };
  }
  return { outcome: "skipped", reason: { kind: "queue-empty" } };
}

export function describe(reason: ConflictSkipReason): string {
  switch (reason.kind) {
    case "not-conflicting":
    case "out-of-scope-author":
    case "already-handled":
    case "scan-error":
    case "needs-human":
    case "budget-spent":
    case "cooldown":
    case "disrupted-bound":
    case "lock-held":
    case "repo-leased":
    case "deferred-bound":
    case "queue-empty":
    case "deadline":
    case "cap":
      return reason.kind;
  }
  const unhandled: never = reason;
  return String(unhandled);
}`);

const EXIT_WITH_NO_REASON = fixture(`export function decide(
  state: string,
): ConflictScanPrOutcome {
  // The #1076 regression, in one line: a new exit that records nothing.
  if (state === "brand-new-exit") return;
  return { outcome: "skipped", reason: { kind: "queue-empty" } };
}`);

const REASON_WITH_NO_CASE = fixture(`export function describe(
  reason: ConflictSkipReason,
): string {
  switch (reason.kind) {
    case "cooldown":
      return "cooldown";
  }
  const unhandled: never = reason;
  return String(unhandled);
}`);

Deno.test({
  name: "taxonomy compile gate - a well-formed decision type-checks",
  // The subprocess needs the type checker, not the sandbox seams.
  sanitizeResources: false,
  fn: async () => {
    const check = await typeCheck(WELL_FORMED);
    assert(
      check.ok,
      `the well-formed fixture must compile, so the failures below mean ` +
        `something: ${check.out}`,
    );
  },
});

Deno.test({
  name:
    "taxonomy compile gate - an exit that returns no reason fails to compile",
  sanitizeResources: false,
  fn: async () => {
    const check = await typeCheck(EXIT_WITH_NO_REASON);
    assert(check.ok === false, "an exit with no decision must not compile");
    assertStringIncludes(check.out, "ConflictScanPrOutcome");
  },
});

Deno.test({
  name: "taxonomy compile gate - a reason with no case fails to compile",
  sanitizeResources: false,
  fn: async () => {
    const check = await typeCheck(REASON_WITH_NO_CASE);
    assert(check.ok === false, "an unhandled reason must not compile");
    assertStringIncludes(check.out, "not assignable to type 'never'");
  },
});
