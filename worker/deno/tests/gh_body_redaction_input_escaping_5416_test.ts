/**
 * Tests for the `--input` rescan after JSON re-serialisation (Issue #5416).
 *
 * `maskedJsonBody` masks the published-text fields of a `gh api --input` JSON
 * body, re-serialises it, and then rescans the whole serialisation. JSON
 * escaping turns a newline into a backslash-n and a quote into backslash-quote,
 * so the already-masked value read as a fresh secret and the request was refused
 * even though the body was safe to send. The rescan now covers only what the key
 * scan cannot reach, and a secret outside the published fields still refuses.
 *
 * Every test calls the real function with real data; none inspect source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  redactGhBodyArgs,
  UnredactableBodyError,
} from "../lib/gh_body_redaction.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import {
  capturingWriter,
  GH_TOKEN_SAMPLE,
  readerFor,
} from "./support/gh_body_fixtures.ts";

/** A 40-character credential-shaped value that the secret rules mask. */
const SECRET_VALUE = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";

const INPUT_ARGS = [
  "api",
  "repos/o/r/issues/1/comments",
  "--input",
  "/tmp/c.json",
];

// ---------------------------------------------------------------------------
// The masked body is sent, not refused
// ---------------------------------------------------------------------------

Deno.test("redactGhBodyArgs #5416 - a cross-line password: body is masked and sent", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({ body: "password:\n" + SECRET_VALUE }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(INPUT_ARGS, read, writer);
  assertEquals(out[3], "/tmp/gh-input-1.json");
  assertEquals(written.length, 1);
  assertEquals((written[0] ?? "").includes(SECRET_VALUE), false);
  assertEquals(
    JSON.parse(written[0] ?? "{}").body,
    `password:\n${REDACTION_PLACEHOLDER}`,
  );
});

Deno.test("redactGhBodyArgs #5416 - a cross-line quoted DEPLOY_TOKEN assignment is masked and sent", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `Rotate these credentials:\nDEPLOY_TOKEN = "${SECRET_VALUE}"`,
    }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(INPUT_ARGS, read, writer);
  assertEquals(out[3], "/tmp/gh-input-1.json");
  assertEquals(written.length, 1);
  assertEquals((written[0] ?? "").includes(SECRET_VALUE), false);
  assertEquals(
    JSON.parse(written[0] ?? "{}").body,
    `Rotate these credentials:\nDEPLOY_TOKEN = "${REDACTION_PLACEHOLDER}"`,
  );
});

Deno.test("redactGhBodyArgs #5416 - a YAML child API_TOKEN under secrets: is masked and sent", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `secrets:\n  API_TOKEN: "${SECRET_VALUE}"`,
    }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(INPUT_ARGS, read, writer);
  assertEquals(out[3], "/tmp/gh-input-1.json");
  assertEquals(written.length, 1);
  assertEquals((written[0] ?? "").includes(SECRET_VALUE), false);
  assertEquals(
    JSON.parse(written[0] ?? "{}").body,
    `secrets:\n  API_TOKEN: "${REDACTION_PLACEHOLDER}"`,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed controls on the changed path: a secret the key scan cannot reach
// still refuses, and the same body without it is accepted
// ---------------------------------------------------------------------------

Deno.test("redactGhBodyArgs #5416 - a secret in a non-published top-level field still refuses", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: "password:\n" + SECRET_VALUE,
      head: `t ${GH_TOKEN_SAMPLE}`,
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () => redactGhBodyArgs(INPUT_ARGS, read, writer),
    UnredactableBodyError,
    "outside its redactable body",
  );

  // Control: the same body with the off-field secret removed is accepted.
  const clean = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: "password:\n" + SECRET_VALUE,
      head: "clean",
    }),
  });
  const control = capturingWriter();
  redactGhBodyArgs(INPUT_ARGS, clean, control.writer);
  assertEquals(control.written.length, 1);
});

Deno.test("redactGhBodyArgs #5416 - a secret in a nested non-published value still refuses", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      meta: { nested: `t ${GH_TOKEN_SAMPLE}` },
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () => redactGhBodyArgs(INPUT_ARGS, read, writer),
    UnredactableBodyError,
    "outside its redactable body",
  );

  // Control: the same body with the nested secret removed is accepted.
  const clean = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      meta: { nested: "clean" },
    }),
  });
  const control = capturingWriter();
  redactGhBodyArgs(INPUT_ARGS, clean, control.writer);
  assertEquals(control.written.length, 1);
});

Deno.test("redactGhBodyArgs #5416 - a secret inside an array still refuses", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      labels: [`t ${GH_TOKEN_SAMPLE}`],
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () => redactGhBodyArgs(INPUT_ARGS, read, writer),
    UnredactableBodyError,
    "outside its redactable body",
  );

  // Control: the same body with the array secret removed is accepted.
  const clean = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      labels: ["clean"],
    }),
  });
  const control = capturingWriter();
  redactGhBodyArgs(INPUT_ARGS, clean, control.writer);
  assertEquals(control.written.length, 1);
});

Deno.test("redactGhBodyArgs #5416 - a published key holding a non-string still refuses", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      title: { text: `t ${GH_TOKEN_SAMPLE}` },
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () => redactGhBodyArgs(INPUT_ARGS, read, writer),
    UnredactableBodyError,
    "outside its redactable body",
  );

  // Control: the same body with the non-string title's secret removed is accepted.
  const clean = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      title: { text: "clean" },
    }),
  });
  const control = capturingWriter();
  redactGhBodyArgs(INPUT_ARGS, clean, control.writer);
  assertEquals(control.written.length, 1);
});

Deno.test("redactGhBodyArgs #5416 - a quoted secret hidden by JSON escaping refuses on the changed path", () => {
  // The value is `"password": "<secret>"` with literal quotes: JSON escaping
  // turns them into \" in the serialised text, which the text scan misses.
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      head: `"password": "${SECRET_VALUE}"`,
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () => redactGhBodyArgs(INPUT_ARGS, read, writer),
    UnredactableBodyError,
    "outside its redactable body",
  );

  // Control: the same body with the quoted secret removed is accepted.
  const clean = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: `see ${GH_TOKEN_SAMPLE}`,
      head: "clean",
    }),
  });
  const control = capturingWriter();
  redactGhBodyArgs(INPUT_ARGS, clean, control.writer);
  assertEquals(control.written.length, 1);
});

Deno.test("redactGhBodyArgs #5416 - a quoted secret hidden by JSON escaping refuses on the unchanged path", () => {
  // Nothing is masked here, so the original text is the scanned body; the
  // quoted secret in `head` is still hidden from that text scan by escaping.
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: "an ordinary comment",
      head: `"password": "${SECRET_VALUE}"`,
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () => redactGhBodyArgs(INPUT_ARGS, read, writer),
    UnredactableBodyError,
    "outside its redactable body",
  );

  // Control: the same body with the quoted secret removed is left alone.
  const clean = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: "an ordinary comment",
      head: "clean",
    }),
  });
  const control = capturingWriter();
  assertEquals(redactGhBodyArgs(INPUT_ARGS, clean, control.writer), INPUT_ARGS);
  assertEquals(control.written.length, 0);
});
