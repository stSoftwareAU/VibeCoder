/**
 * Tests for `finaliseIdleTaskWrapper` (Issues #179, #1753).
 *
 * Only a scan that actually ran closes its wrapper. A failed run comments the
 * failure and leaves the wrapper open so the failure cooldown applies and a
 * later claim retries it.
 *
 * Issue #1753: both writes are REST `gh api` calls on the core quota, so they
 * land while the primary GraphQL quota latch refuses every `gh issue …`
 * subcommand — and the result reports whether they landed, not the verdict.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIdleTaskFailureComment,
  finaliseIdleTaskWrapper,
  IDLE_TASK_FAILURE_COMMENT_PREFIX,
  idleTaskWrapperCloseArgs,
  idleTaskWrapperCommentArgs,
} from "../lib/idle_task_wrapper_closure.ts";
import { isQuotaExemptGhCall } from "../lib/primary_quota_latch.ts";
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

/** The message the spawn chokepoint throws for a latched GraphQL call. */
const QUOTA_SKIP =
  "gh command skipped: GraphQL primary quota exhausted (API rate limit " +
  "already exceeded) — at 2026-09-09 23:49:53 AEST (in 23m 49s)";

/**
 * A `gh` runner behaving as the chokepoint does under the primary-quota
 * latch: every GraphQL-backed subcommand is refused with the quota-skip
 * message, a REST `gh api <path>` call goes through on the core quota.
 */
function latchedGhRunner(
  ghCalls: string[][],
): (args: string[]) => Promise<string> {
  return (args) => {
    if (!isQuotaExemptGhCall(args)) {
      return Promise.reject(new Error(QUOTA_SKIP));
    }
    ghCalls.push(args);
    return Promise.resolve("{}");
  };
}

Deno.test(
  "finaliseIdleTaskWrapper - a successful run posts its summary then closes the wrapper via REST",
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
    assertEquals(ghCalls, [
      [
        "api",
        "-X",
        "POST",
        "repos/acme/widget/issues/18/comments",
        "-f",
        "body=security-scan complete: filed 3 findings",
      ],
      [
        "api",
        "-X",
        "PATCH",
        "repos/acme/widget/issues/18",
        "-f",
        "state=closed",
      ],
    ]);
    assertEquals(records.filter((r) => r.level === "warn").length, 0);
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - both REST calls are exempt from the primary-quota latch (Issue #1753)",
  () => {
    // The whole point of the REST form: `isQuotaExemptGhCall` is the
    // predicate the chokepoint applies, so this is the contract the fix
    // rests on rather than an assumption about argv shape.
    assert(isQuotaExemptGhCall(idleTaskWrapperCommentArgs("o/r", 4, "hi")));
    assert(isQuotaExemptGhCall(idleTaskWrapperCloseArgs("o/r", 4)));
    // …and the subcommands they replace are not.
    assert(
      !isQuotaExemptGhCall(["issue", "close", "4", "--repo", "o/r"]),
    );
    assert(
      !isQuotaExemptGhCall(["issue", "comment", "4", "--repo", "o/r"]),
    );
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - with the primary-quota latch set, a successful run still closes its wrapper (Issue #1753)",
  async () => {
    const { logger, records } = makeLogger();
    const ghCalls: string[][] = [];

    const result = await finaliseIdleTaskWrapper(
      {
        repo: "stSoftwareAU/GRQ-health",
        issueNumber: 204,
        ok: true,
        summary: "health scan complete: no findings",
      },
      { logger, ghCommandFn: latchedGhRunner(ghCalls) },
    );

    assertEquals(result, { closed: true, commented: false });
    assertEquals(ghCalls.length, 2);
    assertEquals(
      ghCalls[0]![3],
      "repos/stSoftwareAU/GRQ-health/issues/204/comments",
    );
    assertEquals(ghCalls[1]![3], "repos/stSoftwareAU/GRQ-health/issues/204");
    assertEquals(ghCalls[1]![5], "state=closed");
    assertEquals(records.filter((r) => r.level === "warn").length, 0);
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - with the primary-quota latch set, a failed run still posts its failure comment (Issue #1753)",
  async () => {
    const { logger, records } = makeLogger();
    const ghCalls: string[][] = [];

    const result = await finaliseIdleTaskWrapper(
      {
        repo: "stSoftwareAU/GRQ-health",
        issueNumber: 204,
        ok: false,
        summary: "detector crashed: EACCES",
      },
      { logger, ghCommandFn: latchedGhRunner(ghCalls) },
    );

    assertEquals(result, { closed: false, commented: true });
    assertEquals(ghCalls.length, 1);
    assertEquals(ghCalls[0]![2], "POST");
    assertEquals(
      ghCalls[0]![3],
      "repos/stSoftwareAU/GRQ-health/issues/204/comments",
    );
    assertStringIncludes(
      String(ghCalls[0]![5]),
      IDLE_TASK_FAILURE_COMMENT_PREFIX,
    );
    assertEquals(records.filter((r) => r.level === "warn").length, 0);
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - a close that did not land reports closed:false and names the reason (Issue #1753)",
  async () => {
    const { logger, records } = makeLogger();

    const result = await finaliseIdleTaskWrapper(
      { repo: "acme/widget", issueNumber: 7, ok: true, summary: "ran" },
      {
        logger,
        // Everything refused — a `gh` outage, or a runner that has not
        // learnt the REST exemption.
        ghCommandFn: () => Promise.reject(new Error(QUOTA_SKIP)),
      },
    );

    // The old code returned `closed: true` here — a close that never
    // happened, reported as done.
    assertEquals(result.closed, false);
    assertEquals(result.commented, false);
    assertStringIncludes(String(result.error), "close: gh command skipped");
    assertStringIncludes(
      String(result.error),
      "summary comment: gh command skipped",
    );

    const warns = records.filter((r) => r.level === "warn");
    assertEquals(warns.map((w) => w.message), [
      "Failed to post idle-task summary comment",
      "Failed to close idle-task issue",
    ]);
    const closeWarn = warns[1]!.context as Record<string, unknown>;
    assertEquals(closeWarn.repo, "acme/widget");
    assertEquals(closeWarn.issueNumber, 7);
    assertEquals(closeWarn.wrapperStillOpen, true);
    assertStringIncludes(
      String(closeWarn.error),
      "GraphQL primary quota exhausted",
    );
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - a refused summary comment does not skip the close",
  async () => {
    const { logger } = makeLogger();
    const ghCalls: string[][] = [];

    const result = await finaliseIdleTaskWrapper(
      { repo: "acme/widget", issueNumber: 7, ok: true, summary: "ran" },
      {
        logger,
        ghCommandFn: (args) => {
          ghCalls.push(args);
          return args[2] === "POST"
            ? Promise.reject(new Error("HTTP 502"))
            : Promise.resolve("{}");
        },
      },
    );

    // An open wrapper costs a second full scan; a missing summary costs a
    // line of context. The close is attempted regardless.
    assertEquals(result.closed, true);
    assertEquals(result.commented, false);
    assertStringIncludes(String(result.error), "summary comment: HTTP 502");
    assertEquals(ghCalls.length, 2);
    assertEquals(ghCalls[1]![2], "PATCH");
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
    assertEquals(args.slice(0, 4), [
      "api",
      "-X",
      "POST",
      "repos/stSoftwareAU/NEAT-AI-Forests/issues/18/comments",
    ]);
    assertEquals(args[4], "-f");
    assertStringIncludes(
      String(args[5]),
      "body=" + IDLE_TASK_FAILURE_COMMENT_PREFIX,
    );
    assertStringIncludes(String(args[5]), "No such file or directory");
    // No close anywhere in the call: no PATCH, no `state=`.
    assert(!args.includes("PATCH"));
    assert(!args.some((a) => a.startsWith("state=")));
  },
);

Deno.test(
  "finaliseIdleTaskWrapper - a failure comment that did not land is logged, swallowed and reported",
  async () => {
    const { logger, records } = makeLogger();

    const result = await finaliseIdleTaskWrapper(
      { repo: "acme/widget", issueNumber: 7, ok: false, summary: "boom" },
      {
        logger,
        ghCommandFn: () => Promise.reject(new Error("gh: rate limited")),
      },
    );

    assertEquals(result, {
      closed: false,
      commented: false,
      error: "gh: rate limited",
    });
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
