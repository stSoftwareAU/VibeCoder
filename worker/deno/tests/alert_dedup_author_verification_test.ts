/**
 * The escalation modules must not dedup on a marker nobody in the fleet
 * wrote.
 *
 * Every self-diagnostic escalation is deduped by searching the target
 * repository for a marker in an issue **body**, and a body is text any
 * account that can open an issue may write. Without an author check the
 * search cannot tell the fleet's own alert from anybody else's issue, so
 * the worker concludes its alert already exists and stays silent — the
 * fleet's own launcher-failure, idle-inversion, bump-script,
 * branch-update and idle-starvation diagnostics all go quiet.
 *
 * Five properties are asserted for each of the five escalations:
 *
 *   1. A marker match from a **non-fleet** author does not dedup — the
 *      alert is still raised.
 *   2. A marker match from a **fleet** account still dedups — the fix is
 *      not "always raise".
 *   3. A marker match from a **different fleet host** still dedups —
 *      cross-host convergence is the reason the filter is the fleet set
 *      rather than `--author @me`.
 *   4. An **unresolvable** fleet author set raises rather than suppresses,
 *      and says so in the log. For an alerting system silence is the worse
 *      failure: a duplicate is noise a human closes, a missing alert is an
 *      incident nobody hears about. This test exists so that direction is
 *      not quietly reversed later by someone optimising for fewer
 *      duplicates.
 *   5. A search returning both a forged and a genuine match dedups on the
 *      genuine one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ALERT_DEDUP_JSON_FIELDS,
  resolveAlertDedupAuthors,
  selectFleetAuthoredMatches,
} from "../lib/alert_dedup_authors.ts";
import {
  fileRunFailureIssue,
  formatRunFailureMarker,
  type RunFailureReport,
} from "../lib/run_failure_issue.ts";
import {
  formatIdleInversionMarker,
  idleInversionStatePath,
  recordIdleInversion,
} from "../lib/idle_inversion_streak.ts";
import {
  bumpScriptStreakPath,
  formatBumpScriptFailureMarker,
  recordBumpScriptRejection,
} from "../lib/bump_script_failure_streak.ts";
import {
  formatPrBranchFailureMarker,
  prBranchFailureStatePath,
  recordPrBranchUpdateFailure,
} from "../lib/pr_branch_update_failure_streak.ts";
import {
  formatIdleStarvationMarker,
  idleStarvationStatePath,
  recordIdleStarvationObservation,
} from "../lib/idle_starvation_escalation.ts";
import type { WorkerConfig } from "../types.ts";

// ===========================================================================
// Shared fixtures
// ===========================================================================

/** The account this host authenticates as. */
const HOST = "vibe-coder-bot";
/** A sibling fleet host — a different account, same fleet. */
const SIBLING = "vibe-coder-grq23";
/** Anyone at all with an issue-open button on a public repository. */
const OUTSIDER = "passer-by";

const FLEET: readonly string[] = [HOST, SIBLING];

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "issue-1-some-branch";

/** One row as `gh issue list --json number,body,author` returns it. */
function row(number: number, body: string, login: string) {
  return { number, body, author: { login } };
}

/**
 * A `gh` fake that answers `issue list` with fixed rows and records every
 * call, so "did not file" and "filed twice" are both observable.
 */
function gh(
  listRows: unknown[],
  createUrl = `https://github.com/${REPO}/issues/999\n`,
) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list") return Promise.resolve(JSON.stringify(listRows));
    if (args[1] === "create") return Promise.resolve(createUrl);
    return Promise.resolve("");
  };
  const creates = () => calls.filter((c) => c[1] === "create");
  const lists = () => calls.filter((c) => c[1] === "list");
  return { fn, calls, creates, lists };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "alert-dedup-author-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ===========================================================================
// The shared control
// ===========================================================================

Deno.test("alert dedup - the search must request the author field", () => {
  assert(
    ALERT_DEDUP_JSON_FIELDS.split(",").includes("author"),
    `a dedup search that does not request the author cannot verify it: ` +
      ALERT_DEDUP_JSON_FIELDS,
  );
});

Deno.test("alert dedup - a non-fleet author is not an existing alert", async () => {
  const logs: string[] = [];
  const kept = await selectFleetAuthoredMatches(
    [row(1, "marker", OUTSIDER)],
    "unit",
    { fleetAuthors: FLEET },
    (m) => logs.push(m),
  );
  assertEquals(kept.length, 0);
  assert(logs.some((l) => l.includes("outside the fleet")), logs.join("\n"));
});

Deno.test("alert dedup - fleet authors match case-insensitively", async () => {
  const kept = await selectFleetAuthoredMatches(
    [row(1, "marker", "VIBE-Coder-Bot")],
    "unit",
    { fleetAuthors: FLEET },
    () => {},
  );
  assertEquals(kept.map((k) => k.number), [1]);
});

Deno.test("alert dedup - an unresolved fleet set keeps nothing and logs loudly", async () => {
  const logs: string[] = [];
  const kept = await selectFleetAuthoredMatches(
    [row(1, "marker", HOST)],
    "unit",
    { fleetAuthors: [] },
    (m) => logs.push(m),
  );
  assertEquals(
    kept.length,
    0,
    "an unverifiable match must not suppress the alert",
  );
  assert(logs.some((l) => l.includes("fleet author set unresolved")));
  assert(logs.some((l) => l.includes("escalation is raised")));
});

Deno.test("alert dedup - a config that cannot be read resolves to no authors, loudly", async () => {
  const logs: string[] = [];
  const authors = await resolveAlertDedupAuthors(
    {
      env: () => undefined,
      loadConfigFn: () => Promise.reject(new Error("ENOENT: .config.json")),
    },
    (m) => logs.push(m),
  );
  assertEquals(authors, []);
  assert(
    logs.some((l) => l.includes("could not load the fleet author set")),
    logs.join("\n"),
  );
});

Deno.test("alert dedup - the configured fleet identity is service accounts, siblings and this host", async () => {
  const config = {
    fleetPrAuthors: [SIBLING],
    serviceAccounts: ["stsvcbot"],
  } as unknown as WorkerConfig;
  const authors = await resolveAlertDedupAuthors(
    {
      env: (name) => (name === "GITHUB_USER" ? HOST : undefined),
      loadConfigFn: () => Promise.resolve(config),
    },
    () => {},
  );
  assertEquals(authors.sort(), [HOST, SIBLING, "stsvcbot"].sort());
});

// ===========================================================================
// 1. run_failure_issue.ts — launcher / run failures
// ===========================================================================

const OOM_REPORT: RunFailureReport = {
  sourceRepo: "stSoftwareAU/private-repo-6",
  sourceIssueNumber: 147,
  machineId: "vibe-coder-test",
  outcome: {
    kind: "no_pr",
    category: "killed",
    phase: "execute",
    elapsedSeconds: 539,
    message: "Claude was killed (exit 137, SIGKILL — possible out-of-memory)",
  },
};

async function runFailure(
  listRows: unknown[],
  fleetAuthors: readonly string[],
  logs: string[] = [],
) {
  let action = "";
  let issueNumber = 0;
  let creates = 0;
  await withTempDir(async (dir) => {
    const g = gh(listRows);
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: g.fn,
      workDir: dir,
      nowSeconds: () => 1_700_000_000,
      fleetAuthors,
      log: (m) => logs.push(m),
    });
    action = decision.action;
    if (decision.action === "commented") issueNumber = decision.issueNumber;
    creates = g.creates().length;
  });
  return { action, issueNumber, creates };
}

const RUN_MARKER = formatRunFailureMarker("oom");

Deno.test("run failure - a forged marker from outside the fleet does not dedup", async () => {
  const r = await runFailure([row(4200, RUN_MARKER, OUTSIDER)], FLEET);
  assertEquals(
    r.action,
    "filed",
    "an issue nobody in the fleet wrote must not suppress the alert",
  );
  assertEquals(r.creates, 1);
});

Deno.test("run failure - a genuine marker from this host still dedups", async () => {
  const r = await runFailure([row(4200, RUN_MARKER, HOST)], FLEET);
  assertEquals(r.action, "commented");
  assertEquals(r.creates, 0);
});

Deno.test("run failure - a marker filed by a sibling fleet host still dedups", async () => {
  const r = await runFailure([row(4200, RUN_MARKER, SIBLING)], FLEET);
  assertEquals(
    r.action,
    "commented",
    "cross-host convergence: another host's issue is this host's issue",
  );
  assertEquals(r.creates, 0);
});

Deno.test("run failure - an unresolved fleet set raises rather than suppresses", async () => {
  const logs: string[] = [];
  const r = await runFailure([row(4200, RUN_MARKER, HOST)], [], logs);
  assertEquals(r.action, "filed");
  assert(logs.some((l) => l.includes("fleet author set unresolved")));
});

Deno.test("run failure - a forged and a genuine match dedup on the genuine one", async () => {
  const r = await runFailure(
    [row(4100, RUN_MARKER, OUTSIDER), row(4200, RUN_MARKER, SIBLING)],
    FLEET,
  );
  assertEquals(r.action, "commented");
  assertEquals(r.issueNumber, 4200);
});

// ===========================================================================
// 2. idle_inversion_streak.ts
// ===========================================================================

const INVERSION_MARKER = formatIdleInversionMarker(REPO);

async function inversion(
  listRows: unknown[],
  fleetAuthors: readonly string[],
  logs: string[] = [],
) {
  let action = "";
  let issueNumber = 0;
  let creates = 0;
  await withTempDir(async (dir) => {
    const g = gh(listRows);
    const decision = await recordIdleInversion({
      recordFiling: () => Promise.resolve(true),
      statePath: idleInversionStatePath(dir),
      cycleId: "run-1",
      report: { repo: REPO, claimable: 2, detail: "work_on=2" },
      ghFn: g.fn,
      threshold: 1,
      fleetAuthors,
      log: (m) => logs.push(m),
    });
    action = decision.action;
    if (decision.action === "already-open") issueNumber = decision.issueNumber;
    creates = g.creates().length;
  });
  return { action, issueNumber, creates };
}

Deno.test("idle inversion - a forged marker from outside the fleet does not dedup", async () => {
  const r = await inversion([row(555, INVERSION_MARKER, OUTSIDER)], FLEET);
  assertEquals(r.action, "filed");
  assertEquals(r.creates, 1);
});

Deno.test("idle inversion - a genuine marker from this host still dedups", async () => {
  const r = await inversion([row(555, INVERSION_MARKER, HOST)], FLEET);
  assertEquals(r.action, "already-open");
  assertEquals(r.creates, 0);
});

Deno.test("idle inversion - a marker filed by a sibling fleet host still dedups", async () => {
  const r = await inversion([row(555, INVERSION_MARKER, SIBLING)], FLEET);
  assertEquals(r.action, "already-open");
  assertEquals(r.creates, 0);
});

Deno.test("idle inversion - an unresolved fleet set raises rather than suppresses", async () => {
  const logs: string[] = [];
  const r = await inversion([row(555, INVERSION_MARKER, HOST)], [], logs);
  assertEquals(r.action, "filed");
  assert(logs.some((l) => l.includes("fleet author set unresolved")));
});

Deno.test("idle inversion - a forged and a genuine match dedup on the genuine one", async () => {
  const r = await inversion(
    [row(500, INVERSION_MARKER, OUTSIDER), row(555, INVERSION_MARKER, HOST)],
    FLEET,
  );
  assertEquals(r.action, "already-open");
  assertEquals(r.issueNumber, 555, "the fleet's issue, not the forged one");
  assertEquals(r.creates, 0);
});

// ===========================================================================
// 3. bump_script_failure_streak.ts
// ===========================================================================

const BUMP_MARKER = formatBumpScriptFailureMarker(REPO);

async function bump(
  listRows: unknown[],
  fleetAuthors: readonly string[],
  logs: string[] = [],
) {
  let action = "";
  let issueNumber = 0;
  let creates = 0;
  await withTempDir(async (dir) => {
    const g = gh(listRows);
    const decision = await recordBumpScriptRejection({
      statePath: bumpScriptStreakPath(dir),
      report: {
        repo: REPO,
        scriptName: "bump-deps.sh",
        rejectionReason: "`bump-deps.sh` exited with status 1.",
        outputTail: "ERROR: deno is required",
        sourceIssueNumber: 556,
      },
      ghFn: g.fn,
      threshold: 1,
      fleetAuthors,
      log: (m) => logs.push(m),
    });
    action = decision.action;
    if (decision.action === "already_open") issueNumber = decision.issueNumber;
    creates = g.creates().length;
  });
  return { action, issueNumber, creates };
}

Deno.test("bump script - a forged marker from outside the fleet does not dedup", async () => {
  const r = await bump([row(88, BUMP_MARKER, OUTSIDER)], FLEET);
  assertEquals(r.action, "filed");
  assertEquals(r.creates, 1);
});

Deno.test("bump script - a genuine marker from this host still dedups", async () => {
  const r = await bump([row(88, BUMP_MARKER, HOST)], FLEET);
  assertEquals(r.action, "already_open");
  assertEquals(r.creates, 0);
});

Deno.test("bump script - a marker filed by a sibling fleet host still dedups", async () => {
  const r = await bump([row(88, BUMP_MARKER, SIBLING)], FLEET);
  assertEquals(r.action, "already_open");
  assertEquals(r.creates, 0);
});

Deno.test("bump script - an unresolved fleet set raises rather than suppresses", async () => {
  const logs: string[] = [];
  const r = await bump([row(88, BUMP_MARKER, HOST)], [], logs);
  assertEquals(r.action, "filed");
  assert(logs.some((l) => l.includes("fleet author set unresolved")));
});

Deno.test("bump script - a forged and a genuine match dedup on the genuine one", async () => {
  const r = await bump(
    [row(80, BUMP_MARKER, OUTSIDER), row(88, BUMP_MARKER, SIBLING)],
    FLEET,
  );
  assertEquals(r.action, "already_open");
  assertEquals(r.issueNumber, 88, "the fleet's issue, not the forged one");
  assertEquals(r.creates, 0);
});

// ===========================================================================
// 4. pr_branch_update_failure_streak.ts
// ===========================================================================

const BRANCH_MARKER = formatPrBranchFailureMarker(REPO, BRANCH);

async function branchUpdate(
  listRows: unknown[],
  fleetAuthors: readonly string[],
  logs: string[] = [],
) {
  let action = "";
  let issueNumber = 0;
  let creates = 0;
  await withTempDir(async (dir) => {
    const g = gh(listRows);
    const decision = await recordPrBranchUpdateFailure({
      statePath: prBranchFailureStatePath(dir),
      cycleId: "run-1",
      report: {
        repo: REPO,
        prNumber: 3847,
        branch: BRANCH,
        baseBranch: "main",
        error: "pathspec did not match any file(s) known to git",
      },
      ghFn: g.fn,
      threshold: 1,
      fleetAuthors,
      log: (m) => logs.push(m),
    });
    action = decision.action;
    if (decision.action === "already-open") issueNumber = decision.issueNumber;
    creates = g.creates().length;
  });
  return { action, issueNumber, creates };
}

Deno.test("branch update - a forged marker from outside the fleet does not dedup", async () => {
  const r = await branchUpdate([row(77, BRANCH_MARKER, OUTSIDER)], FLEET);
  assertEquals(r.action, "filed");
  assertEquals(r.creates, 1);
});

Deno.test("branch update - a genuine marker from this host still dedups", async () => {
  const r = await branchUpdate([row(77, BRANCH_MARKER, HOST)], FLEET);
  assertEquals(r.action, "already-open");
  assertEquals(r.creates, 0);
});

Deno.test("branch update - a marker filed by a sibling fleet host still dedups", async () => {
  const r = await branchUpdate([row(77, BRANCH_MARKER, SIBLING)], FLEET);
  assertEquals(r.action, "already-open");
  assertEquals(r.creates, 0);
});

Deno.test("branch update - an unresolved fleet set raises rather than suppresses", async () => {
  const logs: string[] = [];
  const r = await branchUpdate([row(77, BRANCH_MARKER, HOST)], [], logs);
  assertEquals(r.action, "filed");
  assert(logs.some((l) => l.includes("fleet author set unresolved")));
});

Deno.test("branch update - a forged and a genuine match dedup on the genuine one", async () => {
  const r = await branchUpdate(
    [row(70, BRANCH_MARKER, OUTSIDER), row(77, BRANCH_MARKER, SIBLING)],
    FLEET,
  );
  assertEquals(r.action, "already-open");
  assertEquals(r.issueNumber, 77, "the fleet's issue, not the forged one");
  assertEquals(r.creates, 0);
});

// ===========================================================================
// 5. idle_starvation_escalation.ts
// ===========================================================================

const STARVATION_MARKER = formatIdleStarvationMarker();
const START_MS = Date.UTC(2026, 7, 26, 0, 0, 0);

function observation(hour: number) {
  return {
    nowMs: START_MS + hour * 3_600_000,
    runId: "run-a",
    idleSlotSeconds: 7200,
    openIdleTasks: 0,
    evidence: {
      slotUtilisation: "slot-utilisation: slots=2 idle_pct=31.4",
      refusalReason: "audit_found_claimable",
      claimableTotal: 24,
      censusLines: ["[idle-census] repo=stSoftwareAU/VibeCoder"],
    },
  };
}

async function starvation(
  listRows: unknown[],
  fleetAuthors: readonly string[],
  logs: string[] = [],
) {
  let action = "";
  let issueNumber = 0;
  let creates = 0;
  await withTempDir(async (dir) => {
    const g = gh(listRows);
    const statePath = idleStarvationStatePath(dir);
    const common = {
      statePath,
      ghFn: g.fn,
      thresholdHours: 1,
      thresholdIdleSlotSeconds: 1,
      fleetAuthors,
      log: (m: string) => logs.push(m),
    };
    // The first observation opens the episode; the second passes both
    // thresholds and reaches the dedup search.
    await recordIdleStarvationObservation({
      ...common,
      observation: observation(0),
    });
    const decision = await recordIdleStarvationObservation({
      ...common,
      observation: observation(2),
    });
    action = decision.action;
    if (decision.action === "already-open") issueNumber = decision.issue;
    creates = g.creates().length;
  });
  return { action, issueNumber, creates };
}

Deno.test("idle starvation - a forged marker from outside the fleet does not dedup", async () => {
  const r = await starvation([row(901, STARVATION_MARKER, OUTSIDER)], FLEET);
  assertEquals(r.action, "filed");
  assertEquals(r.creates, 1);
});

Deno.test("idle starvation - a genuine marker from this host still dedups", async () => {
  const r = await starvation([row(901, STARVATION_MARKER, HOST)], FLEET);
  assertEquals(r.action, "already-open");
  assertEquals(r.creates, 0);
});

Deno.test("idle starvation - a marker filed by a sibling fleet host still dedups", async () => {
  const r = await starvation([row(901, STARVATION_MARKER, SIBLING)], FLEET);
  assertEquals(r.action, "already-open");
  assertEquals(r.creates, 0);
});

Deno.test("idle starvation - an unresolved fleet set raises rather than suppresses", async () => {
  const logs: string[] = [];
  const r = await starvation([row(901, STARVATION_MARKER, HOST)], [], logs);
  assertEquals(r.action, "filed");
  assert(logs.some((l) => l.includes("fleet author set unresolved")));
});

Deno.test("idle starvation - a forged and a genuine match dedup on the genuine one", async () => {
  const r = await starvation(
    [
      row(900, STARVATION_MARKER, OUTSIDER),
      row(901, STARVATION_MARKER, SIBLING),
    ],
    FLEET,
  );
  assertEquals(r.action, "already-open");
  assertEquals(r.issueNumber, 901, "the fleet's issue, not the forged one");
  assertEquals(r.creates, 0);
});
