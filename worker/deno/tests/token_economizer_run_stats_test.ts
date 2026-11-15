/**
 * Tests for token_economizer_run_stats.ts (Issue #4958, part of #4953): the
 * plugin's actions and own cost in the run-stats comment and the run callback.
 *
 * Uses Australian English throughout (behaviour, recognised, organisation).
 */

import { assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  buildTokenEconomizerStatsLine,
  summariseTokenEconomizerRun,
  tokenEconomizerCallbackBlock,
  tokenEconomizerNotRun,
  type TokenEconomizerRunStats,
} from "../lib/token_economizer_run_stats.ts";
import { recordTokenEconomizerStop } from "../lib/token_economizer_plugin.ts";
import { buildIssueRunStatsComment } from "../lib/issue_run_stats_comment.ts";
import {
  buildCallbackContextDocument,
  type IssueRunCallbackContext,
} from "../lib/run_callbacks.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";

/** Run `fn` with a fresh temp directory that is always removed. */
async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "te-run-stats-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Build `<home>/repos/k/claude/` with the fixture sessions and ledger. */
async function fixtureHome(home: string, ledger?: string): Promise<void> {
  const base = join(home, "repos", "k", "claude");
  await Deno.mkdir(join(base, "sessions"), { recursive: true });
  await Deno.writeTextFile(
    join(base, "sessions", "a.json"),
    JSON.stringify({ injected_ids: ["x", "y", "z"], nudges: 1, aborts: 0 }),
  );
  await Deno.writeTextFile(
    join(base, "sessions", "b.json"),
    JSON.stringify({ nudges: 0, aborts: 1 }),
  );
  await Deno.writeTextFile(
    join(base, "ledger.jsonl"),
    ledger ?? jsonl([
      {
        kind: "session",
        overhead: { spiral_judge_tokens: 0, optimizer_tokens: 100 },
      },
      { kind: "overhead", overhead: { spiral_judge_tokens: 400 } },
      {
        kind: "overhead",
        overhead: { spiral_judge_tokens: 600, spiral_nudge_writer_tokens: 50 },
      },
      {
        kind: "session",
        imported: true,
        overhead: { optimizer_tokens: 9999 },
      },
    ]),
  );
}

Deno.test("summarise - reads session and ledger figures, excluding imported records", async () => {
  await withTemp(async (dir) => {
    const home = join(dir, "home");
    await fixtureHome(home);
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: join(dir, "work"),
      stateHomes: [home],
    });
    assertEquals(stats, {
      enabled: true,
      status: "on",
      persistence: "unavailable",
      factsInjected: 3,
      redirects: 1,
      stillStuckNotices: 1,
      judgeCalls: 2,
      pluginEffectiveTokens: 1150,
      pluginCostUsd: 0.00115, // 1150 effective tokens at haiku's 1 USD per million input
    });
  });
});

Deno.test("summarise - sums the figures of every populated home (Issue #4958)", async () => {
  await withTemp(async (dir) => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    await fixtureHome(first);
    await fixtureHome(
      second,
      jsonl([{ kind: "overhead", overhead: { spiral_judge_tokens: 5000 } }]),
    );
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: join(dir, "work"),
      stateHomes: [first, second],
    });
    assertEquals(stats, {
      enabled: true,
      status: "on",
      persistence: "unavailable",
      factsInjected: 6,
      redirects: 2,
      stillStuckNotices: 2,
      judgeCalls: 3,
      pluginEffectiveTokens: 6150,
      pluginCostUsd: 0.00615, // 6150 effective tokens at haiku's 1 USD per million input
    });
  });
});

Deno.test("summarise - a ledger-only home leaves the session figures absent, not 0", async () => {
  await withTemp(async (dir) => {
    const home = join(dir, "home");
    const base = join(home, "repos", "k", "claude");
    await Deno.mkdir(base, { recursive: true });
    await Deno.writeTextFile(
      join(base, "ledger.jsonl"),
      JSON.stringify({ kind: "session", overhead: { optimizer_tokens: 200 } }) +
        "\n",
    );
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: join(dir, "work"),
      stateHomes: [home],
    });
    assertEquals(stats, {
      enabled: true,
      status: "on",
      persistence: "unavailable",
      judgeCalls: 0,
      pluginEffectiveTokens: 200,
      pluginCostUsd: 0.0002,
    });
  });
});

Deno.test("summarise - disabled and ineligible runs are off", async () => {
  const base = { workDir: "/nonexistent", stateHomes: [] as string[] };
  assertEquals(
    await summariseTokenEconomizerRun({
      ...base,
      enabled: false,
      eligible: true,
    }),
    { enabled: false, status: "off", persistence: "unavailable" },
  );
  assertEquals(
    await summariseTokenEconomizerRun({
      ...base,
      enabled: true,
      eligible: false,
    }),
    { enabled: true, status: "off", persistence: "unavailable" },
  );
});

Deno.test("summarise - an empty or missing home is fallback with no figures", async () => {
  await withTemp(async (dir) => {
    const empty = join(dir, "empty");
    await Deno.mkdir(empty);
    for (const homes of [[], [empty], [join(dir, "missing")]]) {
      assertEquals(
        await summariseTokenEconomizerRun({
          enabled: true,
          eligible: true,
          workDir: join(dir, "work"),
          stateHomes: homes,
        }),
        {
          enabled: true,
          status: "fallback",
          persistence: "unavailable",
        },
      );
    }
  });
});

Deno.test("summarise - a malformed ledger line makes ledger figures absent, not zero", async () => {
  await withTemp(async (dir) => {
    const home = join(dir, "home");
    await fixtureHome(home, '{"kind":"session"}\n{not json\n');
    const warnings: string[] = [];
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: join(dir, "work"),
      stateHomes: [home],
      logger: { warn: (m) => warnings.push(m) },
    });
    assertEquals(stats, {
      enabled: true,
      status: "on",
      persistence: "unavailable",
      factsInjected: 3,
      redirects: 1,
      stillStuckNotices: 1,
    });
    assertEquals(warnings.length, 1);
    assertEquals((warnings[0] ?? "").includes("ledger.jsonl"), true);
  });
});

Deno.test("summarise - a stop record in force reports stopped with its rule", async () => {
  await withTemp(async (dir) => {
    const work = join(dir, "work");
    await Deno.mkdir(work);
    await recordTokenEconomizerStop(work, {
      rule: "plugin-run-failure",
      reason: "hook failed",
    });
    const home = join(dir, "home");
    await fixtureHome(home);
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: work,
      stateHomes: [home],
    });
    assertEquals(stats.status, "stopped");
    assertEquals(stats.stopRule, "plugin-run-failure");
    assertEquals(stats.factsInjected, 3);
  });
});

Deno.test("summarise - a stop record with no session state carries no figures", async () => {
  await withTemp(async (dir) => {
    const work = join(dir, "work");
    await Deno.mkdir(work);
    await recordTokenEconomizerStop(work, {
      rule: "plugin-run-failure",
      reason: "hook failed",
    });
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: work,
      stateHomes: [join(dir, "missing")],
    });
    assertEquals(stats, {
      enabled: true,
      status: "stopped",
      persistence: "unavailable",
      stopRule: "plugin-run-failure",
    });
    for (
      const key of [
        "factsInjected",
        "judgeCalls",
        "redirects",
        "stillStuckNotices",
        "pluginEffectiveTokens",
        "pluginCostUsd",
      ]
    ) assertEquals(key in stats, false);
  });
});

const ON: TokenEconomizerRunStats = {
  enabled: true,
  status: "on",
  persistence: "unavailable",
  factsInjected: 3,
  judgeCalls: 2,
  redirects: 1,
  stillStuckNotices: 0,
  pluginEffectiveTokens: 4100,
  pluginCostUsd: 0.0123,
};

Deno.test("stats line - exact strings for every status", () => {
  assertEquals(
    buildTokenEconomizerStatsLine(tokenEconomizerNotRun(false)),
    "- **TokenEconomizer:** off",
  );
  assertEquals(
    buildTokenEconomizerStatsLine(tokenEconomizerNotRun(true)),
    "- **TokenEconomizer:** not-run — switched on, the run ended before the agent spawned",
  );
  assertEquals(
    buildTokenEconomizerStatsLine({
      enabled: true,
      status: "fallback",
      persistence: "unavailable",
    }),
    "- **TokenEconomizer:** fallback — switched on, plugin not loaded",
  );
  assertEquals(
    buildTokenEconomizerStatsLine(ON, 1.35),
    "- **TokenEconomizer:** on — learnings not persisted; 3 facts injected; 2 judge calls; 1 redirect; 0 still-stuck notices; plugin model calls ~$0.0123 (run incl. plugin ~$1.3623)",
  );
  assertEquals(
    buildTokenEconomizerStatsLine({
      ...ON,
      status: "stopped",
      stopRule: "plugin-run-failure",
      persistence: "available",
    }),
    "- **TokenEconomizer:** stopped (plugin-run-failure) — learnings persisted; 3 facts injected; 2 judge calls; 1 redirect; 0 still-stuck notices; plugin model calls ~$0.0123",
  );
  assertEquals(
    buildTokenEconomizerStatsLine({
      enabled: true,
      status: "on",
      persistence: "unavailable",
    }, 1.35),
    "- **TokenEconomizer:** on — learnings not persisted; facts injected unavailable; judge calls unavailable; redirects unavailable; still-stuck notices unavailable; plugin model calls unavailable",
  );
});

function claudeResult(): PhaseClaudeResult {
  return {
    runStats: {
      servedModels: ["claude-opus-4-8"],
      requestedModel: "opus",
      wallClockMs: 2_000,
      tokenUsage: {
        inputTokens: 1_000,
        outputTokens: 2_000,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
      },
    },
  };
}

Deno.test("run-stats comment - the line follows the RTK line; omitted is unchanged", () => {
  const base = {
    phase: "issue",
    claudeResults: [claudeResult()],
    runId: "vibe-te-run",
    rtk: { status: "ok" as const, enabled: true, savedTokens: 12 },
  };
  const without = buildIssueRunStatsComment(base);
  const withLine = buildIssueRunStatsComment({ ...base, tokenEconomizer: ON });
  const lines = withLine.split("\n");
  const rtkAt = lines.findIndex((l) => l.startsWith("- **RTK:**"));
  assertEquals(rtkAt > 0, true);
  assertEquals(
    (lines[rtkAt + 1] ?? "").startsWith("- **TokenEconomizer:** on"),
    true,
  );
  assertEquals(
    lines.filter((l) => l !== lines[rtkAt + 1]).join("\n"),
    without,
  );
  assertEquals(
    buildIssueRunStatsComment({ ...base, tokenEconomizer: undefined }),
    without,
  );
});

function context(
  overrides: Partial<IssueRunCallbackContext> = {},
): IssueRunCallbackContext {
  return {
    runId: "vibe-abc-123456",
    result: "success",
    repository: "stSoftwareAU/VibeCoder",
    issueNumber: 4958,
    host: "worker-1",
    startedAt: "2026-09-02T01:00:00.000Z",
    finishedAt: "2026-09-02T01:05:00.000Z",
    durationSeconds: 300,
    exitCode: 0,
    ...overrides,
  };
}

Deno.test("callback document - a switched-off host is byte-identical", () => {
  const plain = buildCallbackContextDocument(context(), "always");
  for (const tokenEconomizer of [undefined, tokenEconomizerNotRun(false)]) {
    const document = buildCallbackContextDocument(
      context({ tokenEconomizer }),
      "always",
    );
    assertEquals(document, plain);
    assertEquals(JSON.stringify(document), JSON.stringify(plain));
  }
  assertEquals("tokenEconomizer" in plain, false);
});

Deno.test("callback document - an on run carries the block and the schema stays 2", () => {
  const document = buildCallbackContextDocument(
    context({
      tokenEconomizer: ON,
      telemetry: { estimatedCostUsd: 1.5 },
    }),
    "always",
  );
  assertEquals(document.schemaVersion, 2);
  assertEquals(document.tokenEconomizer, {
    enabled: true,
    status: "on",
    persistence: "unavailable",
    factsInjected: 3,
    judgeCalls: 2,
    redirects: 1,
    stillStuckNotices: 0,
    pluginEffectiveTokens: 4100,
    pluginCostUsd: 0.0123,
    runCostUsd: 1.5123,
  });
  assertEquals(
    tokenEconomizerCallbackBlock(tokenEconomizerNotRun(true)),
    { enabled: true, status: "not-run", persistence: "unavailable" },
  );
});
