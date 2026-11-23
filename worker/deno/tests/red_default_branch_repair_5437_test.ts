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
 * - an undecidable ancestry stands the sync PR down for the scan;
 * - the repair PR's own failure is returned ahead of other default-branch
 *   failures.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import {
  bodyCarriesRedDefaultBranchMarker,
  formatRedDefaultBranchStatus,
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
  /** Refs whose check-runs read fails with a `gh` error. */
  checkReadErrors?: string[];
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
      return Promise.resolve(JSON.stringify(fx.prs));
    }
    if (args[0] === "pr" && args[1] === "create") {
      return Promise.resolve(`https://github.com/${REPO}/pull/${CREATED_PR}\n`);
    }
    if (args[0] === "pr" && args[1] === "edit") return Promise.resolve("");
    if (args[1] === `repos/${REPO}/commits/${DEFAULT_BRANCH}`) {
      return Promise.resolve(`${fx.tip}\n`);
    }
    if (args[1] === `repos/${REPO}/git/commits/${fx.tip}`) {
      return Promise.resolve(`${TREE}\n`);
    }
    if (args.includes("POST") && args[3] === `repos/${REPO}/git/commits`) {
      return Promise.resolve(`${NEW_COMMIT}\n`);
    }
    if (args.includes("POST") && args[3] === `repos/${REPO}/git/refs`) {
      return Promise.resolve("{}");
    }
    if (args.includes("PATCH")) return Promise.resolve("{}");
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
  extra: Partial<Pick<Fixture, "checks" | "compare">> = {},
): Fixture {
  return {
    prs,
    tip: TIP,
    checks: { [TIP]: [{ id: 1, name: "gitleaks" }], ...extra.checks },
    compare: { [TIP]: "identical", ...extra.compare },
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

  assertEquals(value, null);
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

  assertEquals(value, null);
  assertEquals(prCreateCalls(calls).length, 0);
  assertEquals(callsTo(calls, "pr", "edit").length, 0);
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

Deno.test("findFailedCiChecks - a diverged sync PR's check the tip does not share still reaches the CI-fix agent (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(5, "sync/milestone-e", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-e": [{ id: 15, name: "lint" }],
        [TIP]: [],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
    },
  );
  const { value, calls } = await scan(fx);

  assertEquals(value?.prNumber, 5);
  assertEquals(value?.branchName, "sync/milestone-e");
  assertEquals(value?.checkName, "lint");
  assertEquals(prCreateCalls(calls).length, 0);
});

Deno.test("findFailedCiChecks - a diverged sync PR's check that the tip also has is held for the repair (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(5, "sync/milestone-e", SYNC_ONLY_HEAD)],
    {
      checks: {
        [SYNC_ONLY_HEAD]: [],
        "sync/milestone-e": [{ id: 15, name: "lint" }],
        [TIP]: [{ id: 1, name: "lint" }],
      },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
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
});

Deno.test("findFailedCiChecks - an off-default sync PR stands down when the default tip's check runs cannot be read, and opens no repair PR (Issue #5437)", async () => {
  const fx = redMainFixture(
    [syncPr(7, "sync/milestone-g", SYNC_ONLY_HEAD)],
    {
      checks: { "sync/milestone-g": [{ id: 17, name: "lint" }] },
      compare: { [SYNC_ONLY_HEAD]: "diverged" },
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
