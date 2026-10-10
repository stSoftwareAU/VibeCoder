/**
 * Tests for auto-merge-follows-the-base (Issue #3433).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkPrBaseIntegrity,
  decidePrBaseIntegrity,
  MILESTONE_FIX_RETARGETED_MARKER,
  milestoneFixRetargetedFinalPrMarker,
  MOVED_ONTO_DEFAULT_MARKER,
  type PrBaseIntegrityReading,
  readPrBaseIntegrity,
} from "../lib/pr_base_integrity.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";

const FIX_HEAD = "milestone-fix/m1/pr-77-abc";
const AUTHORS = { fleetAuthors: ["bot"] };

function reading(
  over: Partial<PrBaseIntegrityReading> = {},
): PrBaseIntegrityReading {
  return {
    defaultBranch: "main",
    headRefName: "issue-5-x",
    baseRefName: "main",
    armedAt: null,
    lastBaseChange: null,
    ...over,
  };
}

function payload(r: PrBaseIntegrityReading): string {
  return JSON.stringify({
    data: {
      repository: {
        defaultBranchRef: { name: r.defaultBranch },
        pullRequest: {
          headRefName: r.headRefName,
          baseRefName: r.baseRefName,
          autoMergeRequest: r.armedAt ? { enabledAt: r.armedAt } : null,
          timelineItems: {
            nodes: r.lastBaseChange
              ? [{
                createdAt: r.lastBaseChange.at,
                previousRefName: r.lastBaseChange.from,
                currentRefName: r.lastBaseChange.to,
              }]
              : [],
          },
        },
      },
    },
  });
}

/** Fake gh: serves the read, and records everything else. */
function fakeGh(
  r: PrBaseIntegrityReading | Error,
  markersPresent: string[] = [],
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      return r instanceof Error
        ? Promise.reject(r)
        : Promise.resolve(payload(r));
    }
    if (args[0] === "api") {
      // Comment listing for marker de-duplication, authored by the fleet.
      return Promise.resolve(
        JSON.stringify(
          markersPresent.map((m) => ({ author: "bot", body: m })),
        ),
      );
    }
    return Promise.resolve("");
  };
  return { gh, calls };
}

const disarms = (calls: string[][]) =>
  calls.filter((c) => c.includes("--disable-auto"));
const comments = (calls: string[][]) =>
  calls.filter((c) => c[0] === "pr" && c[1] === "comment");

Deno.test("decide: milestone-fix head off a milestone branch is mistargeted", () => {
  assertEquals(
    decidePrBaseIntegrity(reading({ headRefName: FIX_HEAD })),
    { kind: "mistargeted-milestone-fix" },
  );
});

Deno.test("decide: milestone-fix head on a milestone branch is ok", () => {
  assertEquals(
    decidePrBaseIntegrity(
      reading({ headRefName: FIX_HEAD, baseRefName: "milestone/x" }),
    ),
    { kind: "ok" },
  );
});

Deno.test("decide: a PR moved onto the default branch is held", () => {
  assertEquals(
    decidePrBaseIntegrity(reading({
      lastBaseChange: {
        at: "2026-01-01T00:00:00Z",
        from: "milestone/x",
        to: "main",
      },
    })),
    { kind: "moved-onto-default" },
  );
});

Deno.test("decide: a sync PR moved onto the default branch is left to the #1967 path", () => {
  assertEquals(
    decidePrBaseIntegrity(reading({
      headRefName: "sync/milestone-x",
      lastBaseChange: {
        at: "2026-01-01T00:00:00Z",
        from: "milestone/x",
        to: "main",
      },
    })).kind,
    "ok",
  );
});

Deno.test("decide: a base change after arming is flagged; before arming is ok", () => {
  const change = (at: string) => ({
    at,
    from: "milestone/a",
    to: "milestone/b",
  });
  assertEquals(
    decidePrBaseIntegrity(reading({
      baseRefName: "milestone/b",
      armedAt: "2026-01-01T00:00:00Z",
      lastBaseChange: change("2026-01-02T00:00:00Z"),
    })),
    { kind: "base-changed-since-armed" },
  );
  assertEquals(
    decidePrBaseIntegrity(reading({
      baseRefName: "milestone/b",
      armedAt: "2026-01-03T00:00:00Z",
      lastBaseChange: change("2026-01-02T00:00:00Z"),
    })),
    { kind: "ok" },
  );
});

Deno.test("the integrity query is classified as a read, not a mutation", async () => {
  const { gh, calls } = fakeGh(reading());
  await readPrBaseIntegrity("o/r", 5, gh);
  assertEquals(classifyGhMutation(calls[0]!), null);
});

Deno.test("read: malformed payloads and bad repos throw", async () => {
  await assertRejects(() =>
    readPrBaseIntegrity("o/r", 5, () => Promise.resolve("{}"))
  );
  await assertRejects(() =>
    readPrBaseIntegrity("o/r", 5, () => Promise.resolve("nope"))
  );
  await assertRejects(() =>
    readPrBaseIntegrity("o r;x", 5, () => Promise.resolve("{}"))
  );
});

Deno.test("check: a retargeted milestone-fix PR is disarmed, commented twice and held", async () => {
  const { gh, calls } = fakeGh(reading({ headRefName: FIX_HEAD }));
  const logs: string[] = [];
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: (m) => logs.push(m),
    authorOptions: AUTHORS,
  });
  assertEquals(out.action, "hold");
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(disarms(calls).length, 1);
  const posted = comments(calls);
  assertEquals(posted.map((c) => c[2]), ["9", "77"]);
  assert(posted[0]![6]!.includes(MILESTONE_FIX_RETARGETED_MARKER));
  assert(posted[1]![6]!.includes(milestoneFixRetargetedFinalPrMarker(9)));
  assert(logs.some((l) => l.includes("[MILESTONE_FIX_RETARGETED]")));
});

Deno.test("check: existing fleet markers suppress both comments", async () => {
  const { gh, calls } = fakeGh(reading({ headRefName: FIX_HEAD }), [
    MILESTONE_FIX_RETARGETED_MARKER,
    milestoneFixRetargetedFinalPrMarker(9),
  ]);
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assertEquals(out.action, "hold");
  assertEquals(comments(calls), []);
  assertEquals(disarms(calls).length, 1);
});

Deno.test("check: a PR moved onto the default branch is disarmed, commented once and held", async () => {
  const { gh, calls } = fakeGh(reading({
    lastBaseChange: {
      at: "2026-01-01T00:00:00Z",
      from: "milestone/x",
      to: "main",
    },
  }));
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: "issue-5-x", baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(disarms(calls).length, 1);
  const posted = comments(calls);
  assertEquals(posted.length, 1);
  assert(posted[0]![6]!.includes(MOVED_ONTO_DEFAULT_MARKER));
});

Deno.test("check: a base change since arming disarms and proceeds as disarmed", async () => {
  const { gh, calls } = fakeGh(reading({
    baseRefName: "milestone/b",
    armedAt: "2026-01-01T00:00:00Z",
    lastBaseChange: {
      at: "2026-01-02T00:00:00Z",
      from: "milestone/a",
      to: "milestone/b",
    },
  }));
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: "issue-5-x", baseRefName: "milestone/b" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assertEquals(out, { action: "proceed", disarmed: true });
  assertEquals(disarms(calls).length, 1);
  assertEquals(comments(calls), []);
});

Deno.test("check: a read failure defers, and never disarms or merges", async () => {
  const { gh, calls } = fakeGh(new Error("rate limited"));
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assert(out.action === "hold");
  if (out.action === "hold") {
    assertEquals(out.outcome.result, AutoMergeResult.Deferred);
    assert(out.outcome.message.includes("rate limited"));
    assert(out.outcome.message.includes("#3433"));
  }
  assertEquals(calls.length, 1);
});

Deno.test("check: an unarmed non-fix PR on a milestone base makes no gh call", async () => {
  const { gh, calls } = fakeGh(reading());
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: "issue-5-x", baseRefName: "milestone/x" },
    armed: false,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assertEquals(out, { action: "proceed", disarmed: false });
  assertEquals(calls, []);
});

Deno.test("check: a base change since arming holds as deferred when the disarm fails (Issue #3433)", async () => {
  const inner = fakeGh(reading({
    baseRefName: "milestone/b",
    armedAt: "2026-01-01T00:00:00Z",
    lastBaseChange: {
      at: "2026-01-02T00:00:00Z",
      from: "milestone/a",
      to: "milestone/b",
    },
  }));
  const gh = (args: string[]): Promise<string> =>
    args.includes("--disable-auto")
      ? Promise.reject(new Error("boom"))
      : inner.gh(args);
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: "issue-5-x", baseRefName: "milestone/b" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assert(out.action === "hold");
  assertEquals(out.outcome.result, AutoMergeResult.Deferred);
  assert(out.outcome.message.includes("disarming failed"));
  assert(out.outcome.message.includes("#3433"));
});

Deno.test("check: a failed comment is logged and the PR is still held", async () => {
  const inner = fakeGh(reading({ headRefName: FIX_HEAD }));
  const logs: string[] = [];
  const gh = (args: string[]): Promise<string> =>
    args[0] === "pr" && args[1] === "comment"
      ? Promise.reject(new Error("comment refused"))
      : inner.gh(args);
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: (m) => logs.push(m),
    authorOptions: AUTHORS,
  });
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(disarms(inner.calls).length, 1);
  assert(
    logs.some((l) =>
      l.includes("could not comment on o/r#9") &&
      l.includes("comment refused")
    ),
  );
});

Deno.test("check: an unparsable milestone-fix head is held on its own PR and comments nowhere else", async () => {
  const head = "milestone-fix/oops";
  const { gh, calls } = fakeGh(reading({ headRefName: head }));
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: head, baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
  });
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(disarms(calls).length, 1);
  assertEquals(comments(calls).map((c) => c[2]), ["9"]);
});
