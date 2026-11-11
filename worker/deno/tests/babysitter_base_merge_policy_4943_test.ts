/**
 * The babysitter's base-merge policy for repairs (Issue #4943): a repair
 * merges the PR's base for a genuine conflict (GitHub reports `CONFLICTING`),
 * or when a matching failure on the PR merge base is proven fixed on a newer
 * base commit. A behind-only PR is refreshed by the shared base-refresh owner
 * (Issue #4613), so a failed-CI or review repair must not merge it here.
 *
 * The in-memory GitHub, git and agent boundaries come from
 * tests/support/babysitter_harness.ts, shared with
 * babysitter_fix_orchestration_test.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { APP, basePr, BOT, harness } from "./support/babysitter_harness.ts";
import { BASE_REFRESH_COUNTERS_FILE } from "../lib/repair_base_merge_4943.ts";
import {
  BRANCH_REFRESH_REFUSAL_FILE,
  branchRefreshRefusalKey,
  readBranchRefreshRefusals,
} from "../lib/branch_refresh_refusal_streak.ts";
import {
  BABYSITTER_RESPONSE_FILE,
  fix,
  run,
} from "../commands/fleet_pr_babysitter.ts";
import { cloneGitFixture, seedGitRemote } from "./support/git_fixture.ts";
import { git as gitResult, gitOk } from "./support/git_repo_fixture.ts";
import { baseFixGh, type BaseRunState } from "./support/repair_base_checks.ts";
/**
 * Silence the babysitter's console output, and hand back every stderr line
 * (console.warn) it wrote while the action ran, so the base-refresh diagnostics
 * can be asserted.
 */
async function withConsole<T>(
  action: (stateDir: string, lines: string[]) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir();
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  console.error = () => {};
  try {
    return await action(`${root}/state`, lines);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
}

/** The exact decision line: source, outcome, repo, PR and base all named. */
const SKIPPED_LINE =
  /^\[base-refresh\] source=babysitter-repair outcome=base-merge-skipped repo=owner\/repo pr=#1 base=main owner=none reason="GitHub reports mergeable MERGEABLE, not CONFLICTING/;

const baseRefreshLines = (lines: string[]) =>
  lines.filter((line) => line.includes("[base-refresh]"));

/** Drive fix() through real Git publication, faking GitHub and the agent service. */
async function publishedRepair(
  stateDir: string,
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
  review = false,
  baseState?: BaseRunState,
): Promise<{ hasBase: boolean; contents: string; parents: string[] }> {
  const root = await Deno.makeTempDir();
  try {
    const remote = await seedGitRemote(root, "main", [
      { branch: "main", subject: "seed", files: { "shared.txt": "seed\n" } },
      {
        branch: "feature",
        parent: 1,
        subject: "feature",
        files: { "shared.txt": "feature\n", "feature.txt": "feature\n" },
      },
      {
        branch: "main",
        parent: 1,
        subject: "base advance",
        files: { "shared.txt": "base\n", "base-only.txt": "base advance\n" },
      },
    ]);
    const head = (await gitOk(["rev-parse", "feature"], remote)).trim();
    const base = (await gitOk(["rev-parse", "main"], remote)).trim();
    const h = harness(stateDir);
    h.state.pr = basePr({
      mergeable,
      headRefOid: head,
      ...(review
        ? {
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
        }
        : {}),
    });
    const checkGh = baseState === undefined
      ? undefined
      : baseFixGh(mergeable, baseState, {
        headSha: head,
        baseSha: base,
        mergeBaseSha: (await gitOk(["merge-base", "feature", "main"], remote))
          .trim(),
      });
    const gh = async (args: string[]) => {
      let text: string;
      try {
        text = await h.gh(args);
      } catch (error) {
        if (checkGh === undefined) throw error;
        return checkGh(args);
      }
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          ...JSON.parse(text),
          headRefOid: (await gitOk(["rev-parse", "feature"], remote)).trim(),
        });
      }
      return text;
    };
    const originalRun = h.deps.run!;
    h.deps.run = (command, args, cwd) =>
      command === "git"
        // Connect the Git transport to the local remote after config reset.
        ? run(
          command,
          args[0] === "push"
            ? args.map((arg) => arg === "origin" ? remote : arg)
            : args,
          cwd,
        )
        : originalRun(command, args, cwd);
    h.deps.clone = async (_repo, dir) => {
      await cloneGitFixture(remote, dir);
    };
    delete h.deps.mergeBase;
    delete h.deps.commit;
    delete h.deps.assertTreeSafe;
    delete h.deps.resetGitConfig;
    h.deps.startAgent = async (_app, _repo, options, beforeSpawn) => {
      if (!await beforeSpawn()) return false;
      await Deno.writeTextFile(
        `${options.dir}/repair.txt`,
        "substantive repair\n",
      );
      // Resolve the real conflict; the host retains HEAD until its validated commit.
      if (mergeable === "CONFLICTING") {
        await Deno.writeTextFile(
          `${options.dir}/shared.txt`,
          "resolved feature and base\n",
        );
        await gitOk(["add", "shared.txt"], options.dir);
      }
      await Deno.writeTextFile(
        `${options.exchange}/${BABYSITTER_RESPONSE_FILE}`,
        "done\nBABYSITTER_READY\n",
      );
      return true;
    };
    await fix(
      "owner/repo",
      h.state.pr as never,
      [BOT],
      BOT,
      APP,
      "/unused",
      gh,
      () => Promise.resolve(),
      3,
      h.deps,
    );
    const published = (await gitOk(["rev-parse", "feature"], remote)).trim();
    assert(published !== head, "a substantive repair must be published");
    const tree = await gitOk(["ls-tree", "--name-only", published], remote);
    assert(tree.includes("repair.txt"), tree);
    const hasBase = (await gitResult(
      ["merge-base", "--is-ancestor", base, published],
      remote,
    )).code === 0;
    assertEquals(tree.includes("base-only.txt"), hasBase);
    return {
      hasBase,
      contents: await gitOk(["show", `${published}:shared.txt`], remote),
      parents: (await gitOk(["show", "-s", "--format=%P", published], remote))
        .trim().split(" "),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("babysitter publishes substantive failed-CI repair without a merely-behind base", async () => {
  await withConsole(async (stateDir) => {
    const published = await publishedRepair(stateDir, "MERGEABLE");
    assertEquals(published.hasBase, false);
    assertEquals(published.contents, "feature\n");
    assertEquals(published.parents.length, 1);
  });
});

Deno.test("babysitter publishes review repair without a merely-behind base", async () => {
  await withConsole(async (stateDir) => {
    const published = await publishedRepair(stateDir, "MERGEABLE", true);
    assertEquals(published.hasBase, false);
    assertEquals(published.contents, "feature\n");
  });
});

Deno.test("babysitter publishes a resolved genuine conflict with both parents", async () => {
  await withConsole(async (stateDir) => {
    const published = await publishedRepair(stateDir, "CONFLICTING");
    assertEquals(published.hasBase, true);
    assertEquals(published.contents, "resolved feature and base\n");
    assertEquals(published.parents.length, 2);
  });
});

/**
 * Forget the babysitter's per-PR retry back-off between two passes, keeping the
 * #4831 refusal streak and the decision counters under test.
 */
const forgetRetryBackoff = async (stateDir: string) => {
  const keep = new Set([
    BRANCH_REFRESH_REFUSAL_FILE,
    BASE_REFRESH_COUNTERS_FILE,
  ]);
  for await (const entry of Deno.readDir(stateDir)) {
    if (!keep.has(entry.name)) {
      await Deno.remove(`${stateDir}/${entry.name}`, { recursive: true });
    }
  }
};

const readStreak = async (stateDir: string): Promise<number | undefined> => {
  const state = await readBranchRefreshRefusals(stateDir);
  return state.get(branchRefreshRefusalKey("owner/repo", 1))?.streak;
};

const readCounters = async (
  stateDir: string,
): Promise<Record<string, number>> =>
  JSON.parse(
    await Deno.readTextFile(`${stateDir}/${BASE_REFRESH_COUNTERS_FILE}`),
  ).counters;

Deno.test("an UNKNOWN mergeability read skips the base merge and counts a #4831 refusal streak that a known read clears (Issue #4943)", async () => {
  await withConsole(async (stateDir, lines) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "UNKNOWN" });
    h.state.mergeBaseResult = { kind: "merged", tree: "c".repeat(40) };
    await h.attempt();
    assertEquals(await readStreak(stateDir), 1);
    await forgetRetryBackoff(stateDir);
    await h.attempt();
    assertEquals(await readStreak(stateDir), 2);
    assert(
      lines.some((line) =>
        line.includes("[base-refresh] fleet health: repair mergeability") &&
        line.includes("owner/repo#1 still UNKNOWN after 2 consecutive reads")
      ),
      lines.join("\n"),
    );
    // The skipped decisions are tallied durably in the babysitter state dir.
    assertEquals(
      (await readCounters(stateDir))[
        "baseRefresh.base-merge-skipped.babysitter-repair"
      ],
      2,
    );

    h.state.pr = basePr({ mergeable: "MERGEABLE" });
    await forgetRetryBackoff(stateDir);
    await h.attempt();
    assertEquals(await readStreak(stateDir), undefined);
    const published = await publishedRepair(
      `${stateDir}/unknown-publication`,
      "UNKNOWN",
    );
    assertEquals(published.hasBase, false);
    assertEquals(published.contents, "feature\n");
  });
});

Deno.test("a conflicting repair is tallied as base-merge-allowed in the babysitter state dir (Issue #4943)", async () => {
  await withConsole(async (stateDir) => {
    const h = harness(stateDir);
    h.state.pr = basePr({ mergeable: "CONFLICTING" });
    h.state.mergeBaseResult = { kind: "conflicted" };
    await h.attempt();
    assertEquals(await readCounters(stateDir), {
      "baseRefresh.base-merge-allowed.babysitter-repair": 1,
    });
  });
});

for (
  const baseState of [
    "green",
    "no-run",
    "unavailable",
    "probe-throws",
    "different-historical-failure",
    "dependency-audit",
  ] as const
) {
  Deno.test(`babysitter publishes a substantive repair without base ancestry when base-fix evidence is ${baseState}`, async () => {
    await withConsole(async (stateDir, lines) => {
      const published = await publishedRepair(
        stateDir,
        "MERGEABLE",
        false,
        baseState,
      );
      assertEquals(published.hasBase, false);
      assertEquals(published.contents, "feature\n");
      assertEquals(published.parents.length, 1);
      const skipped = baseRefreshLines(lines).filter((line) =>
        line.includes("source=babysitter-repair")
      );
      assertEquals(skipped.length, 1, lines.join("\n"));
      assertMatch(skipped[0]!, SKIPPED_LINE);
      if (baseState === "green") {
        assertStringIncludes(skipped[0]!, "base fix not proven");
      }
    });
  });
}
