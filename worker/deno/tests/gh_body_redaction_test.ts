/**
 * Tests for the body-file arm of gh_body_redaction.ts (Issue #3938).
 *
 * The agent publishes bodies through the PATH shim, not through `spawnGh`, and
 * its everyday spelling is `--body-file <path>` as much as `--body <text>`. A
 * body read from a file therefore has to be scanned too — and a body that
 * cannot be scanned (stdin, an unreadable path) must refuse rather than be
 * published raw.
 *
 * Every test calls the real function with real data; none inspect source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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

Deno.test("redactGhBodyArgs - masks a secret read from --body-file", () => {
  const read = readerFor({ "/tmp/body.md": `token ${GH_TOKEN_SAMPLE}\n` });
  assertEquals(
    redactGhBodyArgs(
      ["issue", "comment", "1", "--body-file", "/tmp/body.md"],
      read,
    ),
    [
      "issue",
      "comment",
      "1",
      "--body",
      `token ${REDACTION_PLACEHOLDER}\n`,
    ],
  );
});

Deno.test("redactGhBodyArgs - masks a secret in the --body-file=<path> form", () => {
  const read = readerFor({ "body.md": `sk-ant-${"x".repeat(24)}` });
  assertEquals(
    redactGhBodyArgs(["pr", "create", "--body-file=body.md"], read),
    ["pr", "create", `--body=${REDACTION_PLACEHOLDER}`],
  );
});

Deno.test("redactGhBodyArgs - masks a secret behind the -F body-file shorthand", () => {
  const read = readerFor({ "/tmp/b": `leak ${GH_TOKEN_SAMPLE}` });
  assertEquals(
    redactGhBodyArgs(["issue", "create", "-F", "/tmp/b"], read),
    ["issue", "create", "--body", `leak ${REDACTION_PLACEHOLDER}`],
  );
});

Deno.test("redactGhBodyArgs - masks a secret in an @file field value", () => {
  const read = readerFor({ "/tmp/b": `leak ${GH_TOKEN_SAMPLE}` });
  assertEquals(
    redactGhBodyArgs(
      ["api", "repos/org/repo/issues/1/comments", "-F", "body=@/tmp/b"],
      read,
    ),
    [
      "api",
      "repos/org/repo/issues/1/comments",
      "-F",
      `body=leak ${REDACTION_PLACEHOLDER}`,
    ],
  );
});

Deno.test("redactGhBodyArgs - leaves a clean body file byte-for-byte alone", () => {
  const read = readerFor({ "/tmp/body.md": "an ordinary comment\n" });
  const args = ["issue", "comment", "1", "--body-file", "/tmp/body.md"];
  // Nothing to mask, so the file reference itself survives — gh reads it.
  assertEquals(redactGhBodyArgs(args, read), args);
});

// Issue #1283 changed this case's field: `title` is published text now, so the
// non-published example moved to `assignee`, a routing field. The invariant the
// test asserts — a field key outside the published set is never read or
// rewritten — is unchanged, and `title=@path` is covered in
// gh_title_redaction_test.ts.
Deno.test("redactGhBodyArgs - leaves a non-body @file field alone", () => {
  const read = readerFor({ "/tmp/b": `leak ${GH_TOKEN_SAMPLE}` });
  const args = ["api", "repos/org/repo/issues", "-F", "assignee=@/tmp/b"];
  assertEquals(redactGhBodyArgs(args, read), args);
});

Deno.test("redactGhBodyArgs - without a reader, body-file arguments pass through", () => {
  // The worker chokepoint (`spawnGh`) supplies no reader, so its behaviour is
  // unchanged: only argv-carried bodies are rewritten.
  const args = ["issue", "comment", "1", "--body-file", "/tmp/body.md"];
  assertEquals(redactGhBodyArgs(args), args);
});

Deno.test("redactGhBodyArgs - refuses a body it cannot scan", () => {
  const read = readerFor({});
  // stdin cannot be read twice, so a stdin body can never be scanned.
  const stdin = assertThrows(
    () => redactGhBodyArgs(["issue", "comment", "1", "--body-file", "-"], read),
    UnredactableBodyError,
  );
  assertStringIncludes(stdin.message, "stdin");

  // An unreadable path is a fault, not a licence to publish unscanned text.
  const missing = assertThrows(
    () =>
      redactGhBodyArgs(
        ["issue", "comment", "1", "--body-file", "/tmp/gone.md"],
        read,
      ),
    UnredactableBodyError,
  );
  assertStringIncludes(missing.message, "/tmp/gone.md");
});

Deno.test("redactGhBodyArgs - refuses an @- field value", () => {
  assertThrows(
    () => redactGhBodyArgs(["api", "x", "-F", "body=@-"], readerFor({})),
    UnredactableBodyError,
  );
});

Deno.test("redactGhBodyArgs - still masks argv bodies when a reader is supplied", () => {
  const read = readerFor({});
  assertEquals(
    redactGhBodyArgs(
      ["issue", "comment", "1", "--body", `x ${GH_TOKEN_SAMPLE}`],
      read,
    ),
    ["issue", "comment", "1", "--body", `x ${REDACTION_PLACEHOLDER}`],
  );
});

// ---------------------------------------------------------------------------
// Issue #92 — `gh api --input <file>` bodies
//
// `gh api …/comments --input body.json` POSTs the file's JSON as the request
// body: a public sink the argv cannot show. A secret in the body's published
// text must be masked into a fresh temp file (never the agent's own file), and
// a body that cannot be safely masked must refuse rather than publish unscanned.
// ---------------------------------------------------------------------------

Deno.test("redactGhBodyArgs #92 - masks a secret in an --input JSON body into a fresh file", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({ body: `see ${GH_TOKEN_SAMPLE}` }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(
    ["api", "repos/o/r/issues/1/comments", "--input", "/tmp/c.json"],
    read,
    writer,
  );
  // --input now points at the materialised copy, not the agent's file.
  assertEquals(out[0], "api");
  assertEquals(out[2], "--input");
  assertEquals(out[3], "/tmp/gh-input-1.json");
  // The secret reaches neither the argv nor the written body.
  assertEquals(out.some((a) => a.includes(GH_TOKEN_SAMPLE)), false);
  assertEquals(written.length, 1);
  assertStringIncludes(written[0] ?? "", REDACTION_PLACEHOLDER);
  assertEquals((written[0] ?? "").includes(GH_TOKEN_SAMPLE), false);
  // The parsed masked body still carries the redaction in `body`.
  assertEquals(
    JSON.parse(written[0] ?? "{}").body,
    `see ${REDACTION_PLACEHOLDER}`,
  );
});

Deno.test("redactGhBodyArgs #92 - the --input=<path> equals form is handled too", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({ message: `x ${GH_TOKEN_SAMPLE}` }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(
    ["api", "repos/o/r/commits/sha/comments", "--input=/tmp/c.json"],
    read,
    writer,
  );
  assertEquals(out[out.length - 1], "--input=/tmp/gh-input-1.json");
  assertEquals(written.length, 1);
  assertEquals((written[0] ?? "").includes(GH_TOKEN_SAMPLE), false);
});

Deno.test("redactGhBodyArgs #92 - a clean --input body is left byte-for-byte alone, no temp file", () => {
  const original = [
    "api",
    "repos/o/r/issues/1/comments",
    "--input",
    "/tmp/c.json",
  ];
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({ body: "an ordinary comment" }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(original, read, writer);
  assertEquals(out, original);
  assertEquals(written.length, 0);
});

Deno.test("redactGhBodyArgs #92 - the agent's own --input file is never rewritten", () => {
  const files = {
    "/tmp/c.json": JSON.stringify({ body: `t ${GH_TOKEN_SAMPLE}` }),
  };
  const before = files["/tmp/c.json"];
  const { writer } = capturingWriter();
  redactGhBodyArgs(
    ["api", "repos/o/r/issues/1/comments", "--input", "/tmp/c.json"],
    readerFor(files),
    writer,
  );
  // The reader-backed store still holds the original, unmasked content.
  assertEquals(files["/tmp/c.json"], before);
});

Deno.test("redactGhBodyArgs #92 - --input - (stdin) refuses: it cannot be scanned", () => {
  const { writer } = capturingWriter();
  const err = assertThrows(
    () =>
      redactGhBodyArgs(
        ["api", "repos/o/r/issues/1/comments", "--input", "-"],
        readerFor({}),
        writer,
      ),
    UnredactableBodyError,
  );
  assertEquals((err as UnredactableBodyError).source, "-");
});

Deno.test("redactGhBodyArgs #92 - an unreadable --input path refuses", () => {
  const { writer } = capturingWriter();
  assertThrows(
    () =>
      redactGhBodyArgs(
        ["api", "repos/o/r/issues/1/comments", "--input", "/tmp/missing.json"],
        readerFor({}),
        writer,
      ),
    UnredactableBodyError,
  );
});

Deno.test("redactGhBodyArgs #92 - a non-JSON --input body with a secret refuses (unparseable is not unscanned)", () => {
  const read = readerFor({
    "/tmp/c.json": `not json, but leaks ${GH_TOKEN_SAMPLE}`,
  });
  const { writer } = capturingWriter();
  assertThrows(
    () =>
      redactGhBodyArgs(
        ["api", "repos/o/r/issues/1/comments", "--input", "/tmp/c.json"],
        read,
        writer,
      ),
    UnredactableBodyError,
  );
});

// Issue #1283 changed this case's field too: a `title` is masked structurally
// now, so the unreachable-field example moved to `head`, which routes a pull
// request and is deliberately not redactable. The fail-closed invariant is
// unchanged.
Deno.test("redactGhBodyArgs #92 - a secret outside the body field refuses rather than pass unscanned", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      body: "clean",
      head: `t ${GH_TOKEN_SAMPLE}`,
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () =>
      redactGhBodyArgs(
        ["api", "repos/o/r/issues", "--input", "/tmp/c.json"],
        read,
        writer,
      ),
    UnredactableBodyError,
  );
});

Deno.test("redactGhBodyArgs #92 - without a reader, --input arguments pass through untouched", () => {
  const original = [
    "api",
    "repos/o/r/issues/1/comments",
    "--input",
    "/tmp/c.json",
  ];
  // No reader: the worker argv-only chokepoint must not touch --input.
  assertEquals(redactGhBodyArgs(original), original);
});

Deno.test("redactGhBodyArgs #92 - masking needed but no writer supplied refuses", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({ body: `t ${GH_TOKEN_SAMPLE}` }),
  });
  // Reader present, writer omitted: a body that needs masking cannot be
  // materialised, so it must fail closed rather than publish from the original.
  assertThrows(
    () =>
      redactGhBodyArgs(
        ["api", "repos/o/r/issues/1/comments", "--input", "/tmp/c.json"],
        read,
      ),
    UnredactableBodyError,
  );
});

Deno.test("redactGhBodyArgs #92 - a non-object JSON body with no secret is left alone", () => {
  const original = ["api", "repos/o/r/x", "--input", "/tmp/c.json"];
  const read = readerFor({ "/tmp/c.json": JSON.stringify(["a", "b"]) });
  const { writer, written } = capturingWriter();
  assertEquals(redactGhBodyArgs(original, read, writer), original);
  assertEquals(written.length, 0);
});
