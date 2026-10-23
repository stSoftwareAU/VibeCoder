/**
 * Compacting a stream's conversation before a new issue (Issue #2337).
 *
 * Covers the four paths a run can take — a real `/compact` whose outcome is
 * verified by the `compact_boundary` record it appends to the transcript (Issue
 * #4116), the `--autocompact` fallback when it does not, the providers that
 * expose no compaction lever at all, and the freshly opened stream where there
 * is nothing to compact — plus the one-line-per-run rule and the `--autocompact`
 * flag reaching the CLI argument list.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AUTOCOMPACT_WINDOW_TOKENS,
  COMPACT_PROMPT,
  type CompactionRunRequest,
  compactStreamSession,
  MAX_APPENDED_SCAN_BYTES,
  primeStreamCompaction,
} from "../lib/stream_compaction.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PROJECT_DIRECTORY = "-home-vibe-work-repo";

/** The reason a fallback gives when `/compact` appended no boundary record. */
const NO_BOUNDARY_REASON =
  "no compact_boundary record was appended to the transcript";

/** One ordinary transcript record: a JSON object on its own line. */
function userRecord(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  }) + "\n";
}

/** One ordinary assistant record: a JSON object on its own line. */
function assistantRecord(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";
}

/** The record the CLI appends to the transcript once `/compact` has applied. */
const COMPACT_BOUNDARY_RECORD = JSON.stringify({
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
}) + "\n";

/** A session history of a couple of exchanges, already on disk before a run. */
const TRANSCRIPT_HISTORY = userRecord("Implement the parser for issue 2311.") +
  assistantRecord("Done: the parser is in lib/parser.ts.") +
  userRecord("Now add the tests.");

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

async function fileSize(path: string): Promise<number> {
  return (await Deno.stat(path)).size;
}

/** The transcript a test has written, and the ways a run can change it. */
interface TranscriptFixture {
  /** The `CLAUDE_CONFIG_DIR` the transcript lives under. */
  root: string;
  /** The session's `<sessionId>.jsonl` transcript. */
  path: string;
  /** Appends bytes to the transcript, as the CLI does during a run. */
  append: (text: string) => Promise<void>;
  /** Replaces the transcript's whole content. */
  overwrite: (text: string) => Promise<void>;
  /** Deletes the transcript file, leaving its directory in place. */
  remove: () => Promise<void>;
}

/** A throwaway `CLAUDE_CONFIG_DIR` holding one session transcript. */
async function withTranscript(
  body: (ctx: TranscriptFixture) => Promise<void>,
  history = TRANSCRIPT_HISTORY,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "stream-compaction-" });
  // The CLI nests transcripts one directory per project under `projects/`.
  const dir = `${root}/projects/${PROJECT_DIRECTORY}`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${SESSION_ID}.jsonl`;
  await Deno.writeTextFile(path, history);
  try {
    await body({
      root,
      path,
      append: (text) => Deno.writeTextFile(path, text, { append: true }),
      overwrite: (text) => Deno.writeTextFile(path, text),
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

Deno.test("compactStreamSession - a compact_boundary appended by the /compact run is a real compaction", async () => {
  await withTranscript(async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(COMPACT_BOUNDARY_RECORD);
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

Deno.test("compactStreamSession - REGRESSION (Issue #4116): a transcript that grows by a compact_boundary record is compacted", async () => {
  // Before the fix this was judged by size, and an append-only transcript never
  // shrinks, so the boundary was ignored and the run fell back to autocompact.
  await withTranscript(async (ctx) => {
    const before = await fileSize(ctx.path);
    const appended = COMPACT_BOUNDARY_RECORD;
    const stub = stubRunner(async () => {
      await ctx.append(appended);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assert(
      await fileSize(ctx.path) > before,
      "the transcript must have grown, so only the boundary can prove compaction",
    );
    assertEquals(result.action, "compacted");
    assertEquals(result.message, "compaction: /compact");
    assertEquals(result.fields.compactBoundaries, 1);
    assertEquals(result.fields.transcriptOffsetBefore, before);
    assertEquals(result.fields.transcriptBytesAppended, byteLength(appended));
  });
});

Deno.test("compactStreamSession - an unchanged transcript falls back to autocompact", async () => {
  await withTranscript(async (ctx) => {
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
    assertEquals(result.fields.reason, NO_BOUNDARY_REASON);
    assertEquals(result.fields.transcriptBytesAppended, 0);
  });
});

Deno.test("compactStreamSession - a non-zero /compact run falls back and never fails the issue", async () => {
  await withTranscript(async (ctx) => {
    const stub = stubRunner(async () => {
      // A failed run may still have appended a boundary; the exit alone decides.
      await ctx.append(COMPACT_BOUNDARY_RECORD);
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
    assertEquals(result.fields.compactError, "compact refused");
    assertStringIncludes(
      String(result.fields.reason),
      "did not exit cleanly",
    );
    assertEquals(result.fields.compactBoundaries, undefined);
  });
});

Deno.test("compactStreamSession - a transcript that grows with ordinary records but no compact_boundary falls back (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const before = await fileSize(ctx.path);
    const appended = userRecord("Thanks, carry on.") +
      assistantRecord("Carrying on with issue 2311.");
    const stub = stubRunner(async () => {
      await ctx.append(appended);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "deepseek",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assert(await fileSize(ctx.path) > before);
    assertEquals(result.action, "autocompact");
    assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
    assertStringIncludes(String(result.fields.reason), "compact_boundary");
    assertEquals(result.fields.transcriptOffsetBefore, before);
    assertEquals(result.fields.transcriptBytesAppended, byteLength(appended));
  });
});

Deno.test("compactStreamSession - a compact_boundary left before the recorded offset by an earlier compaction does not count (Issue #4116)", async () => {
  // The fixture already holds a boundary: the forbidden thing. Only bytes the run
  // appends after the offset may count, so this must still fall back.
  const history = TRANSCRIPT_HISTORY + COMPACT_BOUNDARY_RECORD +
    userRecord("Picking up after the earlier compaction.");
  const cases = [
    { label: "the run appends nothing", appended: "" },
    {
      label: "the run appends ordinary records",
      appended: userRecord("Still here.") + assistantRecord("Still here too."),
    },
  ];
  for (const testCase of cases) {
    await withTranscript(async (ctx) => {
      const stub = stubRunner(async () => {
        await ctx.append(testCase.appended);
        return { ok: true, exitCode: 0 };
      });
      const result = await compactStreamSession({
        outcome: "resumed",
        providerId: "claude",
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        runner: stub.runner,
      });
      assertEquals(result.action, "autocompact", testCase.label);
      assertEquals(result.fields.reason, NO_BOUNDARY_REASON, testCase.label);
      assertEquals(
        result.fields.transcriptBytesAppended,
        byteLength(testCase.appended),
        testCase.label,
      );
    }, history);
  }
});

Deno.test("compactStreamSession - malformed and partial lines among the appended bytes are skipped, and a valid boundary still counts (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const appended = '{"type":"assistant"\n' + // malformed: unclosed object
      "not json at all\n" +
      "\n" + // blank line
      "null\n" + // valid JSON, but not a record
      "42\n" +
      COMPACT_BOUNDARY_RECORD +
      '{"type":"system","subtype":"compact_bou'; // partial: no trailing newline
    const stub = stubRunner(async () => {
      await ctx.append(appended);
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
    assertEquals(result.fields.compactBoundaries, 1);
  });
});

Deno.test("compactStreamSession - malformed or partial appended lines alone never count as a boundary (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(
        '{"type":"system"\n' + "}}}\n" + '{"type":"system","subtype":"comp',
      );
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.fields.reason, NO_BOUNDARY_REASON);
    assertEquals(result.fields.compactBoundaries, undefined);
  });
});

Deno.test("compactStreamSession - a transcript rewritten shorter than its offset is not claimed as compacted (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const before = await fileSize(ctx.path);
    const rewritten = COMPACT_BOUNDARY_RECORD;
    assert(byteLength(rewritten) < before, "the rewrite must be shorter");
    const stub = stubRunner(async () => {
      await ctx.overwrite(rewritten);
      return { ok: true, exitCode: 0 };
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
    assertStringIncludes(
      String(result.fields.reason),
      "could not be read after /compact",
    );
    assertEquals(result.fields.transcriptOffsetBefore, before);
    assertStringIncludes(
      String(result.fields.transcriptScanError),
      "smaller than its recorded offset",
    );
  });
});

Deno.test("compactStreamSession - a transcript that cannot be read after /compact is not claimed as compacted", async () => {
  await withTranscript(async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.remove();
      return { ok: true, exitCode: 0 };
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
    assertStringIncludes(
      String(result.fields.reason),
      "could not be read after /compact",
    );
    assertEquals(
      result.fields.transcriptOffsetBefore,
      byteLength(TRANSCRIPT_HISTORY),
    );
    assertStringIncludes(
      String(result.fields.transcriptScanError),
      "could not be read:",
    );
  });
});

Deno.test("compactStreamSession - a transcript that shrinks while its appended bytes are being read is not claimed as compacted (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const realOpen = Deno.open;
    const stub = stubRunner(async () => {
      await ctx.append(COMPACT_BOUNDARY_RECORD);
      // From here on the file reports more appended bytes than it can give.
      Deno.open = (async (...args: Parameters<typeof Deno.open>) => {
        const file = await realOpen(...args);
        return new Proxy(file, {
          get(target, prop) {
            if (prop === "stat") {
              return async () => {
                const info = await target.stat();
                return { ...info, size: info.size + 64 };
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof Deno.open;
      return { ok: true, exitCode: 0 };
    });
    try {
      const result = await compactStreamSession({
        outcome: "resumed",
        providerId: "claude",
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        runner: stub.runner,
      });
      assertEquals(result.action, "autocompact");
      assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
      assertStringIncludes(
        String(result.fields.reason),
        "could not be read after /compact",
      );
      assertStringIncludes(
        String(result.fields.transcriptScanError),
        "shrank while it was being read",
      );
      assertEquals(result.fields.compactBoundaries, undefined);
    } finally {
      Deno.open = realOpen;
    }
  });
});

Deno.test("compactStreamSession - a boundary-shaped substring inside another record does not count (Issue #4116)", async () => {
  // Both records contain the text of a boundary but neither is one: the first is
  // a user message quoting it, the second nests it inside a user record.
  const appended = userRecord(
    'the docs quote "subtype":"compact_boundary" as an example',
  ) +
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          content: { type: "system", subtype: "compact_boundary" },
        }],
      },
    }) + "\n";
  assertStringIncludes(appended, "compact_boundary");
  await withTranscript(async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(appended);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.fields.reason, NO_BOUNDARY_REASON);
    assertEquals(result.fields.transcriptBytesAppended, byteLength(appended));
  });
});

Deno.test("compactStreamSession - records that only resemble a boundary in one field do not count (Issue #4116)", async () => {
  const lookalikes = [
    { type: "system", subtype: "init" },
    { type: "user", subtype: "compact_boundary" },
    { type: "system" },
    { subtype: "compact_boundary" },
  ].map((record) => JSON.stringify(record) + "\n").join("");
  await withTranscript(async (ctx) => {
    const stub = stubRunner(async () => {
      await ctx.append(lookalikes);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.fields.reason, NO_BOUNDARY_REASON);
  });
});

Deno.test("compactStreamSession - a boundary appended to any copy of the session's transcript counts, and the offsets are summed (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const otherDir = `${ctx.root}/projects/-another-project`;
    await Deno.mkdir(otherDir, { recursive: true });
    const otherPath = `${otherDir}/${SESSION_ID}.jsonl`;
    await Deno.writeTextFile(otherPath, TRANSCRIPT_HISTORY);
    const ordinary = userRecord("Carrying on.");
    const stub = stubRunner(async () => {
      await ctx.append(ordinary);
      await Deno.writeTextFile(otherPath, COMPACT_BOUNDARY_RECORD, {
        append: true,
      });
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
    assertEquals(
      result.fields.transcriptOffsetBefore,
      byteLength(TRANSCRIPT_HISTORY) * 2,
    );
    assertEquals(result.fields.compactBoundaries, 1);
    assertEquals(
      result.fields.transcriptBytesAppended,
      byteLength(ordinary) + byteLength(COMPACT_BOUNDARY_RECORD),
    );
  });
});

Deno.test("compactStreamSession - a boundary beyond the scan cap is missed and falls back rather than being claimed (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    const filler = "x".repeat(MAX_APPENDED_SCAN_BYTES);
    const stub = stubRunner(async () => {
      await ctx.append(filler + "\n" + COMPACT_BOUNDARY_RECORD);
      return { ok: true, exitCode: 0 };
    });
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(result.action, "autocompact");
    assertEquals(result.fields.reason, NO_BOUNDARY_REASON);
    assertEquals(
      result.fields.transcriptBytesAppended,
      MAX_APPENDED_SCAN_BYTES,
    );
  });
});

Deno.test("compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    await ctx.remove();
    const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
    const result = await compactStreamSession({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
    });
    assertEquals(stub.calls.length, 0);
    assertEquals(result.action, "autocompact");
    assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);
    assertStringIncludes(String(result.fields.reason), "could not be located");
    assertEquals(result.fields.providerId, "claude");
  });
});

Deno.test("primeStreamCompaction - no transcript located: /compact is not run and exactly one warning is logged (Issue #4116)", async () => {
  await withTranscript(async (ctx) => {
    await ctx.remove();
    const stub = stubRunner(() => ({ ok: true, exitCode: 0 }));
    const record = recordingLogger();
    const tokens = await primeStreamCompaction({
      outcome: "resumed",
      providerId: "claude",
      sessionId: SESSION_ID,
      transcriptRoot: ctx.root,
      runner: stub.runner,
      logger: record.logger,
    });
    assertEquals(stub.calls.length, 0);
    assertEquals(tokens, AUTOCOMPACT_WINDOW_TOKENS);
    assertEquals(record.lines.length, 1);
    assertEquals(record.levels, ["warn"]);
    assertStringIncludes(
      String(record.fields[0]?.reason),
      "could not be located",
    );
  });
});

Deno.test("compactStreamSession - a runner that throws falls back rather than propagating", async () => {
  await withTranscript(async (ctx) => {
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

for (const providerId of ["codex", "gemini"]) {
  Deno.test(`compactStreamSession - ${providerId} exposes no compaction lever`, async () => {
    await withTranscript(async (ctx) => {
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
    await withTranscript(async (ctx) => {
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
    boundary: boolean;
    exitCode: number;
    expected: string;
    tokens: number | undefined;
  }> = [
    {
      label: "compacted",
      providerId: "claude",
      outcome: "resumed",
      boundary: true,
      exitCode: 0,
      expected: "compaction: /compact",
      tokens: undefined,
    },
    {
      label: "fallback",
      providerId: "claude",
      outcome: "resumed",
      boundary: false,
      exitCode: 0,
      expected: "compaction: autocompact 100000",
      tokens: AUTOCOMPACT_WINDOW_TOKENS,
    },
    {
      label: "non-zero exit",
      providerId: "deepseek",
      outcome: "resumed",
      boundary: true,
      exitCode: 1,
      expected: "compaction: autocompact 100000",
      tokens: AUTOCOMPACT_WINDOW_TOKENS,
    },
    {
      label: "unavailable",
      providerId: "codex",
      outcome: "resumed",
      boundary: false,
      exitCode: 0,
      expected: "compaction unavailable",
      tokens: undefined,
    },
    {
      label: "skipped",
      providerId: "claude",
      outcome: "new",
      boundary: false,
      exitCode: 0,
      expected: "compaction skipped: new stream session",
      tokens: undefined,
    },
  ];

  for (const testCase of cases) {
    await withTranscript(async (ctx) => {
      const record = recordingLogger();
      const tokens = await primeStreamCompaction({
        outcome: testCase.outcome,
        providerId: testCase.providerId,
        sessionId: SESSION_ID,
        transcriptRoot: ctx.root,
        logger: record.logger,
        runner: async () => {
          if (testCase.boundary) await ctx.append(COMPACT_BOUNDARY_RECORD);
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
  await withTranscript(async (ctx) => {
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
  // been written. The transcript cannot be located, so the run is not made and
  // the fallback is taken — not a throw.
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
  assertStringIncludes(String(result.fields.reason), "could not be located");
  assertEquals(stub.calls.length, 0);
});

Deno.test("compactStreamSession - the transcript root comes from the provider's own child environment", async () => {
  // The production path: no `transcriptRoot` is passed, so the module must
  // find the directory the CLI will actually write to.
  await withTranscript(async (ctx) => {
    const before = await fileSize(ctx.path);
    const stub = stubRunner(async () => {
      await ctx.append(COMPACT_BOUNDARY_RECORD);
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
    assertEquals(result.fields.transcriptOffsetBefore, before);
    assertEquals(result.fields.compactBoundaries, 1);
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
  await withTranscript(async (ctx) => {
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
        await ctx.append(COMPACT_BOUNDARY_RECORD);
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
