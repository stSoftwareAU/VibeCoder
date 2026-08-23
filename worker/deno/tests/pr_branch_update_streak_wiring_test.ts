/**
 * The branch-update pass must stop retrying an un-updatable branch (#335).
 *
 * `executePrBranchUpdates` logged each failure and moved on, so one branch in
 * `stSoftwareAU/NEAT-AI-core` produced 65 identical warnings across days. It
 * now counts consecutive failing cycles per `(repo, branch)`, escalates once
 * at the threshold, then skips the branch instead of retrying it every cycle.
 *
 * These tests drive the real streak state (only `gh` is stubbed) through the
 * real execution loop, and assert on outcomes: how many update attempts were
 * made, how many issues were filed, and what the streak file holds.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  executePrBranchUpdates,
  type PrBranchExecutionDeps,
  type PrBranchUpdateAction,
} from "../lib/pr_branch_update.ts";
import {
  loadPrBranchFailureStreaks,
  PR_BRANCH_UPDATE_FAILURE_THRESHOLD,
  prBranchFailureKey,
  prBranchFailureStatePath,
} from "../lib/pr_branch_update_failure_streak.ts";
import type { Logger, Result } from "../types.ts";

const REPO = "stSoftwareAU/NEAT-AI-core";
const BRANCH = "issue-3832-detect-cycles-linear";
const CHECKOUT_ERROR =
  `Failed to checkout branch '${BRANCH}': error: pathspec '${BRANCH}' did ` +
  `not match any file(s) known to git`;

function makeLogger(lines: string[]): Logger {
  const noop = () => {};
  const capture = (message: string) => lines.push(message);
  return {
    info: capture,
    warn: capture,
    error: capture,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeAction(
  overrides?: Partial<PrBranchUpdateAction>,
): PrBranchUpdateAction {
  return {
    repo: REPO,
    prNumber: 3847,
    branchName: BRANCH,
    baseBranch: "Develop",
    behindBy: 2,
    reason: "behind",
    ...overrides,
  };
}

/** A `gh` stub that answers the escalation search and create calls. */
function makeGh(calls: string[][]) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list") return Promise.resolve("[]");
    if (args[1] === "create") {
      return Promise.resolve(`https://github.com/${REPO}/issues/4321\n`);
    }
    return Promise.reject(new Error(`unrouted: ${args.join(" ")}`));
  };
}

interface Harness {
  deps: (cycleId: string) => PrBranchExecutionDeps;
  attempts: string[];
  ghCalls: string[][];
  logLines: string[];
  statePath: string;
}

/** Build execution deps whose branch update always fails, unless told not to. */
function makeHarness(
  workDir: string,
  updateResult: () => Result<string>,
): Harness {
  const attempts: string[] = [];
  const ghCalls: string[][] = [];
  const logLines: string[] = [];
  const statePath = prBranchFailureStatePath(workDir);
  return {
    attempts,
    ghCalls,
    logLines,
    statePath,
    deps: (cycleId: string) => ({
      workDir,
      logger: makeLogger(logLines),
      setupRepo: () =>
        Promise.resolve({ ok: true, value: `${workDir}/repo` } as Result<
          string
        >),
      getDefaultBranch: () => Promise.resolve("Develop"),
      performBranchUpdate: (params: { branchName: string }) => {
        attempts.push(params.branchName);
        return Promise.resolve(updateResult());
      },
      failureStreak: {
        statePath,
        cycleId,
        ghFn: makeGh(ghCalls),
      },
    }),
  };
}

async function withWorkDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "pr_branch_streak_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("#335 - a permanently failing branch is escalated once, then skipped", async () => {
  await withWorkDir(async (dir) => {
    const failing = () =>
      ({ ok: false, error: new Error(CHECKOUT_ERROR) }) as Result<string>;
    const h = makeHarness(dir, failing);

    for (let cycle = 0; cycle < 10; cycle++) {
      const result = await executePrBranchUpdates(
        [makeAction()],
        h.deps(`cycle-${cycle}`),
      );
      assertEquals(result.ok, true);
    }

    // Attempted only until the threshold — not on every one of the 10 cycles.
    assertEquals(h.attempts.length, PR_BRANCH_UPDATE_FAILURE_THRESHOLD);
    // Exactly one issue filed, naming the branch and git's own failure.
    const creates = h.ghCalls.filter((c) => c[1] === "create");
    assertEquals(creates.length, 1);
    const body = creates[0]![creates[0]!.indexOf("--body") + 1]!;
    assertStringIncludes(body, "pathspec");
    assertStringIncludes(body, "3 consecutive cycles");
    // And the escalation warning is logged once, not on every cycle.
    assertEquals(
      h.logLines.filter((l) => l.includes("consecutive cycles — escalated as"))
        .length,
      1,
    );
  });
});

Deno.test("#335 - the suppressed branch is reported, not silently dropped", async () => {
  await withWorkDir(async (dir) => {
    const failing = () =>
      ({ ok: false, error: new Error(CHECKOUT_ERROR) }) as Result<string>;
    const h = makeHarness(dir, failing);

    let last;
    for (let cycle = 0; cycle < 5; cycle++) {
      last = await executePrBranchUpdates(
        [makeAction()],
        h.deps(`cycle-${cycle}`),
      );
    }

    if (!last?.ok) throw new Error("expected an execution result");
    assertEquals(last.value.suppressedCount, 1);
    assertEquals(last.value.failedCount, 0, "a skipped cycle is not a failure");
    assertEquals(last.value.details.length, 1);
    assertStringIncludes(last.value.details[0]!.message, "Skipped");
    assertStringIncludes(last.value.details[0]!.message, "#4321");
  });
});

Deno.test("#335 - a transient failure that clears escalates nothing", async () => {
  await withWorkDir(async (dir) => {
    let fail = true;
    const h = makeHarness(
      dir,
      () =>
        (fail
          ? { ok: false, error: new Error(CHECKOUT_ERROR) }
          : { ok: true, value: "Updated" }) as Result<string>,
    );

    for (let cycle = 0; cycle < 12; cycle++) {
      // Fail, fail, succeed — for ever. Never three failures in a row.
      fail = cycle % 3 !== 2;
      await executePrBranchUpdates([makeAction()], h.deps(`cycle-${cycle}`));
    }

    assertEquals(h.attempts.length, 12, "every cycle still attempted");
    assertEquals(h.ghCalls.length, 0, "nothing escalated");
    assertEquals(await loadPrBranchFailureStreaks(h.statePath), {});
  });
});

Deno.test("#335 - a successful update after escalation restores normal service", async () => {
  await withWorkDir(async (dir) => {
    let fail = true;
    const h = makeHarness(
      dir,
      () =>
        (fail
          ? { ok: false, error: new Error(CHECKOUT_ERROR) }
          : { ok: true, value: "Updated" }) as Result<string>,
    );

    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await executePrBranchUpdates([makeAction()], h.deps(`cycle-${cycle}`));
    }
    const streaks = await loadPrBranchFailureStreaks(h.statePath);
    assertEquals(streaks[prBranchFailureKey(REPO, BRANCH)]?.issueNumber, 4321);

    // The branch is fixed; the next re-probe succeeds and clears the streak.
    fail = false;
    const deps = h.deps("cycle-probe");
    deps.failureStreak!.retryAfterSkips = 0;
    const result = await executePrBranchUpdates([makeAction()], deps);

    if (!result.ok) throw new Error("expected an execution result");
    assertEquals(result.value.updatedCount, 1);
    assertEquals(await loadPrBranchFailureStreaks(h.statePath), {});
  });
});

Deno.test("#335 - one escalated branch does not suppress its siblings", async () => {
  await withWorkDir(async (dir) => {
    const badBranch = makeAction();
    const goodBranch = makeAction({
      prNumber: 3900,
      branchName: "issue-3900-other-work",
    });
    const h = makeHarness(
      dir,
      () => ({ ok: false, error: new Error(CHECKOUT_ERROR) }) as Result<string>,
    );

    // The bad branch alone fails its way to escalation.
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await executePrBranchUpdates([badBranch], h.deps(`cycle-${cycle}`));
    }
    h.attempts.length = 0;

    // Now both are queued: the sibling must still be attempted.
    await executePrBranchUpdates(
      [badBranch, goodBranch],
      h.deps("cycle-later"),
    );
    assertEquals(h.attempts, ["issue-3900-other-work"]);
  });
});

Deno.test("#335 - without the streak deps the pass behaves exactly as before", async () => {
  await withWorkDir(async (dir) => {
    const logLines: string[] = [];
    const attempts: string[] = [];
    const deps: PrBranchExecutionDeps = {
      workDir: dir,
      logger: makeLogger(logLines),
      setupRepo: () =>
        Promise.resolve({ ok: true, value: `${dir}/repo` } as Result<string>),
      getDefaultBranch: () => Promise.resolve("Develop"),
      performBranchUpdate: (params: { branchName: string }) => {
        attempts.push(params.branchName);
        return Promise.resolve(
          { ok: false, error: new Error(CHECKOUT_ERROR) } as Result<string>,
        );
      },
    };

    for (let cycle = 0; cycle < 6; cycle++) {
      const result = await executePrBranchUpdates([makeAction()], deps);
      if (!result.ok) throw new Error("expected an execution result");
      assertEquals(result.value.failedCount, 1);
    }
    assertEquals(attempts.length, 6, "every cycle retried, as today");
    assertEquals(
      await loadPrBranchFailureStreaks(prBranchFailureStatePath(dir)),
      {},
      "no state written when tracking is not wired",
    );
  });
});
