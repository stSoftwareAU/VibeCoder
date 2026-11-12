/**
 * The unmet-criteria draft body and the draft written by
 * `convertToDraftContinuation` (Issues #4146, #4936).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertMatch, assertStringIncludes } from "@std/assert";
import {
  buildUnmetDraftBody,
  convertToDraftContinuation,
} from "../lib/draft_continuation_pr.ts";

Deno.test("convertToDraftContinuation - the unmet-criteria body is written", async () => {
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
// qualified one needs the run's identity, so the draft builder takes it.
const IDENTITY = { prRepo: "o/r", issueRepo: "o/r" };
const GOVERNING_REFERENCES = [
  "Closes: #5",
  "Closes: o/r#5",
  "Fixes https://github.com/o/r/issues/5",
];

for (const reference of GOVERNING_REFERENCES) {
  Deno.test(`buildUnmetDraftBody - "${reference}" is withheld and does not throw given the identity (Issue #4936)`, () => {
    const body = buildUnmetDraftBody(5, `Done.\n\n${reference}\n`, IDENTITY);

    assertMatch(
      body.split("Done.")[1] ?? "",
      /^\n\nPart of (o\/r)?#5\n$/,
    );
  });
}
