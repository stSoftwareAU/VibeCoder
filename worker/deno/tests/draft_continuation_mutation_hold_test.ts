/**
 * The mutation-hold draft body and the `draftBody` override on
 * `convertToDraftContinuation` (Issue #4617).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  buildMutationHoldDraftBody,
  buildUnmetDraftBody,
  convertToDraftContinuation,
  DRAFT_CONTINUATION_MARKER,
} from "../lib/draft_continuation_pr.ts";

Deno.test("buildMutationHoldDraftBody - marker first, Part of #N, no closing keyword", () => {
  const body = buildMutationHoldDraftBody(5, "Summary. Closes #5.", {
    job: "mutants",
    workflow: "mutants.yml",
    comment: "MUTATION-COMMENT",
  });

  assertEquals(body.startsWith(DRAFT_CONTINUATION_MARKER), true);
  assertStringIncludes(body, "**Draft — validation incomplete.**");
  assertStringIncludes(body, "Part of #5");
  assertStringIncludes(body, "MUTATION-COMMENT");
  assertEquals(body.includes("Closes #5"), false, "closing keyword withheld");
});

Deno.test("buildMutationHoldDraftBody - job and workflow lose backticks and line breaks", () => {
  const body = buildMutationHoldDraftBody(5, "body", {
    job: "mut`ants\nx",
    workflow: "a`b\r\nc.yml",
    comment: "C",
  });

  assertStringIncludes(body, "CI job `mutants x` (ab c.yml)");
});

Deno.test("convertToDraftContinuation - a draftBody is written in place of the unmet-criteria body", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(
      args[1] === "view" ? JSON.stringify({ isDraft: false }) : "",
    );
  };

  await convertToDraftContinuation({
    repo: "owner/repo",
    issueNumber: 5,
    prNumber: 9,
    body: "body",
    draftBody: "HOLD-BODY",
    gh,
    log: () => {},
  });

  const edit = calls.find((args) => args[0] === "pr" && args[1] === "edit");
  assertEquals(edit?.[edit.indexOf("--body") + 1], "HOLD-BODY");
  assertEquals(
    calls.some((args) => args[1] === "ready" && args.includes("--undo")),
    true,
    "the PR is turned into a draft",
  );
  assertEquals(
    calls.some((args) => args[1] === "merge"),
    false,
    "auto-merge is not touched when it is not armed",
  );
});

Deno.test("convertToDraftContinuation - without a draftBody the unmet-criteria body is written", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(
      args[1] === "view" ? JSON.stringify({ isDraft: true }) : "",
    );
  };

  await convertToDraftContinuation({
    repo: "owner/repo",
    issueNumber: 5,
    prNumber: 9,
    body: "body",
    gh,
    log: () => {},
  });

  const edit = calls.find((args) => args[0] === "pr" && args[1] === "edit");
  assertStringIncludes(
    edit?.[edit.indexOf("--body") + 1] ?? "",
    "not every acceptance criterion is met yet",
  );
});

// Issue #4936: the withhold also rewrites colon and full-URL references, and a
// qualified one needs the run's identity, so both draft builders take it.
const IDENTITY = { prRepo: "o/r", issueRepo: "o/r" };
const HOLD = { job: "mutants", workflow: "mutants.yml", comment: "C" };
const GOVERNING_REFERENCES = [
  "Closes: #5",
  "Closes: o/r#5",
  "Fixes https://github.com/o/r/issues/5",
];

for (const reference of GOVERNING_REFERENCES) {
  Deno.test(`buildMutationHoldDraftBody - "${reference}" is withheld and does not throw given the identity (Issue #4936)`, () => {
    const body = buildMutationHoldDraftBody(
      5,
      `Done.\n\n${reference}\n`,
      HOLD,
      IDENTITY,
    );

    assertEquals(
      /(close[sd]?|fix(e[sd])?|resolve[sd]?):?\s+(https:|o\/r#|#)/i.test(body),
      false,
      body,
    );
    assertStringIncludes(body, "Part of ");
  });

  Deno.test(`buildUnmetDraftBody - "${reference}" is withheld and does not throw given the identity (Issue #4936)`, () => {
    const body = buildUnmetDraftBody(5, `Done.\n\n${reference}\n`, IDENTITY);

    assertMatch(
      body.split("Done.")[1] ?? "",
      /^\n\nPart of (o\/r)?#5\n$/,
    );
  });
}
