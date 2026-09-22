/**
 * The label-free report for a chain root nobody can move (Issue #2496).
 *
 * `resolveChainPromotions` (`dependency_chain_promotion.ts`) walks the chain
 * behind every dependency-blocked `top-priority`/`work-on` candidate. When it
 * reaches a root the fleet cannot work — assigned to a human, carrying no
 * discovery label, `needs-human`, or sitting in an unmonitored repo — nothing
 * is promoted and the blocked issue simply stops moving. Silence there is the
 * worst outcome: a human sees an urgent label and no activity, with no way to
 * tell a stalled chain from a stalled fleet.
 *
 * So the fleet says so, in a plain comment on the blocked issue, and **only**
 * a comment:
 *
 *   - **No labels.** The worker cannot apply `top-priority`, and `needs-human`
 *     stays reserved for the {@link ./needs_human_escalation.ts | escalateToHuman}
 *     chokepoint — a root a human is *already working* is waited on, not
 *     escalated. `escalateUnworkableWorkOn` always routes through that
 *     chokepoint, which is exactly why it cannot be reused here. This module
 *     deliberately imports neither it, `escalateToHuman`, nor
 *     `addLabelToIssue`.
 *   - **At most once per 24 hours**, keyed by blocked issue + root + reason,
 *     so a scan every 30 seconds does not paper the thread — and a *changed*
 *     root or reason is news, so it posts again immediately.
 *   - **Never while the fleet is working the chain.** That case is
 *     `fleetWorking`, not `unworkableRoots`, and the caller only ever feeds
 *     this module the latter.
 *
 * Dedup reads the thread through {@link fetchMarkerComments}, which pages the
 * whole thread — the un-paged read returns the 30 oldest comments and would go
 * blind past page one, which is how two other markers leaked (Issues
 * #2265/#2266).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  ChainIssueRef,
  ChainRootReason,
} from "./dependency_chain_promotion.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import { fetchMarkerComments } from "./marker_comment_pages.ts";

type GhFn = (args: string[]) => Promise<string>;

/** Hidden marker every chain-root comment carries, and the dedup read's key. */
export const CHAIN_ROOT_UNWORKABLE_MARKER = "vibe-chain-root-unworkable";

/** How long one report silences an identical repeat. */
export const CHAIN_ROOT_COMMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the report is about: the blocked issue, its root, and why. */
export interface ChainRootUnworkableInput {
  /** The blocked candidate the comment is posted on. */
  blockedNumber: number;
  /** The chain root the fleet cannot work. */
  root: ChainIssueRef;
  /** Why the root is unworkable, as the resolver classified it. */
  reason: ChainRootReason;
  /** The value that triggered the classification (login, repo, labels). */
  detail: string;
}

/** A built comment: the body to post, and the key that dedups it. */
export interface ChainRootUnworkableComment {
  /** Full Markdown body, heading and hidden marker included. */
  body: string;
  /** Stable key for the 24-hour window; changes with the root or the reason. */
  dedupKey: string;
}

/**
 * Keep a repository reference to the characters GitHub actually uses.
 *
 * The reference is parsed out of an issue body, which anyone who can comment
 * can write, and it is interpolated into both the marker attribute and the
 * visible text. Stripping everything outside `owner/repo`'s alphabet means a
 * crafted reference can neither close the marker's `key="…"` attribute nor
 * smuggle markup into the comment.
 */
function safeRepo(repo: string): string {
  return repo.trim().replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 120);
}

/**
 * Keep an assignee to GitHub's own login alphabet (alphanumeric and hyphen,
 * 39 characters), for the same trust-boundary reason as {@link safeRepo}: the
 * login is rendered as an `@mention` in Markdown the fleet authors.
 */
function safeLogin(detail: string): string {
  return detail.trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 39);
}

/** `owner/repo#N`, as a human reads it and as the dedup key spells it. */
function renderRef(root: ChainIssueRef): string {
  return `${safeRepo(root.repo)}#${root.number}`;
}

/** The one sentence that says why the chain stopped here. */
function reasonSentence(
  reason: ChainRootReason,
  ref: string,
  detail: string,
): string {
  switch (reason) {
    case "assigned": {
      const login = safeLogin(detail);
      const who = login === "" ? "an unnamed account" : `@${login}`;
      return `waiting on ${who}, who is assigned to ${ref}`;
    }
    case "no-discovery-label":
      return `${ref} carries no discovery label, so the fleet will not pick ` +
        `it up`;
    case "needs-human":
      return `${ref} is \`needs-human\``;
    case "cross-repo-unmonitored":
      return `cross-repo blocker ${ref} is not monitored by this fleet`;
  }
}

/**
 * Build the comment for one blocked issue whose chain ended at an unworkable
 * root.
 *
 * @param input - The blocked issue, its chain root, and the classification
 * @returns The Markdown body and the key that dedups it for 24 hours
 */
export function buildChainRootUnworkableComment(
  input: ChainRootUnworkableInput,
): ChainRootUnworkableComment {
  const ref = renderRef(input.root);
  const dedupKey =
    `chain-root-unworkable-${input.blockedNumber}-${ref}-${input.reason}`;

  const body = [
    "### Dependency chain stalled at a root the fleet cannot work",
    "",
    `This issue is dependency-blocked, and the chain behind it ends at ` +
    `${ref}: ${reasonSentence(input.reason, ref, input.detail)}.`,
    "",
    `No labels have been changed. The fleet will work this issue as soon as ` +
    `${ref} is workable again.`,
    "",
    `<!-- ${CHAIN_ROOT_UNWORKABLE_MARKER} key="${dedupKey}" -->`,
  ].join("\n");

  return { body, dedupKey };
}

/**
 * Post the comment unless an identical one is already less than 24 hours old.
 *
 * Reads the whole thread for the marker first. A read that fails throws rather
 * than degrading to "no marker found" — a blind read that posts every scan is
 * how a thread ends up with hundreds of duplicates — so the caller decides
 * whether a failed report is worth aborting for (discovery's is not).
 *
 * An unparseable `created_at` compares false and therefore posts: a duplicate
 * informational comment is a smaller harm than a silently suppressed one.
 *
 * @returns true when a comment was posted, false when the window suppressed it
 */
export async function postChainRootUnworkableComment(opts: {
  /** Repository of the blocked issue, in `owner/repo` form. */
  repo: string;
  /** The blocked issue the comment is posted on. */
  issueNumber: number;
  /** The built comment, from {@link buildChainRootUnworkableComment}. */
  comment: ChainRootUnworkableComment;
  /** Runs `gh` (injectable for testing). */
  ghFn: GhFn;
  /** Override the clock used by the dedup window. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Fleet logins whose comments may suppress a repeat.
   *
   * An issue body — and an issue comment — is text anyone who can comment may
   * write, so a marker match on its own proves nothing; only the comment
   * *author* is authenticated. Supplying the fleet identity means a marker
   * forged by an outsider cannot silence the report. Omitted, any marker
   * dedups, which is the behaviour a caller without a resolved fleet set can
   * safely have: the failure it allows is a delayed comment, never a hidden
   * escalation.
   */
  fleetAuthors?: string[];
}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const existing = await fetchMarkerComments(
    opts.repo,
    opts.issueNumber,
    CHAIN_ROOT_UNWORKABLE_MARKER,
    opts.ghFn,
  );

  const keyMarker = `key="${opts.comment.dedupKey}"`;
  const cutoff = now() - CHAIN_ROOT_COMMENT_WINDOW_MS;
  const suppressed = existing.some((c) => {
    if (!c.body.includes(keyMarker)) return false;
    if (opts.fleetAuthors && !isFleetAuthor(c.author, opts.fleetAuthors)) {
      return false;
    }
    return Date.parse(c.createdAt) >= cutoff;
  });
  if (suppressed) return false;

  await opts.ghFn([
    "api",
    "-X",
    "POST",
    `repos/${opts.repo}/issues/${opts.issueNumber}/comments`,
    "-f",
    `body=${opts.comment.body}`,
  ]);
  return true;
}
