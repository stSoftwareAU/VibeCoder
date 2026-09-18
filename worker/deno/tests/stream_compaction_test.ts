/**
 * Compacting a stream's conversation before a new issue (Issue #2337).
 *
 * Covers the four paths a run can take — a real `/compact` whose outcome is
 * verified against the transcript, the `--autocompact` fallback when it is
 * not, the providers that expose no compaction lever at all, and the freshly
 * opened stream there is nothing to compact — plus the one-line-per-run rule
 * and the `--autocompact` flag reaching the CLI argument list.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AUTOCOMPACT_WINDOW_TOKENS,
  COMPACT_PROMPT,
  type CompactionRunRequest,
  compactStreamSession,
  primeStreamCompaction,
} from "../lib/stream_compaction.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** A throwaway `CLAUDE_CONFIG_DIR` holding one session transcript. */
async function withTranscript(
  initialBytes: number,
  body: (ctx: {
    root: string;
    path: string;
    write: (bytes: number) => Promise<void>;
    remove: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "stream-compaction-" });
  // The CLI nests transcripts one directory per project under `projects/`.
  const dir = `${root}/projects/-home-vibe-work-repo`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${SESSION_ID}.jsonl`;
  const write = async (bytes: number) => {
    await Deno.writeTextFile(path, "x".repeat(bytes));
  };
  await write(initialBytes);
  try {
    await body({
      root,
      path,
      write,
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

Deno.test("compactStreamSession - a shrinking transcript is a real compaction", async () => {
  await withTranscript(4096, async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.write(128);
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
    assertEquals(result.autocompactTokens, undefined);
    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0]?.prompt, COMPACT_PROMPT);
    assertEquals(stub.calls[0]?.sessionId, SESSION_ID);
  });
});

Deno.test("compactStreamSession - an unchanged transcript falls back to autocompact", async () => {
  await withTranscript(4096, async (ctx) => {
    const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
    assertEquals(result.message, "compaction: autocompact 100000");
  });
});

Deno.test("compactStreamSession - a grown transcript falls back to autocompact", async () => {
  await withTranscript(1024, async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.write(8192);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "deepseek",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
  });
});

Deno.test("compactStreamSession - a non-zero /compact run falls back and never fails the issue", async () => {
  await withTranscript(4096, async (ctx) => {
    const stub = stubRunner(async () => {
      // A failed run may still have shrunk nothing; the exit alone decides.
      await ctx.write(16);
      return { ok: true, exitCode: 2, detail: "compact refused" };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
    assertEquals(result.fields.compactExitCode, 2);
  });
});

Deno.test("compactStreamSession - a runner that throws falls back rather than propagating", async () => {
  await withTranscript(4096, async (ctx) => {
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: () => {
        throw new Error("spawn refused");
      },
    });
    assertEquals(result.action, "autocompact");
    assertStringIncludes(String(result.fields.compactError), "spawn refused");
  });
});

Deno.test("compactStreamSession - a transcript that cannot be measured is not claimed as compacted", async () => {
  await withTranscript(4096, async (ctx) => {
    await ctx.remove();
    const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
  });
});

for (const providerId of ["codex", "gemini"]) {
  Deno.test(`compactStreamSession - ${providerId} exposes no compaction lever`, async () => {
    await withTranscript(4096, async (ctx) => {
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
      assertEquals(result.autocompactTokens, undefined);
      assertEquals(stub.calls.length, 0);
    });
  });
}

for (const outcome of ["new", "reset"] as const) {
  Deno.test(`compactStreamSession - a ${outcome} stream session has nothing to compact`, async () => {
    await withTranscript(4096, async (ctx) => {
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
      assertEquals(result.autocompactTokens, undefined);
      assertEquals(stub.calls.length, 0);
    });
  });
}

Deno.test("primeStreamCompaction - logs exactly one compaction line per run, whichever path ran", async () => {
  const cases: Array<{
    label: string;
    providerId: string;
    outcome: "resumed" | "new" | "reset";
    shrink: boolean;
    exitCode: number;
    expected: string;
    tokens: number | undefined;
  }> = [
    {
      label: "compacted",
      providerId: "claude",
      outcome: "resumed",
      shrink: true,
      exitCode: 0,
      expected: "compaction: /compact",
      tokens: undefined,
    },
    {
      label: "fallback",
      providerId: "claude",
      outcome: "resumed",
      shrink: false,
      exitCode: 0,
      expected: "compaction: autocompact 100000",
      tokens: AUTOCOMPACT_WINDOW_TOKENS,
    },
    {
      label: "non-zero exit",
      providerId: "deepseek",
      outcome: "resumed",
      shrink: true,
      exitCode: 1,
      expected: "compaction: autocompact 100000",
      tokens: AUTOCOMPACT_WINDOW_TOKENS,
    },
    {
      label: "unavailable",
      providerId: "codex",
      outcome: "resumed",
      shrink: false,
      exitCode: 0,
      expected: "compaction unavailable",
      tokens: undefined,
    },
    {
      label: "skipped",
      providerId: "claude",
      outcome: "new",
      shrink: false,
      exitCode: 0,
      expected: "compaction skipped: new stream session",
      tokens: undefined,
    },
  ];

  for (const testCase of cases) {
    await withTranscript(4096, async (ctx) => {
      const record = recordingLogger();
      const tokens = await primeStreamCompaction({
        outcome: testCase.outcome,
        providerId: testCase.providerId,
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        logger: record.logger,
        runner: async () => {
          if (testCase.shrink) await ctx.write(16);
          return { ok: true, exitCode: testCase.exitCode };
        },
      });
      assertEquals(
        record.lines.length,
        1,
        `${testCase.label}: expected one line, got ${record.lines.join(" | ")}`,
      );
      assertStringIncludes(record.lines[0] ?? "", testCase.expected);
      assertEquals(tokens, testCase.tokens, testCase.label);
    });
  }
});

Deno.test("primeStreamCompaction - a runner that throws never propagates to the issue", async () => {
  await withTranscript(4096, async (ctx) => {
    const record = recordingLogger();
    const tokens = await primeStreamCompaction({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: () => {
        throw new Error("no CLI here");
      },
      logger: record.logger,
    });
    assertEquals(tokens, AUTOCOMPACT_WINDOW_TOKENS);
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
  // been written. Measuring it must fall back, not throw.
  const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
  const result = await compactStreamSession({
    outcome: "resumed",
    providerId: "claude",
    sessionId: SESSION_ID,
    transcriptRoot: "/nonexistent/stream-compaction",
    runner: stub.runner,
  });
  assertEquals(result.action, "autocompact");
  assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
  // The run still happened — the missing directory only made its outcome
  // unprovable.
  assertEquals(stub.calls.length, 1);
});

Deno.test("compactStreamSession - the transcript root comes from the provider's own child environment", async () => {
  // The production path: no `transcriptRoot` is passed, so the module must
  // find the directory the CLI will actually write to.
  await withTranscript(4096, async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.write(64);
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
    assertEquals(result.fields.transcriptBytesBefore, 4096);
    assertEquals(result.fields.transcriptBytesAfter, 64);
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

Deno.test("primeStreamCompaction - the fallback is a warning, a verified compaction is not", async () => {
  await withTranscript(4096, async (ctx) => {
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
        await ctx.write(32);
        return { ok: true, exitCode: 0 };
      },
      logger: compacted.logger,
    });
    assertEquals(compacted.levels, ["info"]);
  });
});

Deno.test("--autocompact reaches the Claude and DeepSeek CLI argument lists", () => {
  for (const providerId of ["claude", "deepseek"]) {
    const args = resolveAgentProvider(providerId).buildInvocation({
      prompt: "do the work",
      autocompactTokens: AUTOCOMPACT_WINDOW_TOKENS,
    });
    const at = args.indexOf("--autocompact");
    assert(at >= 0, `${providerId} should pass --autocompact`);
    assertEquals(args[at + 1], String(AUTOCOMPACT_WINDOW_TOKENS));
  }
});

Deno.test("--autocompact is absent when no fallback is in force", () => {
  const args = resolveAgentProvider("claude").buildInvocation({
    prompt: "do the work",
  });
  assertEquals(args.includes("--autocompact"), false);
});

Deno.test("--autocompact is never passed to a provider without the lever", () => {
  for (const providerId of ["codex", "gemini"]) {
    const args = resolveAgentProvider(providerId).buildInvocation({
      prompt: "do the work",
      autocompactTokens: AUTOCOMPACT_WINDOW_TOKENS,
    });
    assertEquals(
      args.includes("--autocompact"),
      false,
      `${providerId} has no --autocompact flag`,
    );
  }
});
