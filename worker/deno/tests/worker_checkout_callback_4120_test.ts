/**
 * The post-run callback and the run-stats comment name the checkout the
 * worker is running (Issue #4120).
 *
 * Version and commit were already on the context (Issue #2444). This adds
 * the update mode, and the pin when the checkout is frozen. The fields are
 * additive: schemaVersion stays at 2. A fixture checkout is the source, so
 * the test does not depend on this repository's tag or config.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildCallbackContextDocument,
  buildCallbackEnv,
  CALLBACK_SCHEMA_VERSION,
  type TerminalIssueRun,
} from "../lib/run_callbacks.ts";
import { buildIssueRunCallbackContext } from "../lib/run_callback_context.ts";
import { readCheckoutWorkerFacts } from "../lib/run_callback_context.ts";
import {
  buildIssueRunStatsComment,
  formatWorkerStatsLine,
} from "../lib/issue_run_stats_comment.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";

const RUN: TerminalIssueRun = {
  repo: "stSoftwareAU/VibeCoder",
  issueNumber: 4120,
  result: "success",
  startedAtEpochMs: Date.UTC(2026, 9, 24, 1, 0, 0),
  finishedAtEpochMs: Date.UTC(2026, 9, 24, 1, 5, 0),
};

const IDENTITY = { runId: "vibe-4120", host: "GRQ-23" };

async function git(dir: string, args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const out = await cmd.output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `git ${args.join(" ")} failed: ${stderr}`);
  return new TextDecoder().decode(out.stdout).trim();
}

async function fixtureCheckout(): Promise<{ dir: string; sha: string }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-4120-" });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["commit", "--allow-empty", "-q", "-m", "fixture"]);
  await git(dir, ["tag", "1.10.124"]);
  const sha = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, sha };
}

function result(): PhaseClaudeResult {
  return {
    runStats: {
      servedModels: ["claude-sonnet-5"],
      requestedModel: "sonnet",
      wallClockMs: 1_000,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    },
  };
}

Deno.test("#4120 - a dynamic fixture checkout publishes version, commit and mode", async () => {
  const { dir, sha } = await fixtureCheckout();
  try {
    const facts = readCheckoutWorkerFacts(dir);
    assertEquals(facts.version, "1.10.124");
    assertEquals(facts.commit, sha);
    assertEquals(facts.updateMode, "dynamic");
    assertEquals(facts.pinnedRef, undefined);

    const built = buildIssueRunCallbackContext(RUN, IDENTITY, {
      transcriptEnabled: () => false,
      checkoutDir: dir,
      buildFacts: () => ({}),
    });
    assertEquals(built.workerVersion, "1.10.124");
    assertEquals(built.workerCommit, sha);
    assertEquals(built.updateMode, "dynamic");
    assert(!("pinnedRef" in built));

    const document = buildCallbackContextDocument(built, "success");
    assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
    assertEquals(document.workerVersion, "1.10.124");
    assertEquals(document.workerCommit, sha);
    assertEquals(document.updateMode, "dynamic");
    assert(!("pinnedRef" in document));

    const env = buildCallbackEnv(built, "success", "/tmp/context.json", () =>
      undefined);
    assertEquals(env.VIBECODER_WORKER_VERSION, "1.10.124");
    assertEquals(env.VIBECODER_WORKER_COMMIT, sha);
    assertEquals(env.VIBECODER_UPDATE_MODE, "dynamic");
    assertEquals(env.VIBECODER_PINNED_REF, undefined);

    const line = formatWorkerStatsLine({
      version: "1.10.124",
      commit: sha,
      updateMode: "dynamic",
    });
    assertEquals(line, `- **Worker:** 1.10.124 (${sha.slice(0, 7)}), dynamic`);
    const body = buildIssueRunStatsComment({
      phase: "issue",
      claudeResults: [result()],
      runId: "vibe-4120",
      worker: {
        version: "1.10.124",
        commit: sha,
        updateMode: "dynamic",
      },
    });
    assert(body.includes(line));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4120 - a frozen fixture names the pin", async () => {
  const { dir, sha } = await fixtureCheckout();
  try {
    await Deno.writeTextFile(
      `${dir}/.config.json`,
      JSON.stringify({ update_mode: "frozen", pinned_ref: "v1.10.108" }),
    );
    const built = buildIssueRunCallbackContext(RUN, IDENTITY, {
      transcriptEnabled: () => false,
      checkoutDir: dir,
      buildFacts: () => ({}),
    });
    assertEquals(built.updateMode, "frozen");
    assertEquals(built.pinnedRef, "v1.10.108");
    const line = formatWorkerStatsLine({
      version: built.workerVersion!,
      commit: sha,
      updateMode: "frozen",
      pinnedRef: "v1.10.108",
    });
    assertEquals(
      line,
      `- **Worker:** 1.10.124 (${sha.slice(0, 7)}), frozen at v1.10.108`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4120 - a frozen checkout with no pin fails loud", async () => {
  const { dir } = await fixtureCheckout();
  try {
    await Deno.writeTextFile(
      `${dir}/.config.json`,
      JSON.stringify({ update_mode: "frozen" }),
    );
    assertThrows(() => readCheckoutWorkerFacts(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#4120 - omitting the worker argument leaves the stats comment unchanged", () => {
  const without = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [result()],
    runId: "vibe-4120",
  });
  assertEquals(without.includes("**Worker:**"), false);
});
