/**
 * Tests for the published-text arm of gh_body_redaction.ts (Issue #1283).
 *
 * A title is a public sink exactly like a body: `gh issue create --title …`,
 * `gh pr create --title …` and `gh api … -f title=…` all publish their text to
 * GitHub. So do a label's `-f name=` / `-f description=` and a milestone's
 * `-f title=` / `-f description=`. Before this change the chokepoint masked
 * body-shaped arguments only, so those sinks reached GitHub byte-for-byte and
 * two call sites hand-wrapped `redactSecrets` to compensate.
 *
 * The counter-invariant matters just as much: routing arguments — the repo
 * slug, the API path, `--label`, `--head`, reaction fields — must stay
 * byte-for-byte untouched, so redaction can never redirect a mutation.
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

Deno.test("redactGhBodyArgs - masks a secret in a --title argument", () => {
  assertEquals(
    redactGhBodyArgs([
      "issue",
      "create",
      "--repo",
      "org/repo",
      "--title",
      `run failed: ${GH_TOKEN_SAMPLE}`,
      "--body",
      "see the log",
    ]),
    [
      "issue",
      "create",
      "--repo",
      "org/repo",
      "--title",
      `run failed: ${REDACTION_PLACEHOLDER}`,
      "--body",
      "see the log",
    ],
  );
});

Deno.test("redactGhBodyArgs - masks a secret in the --title=<text> form", () => {
  assertEquals(
    redactGhBodyArgs(["pr", "create", `--title=fix ${GH_TOKEN_SAMPLE}`]),
    ["pr", "create", `--title=fix ${REDACTION_PLACEHOLDER}`],
  );
});

Deno.test("redactGhBodyArgs - masks a secret in -f title= and -f description=", () => {
  assertEquals(
    redactGhBodyArgs([
      "api",
      "-X",
      "POST",
      "repos/org/repo/milestones",
      "-f",
      `title=${GH_TOKEN_SAMPLE}`,
      "-f",
      `description=notes ${GH_TOKEN_SAMPLE}`,
    ]),
    [
      "api",
      "-X",
      "POST",
      "repos/org/repo/milestones",
      "-f",
      `title=${REDACTION_PLACEHOLDER}`,
      "-f",
      `description=notes ${REDACTION_PLACEHOLDER}`,
    ],
  );
});

Deno.test("redactGhBodyArgs - masks a secret in a -f name= label field", () => {
  assertEquals(
    redactGhBodyArgs([
      "api",
      "-X",
      "POST",
      "repos/org/repo/labels",
      "-f",
      `name=${GH_TOKEN_SAMPLE}`,
      "-f",
      "color=ededed",
    ]),
    [
      "api",
      "-X",
      "POST",
      "repos/org/repo/labels",
      "-f",
      `name=${REDACTION_PLACEHOLDER}`,
      "-f",
      "color=ededed",
    ],
  );
});

Deno.test("redactGhBodyArgs - masks a secret behind the -t title shorthand", () => {
  assertEquals(
    redactGhBodyArgs([
      "issue",
      "create",
      "-t",
      `run failed: ${GH_TOKEN_SAMPLE}`,
    ]),
    ["issue", "create", "-t", `run failed: ${REDACTION_PLACEHOLDER}`],
  );
});

Deno.test("redactGhBodyArgs - leaves a gh api -t output template alone", () => {
  // On `gh api`, `-t` is `--template`: a formatting argument, not a sink. Its
  // value must survive, and the argument after it must still be scanned.
  assertEquals(
    redactGhBodyArgs([
      "api",
      "repos/org/repo/issues",
      "-t",
      "{{range .}}{{.number}}{{end}}",
      "-f",
      `title=${GH_TOKEN_SAMPLE}`,
    ]),
    [
      "api",
      "repos/org/repo/issues",
      "-t",
      "{{range .}}{{.number}}{{end}}",
      "-f",
      `title=${REDACTION_PLACEHOLDER}`,
    ],
  );
});

Deno.test("redactGhBodyArgs - masks a secret in a --description argument", () => {
  // The CLI spelling of the label description `label_operations.ts` also
  // publishes through `-f description=`.
  assertEquals(
    redactGhBodyArgs([
      "label",
      "create",
      "security",
      "--description",
      `notes ${GH_TOKEN_SAMPLE}`,
    ]),
    [
      "label",
      "create",
      "security",
      "--description",
      `notes ${REDACTION_PLACEHOLDER}`,
    ],
  );
});

Deno.test("redactGhBodyArgs - leaves a GraphQL name variable byte-for-byte alone", () => {
  // `-F name=<repo>` routes a GraphQL query. It shares a key with a label's
  // published name, so the guarantee that holds is shape-specific: an ordinary
  // repository name is never rewritten.
  const args = [
    "api",
    "graphql",
    "-f",
    "query=query($owner:String!,$name:String!){ x }",
    "-F",
    "owner=stSoftwareAU",
    "-F",
    "name=VibeCoder",
  ];
  assertEquals(redactGhBodyArgs(args), args);
});

Deno.test("redactGhBodyArgs - leaves routing arguments byte-for-byte alone", () => {
  // A repo slug carrying no secret, an API path, a label and a head branch are
  // routing data: redaction must never rewrite them, or a mutation lands
  // somewhere other than where the caller aimed it.
  const args = [
    "api",
    "-X",
    "POST",
    "repos/org/repo/issues",
    "--label",
    "security",
    "--head",
    "feature/title-redaction",
    "-f",
    "assignee=octocat",
  ];
  assertEquals(redactGhBodyArgs(args), args);
});

Deno.test("redactGhBodyArgs - a clean title survives byte-for-byte", () => {
  const args = ["issue", "create", "--title", "Fix the date parser"];
  assertEquals(redactGhBodyArgs(args), args);
});

Deno.test("redactGhBodyArgs - masks a secret in a title=@file field value", () => {
  const read = readerFor({ "/tmp/t": `leak ${GH_TOKEN_SAMPLE}` });
  assertEquals(
    redactGhBodyArgs(
      ["api", "repos/org/repo/issues", "-F", "title=@/tmp/t"],
      read,
    ),
    [
      "api",
      "repos/org/repo/issues",
      "-F",
      `title=leak ${REDACTION_PLACEHOLDER}`,
    ],
  );
});

Deno.test("redactGhBodyArgs - masks a title in an --input JSON body into a fresh file", () => {
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({ title: `t ${GH_TOKEN_SAMPLE}` }),
  });
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(
    ["api", "repos/org/repo/issues", "--input", "/tmp/c.json"],
    read,
    writer,
  );
  assertEquals(out[3], "/tmp/gh-input-1.json");
  assertEquals(written.length, 1);
  assertEquals((written[0] ?? "").includes(GH_TOKEN_SAMPLE), false);
  assertEquals(
    JSON.parse(written[0] ?? "{}").title,
    `t ${REDACTION_PLACEHOLDER}`,
  );
});

Deno.test("redactGhBodyArgs - a secret in a routing --input field still refuses", () => {
  // `head` is not published text, so it cannot be masked structurally — the
  // fail-closed path must still hold for the fields the key-scan cannot reach.
  const read = readerFor({
    "/tmp/c.json": JSON.stringify({
      title: "clean",
      head: `branch-${GH_TOKEN_SAMPLE}`,
    }),
  });
  const { writer } = capturingWriter();
  assertThrows(
    () =>
      redactGhBodyArgs(
        ["api", "repos/org/repo/pulls", "--input", "/tmp/c.json"],
        read,
        writer,
      ),
    UnredactableBodyError,
  );
});
