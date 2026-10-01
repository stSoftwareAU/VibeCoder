/**
 * `gh pr list` without `--search` orders results by creation date, not by
 * update recency (Issue #2901). A long-lived PR that merges or closes after
 * `limit` newer-numbered PRs have already been created never enters the
 * window the merged-PR sweeps read, so its `Closes #N` is never honoured and
 * its branch is never cleaned up. Passing `--search sort:updated-desc` orders
 * the listing by update recency instead, so a merge or close puts the PR back
 * at the front of the window regardless of when it was created.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchMergedPRsAnyAuthor,
  fetchMergedPRsByUser,
  fetchRecentlyClosedPRsForFleet,
} from "../lib/issue_query.ts";

const REPO = "o/r";
const LIMIT = 30;

interface FixturePr {
  number: number;
  title: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  body: string;
}

/** Build the shared fixture: a long-lived PR #100 plus `limit` newer PRs. */
function buildFixture(limit: number): FixturePr[] {
  const prs: FixturePr[] = [{
    number: 100,
    title: "Long-lived PR",
    headRefName: "h100",
    // Created earliest...
    createdAt: "2026-01-01T00:00:00Z",
    // ...but merged/closed/updated most recently.
    updatedAt: "2026-09-30T00:00:00Z",
    mergedAt: "2026-09-30T00:00:00Z",
    closedAt: "2026-09-30T00:00:00Z",
    body: "Closes #99",
  }];
  for (let i = 0; i < limit; i++) {
    const n = 101 + i;
    prs.push({
      number: n,
      title: `Newer PR ${n}`,
      headRefName: `h${n}`,
      // Created later than #100...
      createdAt: `2026-0${2 + (i % 7)}-01T00:00:00Z`,
      // ...but merged/closed/updated earlier than #100.
      updatedAt: `2026-0${1 + (i % 7)}-02T00:00:00Z`,
      mergedAt: `2026-0${1 + (i % 7)}-02T00:00:00Z`,
      closedAt: `2026-0${1 + (i % 7)}-02T00:00:00Z`,
      body: "",
    });
  }
  return prs;
}

/**
 * A mock `gh` emulating gh's real ordering semantics: creation-date-desc by
 * default, update-recency-desc when `--search sort:updated-desc` is passed.
 * Handles only `pr list --state ...` calls; throws on anything else.
 */
function mockGh(fixture: FixturePr[]) {
  const seenArgs: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    seenArgs.push(args);
    const cmd = args.slice(0, 2).join(" ");
    const stateIdx = args.indexOf("--state");
    if (cmd !== "pr list" || stateIdx === -1) {
      throw new Error(`mockGh: unexpected args ${JSON.stringify(args)}`);
    }
    const state = args[stateIdx + 1];

    const searchIdx = args.indexOf("--search");
    const sortedByUpdate = searchIdx !== -1 &&
      args[searchIdx + 1]?.includes("sort:updated-desc");

    let rows = fixture.filter((pr) => {
      if (state === "merged") return pr.mergedAt !== null;
      if (state === "closed") return pr.closedAt !== null;
      return true;
    });

    rows = sortedByUpdate
      ? [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : rows.length;
    rows = rows.slice(0, limit);

    return Promise.resolve(JSON.stringify(rows));
  };
  return { gh, seenArgs };
}

Deno.test("fetchMergedPRsAnyAuthor: PR #100 stays in the window (Issue #2901)", async () => {
  const fixture = buildFixture(LIMIT);
  const { gh } = mockGh(fixture);

  const prs = await fetchMergedPRsAnyAuthor(REPO, undefined, LIMIT, gh);

  const pr100 = prs.find((pr) => pr.number === 100);
  assertEquals(pr100 !== undefined, true);
  assertEquals((pr100?.closingRefs ?? []).includes(99), true);
});

Deno.test("fetchMergedPRsByUser: PR #100 stays in the window (Issue #2901)", async () => {
  const fixture = buildFixture(LIMIT);
  const { gh, seenArgs } = mockGh(fixture);

  const prs = await fetchMergedPRsByUser(REPO, "bot", undefined, LIMIT, gh);

  const pr100 = prs.find((pr) => pr.number === 100);
  assertEquals(pr100 !== undefined, true);
  assertEquals((pr100?.closingRefs ?? []).includes(99), true);

  const call = seenArgs[0] ?? [];
  assertStringIncludes(call.join(" "), "--state merged");
  assertStringIncludes(call.join(" "), "--author bot");
});

Deno.test("fetchRecentlyClosedPRsForFleet: PR #100 stays in the window (Issue #2901)", async () => {
  const fixture = buildFixture(100);
  const { gh } = mockGh(fixture);

  const prs = await fetchRecentlyClosedPRsForFleet(
    REPO,
    ["bot"],
    3600,
    undefined,
    gh,
  );

  const pr100 = prs.find((pr) => pr.number === 100);
  assertEquals(pr100 !== undefined, true);
  assertEquals(pr100?.merged, true);
});
