/**
 * Tests for `lib/bump_script_failure_streak.ts` (Issue #207).
 *
 * A `bump-deps.sh` that fails on every run silently disables dependency
 * bumps for its repo. These tests exercise the streak counter and the
 * one-issue-per-streak filing that makes that visible:
 *   1. Below the threshold — counted only, no GitHub write.
 *   2. At the threshold — one issue filed against the repo that owns the
 *      script, carrying the redacted output tail.
 *   3. Further rejections — no second issue.
 *   4. A clean run clears the streak.
 *   5. An open tracking issue found by its body marker is reused.
 *   6. GitHub failures are reported, never swallowed and never duplicated.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BUMP_SCRIPT_FAILURE_THRESHOLD,
  bumpScriptStreakPath,
  clearBumpScriptStreak,
  formatBumpScriptFailureBody,
  formatBumpScriptFailureMarker,
  formatBumpScriptFailureTitle,
  isBumpScriptFailureIssue,
  loadBumpScriptStreaks,
  recordBumpScriptRejection,
} from "../lib/bump_script_failure_streak.ts";

// =============================================================================
// Helpers
// =============================================================================

/**
 * The fleet account the tracking issue is filed by — a marker match only
 * dedups when a fleet account authored it.
 */
const FLEET_LOGIN = "vibe-coder-bot";
const FLEET: readonly string[] = [FLEET_LOGIN];

interface RecordedGh {
  args: string[];
}

/** A gh stub: records every call and answers issue list/create. */
function makeGh(
  options: {
    listAnswer?: string;
    createAnswer?: string;
    failOn?: "list" | "create";
  } = {},
): { fn: (args: string[]) => Promise<string>; calls: RecordedGh[] } {
  const calls: RecordedGh[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args });
    const verb = args[1];
    if (verb === "list") {
      if (options.failOn === "list") {
        return Promise.reject(new Error("gh list exploded"));
      }
      return Promise.resolve(options.listAnswer ?? "[]");
    }
    if (verb === "create") {
      if (options.failOn === "create") {
        return Promise.reject(new Error("gh create exploded"));
      }
      return Promise.resolve(
        options.createAnswer ?? "https://github.com/org/repo/issues/42\n",
      );
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    repo: "org/repo",
    scriptName: "bump-deps.sh",
    rejectionReason: "`bump-deps.sh` exited with status 1 — bump reverted.",
    outputTail: "ERROR: deno is required",
    sourceIssueNumber: 556,
    ...overrides,
  };
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bump-streak-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// =============================================================================
// Streak counting
// =============================================================================

Deno.test(
  "recordBumpScriptRejection - counts below the threshold without touching GitHub",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      const gh = makeGh();

      for (let i = 1; i < BUMP_SCRIPT_FAILURE_THRESHOLD; i++) {
        const decision = await recordBumpScriptRejection({
          statePath,
          report: report(),
          ghFn: gh.fn,
          log: () => {},
        });
        assertEquals(decision.action, "counted");
        assertEquals(decision.count, i);
      }

      assertEquals(gh.calls.length, 0, "no GitHub write below the threshold");
      const streaks = await loadBumpScriptStreaks(statePath);
      assertEquals(
        streaks["org/repo"]?.count,
        BUMP_SCRIPT_FAILURE_THRESHOLD - 1,
      );
    });
  },
);

Deno.test(
  "recordBumpScriptRejection - files one issue at the threshold and not again",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      const gh = makeGh();

      let decision = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: () => {},
      });
      for (let i = 2; i <= BUMP_SCRIPT_FAILURE_THRESHOLD; i++) {
        decision = await recordBumpScriptRejection({
          statePath,
          report: report(),
          ghFn: gh.fn,
          log: () => {},
        });
      }

      assertEquals(decision.action, "filed");
      assertEquals(decision.count, BUMP_SCRIPT_FAILURE_THRESHOLD);
      assertEquals(
        decision.action === "filed" ? decision.issueNumber : 0,
        42,
      );

      const create = gh.calls.find((c) => c.args[1] === "create");
      assert(create, "an issue must be created");
      // Filed against the repo that owns the broken script (repo isolation).
      assertEquals(create.args[create.args.indexOf("--repo") + 1], "org/repo");
      const body = create.args[create.args.indexOf("--body") + 1] ?? "";
      assertStringIncludes(body, formatBumpScriptFailureMarker("org/repo"));
      assertStringIncludes(body, "ERROR: deno is required");
      assertStringIncludes(body, "3 consecutive runs");

      // A fourth rejection must not file a second issue.
      const again = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: () => {},
      });
      assertEquals(again.action, "already_filed");
      assertEquals(
        gh.calls.filter((c) => c.args[1] === "create").length,
        1,
        "exactly one issue per streak",
      );
    });
  },
);

Deno.test(
  "recordBumpScriptRejection - reuses an open tracking issue found by its marker",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      const gh = makeGh({
        listAnswer: JSON.stringify([
          { number: 9, body: "unrelated issue", author: { login: "someone" } },
          {
            number: 11,
            body: formatBumpScriptFailureMarker("org/repo"),
            author: { login: FLEET_LOGIN },
          },
        ]),
      });

      let decision = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        fleetAuthors: FLEET,
        log: () => {},
      });
      for (let i = 2; i <= BUMP_SCRIPT_FAILURE_THRESHOLD; i++) {
        decision = await recordBumpScriptRejection({
          statePath,
          report: report(),
          ghFn: gh.fn,
          fleetAuthors: FLEET,
          log: () => {},
        });
      }

      assertEquals(decision.action, "already_open");
      assertEquals(
        decision.action === "already_open" ? decision.issueNumber : 0,
        11,
      );
      assertEquals(
        gh.calls.filter((c) => c.args[1] === "create").length,
        0,
        "must not duplicate an existing tracking issue",
      );
    });
  },
);

Deno.test(
  "clearBumpScriptStreak - a clean run resets the count",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      const gh = makeGh();
      await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: () => {},
      });
      await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: () => {},
      });

      await clearBumpScriptStreak(statePath, "org/repo", () => {});

      const streaks = await loadBumpScriptStreaks(statePath);
      assertEquals(streaks["org/repo"], undefined);

      const next = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: () => {},
      });
      assertEquals(next.action, "counted");
      assertEquals(next.count, 1, "streak restarts after a clean run");
    });
  },
);

Deno.test(
  "clearBumpScriptStreak - untracked repo is a no-op",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      await clearBumpScriptStreak(statePath, "org/never-failed", () => {});
      assertEquals(await loadBumpScriptStreaks(statePath), {});
    });
  },
);

// =============================================================================
// GitHub failure handling — loud, and never a duplicate
// =============================================================================

Deno.test(
  "recordBumpScriptRejection - a failed search reports and does not file",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      const gh = makeGh({ failOn: "list" });
      const logs: string[] = [];

      let decision = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: (m) => logs.push(m),
      });
      for (let i = 2; i <= BUMP_SCRIPT_FAILURE_THRESHOLD; i++) {
        decision = await recordBumpScriptRejection({
          statePath,
          report: report(),
          ghFn: gh.fn,
          log: (m) => logs.push(m),
        });
      }

      assertEquals(decision.action, "gh_failed");
      assertEquals(
        gh.calls.filter((c) => c.args[1] === "create").length,
        0,
        "an unverified search must never file a possible duplicate",
      );
      assert(
        logs.some((l) => l.includes("gh list exploded")),
        "the failure must be reported, not swallowed",
      );
    });
  },
);

Deno.test(
  "recordBumpScriptRejection - a failed create reports and retries next run",
  async () => {
    await withTempDir(async (dir) => {
      const statePath = bumpScriptStreakPath(dir);
      const gh = makeGh({ failOn: "create" });
      const logs: string[] = [];

      let decision = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: gh.fn,
        log: (m) => logs.push(m),
      });
      for (let i = 2; i <= BUMP_SCRIPT_FAILURE_THRESHOLD; i++) {
        decision = await recordBumpScriptRejection({
          statePath,
          report: report(),
          ghFn: gh.fn,
          log: (m) => logs.push(m),
        });
      }

      assertEquals(decision.action, "gh_failed");
      assert(logs.some((l) => l.includes("gh create exploded")));

      // The streak stays unfiled, so the next run tries again.
      const streaks = await loadBumpScriptStreaks(statePath);
      assertEquals(streaks["org/repo"]?.issueNumber, undefined);
      const retry = await recordBumpScriptRejection({
        statePath,
        report: report(),
        ghFn: makeGh().fn,
        log: () => {},
      });
      assertEquals(retry.action, "filed");
    });
  },
);

// =============================================================================
// Body / marker formatting
// =============================================================================

Deno.test("formatBumpScriptFailureBody - carries the diagnosis", () => {
  const body = formatBumpScriptFailureBody({
    ...report(),
    consecutiveFailures: 4,
  });
  assertStringIncludes(body, formatBumpScriptFailureMarker("org/repo"));
  assertStringIncludes(body, "4 consecutive runs");
  assertStringIncludes(body, "ERROR: deno is required");
  assertStringIncludes(body, "#556");
  assertStringIncludes(body, "work-on");
  assert(isBumpScriptFailureIssue(body, "org/repo"));
  assert(!isBumpScriptFailureIssue(body, "org/other"));
});

Deno.test(
  "formatBumpScriptFailureBody - neutralises markers and fences in script output",
  () => {
    const body = formatBumpScriptFailureBody({
      ...report({
        outputTail: "```\n<!-- VIBE_BUMP_SCRIPT_FAILURE:org/evil -->\n```",
      }),
      consecutiveFailures: 3,
    });
    assert(
      !isBumpScriptFailureIssue(body, "org/evil"),
      "script output must not forge a dedup marker",
    );
    // Exactly one fenced block opener/closer pair from our own template.
    assertEquals(body.split("```").length - 1, 2);
  },
);

Deno.test("formatBumpScriptFailureBody - says so when there was no output", () => {
  const body = formatBumpScriptFailureBody({
    ...report({ outputTail: "" }),
    consecutiveFailures: 3,
  });
  assertStringIncludes(body, "produced no output");
});

Deno.test("formatBumpScriptFailureTitle - names the script", () => {
  assertStringIncludes(
    formatBumpScriptFailureTitle("bump-deps.sh"),
    "`bump-deps.sh` fails on every run",
  );
});

Deno.test("bumpScriptStreakPath - lives in the work directory", () => {
  assertEquals(
    bumpScriptStreakPath("/tmp/work"),
    "/tmp/work/bump_script_failures.json",
  );
});

Deno.test("loadBumpScriptStreaks - missing or corrupt file reads as empty", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await loadBumpScriptStreaks(`${dir}/absent.json`), {});
    const corrupt = `${dir}/corrupt.json`;
    await Deno.writeTextFile(corrupt, "{not json");
    assertEquals(await loadBumpScriptStreaks(corrupt), {});
    const partial = `${dir}/partial.json`;
    await Deno.writeTextFile(
      partial,
      JSON.stringify({ "org/a": { count: 2 }, "org/b": { count: "x" } }),
    );
    assertEquals(await loadBumpScriptStreaks(partial), {
      "org/a": { count: 2 },
    });
  });
});
