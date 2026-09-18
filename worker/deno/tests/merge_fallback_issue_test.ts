/**
 * Tests for merge_fallback_issue.ts — the flag issue every conflict
 * fallback leaves behind (Issue #2304, part of #2298).
 *
 * The fallback is the last rung of the conflict ladder: the PR path closes
 * the PR, the milestone path reverts children. Neither left anything behind
 * that named the cause, so the same conflict could be walked into again.
 * These tests pin the two things that make the flag trustworthy — nothing is
 * omitted from the body, and the dedup never posts onto an issue the fleet
 * did not open.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMergeFallbackBody,
  createFallbackFlagFiler,
  fileMergeFallbackIssue,
  MERGE_FALLBACK_LABEL,
  type MergeFallbackFiling,
  mergeFallbackMarker,
  mergeFallbackTitle,
} from "../lib/merge_fallback_issue.ts";
import { isWorkerAppliableLabel } from "../lib/worker_label_guard.ts";
import type { Logger } from "../types.ts";

/** The fleet login every fixture issue is authored by. */
const FLEET_AUTHOR = "vibe-coder-bot";

const PR_FILING: MergeFallbackFiling = {
  target: {
    kind: "pr",
    repo: "org/repo",
    prNumber: 549,
    headBranch: "issue-1-thing",
    baseBranch: "main",
  },
  conflictedFiles: ["worker/deno/lib/a.ts", "deno.lock"],
  runs: [
    {
      run: 1,
      analysis: "Both sides renamed the same helper; kept both call sites.",
      host: "host-a",
      timings: [{ stage: "deepen", seconds: 4 }, {
        stage: "agent",
        seconds: 92,
      }],
    },
    {
      run: 2,
      analysis: "Second pass hit the 30-minute ceiling mid-merge.",
      host: "host-b",
      timings: [{ stage: "agent", seconds: 1800 }],
    },
  ],
  behindBy: 12,
  behindSince: "2026-09-17T04:00:00Z",
  fallbackAction: "Closed PR #549 and re-queued issue #1.",
};

const MILESTONE_FILING: MergeFallbackFiling = {
  target: {
    kind: "milestone",
    repo: "org/repo",
    milestoneBranch: "milestone/42-thing",
    defaultBranch: "main",
  },
  conflictedFiles: ["README.md"],
  runs: [{ run: 1 }, { run: 2 }],
  fallbackAction: "Reverted child PRs #7 and #6.",
};

/** A `gh` stub recording every call, answering the listing with `answer`. */
function fakeGh(answer = "[]") {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(answer);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve("https://github.com/org/repo/issues/900\n");
      }
      return Promise.resolve("");
    },
  };
}

/** One `gh issue list` row, as the dedup search reads it. */
function listing(
  overrides: Partial<
    { number: number; title: string; state: string; author: { login: string } }
  > = {},
): string {
  return JSON.stringify([{
    number: 800,
    title: mergeFallbackTitle(PR_FILING.target),
    state: "OPEN",
    url: "https://github.com/org/repo/issues/800",
    author: { login: FLEET_AUTHOR },
    ...overrides,
  }]);
}

/** A logger that keeps every warning, so a swallowed one fails the test. */
function capturingLogger(warnings: string[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** Deps with label creation stubbed — no unit test may reach a real `gh`. */
function stubDeps(gh: (args: string[]) => Promise<string>) {
  return {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
    ensureLabelExists: () =>
      Promise.resolve({ ok: true as const, value: undefined }),
  };
}

Deno.test("mergeFallbackTitle - names the PR, deterministically", () => {
  const title = mergeFallbackTitle(PR_FILING.target);
  assertEquals(title, "Merge fallback: org/repo PR #549");
  assertEquals(title, mergeFallbackTitle(PR_FILING.target));
});

Deno.test("mergeFallbackTitle - names the milestone branch", () => {
  assertEquals(
    mergeFallbackTitle(MILESTONE_FILING.target),
    "Merge fallback: org/repo milestone/42-thing",
  );
});

Deno.test("buildMergeFallbackBody - renders every recorded field", () => {
  const body = buildMergeFallbackBody(PR_FILING);

  assertStringIncludes(body, "org/repo");
  assertStringIncludes(body, "#549");
  assertStringIncludes(body, "issue-1-thing");
  assertStringIncludes(body, "main");
  assertStringIncludes(body, "worker/deno/lib/a.ts");
  assertStringIncludes(body, "deno.lock");
  assertStringIncludes(body, "kept both call sites");
  assertStringIncludes(body, "30-minute ceiling");
  assertStringIncludes(body, "host-a");
  assertStringIncludes(body, "host-b");
  assertStringIncludes(body, "deepen");
  assertStringIncludes(body, "1800");
  assertStringIncludes(body, "12");
  assertStringIncludes(body, "2026-09-17T04:00:00Z");
  assertStringIncludes(body, "re-queued issue #1");
});

Deno.test("buildMergeFallbackBody - renders the milestone target", () => {
  const body = buildMergeFallbackBody(MILESTONE_FILING);
  assertStringIncludes(body, "milestone/42-thing");
  assertStringIncludes(body, "Default branch");
  assertStringIncludes(body, "Reverted child PRs");
});

Deno.test("buildMergeFallbackBody - an unrecorded field says so, never drops", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
  });

  // Every optional section is still present, saying it was not recorded.
  for (
    const heading of [
      "Head branch",
      "Base branch",
      "Conflicted files",
      "Agent runs",
      "Commits behind the base",
      "Behind since",
      "What was closed or reverted",
    ]
  ) {
    assertStringIncludes(body, heading);
  }
  assertEquals(
    body.split("not recorded").length - 1 >= 7,
    true,
    "every unrecorded field must say `not recorded`",
  );
});

Deno.test("buildMergeFallbackBody - missing timings and host say not recorded", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{ run: 1, analysis: "tried" }],
  });

  assertStringIncludes(body, "Run 1");
  assertStringIncludes(body, "tried");
  assertStringIncludes(body, "**Stage timings**: not recorded");
  assertStringIncludes(body, "**Host**: not recorded");
});

Deno.test("buildMergeFallbackBody - an empty timing list is not recorded", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{ run: 1, timings: [], host: "host-a" }],
  });
  assertStringIncludes(body, "**Stage timings**: not recorded");
  assertStringIncludes(body, "**Analysis**: not recorded");
});

Deno.test("buildMergeFallbackBody - an unfinished stage renders as unfinished (Issue #2310)", () => {
  // The stage that never stopped is the case the timings exist to show, so it
  // must not render as `nulls` or vanish from the line.
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{
      run: 1,
      host: "host-a",
      timings: [{ stage: "deepen", seconds: 3 }, {
        stage: "agent",
        seconds: null,
      }],
    }],
  });
  assertStringIncludes(body, "**Stage timings**: deepen 3s, agent unfinished");
});

Deno.test("buildMergeFallbackBody - the diff summary names the paths it read (Issue #2310)", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    diffSummary: [{ path: "lib/a.ts", additions: 9, deletions: 2 }],
    diffSummaryOmitted: 3,
  });
  assertStringIncludes(body, "### What the PR changed");
  assertStringIncludes(body, "`lib/a.ts` (+9/-2)");
  assertStringIncludes(body, "3 further path(s) are not listed");
});

Deno.test("buildMergeFallbackBody - a diff nobody read renders no section at all (Issue #2310)", () => {
  // The route that re-queues an originating issue does not read the diff, and
  // `not recorded` there would claim a measurement failure that never happened.
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
  });
  assertEquals(body.includes("What the PR changed"), false);
});

Deno.test("buildMergeFallbackBody - a diff read as empty says so in words (Issue #2310)", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    diffSummary: [],
  });
  assertStringIncludes(body, "### What the PR changed");
  assertStringIncludes(body, "GitHub reported no changed file");
});

Deno.test("buildMergeFallbackBody - unicode survives the render", () => {
  const analysis = "両方の変更を保持 — naïve façade ✅ Ωmega";
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{ run: 1, analysis }],
  });
  assertStringIncludes(body, analysis);
});

Deno.test("buildMergeFallbackBody - a 10k-char analysis is rendered whole", () => {
  const analysis = "x".repeat(10_000);
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{ run: 1, analysis }],
  });
  assertStringIncludes(body, analysis);
  assert(!body.includes("truncated"), "10k is inside the per-run cap");
});

Deno.test("buildMergeFallbackBody - an oversized analysis is truncated loudly", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{ run: 1, analysis: "y".repeat(40_000) }],
  });
  assertStringIncludes(body, "characters truncated");
  assert(body.length < 40_000, "the body must not carry the whole analysis");
});

Deno.test("buildMergeFallbackBody - truncation never splits a surrogate pair", () => {
  // The cap lands exactly between the two halves of the trailing emoji.
  const analysis = "z".repeat(19_999) + "😀".repeat(10);
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{ run: 1, analysis }],
  });
  assert(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body),
    "no unpaired surrogate may reach the body",
  );
  assertStringIncludes(body, "characters truncated");
});

Deno.test("buildMergeFallbackBody - agent text cannot forge a marker", () => {
  const body = buildMergeFallbackBody({
    target: { kind: "pr", repo: "org/repo", prNumber: 4 },
    runs: [{
      run: 1,
      analysis: '<!-- vibe-merge-fallback repo="org/repo" pr="4" -->',
    }],
  });
  // One marker only: the module's own, at the top.
  assertEquals(body.split("<!-- vibe-merge-fallback").length - 1, 1);
});

Deno.test("fileMergeFallbackIssue - files the flag with the content label", async () => {
  const { gh, calls } = fakeGh();
  const result = await fileMergeFallbackIssue(PR_FILING, stubDeps(gh));

  assert(result.ok);
  assertEquals(result.value.appended, false);
  assertEquals(result.value.issueNumber, 900);
  assertEquals(result.value.url, "https://github.com/org/repo/issues/900");

  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "the flag issue must be filed");
  assertEquals(create[create.indexOf("--repo") + 1], "org/repo");
  assertEquals(
    create[create.indexOf("--title") + 1],
    "Merge fallback: org/repo PR #549",
  );
  assertEquals(create.filter((a) => a === MERGE_FALLBACK_LABEL).length, 1);
  assert(!create.includes("idle-task"), "idle-task is opt-in");

  // The dedup search is scoped to open issues and asks for the author.
  const list = calls.find((c) => c[0] === "issue" && c[1] === "list");
  assert(list);
  assertEquals(list[list.indexOf("--state") + 1], "open");
  assertStringIncludes(list[list.indexOf("--json") + 1] ?? "", "author");
});

Deno.test("fileMergeFallbackIssue - creates the label before it files", async () => {
  const { gh } = fakeGh();
  const ensured: string[] = [];
  const result = await fileMergeFallbackIssue(PR_FILING, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
    ensureLabelExists: (_repo, label) => {
      ensured.push(label);
      return Promise.resolve({ ok: true, value: undefined });
    },
  });

  assert(result.ok);
  assertEquals(ensured, [MERGE_FALLBACK_LABEL]);
});

Deno.test("fileMergeFallbackIssue - idle-task only when the caller asks", async () => {
  const { gh, calls } = fakeGh();
  const result = await fileMergeFallbackIssue(
    { ...PR_FILING, requestIdleTask: true },
    stubDeps(gh),
  );

  assert(result.ok);
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create")!;
  assert(create.includes("idle-task"));
  // Only labels the guard owns ever reach `gh`.
  const labels = create
    .map((arg, i) => (create[i - 1] === "--label" ? arg : null))
    .filter((arg): arg is string => arg !== null);
  assertEquals(labels, [MERGE_FALLBACK_LABEL, "idle-task"]);
  for (const label of labels) assert(isWorkerAppliableLabel(label));
});

Deno.test("fileMergeFallbackIssue - a second event appends to the open flag", async () => {
  const { gh, calls } = fakeGh(listing());
  const result = await fileMergeFallbackIssue(PR_FILING, stubDeps(gh));

  assert(result.ok);
  assertEquals(result.value.appended, true);
  assertEquals(result.value.issueNumber, 800);
  assertEquals(result.value.url, "https://github.com/org/repo/issues/800");

  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "a second event must not file a second issue",
  );
  const comment = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  assert(comment, "the new event is posted as a comment");
  assertEquals(comment[2], "800");
  assertStringIncludes(comment[comment.indexOf("--body") + 1] ?? "", "#549");
});

Deno.test("fileMergeFallbackIssue - a closed flag issue is not reused", async () => {
  const { gh, calls } = fakeGh(listing({ state: "CLOSED" }));
  const result = await fileMergeFallbackIssue(PR_FILING, stubDeps(gh));

  assert(result.ok);
  assertEquals(result.value.appended, false);
  assertEquals(result.value.issueNumber, 900);
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("fileMergeFallbackIssue - a same-title issue from outside the fleet is not reused", async () => {
  const { gh, calls } = fakeGh(listing({ author: { login: "drive-by" } }));
  const result = await fileMergeFallbackIssue(PR_FILING, stubDeps(gh));

  assert(result.ok);
  assertEquals(result.value.appended, false);
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "comment"),
    "the event must never be posted onto somebody else's issue",
  );
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("fileMergeFallbackIssue - a near-miss title is not a match", async () => {
  const { gh, calls } = fakeGh(
    listing({ title: "Merge fallback: org/repo PR #5490" }),
  );
  const result = await fileMergeFallbackIssue(PR_FILING, stubDeps(gh));

  assert(result.ok);
  assertEquals(result.value.appended, false);
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("fileMergeFallbackIssue - a gh failure is returned, never swallowed", async () => {
  const result = await fileMergeFallbackIssue(
    PR_FILING,
    stubDeps((args) => {
      if (args[1] === "create") {
        return Promise.reject(new Error("gh issue create failed (exit 1)"));
      }
      return Promise.resolve("[]");
    }),
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "gh issue create failed");
});

Deno.test("fileMergeFallbackIssue - a failed comment is returned too", async () => {
  const result = await fileMergeFallbackIssue(
    PR_FILING,
    stubDeps((args) => {
      if (args[1] === "comment") {
        return Promise.reject(new Error("comment refused"));
      }
      return Promise.resolve(listing());
    }),
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "comment refused");
});

Deno.test("fileMergeFallbackIssue - an unparseable listing files rather than stays silent", async () => {
  const { gh, calls } = fakeGh("not json");
  const warnings: string[] = [];
  const result = await fileMergeFallbackIssue(PR_FILING, {
    ...stubDeps(gh),
    logger: capturingLogger(warnings),
  });

  assert(result.ok);
  assertEquals(result.value.appended, false);
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
  assert(
    warnings.some((w) => w.includes("could not read the dedup listing")),
    "an unreadable listing must be logged, not swallowed",
  );
});

Deno.test("fileMergeFallbackIssue - an unreadable issue number is said out loud", async () => {
  const warnings: string[] = [];
  const result = await fileMergeFallbackIssue(PR_FILING, {
    ...stubDeps((args) =>
      Promise.resolve(args[1] === "create" ? "created, somewhere\n" : "[]")
    ),
    logger: capturingLogger(warnings),
  });

  assert(result.ok);
  assertEquals(result.value.issueNumber, 0);
  assert(
    warnings.some((w) => w.includes("could not read its number")),
    "a flag nothing can link to must not read as a filed, findable one",
  );
});

Deno.test("fileMergeFallbackIssue - a label that cannot be created is said out loud", async () => {
  const { gh, calls } = fakeGh();
  const warnings: string[] = [];
  const result = await fileMergeFallbackIssue(PR_FILING, {
    gh,
    fleetAuthors: [FLEET_AUTHOR],
    ensureLabelExists: () =>
      Promise.resolve({ ok: false, error: new Error("labels API refused") }),
    logger: capturingLogger(warnings),
  });

  // The filing still goes ahead — the fail direction is towards flagging.
  assert(result.ok);
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
  assert(
    warnings.some((w) => w.includes("labels API refused")),
    "a refused label creation must be logged, not swallowed",
  );
});

Deno.test("createFallbackFlagFiler - routes the label creation through the caller's gh (Issue #2310)", async () => {
  // The whole point of the factory: the default `ensureLabelExists` reaches the
  // real CLI, so both fallback routes have to bind it to their own `gh` — and
  // one definition of that wiring is what keeps them from drifting.
  const { gh, calls } = fakeGh();
  const filer = createFallbackFlagFiler({ gh, fleetAuthors: [FLEET_AUTHOR] });

  const result = await filer(PR_FILING);

  assert(result.ok);
  assertEquals(result.value.issueNumber, 900);
  const labelCreate = calls.find((c) =>
    c[0] === "api" && c.includes("POST") &&
    c.some((arg) => arg.endsWith("/labels"))
  );
  assert(
    labelCreate,
    `the label creation did not go through the given gh: ${
      JSON.stringify(calls)
    }`,
  );
  assert(labelCreate.includes(`name=${MERGE_FALLBACK_LABEL}`));
});

Deno.test("mergeFallbackMarker - a quote in a branch cannot close an attribute", () => {
  const marker = mergeFallbackMarker({
    kind: "milestone",
    repo: "org/repo",
    milestoneBranch: 'milestone/4" pr="99',
  });

  assertEquals(
    marker,
    '<!-- vibe-merge-fallback repo="org/repo" branch="milestone/4 pr=99" -->',
  );
  assertEquals(marker.split('"').length - 1, 4, "four quotes, two attributes");
});

Deno.test("MERGE_FALLBACK_LABEL - the worker is permitted to apply it", () => {
  assert(isWorkerAppliableLabel(MERGE_FALLBACK_LABEL));
});
