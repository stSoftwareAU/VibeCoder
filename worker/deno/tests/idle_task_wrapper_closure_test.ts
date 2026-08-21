/**
 * Tests for `finaliseIdleTaskWrapper` (Issue #179).
 *
 * Only a scan that actually ran closes its wrapper. A failed run comments the
 * failure and leaves the wrapper open so the failure cooldown applies and a
 * later claim retries it.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIdleTaskFailureComment,
  finaliseIdleTaskWrapper,
  IDLE_TASK_FAILURE_COMMENT_PREFIX,
} from "../lib/idle_task_wrapper_closure.ts";
import type { LogContext, Logger } from "../types.ts";

interface LogRecord {
  level: string;
  message: string;
  context?: LogContext;
}

function makeLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger: Logger = {
    info: (m, c) => records.push({ level: "info", message: m, context: c }),
    warn: (m, c) => records.push({ level: "warn", message: m, context: c }),
    error: (m, c) => records.push({ level: "error", message: m, context: c }),
    debug: (m, c) => records.push({ level: "debug", message: m, context: c }),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, records };
}

Deno.test(
  "finaliseIdleTaskWrapper - a successful run closes the wrapper with its summary",
  async () => {
    const { logger, records } = makeLogger();
    const ghCalls: string[][] = [];

    const result = await finaliseIdleTaskWrapper(
      {
        repo: "acme/widget",
        issueNumber: 18,
        ok: true,
        summary: "security-scan complete: filed 3 findings",
      },
      {
        logger,
        ghCommandFn: (args) => {
          ghCalls.push(args);
          return Promise.resolve("");
        },
      },
    );

    assertEquals(result, { closed: true, commented: false });
    assertEquals(ghCalls, [[
      "issue",
      "close",
      "18",
      "--repo",
      "acme/widget",
      "--comment",
      "security-scan complete: filed 3 findings",
    ]]);
    assertEquals(records.filter((r) => r.level === "warn").length, 0);
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - a failed run comments and never closes",
  async () => {
    const { logger } = makeLogger();
    const ghCalls: string[][] = [];

    const result = await finaliseIdleTaskWrapper(
      {
        repo: "stSoftwareAU/NEAT-AI-Forests",
        issueNumber: 18,
        ok: false,
        summary:
          "bash-script-refs scan failed (walk): failed to read directory " +
          "/home/vibe/auto-issue-work/NEAT-AI-Forests: No such file or directory",
      },
      {
        logger,
        ghCommandFn: (args) => {
          ghCalls.push(args);
          return Promise.resolve("");
        },
      },
    );

    assertEquals(result, { closed: false, commented: true });
    assertEquals(ghCalls.length, 1);
    const args = ghCalls[0]!;
    assertEquals(args[0], "issue");
    assertEquals(args[1], "comment");
    assertEquals(args[2], "18");
    assertEquals(args[3], "--repo");
    assertEquals(args[4], "stSoftwareAU/NEAT-AI-Forests");
    assertEquals(args[5], "--body");
    assertStringIncludes(String(args[6]), IDLE_TASK_FAILURE_COMMENT_PREFIX);
    assertStringIncludes(String(args[6]), "No such file or directory");
    // No `close` anywhere in the call.
    assert(!args.includes("close"));
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - gh failure is logged and swallowed",
  async () => {
    const { logger, records } = makeLogger();

    const result = await finaliseIdleTaskWrapper(
      { repo: "acme/widget", issueNumber: 7, ok: false, summary: "boom" },
      {
        logger,
        ghCommandFn: () => Promise.reject(new Error("gh: rate limited")),
      },
    );

    assertEquals(result, { closed: false, commented: true });
    const warn = records.find((r) => r.level === "warn");
    assert(warn !== undefined, "expected a warn log for the failed comment");
    assertEquals(warn.message, "Failed to comment on failed idle-task issue");
    assertStringIncludes(String(warn.context?.error), "rate limited");
  },
);

Deno.test("buildIdleTaskFailureComment - keeps the summary verbatim", () => {
  const comment = buildIdleTaskFailureComment("detector crashed: EACCES");
  assertStringIncludes(comment, IDLE_TASK_FAILURE_COMMENT_PREFIX);
  assertStringIncludes(comment, "detector crashed: EACCES");
});
