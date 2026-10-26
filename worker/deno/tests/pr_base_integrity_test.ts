/**
 * Tests for auto-merge-follows-the-base (Issue #3433).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkPrBaseIntegrity,
  type CheckPrBaseIntegrityOptions,
  decidePrBaseIntegrity,
  MILESTONE_FIX_RETARGETED_MARKER,
  MOVED_ONTO_DEFAULT_MARKER,
  type PrBaseIntegrityReading,
  readPrBaseIntegrity,
} from "../lib/pr_base_integrity.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import type {
  AbandonRestartOutcome,
  AbandonRestartRequest,
} from "../lib/conflict_abandon_restart.ts";

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
  retargetFails = false,
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (retargetFails && args[0] === "pr" && args[1] === "edit") {
      return Promise.reject(new Error("HTTP 422: base branch not found"));
    }
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
/** The bases every `gh pr edit --base` call asked for. */
const retargetBases = (calls: string[][]) =>
  calls
    .filter((c) => c[0] === "pr" && c[1] === "edit" && c.includes("--base"))
    .map((c) => c[c.indexOf("--base") + 1]);

/** An abandon seam that records the request and reports it abandoned. */
function recordAbandon(): {
  requests: AbandonRestartRequest[];
  fn: NonNullable<CheckPrBaseIntegrityOptions["abandon"]>;
} {
  const requests: AbandonRestartRequest[] = [];
  return {
    requests,
    fn: (request) => {
      requests.push(request);
      const outcome: AbandonRestartOutcome = {
        outcome: "abandoned",
        issueNumber: 5,
        label: { kept: "work-on" },
      };
      return Promise.resolve(outcome);
    },
  };
}

/** A hand-back is any posted text asking a person to act. */
const asksAHuman = (calls: string[][]) =>
  comments(calls).some((c) => /a human|by hand|manually/i.test(c[6] ?? ""));

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

/** A PR moved off `from` onto `main`. */
const movedFrom = (from: string) => ({
  at: "2026-01-01T00:00:00Z",
  from,
  to: "main",
});

Deno.test("check: a retargeted milestone-fix PR is moved back onto its milestone branch, not handed to a human (Issue #4304)", async () => {
  const { gh, calls } = fakeGh(reading({
    headRefName: FIX_HEAD,
    lastBaseChange: movedFrom("milestone/m1"),
  }));
  const abandon = recordAbandon();
  const logs: string[] = [];
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: (m) => logs.push(m),
    authorOptions: AUTHORS,
    abandon: abandon.fn,
  });
  assert(
    out.action === "hold" && out.outcome.result === AutoMergeResult.Deferred,
  );
  assertEquals(disarms(calls).length, 1);
  assertEquals(retargetBases(calls), ["milestone/m1"]);
  assertEquals(abandon.requests, []);
  const posted = comments(calls);
  assertEquals(posted.map((c) => c[2]), ["9"]);
  assert(posted[0]![6]!.includes(MILESTONE_FIX_RETARGETED_MARKER));
  assertEquals(asksAHuman(calls), false);
  assert(logs.some((l) => l.includes("[MILESTONE_FIX_RETARGETED]")));
});

Deno.test("check: an existing fleet marker suppresses the moved-back comment", async () => {
  const { gh, calls } = fakeGh(
    reading({
      headRefName: FIX_HEAD,
      lastBaseChange: movedFrom("milestone/m1"),
    }),
    [MILESTONE_FIX_RETARGETED_MARKER],
  );
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
    abandon: recordAbandon().fn,
  });
  assertEquals(out.action, "hold");
  assertEquals(comments(calls), []);
  assertEquals(retargetBases(calls), ["milestone/m1"]);
});

Deno.test("check: a milestone-fix PR with no milestone base to go back to is abandoned and its work redone (Issue #4304)", async () => {
  const { gh, calls } = fakeGh(reading({ headRefName: FIX_HEAD }));
  const abandon = recordAbandon();
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: FIX_HEAD, baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
    abandon: abandon.fn,
  });
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(retargetBases(calls), []);
  assertEquals(abandon.requests.length, 1);
  assertEquals(abandon.requests[0]!.prNumber, 9);
  assertEquals(abandon.requests[0]!.branchName, FIX_HEAD);
  assertEquals(abandon.requests[0]!.reason?.kind, "stalled");
  assertEquals(asksAHuman(calls), false);
});

Deno.test("check: a PR moved onto the default branch is moved back onto the base it was opened against (Issue #4304)", async () => {
  const { gh, calls } = fakeGh(reading({
    lastBaseChange: movedFrom("milestone/x"),
  }));
  const abandon = recordAbandon();
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: "issue-5-x", baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
    abandon: abandon.fn,
  });
  assert(
    out.action === "hold" && out.outcome.result === AutoMergeResult.Deferred,
  );
  assertEquals(disarms(calls).length, 1);
  assertEquals(retargetBases(calls), ["milestone/x"]);
  assertEquals(abandon.requests, []);
  const posted = comments(calls);
  assertEquals(posted.length, 1);
  assert(posted[0]![6]!.includes(MOVED_ONTO_DEFAULT_MARKER));
  assertEquals(asksAHuman(calls), false);
});

Deno.test("check: a PR moved onto the default branch whose old base is gone is abandoned and redone (Issue #4304)", async () => {
  const { gh, calls } = fakeGh(
    reading({ lastBaseChange: movedFrom("milestone/x") }),
    [],
    true,
  );
  const abandon = recordAbandon();
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: "issue-5-x", baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
    abandon: abandon.fn,
  });
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(retargetBases(calls), ["milestone/x"]);
  assertEquals(abandon.requests.length, 1);
  assertEquals(abandon.requests[0]!.baseBranch, "main");
  assertEquals(asksAHuman(calls), false);
});

// These comments are posted into the target repo, which autolinks a bare `#N`
// to that repo's own issue or PR, so they must not cite VibeCoder issue numbers.
Deno.test("check: the moved-back comments cite no bare #N (Issue #3674)", async () => {
  for (const head of [FIX_HEAD, "issue-5-x"]) {
    const from = head === FIX_HEAD ? "milestone/m1" : "milestone/x";
    const { gh, calls } = fakeGh(reading({
      headRefName: head,
      lastBaseChange: movedFrom(from),
    }));
    await checkPrBaseIntegrity({
      repo: "o/r",
      pr: { number: 9, headRefName: head, baseRefName: "main" },
      armed: true,
      gh,
      log: () => {},
      authorOptions: AUTHORS,
      abandon: recordAbandon().fn,
    });
    const posted = comments(calls);
    assertEquals(posted.length, 1);
    assertEquals(posted[0]![6]!.match(/#\d+/g), null);
  }
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

Deno.test("check: a failed comment is logged and the PR is still moved back", async () => {
  const inner = fakeGh(reading({
    headRefName: FIX_HEAD,
    lastBaseChange: movedFrom("milestone/m1"),
  }));
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
    abandon: recordAbandon().fn,
  });
  assert(
    out.action === "hold" && out.outcome.result === AutoMergeResult.Deferred,
  );
  assertEquals(disarms(inner.calls).length, 1);
  assertEquals(retargetBases(inner.calls), ["milestone/m1"]);
  assert(
    logs.some((l) =>
      l.includes("could not comment on o/r#9") &&
      l.includes("comment refused")
    ),
  );
});

Deno.test("check: an unparsable milestone-fix head is never moved back, it is abandoned and redone (Issue #4304)", async () => {
  const head = "milestone-fix/oops";
  const { gh, calls } = fakeGh(reading({
    headRefName: head,
    lastBaseChange: movedFrom("milestone/m1"),
  }));
  const abandon = recordAbandon();
  const out = await checkPrBaseIntegrity({
    repo: "o/r",
    pr: { number: 9, headRefName: head, baseRefName: "main" },
    armed: true,
    gh,
    log: () => {},
    authorOptions: AUTHORS,
    abandon: abandon.fn,
  });
  assert(
    out.action === "hold" &&
      out.outcome.result === AutoMergeResult.HeldBaseRetargeted,
  );
  assertEquals(disarms(calls).length, 1);
  assertEquals(retargetBases(calls), []);
  assertEquals(abandon.requests.length, 1);
});
