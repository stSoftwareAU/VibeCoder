/**
 * The merged/closed per-author PR listings stay cached while nothing could
 * have changed them (Issue #2409).
 *
 * Live measurement, 2026-09-20: `graphql-shapes:` showed
 * `242×[pr list --author --json --limit --repo --state]` on a cold cycle — the
 * open, merged and closed listings, once per fleet author per repository —
 * re-fetched every ten minutes. The fleet was exhausting its GraphQL quota ~25
 * minutes into every hour and then claiming nothing.
 *
 * A merged or closed listing for an author changes only when one of that
 * author's **open** PRs in that repository stops being open. The open set is
 * already known cheaply, so the listing is kept for up to an hour *while every
 * open PR it has seen is still open*, and refetched the moment one is gone.
 * A stale answer cannot cause duplicate work: the pickup pre-check looks for
 * an existing PR live, with no cache (`merged_pr_precheck_phase.ts`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  fetchClosedPRsByUser,
  fetchMergedPRsByUser,
} from "../lib/issue_query.ts";

const REPO = "o/r";
const USER = "fleetbot";
const MINUTE = 60;

/** A fake `gh` serving the open and the settled listings, counting each. */
function fakeGh(state: { open: number[]; openFails?: boolean }) {
  const calls = { open: 0, settled: 0 };
  const gh = (args: string[]): Promise<string> => {
    const which = args[args.indexOf("--state") + 1];
    if (which === "open") {
      calls.open++;
      if (state.openFails) return Promise.reject(new Error("rate limited"));
      return Promise.resolve(JSON.stringify(state.open.map((number) => ({
        number,
        title: `PR ${number}`,
        baseRefName: "main",
        headRefName: `h${number}`,
        isDraft: false,
      }))));
    }
    calls.settled++;
    return Promise.resolve(JSON.stringify([{
      number: 900 + calls.settled,
      title: "done",
      mergedAt: "2026-09-01T00:00:00Z",
      closedAt: "2026-09-01T00:00:00Z",
      body: "",
      headRefName: "h",
    }]));
  };
  return { gh, calls };
}

async function withCache<T>(fn: (cache: IssueCache) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "settled-2409-" });
  try {
    // A zero default TTL: the open listing is always re-read, so each test
    // states the open set it means rather than inheriting a cached one.
    return await fn(new IssueCache(dir, 0));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

for (
  const [name, fetchSettled] of [
    [
      "closed",
      (c: IssueCache, gh: (a: string[]) => Promise<string>, now: number) =>
        fetchClosedPRsByUser(REPO, USER, 100, c, gh, () => now),
    ],
    [
      "merged",
      (c: IssueCache, gh: (a: string[]) => Promise<string>, now: number) =>
        fetchMergedPRsByUser(REPO, USER, c, 30, gh, () => now),
    ],
  ] as const
) {
  Deno.test(`${name} listing - past ten minutes, every open PR still open: no refetch (Issue #2409)`, async () => {
    await withCache(async (cache) => {
      const state = { open: [5, 6] };
      const { gh, calls } = fakeGh(state);
      await fetchSettled(cache, gh, 1_000);
      await fetchSettled(cache, gh, 1_000 + 30 * MINUTE);
      assertEquals(calls.settled, 1);
    });
  });

  Deno.test(`${name} listing - an open PR has gone: it may have merged or closed, so refetch (Issue #2409)`, async () => {
    await withCache(async (cache) => {
      const state = { open: [5, 6] };
      const { gh, calls } = fakeGh(state);
      await fetchSettled(cache, gh, 1_000);
      state.open = [6];
      await fetchSettled(cache, gh, 1_000 + 2 * MINUTE);
      assertEquals(calls.settled, 2, "even inside the first ten minutes");
    });
  });

  Deno.test(`${name} listing - a PR opened after caching is remembered, and refetched for when it goes (Issue #2409)`, async () => {
    await withCache(async (cache) => {
      const state = { open: [5] };
      const { gh, calls } = fakeGh(state);
      await fetchSettled(cache, gh, 1_000);
      state.open = [5, 9]; // #9 opens …
      await fetchSettled(cache, gh, 1_000 + 3 * MINUTE);
      assertEquals(calls.settled, 1);
      state.open = [5]; // … and is gone by the next scan.
      await fetchSettled(cache, gh, 1_000 + 6 * MINUTE);
      assertEquals(calls.settled, 2);
    });
  });

  Deno.test(`${name} listing - older than an hour is refetched whatever the open set says (Issue #2409)`, async () => {
    await withCache(async (cache) => {
      const { gh, calls } = fakeGh({ open: [5] });
      await fetchSettled(cache, gh, 1_000);
      await fetchSettled(cache, gh, 1_000 + 61 * MINUTE);
      assertEquals(calls.settled, 2);
    });
  });

  Deno.test(`${name} listing - an open set that cannot be read proves nothing, so refetch past ten minutes (Issue #2409)`, async () => {
    await withCache(async (cache) => {
      const state: { open: number[]; openFails?: boolean } = { open: [5] };
      const { gh, calls } = fakeGh(state);
      await fetchSettled(cache, gh, 1_000);
      state.openFails = true;
      await fetchSettled(cache, gh, 1_000 + 30 * MINUTE);
      assertEquals(calls.settled, 2);
    });
  });

  Deno.test(`${name} listing - a full open listing is truncated and proves nothing (Issue #2409)`, async () => {
    await withCache(async (cache) => {
      const ten = Array.from({ length: 10 }, (_, i) => i + 1);
      const { gh, calls } = fakeGh({ open: ten });
      await fetchSettled(cache, gh, 1_000);
      await fetchSettled(cache, gh, 1_000 + 30 * MINUTE);
      assertEquals(calls.settled, 2);
    });
  });

  Deno.test(`${name} listing - without a cache every call lists, exactly as before (Issue #2409)`, async () => {
    const { gh, calls } = fakeGh({ open: [] });
    await (name === "closed"
      ? fetchClosedPRsByUser(REPO, USER, 100, undefined, gh)
      : fetchMergedPRsByUser(REPO, USER, undefined, 30, gh));
    await (name === "closed"
      ? fetchClosedPRsByUser(REPO, USER, 100, undefined, gh)
      : fetchMergedPRsByUser(REPO, USER, undefined, 30, gh));
    assertEquals(calls.settled, 2);
    assertEquals(calls.open, 0, "no cache means no open-set bookkeeping");
  });
}
