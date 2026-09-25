/**
 * The one comment a held issue carries, naming the gate that holds it
 * (Issue #2531, part of #2527).
 *
 * An issue the fleet deliberately is not working yet — a PR already open on its
 * stream, a closed dependency whose code only lands when a milestone merges, or
 * a dependency still open — looks identical from outside to an issue the fleet
 * has forgotten. So the fleet says which gate holds it, in **one** comment:
 * posted once and **edited in place** when the gate changes, so the fleet never
 * adds a second one.
 *
 * That is the difference from `chain_root_comment.ts`, whose poster is POST-only
 * and keyed by root+reason: when the gate moved on, the old comment simply
 * stayed, which is why the stale "#832" comments on GRQ-AutoTrader #830/#831
 * and #846 were never replaced. Here a changed gate rewrites the comment the
 * fleet already wrote.
 *
 * Two boundaries the upsert must not soften:
 *
 *   - **Only a fleet-authored marker counts.** A comment body is text anyone who
 *     can comment may write, so a marker match proves nothing on its own — only
 *     the *author* is authenticated. A stranger's marker must neither suppress a
 *     post nor, far worse, be edited by the fleet. An empty fleet-author list
 *     therefore trusts nothing and posts: fail towards the action that cannot
 *     hide a fault. This is the check `marker_dedup_author_cap_test.ts` caps for
 *     every dedup read in the tree.
 *   - **An unreadable thread throws.** A blind read passing as "no marker found"
 *     is how two other markers papered their threads (Issues #2265/#2266), and
 *     {@link fetchMarkerComments} already surfaces the failure.
 *
 * The module is pure and injectable — every `gh` call goes through `ghFn` — so
 * the scan wiring (a separate sub-issue) decides *when* a gate is reported; this
 * module only decides *what it says* and *that the fleet writes no second one*.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  ChainIssueRef,
  ChainRootReason,
  UnworkableChainRoot,
} from "./dependency_chain_promotion.ts";
import {
  CHAIN_ROOT_UNWORKABLE_MARKER,
  reasonSentence,
  renderRef,
} from "./chain_root_comment.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import type { IssueCache } from "./issue_cache.ts";
import type { BlockedCandidateInfo } from "./issue_finder_logger.ts";
import {
  deleteIssueComment,
  fetchMarkerComments,
  updateIssueComment,
} from "./marker_comment_pages.ts";

type GhFn = (args: string[]) => Promise<string>;

/** Hidden marker every held-issue gate comment carries, and its dedup key. */
export const HELD_ISSUE_GATE_MARKER = "vibe-held-issue-gate";

/**
 * Why an issue is held, in the three shapes the fleet can actually report.
 *
 * "Held by #N in flight on the same stream" is deliberately absent: once
 * selection stops refusing `top-priority`/`work-on` for occupancy it cannot
 * occur for the tiers this comment is written on.
 */
export type HeldIssueGate =
  /** A PR is already open on this stream; the issue is worked once it lands. */
  | { kind: "pr-open"; prNumber: number }
  /**
   * The fleet's open PRs on the default branch have reached the slot cap
   * (Issue #2663): one fleet PR per slot, so no single PR is the blocker.
   */
  | { kind: "fleet-pr-cap"; open: number; cap: number }
  /** The dependency is closed, but its code rides a milestone branch. */
  | { kind: "milestone-wait"; dependency: ChainIssueRef; milestone: string }
  /** The dependency is still open, optionally with an unworkable chain root. */
  | {
    kind: "dependency";
    dependency: ChainIssueRef;
    /** Set when the chain behind the dependency ends at an unworkable root. */
    rootReason?: ChainRootReason;
    /**
     * The issue the chain actually ends at, when that is not the dependency
     * itself. A chain is often more than one hop, and the reason belongs to the
     * root — naming the dependency there would state something untrue of it.
     * Defaults to {@link dependency} for a one-hop chain.
     */
    root?: ChainIssueRef;
    /** The value that triggered that classification (login, repo, labels). */
    rootDetail?: string;
  };

/** A built comment: the body to write, and the key that identifies the gate. */
export interface HeldIssueGateComment {
  /** Full Markdown body, heading and hidden marker included. */
  body: string;
  /** Stable key over the gate's kind and references; changes when it does. */
  key: string;
}

/** What the upsert did, so a caller can log it without re-reading the thread. */
export type HeldIssueGateOutcome = "unchanged" | "edited" | "posted";

/**
 * Keep a milestone title to the characters a branch-backed milestone uses.
 *
 * The title comes from the GitHub API rather than a fleet literal, and it is
 * interpolated into both the marker's `key="…"` attribute and the visible text,
 * so anything that could close that attribute or open a comment — `"`, `<`, `>`
 * and newlines — is dropped. Spaces, dots and slashes survive, because real
 * milestone names use them. Mirrors `safeRepo`/`safeLogin` in
 * `chain_root_comment.ts`.
 */
function safeMilestone(milestone: string): string {
  return milestone.trim().replace(/[^A-Za-z0-9._/ -]/g, "").slice(0, 120);
}

/**
 * Keep a root detail to the characters a key can carry.
 *
 * The detail is whatever triggered the root classification — a login, a repo, a
 * label — so it reaches the key from outside the fleet. The visible sentence
 * sanitises it through `chain_root_comment.ts`; the key needs its own pass
 * because it interpolates the raw value rather than the rendered sentence.
 */
function safeDetail(detail: string): string {
  return detail.trim().replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 60);
}

/** The one sentence that names the gate. */
function gateSentence(gate: HeldIssueGate): string {
  switch (gate.kind) {
    case "pr-open":
      return `PR #${gate.prNumber} is open on this stream; this issue is ` +
        `worked once it lands.`;
    case "fleet-pr-cap": {
      const prs = gate.open === 1 ? "fleet PR is" : "fleet PRs are";
      return `${gate.open} ${prs} open on this repo's default branch ` +
        `(cap ${gate.cap}) — one fleet PR per slot; this issue is worked ` +
        `once one lands.`;
    }
    case "milestone-wait": {
      const ref = renderRef(gate.dependency);
      const milestone = safeMilestone(gate.milestone);
      return `This issue waits on milestone ${milestone} — ${ref} is closed ` +
        `but its code only reaches the default branch when ${milestone} ` +
        `merges.`;
    }
    case "dependency": {
      const ref = renderRef(gate.dependency);
      if (gate.rootReason === undefined) {
        return `This issue waits on dependency ${ref}.`;
      }
      // The reason belongs to the root, so it must name the root — the
      // dependency is only the root when the chain is a single hop.
      const reason = reasonSentence(
        gate.rootReason,
        renderRef(gate.root ?? gate.dependency),
        gate.rootDetail ?? "",
      );
      return `This issue waits on dependency ${ref}, and the chain behind it ` +
        `ends at a root the fleet cannot work: ${reason}.`;
    }
  }
}

/**
 * The key that decides unchanged-vs-edit: same gate ⇒ same key ⇒ no write.
 *
 * Every interpolated value is either fleet-controlled (a number, a
 * {@link ChainRootReason} union member) or sanitised, so the key cannot break
 * out of the marker attribute it lands in.
 */
function gateKey(gate: HeldIssueGate): string {
  switch (gate.kind) {
    case "pr-open":
      return `held-gate-pr-open-${gate.prNumber}`;
    case "fleet-pr-cap":
      return `held-gate-fleet-pr-cap-${gate.open}-of-${gate.cap}`;
    case "milestone-wait":
      return `held-gate-milestone-wait-${renderRef(gate.dependency)}-` +
        `${safeMilestone(gate.milestone)}`;
    case "dependency": {
      const base = `held-gate-dependency-${renderRef(gate.dependency)}`;
      if (gate.rootReason === undefined) return base;
      // The root and its detail are in the visible sentence, so they must be in
      // the key: an assignee changing from alice to bob is a different gate, and
      // a key that ignored it would leave the comment naming alice for ever.
      return `${base}-${gate.rootReason}-` +
        `${renderRef(gate.root ?? gate.dependency)}-` +
        `${safeDetail(gate.rootDetail ?? "")}`;
    }
  }
}

/**
 * Build the comment for one held issue.
 *
 * @param gate - Why the issue is held
 * @returns The Markdown body and the key that identifies this gate
 */
export function buildHeldIssueGateComment(
  gate: HeldIssueGate,
): HeldIssueGateComment {
  const key = gateKey(gate);

  const body = [
    "### Held by the fleet",
    "",
    gateSentence(gate),
    "",
    "No labels have been changed. This comment is edited in place as the " +
    "gate changes, so it always names the current one.",
    "",
    `<!-- ${HELD_ISSUE_GATE_MARKER} key="${key}" -->`,
  ].join("\n");

  return { body, key };
}

/**
 * Write the held-issue gate comment at most once, editing it when it is stale.
 *
 * Reads the whole thread for the marker first, keeps only the comments a fleet
 * account wrote, and works from the newest of those — {@link fetchMarkerComments}
 * returns rows in page order, so that is the last one.
 *
 * @returns "unchanged" when the newest fleet marker already names this gate,
 *   "edited" when it named a different one, "posted" when there was none
 */
export async function upsertHeldIssueGateComment(opts: {
  /** Repository of the held issue, in `owner/repo` form. */
  repo: string;
  /** The held issue the comment belongs on. */
  issueNumber: number;
  /** Why the issue is held. */
  gate: HeldIssueGate;
  /** Runs `gh` (injectable for testing). */
  ghFn: GhFn;
  /**
   * Fleet logins whose comments may be trusted for dedup and edited — required,
   * not optional. An empty list trusts nothing and posts.
   */
  fleetAuthors: string[];
}): Promise<HeldIssueGateOutcome> {
  const comment = buildHeldIssueGateComment(opts.gate);

  const existing = await fetchMarkerComments(
    opts.repo,
    opts.issueNumber,
    HELD_ISSUE_GATE_MARKER,
    opts.ghFn,
  );
  const ours = existing.filter((c) =>
    isFleetAuthor(c.author, opts.fleetAuthors)
  );
  const newest = ours.at(-1);

  if (newest === undefined) {
    await opts.ghFn([
      "api",
      "-X",
      "POST",
      `repos/${opts.repo}/issues/${opts.issueNumber}/comments`,
      "-f",
      `body=${comment.body}`,
    ]);
    return "posted";
  }

  if (newest.body.includes(`key="${comment.key}"`)) return "unchanged";

  await updateIssueComment(opts.repo, newest.id, comment.body, opts.ghFn);
  return "edited";
}

/**
 * The gate a held issue's scan entry names, or `null` when the entry names none
 * the fleet reports (Issue #2535).
 *
 * - `pr-blocked` at the default-branch slot cap (#2663) ⇒ `fleet-pr-cap`.
 * - `pr-blocked` with the PR recorded (#2534) ⇒ `pr-open`.
 * - `dependency-blocked` ⇒ the first recorded blocker: `milestone-wait` when it
 *   is the cross-milestone hold (#2173), otherwise `dependency`, carrying the
 *   chain's unworkable root unless the fleet is already working the chain —
 *   work is happening, so only the root sentence is dropped; the issue is still
 *   told which dependency it waits on.
 *
 * Every other reason (`milestone-paced`, cooldowns, …) is not commented: the
 * parent issue names these gates and no others.
 *
 * @param held - The scan's record of why the issue was refused
 * @param unworkable - The chain's unworkable root, if the resolver found one
 * @param fleetWorkingChain - True when a fleet account holds the chain's root
 */
export function heldIssueGateFor(
  held: BlockedCandidateInfo,
  unworkable: UnworkableChainRoot | undefined,
  fleetWorkingChain: boolean,
): HeldIssueGate | null {
  if (held.reason === "pr-blocked") {
    if (held.fleetPrCap !== undefined) {
      return {
        kind: "fleet-pr-cap",
        open: held.fleetPrCap.open,
        cap: held.fleetPrCap.cap,
      };
    }
    return held.blockingPr === undefined
      ? null
      : { kind: "pr-open", prNumber: held.blockingPr };
  }
  if (held.reason !== "dependency-blocked") return null;
  const first = held.blockers?.[0];
  if (first === undefined) return null;
  const dependency = { repo: first.repo, number: first.number };
  if (first.heldByMilestone) {
    return {
      kind: "milestone-wait",
      dependency,
      milestone: first.heldByMilestone,
    };
  }
  if (unworkable === undefined || fleetWorkingChain) {
    return { kind: "dependency", dependency };
  }
  return {
    kind: "dependency",
    dependency,
    rootReason: unworkable.reason,
    root: unworkable.root,
    rootDetail: unworkable.detail,
  };
}

/** How long a confirmed gate is trusted before the thread is read again. */
export const HELD_ISSUE_GATE_RECHECK_SECONDS = 24 * 60 * 60;

/** The cache key under which a confirmed gate is remembered. */
function recheckCacheKey(issueNumber: number): string {
  return `held_issue_gate_${issueNumber}`;
}

/** What {@link reportHeldIssueGate} did on one issue. */
export type HeldIssueGateReport =
  | HeldIssueGateOutcome
  /** The same gate was confirmed on GitHub inside the recheck window. */
  | "cached";

/**
 * Report one held issue's gate: upsert the comment, then retire the legacy
 * chain-root comment it replaces (Issue #2535).
 *
 * Every slot on every host scans, and a repository can hold a dozen issues, so
 * reading each thread on every scan would spend GitHub quota on answers that
 * rarely change. A gate confirmed on GitHub is remembered in `cache` for
 * {@link HELD_ISSUE_GATE_RECHECK_SECONDS}; an unchanged gate inside that window
 * reads nothing. A changed gate always reads, and so does an expired one — the
 * comment may have been deleted by hand.
 *
 * Once the comment is posted or edited, fleet-authored
 * `vibe-chain-root-unworkable` comments on the thread are deleted: they were
 * POST-only and never edited, so the stale ones name a root the chain has
 * moved past. Only fleet-authored ones — the fleet never deletes a comment it
 * cannot prove it wrote.
 *
 * Throws when a thread cannot be read or written; the caller logs and carries
 * on. A legacy delete that fails is not fatal to the report and is returned
 * in `deleteErrors`.
 */
export async function reportHeldIssueGate(opts: {
  repo: string;
  issueNumber: number;
  gate: HeldIssueGate;
  ghFn: GhFn;
  fleetAuthors: string[];
  /** Where a confirmed gate is remembered; omitted, every call reads. */
  cache?: IssueCache;
}): Promise<{ outcome: HeldIssueGateReport; deleteErrors: Error[] }> {
  const key = buildHeldIssueGateComment(opts.gate).key;
  const cacheKey = recheckCacheKey(opts.issueNumber);
  const confirmed = await opts.cache?.read<{ key: string }>(
    opts.repo,
    cacheKey,
    { ttlSeconds: HELD_ISSUE_GATE_RECHECK_SECONDS },
  );
  if (confirmed?.key === key) return { outcome: "cached", deleteErrors: [] };

  const outcome = await upsertHeldIssueGateComment(opts);

  const deleteErrors: Error[] = [];
  if (outcome !== "unchanged") {
    const legacy = await fetchMarkerComments(
      opts.repo,
      opts.issueNumber,
      CHAIN_ROOT_UNWORKABLE_MARKER,
      opts.ghFn,
    );
    for (const comment of legacy) {
      if (!isFleetAuthor(comment.author, opts.fleetAuthors)) continue;
      const err = await deleteIssueComment(opts.repo, comment.id, opts.ghFn);
      if (err) deleteErrors.push(err);
    }
  }

  // A legacy delete that failed is retried on the next read: only a fully
  // settled thread is remembered.
  if (deleteErrors.length === 0) {
    await opts.cache?.write(opts.repo, cacheKey, { key });
  }
  return { outcome, deleteErrors };
}
