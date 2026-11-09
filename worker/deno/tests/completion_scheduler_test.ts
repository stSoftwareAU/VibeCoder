import { assertEquals } from "@std/assert";
import { createCompletionScheduler } from "../lib/completion_scheduler.ts";
import type {
  CompletionState,
  CompletionStore,
} from "../lib/completion_admission.ts";
import type { IssueCandidate } from "../lib/issue_priority.ts";

Deno.test("completion scheduling dispatches repair, holds new work and leaves other repositories eligible", async () => {
  let state: CompletionState | undefined;
  const prs = [1, 2, 3, 4].map((number) => ({
    number,
    base: "main",
    issues: [],
    draft: false,
    recoveryIssues: [],
  }));
  const store: CompletionStore = {
    transaction: async (fn) => {
      const result = await fn(state, { prs, liveClaims: new Set() });
      state = result.state;
      return result.value;
    },
  };
  let now = 0;
  const repairs: string[] = [];
  const scheduler = createCompletionScheduler({
    policies: new Map([["owner/busy", { high: 4, low: 2 }]]),
    store: () => store,
    defaultBranch: async () => "main",
    now: () => now,
    log: () => {},
    repair: async (repo) => {
      repairs.push(repo);
      return true;
    },
  });
  const candidate = {
    repo: "owner/busy",
    number: 9,
    milestone: "",
  } as IssueCandidate;
  assertEquals(
    await scheduler.gate(candidate),
    "completion mode: finish existing PRs",
  );
  assertEquals(
    await scheduler.gate({ ...candidate, repo: "owner/other" }),
    undefined,
  );
  assertEquals(await scheduler.process(), true);
  assertEquals(repairs, ["owner/busy"]);
  assertEquals(await scheduler.process(), false); // No hot-loop repair rerun.
  prs.splice(0, 2);
  now = 31_000;
  assertEquals(await scheduler.gate(candidate), undefined);
  assertEquals(await scheduler.process(), false);
});

Deno.test("completion scheduling retries unavailable capacity without freezing other repositories", async () => {
  let fail = true, now = 0;
  const scheduler = createCompletionScheduler({
    policies: new Map([["owner/busy", { high: 4, low: 2 }]]),
    store: () => ({
      transaction: async (fn) => {
        if (fail) throw new Error("GitHub unavailable");
        return (await fn(undefined, { prs: [], liveClaims: new Set() })).value;
      },
    }),
    defaultBranch: async () => "main",
    now: () => now,
    log: () => {},
    repair: async () => false,
  });
  const candidate = {
    repo: "owner/busy",
    number: 9,
    milestone: "",
  } as IssueCandidate;
  assertEquals(
    (await scheduler.gate(candidate))?.includes("GitHub unavailable"),
    true,
  );
  assertEquals(
    await scheduler.gate({ ...candidate, repo: "owner/other" }),
    undefined,
  );
  fail = false;
  now = 31_000;
  assertEquals(await scheduler.gate(candidate), undefined);
});
