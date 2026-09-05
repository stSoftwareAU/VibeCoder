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
 * Nothing here reads a clock (PR #1170). This suite has now been through
 * two timing detectors and both went red on the machine rather than on the
 * code: an absolute 2000 ms bound failed on a host 8% slower than the one it
 * was chosen on (#530), and the ratio check that replaced it failed on a
 * loaded laptop reading 30 ms against 355 ms for work that is linear — a
 * scheduler slice, not a regression. A fleet of unlike machines under unlike
 * loads has no budget and no ratio that means the same thing twice.
 *
 * The behavioural form needs neither. A catastrophically backtracking rule on
 * these inputs does not cost a little more than some threshold, it never
 * returns: the pre-fix `url-userinfo` took 7.5 s on 128 KB of `a` and grew
 * quadratically from there. So each case feeds the adversarial shape and
 * asserts what `redactSecrets` *produces* — benign text unchanged, a
 * credential masked. A super-linear regression hangs the case until the test
 * runner kills it, on every machine, under every load.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
/**
 * Adversarial input size.
 *
 * The size the previous growth check used for its larger run, kept because it
 * is comfortably past the point where the pre-fix rules became unusable: 64 Ki
 * of `a` cost 1.9 s before #3942 and 128 Ki cost 7.6 s.
 */
const HOSTILE_CHARS = 65_536;

/** `unit` repeated until it fills roughly {@link HOSTILE_CHARS} characters. */
function fill(unit: string): string {
  return unit.repeat(Math.floor(HOSTILE_CHARS / unit.length));
}

Deno.test("redactSecrets - a long alphanumeric run does not stall the url-userinfo rule", () => {
  // Pre-fix: 1.9 s at 64 Ki, 7.6 s at 128 Ki, growing quadratically.
  const hostile = "a".repeat(HOSTILE_CHARS);
  assertEquals(
    redactSecrets(hostile),
    hostile,
    "benign text must pass through",
  );
});

Deno.test("redactSecrets - a long hyphen run does not stall the secret-cli-flag rule", () => {
  // Pre-fix: 483 ms at 32 K hyphens, growing quadratically.
  const hostile = "-".repeat(HOSTILE_CHARS);
  assertEquals(redactSecrets(hostile), hostile);
});

Deno.test("redactSecrets - a prompt-injected alphanumeric blob is redacted promptly", () => {
  // The Issue #3942 exploit sketch: an injected model summary of hundreds of
  // kilobytes of alphanumerics reaching `publishableSnippet` before it is
  // sliced, with the credential at the very end.
  const secret = "https://user:s3cr3t-token@example.com/repo.git";
  const out = redactSecrets("a".repeat(HOSTILE_CHARS) + " " + secret);
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
  const sk = fill("sk-" + "a".repeat(19) + "!");
  assertEquals(redactSecrets(sk), sk);

  const aiza = fill("AIzaSy" + "b".repeat(32) + " ");
  assertEquals(redactSecrets(aiza), aiza);
});

Deno.test("redactSecrets - a near-miss PEM-body blob stays bounded (Issue #196)", () => {
  // Same shape as the ReDoS test: just-under-floor base64 lines. A
  // catastrophic-backtracking regression has no wrong output, only a
  // super-linear cost, so the growth check is the detector.
  const hostile = fill("B".repeat(39) + "\n");
  assertEquals(
    redactSecrets(hostile),
    hostile,
    "near-miss PEM-body text must pass through unchanged",
  );
});

Deno.test("redactSecrets - a ragged long-line blob stays bounded (Issue #196)", () => {
  // Lines long enough to enter the pem-body candidate class but never
  // uniform, so a greedy run-match plus a failed uniformity check must
  // still finish in linear time.
  const hostile = fill(
    "A".repeat(40) + "\n" + "B".repeat(41) + "\n" + "C".repeat(42) + "\n",
  );
  assertEquals(redactSecrets(hostile), hostile);
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
