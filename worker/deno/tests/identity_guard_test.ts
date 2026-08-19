/**
 * Tests for the worker identity guard (Issue #3528).
 *
 * A regression let a worker host whose `gh` auth had drifted to a human
 * personal token perform milestone-completion writes as that human account.
 * The guard evaluates the resolved login against a config-driven allowlist of
 * service accounts and fails loud on a mismatch.
 *
 * Uses Australian English throughout (behaviour, authorised, defence).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertWorkerIdentity,
  evaluateWorkerIdentity,
  IdentityGuardError,
  normaliseLogin,
} from "../lib/identity_guard.ts";

// ============================================================================
// normaliseLogin
// ============================================================================

Deno.test("normaliseLogin - trims and lowercases", () => {
  assertEquals(normaliseLogin("  VibeCoderBot "), "VibeCoderBot");
  assertEquals(normaliseLogin("stsvcbot"), "stsvcbot");
});

// ============================================================================
// evaluateWorkerIdentity — happy path
// ============================================================================

Deno.test("evaluateWorkerIdentity - permits an allowed service account", () => {
  const result = evaluateWorkerIdentity(
    "stsvcbot",
    ["stsvcbot", "VibeCoderBot"],
    "host-a",
  );
  assertEquals(result.permitted, true);
  assertEquals(result.enforced, true);
  assertEquals(result.actual, "stsvcbot");
  assertStringIncludes(result.message, "identity OK");
});

Deno.test("evaluateWorkerIdentity - login match is case-insensitive", () => {
  const result = evaluateWorkerIdentity(
    "VibeCoderBot",
    ["stsvcbot", "VibeCoderBot"],
    "host-a",
  );
  assertEquals(result.permitted, true);
});

Deno.test("evaluateWorkerIdentity - trims surrounding whitespace on the login", () => {
  const result = evaluateWorkerIdentity(
    "  stsvcbot\n",
    ["stsvcbot"],
    "host-a",
  );
  assertEquals(result.permitted, true);
  assertEquals(result.actual, "stsvcbot");
});

// ============================================================================
// evaluateWorkerIdentity — mismatch (the regression)
// ============================================================================

Deno.test("evaluateWorkerIdentity - refuses a human account not on the allowlist", () => {
  const result = evaluateWorkerIdentity(
    "maintainer",
    ["stsvcbot", "VibeCoderBot"],
    "host-drifted",
  );
  assertEquals(result.permitted, false);
  assertEquals(result.enforced, true);
  // Fail-loud message names host, actual, and expected so the host self-identifies.
  assertStringIncludes(result.message, "MISMATCH");
  assertStringIncludes(result.message, "host-drifted");
  assertStringIncludes(result.message, "maintainer");
  assertStringIncludes(result.message, "stsvcbot");
});

Deno.test("evaluateWorkerIdentity - refuses when the login cannot be resolved", () => {
  const result = evaluateWorkerIdentity("", ["stsvcbot"], "host-a");
  assertEquals(result.permitted, false);
  assertEquals(result.enforced, true);
  assertStringIncludes(result.message, "could not");
});

// ============================================================================
// evaluateWorkerIdentity — inactive allowlist (never fail silently)
// ============================================================================

Deno.test("evaluateWorkerIdentity - empty allowlist warns loudly but permits", () => {
  const result = evaluateWorkerIdentity("anyone", [], "host-a");
  assertEquals(result.permitted, true);
  assertEquals(result.enforced, false);
  assertStringIncludes(result.message, "INACTIVE");
  assertStringIncludes(result.message, "service_accounts");
});

Deno.test("evaluateWorkerIdentity - whitespace-only allowlist entries are ignored", () => {
  const result = evaluateWorkerIdentity("maintainer", ["  ", ""], "host-a");
  // All entries blank → treated as no allowlist → inactive, not a mismatch.
  assertEquals(result.enforced, false);
  assertEquals(result.permitted, true);
});

// ============================================================================
// evaluateWorkerIdentity — setup-defaulted allowlist (Issue #4030)
// ============================================================================

Deno.test("evaluateWorkerIdentity - a setup-defaulted one-entry allowlist enforces", () => {
  // Setup writes `service_accounts: [<resolved worker login>]` when the
  // operator supplies nothing, so the guard is active from the first run.
  const result = evaluateWorkerIdentity(
    "VibeCoderBot",
    ["VibeCoderBot"],
    "host-3",
  );
  assertEquals(result.permitted, true);
  assertEquals(result.enforced, true);
});

Deno.test("evaluateWorkerIdentity - drift away from a setup-defaulted allowlist is refused", () => {
  // The host-3 drift (#4028): the host authenticated as a second service
  // account that is not on the allowlist. A one-entry allowlist catches it.
  const result = evaluateWorkerIdentity("VibeCoderBot", ["stsvcbot"], "host-3");
  assertEquals(result.permitted, false);
  assertEquals(result.enforced, true);
  assertStringIncludes(result.message, "MISMATCH");
});

Deno.test("evaluateWorkerIdentity - falls back to a host sentinel when hostname is blank", () => {
  const result = evaluateWorkerIdentity("maintainer", ["stsvcbot"], "   ");
  assertStringIncludes(result.message, "unknown-host");
});

// ============================================================================
// assertWorkerIdentity — fail-loud wrapper
// ============================================================================

Deno.test("assertWorkerIdentity - throws IdentityGuardError on mismatch and logs error", () => {
  const errors: string[] = [];
  const infos: string[] = [];
  const err = assertThrows(
    () =>
      assertWorkerIdentity("maintainer", ["stsvcbot"], {
        hostname: () => "host-drifted",
        log: (m) => infos.push(m),
        logError: (m) => errors.push(m),
      }),
    IdentityGuardError,
    "MISMATCH",
  ) as IdentityGuardError;

  // The fault was logged loudly via logError, not swallowed.
  assertEquals(errors.length, 1);
  assertStringIncludes(errors.join(""), "host-drifted");
  assertEquals(infos.length, 0);
  // The evaluation is carried on the error for inspection.
  assertEquals(err.evaluation.permitted, false);
  assertEquals(err.evaluation.actual, "maintainer");
});

Deno.test("assertWorkerIdentity - returns evaluation and logs confirmation on match", () => {
  const infos: string[] = [];
  const result = assertWorkerIdentity("stsvcbot", ["stsvcbot"], {
    hostname: () => "host-a",
    log: (m) => infos.push(m),
    logError: () => {},
  });
  assertEquals(result.permitted, true);
  assertEquals(infos.length, 1);
  assertStringIncludes(infos.join(""), "identity OK");
});

Deno.test("assertWorkerIdentity - inactive allowlist logs a loud warning and does not throw", () => {
  const infos: string[] = [];
  const result = assertWorkerIdentity("anyone", [], {
    hostname: () => "host-a",
    log: (m) => infos.push(m),
    logError: () => {},
  });
  assertEquals(result.permitted, true);
  assertEquals(result.enforced, false);
  assertEquals(infos.length, 1);
  assertStringIncludes(infos.join(""), "INACTIVE");
});

Deno.test("assertWorkerIdentity - unresolved login under an active allowlist throws", () => {
  assertThrows(
    () =>
      assertWorkerIdentity("", ["stsvcbot"], {
        hostname: () => "host-a",
        log: () => {},
        logError: () => {},
      }),
    IdentityGuardError,
  );
});
