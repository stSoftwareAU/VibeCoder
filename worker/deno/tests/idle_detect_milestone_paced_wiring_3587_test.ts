/**
 * Production wiring for the milestone-pacing hold in idle detection (Issue
 * #3587).
 *
 * The claim scan skips every issue of a milestone the persisted pacing
 * ledger paces (`milestone-behind`, Issue #1780). The census was wired to
 * honour that hold in Issue #3464, but the idle-detect audit and the idle-task
 * filer's fleet-wide startable gate still counted those issues as startable,
 * so a paced milestone kept the audit reporting claimable work and the filer
 * refusing to file while the scan would never start it. The fix is one shared
 * hold in `run_core_production_deps.ts` (`loadIdleDetectionHold`) that both
 * readers use. This file drives the real `createProductionRunCoreDeps`, with
 * a stub `gh` that returns only the `--json` fields requested (CODING-STANDARDS.md
 * "A stub mirrors the real callee's contract").
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import { MILESTONE_CONFLICT_ATTEMPT_BUDGET } from "../lib/milestone_sync_streak.ts";
import {
  milestoneSyncStreakPath,
  saveSyncStreaks,
  syncStreakKey,
  type SyncStreaks,
} from "../lib/milestone_sync_streak.ts";
import { startSlotIdleAccounting } from "../lib/slot_idle_accounting.ts";
import {
  resetSharedProcessedIssues,
  sharedProcessedIssues,
} from "../lib/processed_issue_registry.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import { TITLE_MARKER_DEDUP_JSON_FIELDS } from "../lib/idle_task_wrapper_dedup.ts";

const REPO = "org/paced-milestone-fixture";
const WORKER_USER = "worker-bot";
const MILESTONE = "Paced Milestone";
const FIXTURE_LABELS = ["work-on"];

/** The one issue's fields, keyed by gh field name. */
const FIXTURE_FIELDS: Record<string, unknown> = {
  number: 3587,
  title: "Issue in a paced milestone",
  labels: FIXTURE_LABELS.map((name) => ({ name })),
  assignees: [],
  milestone: { title: MILESTONE },
  body: "",
  subIssuesSummary: { total: 0, completed: 0 },
};

/** Set when the filer reaches `gh issue create`; the test asserts it stayed false. */
let createAttempts = 0;

/** Every argv the stub answered, in order, so a test can see who reached it. */
const ghCalls: string[][] = [];

/**
 * Mirrors real `gh` for the calls the filer makes: `issue list` returns only
 * the requested `--json` fields, a `--label` filter the fixture does not carry
 * returns no rows, `issue create` is never reached (it throws and is counted).
 */
function stubGh(args: string[]): Promise<string> {
  ghCalls.push([...args]);
  if (args[0] === "issue" && args[1] === "create") {
    createAttempts++;
    return Promise.reject(new Error("issue create must not be reached"));
  }
  if (args[0] === "issue" && args[1] === "list") {
    // A label filter the fixture does not carry, or a title search (the
    // idle-task wrapper lookups), matches nothing: the fixture is not a wrapper.
    const labelAt = args.indexOf("--label");
    if (args.includes("--search")) return Promise.resolve("[]");
    if (labelAt >= 0 && !FIXTURE_LABELS.includes(args[labelAt + 1] ?? "")) {
      return Promise.resolve("[]");
    }
    const jsonAt = args.indexOf("--json");
    if (jsonAt < 0) return Promise.resolve("[]");
    const requested = new Set((args[jsonAt + 1] ?? "").split(","));
    const row: Record<string, unknown> = {};
    for (const field of Object.keys(FIXTURE_FIELDS)) {
      if (requested.has(field)) row[field] = FIXTURE_FIELDS[field];
    }
    return Promise.resolve(JSON.stringify([row]));
  }
  return Promise.resolve("[]");
}

/**
 * Where the factory reads its work dirs. `workDir` is the factory's `workDir`
 * option (and `repoDir`), `configWorkDir` is the `config.workDir` option, and
 * `ledgerDir` is the directory the paced pacing ledger is written to.
 */
interface WorkDirLayout {
  workDir: string;
  configWorkDir: string;
  ledgerDir: string;
}

/** One dir serves as all three operands: the layout the single-dir tests use. */
function sharedLayout(dir: string): WorkDirLayout {
  return { workDir: dir, configWorkDir: dir, ledgerDir: dir };
}

/** Run `body` with a fresh temp dir, removed in `finally`. */
async function withTempDir<T>(
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "idle-paced-3587-" });
  try {
    return await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

/** Run `body` with two fresh temp dirs, both removed in `finally`. */
function withTempDirPair<T>(
  body: (first: string, second: string) => Promise<T>,
): Promise<T> {
  return withTempDir((first) => withTempDir((second) => body(first, second)));
}

/** Build the production deps over the layout, optionally with a paced ledger. */
async function buildDeps(paced: boolean, layout: WorkDirLayout): Promise<{
  deps: Awaited<ReturnType<typeof createProductionRunCoreDeps>>["deps"];
  lines: string[];
}> {
  if (paced) {
    const streaks: SyncStreaks = {
      [syncStreakKey(REPO, createMilestoneBranchName(MILESTONE))]: {
        count: 2,
        escalated: false,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
      },
    };
    await saveSyncStreaks(milestoneSyncStreakPath(layout.ledgerDir), streaks);
  }
  const lines: string[] = [];
  const { deps } = await createProductionRunCoreDeps({
    repoDir: layout.workDir,
    workDir: layout.workDir,
    githubUser: WORKER_USER,
    logger: createLogger({ write: (line: string) => lines.push(line) }),
    config: {
      ...buildDefaultWorkerConfig(),
      repos: [REPO],
      workDir: layout.configWorkDir,
    },
    idleDetectGhCommandFn: stubGh,
  });
  return { deps, lines };
}

/** Run the idle-detect audit once and return its log lines. */
async function auditLines(
  paced: boolean,
  layout: WorkDirLayout,
): Promise<string[]> {
  const { deps, lines } = await buildDeps(paced, layout);
  await deps.runIdleDetectAudit!({
    tick: 1,
    scanFoundClaimable: false,
    scanExcludedRepos: [],
  });
  return lines;
}

/** Run the idle-task filer once, with idle capacity, and return its log lines. */
async function filerLines(
  paced: boolean,
  layout: WorkDirLayout,
): Promise<string[]> {
  // Idle capacity from the #925 slot ledger, so the filer proceeds past its
  // zero-idle-slot early return.
  startSlotIdleAccounting(Date.now(), 2);
  const { deps, lines } = await buildDeps(paced, layout);
  await deps.runIdleTaskFiler!();
  return lines;
}

function repoLine(lines: string[], marker: string): string {
  const line = lines.find((l) =>
    l.includes(marker) && l.includes(`repo=${REPO}`)
  );
  assert(
    line !== undefined,
    `no ${marker} line for the repo; lines:\n${lines.join("\n")}`,
  );
  return line;
}

Deno.test(
  "idle-detect audit - a paced milestone's issue is held as run_local_hold, not claimable (Issue #3587)",
  async () => {
    const lines = await withTempDir((dir) =>
      auditLines(true, sharedLayout(dir))
    );
    const line = repoLine(lines, "[idle-detect]");
    assert(line.includes("claimable=0"), line);
    assert(line.includes("reason=run_local_hold"), line);
    assert(
      !lines.some((l) => l.includes("ALERT mis_classification")),
      `no mis_classification ALERT expected; lines:\n${lines.join("\n")}`,
    );
  },
);

Deno.test(
  "idle-detect audit - without a ledger entry the same issue is claimable (Issue #3587 negative control)",
  async () => {
    const lines = await withTempDir((dir) =>
      auditLines(false, sharedLayout(dir))
    );
    const line = repoLine(lines, "[idle-detect]");
    assert(line.includes("claimable=1"), line);
  },
);

Deno.test(
  "idle-detect audit - a run-local hold with no ledger entry is run_local_hold, not claimable (Issue #3587)",
  async () => {
    // The shared registry is a module singleton: start from empty and undo
    // the record in `finally` so no other test in this file sees it.
    resetSharedProcessedIssues();
    try {
      // A non-deferral finish (not a claim refusal), so the registry operand
      // of `loadIdleDetectionHold` is what holds the issue.
      sharedProcessedIssues().record(REPO, 3587, "failure");
      const lines = await withTempDir((dir) =>
        auditLines(false, sharedLayout(dir))
      );
      const line = repoLine(lines, "[idle-detect]");
      assert(line.includes("claimable=0"), line);
      assert(line.includes("reason=run_local_hold"), line);
    } finally {
      resetSharedProcessedIssues();
    }
  },
);

Deno.test(
  "idle-detect audit - config.workDir wins: the paced ledger in config.workDir holds the issue even when the factory workDir has none (Issue #3587)",
  async () => {
    const line = await withTempDirPair(async (configDir, factoryDir) => {
      const lines = await auditLines(true, {
        workDir: factoryDir,
        configWorkDir: configDir,
        ledgerDir: configDir,
      });
      return repoLine(lines, "[idle-detect]");
    });
    assert(line.includes("claimable=0"), line);
  },
);

Deno.test(
  "idle-detect audit - the factory workDir is the fallback when config.workDir is empty: the paced ledger there holds the issue (Issue #3587)",
  async () => {
    const line = await withTempDir(async (factoryDir) => {
      const lines = await auditLines(true, {
        workDir: factoryDir,
        configWorkDir: "",
        ledgerDir: factoryDir,
      });
      return repoLine(lines, "[idle-detect]");
    });
    assert(line.includes("claimable=0"), line);
  },
);

Deno.test(
  "idle-task filer - a paced milestone's issue is not startable work, so the fleet-wide gate does not hold filing (Issue #3587)",
  async () => {
    const lines = await withTempDir((dir) =>
      filerLines(true, sharedLayout(dir))
    );
    const line = repoLine(lines, "[repo-busy-idle-task]");
    assert(line.includes("scope=real_work"), line);
    assert(line.includes("startable=0"), line);
    assert(
      createAttempts === 0,
      "the filer must not reach gh issue create in this test",
    );
  },
);

Deno.test(
  "idle-task filer - without a ledger entry the same issue is startable work (Issue #3587 negative control)",
  async () => {
    const lines = await withTempDir((dir) =>
      filerLines(false, sharedLayout(dir))
    );
    const line = repoLine(lines, "[repo-busy-idle-task]");
    assert(line.includes("scope=real_work"), line);
    assert(line.includes("startable=1"), line);
    assert(
      createAttempts === 0,
      "the filer must not reach gh issue create in this test",
    );
  },
);

Deno.test(
  "idle-task filer - the back-fill sweep runs through the injected gh stub, not the real runner (Issue #3587)",
  async () => {
    ghCalls.length = 0;
    await withTempDir((dir) => filerLines(false, sharedLayout(dir)));
    // The sweep's per-title search: `--json <dedup fields>,labels --limit 50`,
    // a shape no other filer query uses.
    const sweepSearches = new Set(
      ghCalls.filter((args) =>
        args[0] === "issue" && args[1] === "list" &&
        args[args.indexOf("--repo") + 1] === REPO &&
        args[args.indexOf("--json") + 1] ===
          `${TITLE_MARKER_DEDUP_JSON_FIELDS},labels` &&
        args[args.indexOf("--limit") + 1] === "50"
      ).map((args) => args[args.indexOf("--search") + 1]),
    );
    for (const title of IDLE_TASK_WRAPPER_TITLES) {
      assert(
        sweepSearches.has(`"${title}" in:title`),
        `back-fill search for "${title}" did not reach the stub; calls:\n${
          ghCalls.map((a) => a.join(" ")).join("\n")
        }`,
      );
    }
  },
);
