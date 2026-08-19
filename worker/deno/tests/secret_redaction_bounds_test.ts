/**
 * Regression tests for the quadratic redaction rules (Issue #3942).
 *
 * `url-userinfo` matched an unanchored, unbounded greedy scheme
 * (`[a-z][a-z0-9+.-]*`), so every start position in an alphanumeric run
 * consumed the remainder and backtracked — 7.5 s on 128 KB of `a`.
 * `secret-cli-flag` had the same shape on a run of hyphens. `redactSecrets`
 * is a synchronous chokepoint on the worker's only thread and is applied to
 * untruncated, attacker-influenced model output, so either rule could stall
 * the fleet host for minutes.
 *
 * No input cap is applied to `redactSecrets` itself: SECURITY.md's
 * "redact before you truncate" standard requires redaction to see the whole
 * text, so dropping the tail would trade a stall for a secret leak. The
 * rules are made linear instead, and the tests below assert both that the
 * work is bounded and that a secret at the very end of a large input is
 * still masked.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

/** Time `redactSecrets(input)` and assert it stayed under `limitMs`. */
function assertBounded(label: string, input: string, limitMs = 1000): string {
  const started = performance.now();
  const out = redactSecrets(input);
  const elapsed = performance.now() - started;
  assert(
    elapsed < limitMs,
    `${label} took ${elapsed.toFixed(0)} ms (limit ${limitMs} ms) — the ` +
      "rule is still super-linear",
  );
  return out;
}

Deno.test("redactSecrets - a long alphanumeric run does not stall the url-userinfo rule", () => {
  // Pre-fix: 1.9 s at 64 Ki, 7.6 s at 128 Ki, growing quadratically.
  const out = assertBounded("128 KiB of 'a'", "a".repeat(131_072));
  assertEquals(out.length, 131_072, "benign text must pass through unchanged");
});

Deno.test("redactSecrets - a long hyphen run does not stall the secret-cli-flag rule", () => {
  // Pre-fix: 483 ms at 32 K hyphens, growing quadratically.
  const out = assertBounded("128 KiB of '-'", "-".repeat(131_072));
  assertEquals(out.length, 131_072);
});

Deno.test("redactSecrets - a prompt-injected 500 KB output is redacted promptly", () => {
  // The Issue #3942 exploit sketch: an injected model summary of ~500 KB of
  // alphanumerics reaching `publishableSnippet` before it is sliced.
  const secret = "https://user:s3cr3t-token@example.com/repo.git";
  const out = assertBounded(
    "500 KB injected output",
    "a".repeat(500_000) + " " + secret,
    2000,
  );
  assertEquals(
    out.includes("s3cr3t-token"),
    false,
    "a secret at the end of a large input must still be redacted",
  );
  assertStringIncludes(out, `https://user:${REDACTION_PLACEHOLDER}@`);
});

Deno.test("redactSecrets - a long sk- charset run stays bounded and is masked (Issue #36)", () => {
  // The `openai-key` quantifier carries an explicit ceiling, so an oversized
  // charset run is consumed in fixed-size bites instead of one open-ended
  // greedy sweep. The key material still goes.
  const run = "sk-" + "a".repeat(4096);
  const out = assertBounded("4 KiB sk- run", run);
  assert(
    out.includes(REDACTION_PLACEHOLDER),
    "a long sk- run must still be masked",
  );
});

Deno.test("redactSecrets - the google-api-key rule masks exactly the 39-character key (Issue #36)", () => {
  // Google keys are exactly 39 characters, so the rule masks that span and
  // leaves the surrounding text alone — an open-ended run would swallow the
  // trailing sentence too.
  const key = "AIzaSy" + "c".repeat(33);
  const out = assertBounded("AIzaSy key in prose", `key ${key} rejected`);
  assertEquals(out, `key ${REDACTION_PLACEHOLDER} rejected`);
});

Deno.test("redactSecrets - near-miss provider prefixes do not stall the new rules (Issue #36)", () => {
  const skNearMiss = ("sk-" + "a".repeat(19) + "!").repeat(5_000);
  assertEquals(
    assertBounded("115 KiB of near-miss sk- prefixes", skNearMiss),
    skNearMiss,
  );
  const aizaNearMiss = ("AIzaSy" + "b".repeat(32) + " ").repeat(3_000);
  assertEquals(
    assertBounded("117 KiB of near-miss AIzaSy prefixes", aizaNearMiss),
    aizaNearMiss,
  );
});

Deno.test("redactSecrets - url-userinfo still masks the credential for real schemes", () => {
  const cases: [string, string][] = [
    ["https://user:pw123@github.com/o/r.git", "https://user:"],
    ["git+ssh://bot:abc123@host/path", "git+ssh://bot:"],
    ["HTTPS://User:PW123@GitHub.com/", "HTTPS://User:"],
    ["postgres://admin:hunter2@db:5432/app", "postgres://admin:"],
  ];
  for (const [input, keptPrefix] of cases) {
    const out = redactSecrets(input);
    assertStringIncludes(out, `${keptPrefix}${REDACTION_PLACEHOLDER}@`);
  }
});

Deno.test("redactSecrets - url-userinfo masks a credential mid-sentence and after punctuation", () => {
  // The scheme is preceded by a non-scheme character, so tightening the
  // rule's start anchor must not lose these.
  for (
    const prefix of ["fatal: cloning ", "url=", "(", "_", "\t", "see <"]
  ) {
    const out = redactSecrets(`${prefix}https://u:tok3n@example.com/x`);
    assertEquals(
      out.includes("tok3n"),
      false,
      `credential survived after prefix ${JSON.stringify(prefix)}`,
    );
  }
});

Deno.test("redactSecrets - secret-cli-flag still masks a space-separated flag value", () => {
  const out = redactSecrets(
    "pr-manager --imgbb-api-key 0123abcd4567 --verbose",
  );
  assertEquals(out.includes("0123abcd4567"), false);
  assertStringIncludes(out, `--imgbb-api-key ${REDACTION_PLACEHOLDER}`);
  assertStringIncludes(out, "--verbose");
});
