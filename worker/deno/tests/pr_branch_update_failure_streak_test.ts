/**
 * Tests for consecutive PR branch-update failure streaks (Issue #335).
 *
 * The failure these encode: `Failed to checkout branch
 * 'issue-3832-detect-cycles-linear'` was logged 65 times across recent cycles
 * for one branch in `stSoftwareAU/NEAT-AI-core`, at WARNING, with no
 * escalation, no per-branch count and no git error to act on.
 *
 * The rules that matter here: **cycles, not attempts**; **per `(repo,
 * branch)`**, so one bad branch cannot suppress the rest; and a transient
 * failure that clears escalates nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkPrBranchUpdateSuppression,
  clearPrBranchUpdateFailure,
  formatPrBranchFailureBody,
  formatPrBranchFailureMarker,
  isPrBranchFailureIssue,
  loadPrBranchFailureStreaks,
  PR_BRANCH_UPDATE_FAILURE_THRESHOLD,
  prBranchFailureKey,
  prBranchFailureStatePath,
  recordPrBranchUpdateFailure,
} from "../lib/pr_branch_update_failure_streak.ts";

const REPO = "stSoftwareAU/NEAT-AI-core";
const BRANCH = "issue-3832-detect-cycles-linear";
const OTHER_BRANCH = "issue-3812-memetic-weights-empty-and-ancestry";

/** A scripted `gh` recording every call. */
function gh(replies: { match: RegExp; reply: string | Error }[]) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const r of replies) {
      if (r.match.test(joined)) {
        return r.reply instanceof Error
          ? Promise.reject(r.reply)
          : Promise.resolve(r.reply);
      }
    }
    return Promise.reject(new Error(`unrouted: ${joined}`));
  };
  return { fn, calls };
}

const NO_EXISTING = { match: /issue list/, reply: "[]" };
const CREATE_OK = {
  match: /issue create/,
  reply: "https://github.com/stSoftwareAU/NEAT-AI-core/issues/4321\n",
};

async function withState(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(prBranchFailureStatePath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const report = {
  repo: REPO,
  prNumber: 3847,
  branch: BRANCH,
  baseBranch: "Develop",
  error:
    "Failed to checkout branch 'issue-3832-detect-cycles-linear': error: " +
    "pathspec did not match any file(s) known to git",
};

// ===========================================================================
// Cycles, not attempts
// ===========================================================================

Deno.test("#335 - repeated failures within one cycle count once", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const decision = await recordPrBranchUpdateFailure({
        statePath,
        cycleId: "run-a",
        report,
        ghFn: fn,
      });
      if (attempt === 0) assertEquals(decision.action, "counted");
      else assertEquals(decision.action, "already-counted");
      assertEquals(decision.count, 1);
    }
    assertEquals(calls.length, 0, "no issue filed below the threshold");
  });
});

// ===========================================================================
// Escalation at the threshold — once, not every cycle
// ===========================================================================

Deno.test("#335 - files one issue at the threshold and not again", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    const actions: string[] = [];
    for (
      let cycle = 0;
      cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD + 3;
      cycle++
    ) {
      const decision = await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
      actions.push(decision.action);
    }
    assertEquals(
      actions.slice(0, PR_BRANCH_UPDATE_FAILURE_THRESHOLD - 1).every((a) =>
        a === "counted"
      ),
      true,
    );
    assertEquals(actions[PR_BRANCH_UPDATE_FAILURE_THRESHOLD - 1], "filed");
    assertEquals(
      actions.slice(PR_BRANCH_UPDATE_FAILURE_THRESHOLD).every((a) =>
        a === "already-filed"
      ),
      true,
      `expected no re-filing, got ${actions.join(",")}`,
    );
    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "create").length,
      1,
    );
  });
});

Deno.test("#335 - the filed issue names the PR, count and git error", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    const create = calls.find((c) => c[1] === "create");
    if (!create) throw new Error("expected an issue to be created");
    const title = create[create.indexOf("--title") + 1]!;
    const body = create[create.indexOf("--body") + 1]!;
    assertStringIncludes(title, "3847");
    assertStringIncludes(title, BRANCH);
    assertStringIncludes(body, formatPrBranchFailureMarker(REPO, BRANCH));
    assertStringIncludes(body, "3 consecutive cycles");
    assertStringIncludes(body, "pathspec did not match");
    assertStringIncludes(body, "Develop");
    assertStringIncludes(body, "work-on");
  });
});

Deno.test("#335 - an existing open escalation issue is adopted, not duplicated", async () => {
  await withState(async (statePath) => {
    const existing = JSON.stringify([
      { number: 77, body: formatPrBranchFailureMarker(REPO, BRANCH) },
    ]);
    const { fn, calls } = gh([
      { match: /issue list/, reply: existing },
      CREATE_OK,
    ]);
    let last;
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      last = await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    assertEquals(last?.action, "already-open");
    assertEquals(
      calls.filter((c) => c[1] === "create").length,
      0,
      "must not file a duplicate",
    );
  });
});

Deno.test("#335 - a failed issue search does not file (a duplicate is worse)", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([
      { match: /issue list/, reply: new Error("gh: API rate limited") },
      CREATE_OK,
    ]);
    let last;
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      last = await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
        log: () => {},
      });
    }
    assertEquals(last?.action, "gh-failed");
    assertEquals(calls.filter((c) => c[1] === "create").length, 0);
  });
});

// ===========================================================================
// Transient failures escalate nothing
// ===========================================================================

Deno.test("#335 - a failure that clears on the next cycle escalates nothing", async () => {
  await withState(async (statePath) => {
    const { fn, calls } = gh([NO_EXISTING, CREATE_OK]);
    for (let round = 0; round < 5; round++) {
      // Two failing cycles, then a success — never reaching the threshold.
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${round}-a`,
        report,
        ghFn: fn,
      });
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${round}-b`,
        report,
        ghFn: fn,
      });
      await clearPrBranchUpdateFailure(statePath, REPO, BRANCH);
    }
    assertEquals(calls.length, 0, "no gh call at all for a transient failure");
    assertEquals(await loadPrBranchFailureStreaks(statePath), {});
  });
});

Deno.test("#335 - a success clears an escalated streak and ends suppression", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    const before = await checkPrBranchUpdateSuppression({
      statePath,
      repo: REPO,
      branch: BRANCH,
      cycleId: "run-after-filing",
    });
    assertEquals(before.suppressed, true);
    assertEquals(before.issueNumber, 4321);

    await clearPrBranchUpdateFailure(statePath, REPO, BRANCH);

    const after = await checkPrBranchUpdateSuppression({
      statePath,
      repo: REPO,
      branch: BRANCH,
      cycleId: "run-next",
    });
    assertEquals(after.suppressed, false);
    assertEquals(after.count, 0);
  });
});

// ===========================================================================
// Suppression and the bounded re-probe
// ===========================================================================

Deno.test("#335 - an un-escalated branch is never suppressed", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    await recordPrBranchUpdateFailure({
      statePath,
      cycleId: "run-0",
      report,
      ghFn: fn,
    });
    const verdict = await checkPrBranchUpdateSuppression({
      statePath,
      repo: REPO,
      branch: BRANCH,
      cycleId: "run-1",
    });
    assertEquals(verdict.suppressed, false);
    assertEquals(verdict.count, 1);
  });
});

Deno.test("#335 - an escalated branch is re-probed after the skip budget", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    const verdicts: boolean[] = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      const verdict = await checkPrBranchUpdateSuppression({
        statePath,
        repo: REPO,
        branch: BRANCH,
        cycleId: `probe-${cycle}`,
        retryAfterSkips: 3,
      });
      verdicts.push(verdict.suppressed);
    }
    assertEquals(verdicts, [
      true,
      true,
      true,
      false, // budget spent — one re-probe
      true,
      true,
      true,
      false,
    ]);
  });
});

Deno.test("#335 - suppression is stable within one cycle", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    for (let repeat = 0; repeat < 4; repeat++) {
      const verdict = await checkPrBranchUpdateSuppression({
        statePath,
        repo: REPO,
        branch: BRANCH,
        cycleId: "same-cycle",
        retryAfterSkips: 2,
      });
      assertEquals(verdict.suppressed, true);
    }
  });
});

// ===========================================================================
// Per (repo, branch) isolation
// ===========================================================================

Deno.test("#335 - one bad branch does not suppress its siblings", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    for (let cycle = 0; cycle < PR_BRANCH_UPDATE_FAILURE_THRESHOLD; cycle++) {
      await recordPrBranchUpdateFailure({
        statePath,
        cycleId: `run-${cycle}`,
        report,
        ghFn: fn,
      });
    }
    const sibling = await checkPrBranchUpdateSuppression({
      statePath,
      repo: REPO,
      branch: OTHER_BRANCH,
      cycleId: "run-x",
    });
    assertEquals(sibling.suppressed, false);

    const otherRepo = await checkPrBranchUpdateSuppression({
      statePath,
      repo: "stSoftwareAU/GRQ",
      branch: BRANCH,
      cycleId: "run-x",
    });
    assertEquals(otherRepo.suppressed, false);

    const streaks = await loadPrBranchFailureStreaks(statePath);
    assertEquals(Object.keys(streaks), [prBranchFailureKey(REPO, BRANCH)]);
  });
});

Deno.test("#335 - each branch keeps its own count", async () => {
  await withState(async (statePath) => {
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    await recordPrBranchUpdateFailure({
      statePath,
      cycleId: "run-0",
      report,
      ghFn: fn,
    });
    const second = await recordPrBranchUpdateFailure({
      statePath,
      cycleId: "run-0",
      report: { ...report, branch: OTHER_BRANCH, prNumber: 3812 },
      ghFn: fn,
    });
    assertEquals(second.count, 1, "a sibling branch starts its own streak");
    const third = await recordPrBranchUpdateFailure({
      statePath,
      cycleId: "run-1",
      report,
      ghFn: fn,
    });
    assertEquals(third.count, 2);
  });
});

// ===========================================================================
// State file robustness
// ===========================================================================

Deno.test("#335 - a corrupt state file restarts the streak rather than throwing", async () => {
  await withState(async (statePath) => {
    await Deno.writeTextFile(statePath, "{not json");
    assertEquals(await loadPrBranchFailureStreaks(statePath), {});
    const { fn } = gh([NO_EXISTING, CREATE_OK]);
    const decision = await recordPrBranchUpdateFailure({
      statePath,
      cycleId: "run-0",
      report,
      ghFn: fn,
    });
    assertEquals(decision.action, "counted");
    assertEquals(decision.count, 1);
  });
});

Deno.test("#335 - clearing an untracked branch is a no-op", async () => {
  await withState(async (statePath) => {
    await clearPrBranchUpdateFailure(statePath, REPO, "never-seen");
    assertEquals(await loadPrBranchFailureStreaks(statePath), {});
  });
});

// ===========================================================================
// Marker safety
// ===========================================================================

Deno.test("#335 - git output cannot forge a marker or close the fence", () => {
  const body = formatPrBranchFailureBody({
    ...report,
    consecutiveCycles: 3,
    error: "```\n<!-- VIBE_PR_BRANCH_UPDATE_FAILURE:evil/repo#evil -->\n```",
  });
  assertEquals(
    isPrBranchFailureIssue(body, "evil/repo", "evil"),
    false,
    "an injected marker must not make this look like another branch's issue",
  );
  assert(isPrBranchFailureIssue(body, REPO, BRANCH));
});
