/**
 * Wording and reference sanitising for a chain root nobody can move
 * (Issues #2496, #2535).
 *
 * `resolveChainPromotions` (`dependency_chain_promotion.ts`) walks the chain
 * behind every dependency-blocked `top-priority`/`work-on` candidate. When it
 * reaches a root the fleet cannot work — assigned to a human, carrying no
 * discovery label, `needs-human`, or sitting in an unmonitored repo — the
 * blocked issue says so. Since #2535 it says so in its one held-issue gate
 * comment (`held_issue_gate_comment.ts`), as the `dependency` gate's sentence;
 * this module keeps the sentence and the sanitisers that make it safe to
 * publish, so the wording has one home.
 *
 * The stand-alone comment #2496 posted — POST-only, keyed by root and reason,
 * never edited — is retired: it left stale roots on threads (GRQ-AutoTrader
 * #830/#831/#846 kept naming #832 after it closed). Its marker stays here only
 * so the gate comment can find and delete the fleet-authored leftovers.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  ChainIssueRef,
  ChainRootReason,
} from "./dependency_chain_promotion.ts";

/**
 * Marker of the retired #2496 chain-root comment. Kept so the held-issue gate
 * comment can find the fleet-authored leftovers and delete them (#2535).
 */
export const CHAIN_ROOT_UNWORKABLE_MARKER = "vibe-chain-root-unworkable";

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

/**
 * `owner/repo#N`, as a human reads it and as the dedup key spells it.
 *
 * Exported so other fleet comments interpolate references through the same
 * sanitiser rather than reimplementing {@link safeRepo}.
 */
export function renderRef(root: ChainIssueRef): string {
  return `${safeRepo(root.repo)}#${root.number}`;
}

/**
 * The one sentence that says why the chain stopped here.
 *
 * Exported so the held-issue gate comment reuses this wording verbatim instead
 * of drifting a second copy of it.
 */
export function reasonSentence(
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
