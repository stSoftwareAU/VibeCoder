/**
 * A backlog-to-done simulation (Issue #2547).
 *
 * Runs the worker's **real** selection (`findOldestIssue`, with every
 * collector, claim gate, escalation and dependency rule behind it) and its
 * **real** merged-PR close-out sweep (`closeIssuesForMergedPrs`) against a
 * {@link FakeGitHub}, tick by tick, until the backlog is done or the tick
 * budget runs out. Only the coding agent is stubbed: a claimed issue gets a
 * PR after `workTicks`, and the PR merges after `mergeTicks` — the path a
 * healthy run takes.
 *
 * The point is the owner's goal 1: raise a backlog, walk away, and find it
 * finished with no human action. Every tick the simulation checks the
 * invariants that goal implies and records each breach as a
 * {@link Violation}; a scenario asserts there are none and that the backlog
 * finished. A gate tested alone cannot catch a rule that is locally
 * plausible and globally wrong — #2473 labelling a dependant `needs-human`,
 * or #824 staying open after its PR merged — this can.
 *
 * Step 1 models one host. Several hosts and the idle-slot invariant come
 * next (see #2547).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { findOldestIssue } from "../../lib/find_oldest_issue.ts";
import { closeIssuesForMergedPrs } from "../../lib/pr_issue_linking.ts";
import { IssueCache } from "../../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../../lib/config_defaults.ts";
import { createMilestoneBranchName } from "../../lib/git_branch.ts";
import type { InFlightClaim } from "../../lib/work_stream.ts";
import type { WorkerConfig } from "../../types.ts";
import type { FakeGitHub } from "./fake_github.ts";

/** One breach of a goal-1 invariant, with the tick it was seen on. */
export interface Violation {
  tick: number;
  invariant:
    | "needs-human"
    | "duplicate-claim"
    | "merged-not-closed"
    | "unknown-gh-command";
  detail: string;
}

export interface SimOptions {
  repos: string[];
  /** The login the host runs as. */
  login?: string;
  /** Humans whose labels the fleet trusts. */
  owners?: string[];
  slots?: number;
  /** Ticks an agent takes to raise a PR once it holds a claim. */
  workTicks?: number;
  /** Ticks a raised PR takes to merge. */
  mergeTicks?: number;
  /** Simulated minutes per tick. */
  minutesPerTick?: number;
  maxTicks?: number;
  /**
   * Ticks a merged PR's issue may stay open before it is a violation — the
   * close-out sweep runs every tick, so one is already generous.
   */
  closeGraceTicks?: number;
}

export interface SimResult {
  finished: boolean;
  ticks: number;
  violations: Violation[];
  /** Issue keys in the order they were claimed. */
  claims: string[];
  /** Open issues left when the run stopped. */
  leftOpen: string[];
}

interface Work {
  claim: InFlightClaim;
  startedTick: number;
  prNumber?: number;
  prTick?: number;
}

export async function runBacklog(
  fake: FakeGitHub,
  opts: SimOptions,
): Promise<SimResult> {
  const login = opts.login ?? "bot";
  const slots = opts.slots ?? 1;
  const workTicks = opts.workTicks ?? 2;
  const mergeTicks = opts.mergeTicks ?? 1;
  const minutes = opts.minutesPerTick ?? 10;
  const maxTicks = opts.maxTicks ?? 200;
  const closeGrace = opts.closeGraceTicks ?? 1;

  const config: WorkerConfig = {
    ...buildDefaultWorkerConfig(),
    // Issue #3874: the content-approval store resolves from workDir.
    workDir: Deno.makeTempDirSync({ prefix: "backlog-sim-" }),
    repos: opts.repos,
    allowedAuthors: opts.owners ?? ["owner"],
    shuffleRepos: false,
  };

  const violations: Violation[] = [];
  const claims: string[] = [];
  const claimed = new Set<string>();
  const inFlight: Work[] = [];
  const reported = new Set<string>();
  const report = (v: Violation) => {
    const key = `${v.invariant}:${v.detail}`;
    if (reported.has(key)) return;
    reported.add(key);
    violations.push(v);
  };

  const done = () =>
    [...fake.issues.values()].every((i) => i.state === "CLOSED") &&
    [...fake.prs.values()].every((p) => p.state !== "OPEN") &&
    inFlight.length === 0;

  let tick = 0;
  for (; tick < maxTicks && !done(); tick++) {
    fake.advance(minutes);
    fake.actor = login;

    // Maintenance: the real close-out sweep, every cycle.
    await closeIssuesForMergedPrs(opts.repos, login, fake.gh, "planning");

    // Agents: raise the PR, release the claim; merge PRs that are due.
    for (const w of [...inFlight]) {
      const issue = fake.issue(w.claim.repo, w.claim.issueNumber);
      if (w.prNumber === undefined && tick - w.startedTick >= workTicks) {
        const base = issue.milestone
          ? createMilestoneBranchName(issue.milestone)
          : fake.defaultBranch;
        const pr = fake.openPr({
          repo: issue.repo,
          title: `${issue.title} (#${issue.number})`,
          body: `Closes #${issue.number}`,
          author: login,
          head: `issue-${issue.number}-work`,
          base,
        });
        w.prNumber = pr.number;
        w.prTick = tick;
        issue.assignees = issue.assignees.filter((a) => a !== login);
      }
      if (
        w.prNumber !== undefined && tick - (w.prTick ?? tick) >= mergeTicks
      ) {
        fake.mergePr(issue.repo, w.prNumber);
        inFlight.splice(inFlight.indexOf(w), 1);
      }
    }

    // Free slots: the real selection, one scan per slot.
    while (inFlight.filter((w) => w.prNumber === undefined).length < slots) {
      const result = await findOldestIssue(config, {
        githubUser: login,
        ghCommandFn: fake.gh,
        // A fresh cache each scan: the simulated clock outruns any TTL.
        cache: new IssueCache(
          Deno.makeTempDirSync({ prefix: "backlog-sim-cache-" }),
          600,
        ),
        inFlightClaims: inFlight
          .filter((w) => w.prNumber === undefined)
          .map((w) => w.claim),
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });
      if (!result.found) break;
      const [repo, num, , milestone] = result.output.split("|");
      const key = `${repo}#${num}`;
      if (claimed.has(key)) {
        report({
          tick,
          invariant: "duplicate-claim",
          detail: `${key} was claimed again`,
        });
        break;
      }
      claimed.add(key);
      claims.push(key);
      const issue = fake.issue(repo!, Number(num));
      issue.assignees.push(login);
      inFlight.push({
        claim: {
          repo: repo!,
          milestone: milestone ?? "",
          issueNumber: issue.number,
        },
        startedTick: tick,
      });
    }

    // Invariants.
    for (const issue of fake.issues.values()) {
      if (issue.labels.includes(config.needsHumanLabel)) {
        report({
          tick,
          invariant: "needs-human",
          detail:
            `${issue.repo}#${issue.number} was labelled ${config.needsHumanLabel}`,
        });
      }
    }
    for (const pr of fake.prs.values()) {
      if (pr.state !== "MERGED" || !pr.mergedAt) continue;
      const ageTicks = (fake.nowMs - Date.parse(pr.mergedAt)) /
        (minutes * 60_000);
      if (ageTicks <= closeGrace) continue;
      for (const ref of pr.body.matchAll(/#(\d+)/g)) {
        const issue = fake.issues.get(`${pr.repo}#${ref[1]}`);
        if (issue && issue.state === "OPEN") {
          report({
            tick,
            invariant: "merged-not-closed",
            detail:
              `${pr.repo}#${issue.number} is open though PR #${pr.number} ` +
              `merged into ${pr.base}`,
          });
        }
      }
    }
    for (const cmd of fake.unknownCommands.splice(0)) {
      report({ tick, invariant: "unknown-gh-command", detail: cmd });
    }
  }

  return {
    finished: done(),
    ticks: tick,
    violations,
    claims,
    leftOpen: [...fake.issues.values()]
      .filter((i) => i.state === "OPEN")
      .map((i) => `${i.repo}#${i.number} [${i.labels.join(",")}]`),
  };
}

/** A readable one-block summary for an assertion message. */
export function describe(result: SimResult): string {
  return [
    `finished=${result.finished} after ${result.ticks} tick(s)`,
    `claims: ${result.claims.join(" → ") || "none"}`,
    `left open: ${result.leftOpen.join(", ") || "none"}`,
    `violations:`,
    ...result.violations.map((v) => `  t${v.tick} ${v.invariant}: ${v.detail}`),
  ].join("\n");
}
