import { assertEquals } from "@std/assert";
import {
  acquireBaseRefreshOwner,
  type BaseRefreshOwnershipPort,
  reconcileBaseRefreshOwner,
  releaseBaseRefreshOwner,
} from "../lib/base_refresh_ownership_4613.ts";

function sharedPort(now = 100): BaseRefreshOwnershipPort {
  const records: Array<{
    id: string;
    repo: string;
    base: string;
    prNumber: number;
    headSha: string;
    workerId: string;
    expiresAt: number;
  }> = [];
  let nextId = 1;
  let clock = now;
  const locks = new Map<string, Promise<void>>();
  return {
    now: () => clock,
    setNow: (value) => clock = value,
    withBaseLock: async (repo, base, fn) => {
      const key = `${repo}:${base}`;
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => release = resolve);
      locks.set(key, previous.then(() => current));
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    read: async (repo, base) =>
      records.filter((r) => r.repo === repo && r.base === base),
    write: async (record) => {
      const id = String(nextId++);
      records.push({ ...record, id });
      return id;
    },
    remove: async (id) => {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) records.splice(index, 1);
    },
  };
}

Deno.test("base refresh owner serialises lanes and releases for the next PR", async () => {
  const port = sharedPort();
  const input = (prNumber: number, workerId: string, sha: string) => ({
    repo: "owner/repo",
    base: "main",
    prNumber,
    headSha: sha.repeat(40),
    workerId,
    ttlSeconds: 60,
  });
  const results = await Promise.all([
    acquireBaseRefreshOwner(port, input(10, "host-a", "a")),
    acquireBaseRefreshOwner(port, input(11, "host-b", "b")),
  ]);
  assertEquals(results.filter((result) => result.acquired).length, 1);
  const winnerIndex = results.findIndex((result) => result.acquired);
  const winner = results[winnerIndex]!;
  const loser = results[1 - winnerIndex]!;
  if (!winner.acquired || loser.acquired) {
    throw new Error("ownership race did not select one lane");
  }
  assertEquals(loser.reason, "owned");
  assertEquals(loser.ownerPrNumber, winnerIndex === 0 ? 10 : 11);
  await releaseBaseRefreshOwner(port, "owner/repo", "main", winner.ownerId);
  assertEquals(
    await acquireBaseRefreshOwner(port, {
      repo: "owner/repo",
      base: "main",
      prNumber: winnerIndex === 0 ? 11 : 10,
      headSha: (winnerIndex === 0 ? "b" : "a").repeat(40),
      workerId: winnerIndex === 0 ? "host-b" : "host-a",
      ttlSeconds: 60,
    }),
    { acquired: true, ownerId: "2" },
  );
});

Deno.test("base refresh ownership is scoped by repository and base", async () => {
  const port = sharedPort();
  await acquireBaseRefreshOwner(port, {
    repo: "owner/repo",
    base: "main",
    prNumber: 10,
    headSha: "a".repeat(40),
    workerId: "host-a",
    ttlSeconds: 60,
  });
  assertEquals(
    await acquireBaseRefreshOwner(port, {
      repo: "owner/repo",
      base: "release",
      prNumber: 12,
      headSha: "c".repeat(40),
      workerId: "host-b",
      ttlSeconds: 60,
    }),
    { acquired: true, ownerId: "2" },
  );
});

Deno.test("base refresh ownership expires and can be reconciled", async () => {
  const port = sharedPort();
  await acquireBaseRefreshOwner(port, {
    repo: "owner/repo",
    base: "main",
    prNumber: 10,
    headSha: "a".repeat(40),
    workerId: "host-a",
    ttlSeconds: 10,
  });
  port.setNow(111);
  assertEquals(
    await reconcileBaseRefreshOwner(port, "owner/repo", "main", () => "active"),
    { released: true, reason: "expired" },
  );
});

Deno.test("base refresh owner releases after failure, merge, or closure", async () => {
  for (const status of ["failed", "merged", "closed"] as const) {
    const port = sharedPort();
    await acquireBaseRefreshOwner(port, {
      repo: "owner/repo",
      base: "main",
      prNumber: 10,
      headSha: "a".repeat(40),
      workerId: "host-a",
      ttlSeconds: 60,
    });
    assertEquals(
      await reconcileBaseRefreshOwner(port, "owner/repo", "main", () => status),
      { released: true, reason: status },
    );
  }
});
