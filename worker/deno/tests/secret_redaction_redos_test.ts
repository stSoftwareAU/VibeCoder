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
 * These tests assert what `redactSecrets` *produces* for each adversarial
 * shape, and that real URL credentials and secret flags are still masked. The
 * input itself is deliberately never truncated — `SECURITY.md` requires
 * redaction before truncation, so a scan cap would leave the tail unmasked —
 * which is why the defence is the patterns' linearity, not an input bound.
 *
 * There is no stopwatch here (PR #1170). A wall-clock budget was the
 * original detector and it made the default branch red on a loaded host: it
 * reported the machine, not the rule. It also added nothing, because a
 * catastrophically backtracking pattern on 128 KB of adversarial text does
 * not overrun a budget, it never returns — so feeding the hostile input and
 * asserting the output is the same detector, on every machine, under every
 * load. The unfixed `url-userinfo` needed ~7.6 s for the 131,072-character
 * case; the fixed one answers in single-digit milliseconds.
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

Deno.test("redactSecrets - a long alphanumeric run passes through unchanged (url-userinfo, Issue #3942)", () => {
  const hostile = "a".repeat(HOSTILE_CHARS);
  assertEquals(
    redactSecrets(hostile),
    hostile,
    "ordinary text must pass through unchanged",
  );
});

Deno.test("redactSecrets - a long hyphen run passes through unchanged (secret-cli-flag, Issue #3942)", () => {
  const hostile = "-".repeat(HOSTILE_CHARS);
  assertEquals(redactSecrets(hostile), hostile);
});

Deno.test("redactSecrets - a mixed hostile blob passes through unchanged (Issue #3942)", () => {
  // Scheme-ish characters interleaved so the lookbehind cannot short-circuit
  // every start position. There is no credential in it, so nothing may be
  // masked — the assertion that used to be a budget is now the output.
  const hostile = "a.b-c+".repeat(HOSTILE_CHARS / 6);
  assertEquals(redactSecrets(hostile), hostile);
});

Deno.test("redactSecrets - a huge input is scanned whole, tail included (Issue #3942)", () => {
  // The input is never truncated: redaction runs before truncation, so a
  // credential past any notional cap must still be masked.
  const secretTail = "\nclone https://nigel:ghp_x@github.com/org/repo.git";
  const oversized = "a".repeat(HOSTILE_CHARS) + secretTail;

  const out = redactSecrets(oversized);

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

Deno.test("redactSecrets - a run of near-miss sk- prefixes passes through unchanged (openai-key, Issue #36)", () => {
  // Adversarial shape for the OpenAI rule: every `sk-` is a candidate start
  // and every run stops one character short of the 20-character minimum, so
  // the rule must fail fast at each start rather than rescanning the tail.
  const unit = "sk-" + "a".repeat(19) + "!";
  const hostile = unit.repeat(Math.floor(HOSTILE_CHARS / unit.length));
  assertEquals(
    redactSecrets(hostile),
    hostile,
    "near-miss text must pass through unchanged",
  );
});

Deno.test("redactSecrets - a run of near-miss AIzaSy prefixes passes through unchanged (google-api-key, Issue #36)", () => {
  // One character short of Google's fixed 39-character key length.
  const unit = "AIzaSy" + "b".repeat(32) + " ";
  const hostile = unit.repeat(Math.floor(HOSTILE_CHARS / unit.length));
  assertEquals(
    redactSecrets(hostile),
    hostile,
    "near-miss text must pass through unchanged",
  );
});

Deno.test("redactSecrets - provider keys in the tail of a huge input are still masked (Issue #36)", () => {
  const openai = "sk-proj-" + "9".repeat(60);
  const google = "AIzaSy" + "7".repeat(33);
  const oversized = "sk-".repeat(HOSTILE_CHARS / 3) + `\n${openai} ${google}\n`;

  const out = redactSecrets(oversized);

  assert(!out.includes(openai), "an OpenAI key in the tail must be masked");
  assert(!out.includes(google), "a Google key in the tail must be masked");
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

Deno.test("redactSecrets - a 500 kB near-miss PEM-body run passes through unchanged (Issue #196)", () => {
  // Adversarial shape for the generalised pem-body rule: many consecutive
  // base64 lines one character short of the width floor, so every line is a
  // candidate start that must fail fast rather than backtracking across the
  // rest of the blob. Pre-fix the 64-character rule ignored this input;
  // a widened, unbounded `{40,}` quantifier would not.
  const unit = "A".repeat(39) + "\n";
  const hostile = unit.repeat(Math.floor(500_000 / unit.length));
  assertEquals(
    redactSecrets(hostile),
    hostile,
    "near-miss PEM-body text must pass through unchanged",
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
