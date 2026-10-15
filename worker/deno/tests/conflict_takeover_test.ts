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
  /** The `.behind_by` reply for compare calls; a string can be garbage. */
  behindBy?: number | string;
  /** Refuse a `pr merge --merge`: the repository forbids merge commits. */
  mergeCommitRefused?: boolean;
  /** The `pr list --head` reply for an open attempt's fix PR (Issue #3596). */
  takeoverFixPrs?: unknown[];
  /** The `.behind_by` reply for the milestone head itself (Issue #3596). */
  headBehindBy?: number | string;
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

    // Fix PR base/head re-read before arming (Issue #3433).
    if (
      args[0] === "pr" && args[1] === "view" &&
      args.includes("baseRefName,headRefName")
    ) {
      return Promise.resolve(JSON.stringify({
        baseRefName: "milestone/2965-x",
        headRefName: "milestone-fix/2965-x/pr-48-takeover",
      }));
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

    // pr list for one fix branch, any state (Issue #3596).
    if (
      args[0] === "pr" && args[1] === "list" &&
      args[args.indexOf("--state") + 1] === "all"
    ) {
      return Promise.resolve(JSON.stringify(options.takeoverFixPrs ?? []));
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
      if (options.mergeCommitRefused && args.includes("--merge")) {
        return Promise.reject(
          new Error("Merge commits are not allowed on this repository"),
        );
      }
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

    // Default branch lookup.
    if (
      args[0] === "api" && args[1] === `repos/${REPO}` &&
      args.includes(".default_branch")
    ) {
      return Promise.resolve("main");
    }

    // Compare reads: fix-branch staleness (Issue #3596) and merge-method probes.
    if (args[0] === "api" && String(args[1]).includes("/compare/")) {
      if (
        args.includes(".behind_by") &&
        String(args[1]).endsWith("...milestone/2965-x")
      ) {
        return Promise.resolve(String(options.headBehindBy ?? 0));
      }
      if (args.includes(".behind_by")) {
        return Promise.resolve(String(options.behindBy ?? 0));
      }
      if (args.includes(".merge_base_commit.sha")) {
        return Promise.resolve("a".repeat(40));
      }
      if (args.includes(".status")) {
        return Promise.resolve("ahead");
      }
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

  // The fix branch is confirmed 0 commits behind the base before the fix PR
  // is raised (Issue #3596).
  const behindIndex = fake.calls.findIndex((a) =>
    a[0] === "api" &&
    a[1] === `repos/${REPO}/compare/main...${fixBranchUsed}` &&
    a.includes(".behind_by")
  );
  const createIndex = fake.calls.findIndex((a) =>
    a[0] === "pr" && a[1] === "create"
  );
  assert(behindIndex >= 0, "no behind_by compare call for the fix branch");
  assert(createIndex > behindIndex, "behind_by check must precede pr create");

  // The fake reports the head as ahead of its merge base with main, so the
  // fix PR is armed as a merge commit and never squashed (Issue #3596).
  const merges = fake.calls.filter((a) => a[0] === "pr" && a[1] === "merge");
  assertEquals(merges.length, 1);
  assert(merges[0]!.includes("--auto"));
  assert(merges[0]!.includes("--merge"));
  assert(!merges[0]!.includes("--squash"));

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
  // Raising the fix PR is not resolving the conflict: the attempt stays open
  // until a later pass sees the fix PR land (Issue #3596).
  assert(!concludeBody.includes(CONFLICT_RESOLVED_MARKER));
  assert(!concludeBody.includes(CONFLICT_FAILED_MARKER));
  assertStringIncludes(concludeBody, "https://github.com/org/repo/pull/900");
  const attempts = readResolutionAttempts(
    comments.map((call) => trustedComment(commentBody(call))),
    (login) => isFleetAuthor(login, [TRUSTED]),
  );
  assertEquals(attempts.map((a) => a.outcome), ["open"]);
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

Deno.test("runConflictTakeover - a fix branch still behind its base raises no fix PR (Issue #3596)", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null, behindBy: 3 });
  const deps = makeDeps(fake, {
    resolveViaLadder: () => {
      throw new Error("resolveViaLadder must not be called for a gated head");
    },
  });

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertEquals(outcome.route, "milestone-fix");
    assertStringIncludes(outcome.detail, "3 commit(s) behind 'main'");
  }
  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));

  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 2);
  const concludeBody = commentBody(comments[1]!);
  assertStringIncludes(concludeBody, CONFLICT_FAILED_MARKER);
  assert(!concludeBody.includes(CONFLICT_RESOLVED_MARKER));
});

Deno.test("runConflictTakeover - an unreadable behind count rejects with no fix PR (Issue #3596)", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null, behindBy: "" });
  const deps = makeDeps(fake);

  await assertRejects(
    () => runConflictTakeover(gatedPr(), deps),
    Error,
    "branchBehindBase",
  );

  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));
  const comments = commentsCalls(fake.calls);
  assert(
    comments.some((call) => commentBody(call).includes(CONFLICT_FAILED_MARKER)),
  );
});

Deno.test("runConflictTakeover - a fix PR whose merge commit is refused is failed, not resolved (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    mergeCommitRefused: true,
  });
  const deps = makeDeps(fake);

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertEquals(outcome.route, "milestone-fix");
    assertStringIncludes(outcome.detail, "cannot land");
    assertStringIncludes(outcome.detail, "NOT squashed");
  }
  const merges = fake.calls.filter((a) => a[0] === "pr" && a[1] === "merge");
  assert(merges.some((a) => a.includes("--merge")));
  assert(!merges.some((a) => a.includes("--squash")));

  // Only the takeover PR's own thread: the fix PR's refusal comment is posted
  // to PR 900 and is not the conclusion.
  const comments = commentsCalls(fake.calls).filter((a) => a[2] === "48");
  assertEquals(comments.length, 2);
  const concludeBody = commentBody(comments[1]!);
  assertStringIncludes(concludeBody, CONFLICT_FAILED_MARKER);
  assert(!concludeBody.includes(CONFLICT_RESOLVED_MARKER));
});

Deno.test("runConflictTakeover - a fractional behind count rejects with no fix PR, naming the value (Issue #3596)", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null, behindBy: "1.5" });

  await assertRejects(
    () => runConflictTakeover(gatedPr(), makeDeps(fake)),
    Error,
    "as 1.5 commit(s) behind 'main'",
  );
  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));
});

Deno.test("runConflictTakeover - a negative behind count rejects with no fix PR, naming the value (Issue #3596)", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null, behindBy: "-1" });

  await assertRejects(
    () => runConflictTakeover(gatedPr(), makeDeps(fake)),
    Error,
    "as -1 commit(s) behind 'main'",
  );
  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));
});

Deno.test("runConflictTakeover - a fix branch up to its base raises the fix PR (Issue #3596)", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null, behindBy: 0 });
  const deps = makeDeps(fake);

  const outcome = await runConflictTakeover(gatedPr(), deps);

  assertEquals(outcome.kind, "fix-pr-raised");
  assert(fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));
});

// ---------------------------------------------------------------------------
// A raised fix PR is concluded by a later pass (Issue #3596)
// ---------------------------------------------------------------------------

/** The head the open attempt ran against, before its fix PR landed. */
const PENDING_SHA = "0123456789ab0123456789ab0123456789ab0123";
const PENDING_FIX_BRANCH = "milestone-fix/2965-x/pr-48-takeover-0123456789ab";

function pendingAttemptComments(): unknown[] {
  return [trustedComment(conflictAttemptMarker(1, "takeover", PENDING_SHA))];
}

function takeoverFixPr(
  state: string,
  overrides: Record<string, unknown> = {},
): unknown {
  const number = state === "MERGED" ? 901 : 902;
  return {
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    state,
    headRefName: PENDING_FIX_BRANCH,
    isCrossRepository: false,
    author: { login: TRUSTED },
    ...overrides,
  };
}

function concludingDeps(fake: FakeGh): ConflictTakeoverDeps {
  return makeDeps(fake, {
    resolveOnFixBranch: () => {
      throw new Error("no fresh attempt may run while concluding one");
    },
  });
}

Deno.test("runConflictTakeover - a landed fix PR with the milestone branch still behind concludes failed, never resolved (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: pendingAttemptComments(),
    takeoverFixPrs: [takeoverFixPr("MERGED")],
    headBehindBy: 2,
  });

  const outcome = await runConflictTakeover(gatedPr(), concludingDeps(fake));

  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertEquals(outcome.route, "milestone-fix");
    assertStringIncludes(outcome.detail, "pull/901 landed");
    assertStringIncludes(
      outcome.detail,
      "'milestone/2965-x' is still 2 commit(s) behind 'main'",
    );
  }
  const listCall = fake.calls.find((a) =>
    a[0] === "pr" && a[1] === "list" && a.includes("--head")
  )!;
  assertEquals(listCall[listCall.indexOf("--head") + 1], PENDING_FIX_BRANCH);
  assertEquals(listCall[listCall.indexOf("--base") + 1], "milestone/2965-x");
  assertEquals(listCall[listCall.indexOf("--state") + 1], "all");
  assert(
    fake.calls.some((a) =>
      a[1] === `repos/${REPO}/compare/main...milestone/2965-x`
    ),
  );
  assert(!fake.calls.some((a) => a[0] === "pr" && a[1] === "create"));

  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 1);
  const body = commentBody(comments[0]!);
  assert(!body.includes(CONFLICT_RESOLVED_MARKER));
  assertStringIncludes(
    body,
    conflictFailedMarker(1, "takeover", PENDING_SHA),
  );
  // The failure is charged once, and closes the open attempt.
  const attempts = readResolutionAttempts(
    [...pendingAttemptComments(), trustedComment(body)],
    (login) => isFleetAuthor(login, [TRUSTED]),
  );
  assertEquals(attempts.map((a) => a.outcome), ["failed"]);
  assertEquals(spentConflictAttempts(attempts), 1);
});

Deno.test("runConflictTakeover - a landed fix PR with the milestone branch 0 behind concludes resolved (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: pendingAttemptComments(),
    takeoverFixPrs: [takeoverFixPr("CLOSED"), takeoverFixPr("MERGED")],
    headBehindBy: 0,
  });

  const outcome = await runConflictTakeover(gatedPr(), concludingDeps(fake));

  assertEquals(outcome.kind, "resolved");
  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 1);
  const body = commentBody(comments[0]!);
  assertStringIncludes(body, CONFLICT_RESOLVED_MARKER);
  assertStringIncludes(body, 'pass="takeover"');
  // The conclusion names the head the attempt ran against, as the failed one does.
  assertStringIncludes(body, `head="${PENDING_SHA}"`);
  assertStringIncludes(body, "pull/901 landed");
});

Deno.test("runConflictTakeover - a fix PR closed without landing concludes failed (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: pendingAttemptComments(),
    takeoverFixPrs: [takeoverFixPr("CLOSED")],
  });

  const outcome = await runConflictTakeover(gatedPr(), concludingDeps(fake));

  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertStringIncludes(outcome.detail, "pull/902 was closed without landing");
  }
  assert(!fake.calls.some((a) => String(a[1]).includes("/compare/")));
  const comments = commentsCalls(fake.calls);
  assertEquals(comments.length, 1);
  assertStringIncludes(commentBody(comments[0]!), CONFLICT_FAILED_MARKER);
});

Deno.test("runConflictTakeover - an unreadable milestone behind count after a landing posts nothing (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: pendingAttemptComments(),
    takeoverFixPrs: [takeoverFixPr("MERGED")],
    headBehindBy: "",
  });

  await assertRejects(
    () => runConflictTakeover(gatedPr(), concludingDeps(fake)),
    Error,
    "branchBehindBase",
  );
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - an open attempt with no fleet fix PR of its own runs a fresh attempt (Issue #3596)", async () => {
  for (
    const listed of [
      [],
      [takeoverFixPr("MERGED", { isCrossRepository: true })],
      [takeoverFixPr("MERGED", { author: { login: "stranger" } })],
      [takeoverFixPr("MERGED", { headRefName: `${PENDING_FIX_BRANCH}-x` })],
      [takeoverFixPr("MERGED", { url: 901 })],
      [takeoverFixPr("MERGED", { number: "901" })],
      [takeoverFixPr("REOPENED")],
    ]
  ) {
    const fake = makeFakeGh({
      gated: true,
      openFixPr: null,
      comments: pendingAttemptComments(),
      takeoverFixPrs: listed,
    });

    const outcome = await runConflictTakeover(gatedPr(), makeDeps(fake));

    assertEquals(outcome.kind, "fix-pr-raised", JSON.stringify(listed));
    const bodies = commentsCalls(fake.calls).map(commentBody);
    assert(!bodies.some((body) => body.includes(CONFLICT_RESOLVED_MARKER)));
    assert(!bodies.some((body) => body.includes(CONFLICT_FAILED_MARKER)));
  }
});

Deno.test("runConflictTakeover - an open ladder attempt is not concluded as a fix PR (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: [
      trustedComment(conflictAttemptMarker(1, "ladder", PENDING_SHA)),
    ],
    takeoverFixPrs: [takeoverFixPr("MERGED")],
  });

  const outcome = await runConflictTakeover(gatedPr(), makeDeps(fake));

  assertEquals(outcome.kind, "fix-pr-raised");
  assert(!fake.calls.some((a) => a.includes(PENDING_FIX_BRANCH)));
});

Deno.test("runConflictTakeover - an open takeover attempt on a non-milestone head is not concluded as a fix PR (Issue #3596)", async () => {
  const fake = makeFakeGh({
    comments: pendingAttemptComments(),
    takeoverFixPrs: [takeoverFixPr("MERGED")],
  });

  const outcome = await runConflictTakeover(nonGatedPr(), makeDeps(fake));

  assertEquals(outcome.kind, "resolved");
  assert(
    !fake.calls.some((a) =>
      a[0] === "pr" && a[1] === "list" && a.includes("all")
    ),
  );
});

Deno.test("runConflictTakeover - an unreadable fix PR listing for an open attempt posts nothing (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: pendingAttemptComments(),
  });
  const gh = (args: string[]) =>
    args[0] === "pr" && args[1] === "list" && args.includes("--head")
      ? Promise.resolve('{"not":"a list"}')
      : fake.gh(args);

  await assertRejects(
    () => runConflictTakeover(gatedPr(), makeDeps({ gh, calls: fake.calls })),
    Error,
    "unexpected PR listing shape",
  );
  assertEquals(commentsCalls(fake.calls).length, 0);
});

Deno.test("runConflictTakeover - the raised fix PR names the milestone PR and the pass (Issue #3596)", async () => {
  const fake = makeFakeGh({ gated: true, openFixPr: null });

  const outcome = await runConflictTakeover(gatedPr(), makeDeps(fake));

  assertEquals(outcome.kind, "fix-pr-raised");
  const create = fake.calls.find((a) => a[0] === "pr" && a[1] === "create")!;
  assertEquals(
    create[create.indexOf("--title") + 1],
    "Address #48 merge-conflict resolution on milestone/2965-x",
  );
});

Deno.test("runConflictTakeover - an open attempt whose fix PR is still open stands down, posting nothing (Issue #3596)", async () => {
  const fake = makeFakeGh({
    gated: true,
    openFixPr: null,
    comments: pendingAttemptComments(),
    takeoverFixPrs: [takeoverFixPr("OPEN")],
  });

  const outcome = await runConflictTakeover(gatedPr(), concludingDeps(fake));

  assertEquals(outcome.kind, "fix-pr-reused");
  if (outcome.kind === "fix-pr-reused") {
    assertEquals(outcome.fixPr.number, 902);
    assertEquals(outcome.fixPr.url, "https://github.com/org/repo/pull/902");
    assertEquals(outcome.fixPr.opened, false);
  }
  assertEquals(commentsCalls(fake.calls).length, 0);
  assert(!fake.calls.some((a) => String(a[1]).includes("/compare/")));
});

Deno.test("runConflictTakeover - an empty or unparsable fix PR listing for an open attempt names the branch and posts nothing (Issue #3596)", async () => {
  for (const reply of ["", "not json"]) {
    const fake = makeFakeGh({
      gated: true,
      openFixPr: null,
      comments: pendingAttemptComments(),
    });
    const gh = (args: string[]) =>
      args[0] === "pr" && args[1] === "list" && args.includes("all")
        ? Promise.resolve(reply)
        : fake.gh(args);

    await assertRejects(
      () => runConflictTakeover(gatedPr(), makeDeps({ gh, calls: fake.calls })),
      Error,
      `could not parse the PR listing for '${PENDING_FIX_BRANCH}'`,
    );
    assertEquals(commentsCalls(fake.calls).length, 0);
  }
});
