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
 * The bound is asserted on the **shape** of the growth, not on a wall clock
 * (Issue #530): each hostile shape is redacted at one size and at four times
 * that size, and the larger run may cost up to twice the proportional time.
 * A slower fleet host inflates both readings equally and stays green, while a
 * super-linear rule costs sixteen times the base and still fails loudly. The
 * previous absolute 2000 ms bound failed the suite on a host 8% slower than
 * the one it was chosen on, reporting a performance signal as a correctness
 * error.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import { assertLinearGrowth } from "./support/growth.ts";

/** Base input size for the growth checks; the scaled run uses four times it. */
const BASE_CHARS = 16_384;

/** Size multiple between the two measured runs. */
const SIZE_FACTOR = 4;

/**
 * Redact `build(BASE_CHARS)` and `build(BASE_CHARS * SIZE_FACTOR)`, assert the
 * cost grew no faster than the input did, and return the larger run's output
 * so correctness can be asserted on it too.
 */
function assertRedactionLinear(
  label: string,
  build: (chars: number) => string,
): string {
  return assertLinearGrowth(label, build, redactSecrets, {
    baseChars: BASE_CHARS,
    sizeFactor: SIZE_FACTOR,
    repeats: 2,
  });
}

/** The scaled-size input a builder produces, for output comparisons. */
function scaledInput(build: (chars: number) => string): string {
  return build(BASE_CHARS * SIZE_FACTOR);
}

Deno.test("redactSecrets - a long alphanumeric run does not stall the url-userinfo rule", () => {
  // Pre-fix: 1.9 s at 64 Ki, 7.6 s at 128 Ki, growing quadratically.
  const build = (chars: number) => "a".repeat(chars);
  const out = assertRedactionLinear("alphanumeric run", build);
  assertEquals(out, scaledInput(build), "benign text must pass through");
});

Deno.test("redactSecrets - a long hyphen run does not stall the secret-cli-flag rule", () => {
  // Pre-fix: 483 ms at 32 K hyphens, growing quadratically.
  const build = (chars: number) => "-".repeat(chars);
  const out = assertRedactionLinear("hyphen run", build);
  assertEquals(out, scaledInput(build));
});

Deno.test("redactSecrets - a prompt-injected alphanumeric blob is redacted promptly", () => {
  // The Issue #3942 exploit sketch: an injected model summary of hundreds of
  // kilobytes of alphanumerics reaching `publishableSnippet` before it is
  // sliced, with the credential at the very end.
  const secret = "https://user:s3cr3t-token@example.com/repo.git";
  const out = assertRedactionLinear(
    "injected blob with a trailing credential",
    (chars) => "a".repeat(chars) + " " + secret,
  );
  assertEquals(
    out.includes("s3cr3t-token"),
    false,
    "a secret at the end of a large input must still be redacted",
  );
  assertStringIncludes(out, `https://user:${REDACTION_PLACEHOLDER}@`);
});

Deno.test("redactSecrets - a long sk- charset run is masked (Issue #36)", () => {
  // The `openai-key` quantifier carries an explicit ceiling, so an oversized
  // charset run is consumed in fixed-size bites instead of one open-ended
  // greedy sweep. The key material still goes.
  const out = redactSecrets("sk-" + "a".repeat(4096));
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
  assertEquals(
    redactSecrets(`key ${key} rejected`),
    `key ${REDACTION_PLACEHOLDER} rejected`,
  );
});

Deno.test("redactSecrets - near-miss provider prefixes do not stall the new rules (Issue #36)", () => {
  const skUnit = "sk-" + "a".repeat(19) + "!";
  const skBuild = (chars: number) =>
    skUnit.repeat(Math.floor(chars / skUnit.length));
  assertEquals(
    assertRedactionLinear("near-miss sk- prefixes", skBuild),
    scaledInput(skBuild),
  );

  const aizaUnit = "AIzaSy" + "b".repeat(32) + " ";
  const aizaBuild = (chars: number) =>
    aizaUnit.repeat(Math.floor(chars / aizaUnit.length));
  assertEquals(
    assertRedactionLinear("near-miss AIzaSy prefixes", aizaBuild),
    scaledInput(aizaBuild),
  );
});

Deno.test("redactSecrets - a near-miss PEM-body blob stays bounded (Issue #196)", () => {
  // Same shape as the ReDoS test: just-under-floor base64 lines. A
  // catastrophic-backtracking regression has no wrong output, only a
  // super-linear cost, so the growth check is the detector.
  const unit = "B".repeat(39) + "\n";
  const build = (chars: number) => unit.repeat(Math.floor(chars / unit.length));
  assertEquals(
    assertRedactionLinear("PEM-body near-miss", build),
    scaledInput(build),
    "near-miss PEM-body text must pass through unchanged",
  );
});

Deno.test("redactSecrets - a ragged long-line blob stays bounded (Issue #196)", () => {
  // Lines long enough to enter the pem-body candidate class but never
  // uniform, so a greedy run-match plus a failed uniformity check must
  // still finish in linear time.
  const unit = "A".repeat(40) + "\n" + "B".repeat(41) + "\n" + "C".repeat(42) +
    "\n";
  const build = (chars: number) => unit.repeat(Math.floor(chars / unit.length));
  assertEquals(
    assertRedactionLinear("ragged PEM-body near-miss", build),
    scaledInput(build),
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
