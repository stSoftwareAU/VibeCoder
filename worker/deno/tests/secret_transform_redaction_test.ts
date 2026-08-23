/**
 * Tests for the decode-then-rescan redaction pass (Issue #188).
 *
 * Every rule in `secret_redaction.ts` anchors on the *original* bytes of a
 * credential — `ghp_`, `sk-ant-`, `AIzaSy`, a PEM marker, a `KEY=value`
 * shape. A credential piped through `base64`, `xxd`, or `rev`, or split
 * across two `echo` calls, therefore matched no rule at all and was
 * republished verbatim — including through `gh_body_redaction.ts`, whose
 * `redactSecrets()` pass guards the worker's public GitHub sinks.
 *
 * These tests fail against the unfixed code (the encoded token survives
 * redaction) and pass once the transform pass lands. The over-redaction
 * tests are equally load-bearing: the pass must not start masking SHAs,
 * UUIDs, patch blobs or ordinary prose.
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import { redactGhBodyArgs } from "../lib/gh_body_redaction.ts";

/** A classic GitHub token: the credential the attacker model exfiltrates. */
const GH_TOKEN = "ghp_" + "aB3dE6gH9jK2mN5pQ8sT1vW4xY7zC0eF3hJ6";

/** An Anthropic key, the second live secret in the worker's environment. */
const ANTHROPIC_KEY = "sk-ant-api03-" + "Kd8fJ2mQ5tW9xZ3bN6vC1yH4uR7pL0aS";

/** Hex-encode `text` the way `xxd -p` / `od` would. */
function toHex(text: string): string {
  return [...text]
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

/** Reverse `text` the way `rev` would. */
function reversed(text: string): string {
  return text.split("").reverse().join("");
}

Deno.test("redactSecrets - masks a base64-encoded GitHub token (Issue #188)", () => {
  // The exact trigger from the issue: `echo "$GH_TOKEN" | base64`.
  const encoded = btoa(GH_TOKEN);
  const out = redactSecrets(`here it is: ${encoded}`);
  assertEquals(out.includes(encoded), false, "encoded token must not survive");
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks a base64-encoded token carrying its trailing newline", () => {
  // `echo` appends a newline, so the real command encodes `token\n`.
  const encoded = btoa(`${GH_TOKEN}\n`);
  const out = redactSecrets(`captured ${encoded} from the pipe`);
  assertEquals(out.includes(encoded), false);
});

Deno.test("redactSecrets - masks a url-safe base64 Anthropic key (Issue #188)", () => {
  const encoded = btoa(ANTHROPIC_KEY).replaceAll("+", "-").replaceAll("/", "_");
  const out = redactSecrets(`payload ${encoded} end`);
  assertEquals(out.includes(encoded), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks a hex-encoded GitHub token (Issue #188)", () => {
  const encoded = toHex(GH_TOKEN);
  const out = redactSecrets(`xxd said ${encoded}`);
  assertEquals(out.includes(encoded), false);
});

Deno.test("redactSecrets - masks a reversed token (Issue #188)", () => {
  const encoded = reversed(GH_TOKEN);
  const out = redactSecrets(`rev output: ${encoded}`);
  assertEquals(out.includes(encoded), false);
});

Deno.test("redactSecrets - masks a double-transformed token (base64 then rev) (Issue #188)", () => {
  const encoded = reversed(btoa(GH_TOKEN));
  const out = redactSecrets(`chained: ${encoded}`);
  assertEquals(out.includes(encoded), false);
});

Deno.test("redactSecrets - masks a token split across two lines (Issue #188)", () => {
  const body = `first half:\n${GH_TOKEN.slice(0, 18)}\n${
    GH_TOKEN.slice(18)
  }\nthat's the lot`;
  const out = redactSecrets(body);
  assertEquals(out.includes(GH_TOKEN.slice(0, 18)), false);
  assertEquals(out.includes(GH_TOKEN.slice(18)), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks a base64 blob wrapped across lines by base64(1)", () => {
  // GNU `base64` wraps at 76 columns, so a long key encodes to several lines.
  const encoded = btoa(ANTHROPIC_KEY);
  const wrapped = `${encoded.slice(0, 40)}\n${encoded.slice(40)}`;
  const out = redactSecrets(`captured:\n${wrapped}\n`);
  assertEquals(out.includes(encoded.slice(0, 40)), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("containsSecret - reports a transformed secret (Issue #188)", () => {
  assert(containsSecret(btoa(GH_TOKEN)));
  assert(containsSecret(toHex(ANTHROPIC_KEY)));
  assertEquals(containsSecret("nothing secret in this sentence at all"), false);
});

Deno.test("redactGhBodyArgs - masks a base64-encoded token in a published body (Issue #188)", () => {
  // The reported sink: an agent-authored `gh` body reaching a public comment.
  const encoded = btoa(GH_TOKEN);
  const args = redactGhBodyArgs([
    "issue",
    "comment",
    "188",
    "--body",
    `debug dump ${encoded}`,
  ]);
  assertEquals(args[4]?.includes(encoded), false);
  assertStringIncludes(args[4] ?? "", REDACTION_PLACEHOLDER);
  assertEquals(args[2], "188", "routing arguments stay byte-identical");
});

Deno.test("redactSecrets - leaves prose, SHAs, UUIDs and identifiers unchanged", () => {
  const benign = [
    "Merged commit 5566503a1b2c3d4e5f60718293a4b5c6d7e8f901 into main.",
    "Run id vibe-mt29l0ik-0e5375 processed issue #188 in 42 seconds.",
    "session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 finished cleanly",
    "worker/deno/lib/secret_redaction.ts:52-212 documents the rules",
    "A base64EncodedIdentifierWithoutAnySecretInside is still readable.",
  ].join("\n");
  assertEquals(redactSecrets(benign), benign);
});

Deno.test("redactSecrets - leaves a base64 image blob and a stats table unchanged", () => {
  // A patch/data blob decodes to binary noise, not to a credential shape.
  const blob = btoa(
    Array.from({ length: 240 }, (_, i) => String.fromCharCode(i % 251)).join(
      "",
    ),
  );
  const body = `![chart](data:image/png;base64,${blob})\n\n` +
    "- **Tokens:** input 27,318 · output 4,102\n" +
    "- **Duration:** 12m 31s\n";
  assertEquals(redactSecrets(body), body);
});

Deno.test("redactSecrets - the transform pass stays linear on a large benign blob (Issue #188)", () => {
  // The decode-then-rescan pass runs on the worker's only thread over
  // attacker-influenced text, so it must not reintroduce a stall.
  const hostile = "a".repeat(262_144);
  const started = performance.now();
  const out = redactSecrets(hostile);
  const elapsed = performance.now() - started;
  assertEquals(out, hostile, "benign text must pass through unchanged");
  assert(
    elapsed < 2_000,
    `256 KiB blob took ${elapsed.toFixed(0)} ms (budget 2000 ms)`,
  );
});

Deno.test("redactSecrets - masks a secret at the tail of a large input (Issue #188)", () => {
  const encoded = btoa(GH_TOKEN);
  const out = redactSecrets("filler text. ".repeat(20_000) + encoded);
  assertEquals(out.includes(encoded), false);
});

Deno.test("redactSecrets - decoded-secret detection is not order-dependent", () => {
  // The decode-then-rescan pass matches each decoded candidate against the
  // signature rules. Those rule patterns are global, so a detection scan must
  // not leave `lastIndex` advanced — otherwise whether a secret is found
  // depends on the previous call's input. Encoding the same token twice in one
  // input, and redacting the same input repeatedly, both exercise that.
  const encoded = btoa(GH_TOKEN);
  const twice = `first ${encoded} second ${encoded}`;
  assertEquals(redactSecrets(twice).includes(encoded), false);

  for (let i = 0; i < 3; i++) {
    assertEquals(
      containsSecret(btoa(ANTHROPIC_KEY)),
      true,
      `detection failed on repeat ${i}`,
    );
  }
});
