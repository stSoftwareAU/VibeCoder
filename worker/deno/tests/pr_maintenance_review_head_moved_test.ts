/**
 * Issue #2697: a CHANGES_REQUESTED review stays actionable after the PR head
 * moves (branch update, rebase, merge-from-base) and is dropped only when
 * dismissed or superseded by the same reviewer's later review.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

interface Captured {
  logger: Logger;
  infos: string[];
  warns: string[];
}

function makeCapturingLogger(): Captured {
  const infos: string[] = [];
  const warns: string[] = [];
  const noop = () => {};
  return {
    infos,
    warns,
    logger: {
      info: (msg: string) => infos.push(msg),
      warn: (msg: string) => warns.push(msg),
      error: noop,
      debug: noop,
      security: noop,
      skipReason: noop,
      timing: noop,
      scanSummary: noop,
      workerSummary: noop,
    },
  };
}

/** One PR at head `shaB` whose reviews were left on `shaA`. */
function makeGh(
  headRefName: string,
  reviews: unknown[] | string,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: 42, headRefName, headRefOid: "shaB" },
      ]));
    }
    if (key.includes("pulls/42/reviews")) {
      if (typeof reviews === "string") return Promise.resolve(reviews);
      // `--paginate` prints one array per page; page one is full of noise, so
      // the review under test is only reachable by reading every page.
      const pageOne = JSON.stringify([{ ...NOISE, id: 1 }]);
      const rest = `${JSON.stringify(reviews)}\n`;
      return Promise.resolve(
        args.includes("--paginate") ? `${pageOne}\n${rest}` : `${pageOne}\n`,
      );
    }
    return Promise.resolve("[]");
  };
}

function options(
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): PrScanOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger,
    isRepoAllowed: () => true,
    isAuthorisedCommenter: (login: string) => login === "maintainer",
    ghCommandFn,
  };
}

/** Another reviewer's approval — never outstanding, never supersedes. */
const NOISE = {
  login: "bystander",
  id: 1,
  body: "LGTM",
  state: "APPROVED",
  submitted_at: "2026-08-01T00:00:00Z",
  commit_id: "shaA",
};

const CHANGES_REQUESTED = {
  login: "maintainer",
  id: 700,
  body: "Please rename the helper.",
  state: "CHANGES_REQUESTED",
  submitted_at: "2026-09-01T00:00:00Z",
  commit_id: "shaA",
};

Deno.test("findPrCommentsToFix - a review on an issue branch survives a head move (Issue #2697)", async () => {
  const { logger } = makeCapturingLogger();
  const result = await findPrCommentsToFix(
    options(makeGh("issue-42-fix", [CHANGES_REQUESTED]), logger),
  );

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, "700");
  // The review sits on page two, so this also proves every page is read.
  assertEquals(result.value.prNumber, 42);
});

Deno.test("findPrCommentsToFix - a review on a milestone branch survives a merge-from-base (Issue #2697)", async () => {
  const { logger } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(
    makeGh("milestone/1442-refactor-claims", [CHANGES_REQUESTED]),
    logger,
  ));

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, "700");
  assertEquals(result.value.branchName, "milestone/1442-refactor-claims");
});

Deno.test("findPrCommentsToFix - a dismissed review is not returned (Issue #2697)", async () => {
  const { logger } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(
    makeGh("issue-42-fix", [{ ...CHANGES_REQUESTED, state: "DISMISSED" }]),
    logger,
  ));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});

for (const later of ["APPROVED"]) {
  Deno.test(`findPrCommentsToFix - a later ${later} review supersedes and the skip is logged at INFO (Issue #2697)`, async () => {
    const { logger, infos } = makeCapturingLogger();
    const result = await findPrCommentsToFix(options(
      makeGh("issue-42-fix", [
        CHANGES_REQUESTED,
        {
          ...CHANGES_REQUESTED,
          id: 701,
          body: "Looks good now.",
          state: later,
          submitted_at: "2026-09-02T00:00:00Z",
          commit_id: "shaB",
        },
      ]),
      logger,
    ));

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, null);
    const logged = infos.find((m) => m.includes("700"));
    assertEquals(
      logged?.includes(`superseded by maintainer's later ${later} review 701`),
      true,
      `expected an INFO skip line with its reason, got: ${infos.join(" | ")}`,
    );
  });
}

Deno.test("findPrCommentsToFix - a later COMMENTED review leaves the request actionable (Issue #2697)", async () => {
  const { logger } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(
    makeGh("issue-42-fix", [
      CHANGES_REQUESTED,
      {
        ...CHANGES_REQUESTED,
        id: 701,
        body: "One more thought.",
        state: "COMMENTED",
        submitted_at: "2026-09-02T00:00:00Z",
        commit_id: "shaB",
      },
    ]),
    logger,
  ));

  assertEquals(result.ok, true);
  if (!result.ok || !result.value) throw new Error("expected the review");
  assertEquals(result.value.commentType, "pr_review");
  assertEquals(result.value.commentId, "700");
});

Deno.test("findPrCommentsToFix - skipping the host's own review is logged at INFO (Issue #2697)", async () => {
  const { logger, infos } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(
    makeGh("issue-42-fix", [{ ...CHANGES_REQUESTED, login: "testbot" }]),
    logger,
  ));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
  assertEquals(
    infos.some((m) => m.includes("700") && m.includes("own review")),
    true,
    `expected an INFO skip line, got: ${infos.join(" | ")}`,
  );
});

Deno.test("findPrCommentsToFix - an empty-bodied change request is skipped and logged at INFO (Issue #2697)", async () => {
  const { logger, infos } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(
    makeGh("issue-42-fix", [{ ...CHANGES_REQUESTED, body: "" }]),
    logger,
  ));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
  assertEquals(
    infos.some((m) => m.includes("700") && m.includes("no body")),
    true,
    `expected an INFO skip line, got: ${infos.join(" | ")}`,
  );
});

Deno.test("findPrCommentsToFix - an unreadable review list warns rather than passing silently (Issue #2697)", async () => {
  const { logger, warns } = makeCapturingLogger();
  const result = await findPrCommentsToFix(options(
    makeGh("issue-42-fix", "[{not json"),
    logger,
  ));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
  assertEquals(
    warns.some((m) => m.includes("org/repo#42") && m.includes("reviews")),
    true,
    `expected a warning, got: ${warns.join(" | ")}`,
  );
});
