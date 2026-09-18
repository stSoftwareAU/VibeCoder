/**
 * The `secret-assignment` rule against JSON structure.
 *
 * The agent transcript tee (Issue #4169) runs `redactSecrets` over every
 * stream-json line before it reaches disk, and the fleet's archived transcripts
 * came back unparsable past the first assistant message. Three shapes in an
 * ordinary line did it:
 *
 *  - `"usage":{"input_tokens":50,...}` — a key that merely contains TOKEN,
 *    followed by a number. Compact JSON has no whitespace, so the bare-value
 *    branch swallowed the number and the rest of the line.
 *  - `"apiKeySource":"none"` on the `init` line — a quoted value masked
 *    without its quotes, leaving a bare word where JSON needs a string.
 *  - a real assignment at the end of a JSON string, `"text":"TOKEN=abc"}` —
 *    the bare value ran through the closing quote and brace.
 *
 * These tests pin the repair: a JSON scalar under a secret-ish key is
 * structure, a quoted value keeps its quotes around the placeholder, a bare
 * value stops at a double quote, and every non-JSON verdict is unchanged.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

/** A usage block exactly as the agent's stream-json carries it. */
const USAGE_LINE =
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the layout."}],"usage":{"input_tokens":50,"cache_creation_input_tokens":51261,"cache_read_input_tokens":1711397,"output_tokens":7415}},"session_id":"e28dacb4"}';

Deno.test("redactSecrets - leaves the usage counts of a stream-json line untouched", () => {
  const out = redactSecrets(USAGE_LINE);
  assertEquals(out, USAGE_LINE);
  const parsed = JSON.parse(out);
  assertEquals(parsed.message.usage.input_tokens, 50);
  assertEquals(parsed.message.usage.output_tokens, 7415);
  assertEquals(containsSecret(USAGE_LINE), false);
});

Deno.test("redactSecrets - a pretty-printed count under a *_tokens key is structure too", () => {
  const body =
    '{\n  "usage": {\n    "input_tokens": 50,\n    "output_tokens": 7415\n  }\n}';
  assertEquals(redactSecrets(body), body);
});

Deno.test("redactSecrets - JSON literals under a secret-ish key are structure, not credentials", () => {
  const body =
    '{"github_token":null,"api_key_present":true,"secret_rotated":false,"token_ttl":-1.5e3,"next":"x"}';
  assertEquals(redactSecrets(body), body);
  assertEquals(containsSecret(body), false);
});

Deno.test("redactSecrets - the init line's apiKeySource stays a JSON string", () => {
  const line =
    '{"type":"system","subtype":"init","apiKeySource":"none","claude_code_version":"2.1.261","output_style":"default"}';
  const out = redactSecrets(line);
  const parsed = JSON.parse(out);
  assertEquals(parsed.apiKeySource, REDACTION_PLACEHOLDER);
  assertEquals(parsed.claude_code_version, "2.1.261");
  assertEquals(parsed.output_style, "default");
});

Deno.test("redactSecrets - a quoted secret is masked with its quotes kept", () => {
  const secret = "correct-horse-9Qz7";
  const out = redactSecrets(`{"password":"${secret}","user":"vibe"}`);
  assertEquals(out.includes(secret), false);
  assertEquals(out, `{"password":"${REDACTION_PLACEHOLDER}","user":"vibe"}`);
  assertEquals(JSON.parse(out).user, "vibe");

  const single = redactSecrets(`token: '${secret}' next`);
  assertEquals(single, `token: '${REDACTION_PLACEHOLDER}' next`);
});

Deno.test("redactSecrets - an assignment at the end of a JSON string stops at the closing quote", () => {
  const secret = "abcdef123456XYZ";
  const line =
    `{"type":"user","message":{"content":[{"type":"tool_result","content":"export GITHUB_TOKEN=${secret}"}]},"tail":"kept"}`;
  const out = redactSecrets(line);
  assertEquals(out.includes(secret), false);
  const parsed = JSON.parse(out);
  assertEquals(
    parsed.message.content[0].content,
    `export GITHUB_TOKEN=${REDACTION_PLACEHOLDER}`,
  );
  assertEquals(parsed.tail, "kept");
});

Deno.test("redactSecrets - the masked output is stable and reads as already redacted", () => {
  const once = redactSecrets(
    '{"password":"correct-horse-9Qz7","text":"TOKEN=abcdef123456"}',
  );
  assertEquals(redactSecrets(once), once);
  assertEquals(containsSecret(once), false);
});

Deno.test("redactSecrets - non-JSON assignments are masked exactly as before", () => {
  assertEquals(
    redactSecrets("TOKEN=abcdef123456"),
    `TOKEN=${REDACTION_PLACEHOLDER}`,
  );
  assertEquals(
    redactSecrets("PASSWORD=12345"),
    `PASSWORD=${REDACTION_PLACEHOLDER}`,
  );
  assertEquals(
    redactSecrets("secret_scanning: enabled"),
    `secret_scanning: ${REDACTION_PLACEHOLDER}`,
  );
  for (
    const body of [
      "TOKEN=abcdef123456",
      "PASSWORD=12345",
      "credential: hunter2x",
    ]
  ) {
    assertEquals(containsSecret(body), true, body);
    assertStringIncludes(redactSecrets(body), REDACTION_PLACEHOLDER, body);
  }
});
