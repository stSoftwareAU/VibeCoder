/**
 * Tests for auto_fix_attempt_tracker.ts (Issues #3582, #1879).
 *
 * Covers the stable failure signature and the cap decision (the
 * consolidated hand-over summary went with the needs-human cap escalation,
 * Issue #4304). The persisted attempt counter and its
 * green-build reset are gone: the tally lives on the pull request as
 * fleet-authored markers (Issue #1879), so this module performs no I/O and
 * the tests here need no state directory.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  computeFailureSignature,
  consumesAutoFixAttempt,
  DEFAULT_MAX_AUTO_FIX_ATTEMPTS,
  hasReachedAutoFixCap,
  normaliseLogExcerpt,
  resolveMaxAutoFixAttempts,
} from "../lib/auto_fix_attempt_tracker.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const LOCUS = { kind: "pr" as const, number: 42 };

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

Deno.test("auto_fix_attempt_tracker - human-gate failures do not consume an attempt", () => {
  assertEquals(consumesAutoFixAttempt("human-gate"), false);
});

// ---------------------------------------------------------------------------
// Attempt budget
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
