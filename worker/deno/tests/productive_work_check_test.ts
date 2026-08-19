/**
 * Tests for the productive-work detector (Issue #2476).
 *
 * The detector returns the most-recent "productive work" epoch for a repo —
 * the MAX across a PR opened, a PR merged, or a commit pushed to the default
 * branch. Part of the combined liveness guard (#2472).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";

import { latestProductiveWorkEpoch } from "../lib/productive_work_check.ts";

/** Unix seconds for a fixed ISO timestamp, for readable assertions. */
function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/**
 * Build a gh stub that dispatches on the command shape:
 *   - `pr list ... --state all`    → PR createdAt source
 *   - `pr list ... --state merged` → PR mergedAt source
 *   - `api repos/.../commits`      → default-branch commit source
 */
function makeGhStub(responses: {
  prAll?: string;
  prMerged?: string;
  commits?: string;
}) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "api") {
      return Promise.resolve(responses.commits ?? "[]");
    }
    if (args.includes("merged")) {
      return Promise.resolve(responses.prMerged ?? "[]");
    }
    return Promise.resolve(responses.prAll ?? "[]");
  };
  return { fn, calls };
}

// Fixed clock well after every fixture timestamp.
const NOW = epoch("2026-06-02T00:00:00Z");
const nowFn = () => NOW;

Deno.test(
  "latestProductiveWorkEpoch - returns the MAX across all three sources",
  async () => {
    const stub = makeGhStub({
      prAll: JSON.stringify([{ createdAt: "2026-01-01T00:00:00Z" }]),
      prMerged: JSON.stringify([{ mergedAt: "2026-03-15T12:00:00Z" }]),
      commits: JSON.stringify([
        { commit: { committer: { date: "2026-02-10T08:00:00Z" } } },
      ]),
    });

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: stub.fn,
      nowFn,
    });

    // PR merged (March) is the most recent of the three.
    assertEquals(result.repo, "org/repo");
    assertEquals(result.lastProductiveEpoch, epoch("2026-03-15T12:00:00Z"));
  },
);

Deno.test(
  "latestProductiveWorkEpoch - the commit source can win the max",
  async () => {
    const stub = makeGhStub({
      prAll: JSON.stringify([{ createdAt: "2026-01-01T00:00:00Z" }]),
      prMerged: JSON.stringify([{ mergedAt: "2026-01-02T00:00:00Z" }]),
      commits: JSON.stringify([
        { commit: { committer: { date: "2026-05-30T23:00:00Z" } } },
        { commit: { committer: { date: "2026-01-01T00:00:00Z" } } },
      ]),
    });

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: stub.fn,
      nowFn,
    });

    assertEquals(result.lastProductiveEpoch, epoch("2026-05-30T23:00:00Z"));
  },
);

Deno.test(
  "latestProductiveWorkEpoch - returns null when all sources are empty",
  async () => {
    const stub = makeGhStub({ prAll: "[]", prMerged: "[]", commits: "[]" });

    const result = await latestProductiveWorkEpoch({
      repo: "org/empty",
      ghCommandFn: stub.fn,
      nowFn,
    });

    assertEquals(result.lastProductiveEpoch, null);
  },
);

Deno.test(
  "latestProductiveWorkEpoch - tolerates malformed JSON from one source",
  async () => {
    const stub = makeGhStub({
      prAll: "not json at all {{{",
      prMerged: JSON.stringify([{ mergedAt: "2026-04-01T00:00:00Z" }]),
      commits: "[]",
    });

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: stub.fn,
      nowFn,
    });

    // The malformed source is ignored; the merged PR still produces a value.
    assertEquals(result.lastProductiveEpoch, epoch("2026-04-01T00:00:00Z"));
  },
);

Deno.test(
  "latestProductiveWorkEpoch - returns null when every source fails to parse",
  async () => {
    const stub = makeGhStub({
      prAll: "broken",
      prMerged: "{also broken",
      commits: "<<<not json",
    });

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: stub.fn,
      nowFn,
    });

    assertEquals(result.lastProductiveEpoch, null);
  },
);

Deno.test(
  "latestProductiveWorkEpoch - treats a gh failure as no signal (null)",
  async () => {
    const fn = (_args: string[]): Promise<string> =>
      Promise.reject(new Error("gh exploded"));

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: fn,
      nowFn,
    });

    assertEquals(result.lastProductiveEpoch, null);
  },
);

Deno.test(
  "latestProductiveWorkEpoch - a single failing source does not sink the others",
  async () => {
    const fn = (args: string[]): Promise<string> => {
      if (args[0] === "api") {
        return Promise.reject(new Error("commits endpoint down"));
      }
      if (args.includes("merged")) {
        return Promise.resolve("[]");
      }
      return Promise.resolve(
        JSON.stringify([{ createdAt: "2026-02-20T00:00:00Z" }]),
      );
    };

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: fn,
      nowFn,
    });

    assertEquals(result.lastProductiveEpoch, epoch("2026-02-20T00:00:00Z"));
  },
);

Deno.test(
  "latestProductiveWorkEpoch - discards future-dated timestamps (clock skew)",
  async () => {
    const stub = makeGhStub({
      // A garbage future date that would otherwise dominate the max.
      prAll: JSON.stringify([{ createdAt: "2099-01-01T00:00:00Z" }]),
      prMerged: JSON.stringify([{ mergedAt: "2026-05-01T00:00:00Z" }]),
      commits: "[]",
    });

    const result = await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: stub.fn,
      nowFn,
    });

    // The future PR-created date is ignored; the merged PR wins.
    assertEquals(result.lastProductiveEpoch, epoch("2026-05-01T00:00:00Z"));
  },
);

Deno.test(
  "latestProductiveWorkEpoch - issues the expected gh queries",
  async () => {
    const stub = makeGhStub({ prAll: "[]", prMerged: "[]", commits: "[]" });

    await latestProductiveWorkEpoch({
      repo: "org/repo",
      ghCommandFn: stub.fn,
      nowFn,
    });

    // Three sources probed: PR all, PR merged, commits.
    assertEquals(stub.calls.length, 3);
    const flat = stub.calls.map((c) => c.join(" "));
    assertEquals(
      flat.some((c) =>
        c.includes("pr list") && c.includes("all") && c.includes("createdAt")
      ),
      true,
    );
    assertEquals(
      flat.some((c) =>
        c.includes("pr list") && c.includes("merged") &&
        c.includes("mergedAt")
      ),
      true,
    );
    assertEquals(
      flat.some((c) =>
        c.includes("api") && c.includes("repos/org/repo/commits")
      ),
      true,
    );
  },
);
