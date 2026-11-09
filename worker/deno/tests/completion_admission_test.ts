import { assertEquals } from "@std/assert";
import {
  admitCompletionWork,
  type CompletionPolicy,
  type CompletionSnapshot,
  type CompletionState,
  type CompletionStore,
} from "../lib/completion_admission.ts";

const policy: CompletionPolicy = { high: 4, low: 2 };

function fixture() {
  let state: CompletionState | undefined;
  let pending = Promise.resolve();
  const snapshot: CompletionSnapshot = { prs: [], liveClaims: new Set() };
  const store: CompletionStore = {
    transaction: (fn) => {
      const result = pending.then(async () => {
        const next = await fn(state, snapshot);
        state = next.state;
        return next.value;
      });
      pending = result.then(() => {}, () => {});
      return result;
    },
  };
  return { store, snapshot, state: () => state };
}

const request = (issue: number, base = "main") => ({
  issue,
  base,
  claimId: issue * 100,
  workerId: `mac-${issue}`,
});

Deno.test("completion admission: competing Macs share four reservations", async () => {
  const f = fixture();
  for (let issue = 1; issue <= 8; issue++) {
    f.snapshot.liveClaims.add(issue * 100);
  }
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      (_, i) => admitCompletionWork(f.store, policy, request(i + 1)),
    ),
  );
  assertEquals(results.filter((r) => r.allowed).length, 4);
  assertEquals(f.state()?.reservations.length, 4);
  assertEquals(results.at(-1)?.mode, "complete");
});

Deno.test("completion admission: claim to draft conversion retains one slot and hysteresis", async () => {
  const f = fixture();
  for (let issue = 1; issue <= 4; issue++) {
    f.snapshot.liveClaims.add(issue * 100);
    await admitCompletionWork(f.store, policy, request(issue));
  }
  f.snapshot.prs.push({
    number: 50,
    base: "main",
    issues: [1],
    draft: true,
    recoveryIssues: [],
  });
  f.snapshot.liveClaims.delete(100);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(5))).pressure,
    4,
  );
  f.snapshot.liveClaims.delete(200);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(5))).allowed,
    false,
  );
  // Resuming the existing draft needs no extra slot.
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(1))).allowed,
    true,
  );
  f.snapshot.liveClaims.delete(300);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(5))).allowed,
    true,
  );
});

Deno.test("completion admission: human and milestone integration PRs consume default capacity", async () => {
  const f = fixture();
  f.snapshot.prs = [1, 2, 3, 4].map((number) => ({
    number,
    base: "main",
    issues: [],
    draft: false,
    recoveryIssues: [],
  }));
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(5))).allowed,
    false,
  );
  // Milestone children have a separate one-change stream.
  f.snapshot.liveClaims.add(600);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(6, "milestone/x")))
      .allowed,
    true,
  );
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(7, "milestone/x")))
      .allowed,
    false,
  );
});

Deno.test("completion admission: one bounded dependency repair, no priority bypass", async () => {
  const f = fixture();
  f.snapshot.prs = [1, 2, 3, 4].map((number) => ({
    number,
    base: "main",
    issues: [],
    draft: false,
    recoveryIssues: [10, 11],
  }));
  f.snapshot.liveClaims.add(1000);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(9))).allowed,
    false,
  );
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(10))).allowed,
    true,
  );
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(11))).allowed,
    false,
  );
  // Crash recovery releases the reservation using the existing issue heartbeat.
  f.snapshot.liveClaims.delete(1000);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(11))).allowed,
    true,
  );
});

Deno.test("completion admission: a ready PR cannot start a duplicate implementation", async () => {
  const f = fixture();
  f.snapshot.prs = [{
    number: 50,
    base: "main",
    issues: [1],
    draft: false,
    recoveryIssues: [],
  }];
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(1))).allowed,
    false,
  );
});

Deno.test("completion admission: shared policy disagreement refuses new work", async () => {
  const f = fixture();
  await admitCompletionWork(f.store, policy);
  assertEquals(
    (await admitCompletionWork(f.store, { high: 8, low: 4 }, request(1)))
      .allowed,
    false,
  );
});

Deno.test("completion admission: an inherited oversized backlog can admit one blocking repair until its PR lands", async () => {
  const f = fixture();
  f.snapshot.prs = Array.from(
    { length: 20 },
    (_, i) => ({
      number: i + 1,
      base: "main",
      issues: [],
      draft: false,
      recoveryIssues: [100, 101],
    }),
  );
  f.snapshot.liveClaims.add(10000);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(100))).allowed,
    true,
  );
  f.snapshot.prs.push({
    number: 200,
    base: "main",
    issues: [100],
    draft: false,
    recoveryIssues: [],
  });
  f.snapshot.liveClaims.delete(10000);
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(101))).allowed,
    false,
  );
  f.snapshot.prs.pop();
  assertEquals(
    (await admitCompletionWork(f.store, policy, request(101))).allowed,
    true,
  );
});
