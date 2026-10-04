/**
 * The shared driver for the conflict-stall fixture replays — the
 * GRQ-AutoTrader#1957 replay (Issue #3002) and the GRQ-AutoTrader#2028
 * replay (Issue #3036).
 *
 * Holds what both replays need and nothing either asserts: the fixture
 * shape and its validation, a silent logger, and {@link ReplayGitHub} — a
 * tiny commit graph plus the `gh` and `git` intercepts the merge-conflict
 * pass, the stall watchdog and the abandon rungs call, composed over
 * {@link FakeGitHub}. Each replay keeps its own cycle loop and assertions.
 *
 * Not a test file: it is imported by the `conflict_*_replay_test.ts` files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import type { FakeGitHub } from "./fake_github.ts";
import type { Logger, Result } from "../../types.ts";
import {
  gatedHeadMarkerPrefix,
  takeoverAtMs,
} from "../../lib/gated_head_guard.ts";
import type { ConflictStallObservation } from "../../lib/merge_conflict_stall_watchdog.ts";
import type {
  ConflictTakeoverPr,
  TakeoverResolution,
} from "../../lib/conflict_takeover.ts";
import {
  abandonAndRestart,
  type AbandonRestartDeps,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
} from "../../lib/conflict_abandon_restart.ts";
import type { MilestoneSyncPrOutcome } from "../../lib/milestone_sync_pr.ts";

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export interface FixtureEvent {
  at: string;
  kind: string;
  historical?: boolean;
  mergeSha?: string;
  landed?: boolean;
  ruleTypes?: string[];
  actor?: string;
  sha?: string;
}

/** One sub-PR that merged into the milestone head before the conflict. */
export interface FixtureSubPr {
  number: number;
  headRefName: string;
  body: string;
  mergedAt: string;
  mergeCommit: string;
}

export interface Fixture {
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
    syncMerge?: string;
    humanPush?: string;
  };
  /** Sub-PRs merged into the head, in merge order (Issue #3036). */
  subPrs?: FixtureSubPr[];
  events: FixtureEvent[];
  replay: { tickMinutes: number; endAt: string };
}

const HEX_SHA = /^[0-9a-f]{40}$/;

function assertSha(value: unknown, where: string): void {
  if (typeof value !== "string" || !HEX_SHA.test(value)) {
    throw new Error(`fixture: ${where} is not a 40-hex sha`);
  }
}

function assertDate(value: unknown, where: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`fixture: ${where} is not a parseable date`);
  }
}

export function validateFixture(raw: unknown): Fixture {
  const f = raw as Fixture;
  if (!f || typeof f !== "object") {
    throw new Error("fixture: not an object");
  }
  for (const key of ["baseRoot", "baseTip", "initialHead"] as const) {
    assertSha(f.commits?.[key], `commits.${key}`);
  }
  for (const key of ["syncMerge", "humanPush"] as const) {
    if (f.commits[key] !== undefined) {
      assertSha(f.commits[key], `commits.${key}`);
    }
  }
  for (const sub of f.subPrs ?? []) {
    if (!Number.isSafeInteger(sub.number) || !sub.headRefName) {
      throw new Error("fixture: a sub-PR is missing its number or head");
    }
    assertSha(sub.mergeCommit, `subPrs #${sub.number} mergeCommit`);
    assertDate(sub.mergedAt, `subPrs #${sub.number} mergedAt`);
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
  assertDate(f.pr.headCommittedAt, "pr.headCommittedAt");
  if (
    !f.replay || typeof f.replay.tickMinutes !== "number" || !f.replay.endAt
  ) {
    throw new Error("fixture: replay block missing or incomplete");
  }
  return f;
}

/** Load and validate a fixture beside this module, by file name. */
export async function loadFixture(fileName: string): Promise<Fixture> {
  const raw = await Deno.readTextFile(
    new URL(`./${fileName}`, import.meta.url),
  );
  return validateFixture(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// A no-op logger
// ---------------------------------------------------------------------------

export const silentLogger: Logger = {
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

export interface Commit {
  parents: string[];
  subject: string;
  /** Who authored it — the head must carry no commit from outside the fleet. */
  author: string;
}

export interface PushRecord {
  actor: string;
  branch: string;
  sha: string;
  atMs: number;
}

/** A sync PR the milestone rebuild raised through {@link ReplayGitHub.raiseSyncPr}. */
export interface SyncPrRecord {
  prNumber: number;
  branch: string;
  sha: string;
  openedAtMs: number;
}

/** What the replay's `git` seam returns — the rebuild's runner shape. */
export interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
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

/** The base author: whoever landed the default branch's own commits. */
const BASE_AUTHOR = "default-branch-history";

export class ReplayGitHub {
  readonly fake: FakeGitHub;
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly pushes: PushRecord[] = [];
  readonly resolveViaLadderCalls: ConflictTakeoverPr[] = [];
  readonly syncPrs: SyncPrRecord[] = [];
  /** Every sha the rebuild detached onto (Issue #3036). */
  readonly detachedOnto: string[] = [];
  private readonly autoMergeArmed = new Map<number, string>();
  private commitSeq = 0;
  private detachedHead: string | undefined;
  headChangedAtMs: number;
  labelledAtMs: number | undefined;

  constructor(
    fake: FakeGitHub,
    private readonly fixture: Fixture,
  ) {
    this.fake = fake;
    const c = fixture.commits;
    const worker = fixture.workerLogin;
    this.commits.set(c.baseRoot, {
      parents: [],
      subject: "root",
      author: BASE_AUTHOR,
    });
    this.commits.set(c.baseTip, {
      parents: [c.baseRoot],
      subject: "Develop tip",
      author: BASE_AUTHOR,
    });
    // The sub-PRs landed on the head one after another, then the head tip.
    let previous = c.baseRoot;
    for (const sub of fixture.subPrs ?? []) {
      this.commits.set(sub.mergeCommit, {
        parents: [previous],
        subject: `merge #${sub.number}`,
        author: worker,
      });
      previous = sub.mergeCommit;
    }
    this.commits.set(c.initialHead, {
      parents: [previous],
      subject: "PR head",
      author: worker,
    });
    if (c.syncMerge !== undefined) {
      this.commits.set(c.syncMerge, {
        parents: [c.initialHead, c.baseTip],
        subject: "sync merge (never landed)",
        author: worker,
      });
    }
    this.branches.set(fixture.pr.base, c.baseTip);
    this.branches.set(fixture.pr.head, c.initialHead);
    this.headChangedAtMs = Date.parse(fixture.pr.headCommittedAt);
  }

  private newSha(): string {
    this.commitSeq++;
    return `c0ffee${this.commitSeq.toString(16)}`.padStart(40, "0");
  }

  newCommit(
    parents: string[],
    subject: string,
    author = this.fake.actor,
  ): string {
    const sha = this.newSha();
    this.commits.set(sha, { parents, subject, author });
    return sha;
  }

  /** Every commit reachable from `sha`, `sha` included. */
  ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const commit = this.commits.get(cur);
      if (commit) stack.push(...commit.parents);
    }
    return seen;
  }

  ancestryContains(sha: string, ancestor: string): boolean {
    return this.ancestors(sha).has(ancestor);
  }

  /** Authors of the head's own commits — those not already on the base. */
  headOnlyAuthors(): Set<string> {
    const onBase = this.ancestors(this.baseTip());
    const authors = new Set<string>();
    for (const sha of this.ancestors(this.headTip())) {
      if (!onBase.has(sha)) authors.add(this.commits.get(sha)!.author);
    }
    return authors;
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
        armedBy,
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

  /** The gated-head resolver that always lands the fix. */
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

  /** The gated-head resolver that never lands the fix. */
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

  /**
   * The milestone rebuild's `git` seam over the commit graph (Issue #3036).
   *
   * A direct push to a `milestone/**` branch is refused as a ruleset
   * violation, as the fixture's own rules intercept says, so the rebuild
   * lands through {@link raiseSyncPr}.
   */
  git = (args: string[]): Promise<GitOutcome> => {
    const ok = (stdout = ""): Promise<GitOutcome> =>
      Promise.resolve({ code: 0, stdout, stderr: "" });
    const [verb] = args;
    if (verb === "fetch") return ok();
    if (verb === "rev-parse" && args.includes("--verify")) {
      const ref = args[args.length - 1]!;
      const match = /^refs\/remotes\/origin\/(.+)\^\{commit\}$/.exec(ref);
      const sha = match ? this.branches.get(match[1]!) : undefined;
      return sha === undefined
        ? Promise.resolve({ code: 128, stdout: "", stderr: `bad ref ${ref}` })
        : ok(`${sha}\n`);
    }
    if (verb === "rev-parse" && args[1] === "HEAD") {
      return ok(`${this.detachedHead ?? ""}\n`);
    }
    if (verb === "checkout" && args[1] === "--detach") {
      this.detachedHead = args[2]!;
      this.detachedOnto.push(args[2]!);
      return ok();
    }
    if (verb === "rev-list") {
      const sha = args[args.length - 1]!;
      const commit = this.commits.get(sha);
      return commit === undefined
        ? Promise.resolve({
          code: 128,
          stdout: "",
          stderr: `bad object ${sha}`,
        })
        : ok([sha, ...commit.parents].join(" "));
    }
    if (verb === "cherry-pick") {
      const sha = args[args.length - 1]!;
      this.detachedHead = this.newCommit(
        [this.detachedHead!],
        `replay ${this.commits.get(sha)?.subject ?? sha}`,
      );
      return ok();
    }
    if (verb === "reset") return ok();
    if (verb === "merge") {
      const ref = args[args.length - 1]!;
      const branch = ref.replace(/^refs\/remotes\/origin\//, "");
      this.detachedHead = this.newCommit(
        [this.detachedHead!, this.branches.get(branch)!],
        `rebuild ${branch}`,
      );
      return ok();
    }
    if (verb === "push") {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "remote: error: GH013: Repository rule violations found",
      });
    }
    throw new Error(`replay: unhandled git call ${JSON.stringify(args)}`);
  };

  /**
   * The milestone sync-PR seam (Issue #3036): the rebuild is pushed to a
   * sync branch and raised as a PR into the milestone head, armed to merge.
   */
  raiseSyncPr = (
    repo: string,
    milestoneBranch: string,
    _defaultBranch: string,
  ): Promise<Result<MilestoneSyncPrOutcome>> => {
    const sha = this.detachedHead!;
    const branch = `sync/${milestoneBranch.replace(/^milestone\//, "")}`;
    this.branches.set(branch, sha);
    this.pushes.push({
      actor: this.fake.actor,
      branch,
      sha,
      atMs: this.fake.nowMs,
    });
    const pr = this.fake.openPr({
      repo,
      title: `Sync ${milestoneBranch}`,
      body: "Milestone rebuild",
      author: this.fake.actor,
      head: branch,
      base: milestoneBranch,
    });
    this.autoMergeArmed.set(pr.number, this.fake.actor);
    this.syncPrs.push({
      prNumber: pr.number,
      branch,
      sha,
      openedAtMs: this.fake.nowMs,
    });
    return Promise.resolve({ ok: true, value: { branch, opened: true } });
  };

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

    if (
      a0 === "pr" && a1 === "list" && flagVal(args, "--state") === "merged" &&
      flagVal(args, "--base") === this.fixture.pr.head
    ) {
      return JSON.stringify(
        (this.fixture.subPrs ?? []).map((sub) => ({
          number: sub.number,
          headRefName: sub.headRefName,
          body: sub.body,
          mergedAt: sub.mergedAt,
          mergeCommit: { oid: sub.mergeCommit },
        })),
      );
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

      // Editing a comment in place — the watchdog's one note (Issue #3036).
      // The fake numbers comments per thread, so the id is read as a
      // position on the replayed PR's own thread, the only one edited here.
      const edit = path.match(
        /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/,
      );
      if (edit && method === "PATCH") {
        const field = flagVal(args, "-f") ?? "";
        const issue = this.fake.issue(edit[1]!, this.fixture.pr.number);
        const comment = issue.comments[Number(edit[2]) - 1];
        if (comment === undefined) {
          throw new Error(`replay: no comment ${edit[2]} to edit`);
        }
        comment.body = field.replace(/^body=/, "");
        return "";
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

export function abandonRan(outcome: AbandonRestartOutcome): boolean {
  return !(
    outcome.outcome === "declined" &&
    outcome.reason.kind === "attempts-not-spent"
  );
}

export function makeAbandonRecorder(
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
// Shared stand-down comment checks
// ---------------------------------------------------------------------------

const STAND_DOWN_TIME_PATTERN =
  /\*\*Owner:\*\* `(milestone sync|conflict takeover)`[\s\S]*?\*\*Takeover at (\S+Z)\*\* \(UTC\)/;

export function standDownComments(
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

export function assertStandDownShape(
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
