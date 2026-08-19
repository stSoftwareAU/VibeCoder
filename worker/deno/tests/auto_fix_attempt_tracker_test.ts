/**
 * Tests for auto_fix_attempt_tracker.ts (Issue #3582).
 *
 * Covers the stable failure signature, the persisted attempt counter,
 * the cap decision, the consolidated escalation summary, and the
 * green-build reset.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type AutoFixAttempt,
  buildAutoFixCapSummary,
  clearAutoFixAttempts,
  clearAutoFixAttemptsForLocus,
  computeFailureSignature,
  consumesAutoFixAttempt,
  DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
  getAutoFixAttempts,
  hasReachedAutoFixCap,
  normaliseLogExcerpt,
  recordAutoFixAttempt,
  resolveMaxAutoFixAttempts,
} from "../lib/auto_fix_attempt_tracker.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const LOCUS = { kind: "pr" as const, number: 42 };

function attempt(overrides: Partial<AutoFixAttempt> = {}): AutoFixAttempt {
  return {
    repo: "owner/repo",
    locus: LOCUS,
    checkName: "build",
    diagnosis: "compilation error in Foo.java",
    change: "added the missing import",
    outcome: "pushed a fix; build still red",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normaliseLogExcerpt
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - normalisation strips timestamps, build numbers and paths", () => {
  const workspaceRoot = "/home/runner/work/repo/repo";
  const first = normaliseLogExcerpt(
    "2026-07-29T10:11:12.345Z [build 4471] /home/runner/work/repo/repo/src/Foo.java:12: error: cannot find symbol (0x7ffd1a2b)",
    workspaceRoot,
  );
  const second = normaliseLogExcerpt(
    "2026-07-30T23:59:01.001Z [build 4472] /home/runner/work/repo/repo/src/Foo.java:12: error: cannot find symbol (0x00ab12cd)",
    workspaceRoot,
  );

  assertEquals(first, second);
  // The durable part survives normalisation.
  assert(first.includes("cannot find symbol"));
  assert(first.includes("src/foo.java"));
});

Deno.test("auto_fix_attempt_tracker - normalisation keeps genuinely different messages distinct", () => {
  const a = normaliseLogExcerpt("error: cannot find symbol Foo");
  const b = normaliseLogExcerpt("error: cannot find symbol Bar");
  assertNotEquals(a, b);
});

// ---------------------------------------------------------------------------
// computeFailureSignature
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - signature is stable across attempts on the same failure", () => {
  const base = {
    repo: "owner/repo",
    locus: LOCUS,
    checkName: "build",
    workspaceRoot: "/work/repo",
  };
  const first = computeFailureSignature({
    ...base,
    logExcerpt:
      "2026-07-29T10:00:00Z build #101 /work/repo/src/A.ts:3 error: type mismatch",
  });
  const second = computeFailureSignature({
    ...base,
    logExcerpt:
      "2026-07-30T11:22:33Z build #102 /work/repo/src/A.ts:3 error: type mismatch",
  });

  assertEquals(first, second);
});

Deno.test("auto_fix_attempt_tracker - a different failure on the same PR gets a different signature", () => {
  const base = { repo: "owner/repo", locus: LOCUS, checkName: "build" };
  const compileFailure = computeFailureSignature({
    ...base,
    logExcerpt: "error: cannot find symbol Foo",
  });
  const testFailure = computeFailureSignature({
    ...base,
    logExcerpt: "error: assertion failed — expected 3 but got 4",
  });

  assertNotEquals(compileFailure, testFailure);
});

Deno.test("auto_fix_attempt_tracker - signature separates repos, loci and check names", () => {
  const base = {
    repo: "owner/repo",
    locus: LOCUS,
    checkName: "build",
    logExcerpt: "error: boom",
  };
  const reference = computeFailureSignature(base);

  assertNotEquals(
    reference,
    computeFailureSignature({ ...base, repo: "owner/other" }),
  );
  assertNotEquals(
    reference,
    computeFailureSignature({ ...base, locus: { kind: "pr", number: 43 } }),
  );
  assertNotEquals(
    reference,
    computeFailureSignature({ ...base, locus: { kind: "issue", number: 42 } }),
  );
  assertNotEquals(
    reference,
    computeFailureSignature({ ...base, checkName: "lint" }),
  );
});

Deno.test("auto_fix_attempt_tracker - signature is filename-safe", () => {
  const signature = computeFailureSignature({
    repo: "owner/repo",
    locus: LOCUS,
    checkName: "build / compile (jdk 21)",
    logExcerpt: "error: boom",
  });
  assert(/^[a-z0-9_-]+$/.test(signature), `unsafe signature: ${signature}`);
});

// ---------------------------------------------------------------------------
// Attempt counter persistence
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - three pushes on one failure reach attempt 3", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    // Three distinct fix commits produce three new check-run ids, but the
    // log excerpt describes the same underlying failure each time.
    const excerpts = [
      "2026-07-29T01:00:00Z build #1 error: cannot find symbol Foo",
      "2026-07-29T02:00:00Z build #2 error: cannot find symbol Foo",
      "2026-07-29T03:00:00Z build #3 error: cannot find symbol Foo",
    ];
    const counts: number[] = [];
    const signatures = new Set<string>();

    for (const excerpt of excerpts) {
      const signature = computeFailureSignature({
        repo: "owner/repo",
        locus: LOCUS,
        checkName: "build",
        logExcerpt: excerpt,
      });
      signatures.add(signature);
      counts.push(await recordAutoFixAttempt(stateDir, signature, attempt()));
    }

    assertEquals(signatures.size, 1);
    assertEquals(counts, [1, 2, 3]);

    const [signature] = [...signatures];
    const attempts = await getAutoFixAttempts(stateDir, signature!);
    assertEquals(attempts.length, 3);
    assertEquals(attempts[0]?.attempt, 1);
    assertEquals(attempts[2]?.attempt, 3);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("auto_fix_attempt_tracker - a different failure on the same PR keeps its own counter", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const first = computeFailureSignature({
      repo: "owner/repo",
      locus: LOCUS,
      checkName: "build",
      logExcerpt: "error: cannot find symbol Foo",
    });
    const second = computeFailureSignature({
      repo: "owner/repo",
      locus: LOCUS,
      checkName: "build",
      logExcerpt: "error: assertion failed",
    });

    await recordAutoFixAttempt(stateDir, first, attempt());
    await recordAutoFixAttempt(stateDir, first, attempt());
    const secondCount = await recordAutoFixAttempt(
      stateDir,
      second,
      attempt({ diagnosis: "failing test" }),
    );

    assertEquals(secondCount, 1);
    assertEquals((await getAutoFixAttempts(stateDir, first)).length, 2);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("auto_fix_attempt_tracker - getAutoFixAttempts returns empty for an unknown signature", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    assertEquals(await getAutoFixAttempts(stateDir, "nosuchsignature"), []);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("auto_fix_attempt_tracker - corrupt state file is discarded, not fatal", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const signature = computeFailureSignature({
      repo: "owner/repo",
      locus: LOCUS,
      checkName: "build",
      logExcerpt: "error: boom",
    });
    await recordAutoFixAttempt(stateDir, signature, attempt());
    await Deno.writeTextFile(
      `${stateDir}/${signature}.autofix.json`,
      "{not json",
    );

    assertEquals(await getAutoFixAttempts(stateDir, signature), []);
    assertEquals(await recordAutoFixAttempt(stateDir, signature, attempt()), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Cap decision
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - cap binds at the configured maximum", () => {
  assertEquals(hasReachedAutoFixCap(2, 3), false);
  assertEquals(hasReachedAutoFixCap(3, 3), true);
  assertEquals(hasReachedAutoFixCap(4, 3), true);
});

Deno.test("auto_fix_attempt_tracker - infrastructure failures do not consume an attempt", () => {
  assertEquals(consumesAutoFixAttempt("infrastructure"), false);
  assertEquals(consumesAutoFixAttempt("code-fix-required"), true);
  assertEquals(consumesAutoFixAttempt("timing"), true);
  assertEquals(consumesAutoFixAttempt("unknown"), true);
});

// ---------------------------------------------------------------------------
// Green reset
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - a green result clears the counter", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const signature = computeFailureSignature({
      repo: "owner/repo",
      locus: LOCUS,
      checkName: "build",
      logExcerpt: "error: boom",
    });
    await recordAutoFixAttempt(stateDir, signature, attempt());
    await recordAutoFixAttempt(stateDir, signature, attempt());

    await clearAutoFixAttempts(stateDir, signature);

    assertEquals(await getAutoFixAttempts(stateDir, signature), []);
    // Budget is fresh again, not inherited.
    assertEquals(await recordAutoFixAttempt(stateDir, signature, attempt()), 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("auto_fix_attempt_tracker - clearing a green locus leaves other loci untouched", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    const greenPr = computeFailureSignature({
      repo: "owner/repo",
      locus: LOCUS,
      checkName: "build",
      logExcerpt: "error: boom",
    });
    const otherPr = computeFailureSignature({
      repo: "owner/repo",
      locus: { kind: "pr", number: 99 },
      checkName: "build",
      logExcerpt: "error: boom",
    });
    await recordAutoFixAttempt(stateDir, greenPr, attempt());
    await recordAutoFixAttempt(
      stateDir,
      otherPr,
      attempt({ locus: { kind: "pr", number: 99 } }),
    );

    const cleared = await clearAutoFixAttemptsForLocus(
      stateDir,
      "owner/repo",
      LOCUS,
    );

    assertEquals(cleared, 1);
    assertEquals(await getAutoFixAttempts(stateDir, greenPr), []);
    assertEquals((await getAutoFixAttempts(stateDir, otherPr)).length, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("auto_fix_attempt_tracker - clearing a locus in a missing state dir is a no-op", async () => {
  const cleared = await clearAutoFixAttemptsForLocus(
    "/tmp/vibe-no-such-state-dir-3582",
    "owner/repo",
    LOCUS,
  );
  assertEquals(cleared, 0);
});

// ---------------------------------------------------------------------------
// Consolidated summary
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - summary covers every attempt in one comment", () => {
  const attempts: AutoFixAttempt[] = [
    attempt({
      attempt: 1,
      diagnosis: "missing import",
      change: "added import",
      outcome: "still red",
    }),
    attempt({
      attempt: 2,
      diagnosis: "wrong package",
      change: "renamed package",
      outcome: "still red",
    }),
    attempt({
      attempt: 3,
      diagnosis: "API removed upstream",
      change: "reverted call site",
      outcome: "still red",
    }),
  ];

  const summary = buildAutoFixCapSummary({
    checkName: "build",
    signature: "abc123",
    maxAttempts: 3,
    attempts,
  });

  assert(summary.includes("3 automatic fix attempts"));
  for (const a of attempts) {
    assert(summary.includes(a.diagnosis), `missing diagnosis: ${a.diagnosis}`);
    assert(summary.includes(a.change), `missing change: ${a.change}`);
  }
  assert(summary.includes("abc123"));
  assert(summary.includes("build"));
});

Deno.test("auto_fix_attempt_tracker - summary tolerates missing attempt detail", () => {
  const summary = buildAutoFixCapSummary({
    checkName: "build",
    signature: "abc123",
    maxAttempts: 3,
    attempts: [],
  });
  assert(summary.includes("build"));
  assert(summary.toLowerCase().includes("no attempt detail"));
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

Deno.test("auto_fix_attempt_tracker - maxAutoFixAttempts defaults to 3", () => {
  const config = buildDefaultWorkerConfig();
  assertEquals(config.maxAutoFixAttempts, DEFAULT_MAX_AUTO_FIX_ATTEMPTS);
  assertEquals(resolveMaxAutoFixAttempts(config, "owner/repo"), 3);
});

Deno.test("auto_fix_attempt_tracker - global and per-repo overrides are honoured", () => {
  const config = buildDefaultWorkerConfig({
    maxAutoFixAttempts: 5,
    repoConfig: {
      "owner/strict": { maxAutoFixAttempts: 1 },
      "owner/bad": { maxAutoFixAttempts: 0 },
    },
  });

  assertEquals(resolveMaxAutoFixAttempts(config, "owner/other"), 5);
  assertEquals(resolveMaxAutoFixAttempts(config, "owner/strict"), 1);
  // Non-positive per-repo values are guarded back to the global setting.
  assertEquals(resolveMaxAutoFixAttempts(config, "owner/bad"), 5);
});
