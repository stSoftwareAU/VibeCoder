/**
 * A red default branch is repaired once, not once per sync PR (Issue #5437).
 *
 * When `main` is red, every `sync/milestone-*` PR inherits the failure. These
 * tests drive the real `findFailedCiChecks` against a `gh` stub that answers
 * by argument, and prove that:
 * - the inherited failure is held, not handed to the CI-fix agent;
 * - exactly one repair PR is opened against the default branch, or an open
 *   one is adopted, and its status is edited only when the marker differs;
 * - a held sync head behind the tip is fast-forwarded, and only that;
 * - a sync failure the default branch does not share still gets its fix;
 * - a green human fix PR is adopted only when its head contains the default
 *   branch's tip, so a stale branch cannot pass for the fix;
 * - a human fix PR whose CI is still running, with no held check failed, is
 *   waited on rather than duplicated; a fleet or bot PR or a stale run is not;
 * - an undecidable ancestry stands the sync PR down for the scan;
 * - a non-sync PR is held only when the tip and its merge base are both red
 *   on the check, so a check its own base lacks is never inherited;
 * - the status is one fleet comment, edited in place when the held set moves;
 * - the repair PR's own failure is returned ahead of other default-branch
 *   failures.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type CiCheckScanOptions,
  fetchCheckRunStates,
  findFailedCiChecks,
  RUNNING_FIX_WAIT_MS,
} from "../lib/pr_maintenance.ts";
import {
  bodyCarriesRedDefaultBranchMarker,
  findGreenFixPr,
  fixCandidateNamesHeldFailure,
  formatRedDefaultBranchStatus,
  formatWithdrawnFixStatus,
  postRedDefaultBranchStatusComment,
  RED_DEFAULT_BRANCH_REPAIR_PREFIX,
  redDefaultBranchMarker,
} from "../lib/red_default_branch_repair.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const DEFAULT_BRANCH = "main"; // allow-hardcoded-branch — the default under test
/** The default branch's tip: red on `gitleaks` in the red-main cases. */
const TIP = "a1".repeat(20);
/** A commit an earlier sync merge left behind. */
const OLD_HEAD = "b2".repeat(20);
/** A commit only a sync lane has. */
const SYNC_ONLY_HEAD = "c3".repeat(20);
const TREE = "d4".repeat(20);
const NEW_COMMIT = "e5".repeat(20);
const CREATED_PR = 77;
const REPAIR_BRANCH = `${RED_DEFAULT_BRANCH_REPAIR_PREFIX}abc`;

interface PrFixture {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  body?: string;
}

interface Fixture {
  /** The PRs the open-PR listing returns. */
  prs: PrFixture[];
  /** The default branch's tip. */
  tip: string;
  /** Failed check runs keyed by the ref (branch name or commit SHA) read. */
  checks: Record<string, Array<{ id: number; name: string }>>;
  /** The compare status of each head against the default branch. */
  compare: Record<string, string | "error">;
  /**
   * The merge base of each head with the default branch, read through
   * `compare/...` with `--jq .merge_base_commit.sha`. `error` fails the read.
   */
  mergeBase?: Record<string, string | "error">;
  /** Refs whose check-runs read fails with a `gh` error. */
  checkReadErrors?: string[];
  /** The message `gh pr create` fails with, when set. */
  prCreateError?: string;
  /** The message a ref PATCH fails with, when set. */
  patchError?: string;
  /** Open PRs against the default branch, as `gh pr list --base` returns them. */
  fixPrs?: Array<{
    number: number;
    headRefName: string;
    headRefOid: string;
    author: { login: string };
    title: string;
    body: string;
  }>;
  /** The message the `--base` PR listing fails with, when set. */
  fixListError?: string;
  /**
   * Open repair PRs the direct `--search head:` lookup returns, which the
   * scan's own listing may not carry (Issue #5437).
   */
  openRepairPrs?: Array<{ number: number; headRefName: string; body?: string }>;
  /** The message the repair-PR lookup fails with, when set. */
  repairListError?: string;
  /** Names of the checks that succeeded, keyed by the ref read. */
  greenChecks?: Record<string, string[]>;
  /**
   * Comments per PR number, oldest first, as `{id, login, body}` objects (the
   * shape the scan's `--jq` emits).
   */
  comments?: Record<number, Array<{ id: number; login: string; body: string }>>;
  /** The message the comment list read fails with, when set. */
  commentReadError?: string;
  /** The message a PR comment post fails with, when set. */
  commentPostError?: string;
  /** The message a PR edit fails with, when set. */
  editError?: string;
  /** The message the tip's tree read fails with, when set. */
  treeError?: string;
  /** The message the empty commit's create fails with, when set. */
  commitError?: string;
  /** The message the branch ref's create fails with, when set. */
  refError?: string;
  /** The message the `merges` POST fails with, when set. */
  mergeError?: string;
  /**
   * Files each repair branch changes against the default branch, read through
   * `compare/...` with `--jq '.files | length'`; absent is 0 (the empty
   * repair commit). `error` fails the read.
   */
  repairFiles?: Record<string, number | "error">;
  /** Names of the check runs still running, keyed by the ref read. */
  pendingChecks?: Record<string, string[]>;
  /**
   * The check runs of each ref with their status, conclusion and start time,
   * as the fix search's states read sees them (Issue #5437).
   */
  checkRunStates?: Record<string, CheckRunStateFixture[]>;
  /** Refs whose check-run states read fails with a `gh` error (Issue #5437). */
  checkRunStateReadErrors?: string[];
}

/** One check run in a {@link Fixture.checkRunStates} answer (Issue #5437). */
interface CheckRunStateFixture {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
}

/** A recording logger, so the scan's warnings and skips can be asserted. */
interface RecordingLogger extends Logger {
  warns: string[];
  skips: string[];
  infos: string[];
}

function makeLogger(): RecordingLogger {
  const noop = () => {};
  const warns: string[] = [];
  const skips: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    skips,
    infos,
    info: (message: string) => void infos.push(message),
    warn: (message: string) => void warns.push(message),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: (code: string, details: string) =>
      void skips.push(`${code}: ${details}`),
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** A sync PR on `branch`, head `headRefOid`, targeting the default branch. */
function syncPr(
  number: number,
  branch: string,
  headRefOid: string,
): PrFixture {
  return {
    number,
    headRefName: branch,
    headRefOid,
    baseRefName: DEFAULT_BRANCH,
  };
}

/**
 * A `gh` stub that answers the scan from `fx` by argument and records every
 * call. It answers the PR list, the default-branch tip and tree, the repair
 * PR's commit, ref and PR creation, the head comparisons, and the check runs
 * for any ref; anything else answers empty.
 */
function ghStub(
  fx: Fixture,
  calls: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      // The repair-PR lookup is the only listing that searches by head.
      if (args.includes("--search")) {
        if (fx.repairListError !== undefined) {
          return Promise.reject(new Error(fx.repairListError));
        }
        return Promise.resolve(JSON.stringify(fx.openRepairPrs ?? []));
      }
      // The fix search names its base branch.
      if (args.includes("--base")) {
        if (fx.fixListError !== undefined) {
          return Promise.reject(new Error(fx.fixListError));
        }
        return Promise.resolve(JSON.stringify(fx.fixPrs ?? []));
      }
      return Promise.resolve(JSON.stringify(fx.prs));
    }
    if (args[0] === "pr" && args[1] === "create") {
      if (fx.prCreateError !== undefined) {
        return Promise.reject(new Error(fx.prCreateError));
      }
      return Promise.resolve(`https://github.com/${REPO}/pull/${CREATED_PR}\n`);
    }
    if (args[0] === "pr" && args[1] === "edit") {
      if (fx.editError !== undefined) {
        return Promise.reject(new Error(fx.editError));
      }
      return Promise.resolve("");
    }
    if (args[0] === "pr" && args[1] === "comment") {
      if (fx.commentPostError !== undefined) {
        return Promise.reject(new Error(fx.commentPostError));
      }
      return Promise.resolve("");
    }
    if (args[1] === `repos/${REPO}/commits/${DEFAULT_BRANCH}`) {
      return Promise.resolve(`${fx.tip}\n`);
    }
    if (args[1] === `repos/${REPO}/git/commits/${fx.tip}`) {
      if (fx.treeError !== undefined) {
        return Promise.reject(new Error(fx.treeError));
      }
      return Promise.resolve(`${TREE}\n`);
    }
    if (args.includes("POST") && args[3] === `repos/${REPO}/git/commits`) {
      if (fx.commitError !== undefined) {
        return Promise.reject(new Error(fx.commitError));
      }
      return Promise.resolve(`${NEW_COMMIT}\n`);
    }
    if (args.includes("POST") && args[3] === `repos/${REPO}/git/refs`) {
      if (fx.refError !== undefined) {
        return Promise.reject(new Error(fx.refError));
      }
      return Promise.resolve("{}");
    }
    if (args.includes("POST") && args[3] === `repos/${REPO}/merges`) {
      if (fx.mergeError !== undefined) {
        return Promise.reject(new Error(fx.mergeError));
      }
      return Promise.resolve("{}");
    }
    const commentsOf = /^repos\/org\/repo\/issues\/(\d+)\/comments$/.exec(
      args[1] ?? "",
    );
    if (args[0] === "api" && commentsOf !== null) {
      if (fx.commentReadError !== undefined) {
        return Promise.reject(new Error(fx.commentReadError));
      }
      const listed = fx.comments?.[Number(commentsOf[1])] ?? [];
      return Promise.resolve(
        listed.map((comment) => JSON.stringify(comment)).join("\n"),
      );
    }
    if (args.includes("PATCH")) {
      if (fx.patchError !== undefined) {
        return Promise.reject(new Error(fx.patchError));
      }
      return Promise.resolve("{}");
    }
    if (args.includes(".merge_base_commit.sha")) {
      const sha = (args[1] ?? "").split("...")[1] ?? "";
      const base = fx.mergeBase?.[sha];
      if (base === undefined || base === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(`${base}\n`);
    }
    if (args.includes(".files | length")) {
      const ref = (args[1] ?? "").split("...")[1] ?? "";
      const files = fx.repairFiles?.[ref] ?? 0;
      if (files === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(`${files}\n`);
    }
    const compare = args.find((arg) => arg.includes("/compare/"));
    if (compare !== undefined) {
      const sha = compare.split("...")[1] ?? "";
      const status = fx.compare[sha];
      if (status === undefined || status === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(`${status}\n`);
    }
    const run = /commits\/(.+)\/check-runs/.exec(key);
    if (run !== null) {
      if (fx.checkReadErrors?.includes(run[1] ?? "")) {
        return Promise.reject(new Error("HTTP 500: Internal Server Error"));
      }
      // The fix search's states read names `started_at` (Issue #5437).
      if (args.some((arg) => arg.includes("started_at"))) {
        if (fx.checkRunStateReadErrors?.includes(run[1] ?? "")) {
          return Promise.reject(new Error("HTTP 504: Gateway Timeout"));
        }
        return Promise.resolve(
          JSON.stringify(fx.checkRunStates?.[run[1] ?? ""] ?? []),
        );
      }
      // The repair PR's running-check read selects incomplete check runs.
      if (args.some((arg) => arg.includes('"completed"'))) {
        return Promise.resolve(
          JSON.stringify(fx.pendingChecks?.[run[1] ?? ""] ?? []),
        );
      }
      // The strict reader for passing checks selects `success` conclusions.
      if (args.some((arg) => arg.includes('"success"'))) {
        const passing = fx.greenChecks?.[run[1] ?? ""] ?? [];
        return Promise.resolve(JSON.stringify(
          passing.map((name, index) => ({
            id: index + 1,
            name,
            status: "completed",
            conclusion: "success",
          })),
        ));
      }
      const checks = fx.checks[run[1] ?? ""] ?? [];
      return Promise.resolve(JSON.stringify(
        checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: "completed",
          conclusion: "failure",
        })),
      ));
    }
    return Promise.resolve("[]");
  };
}

/** Run the real scan over `fx`, recording gh calls and logs. */
async function scan(fx: Fixture) {
  const calls: string[][] = [];
  const logger = makeLogger();
  const stateDir = await Deno.makeTempDir({ prefix: "red-default-5437-" });
  try {
    const options: CiCheckScanOptions = {
      githubUser: "testbot",
      repos: [REPO],
      logger,
      isRepoAllowed: () => true,
      isAuthorisedCommenter: () => true,
      ghCommandFn: ghStub(fx, calls),
      stateDir,
    };
    const result = await findFailedCiChecks(options);
    assert(result.ok);
    return { value: result.value, calls, logger };
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
}

/** The `gh` calls whose first two arguments are `first` and `second`. */
function callsTo(calls: string[][], first: string, second?: string) {
  return calls.filter((args) =>
    args[0] === first && (second === undefined || args[1] === second)
  );
}

/** The value that follows `flag` in a `gh` call, or `undefined`. */
function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * The red-main fixture: the default branch's tip is red on `gitleaks` unless
 * `extra.checks` says otherwise, and the tip compares `identical` to itself.
 */
function redMainFixture(
  prs: PrFixture[],
  extra: Partial<Omit<Fixture, "prs" | "tip">> = {},
): Fixture {
  return {
    ...extra,
    prs,
    tip: TIP,
    checks: { [TIP]: [{ id: 1, name: "gitleaks" }], ...extra.checks },
    compare: { [TIP]: "identical", ...extra.compare },
    openRepairPrs: extra.openRepairPrs,
    repairListError: extra.repairListError,
  };
}

/** Every `gh pr create` call. */
function prCreateCalls(calls: string[][]) {
  return callsTo(calls, "pr", "create");
}

const THREE_SYNC_PRS = [
  syncPr(1, "sync/milestone-a", TIP),
  syncPr(2, "sync/milestone-b", TIP),
  syncPr(3, "sync/milestone-c", TIP),
];

const THREE_SYNC_CHECKS = {
  "sync/milestone-a": [{ id: 11, name: "gitleaks" }],
  "sync/milestone-b": [{ id: 12, name: "gitleaks" }],
  "sync/milestone-c": [{ id: 13, name: "gitleaks" }],
};

// ---------------------------------------------------------------------------
// Red main: one repair, no sync target
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - red main with three identical sync PRs hands none to the CI-fix agent and opens one repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  assertEquals(argAfter(creates[0] ?? [], "--base"), DEFAULT_BRANCH);
  assertEquals(
    argAfter(creates[0] ?? [], "--head"),
    `${RED_DEFAULT_BRANCH_REPAIR_PREFIX}${TIP.slice(0, 12)}`,
  );
  // The heads already sit on the tip, so no sync branch is moved.
  assertEquals(
    callsTo(calls, "api").filter((args) =>
      args.includes("PATCH") && args[3]?.includes("git/refs/heads/sync/")
    ).length,
    0,
  );
  assertEquals(logger.skips.length, 3);
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a fleet PR's failure is still returned while its sync PRs are held (Issue #5437)", async () => {
  const fx = redMainFixture(
    [...THREE_SYNC_PRS, {
      number: 9,
      headRefName: "issue-9-fix",
      headRefOid: SYNC_ONLY_HEAD,
      baseRefName: DEFAULT_BRANCH,
    }],
    {
      checks: {
        ...THREE_SYNC_CHECKS,
        "issue-9-fix": [{ id: 99, name: "lint" }],
      },
      compare: {},
    },
  );
  const { value, calls } = await scan(fx);

  assertEquals(value?.prNumber, 9);
  assertEquals(value?.checkName, "lint");
  assertEquals(prCreateCalls(calls).length, 1);
});

// ---------------------------------------------------------------------------
// Adopting an open repair PR
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - an open repair PR is adopted, not duplicated, and its status is edited once when the marker differs (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
    body: redDefaultBranchMarker(OLD_HEAD, [1, 2]),
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
  });
  const { value, calls } = await scan(fx);

  // Issue #5437: the adopted repair PR is not red on gitleaks itself, so
  // the lowest held sync PR's failing check run is handed over on it.
  assertEquals(value?.prNumber, 20);
  assertEquals(prCreateCalls(calls).length, 0);
  const edits = callsTo(calls, "pr", "edit");
  assertEquals(edits.length, 1);
  assertEquals(edits[0]?.[2], "20");
  assertEquals(argAfter(edits[0] ?? [], "--repo"), REPO);
  const body = argAfter(edits[0] ?? [], "--body") ?? "";
  assertStringIncludes(body, redDefaultBranchMarker(TIP, [1, 2, 3]));
  assertStringIncludes(body, "fix in #20");
});

Deno.test("findFailedCiChecks - an adopted repair PR whose marker is already current is not edited (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
    body: formatRedDefaultBranchStatus({
      defaultBranch: DEFAULT_BRANCH,
      heldPrNumbers: [1, 2, 3],
      repairPrNumber: 20,
      checkNames: ["gitleaks"],
      tipSha: TIP,
    }),
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
  });
  const { value, calls } = await scan(fx);

  // Issue #5437: the adopted repair PR is not red on gitleaks itself, so
  // the lowest held sync PR's failing check run is handed over on it.
  assertEquals(value?.prNumber, 20);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "edit").length, 0);
});

Deno.test("findFailedCiChecks - an adopted repair PR that does not reproduce the tip's gitleaks failure is handed the held sync PR's failing check run (Issue #5437)", async () => {
  // gitleaks on a pull request scans only base..head, so an empty repair
  // commit on the red tip passes it while the tip and the sync PRs stay red.
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
  });
  const { value, calls, logger } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(value?.prNumber, 20);
  assertEquals(value?.branchName, REPAIR_BRANCH);
  assertEquals(value?.checkName, "gitleaks");
  assertEquals(value?.checkId, "11");
  assertEquals(value?.baseRef, DEFAULT_BRANCH);
  assert(
    logger.infos.some((line) =>
      line.includes("does not reproduce gitleaks") && line.includes("#1's")
    ),
  );
});

Deno.test("findFailedCiChecks - a repair PR that already carries a pushed fix and is green is not handed the held failure, and nothing reports a human (Issue #5437)", async () => {
  // The CI-fix agent pushed a fix to the repair branch: it now changes files
  // against main and its CI is green, while the tip and the sync PRs stay red
  // until it merges.
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: NEW_COMMIT,
    baseRefName: DEFAULT_BRANCH,
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
    greenChecks: { [REPAIR_BRANCH]: ["gitleaks"] },
    repairFiles: { [REPAIR_BRANCH]: 2 },
  });
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assert(
    logger.infos.some((line) => line.includes("#20 already changes 2 file(s)")),
  );
  assertEquals(
    logger.skips.filter((line) =>
      line.startsWith("red-default-branch-repair-needs-human")
    ),
    [],
  );
  assertEquals(
    logger.warns.filter((line) => line.includes("needs a human")),
    [],
  );
});

Deno.test("findFailedCiChecks - a repair PR whose held check is still running is not handed the held failure this scan (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
    pendingChecks: { [REPAIR_BRANCH]: ["gitleaks"] },
  });
  const { value, logger } = await scan(fx);

  assertEquals(value, null);
  assert(
    logger.infos.some((line) => line.includes("#20 is still running gitleaks")),
  );
});

Deno.test("findFailedCiChecks - an unreadable repair-branch compare hands nothing over and warns with the gh error (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
    repairFiles: { [REPAIR_BRANCH]: "error" },
  });
  const { value, logger } = await scan(fx);

  assertEquals(value, null);
  assert(
    logger.warns.some((line) =>
      line.includes("could not read whether repair PR") &&
      line.includes("HTTP 502: Bad Gateway")
    ),
  );
});

Deno.test("findFailedCiChecks - an adopted repair PR red on the held check itself is handed its own failure, not the sync PR's (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: {
      ...THREE_SYNC_CHECKS,
      [REPAIR_BRANCH]: [{ id: 99, name: "gitleaks" }],
    },
  });
  const { value } = await scan(fx);

  assertEquals(value?.prNumber, 20);
  assertEquals(value?.checkId, "99");
});

Deno.test("findFailedCiChecks - a newly opened repair PR is left to its own CI: no hand-over in the scan that opens it (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  const { value, calls } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(value, null);
});

Deno.test("findFailedCiChecks - a needs-human repair PR missing from the scan's listing is found by the direct lookup, so no second repair PR is opened (Issue #5437)", async () => {
  // listActionablePrs drops needs-human PRs and a stall-repair scan is scoped
  // to one PR, so the open repair PR is absent from fx.prs.
  const fx = redMainFixture(THREE_SYNC_PRS, {
    checks: THREE_SYNC_CHECKS,
    openRepairPrs: [{ number: 20, headRefName: REPAIR_BRANCH, body: "" }],
  });
  const { value, calls } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 0);
  const lookups = callsTo(calls, "pr", "list").filter((args) =>
    args.includes("--search")
  );
  assertEquals(lookups.length, 1);
  assertEquals(
    argAfter(lookups[0] ?? [], "--search"),
    "head:fix/red-default-branch-",
  );
  assertEquals(value?.prNumber, 20);
});

Deno.test("findFailedCiChecks - an unreadable repair-PR lookup opens no repair PR and warns with the gh error (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, {
    checks: THREE_SYNC_CHECKS,
    repairListError: "HTTP 502: Bad Gateway",
  });
  const { value, calls, logger } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(value, null);
  assert(
    logger.warns.some((line) =>
      line.includes("could not look up an open repair PR") &&
      line.includes("HTTP 502: Bad Gateway")
    ),
  );
});

// ---------------------------------------------------------------------------
// Refresh: fast-forward a stale held sync head
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a held sync head behind the tip is fast-forwarded to it, fast-forward only (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(4, "sync/milestone-d", OLD_HEAD)],
    {
      // The repair has landed: the tip is green and the old head is behind.
      checks: {
        "sync/milestone-d": [{ id: 14, name: "gitleaks" }],
        [TIP]: [],
      },
      compare: { [OLD_HEAD]: "behind" },
    },
  );
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  const patches = calls.filter((args) =>
    args[0] === "api" && args.includes("PATCH")
  );
  assertEquals(patches.length, 1);
  const patch = patches[0] ?? [];
  assertEquals(
    patch[3],
    `repos/${REPO}/git/refs/heads/sync/milestone-d`,
  );
  assertEquals(argAfter(patch, "-f"), `sha=${TIP}`);
  assertStringIncludes(patch.join(" "), "force=false");
  // The tip is not red, so no repair PR is raised for a green default branch.
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 1);
});

// ---------------------------------------------------------------------------
// Off the default branch: only inherited failures are held
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - an ahead sync PR's check the tip does not share still reaches the CI-fix agent (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(5, "sync/milestone-e", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-e": [{ id: 15, name: "lint" }],
        [TIP]: [],
      },
      compare: { [SYNC_ONLY_HEAD]: "ahead" },
    },
  );
  const { value, calls } = await scan(fx);

  assertEquals(value?.prNumber, 5);
  assertEquals(value?.branchName, "sync/milestone-e");
  assertEquals(value?.checkName, "lint");
  assertEquals(prCreateCalls(calls).length, 0);
});

Deno.test("findFailedCiChecks - an ahead sync PR's check that the tip also has is held for the repair (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(5, "sync/milestone-e", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-e": [{ id: 15, name: "lint" }],
        [TIP]: [{ id: 1, name: "lint" }],
      },
      compare: { [SYNC_ONLY_HEAD]: "ahead" },
    },
  );
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(logger.skips.length, 1);
  assertStringIncludes(logger.skips[0] ?? "", "inherited-red-default-branch");
  assertStringIncludes(logger.skips[0] ?? "", "held");
});

// ---------------------------------------------------------------------------
// Undecidable ancestry: stand down
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a sync PR whose ancestry cannot be read gets no CI-fix target and no repair PR this scan (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(6, "sync/milestone-f", SYNC_ONLY_HEAD)],
    {
      checks: { "sync/milestone-f": [{ id: 16, name: "gitleaks" }] },
      compare: { [SYNC_ONLY_HEAD]: "error" },
    },
  );
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.warns.length, 1);
  assertStringIncludes(logger.warns[0] ?? "", "cannot tell");
  assertStringIncludes(logger.warns[0] ?? "", "sync");
  // The warning quotes the gh error that made the ancestry unknown.
  assertStringIncludes(logger.warns[0] ?? "", "HTTP 502: Bad Gateway");
});

Deno.test("findFailedCiChecks - an off-default sync PR stands down when the default tip's check runs cannot be read, and opens no repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(7, "sync/milestone-g", SYNC_ONLY_HEAD)],
    {
      checks: { "sync/milestone-g": [{ id: 17, name: "lint" }] },
      compare: { [SYNC_ONLY_HEAD]: "ahead" },
    },
  );
  fx.checkReadErrors = [TIP];
  const { value, calls, logger } = await scan(fx);

  // Unreadable is not green: the sync PR is not handed to the CI-fix agent.
  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 0);
  assert(logger.warns.some((w) => w.includes("HTTP 500")));
  assert(logger.warns.some((w) => w.includes("cannot read the checks red")));
});

// ---------------------------------------------------------------------------
// Priority: the repair PR's failure comes first
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a failure on the repair PR is returned ahead of another default-branch PR's failure (Issue #5437)", async () => {
  const fx: Fixture = {
    prs: [
      {
        number: 30,
        headRefName: "issue-30-fix",
        headRefOid: SYNC_ONLY_HEAD,
        baseRefName: DEFAULT_BRANCH,
      },
      {
        number: 20,
        headRefName: REPAIR_BRANCH,
        headRefOid: TIP,
        baseRefName: DEFAULT_BRANCH,
        body: "",
      },
    ],
    tip: TIP,
    checks: {
      "issue-30-fix": [{ id: 30, name: "lint" }],
      [REPAIR_BRANCH]: [{ id: 20, name: "gitleaks" }],
    },
    compare: {},
  };
  const { value } = await scan(fx);

  assertEquals(value?.branchName, REPAIR_BRANCH);
  assertEquals(value?.checkName, "gitleaks");
});

// ---------------------------------------------------------------------------
// Status formatting and the marker
// ---------------------------------------------------------------------------

Deno.test("formatRedDefaultBranchStatus - names the held sync PRs and the fix PR, with the marker (Issue #5437)", () => {
  const body = formatRedDefaultBranchStatus({
    defaultBranch: DEFAULT_BRANCH,
    heldPrNumbers: [2, 1],
    repairPrNumber: 9,
    checkNames: ["gitleaks"],
    tipSha: TIP,
  });

  assertStringIncludes(
    body,
    "main is red: holding sync PRs #1, #2, fix in #9",
  );
  assertStringIncludes(body, redDefaultBranchMarker(TIP, [1, 2]));
  assertStringIncludes(body, `sha="${TIP}"`);
  assertStringIncludes(body, 'held="1,2"');
  assertStringIncludes(body, "`gitleaks`");
  assertStringIncludes(body, "this PR's to fix");
});

Deno.test("formatRedDefaultBranchStatus - a repair PR not yet opened says the fix is in this PR (Issue #5437)", () => {
  const body = formatRedDefaultBranchStatus({
    defaultBranch: DEFAULT_BRANCH,
    heldPrNumbers: [1],
    repairPrNumber: null,
    checkNames: ["gitleaks"],
    tipSha: TIP,
  });

  assertStringIncludes(body, "fix in this PR");
  assert(bodyCarriesRedDefaultBranchMarker(body, TIP, [1]));
  assert(!bodyCarriesRedDefaultBranchMarker(body, OLD_HEAD, [1]));
  assert(!bodyCarriesRedDefaultBranchMarker(body, TIP, [1, 2]));
});

Deno.test("bodyCarriesRedDefaultBranchMarker - hostile repeated markers with trailing spaces and x return promptly (Issue #5437)", () => {
  const marker = redDefaultBranchMarker(TIP, [1, 2]);
  const hostile = `${marker}${" ".repeat(50)}x`.repeat(20_000);

  // Every marker is mid-text, followed by `x`, so none is trailing.
  assertEquals(bodyCarriesRedDefaultBranchMarker(hostile, TIP, [1, 2]), false);
  // The same body with a valid marker appended last is trailing.
  assertEquals(
    bodyCarriesRedDefaultBranchMarker(`${hostile}${marker}`, TIP, [1, 2]),
    true,
  );
});

// ---------------------------------------------------------------------------
// Stale (diverged) sync heads, anchored markers and failed outcomes
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a diverged sync PR is stale: no CI-fix target, no repair PR and no PATCH, even when the tip is green (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(8, "sync/milestone-h", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-h": [{ id: 18, name: "gitleaks" }],
        [TIP]: [],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
    },
  );
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(
    callsTo(calls, "api").filter((args) => args.includes("PATCH")).length,
    0,
  );
  assertEquals(logger.skips.length, 1);
  assertStringIncludes(logger.skips[0] ?? "", "stale-sync-head");
  assertStringIncludes(logger.skips[0] ?? "", "re-merges");
  assertEquals(
    logger.skips.some((skip) =>
      skip.startsWith("inherited-red-default-branch")
    ),
    false,
  );
});

Deno.test("findFailedCiChecks - a repair PR whose body quotes the current marker mid-text, without ending with it, is edited (Issue #5437)", async () => {
  const quoted = `Superseded status quoted as \`${
    redDefaultBranchMarker(TIP, [1, 2, 3])
  }\` above.\n\nNew notes follow.`;
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
    body: quoted,
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
  });
  const { value, calls } = await scan(fx);

  // Issue #5437: the adopted repair PR is not red on gitleaks itself, so
  // the lowest held sync PR's failing check run is handed over on it.
  assertEquals(value?.prNumber, 20);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "edit").length, 1);
});

Deno.test("findFailedCiChecks - a failed repair PR creation warns with the gh error and leaves the sync PRs held (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.prCreateError = "HTTP 422: Validation Failed";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(logger.skips.length, 3);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not open a repair PR") &&
      warn.includes("HTTP 422: Validation Failed")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed fast-forward warns with the gh error and the sync PR stays held (Issue #5437)", async () => {
  const fx = redMainFixture([syncPr(4, "sync/milestone-d", OLD_HEAD)], {
    checks: {
      "sync/milestone-d": [{ id: 14, name: "gitleaks" }],
      [TIP]: [],
    },
    compare: { [OLD_HEAD]: "behind" },
  });
  fx.patchError = "HTTP 422: Update is not a fast-forward";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(
    callsTo(calls, "api").filter((args) => args.includes("PATCH")).length,
    1,
  );
  assertEquals(logger.skips.length, 1);
  assertStringIncludes(logger.skips[0] ?? "", "inherited-red-default-branch");
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not fast-forward") &&
      warn.includes("HTTP 422: Update is not a fast-forward")
    ),
  );
  assertEquals(prCreateCalls(calls).length, 0);
});

// ---------------------------------------------------------------------------
// Helpers for the cases below (Issue #5437)
// ---------------------------------------------------------------------------

/** A PR into the default branch on a non-sync head, with its own failure. */
const FEATURE_HEAD = "a7".repeat(20);
/** A human fix PR's head commit (`nleck`'s, in the observed case). */
const FIX_HEAD = "f6".repeat(20);
/** The merge base of `FEATURE_HEAD` with main: the commit it branched from. */
const MERGE_BASE = "9e".repeat(20);

function featurePr(number: number, branch: string): PrFixture {
  return {
    number,
    headRefName: branch,
    headRefOid: FEATURE_HEAD,
    baseRefName: DEFAULT_BRANCH,
  };
}

/** An open human PR against the default branch, as `gh pr list` reports it. */
function humanFixPr(
  number: number,
  headRefName: string,
  headRefOid: string,
  login: string,
  title = "Allowlist the synthetic fixtures in gitleaks",
  body = "",
) {
  return { number, headRefName, headRefOid, author: { login }, title, body };
}

/** Every `gh api -X POST` call to `path`. */
function postsTo(calls: string[][], path: string) {
  return calls.filter((args) =>
    args[0] === "api" && args.includes("POST") && args[3] === path
  );
}

/** Every `gh api -X PATCH` call. */
function patchCalls(calls: string[][]) {
  return calls.filter((args) => args[0] === "api" && args.includes("PATCH"));
}

/** Every `gh api -X PATCH` call to `path`. */
function patchesTo(calls: string[][], path: string) {
  return patchCalls(calls).filter((args) => args[3] === path);
}

/** Every `gh api -X POST` call that writes under the repo's git data. */
function gitWrites(calls: string[][]) {
  return calls.filter((args) =>
    args[0] === "api" && args.includes("POST") &&
    (args[3] ?? "").startsWith(`repos/${REPO}/git/`)
  );
}

/** The status body a fleet or human comment would carry for the red tip. */
function statusComment(prNumber: number): string {
  return formatRedDefaultBranchStatus({
    defaultBranch: DEFAULT_BRANCH,
    heldPrNumbers: [1, 2, 3],
    repairPrNumber: prNumber,
    checkNames: ["gitleaks"],
    tipSha: TIP,
  });
}

// ---------------------------------------------------------------------------
// Non-sync PRs into the default branch (Issue #5437)
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a non-sync PR into main failing a check the tip and its merge base are both red on is held, not handed to the CI-fix agent (Issue #5437)", async () => {
  const fx = redMainFixture([featurePr(9, "issue-9-fix")], {
    checks: {
      "issue-9-fix": [{ id: 9, name: "gitleaks" }],
      [MERGE_BASE]: [{ id: 5, name: "gitleaks" }],
    },
  });
  fx.mergeBase = { [FEATURE_HEAD]: MERGE_BASE };
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  const mergeBaseReads = callsTo(calls, "api").filter((args) =>
    args.includes(".merge_base_commit.sha")
  );
  assertEquals(mergeBaseReads.length, 1);
  assertEquals(
    mergeBaseReads[0]?.[1],
    `repos/${REPO}/compare/main...${FEATURE_HEAD}`,
  );
  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  assertStringIncludes(
    argAfter(creates[0] ?? [], "--body") ?? "",
    "main is red: holding PRs #9, fix in this PR.",
  );
  assertEquals(logger.skips.length, 1);
  assertStringIncludes(logger.skips[0] ?? "", "inherited-red-default-branch");
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a non-sync PR into main failing a check the tip is red on but its merge base is green on is not held: it is the CI-fix target, and no repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture([featurePr(9, "issue-9-fix")], {
    checks: { "issue-9-fix": [{ id: 9, name: "gitleaks" }] },
  });
  // The merge base has no failed check run, so the PR's own base is green.
  fx.mergeBase = { [FEATURE_HEAD]: MERGE_BASE };
  const { value, calls, logger } = await scan(fx);

  assertEquals(value?.prNumber, 9);
  assertEquals(value?.checkName, "gitleaks");
  assertEquals(value?.branchName, "issue-9-fix");
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 0);
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a non-sync PR into main whose merge base cannot be read is not held: it is the CI-fix target, and the warn quotes the gh error (Issue #5437)", async () => {
  const fx = redMainFixture([featurePr(9, "issue-9-fix")], {
    checks: { "issue-9-fix": [{ id: 9, name: "gitleaks" }] },
  });
  fx.mergeBase = { [FEATURE_HEAD]: "error" };
  const { value, calls, logger } = await scan(fx);

  assertEquals(value?.prNumber, 9);
  assertEquals(value?.checkName, "gitleaks");
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("cannot tell whether this PR branched") &&
      warn.includes("HTTP 502: Bad Gateway")
    ),
  );
});

Deno.test("findFailedCiChecks - a non-sync PR into main failing a check the tip is not red on still reaches the CI-fix agent (Issue #5437)", async () => {
  const fx = redMainFixture([featurePr(9, "issue-9-fix")], {
    checks: { "issue-9-fix": [{ id: 9, name: "lint" }] },
  });
  const { value, calls, logger } = await scan(fx);

  assertEquals(value?.prNumber, 9);
  assertEquals(value?.checkName, "lint");
  assertEquals(value?.branchName, "issue-9-fix");
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 0);
});

Deno.test("findFailedCiChecks - a non-sync PR into main still reaches the CI-fix agent, with a warning, when the tip's red checks cannot be read (Issue #5437)", async () => {
  const fx = redMainFixture([featurePr(9, "issue-9-fix")], {
    checks: { "issue-9-fix": [{ id: 9, name: "gitleaks" }] },
  });
  fx.checkReadErrors = [TIP];
  const { value, calls, logger } = await scan(fx);

  assertEquals(value?.prNumber, 9);
  assertEquals(value?.checkName, "gitleaks");
  assertEquals(prCreateCalls(calls).length, 0);
  assert(logger.warns.some((warn) => warn.includes("HTTP 500")));
  assert(
    logger.warns.some((warn) =>
      warn.includes("cannot read the checks red on main") &&
      warn.includes("ordinary CI-fix target")
    ),
  );
});

// ---------------------------------------------------------------------------
// Adopting a green human fix PR (Issue #5437)
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a green human fix PR against main is adopted: no repair PR, and the status is commented on it once (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks", "gate"] };
  fx.compare[FIX_HEAD] = "ahead";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(gitWrites(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "edit").length, 0);
  const comments = callsTo(calls, "pr", "comment");
  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.[2], "5434");
  assertStringIncludes(
    argAfter(comments[0] ?? [], "--body") ?? "",
    "holding sync PRs #1, #2, #3, fix in #5434.",
  );
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a fleet-authored comment carrying the identical marker means the fix PR is not commented again (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  // `testbot` is the scan's own login, so it is in the fleet author set.
  fx.comments = {
    5434: [{ id: 7001, login: "testbot", body: statusComment(5434) }],
  };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(patchCalls(calls).length, 0);
});

Deno.test("findFailedCiChecks - a comment with the identical marker from a non-fleet login does not count, so the status is commented (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  fx.comments = {
    5434: [{ id: 7002, login: "nleck", body: statusComment(5434) }],
  };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 1);
  // The human's comment is never edited: our status is a new comment.
  assertEquals(patchCalls(calls).length, 0);
});

Deno.test("findFailedCiChecks - a candidate green on only some held checks is not adopted, and the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(1, "sync/milestone-a", TIP), syncPr(2, "sync/milestone-b", TIP)],
    {
      checks: {
        "sync/milestone-a": [{ id: 11, name: "gitleaks" }, {
          id: 21,
          name: "lint",
        }],
        "sync/milestone-b": [{ id: 12, name: "gitleaks" }, {
          id: 22,
          name: "lint",
        }],
        [TIP]: [{ id: 1, name: "gitleaks" }, { id: 2, name: "lint" }],
      },
    },
  );
  fx.fixPrs = [humanFixPr(5440, "fix/partial", FIX_HEAD, "nleck")];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  assertStringIncludes(
    argAfter(creates[0] ?? [], "--body") ?? "",
    "`gitleaks`, `lint`",
  );
});

Deno.test("findFailedCiChecks - a candidate green on every held check but diverged from main is a stale branch: not adopted, and the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/stale-before-red", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks", "gate"] };
  fx.compare[FIX_HEAD] = "diverged";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(callsTo(calls, "pr", "edit").length, 0);
  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  assertStringIncludes(
    argAfter(creates[0] ?? [], "--body") ?? "",
    "fix in this PR",
  );
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a candidate whose ancestry cannot be read is not adopted, the warn quotes the gh error, and the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/unknown-ancestry", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks", "gate"] };
  fx.compare[FIX_HEAD] = "error";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(prCreateCalls(calls).length, 1);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not tell whether org/repo#5434") &&
      warn.includes("contains main") &&
      warn.includes("HTTP 502: Bad Gateway")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed fix PR listing warns with the gh error and opens the repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixListError = "HTTP 503: Service Unavailable";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not list the open PRs") &&
      warn.includes("HTTP 503: Service Unavailable")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed check-run read on a candidate warns and opens the repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/gitleaks", FIX_HEAD, "nleck")];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkReadErrors = [FIX_HEAD];
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not read the checks that passed on org/repo#5434") &&
      warn.includes("HTTP 500: Internal Server Error")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed comment read warns with the gh error and opens the repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/gitleaks", FIX_HEAD, "nleck")];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  fx.commentReadError = "HTTP 502: Bad Gateway";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not read the comments on org/repo#5434") &&
      warn.includes("HTTP 502: Bad Gateway")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed status comment post warns with the gh error and opens no repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/gitleaks", FIX_HEAD, "nleck")];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  fx.commentPostError = "HTTP 403: Resource not accessible";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 1);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not post the status on org/repo#5434") &&
      warn.includes("HTTP 403: Resource not accessible")
    ),
  );
});

/** The status body on fix PR `prNumber` that holds `heldPrNumbers` for the tip. */
function statusCommentHolding(
  prNumber: number,
  heldPrNumbers: number[],
): string {
  return formatRedDefaultBranchStatus({
    defaultBranch: DEFAULT_BRANCH,
    heldPrNumbers,
    repairPrNumber: prNumber,
    checkNames: ["gitleaks"],
    tipSha: TIP,
  });
}

Deno.test("findFailedCiChecks - a changed held set edits the one fleet status comment in place: one PATCH to its id, no new comment (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  // The status was written when only #1 and #2 were held.
  fx.comments = {
    5434: [{
      id: 7001,
      login: "testbot",
      body: statusCommentHolding(5434, [1, 2]),
    }],
  };
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(patchCalls(calls).length, 1);
  const patches = patchesTo(calls, "repos/org/repo/issues/comments/7001");
  assertEquals(patches.length, 1);
  assertStringIncludes(
    argAfter(patches[0] ?? [], "-f") ?? "",
    "holding sync PRs #1, #2, #3, fix in #5434.",
  );
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - the newest fleet status comment decides: an older identical one does not stop the newer stale one being edited (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  fx.comments = {
    5434: [
      {
        id: 7001,
        login: "testbot",
        body: statusCommentHolding(5434, [1, 2, 3]),
      },
      { id: 7002, login: "testbot", body: statusCommentHolding(5434, [1, 2]) },
    ],
  };
  const { calls } = await scan(fx);

  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(patchCalls(calls).length, 1);
  assertEquals(
    patchesTo(calls, "repos/org/repo/issues/comments/7002").length,
    1,
  );
});

Deno.test("findFailedCiChecks - a failed status edit warns with the gh error, and neither a repair PR nor a new comment is made (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.compare[FIX_HEAD] = "ahead";
  fx.comments = {
    5434: [{
      id: 7001,
      login: "testbot",
      body: statusCommentHolding(5434, [1, 2]),
    }],
  };
  fx.patchError = "HTTP 422: Unprocessable Entity";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(
    patchesTo(calls, "repos/org/repo/issues/comments/7001").length,
    1,
  );
  assert(
    logger.warns.some((warn) =>
      warn.includes(
        "could not edit the status on comment 7001 on org/repo#5434",
      ) &&
      warn.includes("HTTP 422: Unprocessable Entity")
    ),
  );
});

// ---------------------------------------------------------------------------
// Refreshing a diverged sync head by merging the default branch (Issue #5437)
// ---------------------------------------------------------------------------

const MERGES_PATH = `repos/${REPO}/merges`;

Deno.test("findFailedCiChecks - a diverged sync PR is refreshed by merging main into it once the tip is green on its checks (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(8, "sync/milestone-h", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-h": [{ id: 18, name: "gitleaks" }],
        [TIP]: [],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
    },
  );
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  const merges = postsTo(calls, MERGES_PATH);
  assertEquals(merges.length, 1);
  assert(merges[0]?.includes("base=sync/milestone-h"));
  assert(merges[0]?.includes("head=main"));
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 1);
  assertStringIncludes(logger.skips[0] ?? "", "stale-sync-head");
  assert(
    logger.infos.some((info) =>
      info.includes("merged main into sync/milestone-h")
    ),
  );
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a diverged sync PR is not refreshed while the tip is red, but is held for one repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(8, "sync/milestone-h", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-h": [{ id: 18, name: "gitleaks" }],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
    },
  );
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(postsTo(calls, MERGES_PATH).length, 0);
  // Issue #5437: the red tip holds the diverged PR, so one repair PR is opened
  // for it and the status lists the PR.
  const creates = prCreateCalls(calls);
  assertEquals(creates.length, 1);
  assertEquals(argAfter(creates[0] ?? [], "--base"), DEFAULT_BRANCH);
  assertStringIncludes(
    argAfter(creates[0] ?? [], "--body") ?? "",
    "main is red: holding sync PRs #8, fix in this PR.",
  );
  assert(
    logger.infos.some((info) => info.includes("is red on gitleaks")),
  );
});

Deno.test("findFailedCiChecks - three sync PRs on a red tip get one repair, then one fast-forward each once the repair lands (Issue #5437)", async () => {
  const TIP_AFTER = "f6".repeat(20);

  // Scan 1: main is red on gitleaks at TIP and the three sync heads sit on it.
  const first = await scan(
    redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS }),
  );
  assertEquals(first.value, null);
  const creates = prCreateCalls(first.calls);
  assertEquals(creates.length, 1);
  assertEquals(argAfter(creates[0] ?? [], "--base"), DEFAULT_BRANCH);
  assertEquals(patchCalls(first.calls).length, 0);

  // Scan 2: the repair has landed, so the tip is green at TIP_AFTER. The repair
  // PR is no longer open, and the sync heads are still at TIP, behind the tip.
  const second = await scan({
    prs: THREE_SYNC_PRS,
    tip: TIP_AFTER,
    checks: THREE_SYNC_CHECKS,
    compare: { [TIP]: "behind" },
  });
  assertEquals(second.value, null);
  assertEquals(prCreateCalls(second.calls).length, 0);
  assertEquals(patchCalls(second.calls).length, 3);
  for (const pr of THREE_SYNC_PRS) {
    const patches = patchesTo(
      second.calls,
      `repos/${REPO}/git/refs/heads/${pr.headRefName}`,
    );
    assertEquals(patches.length, 1);
    assertEquals(argAfter(patches[0] ?? [], "-f"), `sha=${TIP_AFTER}`);
    assertStringIncludes(patches[0]?.join(" ") ?? "", "force=false");
  }
  assertEquals(second.logger.warns, []);
});

Deno.test("findFailedCiChecks - a failed merge refresh warns with the gh error and hands no CI-fix target (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(8, "sync/milestone-h", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-h": [{ id: 18, name: "gitleaks" }],
        [TIP]: [],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
    },
  );
  fx.mergeError = "HTTP 409: Merge conflict";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(postsTo(calls, MERGES_PATH).length, 1);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not merge main into sync/milestone-h") &&
      warn.includes("HTTP 409: Merge conflict")
    ),
  );
});

Deno.test("findFailedCiChecks - a diverged sync PR is not refreshed, with a warning, when the tip's red checks cannot be read (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(8, "sync/milestone-h", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-h": [{ id: 18, name: "gitleaks" }],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
    },
  );
  fx.checkReadErrors = [TIP];
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(postsTo(calls, MERGES_PATH).length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("cannot read the checks red on main") &&
      warn.includes("is not refreshed this scan")
    ),
  );
});

// ---------------------------------------------------------------------------
// Repair PR open failures: each names its step and keeps the sync PRs held
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - a failed tip tree read warns naming the step and leaves the sync PRs held (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.treeError = "HTTP 500: tree boom";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(gitWrites(calls).length, 0);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 3);
  assert(
    logger.warns.some((warn) =>
      warn.includes("reading the tip's tree failed: HTTP 500: tree boom") &&
      warn.includes("held PRs stay held")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed empty-commit create warns naming the step and leaves the sync PRs held (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.commitError = "HTTP 422: commit boom";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(postsTo(calls, `repos/${REPO}/git/commits`).length, 1);
  assertEquals(postsTo(calls, `repos/${REPO}/git/refs`).length, 0);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 3);
  assert(
    logger.warns.some((warn) =>
      warn.includes("creating the empty commit failed: HTTP 422: commit boom")
    ),
  );
});

Deno.test("findFailedCiChecks - a failed repair branch create warns naming the branch and leaves the sync PRs held (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.refError = "HTTP 422: Reference already exists";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(postsTo(calls, `repos/${REPO}/git/refs`).length, 1);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(logger.skips.length, 3);
  assert(
    logger.warns.some((warn) =>
      warn.includes(
        `creating branch ${RED_DEFAULT_BRANCH_REPAIR_PREFIX}${
          TIP.slice(0, 12)
        } failed: HTTP 422: Reference already exists`,
      )
    ),
  );
});

Deno.test("findFailedCiChecks - a failed status edit on an adopted repair PR warns with the gh error (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
    body: redDefaultBranchMarker(OLD_HEAD, [1, 2]),
  };
  const fx = redMainFixture([...THREE_SYNC_PRS, repair], {
    checks: THREE_SYNC_CHECKS,
  });
  fx.editError = "HTTP 422: edit boom";
  const { value, calls, logger } = await scan(fx);

  // Issue #5437: the adopted repair PR is not red on gitleaks itself, so
  // the lowest held sync PR's failing check run is handed over on it.
  assertEquals(value?.prNumber, 20);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "edit").length, 1);
  assert(
    logger.warns.some((warn) =>
      warn.includes(
        "could not update the status of org/repo#20: HTTP 422: edit boom",
      )
    ),
  );
});

// ---------------------------------------------------------------------------
// A green human fix makes the repair PR wait (Issue #5437)
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - with a green human fix PR adopted, the worker's repair PR failure is not handed to the CI-fix agent, and another PR's failure is (Issue #5437)", async () => {
  const repair: PrFixture = {
    number: 20,
    headRefName: REPAIR_BRANCH,
    headRefOid: TIP,
    baseRefName: DEFAULT_BRANCH,
    body: "",
  };
  // A PR into a non-default base: the positive control, which must be returned.
  const otherBase: PrFixture = {
    number: 9,
    headRefName: "issue-9-lint",
    headRefOid: FEATURE_HEAD,
    baseRefName: "release/1.0",
  };
  const fx = redMainFixture(
    [syncPr(1, "sync/milestone-a", TIP), repair, otherBase],
    {
      checks: {
        "sync/milestone-a": [{ id: 11, name: "gitleaks" }],
        [REPAIR_BRANCH]: [{ id: 20, name: "gitleaks" }],
        "issue-9-lint": [{ id: 9, name: "lint" }],
      },
    },
  );
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks", "gate"] };
  fx.compare[FIX_HEAD] = "ahead";
  const { value, calls, logger } = await scan(fx);

  // The repair PR's gitleaks failure is not the result: the fix PR is adopted.
  assert(value?.prNumber !== 20);
  assertEquals(value?.prNumber, 9);
  assertEquals(value?.checkName, "lint");
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(gitWrites(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 1);
  assert(
    logger.skips.some((skip) =>
      skip.startsWith("red-default-branch-fix-adopted: ") &&
      skip.includes(
        "org/repo#20: org/repo#5434 is the fix for the held checks (green, or CI still running with none failed); the repair PR waits",
      )
    ),
  );
});

// ---------------------------------------------------------------------------
// A human fix PR still running its CI is waited on (Issue #5437)
// ---------------------------------------------------------------------------

/** A green-on-gitleaks head, for a second human fix PR in these cases. */
const GREEN_FIX_HEAD = "f7".repeat(20);
/** A start time far outside the wait window. */
const LONG_AGO = "2026-01-01T00:00:00Z";

/** A check run still running, started now (inside the wait window). */
function runningRun(name: string): CheckRunStateFixture {
  return {
    name,
    status: "in_progress",
    conclusion: null,
    started_at: new Date().toISOString(),
  };
}

/** A check run that has completed with a failure. */
function failedRun(name: string): CheckRunStateFixture {
  return {
    name,
    status: "completed",
    conclusion: "failure",
    started_at: LONG_AGO,
  };
}

/** Every check-run states read, which names `started_at` in its `--jq`. */
function statesReads(calls: string[][]) {
  return calls.filter((args) =>
    args[0] === "api" && args.some((arg) => arg.includes("started_at"))
  );
}

Deno.test("findFailedCiChecks - a human fix PR still running its CI, with the held check not yet created, is adopted: no repair PR, and its status is commented on it once (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [runningRun("lint")] };
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(gitWrites(calls).length, 0);
  const comments = callsTo(calls, "pr", "comment");
  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.[2], "5434");
  assert(
    logger.infos.some((info) =>
      info.includes("org/repo#5434") &&
      info.includes("by nleck") &&
      info.includes("still running")
    ),
    `infos: ${logger.infos}`,
  );
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a fleet-authored PR still running its CI is not waited on: the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  // `testbot` is the scan's own login, so it is in the fleet author set.
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "testbot"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [runningRun("lint")] };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(statesReads(calls).length, 0);
});

Deno.test("findFailedCiChecks - a bot-authored fix PR still running its CI is not waited on: the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  // Dependabot is a bot, not in the fleet author set: only the bot check applies.
  fx.fixPrs = [
    humanFixPr(
      5434,
      "dependabot/npm_and_yarn/lint",
      FIX_HEAD,
      "app/dependabot",
    ),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [runningRun("lint")] };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(statesReads(calls).length, 0);
});

Deno.test("findFailedCiChecks - a fleet PR whose login differs only in case is not waited on: the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  // The scan's login is `testbot`; GitHub logins compare case-insensitively.
  fx.fixPrs = [humanFixPr(5434, "fix/mixed-case", FIX_HEAD, "TestBot")];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [runningRun("lint")] };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertEquals(statesReads(calls).length, 0);
});

Deno.test("findFailedCiChecks - a held check that timed out while another check runs is a failure: not waited on, and the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = {
    [FIX_HEAD]: [{
      name: "gitleaks",
      status: "completed",
      conclusion: "timed_out",
      started_at: LONG_AGO,
    }, runningRun("lint")],
  };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(statesReads(calls).length, 1);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
});

Deno.test("findFailedCiChecks - a candidate whose check-run states cannot be read is skipped, and a later green candidate is still adopted (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/unreadable-states", FIX_HEAD, "nleck"),
    humanFixPr(5435, "fix/green", GREEN_FIX_HEAD, "alice"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.compare[GREEN_FIX_HEAD] = "ahead";
  fx.greenChecks = { [GREEN_FIX_HEAD]: ["gitleaks"] };
  fx.checkRunStateReadErrors = [FIX_HEAD];
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  const comments = callsTo(calls, "pr", "comment");
  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.[2], "5435");
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not read the check runs on org/repo#5434") &&
      warn.includes("HTTP 504: Gateway Timeout") &&
      warn.includes("it is not waited on")
    ),
    `warns: ${logger.warns}`,
  );
});

Deno.test("findFailedCiChecks - a human fix PR with a held check failed while another check runs is not waited on: the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = {
    [FIX_HEAD]: [failedRun("gitleaks"), runningRun("lint")],
  };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(statesReads(calls).length, 1);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
});

Deno.test("findFailedCiChecks - a human fix PR whose only running check started long ago is not waited on: the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = {
    [FIX_HEAD]: [{
      name: "lint",
      status: "in_progress",
      conclusion: null,
      started_at: LONG_AGO,
    }],
  };
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(statesReads(calls).length, 1);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
});

Deno.test("findFailedCiChecks - a running human fix PR does not win over a second candidate green on every held check: the green one is commented on (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/still-running", FIX_HEAD, "nleck"),
    humanFixPr(5435, "fix/green", GREEN_FIX_HEAD, "alice"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.compare[GREEN_FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [runningRun("lint")] };
  fx.greenChecks = { [GREEN_FIX_HEAD]: ["gitleaks"] };
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(statesReads(calls).length, 1);
  assertEquals(prCreateCalls(calls).length, 0);
  const comments = callsTo(calls, "pr", "comment");
  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.[2], "5435");
  assertStringIncludes(
    argAfter(comments[0] ?? [], "--body") ?? "",
    "fix in #5435.",
  );
  assertEquals(
    logger.infos.some((info) => info.includes("org/repo#5434")),
    false,
  );
});

Deno.test("findFailedCiChecks - a failed check-run states read warns with the gh error and opens the repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/gitleaks-allow-5310-fixtures", FIX_HEAD, "nleck"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStateReadErrors = [FIX_HEAD];
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not read the check runs on org/repo#5434") &&
      warn.includes("HTTP 504: Gateway Timeout")
    ),
    `warns: ${logger.warns}`,
  );
});

Deno.test("findGreenFixPr - a PR row without its head commit fails the read, and the warn names headRefOid (Issue #5437)", async () => {
  const logger = makeLogger();
  const fix = await findGreenFixPr({
    repo: REPO,
    defaultBranch: DEFAULT_BRANCH,
    checkNames: ["lint"],
    heldPrNumbers: [],
    isSyncBranch: () => false,
    readAncestry: () =>
      Promise.resolve({ status: "contains-default" as const }),
    readSuccessfulCheckNames: () => Promise.resolve(new Set(["lint"])),
    fleetLogins: [],
    readCheckRunStates: () =>
      Promise.resolve({
        failed: new Set<string>(),
        running: new Set<string>(),
      }),
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify([
        { number: 12, headRefName: "human/fix", author: { login: "alice" } },
      ])),
    logger,
  });
  assertEquals(fix, null);
  assert(
    logger.warns.some((w) => w.includes("headRefOid")),
    `warns: ${logger.warns}`,
  );
});

// ---------------------------------------------------------------------------
// The check-run states the fix wait reads, with a fixed clock (Issue #5437)
// ---------------------------------------------------------------------------

/** A fixed clock for the wait-window cases. */
const WINDOW_NOW = Date.parse("2026-11-23T12:00:00Z");

/** A `gh` answer that returns `rows` as the check-run array. */
function rowsGh(rows: unknown[]): (args: string[]) => Promise<string> {
  return () => Promise.resolve(JSON.stringify(rows));
}

Deno.test("fetchCheckRunStates - a run started just inside the wait window is running (Issue #5437)", async () => {
  const startedAt = new Date(WINDOW_NOW - (RUNNING_FIX_WAIT_MS - 60_000))
    .toISOString();
  const states = await fetchCheckRunStates(
    REPO,
    TIP,
    rowsGh([{
      name: "lint",
      status: "in_progress",
      conclusion: null,
      started_at: startedAt,
    }]),
    WINDOW_NOW,
  );
  assertEquals([...states.running], ["lint"]);
  assertEquals(states.failed.size, 0);
});

Deno.test("fetchCheckRunStates - a run started just outside the wait window is not running (Issue #5437)", async () => {
  const startedAt = new Date(WINDOW_NOW - (RUNNING_FIX_WAIT_MS + 60_000))
    .toISOString();
  const states = await fetchCheckRunStates(
    REPO,
    TIP,
    rowsGh([{
      name: "lint",
      status: "in_progress",
      conclusion: null,
      started_at: startedAt,
    }]),
    WINDOW_NOW,
  );
  assertEquals(states.running.size, 0);
  assertEquals(states.failed.size, 0);
});

Deno.test("fetchCheckRunStates - a run with no usable start time is not running (Issue #5437)", async () => {
  const states = await fetchCheckRunStates(
    REPO,
    TIP,
    rowsGh([{
      name: "lint",
      status: "queued",
      conclusion: null,
      started_at: null,
    }]),
    WINDOW_NOW,
  );
  assertEquals(states.running.size, 0);
});

Deno.test("fetchCheckRunStates - a completed timed_out run is failed, and a success is not (Issue #5437)", async () => {
  const states = await fetchCheckRunStates(
    REPO,
    TIP,
    rowsGh([
      {
        name: "gitleaks",
        status: "completed",
        conclusion: "timed_out",
        started_at: LONG_AGO,
      },
      {
        name: "lint",
        status: "completed",
        conclusion: "success",
        started_at: LONG_AGO,
      },
    ]),
    WINDOW_NOW,
  );
  assertEquals([...states.failed], ["gitleaks"]);
  assertEquals(states.running.size, 0);
});

Deno.test("fetchCheckRunStates - a check run row without a name throws, naming the field (Issue #5437)", async () => {
  await assertRejects(
    () =>
      fetchCheckRunStates(
        REPO,
        TIP,
        rowsGh([{ status: "completed", conclusion: "success" }]),
        WINDOW_NOW,
      ),
    Error,
    "has no name",
  );
});

Deno.test("postRedDefaultBranchStatusComment - a comment without a user.login reads as read-failed, and the warn names the login (Issue #5437)", async () => {
  const logger = makeLogger();
  const outcome = await postRedDefaultBranchStatusComment({
    repo: REPO,
    defaultBranch: DEFAULT_BRANCH,
    tipSha: TIP,
    checkNames: ["lint"],
    heldPrNumbers: [11],
    allHeldAreSync: true,
    prNumber: 12,
    fleetLogins: ["fleet-bot"],
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({ id: 5, login: null, body: "" })),
    logger,
  });
  assertEquals(outcome, "read-failed");
  assert(
    logger.warns.some((w) => w.includes("user.login")),
    `warns: ${logger.warns}`,
  );
});

// ---------------------------------------------------------------------------
// One fix status stands: a superseded one is withdrawn (Issue #5437)
// ---------------------------------------------------------------------------

/** The status body of the one `gh pr comment` a scan posted. */
function postedCommentBody(calls: string[][]): string {
  const comments = callsTo(calls, "pr", "comment");
  assertEquals(comments.length, 1);
  return argAfter(comments[0] ?? [], "--body") ?? "";
}

/** The body a PATCH to comment `id` wrote. */
function patchedBody(calls: string[][], id: number): string {
  const patches = patchesTo(calls, `repos/org/repo/issues/comments/${id}`);
  assertEquals(patches.length, 1);
  return (argAfter(patches[0] ?? [], "-f") ?? "").replace(/^body=/, "");
}

Deno.test("findFailedCiChecks - a running human fix is adopted with the pending status; once its held check fails, the repair PR is opened and the earlier status is withdrawn naming it (Issue #5437)", async () => {
  // Scan 1: #5434's CI is running and gitleaks has not been created yet.
  const first = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  first.fixPrs = [
    humanFixPr(5434, "fix/unrelated-docs", FIX_HEAD, "nleck"),
  ];
  first.compare[FIX_HEAD] = "ahead";
  first.checkRunStates = { [FIX_HEAD]: [runningRun("lint")] };
  const one = await scan(first);

  assertEquals(prCreateCalls(one.calls).length, 0);
  const pendingBody = postedCommentBody(one.calls);
  assertEquals(callsTo(one.calls, "pr", "comment")[0]?.[2], "5434");
  assertStringIncludes(
    pendingBody,
    "holding sync PRs #1, #2, #3, fix in #5434, its CI still running.",
  );
  assertStringIncludes(pendingBody, "It cannot tell from GitHub whether");
  assert(!pendingBody.includes("This PR exists to repair"));
  assert(bodyCarriesRedDefaultBranchMarker(pendingBody, TIP, [1, 2, 3], true));
  assert(!bodyCarriesRedDefaultBranchMarker(pendingBody, TIP, [1, 2, 3]));

  // Scan 2: gitleaks has now failed on #5434, which carries scan 1's status.
  const second = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  second.fixPrs = first.fixPrs;
  second.compare[FIX_HEAD] = "ahead";
  second.checkRunStates = {
    [FIX_HEAD]: [failedRun("gitleaks"), runningRun("lint")],
  };
  second.comments = {
    5434: [{ id: 7100, login: "testbot", body: pendingBody }],
  };
  const two = await scan(second);

  assertEquals(prCreateCalls(two.calls).length, 1);
  assertEquals(callsTo(two.calls, "pr", "comment").length, 0);
  assertEquals(patchCalls(two.calls).length, 1);
  const withdrawn = patchedBody(two.calls, 7100);
  assertStringIncludes(
    withdrawn,
    `is no longer taken as its fix: fix in #${CREATED_PR}.`,
  );
  assert(!bodyCarriesRedDefaultBranchMarker(withdrawn, TIP, [1, 2, 3], true));
  assert(!withdrawn.includes("fix in #5434"));
  assertEquals(two.logger.warns, []);

  // Scan 3: the status is already withdrawn, so it is not edited again.
  const third = {
    ...second,
    comments: { 5434: [{ id: 7100, login: "testbot", body: withdrawn }] },
  };
  const three = await scan(third);
  assertEquals(patchCalls(three.calls).length, 0);
});

Deno.test("findFailedCiChecks - a green fix adopted after an earlier pending one withdraws the earlier status, naming the green fix (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(5434, "fix/unrelated-docs", FIX_HEAD, "nleck"),
    humanFixPr(5435, "fix/green", GREEN_FIX_HEAD, "alice"),
  ];
  fx.compare[FIX_HEAD] = "ahead";
  fx.compare[GREEN_FIX_HEAD] = "ahead";
  fx.greenChecks = { [GREEN_FIX_HEAD]: ["gitleaks"] };
  fx.checkRunStates = { [FIX_HEAD]: [failedRun("gitleaks")] };
  fx.comments = {
    5434: [{
      id: 7200,
      login: "testbot",
      body: formatRedDefaultBranchStatus({
        defaultBranch: DEFAULT_BRANCH,
        heldPrNumbers: [1, 2, 3],
        repairPrNumber: 5434,
        checkNames: ["gitleaks"],
        tipSha: TIP,
        pending: true,
      }),
    }],
  };
  const { calls, logger } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment")[0]?.[2], "5435");
  assertStringIncludes(
    patchedBody(calls, 7200),
    "is no longer taken as its fix: fix in #5435.",
  );
  assertEquals(logger.warns, []);
});

Deno.test("findFailedCiChecks - a pending fix that turns green has its pending status edited in place to the green one (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/gitleaks", FIX_HEAD, "nleck")];
  fx.compare[FIX_HEAD] = "ahead";
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks"] };
  fx.comments = {
    5434: [{
      id: 7300,
      login: "testbot",
      body: formatRedDefaultBranchStatus({
        defaultBranch: DEFAULT_BRANCH,
        heldPrNumbers: [1, 2, 3],
        repairPrNumber: 5434,
        checkNames: ["gitleaks"],
        tipSha: TIP,
        pending: true,
      }),
    }],
  };
  const { calls } = await scan(fx);

  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  const green = patchedBody(calls, 7300);
  assertStringIncludes(green, "holding sync PRs #1, #2, #3, fix in #5434.");
  assert(bodyCarriesRedDefaultBranchMarker(green, TIP, [1, 2, 3]));
});

Deno.test("findFailedCiChecks - a PR adopted again after its status was withdrawn has that comment edited back, not a second one posted (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/gitleaks", FIX_HEAD, "nleck")];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [runningRun("gitleaks")] };
  fx.comments = {
    5434: [{
      id: 7400,
      login: "testbot",
      body: formatWithdrawnFixStatus({
        defaultBranch: DEFAULT_BRANCH,
        fixPrNumber: CREATED_PR,
        checkNames: ["gitleaks"],
        tipSha: TIP,
      }),
    }],
  };
  const { calls } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "comment").length, 0);
  assertStringIncludes(
    patchedBody(calls, 7400),
    "fix in #5434, its CI still running.",
  );
});

Deno.test("findFailedCiChecks - an unreadable comment list on another PR warns with the gh error and the repair PR still stands (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/unrelated-docs", FIX_HEAD, "nleck")];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [failedRun("gitleaks")] };
  fx.commentReadError = "HTTP 503: comments boom";
  const { calls, logger } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(patchCalls(calls).length, 0);
  assert(
    logger.warns.some((warn) =>
      warn.includes("could not read the comments on org/repo#5434") &&
      warn.includes("to withdraw a superseded fix status") &&
      warn.includes("HTTP 503: comments boom")
    ),
    `warns: ${logger.warns}`,
  );
});

Deno.test("findFailedCiChecks - a status withdrawn while no fix PR stood is edited again to name the repair PR once it is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [humanFixPr(5434, "fix/unrelated-docs", FIX_HEAD, "nleck")];
  fx.compare[FIX_HEAD] = "ahead";
  fx.checkRunStates = { [FIX_HEAD]: [failedRun("gitleaks")] };
  fx.comments = {
    5434: [{
      id: 7500,
      login: "testbot",
      body: formatWithdrawnFixStatus({
        defaultBranch: DEFAULT_BRANCH,
        fixPrNumber: null,
        checkNames: ["gitleaks"],
        tipSha: TIP,
      }),
    }],
  };
  const { calls } = await scan(fx);

  assertEquals(prCreateCalls(calls).length, 1);
  const body = patchedBody(calls, 7500);
  assertStringIncludes(
    body,
    `no longer taken as its fix: fix in #${CREATED_PR}.`,
  );
  assert(!body.includes("no fix PR stands yet"));
});

// ---------------------------------------------------------------------------
// A fix candidate must name the held failure (Issue #5437)
// ---------------------------------------------------------------------------

Deno.test("findFailedCiChecks - an unrelated human PR green on gitleaks is not adopted, and the repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(
      5434,
      "feature/dark-mode",
      FIX_HEAD,
      "nleck",
      "Add dark mode",
      "Adds a theme toggle.",
    ),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks", "gate"] };
  fx.compare[FIX_HEAD] = "ahead";
  const { value, calls, logger } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 1);
  assertEquals(
    callsTo(calls, "pr", "comment").filter((args) => args[2] === "5434")
      .length,
    0,
  );
  assert(
    logger.infos.some((line) =>
      line.includes("org/repo#5434") && line.includes("names none of the held")
    ),
    `infos: ${logger.infos}`,
  );
});

Deno.test("findFailedCiChecks - the same human PR with a title naming gitleaks is adopted, so no repair PR is opened (Issue #5437)", async () => {
  const fx = redMainFixture(THREE_SYNC_PRS, { checks: THREE_SYNC_CHECKS });
  fx.fixPrs = [
    humanFixPr(
      5434,
      "feature/dark-mode",
      FIX_HEAD,
      "nleck",
      "Add dark mode and allow gitleaks fixtures",
      "Adds a theme toggle.",
    ),
  ];
  fx.greenChecks = { [FIX_HEAD]: ["gitleaks", "gate"] };
  fx.compare[FIX_HEAD] = "ahead";
  const { value, calls } = await scan(fx);

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  const comments = callsTo(calls, "pr", "comment");
  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.[2], "5434");
});

const NAMES = { title: "", body: "", headRefName: "" };

Deno.test("fixCandidateNamesHeldFailure - a check named in the body, the branch or in mixed case counts (Issue #5437)", () => {
  assert(
    fixCandidateNamesHeldFailure(
      { ...NAMES, body: "Allows the gitleaks fixtures." },
      ["gitleaks"],
      [],
    ),
  );
  assert(
    fixCandidateNamesHeldFailure(
      { ...NAMES, headRefName: "fix/gitleaks-allow-5310-fixtures" },
      ["gitleaks"],
      [],
    ),
  );
  assert(
    fixCandidateNamesHeldFailure(
      { ...NAMES, title: "Fix GitLeaks" },
      ["gitleaks"],
      [],
    ),
  );
});

Deno.test("fixCandidateNamesHeldFailure - a check name inside a longer word does not count (Issue #5437)", () => {
  for (const title of ["gitleaksy", "notgitleaks", "gitleaks2"]) {
    assertEquals(
      fixCandidateNamesHeldFailure({ ...NAMES, title }, ["gitleaks"], []),
      false,
      title,
    );
  }
  // A later whole-token occurrence still counts after an embedded one.
  assert(
    fixCandidateNamesHeldFailure(
      { ...NAMES, title: "notgitleaks but gitleaks too" },
      ["gitleaks"],
      [],
    ),
  );
});

Deno.test("fixCandidateNamesHeldFailure - a held PR number counts only as a whole number and only when held (Issue #5437)", () => {
  assert(
    fixCandidateNamesHeldFailure(
      { ...NAMES, body: "Follows up #5429" },
      ["gitleaks"],
      [5429],
    ),
  );
  assertEquals(
    fixCandidateNamesHeldFailure(
      { ...NAMES, body: "See #54290" },
      ["gitleaks"],
      [5429],
    ),
    false,
  );
  assertEquals(
    fixCandidateNamesHeldFailure(
      { ...NAMES, body: "Follows up #5429" },
      ["gitleaks"],
      [5428],
    ),
    false,
  );
});

Deno.test("fixCandidateNamesHeldFailure - a check name with spaces and a slash matches, and an empty name is ignored (Issue #5437)", () => {
  assert(
    fixCandidateNamesHeldFailure(
      { ...NAMES, title: "Make CI / gate pass" },
      ["CI / gate"],
      [],
    ),
  );
  assertEquals(
    fixCandidateNamesHeldFailure(
      { ...NAMES, title: "Anything" },
      [""],
      [],
    ),
    false,
  );
});

Deno.test("fixCandidateNamesHeldFailure - a hostile long body of the check name's prefix returns false (Issue #5437)", () => {
  const named = fixCandidateNamesHeldFailure(
    { ...NAMES, body: "a".repeat(100000) + "!" },
    ["aaab"],
    [],
  );
  assertEquals(named, false);
});

/** Runs `findGreenFixPr` for check `lint` over `rows`, every candidate green. */
function directFix(
  rows: unknown[],
  running: ReadonlySet<string>,
  passing: ReadonlySet<string>,
) {
  const logger = makeLogger();
  const fix = findGreenFixPr({
    repo: REPO,
    defaultBranch: DEFAULT_BRANCH,
    checkNames: ["lint"],
    heldPrNumbers: [],
    isSyncBranch: () => false,
    readAncestry: () =>
      Promise.resolve({ status: "contains-default" as const }),
    readSuccessfulCheckNames: (oid: string) =>
      Promise.resolve(oid === "green" ? new Set(["lint"]) : passing),
    fleetLogins: [],
    readCheckRunStates: () =>
      Promise.resolve({ failed: new Set<string>(), running }),
    ghCommandFn: () => Promise.resolve(JSON.stringify(rows)),
    logger,
  });
  return { fix, logger };
}

Deno.test("findGreenFixPr - a still-running human candidate that names nothing is not waited on (Issue #5437)", async () => {
  const { fix, logger } = directFix(
    [{
      number: 12,
      headRefName: "feature/dark-mode",
      headRefOid: "running",
      author: { login: "alice" },
      title: "Add dark mode",
      body: "",
    }],
    new Set(["lint"]),
    new Set(),
  );
  assertEquals(await fix, null);
  assert(logger.infos.some((line) => line.includes("names none of the held")));
});

Deno.test("findGreenFixPr - an unnamed running candidate is skipped and a later named green one is returned (Issue #5437)", async () => {
  const { fix } = directFix(
    [
      {
        number: 12,
        headRefName: "feature/dark-mode",
        headRefOid: "running",
        author: { login: "alice" },
        title: "Add dark mode",
        body: "",
      },
      {
        number: 13,
        headRefName: "fix/other",
        headRefOid: "green",
        author: { login: "bob" },
        title: "Fix lint",
        body: "",
      },
    ],
    new Set(["lint"]),
    new Set(),
  );
  assertEquals((await fix)?.number, 13);
});

Deno.test("findGreenFixPr - a PR row without a title returns null and the warn names title (Issue #5437)", async () => {
  const { fix, logger } = directFix(
    [{
      number: 12,
      headRefName: "fix/lint",
      headRefOid: "green",
      author: { login: "alice" },
      body: "",
    }],
    new Set(),
    new Set(),
  );
  assertEquals(await fix, null);
  assert(
    logger.warns.some((w) => w.includes("title")),
    `warns: ${logger.warns}`,
  );
});

Deno.test("findGreenFixPr - a PR row without a body returns null and the warn names body (Issue #5437)", async () => {
  const { fix, logger } = directFix(
    [{
      number: 12,
      headRefName: "fix/lint",
      headRefOid: "green",
      author: { login: "alice" },
      title: "Fix lint",
    }],
    new Set(),
    new Set(),
  );
  assertEquals(await fix, null);
  assert(
    logger.warns.some((w) => w.includes("has no body")),
    `warns: ${logger.warns}`,
  );
});

Deno.test("findGreenFixPr - an empty body is valid, and the PR is adopted when its title names the check (Issue #5437)", async () => {
  const { fix } = directFix(
    [{
      number: 12,
      headRefName: "human/change",
      headRefOid: "green",
      author: { login: "alice" },
      title: "Fix lint",
      body: "",
    }],
    new Set(),
    new Set(),
  );
  assertEquals((await fix)?.number, 12);
});
