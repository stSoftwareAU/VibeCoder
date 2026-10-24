/**
 * Compacting a stream's conversation before a new issue (Issues #2337, #4116).
 *
 * Covers the four paths a run can take — a real `/compact`, verified by the
 * compact boundary it appends to the transcript; a fresh session when it is
 * not verified; the providers that expose no compaction lever at all; and the
 * freshly opened stream there is nothing to compact — plus the
 * one-line-per-run rule, and that no `--autocompact` window ever reaches the
 * CLI (it put the compaction threshold below the issue prompt's own size).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  COMPACT_PROMPT,
  type CompactionRunRequest,
  compactStreamSession,
  primeStreamCompaction,
} from "../lib/stream_compaction.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** One ordinary transcript line, as the CLI writes a user turn. */
const TURN_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "x".repeat(200) },
}) + "\n";

/**
 * The record Claude Code appends when `/compact` works — copied from a live
 * stream transcript on GRQ-23 (Issue #4116). The file grows by this line.
 */
const BOUNDARY_LINE = JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  level: "info",
  compactMetadata: { trigger: "manual", preTokens: 65523 },
}) + "\n";

/**
 * A tool result that merely *quotes* a boundary record. Inside a JSON string
 * its quotes are escaped, so it must never read as a compaction.
 */
const QUOTED_BOUNDARY_LINE = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      content: '{"type":"system","subtype":"compact_boundary"}',
    }],
  },
}) + "\n";

/** A throwaway `CLAUDE_CONFIG_DIR` holding one session transcript. */
async function withTranscript(
  initialTurns: number,
  body: (ctx: {
    root: string;
    path: string;
    append: (line: string) => Promise<void>;
    remove: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "stream-compaction-" });
  // The CLI nests transcripts one directory per project under `projects/`.
  const dir = `${root}/projects/-home-vibe-work-repo`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${SESSION_ID}.jsonl`;
  await Deno.writeTextFile(path, TURN_LINE.repeat(initialTurns));
  try {
    await body({
      root,
      path,
      append: (line) => Deno.writeTextFile(path, line, { append: true }),
      remove: () => Deno.remove(path),
    });
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

/** A stubbed `/compact` run, recording what it was asked to do. */
function stubRunner(
  behaviour: (request: CompactionRunRequest) =>
    | Promise<
      { ok: boolean; exitCode?: number; detail?: string }
    >
    | { ok: boolean; exitCode?: number; detail?: string },
) {
  const calls: CompactionRunRequest[] = [];
  return {
    calls,
    runner: async (request: CompactionRunRequest) => {
      calls.push(request);
      return await behaviour(request);
    },
  };
}

/** A logger that records every line, so "exactly one" is assertable. */
function recordingLogger() {
  const lines: string[] = [];
  const fields: Record<string, unknown>[] = [];
  const levels: string[] = [];
  return {
    lines,
    fields,
    levels,
    logger: {
      info(message: string, extra?: Record<string, unknown>) {
        levels.push("info");
        lines.push(message);
        fields.push(extra ?? {});
      },
      warn(message: string, extra?: Record<string, unknown>) {
        levels.push("warn");
        lines.push(message);
        fields.push(extra ?? {});
      },
    },
  };
}

Deno.test("compactStreamSession - a new compact boundary is a real compaction, though the file grew", async () => {
  // The live shape (Issue #4116): Claude's transcript is append-only, so a
  // working `/compact` makes the file larger. Size never shrank once in 15
  // GRQ-23 runs; the boundary record is what changes.
  await withTranscript(20, async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(TURN_LINE + BOUNDARY_LINE + TURN_LINE);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "compacted");
    assertEquals(result.message, "compaction: /compact");
    assertEquals(result.freshSession, undefined);
    assertEquals(result.fields.compactBoundariesBefore, 0);
    assertEquals(result.fields.compactBoundariesAfter, 1);
    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0]?.prompt, COMPACT_PROMPT);
    assertEquals(stub.calls[0]?.sessionId, SESSION_ID);
  });
});

Deno.test("compactStreamSession - an earlier boundary does not prove this compaction", async () => {
  // A stream compacted on an earlier issue already carries boundaries; only a
  // new one counts.
  await withTranscript(20, async (ctx) => {
    await ctx.append(BOUNDARY_LINE + TURN_LINE);
    const stub = stubRunner(async () => {
      await ctx.append(TURN_LINE);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "fresh");
    assertEquals(result.freshSession, true);
    assertEquals(result.fields.compactBoundariesBefore, 1);
    assertEquals(result.fields.compactBoundariesAfter, 1);
  });
});

Deno.test("compactStreamSession - a quoted boundary inside a tool result is not a compaction", async () => {
  await withTranscript(20, async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(QUOTED_BOUNDARY_LINE);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "fresh");
  });
});

Deno.test("compactStreamSession - an unchanged transcript starts a fresh session", async () => {
  await withTranscript(20, async (ctx) => {
    const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "fresh");
    assertEquals(result.freshSession, true);
    assertEquals(result.message, "compaction: fresh session");
  });
});

Deno.test("compactStreamSession - a non-zero /compact run starts a fresh session and never fails the issue", async () => {
  await withTranscript(20, async (ctx) => {
    const stub = stubRunner(async () => {
      // A failed run that still wrote a boundary is not trusted: the exit
      // alone decides.
      await ctx.append(BOUNDARY_LINE);
      return { ok: true, exitCode: 2, detail: "compact refused" };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "deepseek",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "fresh");
    assertEquals(result.freshSession, true);
    assertEquals(result.fields.compactExitCode, 2);
  });
});

Deno.test("compactStreamSession - a runner that throws starts a fresh session rather than propagating", async () => {
  await withTranscript(20, async (ctx) => {
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: () => {
        throw new Error("spawn refused");
      },
    });
    assertEquals(result.action, "fresh");
    assertStringIncludes(String(result.fields.compactError), "spawn refused");
  });
});

Deno.test("compactStreamSession - a transcript that cannot be read is not claimed as compacted", async () => {
  await withTranscript(20, async (ctx) => {
    await ctx.remove();
    const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "fresh");
    assertEquals(result.freshSession, true);
  });
});

for (const providerId of ["codex", "gemini"]) {
  Deno.test(`compactStreamSession - ${providerId} exposes no compaction lever`, async () => {
    await withTranscript(20, async (ctx) => {
      const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
      const result = await compactStreamSession({
        outcome: "resumed",
        providerId,
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        runner: stub.runner,
      });
      assertEquals(result.action, "unavailable");
      assertStringIncludes(result.message, "compaction unavailable");
      assertStringIncludes(result.message, providerId);
      assertEquals(result.freshSession, undefined);
      assertEquals(stub.calls.length, 0);
    });
  });
}

for (const outcome of ["new", "reset"] as const) {
  Deno.test(`compactStreamSession - a ${outcome} stream session has nothing to compact`, async () => {
    await withTranscript(20, async (ctx) => {
      const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
      const result = await compactStreamSession({
        outcome,
        providerId: "claude",
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        runner: stub.runner,
      });
      assertEquals(result.action, "skipped");
      assertEquals(result.message, "compaction skipped: new stream session");
      assertEquals(result.freshSession, undefined);
      assertEquals(stub.calls.length, 0);
    });
  });
}

Deno.test("primeStreamCompaction - logs exactly one compaction line per run, whichever path ran", async () => {
  const cases: Array<{
    label: string;
    providerId: string;
    outcome: "resumed" | "new" | "reset";
    boundary: boolean;
    exitCode: number;
    expected: string;
    fresh: boolean;
  }> = [
    {
      label: "compacted",
      providerId: "claude",
      outcome: "resumed",
      boundary: true,
      exitCode: 0,
      expected: "compaction: /compact",
      fresh: false,
    },
    {
      label: "unverified",
      providerId: "claude",
      outcome: "resumed",
      boundary: false,
      exitCode: 0,
      expected: "compaction: fresh session",
      fresh: true,
    },
    {
      label: "non-zero exit",
      providerId: "deepseek",
      outcome: "resumed",
      boundary: true,
      exitCode: 1,
      expected: "compaction: fresh session",
      fresh: true,
    },
    {
      label: "unavailable",
      providerId: "codex",
      outcome: "resumed",
      boundary: false,
      exitCode: 0,
      expected: "compaction unavailable",
      fresh: false,
    },
    {
      label: "skipped",
      providerId: "claude",
      outcome: "new",
      boundary: false,
      exitCode: 0,
      expected: "compaction skipped: new stream session",
      fresh: false,
    },
  ];

  for (const testCase of cases) {
    await withTranscript(20, async (ctx) => {
      const record = recordingLogger();
      const fresh = await primeStreamCompaction({
        outcome: testCase.outcome,
        providerId: testCase.providerId,
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        logger: record.logger,
        runner: async () => {
          if (testCase.boundary) await ctx.append(BOUNDARY_LINE);
          return { ok: true, exitCode: testCase.exitCode };
        },
      });
      assertEquals(
        record.lines.length,
        1,
        `${testCase.label}: expected one line, got ${record.lines.join(" | ")}`,
      );
      assertStringIncludes(record.lines[0] ?? "", testCase.expected);
      assertEquals(fresh, testCase.fresh, testCase.label);
    });
  }
});

Deno.test("primeStreamCompaction - a runner that throws never propagates to the issue", async () => {
  await withTranscript(20, async (ctx) => {
    const record = recordingLogger();
    const fresh = await primeStreamCompaction({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: () => {
        throw new Error("no CLI here");
      },
      logger: record.logger,
    });
    assertEquals(fresh, true);
    assertEquals(record.lines.length, 1);
    // The spawn-failure branch specifically, not some earlier fault standing
    // in for it — the reason names which path actually ran.
    assertStringIncludes(
      String(record.fields[0]?.reason),
      "could not be spawned",
    );
  });
});

Deno.test("compactStreamSession - a transcript directory that does not exist yet is not a fault", async () => {
  // The ordinary first run on a host: `<CLAUDE_CONFIG_DIR>/projects` has never
  // been written. Reading it must fall back, not throw.
  const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
  const result = await compactStreamSession({
    outcome: "resumed",
    providerId: "claude",
    sessionId: SESSION_ID,
    transcriptRoot: "/nonexistent/stream-compaction",
    runner: stub.runner,
  });
  assertEquals(result.action, "fresh");
  assertEquals(result.freshSession, true);
  // The run still happened — the missing directory only made its outcome
  // unprovable.
  assertEquals(stub.calls.length, 1);
});

Deno.test("compactStreamSession - the transcript root comes from the provider's own child environment", async () => {
  // The production path: no `transcriptRoot` is passed, so the module must
  // find the directory the CLI will actually write to.
  await withTranscript(20, async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(BOUNDARY_LINE);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      parentEnv: { HOME: "/home/nobody", CLAUDE_CONFIG_DIR: ctx.root },
      runner: stub.runner,
    });
    assertEquals(result.action, "compacted");
    assertEquals(result.fields.compactBoundariesAfter, 1);
  });
});

Deno.test("compactStreamSession - a new stream session is skipped whatever the provider", async () => {
  // Two rules meet here — nothing to compact, and no lever — and only one
  // line may be logged. "Nothing to compact" is the more specific fact, and
  // it is the one reported.
  const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
  const result = await compactStreamSession({
    outcome: "new",
    providerId: "codex",
    sessionId: SESSION_ID,
    transcriptRoot: "/nonexistent/stream-compaction",
    runner: stub.runner,
  });
  assertEquals(result.action, "skipped");
  assertEquals(stub.calls.length, 0);
});

Deno.test("primeStreamCompaction - the fresh-session fallback is a warning, a verified compaction is not", async () => {
  await withTranscript(20, async (ctx) => {
    const fallback = recordingLogger();
    await primeStreamCompaction({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: () => ({ ok: true, exitCode: 0 }),
      logger: fallback.logger,
    });
    assertEquals(fallback.levels, ["warn"]);

    const compacted = recordingLogger();
    await primeStreamCompaction({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: async () => {
        await ctx.append(BOUNDARY_LINE);
        return { ok: true, exitCode: 0 };
      },
      logger: compacted.logger,
    });
    assertEquals(compacted.levels, ["info"]);
  });
});

Deno.test("no provider's CLI argument list ever carries --autocompact", () => {
  // `--autocompact 100000` put Claude's compaction trigger near 68k tokens,
  // under the ~67k-token issue prompt itself: every turn compacted and the CLI
  // aborted with "Autocompact is thrashing" (Issue #4116; 37 of 44 GRQ-23
  // analysis-only hand-offs, 2026-10-20 → 23).
  for (const providerId of ["claude", "deepseek", "codex", "gemini"]) {
    const args = resolveAgentProvider(providerId).buildInvocation({
      prompt: "do the work",
    });
    assertEquals(args.includes("--autocompact"), false, providerId);
  }
});
