/**
 * Auto-merge follows the base (Issue #3433).
 *
 * A PR's base can be moved after it was opened (a human or an agent editing
 * it). A milestone-fix PR retargeted to the default branch carries the whole
 * milestone's diff, and its armed auto-merge would land that work without the
 * milestone's final review. The Auto-merge sweep therefore re-reads the PR's
 * base each pass and holds, disarms or re-evaluates it before any arming.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { disarmAutoMerge } from "./auto_merge_disarm.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import {
  isMilestoneBranch,
  isMilestoneFixBranch,
} from "./milestone_branch_names.ts";
import { hasFleetAuthoredMarker } from "./milestone_children_gate.ts";
import { isMilestoneSyncBranch } from "./milestone_sync_pr.ts";
import { parseMilestoneFixHead } from "./pr_base_change_guard.ts";
import {
  AutoMergeResult,
  type EnableAutoMergeResult,
} from "./pr_auto_merge.ts";

/** Marker on the comment placed on a retargeted milestone-fix PR. */
export const MILESTONE_FIX_RETARGETED_MARKER =
  "<!-- vibe-milestone-fix-retargeted -->";

/** Marker on the comment explaining a PR moved onto the default branch. */
export const MOVED_ONTO_DEFAULT_MARKER = "<!-- vibe-pr-moved-onto-default -->";

/** Marker on the milestone's final PR, naming the retargeted fix PR. */
export function milestoneFixRetargetedFinalPrMarker(fixPr: number): string {
  return `<!-- vibe-milestone-fix-retargeted pr="${fixPr}" -->`;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

type GhFn = (args: string[]) => Promise<string>;

/** The most recent base change on a PR. */
export interface PrBaseChange {
  /** ISO timestamp of the change. */
  at: string;
  /** Previous base branch. */
  from: string;
  /** New base branch. */
  to: string;
}

/** What one GraphQL read says about a PR's base. */
export interface PrBaseIntegrityReading {
  /** The repository's default branch. */
  defaultBranch: string;
  /** PR head branch. */
  headRefName: string;
  /** PR base branch. */
  baseRefName: string;
  /** When auto-merge was armed, or null when it is not. */
  armedAt: string | null;
  /** The latest base change, or null when the base was never changed. */
  lastBaseChange: PrBaseChange | null;
}

/** Verdict of {@link decidePrBaseIntegrity}. */
export type PrBaseIntegrityDecision =
  | { kind: "mistargeted-milestone-fix" }
  | { kind: "moved-onto-default" }
  | { kind: "base-changed-since-armed" }
  | { kind: "ok" };

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      headRefName
      baseRefName
      autoMergeRequest { enabledAt }
      timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], last: 1) {
        nodes { ... on BaseRefChangedEvent { createdAt previousRefName currentRefName } }
      }
    }
  }
}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") {
    throw new Error(`malformed PR base payload: ${what} is not a string`);
  }
  return v;
}

/**
 * Read a PR's head, base, arming time and latest base change in one query.
 *
 * @throws when the repo is malformed, the call fails or the payload is
 *   malformed — the caller must fail closed.
 */
export async function readPrBaseIntegrity(
  repo: string,
  prNumber: number,
  gh: GhFn,
): Promise<PrBaseIntegrityReading> {
  if (!REPO_RE.test(repo)) throw new Error(`invalid repo '${repo}'`);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`invalid PR number ${prNumber}`);
  }
  const [owner, name] = repo.split("/");
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${prNumber}`,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("malformed PR base payload: not JSON");
  }
  const data = isRecord(parsed) ? parsed.data : undefined;
  const repository = isRecord(data) ? data.repository : undefined;
  if (!isRecord(repository)) {
    throw new Error("malformed PR base payload: no repository");
  }
  const defaultRef = repository.defaultBranchRef;
  const pr = repository.pullRequest;
  if (!isRecord(defaultRef) || !isRecord(pr)) {
    throw new Error("malformed PR base payload: no default branch or PR");
  }
  const armed = pr.autoMergeRequest;
  let armedAt: string | null = null;
  if (armed !== null && armed !== undefined) {
    if (!isRecord(armed)) {
      throw new Error("malformed PR base payload: autoMergeRequest");
    }
    armedAt = str(armed.enabledAt, "autoMergeRequest.enabledAt");
  }
  const timeline = pr.timelineItems;
  if (!isRecord(timeline) || !Array.isArray(timeline.nodes)) {
    throw new Error("malformed PR base payload: no timelineItems");
  }
  let lastBaseChange: PrBaseChange | null = null;
  const node = timeline.nodes[timeline.nodes.length - 1];
  if (node !== undefined && node !== null) {
    if (!isRecord(node)) {
      throw new Error("malformed PR base payload: timeline node");
    }
    lastBaseChange = {
      at: str(node.createdAt, "createdAt"),
      from: str(node.previousRefName, "previousRefName"),
      to: str(node.currentRefName, "currentRefName"),
    };
  }
  return {
    defaultBranch: str(defaultRef.name, "defaultBranchRef.name"),
    headRefName: str(pr.headRefName, "headRefName"),
    baseRefName: str(pr.baseRefName, "baseRefName"),
    armedAt,
    lastBaseChange,
  };
}

/** Decide what a PR's base means for auto-merge. Pure. */
export function decidePrBaseIntegrity(
  r: PrBaseIntegrityReading,
): PrBaseIntegrityDecision {
  if (
    isMilestoneFixBranch(r.headRefName) && !isMilestoneBranch(r.baseRefName)
  ) {
    return { kind: "mistargeted-milestone-fix" };
  }
  const change = r.lastBaseChange;
  // A sync PR moved onto the default branch is closed by enableAutoMerge's
  // Issue #1967 path, so it must reach that path rather than be held here.
  if (
    change && r.baseRefName === r.defaultBranch &&
    change.to === r.baseRefName && !isMilestoneSyncBranch(r.headRefName)
  ) {
    return { kind: "moved-onto-default" };
  }
  if (r.armedAt && change) {
    const changed = Date.parse(change.at);
    const armed = Date.parse(r.armedAt);
    if (changed > armed) return { kind: "base-changed-since-armed" };
  }
  return { kind: "ok" };
}

/** Result of {@link checkPrBaseIntegrity}. */
export type PrBaseIntegrityCheck =
  | { action: "hold"; outcome: EnableAutoMergeResult }
  | { action: "proceed"; disarmed: boolean };

/** Inputs to {@link checkPrBaseIntegrity}. */
export interface CheckPrBaseIntegrityOptions {
  /** `owner/repo`. */
  repo: string;
  /** The PR as the sweep listing shows it. */
  pr: { number: number; headRefName?: string; baseRefName?: string };
  /** Whether the live read shows auto-merge armed. */
  armed: boolean;
  /** `gh` runner. */
  gh: GhFn;
  /** Warning logger. */
  log: (message: string) => void;
  /** Fleet author options for comment de-duplication. */
  authorOptions?: AlertDedupAuthorOptions;
}

/** Post `body` on `prNumber` once per `marker`; never throws. */
async function commentOnce(
  o: CheckPrBaseIntegrityOptions,
  prNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  try {
    if (
      await hasFleetAuthoredMarker(
        o.repo,
        prNumber,
        marker,
        o.gh,
        o.authorOptions ?? {},
        o.log,
      )
    ) return;
    await o.gh([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      o.repo,
      "--body",
      `${marker}\n${body}`,
    ]);
  } catch (err) {
    o.log(
      `WARNING: could not comment on ${o.repo}#${prNumber} about its base: ${
        err instanceof Error ? err.message : String(err)
      } (Issue #3433)`,
    );
  }
}

/**
 * Check one swept PR's base before any arming or branch update.
 *
 * Fails closed: an unreadable PR is deferred, never armed.
 */
export async function checkPrBaseIntegrity(
  o: CheckPrBaseIntegrityOptions,
): Promise<PrBaseIntegrityCheck> {
  const { repo, pr, armed, gh, log } = o;
  const head = pr.headRefName ?? "";
  const listedBase = pr.baseRefName ?? "";
  // Bounds the per-sweep GraphQL cost: an unarmed PR on a milestone base that
  // is not a fix PR has nothing to disarm, and arming into a milestone branch
  // is the normal path.
  if (!armed && isMilestoneBranch(listedBase) && !isMilestoneFixBranch(head)) {
    return { action: "proceed", disarmed: false };
  }

  let reading: PrBaseIntegrityReading;
  try {
    reading = await readPrBaseIntegrity(repo, pr.number, gh);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      action: "hold",
      outcome: {
        result: AutoMergeResult.Deferred,
        message:
          `PR #${pr.number} base could not be read (${message}) — not armed this pass, will re-read next pass (Issue #3433)`,
      },
    };
  }

  const decision = decidePrBaseIntegrity(reading);
  const base = reading.baseRefName;
  switch (decision.kind) {
    case "mistargeted-milestone-fix": {
      await disarmAutoMerge(repo, pr.number, gh, log);
      log(
        `WARNING: [MILESTONE_FIX_RETARGETED] ${repo}#${pr.number} has milestone-fix head '${reading.headRefName}' on base '${base}', not a milestone branch — auto-merge disarmed (Issue #3433)`,
      );
      const text =
        `This milestone-fix PR targets \`${base}\` instead of a milestone branch. Its diff is the milestone's work, so it must land only through the milestone's final PR. Auto-merge has been disarmed. A human should retarget it to \`milestone/<…>\` or close it (Issue #3433).`;
      await commentOnce(o, pr.number, MILESTONE_FIX_RETARGETED_MARKER, text);
      const parsed = parseMilestoneFixHead(reading.headRefName);
      if (parsed) {
        await commentOnce(
          o,
          parsed.milestonePrNumber,
          milestoneFixRetargetedFinalPrMarker(pr.number),
          `Milestone-fix PR #${pr.number} targets \`${base}\` instead of a milestone branch. ${text}`,
        );
      }
      return {
        action: "hold",
        outcome: {
          result: AutoMergeResult.HeldBaseRetargeted,
          message:
            `PR #${pr.number} is a milestone-fix PR on base '${base}', not a milestone branch — auto-merge disarmed (Issue #3433)`,
        },
      };
    }
    case "moved-onto-default": {
      const from = reading.lastBaseChange?.from ?? "unknown";
      await disarmAutoMerge(repo, pr.number, gh, log);
      log(
        `WARNING: ${repo}#${pr.number} was moved onto '${base}' from '${from}' after it was opened — auto-merge disarmed (Issue #3433)`,
      );
      await commentOnce(
        o,
        pr.number,
        MOVED_ONTO_DEFAULT_MARKER,
        `This PR was moved onto the default branch \`${base}\` from \`${from}\` after it was opened, so the fleet will not auto-merge it there. Auto-merge has been disarmed; a human should review and merge it (Issue #3433).`,
      );
      return {
        action: "hold",
        outcome: {
          result: AutoMergeResult.HeldBaseRetargeted,
          message:
            `PR #${pr.number} was moved onto '${base}' from '${from}' after it was opened — not armed, not merged, auto-merge disarmed (Issue #3433)`,
        },
      };
    }
    case "base-changed-since-armed": {
      const disarmed = await disarmAutoMerge(repo, pr.number, gh, log);
      log(
        `WARNING: ${repo}#${pr.number} base changed after auto-merge was armed — disarmed for re-evaluation (Issue #3433)`,
      );
      return { action: "proceed", disarmed };
    }
    case "ok":
      return { action: "proceed", disarmed: false };
  }
}
