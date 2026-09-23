/**
 * The one comment a held issue carries, naming the gate that holds it
 * (Issue #2531, part of #2527).
 *
 * An issue the fleet deliberately is not working yet — a PR already open on its
 * stream, a closed dependency whose code only lands when a milestone merges, or
 * a dependency still open — looks identical from outside to an issue the fleet
 * has forgotten. So the fleet says which gate holds it, in **one** comment:
 * posted once, **edited in place** when the gate changes, never duplicated.
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
 * module only decides *what it says* and *that there is exactly one of it*.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  ChainIssueRef,
  ChainRootReason,
} from "./dependency_chain_promotion.ts";
import { reasonSentence, renderRef } from "./chain_root_comment.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
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
  /** The dependency is closed, but its code rides a milestone branch. */
  | { kind: "milestone-wait"; dependency: ChainIssueRef; milestone: string }
  /** The dependency is still open, optionally with an unworkable chain root. */
  | {
    kind: "dependency";
    dependency: ChainIssueRef;
    /** Set when the chain behind the dependency ends at an unworkable root. */
    rootReason?: ChainRootReason;
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

/** The one sentence that names the gate. */
function gateSentence(gate: HeldIssueGate): string {
  switch (gate.kind) {
    case "pr-open":
      return `PR #${gate.prNumber} is open on this stream; this issue is ` +
        `worked once it lands.`;
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
      const reason = reasonSentence(
        gate.rootReason,
        ref,
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
    case "milestone-wait":
      return `held-gate-milestone-wait-${renderRef(gate.dependency)}-` +
        `${safeMilestone(gate.milestone)}`;
    case "dependency": {
      const base = `held-gate-dependency-${renderRef(gate.dependency)}`;
      return gate.rootReason === undefined
        ? base
        : `${base}-${gate.rootReason}`;
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
