/**
 * One repo state, rendered for both instruments that judge it (Issue #524).
 *
 * The claim path is a conjunction of ~24 gates, and every "the worker isn't
 * picking up work" incident so far has been a *pair* of individually-correct
 * gates — not a single gate misbehaving. Per-gate tests cannot see those, so
 * this module describes a repository's state once and renders it two ways:
 *
 *  - {@link toMockGh} — the `gh` surface the claim scan reads
 *    (`findOldestIssue` and the collectors beneath it), and
 *  - {@link toCensusInput} — the already-fetched shape the idle-decision
 *    census reads (`buildIdleDecisionCensus`).
 *
 * Two implementations of the same question are normally a liability. Here they
 * are free differential testing: the census-vs-scan comparison that today only
 * runs on the live fleet (the `[idle-census] … ALERT inversion` alert, three
 * cycles and a human later) runs over generated states in CI instead.
 *
 * # Gate isolation
 *
 * Each modelled gate is arranged to refuse exactly the issue it targets, so
 * pairs compose without interfering:
 *
 *  - `milestone-occupied` — the issue sits in its own milestone stream, which
 *    an issue assigned to the worker already occupies.
 *  - `pr-blocked` — the issue sits in its own milestone stream, and a fleet PR
 *    targets that stream's branch. A `milestone/…` base cannot block a
 *    default-stream issue, so no other issue is affected.
 *  - `merged-pr-permanent` — a merged fleet PR names the issue in its title.
 *  - `dependency-blocked` — the issue body names an open dependency issue.
 *  - `cooldown` — this run is holding the issue back (Issue #655): the scan
 *    filters it out via `isIssueInCooldown`, and the census is handed the
 *    same set as `runLocalHolds`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  buildIdleDecisionCensus,
  type RepoCensusEntry,
  type RepoCensusInput,
} from "../../lib/idle_decision_census.ts";
import type { ClosedPR, OpenPR } from "../../lib/issue_query.ts";
import { createMilestoneBranchName } from "../../lib/git_branch.ts";
import { buildDefaultWorkerConfig } from "../../lib/config_defaults.ts";
import { findOldestIssue } from "../../lib/find_oldest_issue.ts";
import { IssueCache } from "../../lib/issue_cache.ts";
import type { WorkerConfig } from "../../types.ts";

/** The claim-scan gates the census also models (`CENSUS_SCAN_GATE_COVERAGE`). */
export const MODELLED_GATES = [
  "milestone-occupied",
  "pr-blocked",
  "merged-pr-permanent",
  "dependency-blocked",
  "cooldown",
] as const;

/** A modelled gate, or `none` for an issue nothing refuses. */
export type ModelledGate = typeof MODELLED_GATES[number] | "none";

/** The worker login every fixture scans as. */
export const WORKER_USER = "bot";

/** The trusted human whose label adds the scan honours. */
export const TRUSTED_AUTHOR = "alice";

/** An actor the scan does not trust to apply a discovery label. */
export const UNTRUSTED_AUTHOR = "mallory";

/** When every fixture label was applied — long before any PR closed. */
const LABEL_ADDED_AT = "2020-01-01T00:00:00Z";

/** When a fixture's merged PR landed. */
const PR_MERGED_AT = "2026-08-28T04:55:16Z";

/** One issue in a described repo state. */
export interface StateIssue {
  number: number;
  /** Which discovery tier the issue carries. */
  tier: "work-on" | "low-priority";
  /** The gate that should refuse it. Defaults to `none`. */
  gate?: ModelledGate;
  /** ISO creation timestamp. Defaults to a stable value from `number`. */
  createdAt?: string;
  /**
   * When true the discovery label was applied by an untrusted actor, so the
   * scan refuses the issue as `label-author-not-allowed` — a `human` gate
   * outside the census's view, used by the monotonicity property.
   */
  untrustedLabel?: boolean;
}

/** A repository state, described once for both instruments. */
export interface RepoState {
  repo: string;
  issues: StateIssue[];
}

/** Support issues the gates need, derived from the issue they gate. */
const occupierNumber = (n: number) => 100_000 + n;
const dependencyNumber = (n: number) => 200_000 + n;
const openPrNumber = (n: number) => 300_000 + n;
const mergedPrNumber = (n: number) => 400_000 + n;

/** The milestone stream an issue sits in, given its gate. */
function milestoneFor(issue: StateIssue): string {
  switch (issue.gate ?? "none") {
    case "milestone-occupied":
      return `occupied-${issue.number}`;
    case "pr-blocked":
      return `pr-${issue.number}`;
    default:
      return "";
  }
}

/** The issue body, which carries the dependency reference when gated. */
function bodyFor(issue: StateIssue): string {
  return issue.gate === "dependency-blocked"
    ? `Depends on #${dependencyNumber(issue.number)}`
    : "No dependencies.";
}

function createdAtFor(issue: StateIssue): string {
  return issue.createdAt ??
    `2026-01-01T00:00:${String(issue.number % 60).padStart(2, "0")}Z`;
}

/** Title for a described issue — deliberately not a milestone-merge title. */
function titleFor(issue: StateIssue): string {
  return `Fixture issue ${issue.number}`;
}

/** Every open issue the repo holds, including the gates' support issues. */
interface RenderedIssue {
  number: number;
  title: string;
  url: string;
  assignees: { login: string }[];
  labels: { name: string }[];
  createdAt: string;
  author: { login: string };
  milestone: { title: string } | null;
  body: string;
}

function renderIssues(state: RepoState): RenderedIssue[] {
  const rendered: RenderedIssue[] = [];
  const push = (
    number: number,
    overrides: Partial<RenderedIssue> = {},
  ): void => {
    rendered.push({
      number,
      title: `Support issue ${number}`,
      url: `https://github.com/${state.repo}/issues/${number}`,
      assignees: [],
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      author: { login: TRUSTED_AUTHOR },
      milestone: null,
      body: "No dependencies.",
      ...overrides,
    });
  };

  for (const issue of state.issues) {
    const milestone = milestoneFor(issue);
    push(issue.number, {
      title: titleFor(issue),
      labels: [{ name: issue.tier }],
      createdAt: createdAtFor(issue),
      milestone: milestone === "" ? null : { title: milestone },
      body: bodyFor(issue),
    });
    if (issue.gate === "milestone-occupied") {
      // An issue the worker already holds in the same stream — the scan's
      // `isMilestoneOccupied`, and the census's `occupiedStreamsFor`.
      push(occupierNumber(issue.number), {
        assignees: [{ login: WORKER_USER }],
        milestone: { title: milestone },
      });
    }
    if (issue.gate === "dependency-blocked") {
      push(dependencyNumber(issue.number));
    }
  }
  return rendered;
}

/** The fleet's open PRs implied by the state's `pr-blocked` gates. */
export function renderOpenPRs(state: RepoState): OpenPR[] {
  return state.issues
    .filter((issue) => issue.gate === "pr-blocked")
    .map((issue) => ({
      number: openPrNumber(issue.number),
      title: `Work in progress on stream ${milestoneFor(issue)}`,
      baseRefName: createMilestoneBranchName(milestoneFor(issue)),
      headRefName: `issue-${issue.number}`,
      author: WORKER_USER,
    }));
}

/** The issues this run is holding back, from the state's `cooldown` gates. */
export function renderRunLocalHolds(state: RepoState): Set<number> {
  return new Set(
    state.issues.filter((i) => i.gate === "cooldown").map((i) => i.number),
  );
}

/** The fleet's merged PRs implied by the state's `merged-pr-permanent` gates. */
export function renderMergedPRs(state: RepoState): ClosedPR[] {
  return state.issues
    .filter((issue) => issue.gate === "merged-pr-permanent")
    .map((issue) => ({
      number: mergedPrNumber(issue.number),
      title: `Land the fix (Issue #${issue.number})`,
      closedAt: PR_MERGED_AT,
      merged: true,
    }));
}

/** Render the state as the already-fetched input the census reads. */
export function toCensusInput(
  state: RepoState,
  overrides: Partial<RepoCensusInput> = {},
): RepoCensusInput {
  return {
    repo: state.repo,
    monitored: true,
    scannedThisCycle: true,
    nice: 0,
    issues: renderIssues(state).map((i) => ({
      number: i.number,
      labels: i.labels.map((l) => l.name),
      assignees: i.assignees.map((a) => a.login),
      milestone: i.milestone?.title ?? "",
      body: i.body,
    })),
    openPRs: renderOpenPRs(state),
    mergedPRs: renderMergedPRs(state),
    runLocalHolds: renderRunLocalHolds(state),
    ...overrides,
  };
}

/**
 * Render the state as the `gh` surface the claim scan reads.
 *
 * Only the calls the scan actually makes are answered; anything else returns
 * an empty JSON array, matching the fail-safe shape the collectors expect.
 */
export function toMockGh(
  state: RepoState,
): (args: string[]) => Promise<string> {
  const issues = renderIssues(state);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const untrusted = new Set(
    state.issues.filter((i) => i.untrustedLabel).map((i) => i.number),
  );
  const openPRs = renderOpenPRs(state);
  const mergedPRs = renderMergedPRs(state);

  /** Label-add events: both discovery labels, so either tier resolves. */
  const timelineFor = (issueNumber: number): unknown[] => {
    const actor = untrusted.has(issueNumber)
      ? UNTRUSTED_AUTHOR
      : TRUSTED_AUTHOR;
    return ["work-on", "low-priority"].map((label) => ({
      event: "labeled",
      label: { name: label },
      actor: { login: actor },
      created_at: LABEL_ADDED_AT,
    }));
  };

  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    const json = (value: unknown) => Promise.resolve(JSON.stringify(value));

    // The batched GraphQL timeline query: refuse it so each caller falls back
    // to the per-issue REST path answered below.
    if (args[0] === "api" && args[1] === "graphql") return json({});

    if (args[0] === "api") {
      const path = args[1] ?? "";
      const timeline = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/timeline/.exec(
        path,
      );
      if (timeline) return json(timelineFor(Number(timeline[1])));
      // Sub-issues: the fixtures never use the native sub-issue API.
      return json([]);
    }

    if (command.includes("issue list")) {
      return json(issues);
    }

    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const issue = byNumber.get(number);
      const fields = args[args.indexOf("--json") + 1] ?? "";
      if (fields.includes("state")) {
        return json({
          number,
          // Every rendered issue is open; anything else is closed, which is
          // what the dependency gate must see for a landed dependency.
          state: issue ? "OPEN" : "CLOSED",
          title: issue?.title ?? "",
        });
      }
      return json({
        title: issue?.title ?? "",
        body: issue?.body ?? "",
        labels: issue?.labels ?? [],
      });
    }

    if (command.includes("pr list")) {
      const author = args[args.indexOf("--author") + 1] ?? "";
      // Only the worker's own PRs exist in these fixtures, so a query for any
      // other fleet account correctly returns nothing.
      if (author !== WORKER_USER) return json([]);
      const closed = args.includes("closed");
      return json(
        closed
          ? mergedPRs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            mergedAt: pr.closedAt,
            closedAt: pr.closedAt,
          }))
          : openPRs,
      );
    }

    return json([]);
  };
}

/** What the claim scan did with a state. */
export interface ScanOutcome {
  /** Whether the scan claimed anything at all. */
  claimed: boolean;
  /** The issue number it claimed, or `null`. */
  claimedIssue: number | null;
}

/**
 * Run the real claim path (`findOldestIssue`) over a described state.
 *
 * Every remaining run-local axis is held constant — no deprioritisation, no
 * in-flight holds, a configured content-approval store — so the only thing
 * that varies between states is the modelled gates. Issue #655 moved the
 * retry cooldown out of that constant set and into the modelled gates: the
 * scan and the census now read the same hold set, so a state where they
 * disagree about it fails here rather than on the fleet three cycles later.
 */
export async function runClaimScan(state: RepoState): Promise<ScanOutcome> {
  const config: WorkerConfig = {
    ...buildDefaultWorkerConfig(),
    repos: [state.repo],
    // No configured-label tier in these fixtures: no issue carries this label.
    issueLabels: ["help-wanted"],
    allowedAuthors: [TRUSTED_AUTHOR],
    // Issue #3874: without a content-approval store the integrity gate fails
    // closed and refuses every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "claim-path-workdir-" }),
    shuffleRepos: false,
  };
  const runLocalHolds = renderRunLocalHolds(state);
  const result = await findOldestIssue(config, {
    githubUser: WORKER_USER,
    ghCommandFn: toMockGh(state),
    cache: new IssueCache(
      Deno.makeTempDirSync({ prefix: "claim-path-cache-" }),
      600,
    ),
    // Issue #655: the same holds the census is handed above.
    isIssueInCooldown: (_repo, num) => runLocalHolds.has(num),
    // Deterministic tie-breaking so a state's outcome is reproducible.
    selectionOptions: { randomFn: () => 0, randomPoolSize: 3 },
  });
  const claimedIssue = result.found
    ? Number(result.output.split("|")[1])
    : null;
  return { claimed: result.found, claimedIssue };
}

/** Run the idle-decision census over a described state. */
export function runCensus(state: RepoState): RepoCensusEntry {
  const census = buildIdleDecisionCensus({
    decisionPoint: "selection",
    workerUser: WORKER_USER,
    repos: [toCensusInput(state)],
  });
  const entry = census.perRepo[0];
  if (entry === undefined) {
    throw new Error("census returned no entry for the described repo");
  }
  return entry;
}
