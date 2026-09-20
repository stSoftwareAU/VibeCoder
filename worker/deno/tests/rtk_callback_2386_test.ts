/**
 * The RTK outcome reaches the post-run callback context (Issue #2386, part of
 * #2328).
 *
 * The block is **additive and unconditional**: every run carries
 * `rtk.enabled` and `rtk.status`, and `rtk.savedTokens` only when RTK's gain
 * store was read a second time. A run that reported no RTK preparation
 * publishes `{ enabled: false, status: "off" }` rather than nothing.
 *
 * The path is exercised rather than asserted a field at a time: `workOnIssue`
 * lifts the outcome off the phase state, and the context builder and the
 * document/environment builders publish it. The scan loop's own half of the
 * thread — `withProcessCallbackFacts` onto the terminal run — is covered in
 * `run_core_callbacks_test.ts`, beside the loop harness it needs. The pinned
 * field set lives in `callback_schema_compat_test.ts`.
 *
 * Every test drives the real `prepareRtkRun` through the scripted subprocess
 * seam, so no `rtk` binary is spawned and nothing sleeps.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssue } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  buildCallbackContextDocument,
  buildCallbackEnv,
  rtkNotRun,
  type TerminalIssueRun,
} from "../lib/run_callbacks.ts";
import { buildIssueRunCallbackContext } from "../lib/run_callback_context.ts";
import type { WorkOnIssueResult } from "../lib/issue_worker_types.ts";
import {
  healthyRtkSeam,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
} from "./support/rtk_seam.ts";

const IDENTITY = { runId: "vibe-2386", host: "GRQ-23" };

/** The terminal run the scan loop would report for one issue-worker result. */
function terminalRun(result: WorkOnIssueResult): TerminalIssueRun {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2386,
    result: "success",
    startedAtEpochMs: Date.parse("2026-09-20T01:00:00.000Z"),
    finishedAtEpochMs: Date.parse("2026-09-20T01:30:00.000Z"),
    ...(result.rtk ? { rtk: result.rtk } : {}),
  };
}

/** Run one issue on a host whose `rtk_output.enabled` is `enabled`. */
function runIssue(enabled: boolean, seam: RtkSeam): Promise<WorkOnIssueResult> {
  const config = buildDefaultWorkerConfig();
  config.rtkOutput = { enabled };
  const deps = createMockDeps({
    claude: { prepareRtkRun: seam.prepare as never },
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/1"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });
  return workOnIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2386,
    issueTitle: "Carry an rtk block on the callback context",
    issueBody: "Fix the bug in `src/auth/login.ts:45`",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  }, deps);
}

/** What a hook is handed for one issue-worker result. */
function published(result: WorkOnIssueResult): {
  block: unknown;
  env: Record<string, string>;
} {
  const context = buildIssueRunCallbackContext(terminalRun(result), IDENTITY);
  return {
    block: buildCallbackContextDocument(context, "always").rtk,
    env: buildCallbackEnv(
      context,
      "always",
      "/tmp/context.json",
      () => undefined,
    ),
  };
}

Deno.test({
  name:
    "#2386 - an issue run's RTK outcome and saved-token figure reach the hook",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await runIssue(true, healthyRtkSeam(100, 140));

    assertEquals(result.rtk, { enabled: true, status: "ok", savedTokens: 40 });
    const { block, env } = published(result);
    assertEquals(block, { enabled: true, status: "ok", savedTokens: 40 });
    assertEquals(env.VIBECODER_RTK_ENABLED, "true");
    assertEquals(env.VIBECODER_RTK_STATUS, "ok");
    assertEquals(env.VIBECODER_RTK_SAVED_TOKENS, "40");
  },
});

Deno.test({
  name:
    "#2386 - a switched-on host without rtk reports failed and no figure at all",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const result = await runIssue(true, rtkSeam([rtkMissing()]));

    assertEquals(result.rtk?.status, "failed");
    const { block, env } = published(result);
    assertEquals(block, { enabled: true, status: "failed" });
    assertEquals(env.VIBECODER_RTK_ENABLED, "true");
    assertEquals(env.VIBECODER_RTK_STATUS, "failed");
    assert(
      !("VIBECODER_RTK_SAVED_TOKENS" in env),
      "a failed preparation exported a figure it never read",
    );
  },
});

Deno.test({
  name: "#2386 - a switched-off host reports the explicit off block",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const seam = rtkSeam([]);
    const result = await runIssue(false, seam);

    assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
    const { block, env } = published(result);
    assertEquals(block, { enabled: false, status: "off" });
    assertEquals(env.VIBECODER_RTK_ENABLED, "false");
    assertEquals(env.VIBECODER_RTK_STATUS, "off");
    assert(!("VIBECODER_RTK_SAVED_TOKENS" in env));
  },
});

// The fabricated-`false` trap, which the Graft block already documents and
// avoids (#2104): the trial separates enabled runs from control runs by this
// block alone. A run on a switched-ON host that ends before RTK is prepared —
// a refused claim, an early exit — must not be archived as `enabled: false`,
// or every such run is counted as a control run and the comparison is wrong.
for (const enabled of [true, false]) {
  Deno.test({
    name:
      `#2386 - a run that ended before RTK was prepared states the host's real switch (enabled=${enabled})`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const config = buildDefaultWorkerConfig();
      config.rtkOutput = { enabled };
      const deps = createMockDeps({
        issues: {
          claimIssue: () =>
            Promise.resolve({
              ok: true,
              value: { claimed: false, reason: "already_assigned" as const },
            }),
        },
      });

      const result = await workOnIssue({
        repo: "stSoftwareAU/VibeCoder",
        issueNumber: 2386,
        issueTitle: "Carry an rtk block on the callback context",
        issueBody: "The claim was refused, so RTK was never prepared.",
        issueLabels: [],
        issueComments: "",
        githubUser: "testbot",
        config,
      }, deps);

      assertEquals(result.rtk, { status: "off", enabled });
      const { block, env } = published(result);
      assertEquals(block, { enabled, status: "off" });
      assertEquals(env.VIBECODER_RTK_ENABLED, String(enabled));
      assertEquals(env.VIBECODER_RTK_STATUS, "off");
      assertEquals("VIBECODER_RTK_SAVED_TOKENS" in env, false);
    },
  });
}

// A run that reaches the callbacks carrying no RTK outcome at all — a thrown
// run, a shutdown drain — used to fall back to `{ enabled: false }` whatever
// the host's switch. CodeGraph's block already has a truthful fallback at the
// same site (`codegraphNotRun`, #2162); this is RTK's.
Deno.test("#2386 - a run that recorded no RTK outcome still states the host's real switch", () => {
  assertEquals(rtkNotRun(true), { enabled: true, status: "off" });
  assertEquals(rtkNotRun(false), { enabled: false, status: "off" });
  // The fallback is only ever a fallback: it carries no figure.
  assertEquals("savedTokens" in rtkNotRun(true), false);
});
