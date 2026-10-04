/**
 * Replays the GRQ-AutoTrader#1957 timeline — a conflicting milestone-head PR
 * stood down twice (milestone sync, then the gated-head guard) and left for
 * a human to push eight hours later — against the real stall watchdog
 * (#3001), conflict takeover (#2999) and abandon-and-redo (#3000) passes, to
 * check the reworked ladder now reaches MERGEABLE without a human.
 *
 * Issue #3031: at the fixture's `milestone-head-stand-down` moment the
 * merge-conflict pass no longer stands down. The replay runs the real
 * `processMergeConflict` there, which takes the conflict over in that same
 * cycle through a `milestone-fix/**` PR.
 *
 * The fixture's two historical events (the human's push and the PR merging)
 * are deliberately never applied: the replay's own resolvers are what must
 * clear the conflict. Issue #3002, part of #2965.
 */

import { assert, assertEquals } from "@std/assert";
import { FakeGitHub } from "./fixtures/fake_github.ts";
import type { Logger } from "../types.ts";
import {
  gatedHeadMarkerPrefix,
  guardGatedHead,
  resetGatedHeadReportsForTest,
  takeoverAtMs,
} from "../lib/gated_head_guard.ts";
import { processMergeConflict } from "../lib/pr_merge_conflict_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  CONFLICT_OWNER_CHECK_HOURS,
  CONFLICT_RESOLUTION_BUDGET,
  readResolutionAttempts,
} from "../lib/merge_conflict_markers.ts";
import {
  type ConflictStallObservation,
  detectConflictQueueStall,
  repairConflictQueueStall,
} from "../lib/merge_conflict_stall_watchdog.ts";
import type {
  ConflictTakeoverPr,
  TakeoverResolution,
} from "../lib/conflict_takeover.ts";
import {
  abandonAndRestart,
  type AbandonRestartDeps,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
} from "../lib/conflict_abandon_restart.ts";
import {
  type ActiveMilestone,
  escalateSyncConflict,
} from "../lib/milestone_branch_sync.ts";
import type { MilestoneSyncConflict } from "../lib/milestone_sync_conflict.ts";

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

interface FixtureEvent {
  at: string;
  kind: string;
  historical?: boolean;
  mergeSha?: string;
  landed?: boolean;
  ruleTypes?: string[];
}

interface Fixture {
  source: string;
  repo: string;
  workerLogin: string;
  humanLogin: string;
  milestoneIssue: number;
  milestoneTitle: string;
  pr: {
    number: number;
    head: string;
    base: string;
    headCommittedAt: string;
  };
  commits: {
    baseRoot: string;
    baseTip: string;
    initialHead: string;
    syncMerge: string;
    humanPush: string;
  };
  events: FixtureEvent[];
  replay: { tickMinutes: number; endAt: string };
}

const HEX_SHA = /^[0-9a-f]{40}$/;

function validateFixture(raw: unknown): Fixture {
  const f = raw as Fixture;
  if (!f || typeof f !== "object") {
    throw new Error("fixture: not an object");
  }
  for (
    const key of [
      "baseRoot",
      "baseTip",
      "initialHead",
      "syncMerge",
      "humanPush",
    ] as const
  ) {
    const sha = f.commits?.[key];
    if (typeof sha !== "string" || !HEX_SHA.test(sha)) {
      throw new Error(`fixture: commits.${key} is not a 40-hex sha`);
    }
  }
  if (!Array.isArray(f.events) || f.events.length === 0) {
    throw new Error("fixture: events missing");
  }
  for (const event of f.events) {
    if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) {
      throw new Error(`fixture: event has an unparseable 'at': ${event.at}`);
    }
    if (typeof event.kind !== "string") {
      throw new Error("fixture: event missing 'kind'");
    }
  }
  if (!f.pr || typeof f.pr.number !== "number" || !f.pr.head || !f.pr.base) {
    throw new Error("fixture: pr block missing or incomplete");
  }
  if (
    typeof f.pr.headCommittedAt !== "string" ||
    Number.isNaN(Date.parse(f.pr.headCommittedAt))
  ) {
    throw new Error("fixture: pr.headCommittedAt is not a parseable date");
  }
  if (
    !f.replay || typeof f.replay.tickMinutes !== "number" || !f.replay.endAt
  ) {
    throw new Error("fixture: replay block missing or incomplete");
  }
  return f;
}

async function loadFixture(): Promise<Fixture> {
  const raw = await Deno.readTextFile(
    new URL("./fixtures/grq_autotrader_1957_timeline.json", import.meta.url),
  );
  return validateFixture(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// A no-op logger
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

// ---------------------------------------------------------------------------
// A tiny commit graph, plus a ReplayGitHub composing FakeGitHub
// ---------------------------------------------------------------------------

interface Commit {
  parents: string[];
  subject: string;
}

interface PushRecord {
  actor: string;
  branch: string;
  sha: string;
  atMs: number;
}

/** `gh` arguments helpers, mirroring `fake_github.ts`'s own. */
function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The first non-flag positional argument to `gh api`, i.e. the REST path. */
function apiPath(args: string[]): string {
  const valued = new Set([
    "-X",
    "--method",
    "-f",
    "-F",
    "--field",
    "--raw-field",
    "-H",
    "--header",
    "--jq",
    "-q",
    "--input",
  ]);
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (valued.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return a;
  }
  return "";
}

class ReplayGitHub {
  readonly fake: FakeGitHub;
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly pushes: PushRecord[] = [];
  readonly resolveViaLadderCalls: ConflictTakeoverPr[] = [];
  private readonly autoMergeArmed = new Map<number, string>();
  private commitSeq = 0;
  headChangedAtMs: number;
  labelledAtMs: number | undefined;

  constructor(
    fake: FakeGitHub,
    private readonly fixture: Fixture,
  ) {
    this.fake = fake;
    const c = fixture.commits;
    this.commits.set(c.baseRoot, { parents: [], subject: "root" });
    this.commits.set(c.baseTip, {
      parents: [c.baseRoot],
      subject: "Develop tip",
    });
    this.commits.set(c.initialHead, {
      parents: [c.baseRoot],
      subject: "PR head",
    });
    this.commits.set(c.syncMerge, {
      parents: [c.initialHead, c.baseTip],
      subject: "sync merge (never landed)",
    });
    this.branches.set(fixture.pr.base, c.baseTip);
    this.branches.set(fixture.pr.head, c.initialHead);
    this.headChangedAtMs = Date.parse(fixture.pr.headCommittedAt);
  }

  private newSha(): string {
    this.commitSeq++;
    return `c0ffee${this.commitSeq.toString(16)}`.padStart(40, "0");
  }

  newCommit(parents: string[], subject: string): string {
    const sha = this.newSha();
    this.commits.set(sha, { parents, subject });
    return sha;
  }

  ancestryContains(sha: string, ancestor: string): boolean {
    if (sha === ancestor) return true;
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur === ancestor) return true;
      const commit = this.commits.get(cur);
      if (commit) stack.push(...commit.parents);
    }
    return false;
  }

  headTip(): string {
    return this.branches.get(this.fixture.pr.head)!;
  }

  baseTip(): string {
    return this.branches.get(this.fixture.pr.base)!;
  }

  mergeableState(): "MERGEABLE" | "CONFLICTING" {
    return this.ancestryContains(this.headTip(), this.baseTip())
      ? "MERGEABLE"
      : "CONFLICTING";
  }

  /** Merge any OPEN fix PR whose auto-merge is armed into its base. */
  settle(): void {
    for (const [prNumber, armedBy] of [...this.autoMergeArmed.entries()]) {
      const pr = this.fake.prs.get(`${this.fixture.repo}#${prNumber}`);
      if (!pr || pr.state !== "OPEN") continue;
      const baseTip = this.branches.get(pr.base);
      const fixTip = this.branches.get(pr.head);
      if (baseTip === undefined || fixTip === undefined) continue;
      const merged = this.newCommit(
        [baseTip, fixTip],
        `merge ${pr.head} into ${pr.base}`,
      );
      this.branches.set(pr.base, merged);
      this.pushes.push({
        actor: armedBy,
        branch: pr.base,
        sha: merged,
        atMs: this.fake.nowMs,
      });
      if (pr.base === this.fixture.pr.head) {
        this.headChangedAtMs = this.fake.nowMs;
      }
      this.fake.mergePr(this.fixture.repo, prNumber);
      this.autoMergeArmed.delete(prNumber);
    }
  }

  /** The gated-head resolver that always lands the fix (test A). */
  resolveOnFixBranchSucceeds = (
    pr: ConflictTakeoverPr,
    fixBranch: string,
  ): Promise<TakeoverResolution> => {
    const headTip = this.branches.get(pr.headRefName)!;
    const baseTip = this.branches.get(pr.baseRefName)!;
    const fixTip = this.newCommit(
      [headTip, baseTip],
      `resolve conflict on ${fixBranch}`,
    );
    this.branches.set(fixBranch, fixTip);
    this.pushes.push({
      actor: this.fake.actor,
      branch: fixBranch,
      sha: fixTip,
      atMs: this.fake.nowMs,
    });
    return Promise.resolve({
      resolved: true,
      detail: "merged the default branch into the fix branch and resolved it",
    });
  };

  /** The gated-head resolver that never lands the fix (test B). */
  resolveOnFixBranchFails = (
    _pr: ConflictTakeoverPr,
    _fixBranch: string,
  ): Promise<TakeoverResolution> =>
    Promise.resolve({
      resolved: false,
      detail: "conflict could not be resolved",
    });

  /** Marker-free contract seam: must never run for this gated head. */
  resolveViaLadder = (pr: ConflictTakeoverPr): Promise<TakeoverResolution> => {
    this.resolveViaLadderCalls.push(pr);
    return Promise.resolve({
      resolved: false,
      detail: "ladder must not push a gated head",
    });
  };

  observation(repo: string, prNumber: number): ConflictStallObservation {
    const issue = this.fake.issue(repo, prNumber);
    return {
      repo,
      prNumber,
      labels: [...issue.labels],
      ...(this.labelledAtMs !== undefined
        ? { labelledAtMs: this.labelledAtMs }
        : {}),
      comments: issue.comments.map((c) => ({
        body: c.body,
        created_at: c.at,
        user: { login: c.author },
      })),
      mergeableState: this.mergeableState(),
      baseRefOid: this.baseTip(),
      headRefOid: this.headTip(),
      headChangedAtMs: this.headChangedAtMs,
    };
  }

  /** The combined `gh` seam: a handful of intercepts, else the fake. */
  gh = async (args: string[]): Promise<string> => {
    const handled = await this.dispatch(args);
    if (handled !== undefined) return handled;
    return this.fake.gh(args);
  };

  private async dispatch(args: string[]): Promise<string | undefined> {
    const [a0, a1] = args;
    const repo = flagVal(args, "--repo") ?? "";

    if (a0 === "pr" && a1 === "view") {
      const n = Number(args[2]);
      const jq = flagVal(args, "--jq");
      const jsonFields = (flagVal(args, "--json") ?? "").split(",");
      if (jsonFields.includes("comments")) {
        const issue = this.fake.issue(repo, n);
        return JSON.stringify({
          comments: issue.comments.map((c) => ({ body: c.body })),
        });
      }
      if (jq === ".labels[].name") {
        const issue = this.fake.issue(repo, n);
        return issue.labels.join("\n");
      }
      if (n === this.fixture.pr.number) {
        const issue = this.fake.issue(repo, n);
        return JSON.stringify({
          headRefName: this.fixture.pr.head,
          baseRefName: this.fixture.pr.base,
          headRefOid: this.headTip(),
          mergeable: this.mergeableState(),
          labels: issue.labels.map((name) => ({ name })),
        });
      }
      return undefined;
    }

    if (a0 === "pr" && a1 === "comment") {
      const n = Number(args[2]);
      const body = flagVal(args, "--body") ?? "";
      const issue = this.fake.issue(repo, n);
      issue.comments.push({
        author: this.fake.actor,
        body,
        at: this.fake.now(),
      });
      return `https://github.com/${repo}/issues/${n}#issuecomment-${issue.comments.length}`;
    }

    if (a0 === "pr" && a1 === "create") {
      const base = flagVal(args, "--base") ?? "";
      const head = flagVal(args, "--head") ?? "";
      const title = flagVal(args, "--title") ?? "";
      const body = flagVal(args, "--body") ?? "";
      const pr = this.fake.openPr({
        repo,
        title,
        body,
        author: this.fake.actor,
        head,
        base,
      });
      return `https://github.com/${repo}/pull/${pr.number}`;
    }

    if (a0 === "pr" && a1 === "merge") {
      const n = Number(args[2]);
      this.autoMergeArmed.set(n, this.fake.actor);
      return "";
    }

    if (a0 === "api") {
      const method = (flagVal(args, "-X") ?? "GET").toUpperCase();
      const path = apiPath(args);

      const rules = path.match(/^repos\/[^/]+\/[^/]+\/rules\/branches\/(.+)$/);
      if (rules) {
        const branch = rules[1]!;
        return branch.startsWith("milestone/")
          ? JSON.stringify([{ type: "pull_request" }])
          : "[]";
      }

      const commit = path.match(/^repos\/[^/]+\/[^/]+\/commits\/(.+)$/);
      if (commit) {
        const ref = commit[1]!;
        const sha = this.branches.get(ref) ??
          (this.commits.has(ref) ? ref : undefined);
        if (sha === undefined) {
          throw new Error(`replay: unknown ref '${ref}'`);
        }
        const found = this.commits.get(sha)!;
        return `${sha} ${found.subject}`;
      }

      const compare = path.match(
        /^repos\/[^/]+\/[^/]+\/compare\/([^.]+)\.\.\.(.+)$/,
      );
      if (compare) {
        const a = compare[1]!;
        const b = compare[2]!;
        let status: string;
        if (a === b) status = "identical";
        else if (this.ancestryContains(b, a)) status = "ahead";
        else if (this.ancestryContains(a, b)) status = "behind";
        else status = "diverged";
        return JSON.stringify({ status });
      }

      const reviewers = path.match(
        /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/requested_reviewers$/,
      );
      if (reviewers && method === "GET") {
        return JSON.stringify({ users: [], teams: [] });
      }
    }

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Abandon-ran classification
// ---------------------------------------------------------------------------

function abandonRan(outcome: AbandonRestartOutcome): boolean {
  return !(
    outcome.outcome === "declined" &&
    outcome.reason.kind === "attempts-not-spent"
  );
}

function makeAbandonRecorder(
  repl: ReplayGitHub,
  sink: Array<{ atMs: number; outcome: AbandonRestartOutcome }>,
): (
  request: AbandonRestartRequest,
  deps: AbandonRestartDeps,
) => Promise<AbandonRestartOutcome> {
  return async (request, deps) => {
    const outcome = await abandonAndRestart(request, deps);
    sink.push({ atMs: repl.fake.nowMs, outcome });
    return outcome;
  };
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

interface SyncReportRecord {
  event: FixtureEvent;
  posted: boolean;
  landingKind: string;
}

interface ReplayResult {
  fixture: Fixture;
  repl: ReplayGitHub;
  fake: FakeGitHub;
  firstMergeableAtMs: number | undefined;
  finalMergeable: "MERGEABLE" | "CONFLICTING";
  watchdogActions: Array<{ atMs: number; action: string }>;
  abandonProbes: Array<{ atMs: number; outcome: AbandonRestartOutcome }>;
  abandonFromWatchdog: Array<{ atMs: number; outcome: AbandonRestartOutcome }>;
  syncReports: SyncReportRecord[];
  /** What the merge-conflict pass reported at its first sighting (Issue #3031). */
  passSummaries: string[];
}

interface ReplayOptions {
  resolveOnFixBranch: (
    repl: ReplayGitHub,
  ) => (
    pr: ConflictTakeoverPr,
    fixBranch: string,
  ) => Promise<TakeoverResolution>;
  endAt?: string;
}

async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  resetGatedHeadReportsForTest();
  const fixture = await loadFixture();
  const { repo, workerLogin } = fixture;
  const prNumber = fixture.pr.number;
  const endAtMs = Date.parse(options.endAt ?? fixture.replay.endAt);
  const tickMs = fixture.replay.tickMinutes * 60_000;

  const fake = new FakeGitHub({
    startIso: fixture.events[0]!.at,
    defaultBranch: fixture.pr.base,
  });
  fake.actor = workerLogin;
  fake.addIssue({
    repo,
    number: prNumber,
    title: `Milestone ${fixture.milestoneIssue} completion`,
    author: workerLogin,
  });
  fake.addIssue({
    repo,
    number: fixture.milestoneIssue,
    title: fixture.milestoneTitle,
    author: workerLogin,
  });

  const repl = new ReplayGitHub(fake, fixture);

  const isTrustedAuthor = (login: string) => login === workerLogin;
  const rejectingResolveContext = () =>
    Promise.reject(new Error("replay stops at the originating-issue lookup"));

  const watchdogActions: Array<{ atMs: number; action: string }> = [];
  const abandonProbes: Array<{ atMs: number; outcome: AbandonRestartOutcome }> =
    [];
  const abandonFromWatchdog: Array<
    { atMs: number; outcome: AbandonRestartOutcome }
  > = [];
  const syncReports: SyncReportRecord[] = [];
  const passSummaries: string[] = [];

  const watchdogAbandonRecorder = makeAbandonRecorder(
    repl,
    abandonFromWatchdog,
  );
  const resolveOnFixBranch = options.resolveOnFixBranch(repl);

  const milestone: ActiveMilestone = {
    milestoneTitle: fixture.milestoneTitle,
    milestoneNumber: 1,
    milestoneBranch: fixture.pr.head,
    defaultBranch: fixture.pr.base,
  };

  async function applyEvent(event: FixtureEvent): Promise<void> {
    switch (event.kind) {
      case "conflict-labelled": {
        await repl.gh([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${prNumber}/labels`,
          "-f",
          "labels[]=merge-conflict",
        ]);
        repl.labelledAtMs = fake.nowMs;
        return;
      }
      case "milestone-head-stand-down": {
        // Historically a stand-down; since Issue #3031 the merge-conflict
        // pass takes the milestone head over in this same cycle.
        if (repl.mergeableState() === "CONFLICTING") {
          const result = await processMergeConflict(
            {
              repo,
              prNumber,
              branchName: fixture.pr.head,
              baseBranch: fixture.pr.base,
              attemptCount: 0,
            },
            {
              logger: silentLogger,
              deps: createMockDeps({ github: { runGhCommand: repl.gh } }),
              workDir: "/nonexistent-clone",
              workRoot: "/nonexistent-root",
              trustedAuthors: [workerLogin],
              takeoverResolvers: {
                resolveViaLadder: repl.resolveViaLadder,
                resolveOnFixBranch,
              },
            },
          );
          if (!result.ok) throw result.error;
          passSummaries.push(result.value.summary);
        }
        return;
      }
      case "milestone-sync-run": {
        const conflict: MilestoneSyncConflict = {
          files: ["src/example.ts"],
          milestoneSha: fixture.commits.initialHead,
          defaultSha: fixture.commits.baseTip,
          resolution: "auto",
          mergeSha: event.mergeSha ?? fixture.commits.syncMerge,
        };
        const report = await escalateSyncConflict(
          repo,
          milestone,
          conflict,
          repl.gh,
          () => {},
          { fleetAuthors: [workerLogin] },
        );
        syncReports.push({
          event,
          posted: report.posted,
          landingKind: report.landing.kind,
        });
        return;
      }
      case "gated-head-stand-down": {
        if (repl.mergeableState() === "CONFLICTING") {
          await guardGatedHead({
            repo,
            prNumber,
            branchName: fixture.pr.head,
            pass: "merge-conflict resolution",
            logger: silentLogger,
            runGhCommand: repl.gh,
            nowMs: () => fake.nowMs,
          });
        }
        return;
      }
      case "human-push":
      case "pr-merged":
        // Historical only — the replay must never apply either.
        return;
      default:
        throw new Error(`replay: unhandled fixture event kind '${event.kind}'`);
    }
  }

  async function watchdogTick(): Promise<void> {
    const stall = detectConflictQueueStall(
      repl.observation(repo, prNumber),
      { nowMs: fake.nowMs, isTrustedAuthor },
    );
    if (stall === null) return;
    const action = await repairConflictQueueStall(stall, {
      ghCommandFn: repl.gh,
      logger: silentLogger,
      isTrustedAuthor,
      nowMs: fake.nowMs,
      trustedAuthors: [workerLogin],
      acquireLease: () => ({ release() {} }),
      takeoverResolvers: {
        resolveViaLadder: repl.resolveViaLadder,
        resolveOnFixBranch,
      },
      abandon: watchdogAbandonRecorder,
      abandonDeps: { resolveContext: rejectingResolveContext },
    });
    watchdogActions.push({ atMs: fake.nowMs, action });
  }

  async function abandonProbeTick(): Promise<void> {
    const outcome = await abandonAndRestart(
      {
        repo,
        prNumber,
        branchName: fixture.pr.head,
        baseBranch: fixture.pr.base,
        reason: { kind: "merge-conflict" },
      },
      {
        gh: repl.gh,
        trustedAuthors: [workerLogin],
        logger: silentLogger,
        resolveContext: rejectingResolveContext,
      },
    );
    abandonProbes.push({ atMs: fake.nowMs, outcome });
  }

  fake.nowMs = Date.parse(fixture.events[0]!.at);
  const applied = new Set<number>();
  let firstMergeableAtMs: number | undefined;

  while (fake.nowMs <= endAtMs) {
    repl.settle();

    for (let i = 0; i < fixture.events.length; i++) {
      if (applied.has(i)) continue;
      const event = fixture.events[i]!;
      const atMs = Date.parse(event.at);
      if (atMs > fake.nowMs) continue;
      if (event.historical) {
        applied.add(i);
        continue;
      }
      await applyEvent(event);
      applied.add(i);
    }

    if (
      repl.mergeableState() === "MERGEABLE" && firstMergeableAtMs === undefined
    ) {
      firstMergeableAtMs = fake.nowMs;
    }

    if (repl.mergeableState() === "CONFLICTING") {
      await watchdogTick();
      await abandonProbeTick();
    }

    if (fake.nowMs >= endAtMs) break;

    let nextEventMs = Infinity;
    for (let i = 0; i < fixture.events.length; i++) {
      if (applied.has(i) || fixture.events[i]!.historical) continue;
      const atMs = Date.parse(fixture.events[i]!.at);
      if (atMs > fake.nowMs && atMs < nextEventMs) nextEventMs = atMs;
    }
    fake.nowMs = Math.min(fake.nowMs + tickMs, nextEventMs, endAtMs);
  }

  return {
    fixture,
    repl,
    fake,
    firstMergeableAtMs,
    finalMergeable: repl.mergeableState(),
    watchdogActions,
    abandonProbes,
    abandonFromWatchdog,
    syncReports,
    passSummaries,
  };
}

// ---------------------------------------------------------------------------
// Shared stand-down comment checks
// ---------------------------------------------------------------------------

const STAND_DOWN_TIME_PATTERN =
  /\*\*Owner:\*\* `(milestone sync|conflict takeover)`[\s\S]*?\*\*Takeover at (\S+Z)\*\* \(UTC\)/;

function standDownComments(
  comments: Array<{ body: string; at: string }>,
  branch: string,
): Array<{ body: string; at: string }> {
  const prefixes = [
    // The retired merge-conflict stand-down (Issue #3031) — must never appear.
    `<!-- vibe-milestone-head branch="${branch}"`,
    gatedHeadMarkerPrefix(branch),
  ];
  return comments.filter((c) => prefixes.some((p) => c.body.includes(p)));
}

function assertStandDownShape(
  comments: Array<{ body: string; at: string }>,
): void {
  for (const comment of comments) {
    const match = STAND_DOWN_TIME_PATTERN.exec(comment.body);
    assert(
      match !== null,
      `stand-down comment missing owner/takeover-at shape: ${comment.body}`,
    );
    const takeoverIso = match![2]!;
    const expected = takeoverAtMs(Date.parse(comment.at));
    assertEquals(Date.parse(takeoverIso), expected);
  }
}

/**
 * No sync report may claim a merge that is not on the milestone tip or in a
 * sync PR — i.e. every posted report's landing kind is "tip" or "sync-pr".
 */
function assertSyncReportsConfirmed(result: ReplayResult): void {
  for (const r of result.syncReports) {
    assert(
      !r.posted || r.landingKind === "tip" || r.landingKind === "sync-pr",
      `sync report posted with unconfirmed landing kind '${r.landingKind}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test A — reaches MERGEABLE with no human push
// ---------------------------------------------------------------------------

Deno.test(
  "replays the GRQ-AutoTrader#1957 timeline to MERGEABLE with no human push",
  async () => {
    const result = await runReplay({
      resolveOnFixBranch: (repl) => repl.resolveOnFixBranchSucceeds,
    });
    const { fixture, repl, fake } = result;
    const humanPushAtMs = Date.parse(
      fixture.events.find((e) => e.kind === "human-push")!.at,
    );

    // 1. Reaches MERGEABLE, promptly, before any human push.
    assertEquals(result.finalMergeable, "MERGEABLE");
    assert(result.firstMergeableAtMs !== undefined);
    assert(result.firstMergeableAtMs! < humanPushAtMs);

    // Issue #3031: the merge-conflict pass takes the milestone head over in
    // the cycle that first sees it, so the fix PR lands within a tick or two
    // of that sighting — not after a two-hour stand-down.
    const firstSightingEvent = fixture.events.find(
      (e) => e.kind === "milestone-head-stand-down",
    )!;
    const firstSightingAtMs = Date.parse(firstSightingEvent.at);
    assert(
      result.firstMergeableAtMs! <=
        firstSightingAtMs + 2 * fixture.replay.tickMinutes * 60_000,
    );
    assertEquals(result.passSummaries.length, 1);
    assert(result.passSummaries[0]!.includes("fix PR"));

    // 2. Every push is the worker's, never the human's, never the historical sha.
    assert(repl.pushes.length >= 1);
    for (const push of repl.pushes) {
      assertEquals(push.actor, fixture.workerLogin);
      assert(push.actor !== fixture.humanLogin);
      assert(push.sha !== fixture.commits.humanPush);
    }

    // 3. No stand-down was posted: the conflict was resolved before the
    // gated-head guard's event, and the milestone stand-down is gone.
    const issue = fake.issue(fixture.repo, fixture.pr.number);
    const standDowns = standDownComments(issue.comments, fixture.pr.head);
    assertEquals(standDowns, []);

    // 4. The shared budget was touched, but never exceeded.
    const attempts = readResolutionAttempts(
      issue.comments.map((c) => ({
        body: c.body,
        user: { login: c.author },
        created_at: c.at,
      })),
      (login) => login === fixture.workerLogin,
    );
    assert(attempts.length >= 1);
    assert(attempts.length <= CONFLICT_RESOLUTION_BUDGET);

    // 5. The sync report never claims an unconfirmed landing — the 03:59 run
    // specifically, plus every report across the whole replay.
    const syncRun = result.syncReports.find(
      (r) => r.event.kind === "milestone-sync-run",
    )!;
    assertEquals(syncRun.posted, false);
    assertEquals(syncRun.landingKind, "unconfirmed");
    const milestoneIssue = fake.issue(fixture.repo, fixture.milestoneIssue);
    for (const comment of milestoneIssue.comments) {
      assert(!comment.body.includes(fixture.commits.syncMerge));
    }
    assertSyncReportsConfirmed(result);

    // 6. No abandon ever ran.
    for (const probe of result.abandonProbes) {
      assert(!abandonRan(probe.outcome));
    }
    assertEquals(result.abandonFromWatchdog.length, 0);

    // 7. Exactly one fix PR was opened, and the watchdog never needed to
    // take over.
    const fixPrs = [...fake.prs.values()].filter((pr) =>
      pr.base === fixture.pr.head && pr.head.startsWith("milestone-fix/")
    );
    assertEquals(fixPrs.length, 1);
    assertEquals(
      result.watchdogActions.filter((a) => a.action === "taken-over"),
      [],
    );

    // 8. The gated head was never pushed via the ladder directly.
    assertEquals(repl.resolveViaLadderCalls.length, 0);

    // 9. The fix reached the PR head itself, not only a side branch.
    assert(repl.pushes.some((p) => p.branch === fixture.pr.head));

    // 10. Every `gh` invocation was recognised.
    assertEquals(fake.unknownCommands, []);
  },
);

// ---------------------------------------------------------------------------
// Test B — bounded at 3 attempts, abandons only once the third has failed
// ---------------------------------------------------------------------------

Deno.test(
  "bounds the replay at 3 attempts and abandons only once the third has failed",
  async () => {
    const result = await runReplay({
      resolveOnFixBranch: (repl) => repl.resolveOnFixBranchFails,
      endAt: "2026-10-01T10:30:00Z",
    });
    const { fixture, repl, fake } = result;

    const issue = fake.issue(fixture.repo, fixture.pr.number);
    const rawComments = issue.comments.map((c) => ({
      body: c.body,
      user: { login: c.author },
      created_at: c.at,
    }));
    const attempts = readResolutionAttempts(
      rawComments,
      (login) => login === fixture.workerLogin,
    );
    assertEquals(attempts.length, CONFLICT_RESOLUTION_BUDGET);

    // Attempts are judged at least CONFLICT_OWNER_CHECK_HOURS apart.
    const attemptTimes = attempts
      .map((a) => a.atMs)
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => a - b);
    for (let i = 1; i < attemptTimes.length; i++) {
      assert(
        attemptTimes[i]! - attemptTimes[i - 1]! >=
          CONFLICT_OWNER_CHECK_HOURS * 3_600_000,
      );
    }

    // Only the gated-head guard stood down; the milestone stand-down is gone
    // (Issue #3031), and what is posted carries the owner/takeover-at shape.
    const standDowns = standDownComments(issue.comments, fixture.pr.head);
    assertEquals(standDowns.length, 1);
    assertStandDownShape(standDowns);

    // The first attempt was the merge-conflict pass's own takeover, in the
    // cycle that first saw the PR, and it counts as one failed attempt.
    const firstStandDownEvent = fixture.events.find(
      (e) => e.kind === "milestone-head-stand-down",
    )!;
    const firstStandDownAtMs = Date.parse(firstStandDownEvent.at);
    assertEquals(attemptTimes[0], firstStandDownAtMs);
    assertEquals(attempts[0]!.outcome, "failed");

    // Abandon ran, but not before the budget was genuinely spent: no earlier
    // than the third attempt, which the owner-check spacing puts at least
    // two windows after that first sighting.
    const ranTimes = [
      ...result.abandonProbes.filter((p) => abandonRan(p.outcome)).map((p) =>
        p.atMs
      ),
      ...result.abandonFromWatchdog.filter((p) => abandonRan(p.outcome)).map(
        (p) => p.atMs,
      ),
    ];
    assert(ranTimes.length >= 1, "abandon never ran");
    const firstAbandonRanAtMs = Math.min(...ranTimes);
    assert(firstAbandonRanAtMs >= attemptTimes[2]!);
    assert(
      firstAbandonRanAtMs >=
        firstStandDownAtMs +
          (CONFLICT_RESOLUTION_BUDGET - 1) * CONFLICT_OWNER_CHECK_HOURS *
            3_600_000,
    );

    // No push ever landed, let alone a human one.
    assertEquals(repl.pushes.length, 0);

    // Every probe/watchdog outcome classified as "ran" actually passed the
    // budget guard and reached the stubbed originating-issue lookup, where
    // the replay deliberately stops — not some earlier failure such as
    // "failed" at step "pr-thread".
    const allOutcomes = [
      ...result.abandonProbes,
      ...result.abandonFromWatchdog,
    ];
    for (const { outcome } of allOutcomes) {
      if (!abandonRan(outcome)) continue;
      assert(
        outcome.outcome === "failed" && outcome.step === "originating-issue",
        `unexpected abandon outcome: ${JSON.stringify(outcome)}`,
      );
    }

    // Every abandon probe before the third attempt's time declined because
    // the budget had not yet been spent.
    const thirdAttemptAtMs = attemptTimes[2]!;
    for (const probe of result.abandonProbes) {
      if (probe.atMs >= thirdAttemptAtMs) continue;
      assertEquals(probe.outcome.outcome, "declined");
      assert(probe.outcome.outcome === "declined");
      assertEquals(probe.outcome.reason.kind, "attempts-not-spent");
    }

    // The watchdog itself routed to abandon once the budget was spent.
    assert(
      result.abandonFromWatchdog.length >= 1,
      "watchdog never routed to abandon",
    );

    assertSyncReportsConfirmed(result);

    assertEquals(fake.unknownCommands, []);
  },
);
