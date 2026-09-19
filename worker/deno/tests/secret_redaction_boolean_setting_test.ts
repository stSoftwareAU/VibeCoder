/**
 * The `secret-assignment` rule against a boolean setting under a secret-ish
 * key.
 *
 * Live incident (2026-09-07 → 2026-09-19): the `github-actions-audit` idle
 * task filed fourteen issues across five monitored repositories whose whole
 * instruction was "add `persist-credentials: false` to the checkout step".
 * The key contains CREDENTIAL, so every copy of the setting was published as
 * `persist-credentials: ***REDACTED***` — and because the bare-value branch
 * runs to the next whitespace, the closing backtick and the full stop went
 * with it. The issues told the agent to set a value nobody could read.
 *
 * A switch is not a credential. `true`, `false`, `yes`, `no`, `on`, `off`,
 * `null` and `none` standing alone as the value are configuration; the same
 * letters at the start of a longer token are still a value to mask.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

Deno.test("redactSecrets - the audit's own issue text survives: `persist-credentials: false` in prose, a fence and at end of line", () => {
  const body = [
    "Job `markdownlint` step 0 runs `actions/checkout` without `persist-credentials: false`. By default checkout",
    "",
    "Add `persist-credentials: false` to the checkout step:",
    "",
    "```yaml",
    "      - uses: actions/checkout@<sha>",
    "        with:",
    "          persist-credentials: false",
    "```",
    "",
    "`uses: actions/checkout` with no `persist-credentials: false`",
  ].join("\n");
  assertEquals(redactSecrets(body), body);
});

Deno.test("redactSecrets - a bare switch under a secret-ish key is configuration, in every spelling and separator", () => {
  for (
    const line of [
      "persist-credentials: true",
      "persist-credentials: False",
      "use_credentials = no",
      "STORE_PASSWORD=off",
      "password: null",
      "api_key: none",
      "rotate_token: yes",
      "cache-credentials: on,",
      "(persist-credentials: false)",
    ]
  ) {
    assertEquals(redactSecrets(line), line, line);
  }
});

Deno.test("redactSecrets - a value that merely starts with a switch word is still masked", () => {
  for (
    const [line, expected] of [
      ["PASSWORD=false-Flag-9f8e7d6c", `PASSWORD=${REDACTION_PLACEHOLDER}`],
      ["API_KEY=no1SecretValue77", `API_KEY=${REDACTION_PLACEHOLDER}`], // gitleaks:allow fake fixture, not a real key
      ["token: onlyAToken12345", `token: ${REDACTION_PLACEHOLDER}`],
      ["SECRET=null_b64_Zm9vYmFy", `SECRET=${REDACTION_PLACEHOLDER}`], // gitleaks:allow fake fixture, not a real key
      ["password: true.story.8842", `password: ${REDACTION_PLACEHOLDER}`],
    ] as const
  ) {
    assertEquals(redactSecrets(line), expected, line);
  }
});

Deno.test("redactSecrets - ordinary credentials are masked exactly as before", () => {
  assertEquals(
    redactSecrets("PASSWORD=hunter2hunter2"),
    `PASSWORD=${REDACTION_PLACEHOLDER}`,
  );
  assertEquals(
    redactSecrets('"api_key": "abc123def456ghi789"'), // gitleaks:allow fake fixture, not a real key
    `"api_key": "${REDACTION_PLACEHOLDER}"`,
  );
  // A bare number with nothing after it stays masked (Issue #4169's rule).
  assertEquals(
    redactSecrets("PASSWORD=12345"),
    `PASSWORD=${REDACTION_PLACEHOLDER}`,
  );
});
