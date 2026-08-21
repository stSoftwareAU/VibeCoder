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
 *   1. Wrappers whose scan SUCCEEDED (claim handler returns
 *      `handled: true, ok: true`) are closed via
 *      `gh issue close --comment <summary>` and the routing reports
 *      `{ routed: true, success: true }`.
 *   2. Non-wrappers (claim handler returns `handled: false`) report
 *      `{ routed: false }` and are NEVER closed — the caller falls
 *      through to the standard pipeline.
 *   3. A `gh` close failure is logged and swallowed — the worker
 *      cannot crash on a stuck issue.
 *
 * Issue #179 adds two more:
 *   4. A wrapper whose scan FAILED is commented on, never closed, so the
 *      failure cooldown applies and a later claim retries it.
 *   5. A recognised wrapper ensures the repo's local clone before the
 *      template runs; a clone that cannot be made fails loud (comment,
 *      wrapper left open, `success: false`) and never runs the template.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { routeIdleTaskInProcessIssue } from "../lib/idle_task_process_issue_route.ts";
import type { HandleIdleTaskIssueResult } from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_FAILURE_COMMENT_PREFIX } from "../lib/idle_task_wrapper_closure.ts";
import type { IdleTaskTemplate } from "../lib/idle_task_template.ts";
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

/**
 * Clone stub reporting "already cloned" — the state every pre-#179 test
 * implicitly assumed. Tests that exercise the clone path override it.
 */
const okClone = () =>
  Promise.resolve({
    ok: true,
    repoPath: "/tmp/widget/widget",
    cloned: false,
  });

/** Minimal registered-template stand-in for the clone-path tests. */
function fakeTemplate(name: string): IdleTaskTemplate {
  return {
    name,
    description: `Test template ${name}`,
    buildIssueTitle: () => "Run a security scan",
    buildIssueBody: () => "body",
    runTask: () => Promise.resolve({ ok: true, summary: "ran" }),
  };
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
      ensureCloneFn: okClone,
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
  "routeIdleTaskInProcessIssue - failed template run comments and leaves the wrapper open",
  async () => {
    // Behaviour change (Issue #179): this test previously asserted the
    // wrapper was CLOSED with the failure summary. Closing a wrapper whose
    // scan never ran discarded the work — the NEAT-AI-Forests#18/#19
    // incident. A failed run now comments and leaves the wrapper open so
    // the failure cooldown applies and a later claim retries the scan.
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
      ensureCloneFn: okClone,
      ghCommandFn: (args) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    });

    assertEquals(outcome, { routed: true, success: false });
    assertEquals(ghCalls.length, 1);
    const args = ghCalls[0]!;
    assertEquals(args[1], "comment");
    assert(
      !args.includes("close"),
      "a failed scan must never close its wrapper",
    );
    assertStringIncludes(String(args[6]), IDLE_TASK_FAILURE_COMMENT_PREFIX);
    assertStringIncludes(String(args[6]), "security-scan threw: timeout");
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
        ensureCloneFn: okClone,
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
      ensureCloneFn: okClone,
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
      ensureCloneFn: okClone,
      ghCommandFn: (args) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    });

    assertEquals(ghCalls[0]?.[6], "idle-task processed");
  },
);

// ---------------------------------------------------------------------------
// Clone preparation (Issue #179)
// ---------------------------------------------------------------------------

Deno.test(
  "routeIdleTaskInProcessIssue - clones a recognised wrapper's repo before running the template",
  async () => {
    // NEAT-AI-Forests regression: the repo was added to `.config.json` and
    // its wrappers raised, but nothing had cloned it — every scan died with
    // ENOENT on `${workDir}/<repo>`.
    const { logger } = makeLogger();
    const cloneCalls: Array<[string, string]> = [];
    let handlerWorkDir: string | undefined;

    const outcome = await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      findTemplateFn: () => fakeTemplate("security-scan"),
      ensureCloneFn: (repo, workDir) => {
        cloneCalls.push([repo, workDir]);
        return Promise.resolve({
          ok: true,
          repoPath: `${workDir}/widget`,
          cloned: true,
        });
      },
      handleIdleTaskFn: (opts) => {
        handlerWorkDir = opts.workDir;
        return Promise.resolve({
          handled: true,
          ok: true,
          summary: "security-scan complete: no findings",
        });
      },
      ghCommandFn: () => Promise.resolve(""),
    });

    assertEquals(cloneCalls, [["owner/widget", "/tmp/widget"]]);
    assertEquals(handlerWorkDir, "/tmp/widget");
    assertEquals(outcome, { routed: true, success: true });
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - a clone failure never runs the template and never closes the wrapper",
  async () => {
    const { logger, records } = makeLogger();
    const ghCalls: string[][] = [];
    let handlerCalled = false;

    const outcome = await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      findTemplateFn: () => fakeTemplate("security-scan"),
      ensureCloneFn: (_repo, workDir) =>
        Promise.resolve({
          ok: false,
          repoPath: `${workDir}/widget`,
          cloned: false,
          message: "Failed to clone owner/widget: network unreachable",
        }),
      handleIdleTaskFn: () => {
        handlerCalled = true;
        return Promise.resolve({ handled: true, ok: true, summary: "ran" });
      },
      ghCommandFn: (args) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    });

    assertEquals(handlerCalled, false);
    assertEquals(outcome, { routed: true, success: false });
    assertEquals(ghCalls.length, 1);
    assertEquals(ghCalls[0]?.[1], "comment");
    assertStringIncludes(String(ghCalls[0]?.[6]), "network unreachable");
    assert(
      records.some((r) =>
        r.level === "warn" && r.message === "idle-task clone preparation failed"
      ),
      "expected a loud warning for the failed clone",
    );
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - a non-wrapper never triggers a clone",
  async () => {
    const { logger } = makeLogger();
    let cloneCalled = false;

    const outcome = await routeIdleTaskInProcessIssue(
      {
        repo: "owner/widget",
        issueNumber: 42,
        issueTitle: "Fix the date parser",
        issueLabels: ["bug"],
        issueBody: "The parser drops the timezone offset.",
        workDir: "/tmp/widget",
      },
      {
        logger,
        findTemplateFn: () => undefined,
        ensureCloneFn: () => {
          cloneCalled = true;
          return okClone();
        },
        handleIdleTaskFn: () => Promise.resolve({ handled: false }),
        ghCommandFn: () => Promise.resolve(""),
      },
    );

    assertEquals(cloneCalled, false);
    assertEquals(outcome, { routed: false });
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - forwards the cycle deadline to the claim handler",
  async () => {
    // Issue #186: without this the scan's Claude budget never sees the
    // deadline and a late claim runs a full hour past the cycle.
    const { logger } = makeLogger();
    let seenDeadline: number | undefined;
    const deadline = 1_700_000_000_000;

    await routeIdleTaskInProcessIssue(
      { ...WRAPPER_INPUT, cycleDeadlineEpochMs: deadline },
      {
        logger,
        handleIdleTaskFn: (opts) => {
          seenDeadline = opts.cycleDeadlineEpochMs;
          return Promise.resolve({ handled: true, ok: true, summary: "ran" });
        },
        ensureCloneFn: okClone,
        ghCommandFn: () => Promise.resolve(""),
      },
    );

    assertEquals(seenDeadline, deadline);
  },
);

Deno.test(
  "routeIdleTaskInProcessIssue - omits the deadline when the caller has none",
  async () => {
    const { logger } = makeLogger();
    let sawKey = true;

    await routeIdleTaskInProcessIssue(WRAPPER_INPUT, {
      logger,
      handleIdleTaskFn: (opts) => {
        sawKey = "cycleDeadlineEpochMs" in opts;
        return Promise.resolve({ handled: true, ok: true, summary: "ran" });
      },
      ensureCloneFn: okClone,
      ghCommandFn: () => Promise.resolve(""),
    });

    assertEquals(sawKey, false);
  },
);
