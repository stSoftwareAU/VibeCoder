/**
 * Regression tests for `routeIdleTaskInProcessIssue` (Issue #2118).
 *
 * The main worker loop's production `processIssue` previously called
 * `workOnIssue` directly without the claim-handler step that the
 * `work-on-issue` CLI uses. Every idle-task wrapper claimed by the
 * main loop tripped the orchestrator's `idle_task_guard` and was
 * refused with `phase: 'idle_task_guard'`, never running the template.
 *
 * These tests pin the wiring shape:
 *   1. Wrappers (claim handler returns `handled: true`) are closed via
 *      `gh issue close --comment <summary>` and the routing reports
 *      `{ routed: true, success }` with the handler's `ok` flag.
 *   2. Non-wrappers (claim handler returns `handled: false`) report
 *      `{ routed: false }` and are NEVER closed — the caller falls
 *      through to the standard pipeline.
 *   3. A `gh` close failure is logged and swallowed — the worker
 *      cannot crash on a stuck issue.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { routeIdleTaskInProcessIssue } from "../lib/idle_task_process_issue_route.ts";
import type { HandleIdleTaskIssueResult } from "../lib/idle_task_claim_handler.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogRecord {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  context?: unknown;
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

const WRAPPER_INPUT = {
  repo: "owner/widget",
  issueNumber: 2726,
  issueTitle: "Run a security scan",
  issueLabels: ["idle-task"],
  issueBody: "# MythOS-style Security Audit — Four-Phase Scan (v5)\n\n" +
    "Audit `owner/widget` for vulnerabilities...",
  workDir: "/tmp/widget",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "routeIdleTaskInProcessIssue - wrapper routes, closes issue, returns routed:true",
  async () => {
    const { logger, records } = makeLogger();
    const ghCalls: string[][] = [];

    const handlerResult: HandleIdleTaskIssueResult = {
      handled: true,
      ok: true,
      summary: "security-scan complete: filed 3 findings",
    };

    const outcome = await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      handleIdleTaskFn: () => Promise.resolve(handlerResult),
      ghCommandFn: (args) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    });

    assertEquals(outcome, { routed: true, success: true });

    // Exactly one gh call — closing the wrapper with the summary.
    assertEquals(ghCalls.length, 1);
    const closeArgs = ghCalls[0]!;
    assertEquals(closeArgs[0], "issue");
    assertEquals(closeArgs[1], "close");
    assertEquals(closeArgs[2], "2726");
    assertEquals(closeArgs[3], "--repo");
    assertEquals(closeArgs[4], "owner/widget");
    assertEquals(closeArgs[5], "--comment");
    assertEquals(closeArgs[6], "security-scan complete: filed 3 findings");

    // No warnings — the close succeeded cleanly.
    assertEquals(records.filter((r) => r.level === "warn").length, 0);
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - failed template run still reports routed:true with success=false",
  async () => {
    const { logger } = makeLogger();
    const ghCalls: string[][] = [];

    const outcome = await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      handleIdleTaskFn: () =>
        Promise.resolve({
          handled: true,
          ok: false,
          summary: "security-scan threw: timeout",
        }),
      ghCommandFn: (args) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    });

    assertEquals(outcome, { routed: true, success: false });
    // The wrapper is still closed (with the failure summary) so the
    // queue is not blocked.
    assertEquals(ghCalls.length, 1);
    assertEquals(ghCalls[0]?.[6], "security-scan threw: timeout");
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - non-wrapper passes through with routed:false",
  async () => {
    const { logger } = makeLogger();
    const ghCalls: string[][] = [];

    const outcome = await routeIdleTaskInProcessIssue(
      {
        repo: "owner/widget",
        issueNumber: 42,
        issueTitle: "Fix the date parser to handle ISO-8601 inputs",
        issueLabels: ["bug"],
        issueBody: "The parser drops the timezone offset.",
        workDir: "/tmp/widget",
      },
      {
        logger,
        handleIdleTaskFn: () => Promise.resolve({ handled: false }),
        ghCommandFn: (args) => {
          ghCalls.push(args);
          return Promise.resolve("");
        },
      },
    );

    assertEquals(outcome, { routed: false });
    // Non-wrappers must NEVER be auto-closed by this helper — that
    // would skip the entire issue pipeline.
    assertEquals(ghCalls.length, 0);
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - gh close failure is logged and swallowed",
  async () => {
    const { logger, records } = makeLogger();

    const outcome = await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      handleIdleTaskFn: () =>
        Promise.resolve({ handled: true, ok: true, summary: "ran" }),
      ghCommandFn: () => Promise.reject(new Error("gh: rate limited")),
    });

    // The route still reports success — the run completed, only the
    // close call failed.
    assertEquals(outcome, { routed: true, success: true });

    const warn = records.find((r) => r.level === "warn");
    assert(warn !== undefined, "expected a warn log for the failed close");
    assertEquals(warn.message, "Failed to close idle-task issue");
    const ctx = warn.context as Record<string, unknown>;
    assertEquals(ctx.repo, "owner/widget");
    assertEquals(ctx.issueNumber, 2726);
    assertStringIncludes(String(ctx.error), "rate limited");
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - default summary is used when handler omits it",
  async () => {
    const { logger } = makeLogger();
    const ghCalls: string[][] = [];

    await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      handleIdleTaskFn: () => Promise.resolve({ handled: true, ok: true }),
      ghCommandFn: (args) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    });

    assertEquals(ghCalls[0]?.[6], "idle-task processed");
  },
);
