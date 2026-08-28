/**
 * Tests for honest timeout messages and extension telemetry (Issue #4298,
 * part of #4290).
 *
 * Once a run can outlive its configured budget (#4296), every operator-facing
 * signal that hard-codes "1 hour" lies. The contract these tests pin:
 *
 * - a run granted N extensions reports `extensions.granted === N`, the total
 *   extended seconds and the final deadline on its result;
 * - `watchdogLateSeconds` is measured against the **final** deadline, so it is
 *   `0` for an on-time kill after extensions and non-zero only when the timer
 *   genuinely fired past it. A deliberately-wrong baseline (lateness measured
 *   against the original `timeoutSeconds`) fails this case, which is what
 *   proves the test discriminates;
 * - the kill log and the issue-facing failure text both name the extension
 *   count, the total elapsed and the stalled signal;
 * - with the feature disabled every message is byte-identical to today's.
 *
 * The agent is a stub script on PATH and the tree probe is injected, so no
 * test needs a git repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import {
  buildExtensionTelemetry,
  buildTimeoutFailureReason,
  buildTimeoutKillMessage,
  type ExtensionTelemetry,
} from "../lib/timeout_extension_telemetry.ts";
import { buildDiagnosticContext } from "../lib/execute_claude_phase.ts";
import { formatZeroOutputDiagnostics } from "../lib/failure_diagnosis.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

/** A stub agent on PATH plus the temp dir holding it. */
interface StubAgent {
  restore: () => Promise<void>;
}

/**
 * Install a stub `claude` on PATH, re-execed into its own session so the
 * watchdog's process-group kill lands on the stub alone.
 */
async function installStub(body: string): Promise<StubAgent> {
  const dir = await Deno.makeTempDir({ prefix: "timeout_telemetry_4298_" });
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(
    `${dir}/claude.impl`,
    `#!/usr/bin/env bash\n${body}`,
  );
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `impl="$(dirname "$0")/claude.impl"\n` +
      // No silent fallback: without setsid the stub would share this process's
      // group, and the watchdog's group kill would land on the test runner
      // (Issue #471). Fail loud instead of running unisolated.
      `if ! command -v setsid >/dev/null 2>&1; then\n` +
      `  echo "setsid is required to isolate the stub agent" >&2; exit 127\n` +
      `fi\n` +
      `exec setsid bash "$impl"\n`,
  );
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  return {
    restore: async () => {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    },
  };
}

/** A stub that emits a tool call every `gapSeconds` for `count` iterations. */
function chattyStub(count: number, gapSeconds: string): string {
  return `for i in $(seq 1 ${count}); do\n` +
    `  printf '%s\\n' '${TOOL_LINE}'\n` +
    `  sleep ${gapSeconds}\n` +
    `done\n` +
    `printf '%s\\n' '{"type":"result","result":"done"}'\n`;
}

/** Collect log lines so the kill message can be asserted on. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  } as unknown as Logger;
  return { logger, lines };
}

/** A probe that replays a scripted verdict sequence. */
function scriptedProbe(verdicts: TreeProgressState[]) {
  let calls = 0;
  return {
    count: () => calls,
    probe: (): Promise<TreeProgressState> => {
      const verdict = verdicts[calls] ?? verdicts.at(-1) ?? "unknown";
      calls++;
      return Promise.resolve(verdict);
    },
  };
}

// ---------------------------------------------------------------------------
// Runner telemetry
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithTimeout - a run granted N extensions reports N, the extended seconds and the final deadline (Issue #4298)",
  fn: async () => {
    // Two grants, then the tree stops moving — the third check kills.
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger } = recordingLogger();
    const { probe } = scriptedProbe(["advanced", "advanced", "unchanged"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      const ext = result.value.extensions;
      assert(ext, "an active run must carry extension telemetry");
      assertEquals(ext.granted, 2, "two grants were made");
      assertEquals(ext.baseTimeoutSeconds, 1);
      // Two 1 s grants from a 1 s budget: the final deadline lands ~3 s in.
      // Only the lower bound is asserted — a loaded VM may check late, which
      // pushes the deadline further out but never pulls it back.
      assert(
        ext.finalDeadlineSeconds >= 2,
        `final deadline ${ext.finalDeadlineSeconds}s must reflect both grants`,
      );
      assertEquals(
        ext.extendedSeconds,
        ext.finalDeadlineSeconds - ext.baseTimeoutSeconds,
        "extended seconds must be the surplus over the base budget",
      );
      assert(
        (ext.refusalReason ?? "").includes("working tree unchanged"),
        `the stalled signal must be named: ${ext.refusalReason}`,
      );
    } finally {
      await stub.restore();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - watchdogLateSeconds stays 0 for an on-time kill after extensions (Issues #4254, #4298)",
  fn: async () => {
    // One 4 s grant on a 1 s budget: the kill lands ~5 s in, on time against
    // the final deadline. A deliberately-wrong baseline that measured
    // lateness against the original 1 s `timeoutSeconds` would report ~4 s of
    // bogus lateness here, firing #4254's starved-timer detector on every
    // extended run. The tolerance below is well clear of both figures.
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger } = recordingLogger();
    const { probe } = scriptedProbe(["advanced", "unchanged"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 4, activityStallSeconds: 60 },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      const ext = result.value.extensions;
      assert(ext, "an active run must carry extension telemetry");
      assert(ext.granted >= 1, "the run must actually have been extended");
      // Absent (or 0) means "not late" — the field is omitted when zero.
      const late = result.value.watchdogLateSeconds ?? 0;
      assert(
        late <= 2,
        `lateness must be measured against the final deadline, got ${late}s ` +
          `after ${ext.granted} extension(s) totalling ${ext.extendedSeconds}s`,
      );
    } finally {
      await stub.restore();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - the kill log names the extension count, the elapsed time and the stalled signal (Issue #4298)",
  fn: async () => {
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    const { probe } = scriptedProbe(["advanced", "unchanged"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
        },
      });
      assert(result.ok, "the runner must return a result");

      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, `a kill line must be logged, got: ${JSON.stringify(lines)}`);
      assertStringIncludes(kill, "extended 1×");
      assertStringIncludes(kill, "base budget 1s");
      assertStringIncludes(kill, "last extension refused:");
      assertStringIncludes(kill, "working tree unchanged");
      assertStringIncludes(kill, "killing process tree");
    } finally {
      await stub.restore();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - with the feature disabled the kill log is byte-identical to the legacy line (Issue #4298)",
  fn: async () => {
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
      });
      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.extensions,
        undefined,
        "no telemetry may be produced without the feature",
      );

      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, "a kill line must be logged");
      // The legacy wording, with only the #4254 late suffix permitted after it.
      const legacy =
        /^Claude timed out after 1s — killing process tree \(PID \d+\)/;
      assert(
        legacy.test(kill),
        `the disabled path must keep today's wording, got: ${kill}`,
      );
      assert(
        !kill.includes("extended"),
        `no extension wording may appear: ${kill}`,
      );
    } finally {
      await stub.restore();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a policy present but disabled produces no telemetry and the legacy line (Issue #4298)",
  fn: async () => {
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    const { probe, count } = scriptedProbe(["advanced"]);
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: {
            enabled: false,
            grantSeconds: 60,
            activityStallSeconds: 60,
          },
          treeProbe: probe,
        },
      });
      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(
        result.value.extensions,
        undefined,
        "a disabled policy must produce no telemetry",
      );
      assert(count() <= 1, "a disabled policy asks the probe at most once");
      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, "a kill line must be logged");
      assert(
        !kill.includes("extended"),
        `the disabled policy must keep today's wording: ${kill}`,
      );
    } finally {
      await stub.restore();
    }
  },
});

// ---------------------------------------------------------------------------
// Message builders (pure)
// ---------------------------------------------------------------------------

/** Telemetry standing in for a four-extension run of a 3600 s budget. */
function extendedRun(): ExtensionTelemetry {
  return buildExtensionTelemetry({
    baseTimeoutSeconds: 3600,
    startMs: 1_000_000,
    deadlineMs: 1_000_000 + 5_640_000,
    nowMs: 1_000_000 + 5_640_000,
    granted: 4,
    refusalReason: "working tree unchanged despite tool activity 31s ago",
  });
}

Deno.test("buildExtensionTelemetry - derives the surplus over the base budget (Issue #4298)", () => {
  const t = extendedRun();
  assertEquals(t.granted, 4);
  assertEquals(t.baseTimeoutSeconds, 3600);
  assertEquals(t.finalDeadlineSeconds, 5640);
  assertEquals(t.extendedSeconds, 2040);
  assertEquals(t.elapsedSeconds, 5640);
});

Deno.test("buildExtensionTelemetry - a kill before the deadline never reports negative surplus (Issue #4298)", () => {
  const t = buildExtensionTelemetry({
    baseTimeoutSeconds: 3600,
    startMs: 0,
    deadlineMs: 1_800_000,
    nowMs: 900_000,
    granted: 0,
  });
  assertEquals(t.extendedSeconds, 0);
  assertEquals(t.elapsedSeconds, 900);
  assertEquals(t.refusalReason, undefined);
});

Deno.test("buildTimeoutKillMessage - names the extensions, the elapsed time and the stalled signal (Issue #4298)", () => {
  const message = buildTimeoutKillMessage({
    pid: 4242,
    budgetSeconds: 5640,
    extensions: extendedRun(),
  });
  assertStringIncludes(message, "Claude timed out after 5640s");
  assertStringIncludes(message, "base budget 3600s extended 4× by 2040s");
  assertStringIncludes(message, "final deadline 5640s");
  assertStringIncludes(
    message,
    "last extension refused: working tree unchanged despite tool activity 31s ago",
  );
  assertStringIncludes(message, "killing process tree (PID 4242)");
});

Deno.test("buildTimeoutKillMessage - without telemetry the legacy line is byte-identical (Issue #4298)", () => {
  assertEquals(
    buildTimeoutKillMessage({ pid: 99, budgetSeconds: 3600 }),
    "Claude timed out after 3600s — killing process tree (PID 99)",
  );
});

Deno.test("buildTimeoutFailureReason - the issue-facing text carries the extension history (Issue #4298)", () => {
  const reason = buildTimeoutFailureReason(3600, extendedRun());
  assertStringIncludes(reason, "timed out after 5640 seconds (94 minutes)");
  assertStringIncludes(reason, "extended 4× by 2040s");
  assertStringIncludes(reason, "working tree unchanged");
  assert(
    !reason.includes("timed out after 3600 seconds"),
    `the false configured-budget claim must be gone: ${reason}`,
  );
});

Deno.test("buildTimeoutFailureReason - without telemetry the legacy text is byte-identical (Issue #4298)", () => {
  assertEquals(
    buildTimeoutFailureReason(3600),
    "timed out after 3600 seconds (60 minutes)",
  );
});

Deno.test("buildTimeoutFailureReason - a refused first check still names the stall (Issue #4298)", () => {
  const reason = buildTimeoutFailureReason(
    3600,
    buildExtensionTelemetry({
      baseTimeoutSeconds: 3600,
      startMs: 0,
      deadlineMs: 3_600_000,
      nowMs: 3_601_000,
      granted: 0,
      refusalReason: "no tool activity recorded",
    }),
  );
  assertStringIncludes(reason, "base budget 3600s, no extension granted");
  assertStringIncludes(
    reason,
    "last extension refused: no tool activity recorded",
  );
});

// ---------------------------------------------------------------------------
// Diagnostic context round-trip
// ---------------------------------------------------------------------------

Deno.test("buildDiagnosticContext - carries the extension history through to the diagnosis (Issue #4298)", () => {
  const context = buildDiagnosticContext({
    clarityStatus: "assessed_clear",
    elapsedSeconds: 5640,
    claudeNoOutputTimeout: 600,
    claudeTimeout: 3600,
    extensions: extendedRun(),
  });
  assertStringIncludes(context, "extensions_granted=4");
  assertStringIncludes(context, "extended_seconds=2040");
  assertStringIncludes(context, "final_deadline_seconds=5640");

  const rendered = formatZeroOutputDiagnostics(context);
  assertStringIncludes(rendered, "extended 4× by 2040s");
  assertStringIncludes(rendered, "final deadline of 5640s");
  assertStringIncludes(rendered, "working tree unchanged");
});

Deno.test("buildDiagnosticContext - a reason carrying separators cannot corrupt the encoding (Issue #4298)", () => {
  const context = buildDiagnosticContext({
    clarityStatus: "skipped",
    elapsedSeconds: 100,
    claudeNoOutputTimeout: 600,
    claudeTimeout: 3600,
    extensions: buildExtensionTelemetry({
      baseTimeoutSeconds: 3600,
      startMs: 0,
      deadlineMs: 3_600_000,
      nowMs: 100_000,
      granted: 0,
      refusalReason: "probe failed; claude_timeout=1 injected",
    }),
  });
  // Exactly the fields the builder emits — the reason contributes no extras.
  const keys = context.split(";").map((p) => p.split("=")[0]);
  assertEquals(
    keys,
    [
      "health_check",
      "clarity",
      "elapsed_seconds",
      "no_output_timeout",
      "claude_timeout",
      "extensions_granted",
      "extended_seconds",
      "final_deadline_seconds",
      "extension_refused",
    ],
  );
  assertStringIncludes(context, "claude_timeout=3600");
});

Deno.test("buildDiagnosticContext - without telemetry the legacy string is byte-identical (Issue #4298)", () => {
  assertEquals(
    buildDiagnosticContext({
      clarityStatus: "assessed_clear",
      elapsedSeconds: 3600,
      claudeNoOutputTimeout: 600,
      claudeTimeout: 3600,
    }),
    "health_check=passed;clarity=assessed_clear;elapsed_seconds=3600;" +
      "no_output_timeout=600;claude_timeout=3600",
  );
});
