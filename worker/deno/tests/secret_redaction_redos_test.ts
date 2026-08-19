/**
 * Regression tests for Issue #3942 — `redactSecrets` backtracked
 * quadratically on attacker-influenced text.
 *
 * Two rules were super-linear and unbounded:
 *   - `url-userinfo` (`[a-z][a-z0-9+.-]*` unanchored and greedy) — every
 *     start position in an alphanumeric run consumed the remainder looking
 *     for `://`. 65,536 `a`s cost ~1.9 s, 131,072 cost ~7.6 s.
 *   - `secret-cli-flag` (`--[A-Za-z0-9-]*`) — same shape on a run of
 *     hyphens, ~0.5 s at 32,000.
 *
 * `redactSecrets` runs synchronously on the worker's only thread, and
 * `handle_no_changes_phase.ts` feeds it the entire uncapped model stdout, so
 * a prompt-injected "end your summary with 500,000 a's" stalled the whole
 * fleet host inside one regex.
 *
 * These tests assert both rules are now linear and that real URL credentials
 * and secret flags are still masked. The input itself is deliberately never
 * truncated — `SECURITY.md` requires redaction before truncation, so a scan
 * cap would leave the tail unmasked — which is why the defence measured here
 * is the patterns' linearity, not an input bound.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

/**
 * Hostile input size. Pre-fix this length cost ~7.6 s in `url-userinfo`;
 * post-fix it is single-digit milliseconds.
 */
const HOSTILE_CHARS = 131_072;

/**
 * Wall-clock budget for one redaction. Loose on purpose — this is a
 * super-linearity detector, not a performance measurement.
 */
const BUDGET_MS = 2_000;

/** Milliseconds `fn` took to run. */
function elapsedMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

Deno.test("redactSecrets - a long alphanumeric run is linear (url-userinfo, Issue #3942)", () => {
  const hostile = "a".repeat(HOSTILE_CHARS);
  let out = "";
  const took = elapsedMs(() => {
    out = redactSecrets(hostile);
  });
  assertEquals(out, hostile, "ordinary text must pass through unchanged");
  assert(
    took < BUDGET_MS,
    `alphanumeric run took ${took.toFixed(0)} ms (budget ${BUDGET_MS} ms)`,
  );
});

Deno.test("redactSecrets - a long hyphen run is linear (secret-cli-flag, Issue #3942)", () => {
  const hostile = "-".repeat(HOSTILE_CHARS);
  let out = "";
  const took = elapsedMs(() => {
    out = redactSecrets(hostile);
  });
  assertEquals(out, hostile);
  assert(
    took < BUDGET_MS,
    `hyphen run took ${took.toFixed(0)} ms (budget ${BUDGET_MS} ms)`,
  );
});

Deno.test("redactSecrets - a mixed hostile blob is linear (Issue #3942)", () => {
  // Scheme-ish characters interleaved so the lookbehind cannot short-circuit
  // every start position.
  const hostile = "a.b-c+".repeat(HOSTILE_CHARS / 6);
  const took = elapsedMs(() => {
    redactSecrets(hostile);
  });
  assert(
    took < BUDGET_MS,
    `mixed blob took ${took.toFixed(0)} ms (budget ${BUDGET_MS} ms)`,
  );
});

Deno.test("redactSecrets - a huge input is scanned whole, tail included (Issue #3942)", () => {
  // The input is never truncated: redaction runs before truncation, so a
  // credential past any notional cap must still be masked.
  const secretTail = "\nclone https://nigel:ghp_x@github.com/org/repo.git";
  const oversized = "a".repeat(HOSTILE_CHARS) + secretTail;

  let out = "";
  const took = elapsedMs(() => {
    out = redactSecrets(oversized);
  });

  assert(
    took < BUDGET_MS,
    `oversized input took ${took.toFixed(0)} ms (budget ${BUDGET_MS} ms)`,
  );
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
  assert(
    !out.includes("ghp_x"),
    "a credential in the tail must still be masked",
  );
  // Nothing is dropped — the non-secret prefix survives in full.
  assert(
    out.length > HOSTILE_CHARS,
    `output was truncated to ${out.length} characters`,
  );
});

Deno.test("redactSecrets - URL credentials are still masked after the anchoring fix (Issue #3942)", () => {
  const cases = [
    "https://nigel:ghp_secretvalue@github.com/org/repo.git",
    "GIT_URL=https://nigel:s3cret@github.com/org/repo.git",
    "git+ssh://nigel:s3cret@github.com/org/repo.git",
    "cloning postgresql://app:hunter2@db.internal:5432/app now",
    "(https://nigel:s3cret@example.com)",
    '"https://nigel:s3cret@example.com"',
  ];
  for (const text of cases) {
    const out = redactSecrets(text);
    assertStringIncludes(out, REDACTION_PLACEHOLDER, `not masked: ${text}`);
    assert(!out.includes("s3cret"), `password survived: ${text}`);
    assert(
      !out.includes("ghp_secretvalue"),
      `token survived: ${text}`,
    );
    assert(!out.includes("hunter2"), `password survived: ${text}`);
  }
  // The scheme, username and host stay readable.
  assertEquals(
    redactSecrets("https://nigel:s3cret@github.com/org/repo.git"),
    `https://nigel:${REDACTION_PLACEHOLDER}@github.com/org/repo.git`,
  );
});

Deno.test("redactSecrets - secret CLI flags are still masked after the bound (Issue #3942)", () => {
  assertEquals(
    redactSecrets("pr-manager --imgbb-api-key 0123abcd4567 --verbose"),
    `pr-manager --imgbb-api-key ${REDACTION_PLACEHOLDER} --verbose`,
  );
  assertEquals(
    redactSecrets("gh auth login --with-token ghp_aaaaaaaaaaaa"),
    `gh auth login --with-token ${REDACTION_PLACEHOLDER}`,
  );
  // An adjacent flag is not mistaken for a secret.
  assertEquals(
    redactSecrets("cmd --token --verbose"),
    "cmd --token --verbose",
  );
});
