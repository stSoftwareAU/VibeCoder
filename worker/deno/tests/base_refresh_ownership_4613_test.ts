import { assertEquals, assertRejects } from "@std/assert";
import { acquireBranchUpdateLock } from "../lib/pr_branch_lock.ts";
import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";
import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";
import {
  acquireBaseRefreshOwner,
  type BaseRefreshOwnershipPort,
  makeGitHubBaseRefreshOwnershipPort,
  reconcileBaseRefreshOwner,
  releaseBaseRefreshOwner,
} from "../lib/base_refresh_ownership_4613.ts";

Deno.test("a refused duplicate PUT leaves ownership blocking the next PR", async () => {
  const f = strictRefreshFixture();
  const request = (number: number) =>
    requestReadyBranchUpdate(
      "owner/repo",
      number,
      f.gh,
      "main",
      f.head,
      async () => {},
      { fleetAuthors: ["VibeCoderST"] },
      "test-ready-updater",
    );
  assertEquals((await request(30)).ok, true);
  f.state.refusal = "HTTP 422: expected head sha changed";
  assertEquals((await request(30)).ok, false);
  const next = await request(31);
  assertEquals(next.ok, false);
  if (!next.ok) {
    assertEquals(
      next.error.message.includes("base refresh owned by owner/repo#30"),
      true,
    );
  }
  assertEquals(f.calls.filter((args) => args.includes("PUT")).length, 2);
});

Deno.test("base transaction on the anchor preserves an older live PR lock", async () => {
  const f = strictRefreshFixture();
  const now = Math.floor(Date.now() / 1000);
  const lock = await acquireBranchUpdateLock({
    repo: "owner/repo",
    prNumber: 1,
    workerId: "repair",
    nowFn: () => now - 90,
    ghCommandFn: f.gh,
    sleepFn: async () => {},
    authorOptions: { fleetAuthors: ["VibeCoderST"] },
  });
  if (!lock.ok || !lock.value.acquired) throw new Error("PR lock not acquired");
  const port = makeGitHubBaseRefreshOwnershipPort({
    workerId: "refresh",
    ghCommandFn: f.gh,
    sleepFn: async () => {},
    authorOptions: { fleetAuthors: ["VibeCoderST"] },
    anchorPrForBase: async () => 1,
  });
  const owner = await acquireBaseRefreshOwner(port, {
    repo: "owner/repo",
    base: "main",
    prNumber: 1,
    headSha: f.head,
    workerId: "refresh",
    ttlSeconds: 60,
  });
  assertEquals(owner.acquired, true);
  assertEquals(
    f.comments.some((row) => row.id === lock.value.lockCommentId),
    true,
  );
});

Deno.test("failed same-PR reacquisition retains the successful refresh owner", async () => {
  const port = sharedPort();
  const input = {
    repo: "owner/repo",
    base: "main",
    prNumber: 30,
    headSha: "a".repeat(40),
    workerId: "host-a",
    ttlSeconds: 60,
  };
  const first = await acquireBaseRefreshOwner(port, input);
  const second = await acquireBaseRefreshOwner(port, {
    ...input,
    workerId: "host-b",
  });
  if (!first.acquired || !second.acquired) {
    throw new Error("acquisition failed");
  }
  await releaseBaseRefreshOwner(port, input.repo, input.base, second.ownerId);
  assertEquals((await port.read(input.repo, input.base)).map((r) => r.id), [
    first.ownerId,
  ]);
  assertEquals(
    (await acquireBaseRefreshOwner(port, { ...input, prNumber: 31 })).acquired,
    false,
  );
});

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
  if (!port.setNow) throw new Error("test port has no clock setter");
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

Deno.test("GitHub comment ownership serialises independent host ports", async () => {
  const comments = new Map<
    number,
    Array<{
      id: number;
      body: string;
      author: string;
      created_at: string;
    }>
  >();
  let nextId = 1;
  let barrierEnabled = true;
  let arrivals = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => releaseBarrier = resolve);
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "comment") {
      const prNumber = Number(args[2]);
      const rows = comments.get(prNumber) ?? [];
      const id = nextId++;
      rows.push({
        id,
        body: args[args.indexOf("--body") + 1]!,
        author: "VibeCoderST",
        created_at: new Date(id * 1000).toISOString(),
      });
      comments.set(prNumber, rows);
      return `https://github.com/owner/repo/issues/${prNumber}#issuecomment-${id}`;
    }
    if (args[0] === "api" && args[1]?.includes("/comments?")) {
      const prNumber = Number(args[1].split("/issues/")[1]?.split("/")[0]);
      return JSON.stringify((comments.get(prNumber) ?? []).map((row) => ({
        ...row,
      })));
    }
    if (args[0] === "api" && args.includes("DELETE")) {
      const id = Number(args.at(-1)?.split("/").at(-1));
      for (const [prNumber, rows] of comments) {
        comments.set(prNumber, rows.filter((row) => row.id !== id));
      }
      return "";
    }
    throw new Error(
      `Unexpected GitHub ownership command: ${args.slice(0, 3).join(" ")}`,
    );
  };
  const makePort = (workerId: string) =>
    makeGitHubBaseRefreshOwnershipPort({
      workerId,
      ghCommandFn: gh,
      sleepFn: async () => {
        if (!barrierEnabled) return;
        arrivals++;
        if (arrivals === 2) releaseBarrier();
        await barrier;
      },
      authorOptions: { fleetAuthors: ["VibeCoderST"] },
      anchorPrForBase: async () => 1,
    });
  const hostA = makePort("host-a");
  const hostB = makePort("host-b");
  const results = await Promise.allSettled([
    acquireBaseRefreshOwner(hostA, {
      repo: "owner/repo",
      base: "main",
      prNumber: 10,
      headSha: "a".repeat(40),
      workerId: "host-a",
      ttlSeconds: 60,
    }),
    acquireBaseRefreshOwner(hostB, {
      repo: "owner/repo",
      base: "main",
      prNumber: 11,
      headSha: "b".repeat(40),
      workerId: "host-b",
      ttlSeconds: 60,
    }),
  ]);
  barrierEnabled = false;
  const winners = results.filter((result) =>
    result.status === "fulfilled" && result.value.acquired
  );
  assertEquals(winners.length, 1);
  const winnerResult = winners[0];
  if (
    !winnerResult || winnerResult.status !== "fulfilled" ||
    !winnerResult.value.acquired
  ) {
    throw new Error("GitHub ownership race did not select one host");
  }
  assertEquals(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  const winner = winnerResult.value;
  // The transaction lock is gone; persisted ownership must still exclude a host.
  assertEquals(
    (await acquireBaseRefreshOwner(hostB, {
      repo: "owner/repo",
      base: "main",
      prNumber: 99,
      headSha: "f".repeat(40),
      workerId: "host-b",
      ttlSeconds: 60,
    })).acquired,
    false,
  );
  const unresolved = makeGitHubBaseRefreshOwnershipPort({
    workerId: "unresolved",
    ghCommandFn: gh,
    sleepFn: async () => {},
    authorOptions: { fleetAuthors: [] },
    anchorPrForBase: async () => 1,
  });
  await assertRejects(
    () =>
      acquireBaseRefreshOwner(unresolved, {
        repo: "owner/repo",
        base: "main",
        prNumber: 99,
        headSha: "f".repeat(40),
        workerId: "unresolved",
        ttlSeconds: 60,
      }),
    Error,
    "fleet author set unresolved",
  );
  await releaseBaseRefreshOwner(
    results[0]?.status === "fulfilled" && results[0].value.acquired
      ? hostA
      : hostB,
    "owner/repo",
    "main",
    winner.ownerId,
  );
  assertEquals(
    (await acquireBaseRefreshOwner(
      results[0]?.status === "fulfilled" && results[0].value.acquired
        ? hostB
        : hostA,
      {
        repo: "owner/repo",
        base: "main",
        prNumber:
          results[0]?.status === "fulfilled" && results[0].value.acquired
            ? 11
            : 10,
        headSha: results[0]?.status === "fulfilled" && results[0].value.acquired
          ? "b".repeat(40)
          : "a".repeat(40),
        workerId:
          results[0]?.status === "fulfilled" && results[0].value.acquired
            ? "host-b"
            : "host-a",
        ttlSeconds: 60,
      },
    )).acquired,
    true,
  );
  assertEquals(
    (await acquireBaseRefreshOwner(hostB, {
      repo: "owner/repo",
      base: "release",
      prNumber: 20,
      headSha: "c".repeat(40),
      workerId: "host-b",
      ttlSeconds: 60,
    })).acquired,
    true,
  );
});
