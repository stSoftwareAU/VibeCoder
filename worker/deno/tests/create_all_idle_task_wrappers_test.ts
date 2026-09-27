/**
 * Tests for {@link createAllIdleTaskWrappers} (Issue #2577).
 *
 * Covers:
 *   - all-on-clean — a clean repo gets exactly one wrapper per canonical
 *     template, each carrying the `idle-task` label and no milestone;
 *   - partial-skip — under `force` (Issue #2752), a repo that already has some
 *     wrappers open skips those and files the rest;
 *   - full-skip — a repo with every wrapper already open files nothing;
 *   - any-open gate (Issue #2752) — any open `idle-task` issue (non-canonical,
 *     `needs-human`, `failed`, `Finish #N:`) blocks the whole sweep; the lookup
 *     asks for open issues only; a failed lookup files nothing and returns an
 *     error; `force` files past the gate but still skips exact titles;
 *   - canonical titles — every filed `--title` is a member of the
 *     `IDLE_TASK_WRAPPER_TITLES` allowlist;
 *   - partial progress (Issue #3862) — a mid-sweep `gh` failure never discards
 *     the templates already created/skipped, and the sweep continues;
 *   - terminal write refusals (Issue #3862) — an off-allowlist target aborts
 *     before any `gh` call, and a mid-sweep block aborts immediately.
 *
 * All dependencies are injected so the tests never touch the network.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  createAllIdleTaskWrappers,
  formatIdleTaskOutcomeTable,
  isTerminalSweepError,
  partialFromSweepError,
} from "../lib/create_all_idle_task_wrappers.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import {
  GITHUB_ISSUE_BODY_MAX_CHARS,
  IDLE_TASK_BODY_TRUNCATION_MARKER,
} from "../lib/idle_task_body_limit.ts";
import type { Result } from "../types.ts";
import {
  classifyGhMutation,
  type MutationInfo,
} from "../lib/audit_mutation_classifier.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { openIdleTaskIssues } from "./support/open_idle_task_issues.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Registry size, derived — never hard-coded, so registering a template keeps
 * these expectations honest instead of pinning today's number (Issue #664).
 */
const TEMPLATE_COUNT = IDLE_TASK_WRAPPER_TITLES.length;

interface GhCall {
  args: string[];
}

/** Collect `gh issue create` calls; everything else returns an empty string. */
function makeMockGh(opts: { createThrows?: boolean } = {}) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "create") {
      if (opts.createThrows) {
        return Promise.reject(new Error("gh issue create exploded"));
      }
      return Promise.resolve(
        "https://github.com/org/monitored/issues/4242\n",
      );
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

function createCalls(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
}

/** Extract the `--title` value from a `gh issue create` call. */
function titleOf(call: GhCall): string {
  const i = call.args.indexOf("--title");
  return i >= 0 ? call.args[i + 1]! : "";
}

/** Extract the `--body` value from a `gh issue create` call. */
function bodyOf(call: GhCall): string {
  const i = call.args.indexOf("--body");
  return i >= 0 ? call.args[i + 1]! : "";
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/**
 * True when `body` contains two attribution-footer lines separated only by
 * blank lines — the exact tail-duplication shape of the Issue #3513 bug. LLM
 * prompts legitimately quote the footer inline (in fenced examples / prose),
 * so a plain "footer appears once" count would false-positive; adjacency
 * captures only the double-stamp.
 */
function hasAdjacentFooters(body: string, footerPrefix: string): boolean {
  const isFooter = (line: string) => line.trim().startsWith(footerPrefix);
  const lines = body.split("\n");
  const footerIdx = lines
    .map((l, i) => (isFooter(l) ? i : -1))
    .filter((i) => i >= 0);
  for (let k = 1; k < footerIdx.length; k++) {
    const between = lines.slice(footerIdx[k - 1]! + 1, footerIdx[k]!);
    if (between.every((l) => l.trim().length === 0)) return true;
  }
  return false;
}

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-06-07T00:00:00.000Z");

// ---------------------------------------------------------------------------
// all-on-clean
// ---------------------------------------------------------------------------

Deno.test(
  "createAllIdleTaskWrappers - clean repo gets one wrapper per template with idle-task label and no milestone",
  async () => {
    const gh = makeMockGh();
    const ensureCalls: string[] = [];

    const result = await createAllIdleTaskWrappers("org/fresh", {
      ghCommandFn: gh.fn,
      ensureLabelFn: (r) => {
        ensureCalls.push(r);
        return labelOk();
      },
      findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-aaaaaa",
      workerUser: "vibe-bot",
    });

    assert(result.ok, "expected ok result");
    if (!result.ok) return;

    // Exactly one wrapper filed per canonical template.
    assertEquals(result.value.created.length, TEMPLATE_COUNT);
    assertEquals(result.value.skipped.length, 0);

    const creates = createCalls(gh.calls);
    assertEquals(creates.length, TEMPLATE_COUNT);

    // Label ensured once.
    assertEquals(ensureCalls, ["org/fresh"]);

    for (const c of creates) {
      // Every wrapper carries the idle-task label.
      assert(c.args.includes("--label"));
      const li = c.args.indexOf("--label");
      assertEquals(c.args[li + 1], "idle-task");
      // No per-template milestone.
      assert(!c.args.includes("--milestone"), "no --milestone expected");
      // Title is on the canonical allowlist.
      assert(
        IDLE_TASK_WRAPPER_TITLES.includes(titleOf(c)),
        `title "${titleOf(c)}" not in allowlist`,
      );
    }

    // The filed titles are exactly the canonical set.
    const filedTitles = new Set(creates.map(titleOf));
    assertEquals(filedTitles, new Set(IDLE_TASK_WRAPPER_TITLES));
  },
);

// ---------------------------------------------------------------------------
// Attribution footer stamped exactly once (Issue #3513)
// ---------------------------------------------------------------------------

const FOOTER_PREFIX = "🏷️ Filed by idle-task template:";

Deno.test(
  "createAllIdleTaskWrappers - every filed wrapper body carries exactly one attribution footer (Issue #3513)",
  async () => {
    const gh = makeMockGh();

    const result = await createAllIdleTaskWrappers("org/single-footer", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-eeeeee",
      workerUser: "vibe-bot",
    });

    assert(result.ok, "expected ok result");
    if (!result.ok) return;

    const creates = createCalls(gh.calls);
    assertEquals(creates.length, TEMPLATE_COUNT);

    // Every wrapper — including the six native prompts that pre-embed the
    // footer via a trailing {{ATTRIBUTION_FOOTER}} — must never carry two
    // footer lines back-to-back at the tail, and carries exactly one run-id
    // metadata block.
    for (const c of creates) {
      const body = bodyOf(c);
      assert(
        !hasAdjacentFooters(body, FOOTER_PREFIX),
        `wrapper "${titleOf(c)}" double-stamps the attribution footer`,
      );
      // The body ends with the single trailing footer then the run-id block.
      assertStringIncludes(body, "```\nrun-id: vibe-test-eeeeee\n```");
      assertEquals(
        countOccurrences(body, "run-id: vibe-test-eeeeee"),
        1,
        `wrapper "${titleOf(c)}" must carry exactly one run-id block`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// GitHub issue-body limit (Issue #3634)
// ---------------------------------------------------------------------------

Deno.test(
  "createAllIdleTaskWrappers - no filed wrapper body exceeds GitHub's 65,536-character limit (Issue #3634)",
  async () => {
    const gh = makeMockGh();
    const logLines: string[] = [];

    const result = await createAllIdleTaskWrappers("org/body-limit", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-ffffff",
      workerUser: "vibe-bot",
      log: (line) => logLines.push(line),
    });

    assert(result.ok, "expected ok result");
    if (!result.ok) return;

    const creates = createCalls(gh.calls);
    assertEquals(creates.length, TEMPLATE_COUNT);

    for (const c of creates) {
      const body = bodyOf(c);
      assert(
        body.length <= GITHUB_ISSUE_BODY_MAX_CHARS,
        `wrapper "${titleOf(c)}" body is ${body.length} characters, over the ` +
          `${GITHUB_ISSUE_BODY_MAX_CHARS}-character GitHub limit`,
      );
      // A clamped body still carries its run-id tail and says so loudly.
      assertStringIncludes(body, "run-id: vibe-test-ffffff");
      if (body.includes(IDLE_TASK_BODY_TRUNCATION_MARKER)) {
        assert(
          logLines.some((l) => l.includes("action=truncated_body")),
          "a truncated body must be logged, never dropped silently",
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// partial-skip
// ---------------------------------------------------------------------------

Deno.test(
  "createAllIdleTaskWrappers - skips wrappers already open and files the rest",
  async () => {
    const gh = makeMockGh();
    // Two canonical wrappers already open.
    const alreadyOpen = new Set<string>([
      IDLE_TASK_WRAPPER_TITLES[0]!,
      IDLE_TASK_WRAPPER_TITLES[1]!,
    ]);

    const result = await createAllIdleTaskWrappers("org/partial", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () =>
        Promise.resolve(openIdleTaskIssues([...alreadyOpen])),
      // Issue #2752: without force any open issue blocks the whole sweep;
      // force exercises the per-title dedup this test covers.
      force: true,
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-bbbbbb",
    });

    assert(result.ok);
    if (!result.ok) return;

    assertEquals(result.value.created.length, TEMPLATE_COUNT - 2);
    assertEquals(result.value.skipped.length, 2);

    const creates = createCalls(gh.calls);
    assertEquals(creates.length, TEMPLATE_COUNT - 2);

    // None of the filed titles is one of the already-open ones.
    for (const c of creates) {
      assert(!alreadyOpen.has(titleOf(c)));
    }
  },
);

// ---------------------------------------------------------------------------
// full-skip
// ---------------------------------------------------------------------------

Deno.test(
  "createAllIdleTaskWrappers - files nothing when all wrappers are already open",
  async () => {
    const gh = makeMockGh();
    const allOpen = new Set<string>(IDLE_TASK_WRAPPER_TITLES);

    const result = await createAllIdleTaskWrappers("org/full", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () =>
        Promise.resolve(openIdleTaskIssues([...allOpen])),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-cccccc",
    });

    assert(result.ok);
    if (!result.ok) return;

    assertEquals(result.value.created.length, 0);
    assertEquals(result.value.skipped.length, TEMPLATE_COUNT);
    assertEquals(createCalls(gh.calls).length, 0);
  },
);

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

Deno.test(
  "createAllIdleTaskWrappers - returns error when label ensure fails",
  async () => {
    const gh = makeMockGh();
    const result = await createAllIdleTaskWrappers("org/x", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () =>
        Promise.resolve({ ok: false, error: new Error("no perms") }),
      findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
    });
    assert(!result.ok);
    assertEquals(createCalls(gh.calls).length, 0);
  },
);

Deno.test(
  "createAllIdleTaskWrappers - rejects an empty repo argument",
  async () => {
    const result = await createAllIdleTaskWrappers("   ", {
      ensureLabelFn: () => labelOk(),
    });
    assert(!result.ok);
  },
);

// ---------------------------------------------------------------------------
// Partial progress and terminal-failure classification (Issue #3862)
// ---------------------------------------------------------------------------

/**
 * Mock gh whose `issue create` throws `error` on the `failOnCreate`-th call
 * (1-based) and succeeds otherwise.
 */
function makeFailingGh(opts: { failOnCreate: number; error: Error }) {
  const calls: GhCall[] = [];
  let creates = 0;
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "create") {
      creates++;
      if (creates === opts.failOnCreate) return Promise.reject(opts.error);
      return Promise.resolve("https://github.com/org/repo/issues/1\n");
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

Deno.test(
  "createAllIdleTaskWrappers - a mid-sweep gh failure preserves partial progress and continues",
  async () => {
    // Two wrappers already open, so the sweep both creates and skips before
    // the failure lands.
    const alreadyOpen = new Set<string>([
      IDLE_TASK_WRAPPER_TITLES[0]!,
      IDLE_TASK_WRAPPER_TITLES[1]!,
    ]);
    const gh = makeFailingGh({
      failOnCreate: 3,
      error: new Error("gh issue create exploded"),
    });

    const result = await createAllIdleTaskWrappers("org/partial-progress", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () =>
        Promise.resolve(openIdleTaskIssues([...alreadyOpen])),
      // Issue #2752: force keeps the sweep past the any-open gate so it
      // both skips and creates before the failure lands.
      force: true,
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-partial",
    });

    assert(!result.ok, "a failed template must fail the sweep loudly");
    if (result.ok) return;

    const partial = partialFromSweepError(result.error);
    // Two skipped; the third create attempt failed, the rest ran.
    assertEquals(partial.created.length, TEMPLATE_COUNT - 3);
    assertEquals(partial.skipped.length, 2);
    assertEquals(partial.failed?.length, 1);
    assertEquals(partial.failed?.[0]?.terminal, false);
    assertStringIncludes(partial.failed?.[0]?.reason ?? "", "exploded");
    assertEquals(partial.aborted, undefined);
    assertEquals(isTerminalSweepError(result.error), false);

    // The sweep attempted every creatable template despite the failure.
    assertEquals(createCalls(gh.calls).length, TEMPLATE_COUNT - 2);
  },
);

Deno.test(
  "createAllIdleTaskWrappers - an off-allowlist repo aborts in preflight with zero gh calls",
  async () => {
    const gh = makeMockGh();
    const ensureCalls: string[] = [];
    seedWriteRepoAllowlist("org/allowed");
    try {
      const result = await createAllIdleTaskWrappers("org/blocked", {
        ghCommandFn: gh.fn,
        ensureLabelFn: (r) => {
          ensureCalls.push(r);
          return labelOk();
        },
        findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
        nowFn: stableNow,
        rootDir: REPO_ROOT,
        runId: "vibe-test-blocked",
      });

      assert(!result.ok, "an off-allowlist target must be refused");
      if (result.ok) return;

      // Names the blocked repo and the active allowlist.
      assertStringIncludes(result.error.message, "org/blocked");
      assertStringIncludes(result.error.message, "org/allowed");
      assert(isTerminalSweepError(result.error), "refusal must be terminal");

      // Nothing was attempted — no body built, no blocked-write audit event.
      assertEquals(gh.calls.length, 0);
      assertEquals(ensureCalls.length, 0);
      const partial = partialFromSweepError(result.error);
      assertEquals(partial.created.length, 0);
      assertEquals(partial.skipped.length, 0);
    } finally {
      resetWriteRepoAllowlist();
    }
  },
);

Deno.test(
  "createAllIdleTaskWrappers - a blocked write mid-sweep aborts immediately with partial progress",
  async () => {
    const gh = makeFailingGh({
      failOnCreate: 2,
      error: new WriteRepoBlockedError("org/blocked-mid", "issue-create"),
    });

    const result = await createAllIdleTaskWrappers("org/blocked-mid", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-blocked-mid",
    });

    assert(!result.ok);
    if (result.ok) return;

    assert(isTerminalSweepError(result.error), "block must be terminal");
    assertStringIncludes(result.error.message, "org/blocked-mid");

    const partial = partialFromSweepError(result.error);
    assertEquals(partial.created.length, 1);
    assertEquals(partial.failed?.length, 1);
    assertEquals(partial.failed?.[0]?.terminal, true);
    assertEquals(partial.aborted, true);

    // Exactly one blocked write attempted — the remaining templates were not.
    assertEquals(createCalls(gh.calls).length, 2);
  },
);

Deno.test(
  "formatIdleTaskOutcomeTable - renders one row per template outcome",
  () => {
    const lines = formatIdleTaskOutcomeTable("org/table", {
      created: ["security-scan"],
      skipped: ["test-audit"],
      failed: [{ template: "dead-code", reason: "boom", terminal: false }],
    });
    const text = lines.join("\n");
    assertStringIncludes(text, "org/table");
    assertStringIncludes(text, "security-scan");
    assertStringIncludes(text, "created");
    assertStringIncludes(text, "test-audit");
    assertStringIncludes(text, "already_open");
    assertStringIncludes(text, "dead-code");
    assertStringIncludes(text, "boom");
  },
);

Deno.test(
  "createAllIdleTaskWrappers - surfaces gh issue create failure",
  async () => {
    const gh = makeMockGh({ createThrows: true });
    const result = await createAllIdleTaskWrappers("org/boom", {
      ghCommandFn: gh.fn,
      ensureLabelFn: () => labelOk(),
      findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
      runId: "vibe-test-dddddd",
    });
    assert(!result.ok);
  },
);

// ---------------------------------------------------------------------------
// Worker-side sweep journalling (Issue #3860)
//
// A worker-initiated sweep must leave a complete audit trail: every write is
// an explicit `gh issue create --repo <target>`, so the shared `spawnGh`
// chokepoint classifies it against the target repo and records it under that
// repo in the audit journal. A write that lost its `--repo` (or gained an
// undeterminable target) would be journalled against the wrong repo — or fail
// closed — and this case catches that.
// ---------------------------------------------------------------------------

Deno.test("createAllIdleTaskWrappers - every write classifies against the target repo", async () => {
  const target = "stSoftwareAU/private-repo-14";
  const classified: MutationInfo[] = [];
  const gh = (args: string[]): Promise<string> => {
    // Stand-in for the chokepoint: classify exactly what `spawnGh` would.
    const info = classifyGhMutation(args);
    if (info) classified.push(info);
    return Promise.resolve("[]");
  };

  const result = await createAllIdleTaskWrappers(target, {
    ghCommandFn: gh,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
    nowFn: () => new Date("2026-01-01T00:00:00Z"),
    rootDir: REPO_ROOT,
  });

  assert(result.ok, "sweep must succeed");
  assertEquals(
    classified.length,
    result.value.created.length,
    "one journalled mutation per wrapper filed",
  );
  assert(classified.length > 0, "the sweep must file at least one wrapper");
  for (const info of classified) {
    assertEquals(info.verb, "issue-create");
    assertEquals(
      info.repo,
      target,
      "every write must name the target repo explicitly",
    );
    assert(
      info.scope !== "unknown",
      "an undeterminable target would fail closed at the chokepoint",
    );
  }
});

// ---------------------------------------------------------------------------
// Any-open idle-task gate (Issue #2752)
//
// On-demand raises must not stack a second batch on a repo that already has
// any open `idle-task` issue — whatever its title (a hand-edited wrapper, a
// `Finish #N:` continuation) and whatever else it is labelled with.
// ---------------------------------------------------------------------------

/**
 * Mock gh whose `issue list` returns `listOutput` (or throws `listThrows`) and
 * whose `issue create` succeeds; every call is recorded.
 */
function makeListGh(opts: { listOutput?: string; listThrows?: Error }) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "list") {
      if (opts.listThrows) return Promise.reject(opts.listThrows);
      return Promise.resolve(opts.listOutput ?? "[]");
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/org/monitored/issues/4242\n");
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

/** Run a sweep against the real default lookup, capturing log lines. */
async function sweepWithDefaultLookup(
  repo: string,
  gh: (args: string[]) => Promise<string>,
  extra: { force?: boolean } = {},
) {
  const lines: string[] = [];
  const result = await createAllIdleTaskWrappers(repo, {
    ghCommandFn: gh,
    ensureLabelFn: () => labelOk(),
    nowFn: stableNow,
    rootDir: REPO_ROOT,
    runId: "vibe-test-gate",
    log: (line) => lines.push(line),
    ...extra,
  });
  return { result, lines };
}

Deno.test(
  "createAllIdleTaskWrappers - an open Finish #N: idle-task issue labelled needs-human blocks the whole sweep",
  async () => {
    // Failure-detection case from the issue: labels are irrelevant — any open
    // idle-task issue blocks.
    const gh = makeListGh({
      listOutput: JSON.stringify([{
        number: 638,
        title: "Finish #638: tidy docs",
        url: "https://github.com/org/blocked/issues/638",
        labels: [{ name: "idle-task" }, { name: "needs-human" }],
      }]),
    });

    const { result, lines } = await sweepWithDefaultLookup(
      "org/blocked",
      gh.fn,
    );

    assert(result.ok, "a blocked repo is a clean skip, not an error");
    if (!result.ok) return;
    assertEquals(createCalls(gh.calls).length, 0);
    assertEquals(result.value.created.length, 0);
    assertEquals(result.value.blockedBy?.number, 638);
    assertEquals(result.value.skipped.length, TEMPLATE_COUNT);
    assert(
      lines.some((l) =>
        l.includes(
          "[idle-task] repo=org/blocked issue=638 action=skipped reason=existing_wrapper_open",
        )
      ),
      `expected the existing_wrapper_open skip log, got: ${lines.join("\n")}`,
    );
  },
);

Deno.test(
  "createAllIdleTaskWrappers - a non-canonical open idle-task title blocks the whole sweep",
  async () => {
    const gh = makeListGh({
      listOutput: JSON.stringify([{
        number: 77,
        title: "Hand-edited: audit the docs",
        url: "https://github.com/org/blocked/issues/77",
      }]),
    });

    const { result } = await sweepWithDefaultLookup("org/blocked", gh.fn);

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(createCalls(gh.calls).length, 0);
    assertEquals(result.value.blockedBy?.number, 77);
  },
);

Deno.test(
  "createAllIdleTaskWrappers - an open idle-task issue also labelled failed blocks the sweep",
  async () => {
    const gh = makeListGh({
      listOutput: JSON.stringify([{
        number: 12,
        title: IDLE_TASK_WRAPPER_TITLES[0],
        url: "https://github.com/org/blocked/issues/12",
        labels: [{ name: "idle-task" }, { name: "failed" }],
      }]),
    });

    const { result } = await sweepWithDefaultLookup("org/blocked", gh.fn);

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(createCalls(gh.calls).length, 0);
    assertEquals(result.value.blockedBy?.number, 12);
  },
);

Deno.test(
  "createAllIdleTaskWrappers - the default lookup asks for open idle-task issues only",
  async () => {
    const gh = makeListGh({ listOutput: "[]" });

    const { result } = await sweepWithDefaultLookup("org/clean", gh.fn);

    assert(result.ok);
    const lists = gh.calls.filter((c) =>
      c.args[0] === "issue" && c.args[1] === "list"
    );
    assertEquals(lists.length, 1, "the gate is checked once per sweep");
    const args = lists[0]!.args;
    assertEquals(args[args.indexOf("--state") + 1], "open");
    assertEquals(args[args.indexOf("--label") + 1], "idle-task");
    assertEquals(args[args.indexOf("--repo") + 1], "org/clean");
    assertStringIncludes(args[args.indexOf("--json") + 1]!, "number");
  },
);

Deno.test(
  "createAllIdleTaskWrappers - a clean repo still gets the full template set",
  async () => {
    const gh = makeListGh({ listOutput: "[]" });

    const { result } = await sweepWithDefaultLookup("org/clean", gh.fn);

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.blockedBy, undefined);
    assertEquals(result.value.created.length, TEMPLATE_COUNT);
    assertEquals(createCalls(gh.calls).length, TEMPLATE_COUNT);
  },
);

for (
  const [label, opts] of [
    ["non-JSON output", { listOutput: "not json" }],
    ["a non-array JSON value", { listOutput: '{"number":1}' }],
    ["a thrown lookup", { listThrows: new Error("gh: HTTP 502") }],
  ] as const
) {
  Deno.test(
    `createAllIdleTaskWrappers - ${label} from the lookup fails closed and files nothing`,
    async () => {
      const gh = makeListGh(opts);

      const { result, lines } = await sweepWithDefaultLookup(
        "org/flaky",
        gh.fn,
      );

      assert(!result.ok, "a failed lookup must never be treated as clean");
      if (result.ok) return;
      assertEquals(createCalls(gh.calls).length, 0);
      assertEquals(partialFromSweepError(result.error).created.length, 0);
      assert(
        lines.some((l) =>
          l.includes(
            "[idle-task] repo=org/flaky action=skipped reason=lookup_failed",
          )
        ),
        `expected the lookup_failed skip log, got: ${lines.join("\n")}`,
      );
    },
  );
}

Deno.test(
  "createAllIdleTaskWrappers - force bypasses the gate but keeps exact-title dedup",
  async () => {
    const gh = makeListGh({
      listOutput: JSON.stringify([
        {
          number: 1,
          title: IDLE_TASK_WRAPPER_TITLES[0],
          url: "https://github.com/org/forced/issues/1",
        },
        {
          number: 638,
          title: "Finish #638: tidy docs",
          url: "https://github.com/org/forced/issues/638",
        },
      ]),
    });

    const { result } = await sweepWithDefaultLookup("org/forced", gh.fn, {
      force: true,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.blockedBy, undefined);
    assertEquals(result.value.created.length, TEMPLATE_COUNT - 1);
    assertEquals(result.value.skipped.length, 1);
    const titles = createCalls(gh.calls).map(titleOf);
    assert(!titles.includes(IDLE_TASK_WRAPPER_TITLES[0]!));
  },
);
