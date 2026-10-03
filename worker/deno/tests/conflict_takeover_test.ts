/**
 * Tests for conflict_takeover.ts — the conflict takeover pass (Issue #2999,
 * part of #2965).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { Logger } from "../types.ts";
import {
  type ConflictTakeoverDeps,
  type ConflictTakeoverPr,
  runConflictTakeover,
  takeoverAgentTimeoutSeconds,
} from "../lib/conflict_takeover.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  conflictAttemptMarker,
  conflictFailedMarker,
  readResolutionAttempts,
} from "../lib/merge_conflict_markers.ts";
import {
  DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS,
  DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT,
} from "../lib/merge_conflict_drain.ts";
import { spentConflictAttempts } from "../lib/pr_merge_conflict_scan.ts";
import { isFleetAuthor } from "../lib/fleet_authors.ts";

const REPO = "org/repo";
const TRUSTED = "vibe-bot";
const HEAD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
} as unknown as Logger;

function nonGatedPr(): ConflictTakeoverPr {
  return {
    repo: REPO,
    number: 48,
    headRefName: "feature/x",
    baseRefName: "main",
    headSha: HEAD_SHA,
  };
}

function gatedPr(): ConflictTakeoverPr {
  return {
    repo: REPO,
    number: 48,
    headRefName: "milestone/2965-x",
    baseRefName: "main",
    headSha: HEAD_SHA,
  };
}

interface FakeGhOptions {
  comments?: unknown[];
  gated?: boolean;
  openFixPr?: {
    number: number;
    url: string;
    headRefName: string;
    isCrossRepository?: boolean;
    author?: { login: string };
  } | null;
  prCreateUrl?: string;
  labelsOnPr?: string[];
}

interface FakeGh {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
}

function makeFakeGh(options: FakeGhOptions = {}): FakeGh {
  const calls: string[][] = [];
  const comments = options.comments ?? [];
  const labels = options.labelsOnPr ?? [];

  const gh = (args: string[]): Promise<string> => {
    calls.push(args);

    // Comment pages.
    if (args[0] === "api" && String(args[1]).includes("/comments?")) {
      const page = Number(/&page=(\d+)/.exec(String(args[1]))?.[1] ?? 1);
      if (page > 1) return Promise.resolve("[]");
      return Promise.resolve(JSON.stringify(comments));
    }

    // Branch rules.
    if (args[0] === "api" && String(args[1]).includes("/rules/branches/")) {
      return Promise.resolve(
        JSON.stringify(options.gated ? [{ type: "pull_request" }] : []),
      );
    }

    // PR labels.
    if (args[0] === "pr" && args[1] === "view" && args.includes("labels")) {
      return Promise.resolve(labels.join("\n"));
    }

    // Label list cache refresh.
    if (args[0] === "label" && args[1] === "list") {
      return Promise.resolve("[]");
    }

    // Label create / add / delete.
    if (args[0] === "api" && args.includes("POST")) {
      return Promise.resolve("");
    }
    if (args[0] === "api" && args.includes("DELETE")) {
      return Promise.resolve("");
    }

    // pr list (findOpenMilestoneFixPr / raiseMilestoneFixPr reuse check).
    if (args[0] === "pr" && args[1] === "list") {
      if (options.openFixPr === undefined || options.openFixPr === null) {
        return Promise.resolve("[]");
      }
      return Promise.resolve(JSON.stringify([options.openFixPr]));
    }

    // pr create.
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.resolve(
        options.prCreateUrl ?? "https://github.com/org/repo/pull/900\n",
      );
    }

    // pr merge --auto.
    if (args[0] === "pr" && args[1] === "merge") {
      return Promise.resolve("");
    }

    // review-request clearing (GET/DELETE requested_reviewers).
    if (args.includes("GET")) {
      return Promise.resolve('{"users":[],"teams":[]}');
    }

    // pr comment. The URL is what lets a cut-short attempt be withdrawn.
    if (args[0] === "pr" && args[1] === "comment") {
      return Promise.resolve(
        "https://github.com/org/repo/pull/48#issuecomment-1001\n",
      );
    }

    return Promise.resolve("");
  };

  return { gh, calls };
}

function commentsCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === "pr" && a[1] === "comment");
}

function commentBody(call: string[]): string {
  return call[call.indexOf("--body") + 1] ?? "";
}

function trustedComment(body: string): unknown {
  return {
    body,
    user: { login: TRUSTED },
    created_at: new Date().toISOString(),
  };
}

function makeDeps(
  fake: FakeGh,
  overrides: Partial<ConflictTakeoverDeps> = {},
): ConflictTakeoverDeps {
  return {
    gh: fake.gh,
    trustedAuthors: [TRUSTED],
    resolveViaLadder: () =>
      Promise.resolve({ resolved: true, detail: "merged" }),
    resolveOnFixBranch: () =>
      Promise.resolve({ resolved: true, detail: "merged" }),
    logger: silentLogger,
    ...overrides,
  };
}

Deno.test("runConflictTakeover - gated milestone head raises a fix PR, never touches the head", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null });
  let fixBranchUsed = "";
  const deps = makeDeps(fake, {
    resolveOnFixBranch: (_pr, fixBranch) => {
      fixBranchUsed = fixBranch;
      return Promise.resolve({
        resolved: true,
        detail: "fixed on side branch",
      });
    },
    resolveViaLadder: () => {
      throw new Error("resolveViaLadder must not be called for a gated head");
    },
  });

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "fix-pr-raised");
  assert(fixBranchUsed.startsWith("milestone-fix/"));

  const creates = fake.calls.filter((a) => a[0] === "pr" && a[1] === "create");
  assertEquals(creates.length, 1);
  const create = creates[0]!;
  assertEquals(create[create.indexOf("--base") + 1], "milestone/2965-x");
  assert(create[create.indexOf("--head") + 1]!.startsWith("milestone-fix/"));

  // No push/resolve call named the gated head branch directly.
  assert(
    !fake.calls.some((a) =>
      a.includes("milestone/2965-x") && a[0] !== "pr" && a[0] !== "api"
    ),
  );

  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 2);
  const attemptBody = commentBody(comments[0]!);
  const concludeBody = commentBody(comments[1]!);
  assertStringIncludes(attemptBody, CONFLICT_ATTEMPT_MARKER);
  assertStringIncludes(attemptBody, 'pass="takeover"');
  assertStringIncludes(attemptBody, HEAD_SHA);
  assertStringIncludes(concludeBody, CONFLICT_RESOLVED_MARKER);
  assertStringIncludes(concludeBody, 'pass="takeover"');
});

Deno.test("runConflictTakeover - an already-open fix PR is reused, nothing attempted", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: {
      number: 77,
      url: "https://github.com/org/repo/pull/77",
      headRefName: "milestone-fix/2965-x/pr-48-takeover-abc",
      isCrossRepository: false,
      author: { login: TRUSTED },
    },
  });
  let ladderCalled = false;
  let fixBranchCalled = false;
  const deps = makeDeps(fake, {
    resolveViaLadder: () => {
      ladderCalled = true;
      return Promise.resolve({ resolved: true, detail: "" });
    },
    resolveOnFixBranch: () => {
      fixBranchCalled = true;
      return Promise.resolve({ resolved: true, detail: "" });
    },
  });

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "fix-pr-reused");
  if (outcome.kind === "fix-pr-reused") {
    assertEquals(outcome.fixPr.number, 77);
  }
  assert(!ladderCalled);
  assert(!fixBranchCalled);
  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - non-gated head resolves via the ladder", async () => {
  const fake = makeFakeGh({ gated: false });
  let ladderCalled = 0;
  const deps = makeDeps(fake, {
    resolveViaLadder: () => {
      ladderCalled++;
      return Promise.resolve({ resolved: true, detail: "merged cleanly" });
    },
    resolveOnFixBranch: () => {
      throw new Error(
        "resolveOnFixBranch must not be called for a non-gated head",
      );
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "resolved");
  assertEquals(ladderCalled, 1);
  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));

  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 2);
  assertStringIncludes(commentBody(comments[1]!), CONFLICT_RESOLVED_MARKER);
});

Deno.test("runConflictTakeover - three trusted failed attempts decline the budget, posting nothing", async () => {
  const comments = [1, 2, 3].map((n) =>
    trustedComment(
      [
        conflictAttemptMarker(n, "takeover", HEAD_SHA),
        conflictFailedMarker(n, "takeover", HEAD_SHA),
      ].join("\n"),
    )
  );
  const fake = makeFakeGh({ gated: false, comments });
  let resolverCalled = false;
  const deps = makeDeps(fake, {
    resolveViaLadder: () => {
      resolverCalled = true;
      return Promise.resolve({ resolved: true, detail: "" });
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "declined-budget");
  if (outcome.kind === "declined-budget") {
    assertEquals(outcome.attemptsSpent, 3);
  }
  assert(!resolverCalled);
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - three failed markers from an untrusted login do not decline", async () => {
  const comments = [1, 2, 3].map((n) => ({
    body: [
      conflictAttemptMarker(n, "takeover", HEAD_SHA),
      conflictFailedMarker(n, "takeover", HEAD_SHA),
    ].join("\n"),
    user: { login: "random-outsider" },
    created_at: new Date().toISOString(),
  }));
  const fake = makeFakeGh({ gated: false, comments });
  let resolverCalled = false;
  const deps = makeDeps(fake, {
    resolveViaLadder: () => {
      resolverCalled = true;
      return Promise.resolve({ resolved: true, detail: "merged" });
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "resolved");
  assert(resolverCalled);
});

Deno.test("runConflictTakeover - resolver throwing propagates, failed conclusion posted after the attempt marker", async () => {
  const fake = makeFakeGh({ gated: false });
  const deps = makeDeps(fake, {
    resolveViaLadder: () => Promise.reject(new Error("boom")),
  });

  await assertRejects(
    () => runConflictTakeover(nonGatedPr(), deps),
    Error,
    "boom",
  );

  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 2);
  assertStringIncludes(commentBody(comments[0]!), CONFLICT_ATTEMPT_MARKER);
  assertStringIncludes(commentBody(comments[1]!), CONFLICT_FAILED_MARKER);
  assertStringIncludes(commentBody(comments[1]!), 'pass="takeover"');
});

Deno.test("runConflictTakeover - resolver reports unresolved, failed conclusion posted and no label removal", async () => {
  const fake = makeFakeGh({ gated: false, labelsOnPr: ["merge-conflict"] });
  const deps = makeDeps(fake, {
    resolveViaLadder: () =>
      Promise.resolve({
        resolved: false,
        detail: "still conflicted after merge",
      }),
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertEquals(outcome.route, "ladder");
  }
  assert(!fake.calls.some((a) => a[0] === "api" && a.includes("DELETE")));

  const comments = commentsCalls(fake.calls);
  assertStringIncludes(commentBody(comments[1]!), CONFLICT_FAILED_MARKER);
});

Deno.test("runConflictTakeover - label already present before is never removed after a resolve", async () => {
  const fake = makeFakeGh({ gated: false, labelsOnPr: ["merge-conflict"] });
  const deps = makeDeps(fake);

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "resolved");
  assert(!fake.calls.some((a) => a[0] === "api" && a.includes("DELETE")));
});

Deno.test("runConflictTakeover - label absent before is added then removed after a resolve", async () => {
  const fake = makeFakeGh({ gated: false, labelsOnPr: [] });
  const deps = makeDeps(fake);

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "resolved");
  const posts = fake.calls.filter((a) => a[0] === "api" && a.includes("POST"));
  assert(posts.some((a) => String(a.find((x) => x.includes("/labels")) ?? "")));
  const deletes = fake.calls.filter((a) =>
    a[0] === "api" && a.includes("DELETE")
  );
  assertEquals(deletes.length, 1);
  assert(deletes[0]!.some((a) => a.includes("/labels/merge-conflict")));
});

Deno.test("runConflictTakeover - a held cross-host lock stands down before any attempt marker", async () => {
  const fake = makeFakeGh({ gated: false });
  const deps = makeDeps(fake, {
    workerId: "host-b",
    acquireLockFn: () =>
      Promise.resolve({
        ok: true,
        value: { acquired: false, winnerId: "host-a" },
      }),
    resolveViaLadder: () => {
      throw new Error("must not resolve while the lock is held");
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome, { kind: "lock-held", holder: "host-a" });
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - the cross-host lock is released after the attempt", async () => {
  const fake = makeFakeGh({ gated: false });
  let released = 0;
  const deps = makeDeps(fake, {
    workerId: "host-a",
    acquireLockFn: () =>
      Promise.resolve({
        ok: true,
        value: { acquired: true, lockCommentId: 99 },
      }),
    releaseLockFn: () => {
      released++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    startLockRenewalFn: () => ({ stop() {} }),
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "resolved");
  assertEquals(released, 1);
});

Deno.test("runConflictTakeover - empty trustedAuthors rejects before any pr comment", async () => {
  const fake = makeFakeGh({ gated: false });
  const deps = makeDeps(fake, { trustedAuthors: [] });

  await assertRejects(() => runConflictTakeover(nonGatedPr(), deps));
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - an ungated milestone head still uses the fix-PR route (Issue #2965)", async () => {
  const fake = makeFakeGh({ gated: false });
  let fixCalled = false;
  const deps = makeDeps(fake, {
    resolveOnFixBranch: () => {
      fixCalled = true;
      return Promise.resolve({
        resolved: true,
        detail: "fixed on side branch",
      });
    },
    resolveViaLadder: () => {
      throw new Error("resolveViaLadder must not push a milestone head");
    },
  });

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "fix-pr-raised");
  assert(fixCalled);
});

Deno.test("runConflictTakeover - an open CI fix PR does not block the takeover (Issue #2965)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: {
      number: 77,
      url: "https://github.com/org/repo/pull/77",
      headRefName: "milestone-fix/2965-x/pr-48-ci-abc",
    },
  });
  let fixCalled = false;
  const deps = makeDeps(fake, {
    resolveOnFixBranch: () => {
      fixCalled = true;
      return Promise.resolve({
        resolved: true,
        detail: "fixed on side branch",
      });
    },
  });

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "fix-pr-raised");
  assert(fixCalled);
});

Deno.test("runConflictTakeover - a cut-short agent spends no budget (Issue #2965)", async () => {
  for (
    const detail of [
      "the run was ended by the worker before the agent finished",
      "the agent provider was unavailable — 402",
    ]
  ) {
    const fake = makeFakeGh({ gated: false });
    const deps = makeDeps(fake, {
      resolveViaLadder: () =>
        Promise.resolve({ resolved: false, disrupted: true, detail }),
    });

    const outcome = await runConflictTakeover(nonGatedPr(), deps);

    assertEquals(outcome.kind, "disrupted");
    const comments = commentsCalls(fake.calls);
    assertEquals(comments.length, 1);
    assert(!commentBody(comments[0]!).includes(CONFLICT_FAILED_MARKER));
    assert(
      fake.calls.some((args) =>
        args.includes("DELETE") &&
        args.some((arg) => arg.includes("issues/comments/1001"))
      ),
    );
  }
});

Deno.test("takeoverAgentTimeoutSeconds is the time the handler still has", () => {
  const now = 1_000_000;
  assertEquals(takeoverAgentTimeoutSeconds(undefined, 3600, now), undefined);
  assertEquals(
    takeoverAgentTimeoutSeconds(now + 600_000, 3600, now),
    600,
  );
  assertEquals(
    takeoverAgentTimeoutSeconds(now + 7_200_000, 3600, now),
    3600,
  );
  assertEquals(takeoverAgentTimeoutSeconds(now + 400, 3600, now), 1);
});

Deno.test("runConflictTakeover - less than the agent floor left spends no budget (Issue #2965)", async () => {
  const now = 1_700_000_000_000;
  const fake = makeFakeGh({ gated: false });
  const deps = makeDeps(fake, {
    deadlineEpochMs: now + DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT +
      DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS - 1,
    nowMs: now,
    resolveViaLadder: () => {
      throw new Error("must not start an agent the cycle cannot cover");
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "declined-time");
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - a mid-sync lock at the 2-hour mark spends no further attempt (Issue #2965)", async () => {
  const dueAgo = new Date(Date.now() - (2 * 60 + 1) * 60 * 1000).toISOString();
  const comments = [
    trustedComment(
      [
        conflictAttemptMarker(1, "sync", HEAD_SHA),
        conflictFailedMarker(1, "sync", HEAD_SHA),
      ].join("\n"),
    ),
  ];
  (comments[0] as { created_at: string }).created_at = dueAgo;
  const fake = makeFakeGh({ gated: false, comments });
  const deps = makeDeps(fake, {
    workerId: "host-b",
    acquireLockFn: () =>
      Promise.resolve({
        ok: true,
        value: { acquired: false, winnerId: "sync-host" },
      }),
    resolveViaLadder: () => {
      throw new Error("must not resolve while the sync holds the lock");
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome, { kind: "lock-held", holder: "sync-host" });
  assertEquals(commentsCalls(fake.calls).length, 0);
  assertEquals(
    spentConflictAttempts(
      readResolutionAttempts(
        comments,
        (login) => isFleetAuthor(login, [TRUSTED]),
      ),
    ),
    1,
  );
});

Deno.test("runConflictTakeover - a fork takeover fix PR is not reused (Issue #2965)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: {
      number: 77,
      url: "https://github.com/org/repo/pull/77",
      headRefName: "milestone-fix/2965-x/pr-48-takeover-abc",
      isCrossRepository: true,
      author: { login: TRUSTED },
    },
  });
  let fixCalled = false;
  const deps = makeDeps(fake, {
    resolveOnFixBranch: () => {
      fixCalled = true;
      return Promise.resolve({ resolved: true, detail: "fixed" });
    },
  });

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "fix-pr-raised");
  assert(fixCalled);
});

Deno.test("runConflictTakeover - a sync marker that lands before the lock spends no second attempt (Issue #2965)", async () => {
  const comments: unknown[] = [];
  const fake = makeFakeGh({ gated: false, comments });
  let released = 0;
  const deps = makeDeps(fake, {
    workerId: "host-b",
    acquireLockFn: () => {
      comments.push(
        trustedComment(
          [
            conflictAttemptMarker(1, "sync", HEAD_SHA),
            conflictFailedMarker(1, "sync", HEAD_SHA),
          ].join("\n"),
        ),
      );
      return Promise.resolve({
        ok: true,
        value: { acquired: true, lockCommentId: 9 },
      });
    },
    releaseLockFn: () => {
      released++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    startLockRenewalFn: () => ({ stop() {} }),
    resolveViaLadder: () => {
      throw new Error(
        "must not resolve after the sync already spent the attempt",
      );
    },
  });

  const outcome = await runConflictTakeover(nonGatedPr(), deps);

  assertEquals(outcome.kind, "no-longer-due");
  assertEquals(commentsCalls(fake.calls).length, 0);
  assertEquals(released, 1);
  assertEquals(
    spentConflictAttempts(
      readResolutionAttempts(
        comments,
        (login) => isFleetAuthor(login, [TRUSTED]),
      ),
    ),
    1,
  );
});
