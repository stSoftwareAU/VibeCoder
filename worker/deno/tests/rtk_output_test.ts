/**
 * Tests for `lib/rtk_output.ts` — the RTK run module (Issue #2382, part of
 * #2328).
 *
 * Two invariants carry the file. The hook entry and the prompt line are
 * installed together or not at all, for every status a preparation can report;
 * and no seam outcome — a missing binary, a non-zero exit, a timeout, a throw,
 * or unreadable JSON — ever rejects the returned promise.
 *
 * Every subprocess is stubbed through the injected `run` seam, so nothing here
 * spawns `rtk` and nothing waits on a clock.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "../lib/agent_provider.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import type { Result } from "../types.ts";
import {
  buildRtkHookSettings,
  describeRtkRun,
  mergePreToolUseSettings,
  prepareRtkRun,
  RTK_HOOK_COMMAND,
  RTK_HOOK_MATCHER,
  RTK_OFF,
  RTK_PREFLIGHT_TIMEOUT_MS,
  RTK_PROMPT_LINE,
  RTK_UNAVAILABLE_MARKER,
  type RtkOutputLogger,
  type RtkRunner,
} from "../lib/rtk_output.ts";

/** One line a stub logger kept, so a test can read the marker back. */
interface LoggedLine {
  level: "info" | "warn";
  message: string;
}

/** A logger that keeps what it was told. */
function recordingLogger(): RtkOutputLogger & { lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  return {
    lines,
    info: (message: string) => lines.push({ level: "info", message }),
    warn: (message: string) => lines.push({ level: "warn", message }),
  };
}

/** The warn lines carrying the unavailable marker. */
function markerLines(logger: { lines: LoggedLine[] }): string[] {
  return logger.lines
    .filter((line) =>
      line.level === "warn" && line.message.includes(RTK_UNAVAILABLE_MARKER)
    )
    .map((line) => line.message);
}

/** A subprocess that ran and exited with `code`. */
function exited(
  code: number,
  stdout = "",
  stderr = "",
): Result<SubprocessResult> {
  return {
    ok: true,
    value: { success: code === 0, code, stdout, stderr, timedOut: false },
  };
}

/** What `runWithTimeout` answers when it killed the child: ok, code 124. */
function timedOut(ms: number): Result<SubprocessResult> {
  return {
    ok: true,
    value: {
      success: false,
      code: 124,
      stdout: "",
      stderr: `Timed out after ${ms}ms`,
      timedOut: true,
    },
  };
}

/** What `runWithTimeout` answers when the binary could not be spawned. */
function unstartable(message: string): Result<SubprocessResult> {
  return { ok: false, error: new Error(message) };
}

/** A healthy `rtk gain --all --format json` answer. */
function gain(totalSaved: number): Result<SubprocessResult> {
  return exited(0, JSON.stringify({ summary: { total_saved: totalSaved } }));
}

/** A healthy `rtk --version` answer. */
function version(): Result<SubprocessResult> {
  return exited(0, "rtk 0.37.2");
}

/** One recorded seam call. */
interface StubCall {
  executable: string;
  args: string[];
  timeoutMs?: number;
}

/** A seam that answers from a queue, and throws when the queue runs dry. */
function stubRunner(replies: (Result<SubprocessResult> | Error)[]): {
  run: RtkRunner;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const run: RtkRunner = (executable, args, options) => {
    calls.push({ executable, args, timeoutMs: options?.timeoutMs });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error(`unexpected call: ${executable} ${args.join(" ")}`);
    }
    if (reply instanceof Error) throw reply;
    return Promise.resolve(reply);
  };
  return { run, calls };
}

/** A prepared run on a Claude host whose preflight succeeded. */
function healthy(baseline: number, ...extra: Result<SubprocessResult>[]) {
  return stubRunner([version(), gain(baseline), ...extra]);
}

Deno.test("prepareRtkRun - a switched-off host changes nothing", async () => {
  const logger = recordingLogger();
  const stub = stubRunner([]);
  const run = await prepareRtkRun({
    enabled: false,
    providerId: CLAUDE_PROVIDER_ID,
    logger,
    run: stub.run,
  });

  assertEquals(run.result.status, "off");
  assertEquals(run.result.enabled, false);
  assertEquals(run.result.savedTokens, undefined);
  assertEquals(run.hookSettings(), undefined);
  assertEquals(run.applyPrompt("Do the work."), "Do the work.");
  assertEquals(stub.calls, [], "an off host spawns nothing");
  assertEquals(markerLines(logger), []);
});

Deno.test("RTK_OFF - the shared off result is frozen", () => {
  assert(Object.isFrozen(RTK_OFF));
  assertEquals(RTK_OFF.status, "off");
  assertEquals(RTK_OFF.enabled, false);
});

Deno.test("prepareRtkRun - every non-Claude provider is unsupported", async () => {
  for (
    const providerId of [
      CODEX_PROVIDER_ID,
      GEMINI_PROVIDER_ID,
      DEEPSEEK_PROVIDER_ID,
    ]
  ) {
    const logger = recordingLogger();
    const stub = stubRunner([]);
    const run = await prepareRtkRun({
      enabled: true,
      providerId,
      logger,
      run: stub.run,
    });

    assertEquals(run.result.status, "unsupported", providerId);
    assertEquals(run.result.enabled, true, providerId);
    assertEquals(
      run.result.provider,
      providerId,
      "the stats line names the provider that could not take the hook",
    );
    assertEquals(run.hookSettings(), undefined, providerId);
    assertEquals(run.applyPrompt("Prompt."), "Prompt.", providerId);
    assertEquals(stub.calls, [], providerId);
  }
});

Deno.test("prepareRtkRun - an unnamed provider carries no provider field", async () => {
  const logger = recordingLogger();
  const run = await prepareRtkRun({
    enabled: true,
    providerId: "",
    logger,
    run: stubRunner([]).run,
  });

  assertEquals(run.result.status, "unsupported");
  assertEquals(
    run.result.provider,
    undefined,
    "an empty id would render an empty bracket in the stats line",
  );
});

Deno.test("prepareRtkRun - no seam outcome fails the run", async () => {
  const cases: { name: string; replies: (Result<SubprocessResult> | Error)[] }[] =
    [
      { name: "the binary is not installed", replies: [unstartable("No such file or directory (os error 2)")] },
      { name: "the version probe exits non-zero", replies: [exited(1, "", "rtk: unknown flag")] },
      { name: "the version probe times out", replies: [timedOut(RTK_PREFLIGHT_TIMEOUT_MS)] },
      { name: "the seam itself throws", replies: [new Error("spawn refused by the sandbox")] },
      { name: "the gain read exits non-zero", replies: [version(), exited(2, "", "tracking store is locked")] },
      { name: "the gain answer is not JSON", replies: [version(), exited(0, "not json at all")] },
      { name: "the gain answer is a JSON array", replies: [version(), exited(0, "[]")] },
      { name: "the gain answer carries no summary.total_saved", replies: [version(), exited(0, '{"summary":{}}')] },
      { name: "the saved total is negative", replies: [version(), exited(0, '{"summary":{"total_saved":-1}}')] },
    ];

  for (const testCase of cases) {
    const logger = recordingLogger();
    const run = await prepareRtkRun({
      enabled: true,
      providerId: CLAUDE_PROVIDER_ID,
      logger,
      run: stubRunner(testCase.replies).run,
    });

    assertEquals(run.result.status, "failed", testCase.name);
    assertEquals(run.result.enabled, true, testCase.name);
    assertEquals(
      markerLines(logger).length,
      1,
      `exactly one marker line for: ${testCase.name}`,
    );
    assertEquals(run.hookSettings(), undefined, testCase.name);
    assertEquals(run.applyPrompt("Prompt."), "Prompt.", testCase.name);
  }
});

Deno.test("prepareRtkRun - a failed preparation records nothing", async () => {
  const logger = recordingLogger();
  const stub = stubRunner([unstartable("no rtk here")]);
  const run = await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger,
    run: stub.run,
  });
  await run.record();

  assertEquals(run.result.status, "failed");
  assertEquals(run.result.savedTokens, undefined);
  assertEquals(stub.calls.length, 1, "record() re-reads nothing without a baseline");
});

Deno.test("prepareRtkRun - a healthy preflight wires the hook and the prompt", async () => {
  const logger = recordingLogger();
  const stub = healthy(1_000);
  const run = await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger,
    run: stub.run,
  });

  assertEquals(run.result.status, "ok");
  assertEquals(run.result.enabled, true);
  assertEquals(run.result.provider, undefined, "provider is set only when unsupported");
  assertEquals(run.hookSettings(), buildRtkHookSettings());
  assertEquals(run.applyPrompt("Prompt."), `Prompt.\n\n${RTK_PROMPT_LINE}`);
  assertEquals(markerLines(logger), []);

  assertEquals(stub.calls.map((call) => call.executable), ["rtk", "rtk"]);
  assertEquals(stub.calls[0].args, ["--version"]);
  assertEquals(stub.calls[1].args, ["gain", "--all", "--format", "json"]);
  for (const call of stub.calls) {
    assertEquals(
      call.timeoutMs,
      RTK_PREFLIGHT_TIMEOUT_MS,
      "a wedged read must not hang the run",
    );
  }
});

Deno.test("prepareRtkRun - the environment reaches the rtk invocations", async () => {
  const stub = healthy(0);
  const seen: (Record<string, string> | undefined)[] = [];
  const run: RtkRunner = (executable, args, options) => {
    seen.push(options?.env);
    return stub.run(executable, args, options);
  };
  await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger: recordingLogger(),
    run,
    env: { XDG_DATA_HOME: "/state/data" },
  });

  assertEquals(seen, [
    { XDG_DATA_HOME: "/state/data" },
    { XDG_DATA_HOME: "/state/data" },
  ]);
});

Deno.test("prepareRtkRun - record() saves the gain delta", async () => {
  const logger = recordingLogger();
  const stub = healthy(1_000, gain(1_750));
  const run = await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger,
    run: stub.run,
  });
  await run.record();

  assertEquals(run.result.status, "ok");
  assertEquals(run.result.savedTokens, 750);
  assertEquals(markerLines(logger), []);
});

Deno.test("prepareRtkRun - record() clamps a lower after-value at zero", async () => {
  // A sibling container sharing the tracking store can rotate it mid-run.
  const stub = healthy(5_000, gain(400));
  const run = await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger: recordingLogger(),
    run: stub.run,
  });
  await run.record();

  assertEquals(run.result.savedTokens, 0);
});

Deno.test("prepareRtkRun - record() reports an unchanged store as zero", async () => {
  const stub = healthy(1_000, gain(1_000));
  const run = await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger: recordingLogger(),
    run: stub.run,
  });
  await run.record();

  assertEquals(run.result.savedTokens, 0);
});

Deno.test("prepareRtkRun - a failed second read leaves the status ok", async () => {
  for (
    const reply of [
      unstartable("rtk vanished mid-run"),
      exited(2, "", "tracking store is locked"),
      exited(0, "not json"),
    ]
  ) {
    const logger = recordingLogger();
    const stub = healthy(1_000, reply);
    const run = await prepareRtkRun({
      enabled: true,
      providerId: CLAUDE_PROVIDER_ID,
      logger,
      run: stub.run,
    });
    await run.record();

    assertEquals(run.result.status, "ok", "the hook did run");
    assertEquals(run.result.savedTokens, undefined, "no figure beats a wrong one");
    assertEquals(markerLines(logger).length, 1);
  }
});

Deno.test("prepareRtkRun - record() is idempotent across repeated calls", async () => {
  const stub = healthy(1_000, gain(1_400), gain(1_900));
  const run = await prepareRtkRun({
    enabled: true,
    providerId: CLAUDE_PROVIDER_ID,
    logger: recordingLogger(),
    run: stub.run,
  });
  await run.record();
  assertEquals(run.result.savedTokens, 400);
  await run.record();
  assertEquals(run.result.savedTokens, 900, "still measured from the baseline");
});

Deno.test("prepareRtkRun - logs exactly one status line per run", async () => {
  const cases: { replies: (Result<SubprocessResult> | Error)[]; enabled: boolean; providerId: string }[] = [
    { replies: [], enabled: false, providerId: CLAUDE_PROVIDER_ID },
    { replies: [], enabled: true, providerId: CODEX_PROVIDER_ID },
    { replies: [unstartable("no rtk")], enabled: true, providerId: CLAUDE_PROVIDER_ID },
    { replies: [version(), gain(12)], enabled: true, providerId: CLAUDE_PROVIDER_ID },
  ];

  for (const testCase of cases) {
    const logger = recordingLogger();
    await prepareRtkRun({
      enabled: testCase.enabled,
      providerId: testCase.providerId,
      logger,
      run: stubRunner(testCase.replies).run,
    });
    const info = logger.lines.filter((line) => line.level === "info");
    assertEquals(info.length, 1, JSON.stringify(testCase.providerId));
    assertStringIncludes(info[0].message, "RTK output: status=");
  }
});

Deno.test("buildRtkHookSettings - the PreToolUse Bash entry RTK documents", () => {
  assertEquals(buildRtkHookSettings(), {
    hooks: {
      PreToolUse: [
        {
          matcher: RTK_HOOK_MATCHER,
          hooks: [{ type: "command", command: RTK_HOOK_COMMAND }],
        },
      ],
    },
  });
  assertEquals(RTK_HOOK_MATCHER, "Bash");
  assertEquals(RTK_HOOK_COMMAND, "rtk hook claude");
});

Deno.test("RTK_PROMPT_LINE - one line naming the recall escape hatch", () => {
  assertEquals(RTK_PROMPT_LINE.includes("\n"), false);
  assertStringIncludes(RTK_PROMPT_LINE, "rtk recall");
});

Deno.test("mergePreToolUseSettings - both matchers survive the merge", () => {
  const splitGuard = {
    permissions: { deny: ["Bash(rm:*)"] },
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [{ type: "command", command: "deno run split_guard.ts" }],
        },
      ],
      PostToolUse: [{ matcher: "Edit", hooks: [] }],
    },
  };
  const merged = mergePreToolUseSettings(splitGuard, buildRtkHookSettings());

  const hooks = merged.hooks as Record<string, { matcher: string }[]>;
  assertEquals(hooks.PreToolUse.map((entry) => entry.matcher), [
    "Edit|Write",
    RTK_HOOK_MATCHER,
  ]);
  assertEquals(merged.permissions, { deny: ["Bash(rm:*)"] }, "other keys survive");
  assertEquals(hooks.PostToolUse.length, 1, "other hook events survive");
  assertEquals(
    splitGuard.hooks.PreToolUse.length,
    1,
    "the caller's own settings are not mutated",
  );
});

Deno.test("mergePreToolUseSettings - an absent base yields RTK's entry alone", () => {
  assertEquals(
    mergePreToolUseSettings(undefined, buildRtkHookSettings()),
    buildRtkHookSettings(),
  );
});

Deno.test("mergePreToolUseSettings - a base without hooks keeps its own keys", () => {
  const merged = mergePreToolUseSettings(
    { permissions: { deny: [] } },
    buildRtkHookSettings(),
  );

  assertEquals(merged.permissions, { deny: [] });
  assertEquals(merged.hooks, buildRtkHookSettings().hooks);
});

Deno.test("describeRtkRun - names the status and whatever figures there are", () => {
  assertStringIncludes(
    describeRtkRun({ enabled: false, status: "off" }),
    "status=off",
  );
  assertStringIncludes(
    describeRtkRun({ enabled: true, status: "unsupported", provider: "codex" }),
    "provider=codex",
  );
  assertStringIncludes(
    describeRtkRun({ enabled: true, status: "ok", savedTokens: 1_234 }),
    "savedTokens=1234",
  );
  const plain = describeRtkRun({ enabled: true, status: "ok" });
  assertEquals(plain.includes("savedTokens"), false);
  assertStringIncludes(plain, "#2382");
});
