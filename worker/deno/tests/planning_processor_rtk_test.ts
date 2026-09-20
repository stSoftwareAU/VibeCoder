/**
 * RTK output filtering wired into the planning run (Issue #2384, part of
 * #2328).
 *
 * Planning is the path where a dropped hook is easiest to miss: one round
 * spawns the agent from five separate sites — the draft, the publish turn, the
 * #1219 retry, the Failure-Detection self-repair (#3272) and the plan-coverage
 * self-repair (#2319) — and each spawn is its own `claude` process with its
 * own argv. A hook wired into four of them leaves the fifth running unfiltered,
 * or worse, filtered with no line to say so. So the round here is driven
 * through all five, and every spawn is held to the same contract, in both
 * directions.
 *
 * Every test calls the real `prepareRtkRun` through a scripted subprocess
 * seam, and the provider id is injected — nothing here reads or writes the
 * process environment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { processIssuePlanning } from "../lib/planning_processor.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import type { GitHubClient } from "../types.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { CODEGRAPH_PROMPT_LINE } from "../lib/codegraph_context.ts";
import type { RtkOutputResult } from "../lib/rtk_output.ts";
import {
  rtkGain,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
  rtkVersion,
} from "./support/rtk_seam.ts";
import {
  assertCarriesRtkHook,
  assertNoRtkHook,
  assertOnlyRtkDiffers,
  assertRtkOutsideCodegraph,
  type SpawnOptions,
} from "./support/rtk_wiring_asserts.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FLEET_LOGIN = "testbot";

/** The five sites one fully-exercised planning round spawns from, in order. */
const SPAWNS = [
  "draft",
  "publish",
  "#1219 retry",
  "Failure-Detection self-repair",
  "plan-coverage self-repair",
] as const;

/** Which of {@link SPAWNS} a prompt belongs to. */
function spawnKind(prompt: string, turn: number): typeof SPAWNS[number] {
  if (prompt.includes("missing a filled")) {
    return "Failure-Detection self-repair";
  }
  if (prompt.includes("did not publish the `## Plan Coverage` table")) {
    return "plan-coverage self-repair";
  }
  if (turn === 0) return "draft";
  return turn === 1 ? "publish" : "#1219 retry";
}

function stubGhClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Break down auth refactor",
        body: "",
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as unknown as GitHubClient;
}

/** A CodeGraph preparer reporting a built index, so both accelerators run. */
const INDEXED_CODEGRAPH =
  (() =>
    Promise.resolve({ status: "ok", enabled: true, nodeCount: 1 })) as never;

interface Observed {
  runOptions: SpawnOptions[];
  kinds: string[];
  rtkOutput?: RtkOutputResult;
}

/**
 * Drive one planning round through every spawn it can make.
 *
 * The draft is prose; the publish turn names no sub-issue, so the #1219 retry
 * runs and creates them; their bodies lack `## Failure Detection`, so the
 * self-repair runs; and the parent carries no `## Plan Coverage` table, so the
 * coverage repair runs.
 */
async function runPlanning(
  enabled: boolean,
  seam: RtkSeam,
  providerId: string = CLAUDE_PROVIDER_ID,
  codegraphToo = false,
): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/rtk-2384-planning-work";
  config.rtkOutput = { enabled };
  config.codegraphContext = { enabled: codegraphToo };
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 100,
    issueTitle: "Break down auth refactor",
    issueBody: "This issue needs to be broken into sub-issues.",
    issueLabels: ["planning"],
    issueComments: "",
    githubUser: FLEET_LOGIN,
    config,
  };
  const observed: Observed = { runOptions: [], kinds: [] };

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: SpawnOptions) => {
        const kind = spawnKind(
          String(options.prompt),
          observed.runOptions.length,
        );
        observed.runOptions.push(options);
        observed.kinds.push(kind);
        const output = {
          "draft": "Draft plan: this needs two sub-issues.",
          "publish": "I have thought about it and created nothing yet.",
          "#1219 retry": "Created https://github.com/org/repo/issues/131 and " +
            "https://github.com/org/repo/issues/132",
          "Failure-Detection self-repair": "No usable draft.",
          "plan-coverage self-repair": "No usable table.",
        }[kind];
        return Promise.resolve({
          ok: true,
          value: { output, exitCode: 0, timedOut: false },
        });
      }) as never,
      prepareRtkRun: seam.prepare,
      rtkProviderId: () => providerId,
      ...(codegraphToo ? { prepareCodegraphContext: INDEXED_CODEGRAPH } : {}),
    },
    github: {
      runGhCommand: ((args: string[]) => {
        if (args[0] === "issue" && args[1] === "view") {
          const jsonArg = args[args.indexOf("--json") + 1] ?? "";
          if (jsonArg.includes("comments")) {
            // A parent with no `## Plan Coverage` table anywhere.
            return Promise.resolve(
              JSON.stringify({ body: "Parent", comments: [] }),
            );
          }
          if (jsonArg.includes("body")) {
            // Sub-issues with no `## Failure Detection` section.
            return Promise.resolve(JSON.stringify({
              number: Number(args[2]),
              title: "Sub-issue",
              body: "## Summary\nDo a thing.\n",
            }));
          }
          return Promise.resolve(JSON.stringify({ state: "OPEN" }));
        }
        if (args.includes("search")) return Promise.resolve("[]");
        return Promise.resolve("");
      }) as never,
    },
  });

  const result = await processIssuePlanning(ctx, {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(),
    logger: deps.logger,
    deps,
  });
  assert(result.ok, "losing or lacking RTK must never fail a planning round");
  observed.rtkOutput = result.value.rtkOutput;
  return observed;
}

/**
 * Fail loud if the fixture stops reaching one of the five sites.
 *
 * A site may spawn more than once — the Failure-Detection repair drafts a
 * batch and then falls back per sub-issue — so it is the distinct sites, in
 * order, that are pinned.
 */
function assertEverySpawnRan(observed: Observed): void {
  assertEquals(
    [...new Set(observed.kinds)],
    [...SPAWNS],
    "the fixture must drive the round through every site it can spawn from",
  );
}

/** A healthy host whose gain store grows by ten tokens per re-read. */
function growingRtkSeam(): RtkSeam {
  return rtkSeam([
    rtkVersion(),
    rtkGain(100),
    ...Array.from({ length: 20 }, (_, read) => rtkGain(110 + read * 10)),
  ]);
}

Deno.test("planning_processor - the RTK switch off leaves every spawn of the round untouched (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runPlanning(false, seam);

  assertEverySpawnRan(observed);
  assertEquals(seam.prepared.length, 1, "prepared once, even when off");
  assertEquals(seam.prepared[0]?.enabled, false);
  assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
  for (const spawn of observed.runOptions) assertNoRtkHook(spawn);
  assertEquals(observed.rtkOutput, { enabled: false, status: "off" });
});

Deno.test("planning_processor - every spawn of the round carries the hook and the line (Issue #2384)", async () => {
  const off = await runPlanning(false, rtkSeam([]));
  const seam = growingRtkSeam();
  const on = await runPlanning(true, seam);

  assertEverySpawnRan(on);
  // Prepared once for the whole round, against the repository checkout.
  assertEquals(seam.prepared.length, 1);
  assertEquals(seam.prepared[0]?.enabled, true);
  assertEquals(seam.prepared[0]?.providerId, CLAUDE_PROVIDER_ID);
  assertEquals(seam.prepared[0]?.cwd, "/tmp/rtk-2384-planning-work/repo");

  // The hook and the line ride together on each spawn, and they are the
  // *only* thing the switch does to it — the off round is today's round.
  for (const [index, spawn] of on.runOptions.entries()) {
    try {
      assertCarriesRtkHook(spawn);
      assertOnlyRtkDiffers(spawn, off.runOptions[index]);
    } catch (err) {
      throw new Error(`the ${on.kinds[index]} spawn: ${err}`, { cause: err });
    }
  }

  // Version and baseline, then one re-read after each spawn — so the figure
  // covers the whole round, measured from the one baseline.
  const spawns = on.runOptions.length;
  assertEquals(seam.calls.length, 2 + spawns, "re-read after every spawn");
  assertEquals(on.rtkOutput, {
    enabled: true,
    status: "ok",
    savedTokens: 10 * spawns,
  });
});

Deno.test("planning_processor - a host without rtk plans unfiltered rather than failing (Issue #2384)", async () => {
  const seam = rtkSeam([rtkMissing()]);
  const observed = await runPlanning(true, seam);

  assertEverySpawnRan(observed);
  for (const spawn of observed.runOptions) assertNoRtkHook(spawn);
  assertEquals(seam.calls.length, 1, "a failed preflight is never re-read");
  assertEquals(observed.rtkOutput, { enabled: true, status: "failed" });
});

Deno.test("planning_processor - a provider that takes no hooks is reported, not filtered (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runPlanning(true, seam, "gemini");

  assertEverySpawnRan(observed);
  assertEquals(seam.calls.length, 0, "an unsupported provider spawns no rtk");
  for (const spawn of observed.runOptions) assertNoRtkHook(spawn);
  assertEquals(observed.rtkOutput, {
    enabled: true,
    status: "unsupported",
    provider: "gemini",
  });
});

Deno.test("planning_processor - RTK's pair rides outside CodeGraph's on every spawn when both are on (Issue #2384)", async () => {
  const observed = await runPlanning(
    true,
    growingRtkSeam(),
    CLAUDE_PROVIDER_ID,
    true,
  );

  assertEverySpawnRan(observed);
  for (const [index, spawn] of observed.runOptions.entries()) {
    try {
      assertRtkOutsideCodegraph(spawn, CODEGRAPH_PROMPT_LINE);
    } catch (err) {
      throw new Error(`the ${observed.kinds[index]} spawn: ${err}`, {
        cause: err,
      });
    }
  }
  assertEquals(observed.rtkOutput?.status, "ok");
});
