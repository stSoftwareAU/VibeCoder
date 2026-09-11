/**
 * The CI-fix scanner honours fleet-authored deferrals (Issue #1881, parent
 * #1861).
 *
 * `findFailedCiChecks` must leave a failing check alone while a
 * `vibe-ci-fix-deferred` marker the fleet wrote names an issue that is still
 * open — on every host, since the record is the pull request's own comments
 * — and must return it again the moment that issue closes. Every degraded
 * read (comments unreadable, blocker state unreadable, marker from outside
 * the fleet, malformed reference) leaves the check undeferred and is logged:
 * the scan never goes quiet on an error.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import {
  buildCiFixDeferralMarker,
  CI_FIX_DEFERRAL_MARKER_NAME,
} from "../lib/ci_fix_attempt_markers.ts";
import {
  findOpenDeferrals,
  parseBlockerRef,
} from "../lib/ci_fix_pr_markers.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A logger that records what the scan reported. */
interface RecordingLogger extends Logger {
  errors: string[];
  skips: string[];
}

function makeRecordingLogger(): RecordingLogger {
  const noop = () => {};
  const errors: string[] = [];
  const skips: string[] = [];
  return {
    errors,
    skips,
    info: noop,
    warn: noop,
    error: (message: string) => {
      errors.push(message);
    },
    debug: noop,
    security: noop,
    skipReason: (code: string, details: string) => {
      skips.push(`${code}: ${details}`);
    },
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

const FLEET_LOGIN = "testbot";
const SIGNATURE = "a1b2c3d4e5f6";

/** One REST comment row, as `repos/…/issues/…/comments` returns it. */
function commentRow(
  id: number,
  author: string,
  body: string,
): Record<string, unknown> {
  return {
    id,
    body,
    created_at: "2026-09-10T08:00:00Z",
    user: { login: author },
  };
}

/** A deferral comment for `checkName`, blocked on `dependsOn`. */
function deferralComment(
  id: number,
  author: string,
  checkName: string,
  dependsOn: string,
): Record<string, unknown> {
  return commentRow(
    id,
    author,
    `No change required for ${checkName} — the base branch is red.\n\n` +
      `Depends on ${dependsOn}\n\n` +
      buildCiFixDeferralMarker({ signature: SIGNATURE, checkName, dependsOn }),
  );
}

interface StubOptions {
  /** Failed check runs on the single PR's head. */
  checks: Array<{ id: number; name: string }>;
  /** The PR's comment rows, or `"error"` to make the fetch fail. */
  comments: Record<string, unknown>[] | "error";
  /** State each blocker reads as (`"error"` makes the read fail). */
  blockers?: Record<string, "OPEN" | "CLOSED" | "error">;
}

/** Every `gh` call the scan made, joined for assertions. */
type Calls = string[];

/**
 * A `gh` stub for one PR (#7 on `org/repo`, head `issue-1-fix`, base
 * `main`) that answers the PR list, its check runs, its comments and the
 * blocker state reads, recording every call.
 */
function makeGh(
  options: StubOptions,
  calls: Calls,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: 7, headRefName: "issue-1-fix", baseRefName: "main" },
      ]));
    }
    if (key.includes("check-runs") && !key.includes("annotations")) {
      return Promise.resolve(JSON.stringify(
        options.checks.map((check) => ({
          ...check,
          status: "completed",
          conclusion: "failure",
        })),
      ));
    }
    if (key.includes("annotations")) return Promise.resolve("[]");
    if (key.includes("/issues/7/comments")) {
      if (options.comments === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(JSON.stringify(options.comments));
    }
    if (args[0] === "issue" && args[1] === "view") {
      const number = args[2] ?? "";
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
      const state = options.blockers?.[`${repo}#${number}`] ?? "OPEN";
      if (state === "error") {
        return Promise.reject(new Error("HTTP 500: Internal Server Error"));
      }
      return Promise.resolve(JSON.stringify({
        number: Number(number),
        state,
        title: "Base branch is red",
      }));
    }
    return Promise.resolve("[]");
  };
}

/** Run the scan against a throwaway retry-state directory. */
async function scan(
  options: StubOptions,
  logger: RecordingLogger,
  calls: Calls = [],
  overrides: Partial<CiCheckScanOptions> = {},
) {
  const stateDir = await Deno.makeTempDir({ prefix: "ci-deferral-1881-" });
  try {
    const scanOptions: CiCheckScanOptions = {
      githubUser: FLEET_LOGIN,
      repos: ["org/repo"],
      logger,
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: makeGh(options, calls),
      stateDir,
      ...overrides,
    };
    return await findFailedCiChecks(scanOptions);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

const TWO_CHECKS = [
  { id: 1, name: "Project Validation" },
  { id: 2, name: "lint" },
];

// ---------------------------------------------------------------------------
// findFailedCiChecks
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a check deferred on an open issue is not returned; a differently named failure on the same PR is (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const result = await scan({
    checks: TWO_CHECKS,
    comments: [
      deferralComment(10, FLEET_LOGIN, "Project Validation", "org/repo#149"),
    ],
    blockers: { "org/repo#149": "OPEN" },
  }, logger);

  assert(result.ok);
  assertEquals(result.value?.checkName, "lint");
  assertEquals(logger.skips.length, 1);
  assertStringIncludes(logger.skips[0] ?? "", "ci-fix-deferred");
  assertStringIncludes(logger.skips[0] ?? "", "Project Validation");
  assertStringIncludes(logger.skips[0] ?? "", "org/repo#149");
  assertEquals(logger.errors, []);
});

Deno.test("findFailedCiChecks - a deferred check whose only sibling is also deferred yields nothing, and a second host sees the same (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const result = await scan({
    checks: [{ id: 1, name: "Project Validation" }],
    comments: [
      deferralComment(10, FLEET_LOGIN, "Project Validation", "org/repo#149"),
    ],
    blockers: { "org/repo#149": "OPEN" },
  }, logger);

  assert(result.ok);
  assertEquals(result.value, null);
  assertEquals(logger.skips.length, 1);
});

Deno.test("findFailedCiChecks - once the named issue closes the check is returned again (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const result = await scan({
    checks: TWO_CHECKS,
    comments: [
      deferralComment(10, FLEET_LOGIN, "Project Validation", "org/repo#149"),
    ],
    blockers: { "org/repo#149": "CLOSED" },
  }, logger);

  assert(result.ok);
  assertEquals(result.value?.checkName, "Project Validation");
  assertEquals(logger.skips, []);
  assertEquals(logger.errors, []);
});

Deno.test("findFailedCiChecks - a cross-repository blocker is read with --repo (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const calls: Calls = [];
  const result = await scan(
    {
      checks: TWO_CHECKS,
      comments: [
        deferralComment(10, FLEET_LOGIN, "Project Validation", "other/core#7"),
      ],
      blockers: { "other/core#7": "OPEN" },
    },
    logger,
    calls,
  );

  assert(result.ok);
  assertEquals(result.value?.checkName, "lint");
  const stateRead = calls.find((call) => call.startsWith("issue view 7 "));
  assert(stateRead !== undefined, "the blocker's state was read");
  assertStringIncludes(stateRead, "--repo other/core");
});

Deno.test("findFailedCiChecks - a deferral marker authored outside the fleet is ignored (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const result = await scan({
    checks: TWO_CHECKS,
    comments: [
      deferralComment(10, "randomuser", "Project Validation", "org/repo#149"),
    ],
    blockers: { "org/repo#149": "OPEN" },
  }, logger);

  assert(result.ok);
  assertEquals(result.value?.checkName, "Project Validation");
  assertEquals(logger.skips, []);
});

Deno.test("findFailedCiChecks - a comment fetch error leaves the check undeferred and is logged (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const result = await scan({
    checks: TWO_CHECKS,
    comments: "error",
  }, logger);

  assert(result.ok);
  assertEquals(result.value?.checkName, "Project Validation");
  assertEquals(logger.skips, []);
  assertEquals(logger.errors.length, 1);
  assertStringIncludes(logger.errors[0] ?? "", "Issue #1881");
});

Deno.test("findFailedCiChecks - an unreadable blocker state leaves the check undeferred and is logged (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const result = await scan({
    checks: TWO_CHECKS,
    comments: [
      deferralComment(10, FLEET_LOGIN, "Project Validation", "org/repo#149"),
    ],
    blockers: { "org/repo#149": "error" },
  }, logger);

  assert(result.ok);
  assertEquals(result.value?.checkName, "Project Validation");
  assertEquals(logger.skips, []);
  assertEquals(logger.errors.length, 1);
  assertStringIncludes(logger.errors[0] ?? "", "Issue #1881");
});

Deno.test("findFailedCiChecks - a PR with no failing checks reads no comments (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const calls: Calls = [];
  const result = await scan({ checks: [], comments: "error" }, logger, calls);

  assert(result.ok);
  assertEquals(result.value, null);
  assert(
    calls.every((call) => !call.includes("/issues/7/comments")),
    "no comment fetch for a green PR",
  );
  assertEquals(logger.errors, []);
});

// ---------------------------------------------------------------------------
// findOpenDeferrals / parseBlockerRef
// ---------------------------------------------------------------------------

Deno.test("findOpenDeferrals - one state read per distinct blocker, one entry per check (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const calls: Calls = [];
  const gh = makeGh({
    checks: [],
    comments: [
      deferralComment(10, FLEET_LOGIN, "Project Validation", "org/repo#149"),
      deferralComment(11, FLEET_LOGIN, "Project Validation", "org/repo#149"),
      deferralComment(12, FLEET_LOGIN, "docs", "org/repo#149"),
    ],
    blockers: { "org/repo#149": "OPEN" },
  }, calls);

  const open = await findOpenDeferrals({
    repo: "org/repo",
    prNumber: 7,
    ghCommandFn: gh,
    fleetLogins: [FLEET_LOGIN],
    logger,
  });

  assertEquals(open.map((d) => d.checkName), ["Project Validation", "docs"]);
  assertEquals(open[0]?.dependsOn, "org/repo#149");
  assertEquals(open[0]?.signature, SIGNATURE);
  assertEquals(
    calls.filter((call) => call.startsWith("issue view ")).length,
    1,
  );
});

Deno.test("findOpenDeferrals - an empty fleet login set attributes nothing and defers nothing (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const gh = makeGh({
    checks: [],
    comments: [
      deferralComment(10, FLEET_LOGIN, "Project Validation", "org/repo#149"),
    ],
  }, []);

  const open = await findOpenDeferrals({
    repo: "org/repo",
    prNumber: 7,
    ghCommandFn: gh,
    fleetLogins: [],
    logger,
  });

  assertEquals(open, []);
});

Deno.test("findOpenDeferrals - a comment without a marker is not a deferral (Issue #1881)", async () => {
  const logger = makeRecordingLogger();
  const gh = makeGh({
    checks: [],
    comments: [
      commentRow(
        10,
        FLEET_LOGIN,
        `Mentions ${CI_FIX_DEFERRAL_MARKER_NAME} in prose only.`,
      ),
    ],
  }, []);

  const open = await findOpenDeferrals({
    repo: "org/repo",
    prNumber: 7,
    ghCommandFn: gh,
    fleetLogins: [FLEET_LOGIN],
    logger,
  });

  assertEquals(open, []);
});

Deno.test("parseBlockerRef - splits owner/repo#N and refuses anything else (Issue #1881)", () => {
  assertEquals(parseBlockerRef("org/repo#149"), {
    repo: "org/repo",
    number: 149,
  });
  assertEquals(parseBlockerRef("other/core#7"), {
    repo: "other/core",
    number: 7,
  });
  assertEquals(parseBlockerRef("#149"), null);
  assertEquals(parseBlockerRef("org/repo#0"), null);
  assertEquals(parseBlockerRef("org/repo#abc"), null);
  assertEquals(parseBlockerRef("org/repo"), null);
  assertEquals(parseBlockerRef("repo#149"), null);
  assertEquals(parseBlockerRef("a/b/c#149"), null);
});
