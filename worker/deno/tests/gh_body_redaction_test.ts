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
  type BodyFileReader,
  redactGhBodyArgs,
  UnredactableBodyError,
} from "../lib/gh_body_redaction.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

/** A realistic GitHub token shape — the payload each body carries. */
const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

/** A reader serving a fixed set of paths; anything else fails to read. */
function readerFor(files: Record<string, string>): BodyFileReader {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  };
}

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

Deno.test("redactGhBodyArgs - leaves a non-body @file field alone", () => {
  const read = readerFor({ "/tmp/b": `leak ${GH_TOKEN_SAMPLE}` });
  const args = ["api", "repos/org/repo/issues", "-F", "title=@/tmp/b"];
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
