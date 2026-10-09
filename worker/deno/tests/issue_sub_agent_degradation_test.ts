/**
 * Tests for the Haiku sub-agent degradation check on issue runs (Issue #3405).
 *
 * A haiku-tier `issue` run that the API served a previous-generation Haiku
 * (and no current one) is labelled `degraded-model` and names both models in
 * the run-stats comment. The label cache directory is a temp directory so the
 * label operations are hermetic.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assessIssueSubAgentDegradation,
  buildIssueSubAgentDegradationLine,
  reportIssueSubAgentDegradation,
} from "../lib/issue_sub_agent_degradation.ts";
import { buildIssueRunStatsComment } from "../lib/issue_run_stats_comment.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";
import type { Logger } from "../types.ts";

const REPO = "org/repo";
const ISSUE = 3405;

function claudeRun(served: string[]): PhaseClaudeResult {
  return {
    runStats: {
      servedModels: served,
      requestedModel: "opus",
      wallClockMs: 5_000,
      numTurns: 12,
      tokenUsage: {
        inputTokens: 4_000,
        outputTokens: 8_000,
        cacheCreationTokens: 500,
        cacheReadTokens: 250,
      },
    },
  };
}

interface Harness {
  calls: string[][];
  addLabelCalls: Array<{ issue: number; label: string }>;
  warnings: Array<{ message: string; context?: Record<string, unknown> }>;
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  cacheDir: string;
}

async function withHarness(
  run: (h: Harness) => Promise<void>,
  opts: { failAddLabel?: boolean } = {},
): Promise<void> {
  const cacheDir = await Deno.makeTempDir({ prefix: "sub_agent_degr_" });
  const calls: string[][] = [];
  const addLabelCalls: Array<{ issue: number; label: string }> = [];
  const warnings: Harness["warnings"] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    const labelArg = args.find((a) => a.startsWith("labels[]="));
    const apiIdx = args.findIndex((a) => /\/issues\/\d+\/labels$/.test(a));
    if (labelArg && apiIdx >= 0) {
      if (opts.failAddLabel) return Promise.reject(new Error("boom"));
      addLabelCalls.push({
        issue: parseInt(args[apiIdx]!.match(/\/issues\/(\d+)\//)![1]!, 10),
        label: labelArg.replace("labels[]=", ""),
      });
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      if (opts.failAddLabel) return Promise.reject(new Error("boom"));
      const li = args.indexOf("--add-label");
      addLabelCalls.push({
        issue: parseInt(args[2]!, 10),
        label: li >= 0 ? args[li + 1]! : "",
      });
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  const noop = () => {};
  const logger = {
    info: noop,
    debug: noop,
    error: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
    warn: (message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
  } as unknown as Logger;
  try {
    await run({
      calls,
      addLabelCalls,
      warnings,
      ghCommandFn,
      logger,
      cacheDir,
    });
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
}

Deno.test("haiku tier served haiku-4-5 - degraded, labelled, both models named", async () => {
  await withHarness(async (h) => {
    const claudeResults = [claudeRun(["claude-opus-5-5", "claude-haiku-4-5"])];
    const expected = {
      requested: "claude-haiku-5-5",
      served: ["claude-haiku-4-5"],
    };
    assertEquals(
      assessIssueSubAgentDegradation({ tier: "haiku", claudeResults }),
      expected,
    );

    const result = await reportIssueSubAgentDegradation({
      repo: REPO,
      issueNumber: ISSUE,
      tier: "haiku",
      claudeResults,
      ghCommandFn: h.ghCommandFn,
      logger: h.logger,
      cacheDir: h.cacheDir,
    });
    assertEquals(result, expected);
    assertEquals(h.addLabelCalls, [{ issue: ISSUE, label: "degraded-model" }]);

    const body = buildIssueRunStatsComment({
      phase: "issue",
      claudeResults,
      runId: "r1",
      subAgentDegradation: result,
    });
    const line = body.split("\n").find((l) =>
      l.includes("Haiku sub-agents degraded")
    );
    assert(line, "expected the Haiku line");
    assertStringIncludes(line, "claude-haiku-5-5");
    assertStringIncludes(line, "claude-haiku-4-5");
  });
});

Deno.test("haiku tier served current haiku - healthy, no gh call", async () => {
  await withHarness(async (h) => {
    const result = await reportIssueSubAgentDegradation({
      repo: REPO,
      issueNumber: ISSUE,
      tier: "haiku",
      claudeResults: [claudeRun(["claude-opus-5-5", "claude-haiku-5-5"])],
      ghCommandFn: h.ghCommandFn,
      logger: h.logger,
      cacheDir: h.cacheDir,
    });
    assertEquals(result, undefined);
    assertEquals(h.calls.length, 0);
  });
});

Deno.test("haiku tier served both stale and current haiku - one current keeps it healthy", () => {
  assertEquals(
    assessIssueSubAgentDegradation({
      tier: "haiku",
      claudeResults: [claudeRun(["claude-haiku-4-5", "claude-haiku-5-5"])],
    }),
    undefined,
  );
});

Deno.test("haiku tier dated id - degraded and names the dated id", () => {
  const result = assessIssueSubAgentDegradation({
    tier: "haiku",
    claudeResults: [claudeRun(["claude-haiku-4-5-20251001"])],
  });
  assertEquals(result?.served, ["claude-haiku-4-5-20251001"]);
  assertEquals(result?.requested, "claude-haiku-5-5");
});

Deno.test("sonnet tier served haiku-4-5 - never triggers, no gh call", async () => {
  await withHarness(async (h) => {
    const result = await reportIssueSubAgentDegradation({
      repo: REPO,
      issueNumber: ISSUE,
      tier: "sonnet",
      claudeResults: [claudeRun(["claude-haiku-4-5"])],
      ghCommandFn: h.ghCommandFn,
      logger: h.logger,
      cacheDir: h.cacheDir,
    });
    assertEquals(result, undefined);
    assertEquals(h.calls.length, 0);
  });
});

Deno.test("label-apply failure - does not throw, still returns the assessment, warns with the issue number", async () => {
  await withHarness(async (h) => {
    const result = await reportIssueSubAgentDegradation({
      repo: REPO,
      issueNumber: ISSUE,
      tier: "haiku",
      claudeResults: [claudeRun(["claude-haiku-4-5"])],
      ghCommandFn: h.ghCommandFn,
      logger: h.logger,
      cacheDir: h.cacheDir,
    });
    assertEquals(result?.served, ["claude-haiku-4-5"]);
    assert(
      h.warnings.some((w) => w.context?.issueNumber === ISSUE),
      "expected a warning carrying the issue number",
    );
  }, { failAddLabel: true });
});

Deno.test("line sanitiser - a backtick in a served id never reaches the line", () => {
  const line = buildIssueSubAgentDegradationLine({
    requested: "claude-haiku-5-5",
    served: ["claude-haiku-4-5`x", "claude-haiku-4-4"],
  });
  assertEquals(
    line,
    "- **Haiku sub-agents degraded:** requested `claude-haiku-5-5` " +
      "(`issue_sub_agent_tier: haiku`), served `claude-haiku-4-5x`, " +
      "`claude-haiku-4-4`",
  );
});

Deno.test("no degradation - no line and no comment text", () => {
  assertEquals(buildIssueSubAgentDegradationLine(undefined), "");
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeRun(["claude-opus-5-5"])],
    runId: "r1",
  });
  assert(body.length > 0);
  assert(!body.includes("Haiku sub-agents degraded"));
});
