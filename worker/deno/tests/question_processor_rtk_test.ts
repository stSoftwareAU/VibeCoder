/**
 * RTK output filtering wired into the question run (Issue #2384, part of
 * #2328).
 *
 * The issue path got the hook in #2383; this file holds the question path to
 * the same contract, in both directions:
 *
 *   - **A switched-off host must spawn what it always spawned.** No
 *     `settingsJson` key at all, an unchanged prompt, and no `rtk` process.
 *   - **The hook and the prompt line are indivisible.** On, the spawn carries
 *     RTK's `Bash` entry and the prompt ends with the one recall line.
 *   - **Losing RTK must never fail a run.** A host without the binary, or a
 *     provider that takes no hooks, answers the question unfiltered and says
 *     so in the result.
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
import { processIssueQuestion } from "../lib/question_processor.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import type { GitHubClient } from "../types.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { CODEGRAPH_PROMPT_LINE } from "../lib/codegraph_context.ts";
import type { RtkOutputResult } from "../lib/rtk_output.ts";
import {
  healthyRtkSeam,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
} from "./support/rtk_seam.ts";
import {
  assertCarriesRtkHook,
  assertNoRtkHook,
  assertOnlyRtkDiffers,
  assertRtkOutsideCodegraph,
  type SpawnOptions,
} from "./support/rtk_wiring_asserts.ts";

/** A gh client that answers everything the answer path needs. */
function stubGhClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 2384,
        title: "How does the retry logic work?",
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
  rtkOutput?: RtkOutputResult;
}

async function runQuestion(
  enabled: boolean,
  seam: RtkSeam,
  providerId: string = CLAUDE_PROVIDER_ID,
  codegraphToo = false,
): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.workDir = "/tmp/rtk-2384-question-work";
  config.rtkOutput = { enabled };
  config.codegraphContext = { enabled: codegraphToo };
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2384,
    issueTitle: "How does the retry logic work?",
    issueBody: "Explain it.",
    issueLabels: ["question"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const observed: Observed = { runOptions: [] };
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: SpawnOptions) => {
        observed.runOptions.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            output: "The retry logic uses exponential backoff.",
            exitCode: 0,
            timedOut: false,
          },
        });
      }) as never,
      prepareRtkRun: seam.prepare,
      rtkProviderId: () => providerId,
      ...(codegraphToo ? { prepareCodegraphContext: INDEXED_CODEGRAPH } : {}),
    },
  });

  const result = await processIssueQuestion(ctx, {
    ghClient: stubGhClient(),
    logger: deps.logger,
    deps,
  });
  assert(result.ok, "losing or lacking RTK must never fail a question run");
  observed.rtkOutput = result.value.rtkOutput;
  return observed;
}

Deno.test("question_processor - the RTK switch off spawns no rtk, no settings and an unchanged prompt (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runQuestion(false, seam);

  assertEquals(seam.prepared.length, 1, "the run reports a status even off");
  assertEquals(seam.prepared[0]?.enabled, false);
  assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
  assertEquals(observed.runOptions.length, 1);
  assertNoRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, { enabled: false, status: "off" });
});

Deno.test("question_processor - the RTK switch on installs the hook and the prompt line together (Issue #2384)", async () => {
  const off = await runQuestion(false, rtkSeam([]));
  const seam = healthyRtkSeam(100, 140);
  const on = await runQuestion(true, seam);

  // The preparation saw the host switch, the run's provider and its checkout.
  assertEquals(seam.prepared[0]?.enabled, true);
  assertEquals(seam.prepared[0]?.providerId, CLAUDE_PROVIDER_ID);
  assertEquals(seam.prepared[0]?.cwd, "/tmp/rtk-2384-question-work/repo");

  // The hook and the line ride together, and they are the *only* thing the
  // switch does to the invocation — the off run is today's run.
  assertCarriesRtkHook(on.runOptions[0]);
  assertOnlyRtkDiffers(on.runOptions[0], off.runOptions[0]);

  // The figure is read again once the invocation is over.
  assertEquals(seam.calls.length, 3, "version, baseline, then the second read");
  assertEquals(on.rtkOutput, { enabled: true, status: "ok", savedTokens: 40 });
});

Deno.test("question_processor - a host without rtk answers unfiltered rather than failing (Issue #2384)", async () => {
  const seam = rtkSeam([rtkMissing()]);
  const observed = await runQuestion(true, seam);

  assertEquals(observed.runOptions.length, 1, "the run still proceeds");
  assertNoRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, { enabled: true, status: "failed" });
});

Deno.test("question_processor - a provider that takes no hooks is reported, not filtered (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runQuestion(true, seam, "gemini");

  assertEquals(seam.calls.length, 0, "an unsupported provider spawns no rtk");
  assertEquals(observed.runOptions.length, 1, "the run still proceeds");
  assertNoRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, {
    enabled: true,
    status: "unsupported",
    provider: "gemini",
  });
});

Deno.test("question_processor - RTK's pair rides outside CodeGraph's when both are on (Issue #2384)", async () => {
  const seam = healthyRtkSeam(100, 140);
  const observed = await runQuestion(true, seam, CLAUDE_PROVIDER_ID, true);

  assertRtkOutsideCodegraph(observed.runOptions[0], CODEGRAPH_PROMPT_LINE);
  assertEquals(observed.rtkOutput?.status, "ok");
});
