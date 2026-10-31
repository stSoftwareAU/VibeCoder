/**
 * The open-PR duplicate guard must see every open PR of a fleet author, not
 * just the newest ten (Issue #4518).
 *
 * `fetchOpenPRsByUser` used to ask `gh pr list` for ten rows. An author with
 * more open PRs than that had its older PRs cut off, so the own-PR hold
 * (Issue #2663) could miss the oldest PR, the one that delivers the issue, and
 * let the issue be claimed again. This pins that the listing requests more
 * than twelve rows and that the issue's own, oldest PR is still found.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  fetchOpenPRsForFleet,
  getBlockingPRForIssue,
} from "../lib/issue_query.ts";

const REPO = "o/r";
const AUTHOR = "vibe-bot";
const OWN_PR = 100;

interface ListedPR {
  number: number;
  title: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
}

/**
 * Twelve open PRs by one fleet author, newest first. PRs 101..111 are for
 * other issues; PR 100 is the issue-8 PR and the oldest of the twelve.
 */
const LISTING: ListedPR[] = [
  ...Array.from({ length: 11 }, (_, i) => {
    const number = 111 - i;
    return {
      number,
      title: `Other work (#${number})`,
      baseRefName: "main",
      headRefName: `issue-${number}-other`,
      isDraft: false,
    };
  }),
  {
    number: OWN_PR,
    title: "Fix it (#8)",
    baseRefName: "main",
    headRefName: "issue-8-fix",
    isDraft: false,
  },
];

/**
 * Stub `gh`: `pr list` honours `--author` and `--limit` over {@link LISTING}.
 * Each requested `--limit` is recorded in `limits`.
 */
function ghStub(limits: number[] = []): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] !== "pr" || args[1] !== "list") {
      return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
    }
    const author = args[args.indexOf("--author") + 1];
    const limit = Number(args[args.indexOf("--limit") + 1]);
    if (!Number.isInteger(limit)) {
      return Promise.reject(new Error(`no --limit in: ${args.join(" ")}`));
    }
    limits.push(limit);
    if (author !== AUTHOR) return Promise.resolve("[]");
    return Promise.resolve(JSON.stringify(LISTING.slice(0, limit)));
  };
}

Deno.test("the own PR is held even when it is the oldest of twelve (Issue #4518)", async () => {
  const prs = await fetchOpenPRsForFleet(REPO, [AUTHOR], undefined, ghStub());
  assertEquals(prs.length, 12, "every open PR of the author is listed");
  const held = getBlockingPRForIssue(prs, "", [AUTHOR], 8, 8);
  assertEquals(held?.number, OWN_PR);
  assertEquals(held?.fleetPrCap, undefined, "held by its own PR, not the cap");
});

Deno.test("an issue with no PR of its own is not held by the own-PR rule (Issue #4518 control)", async () => {
  const prs = await fetchOpenPRsForFleet(REPO, [AUTHOR], undefined, ghStub());
  // Twelve default-branch PRs are over a cap of 8, so issue 9 is held by the
  // cap, not by PR 100. With a cap of 50 nothing holds it.
  const held = getBlockingPRForIssue(prs, "", [AUTHOR], 8, 9);
  assertNotEquals(held?.number, OWN_PR);
  assertEquals(held?.fleetPrCap, { open: 12, cap: 8 });
  assertEquals(getBlockingPRForIssue(prs, "", [AUTHOR], 50, 9), null);
});

Deno.test("the open-PR listing asks gh for more than twelve rows (Issue #4518)", async () => {
  const limits: number[] = [];
  await fetchOpenPRsForFleet(REPO, [AUTHOR], undefined, ghStub(limits));
  assertEquals(limits.length, 1, "one pr list call for one author");
  assert(
    limits[0]! > 12,
    `--limit ${limits[0]} would truncate twelve open PRs`,
  );
});
