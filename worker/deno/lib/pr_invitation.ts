/**
 * Explicit-invitation predicate for human-authored PRs (Issue #4077).
 *
 * Since Issue #4076 the five PR-maintenance scans only ever list PRs
 * authored by accounts the fleet operates (`resolveFleetMaintenanceAuthorSet`),
 * so a trusted human's PR is never adopted. The agreed policy (#4074) is
 * narrower than "never": the worker may act on a human-authored PR **when
 * explicitly invited**, and only then.
 *
 * This module is the pure decision half of that mechanism — it takes an
 * already-fetched PR (labels with their adders, comments, reviews) and
 * answers "was the worker invited, and by whom?". All GitHub access lives
 * in the caller (`pr_invitation_lookup.ts`), so every rule here is unit
 * testable without a network.
 *
 * Two signals count, both requiring a **trusted human** (`allowed_authors`,
 * excluding fleet accounts — a worker must not conscript itself):
 *
 * - **Label** — the PR carries the invite label (default `work-on`) and a
 *   trusted human applied it. The adder is resolved from the timeline by
 *   the caller, never inferred from label presence.
 * - **Mention** — a PR comment or review body from a trusted human that
 *   @mentions the host login or a configured fleet login.
 *
 * Everything ambiguous, unparseable, or unattributable is **not invited**.
 * Fail closed.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Default invitation label — the existing `work-on` signal is reused. */
export const DEFAULT_INVITE_LABEL = "work-on";

/** A label on the PR, paired with the login that most recently applied it. */
export interface InvitationLabel {
  /** Label name as it appears on the PR. */
  name: string;
  /**
   * Login that applied the label, from the timeline. `null`/absent when
   * authorship could not be established — which is never an invitation.
   */
  addedBy?: string | null;
}

/** A PR comment or review body, with its author. */
export interface InvitationComment {
  author?: { login?: string | null } | null;
  body?: string | null;
}

/** The already-fetched PR facts the predicate decides on. */
export interface InvitationPr {
  /** PR number (used only for the caller's logging). */
  number?: number;
  /** PR author — informational; a human PR can be handed over by a peer. */
  author?: { login?: string | null } | null;
  /** Labels currently on the PR, each with its verified adder. */
  labels?: readonly InvitationLabel[] | null;
  /** Top-level PR comments. */
  comments?: readonly InvitationComment[] | null;
  /** PR reviews (their bodies count the same as comments). */
  reviews?: readonly InvitationComment[] | null;
}

/** Configuration the invitation rules are evaluated against. */
export interface PrInvitationOptions {
  /** The current host's GitHub login — a valid @mention target. */
  githubUser: string;
  /** Trusted humans (`allowed_authors`) — the only accounts that may invite. */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`) — also valid @mention targets. */
  fleetPrAuthors?: readonly string[];
  /** Invitation label name. Defaults to {@link DEFAULT_INVITE_LABEL}. */
  inviteLabel?: string;
}

/** The invitation verdict for one PR. */
export interface PrInvitation {
  /** True only when a trusted human invited the worker onto this PR. */
  invited: boolean;
  /** Which signal admitted the PR, or `null` when not invited. */
  via: "label" | "mention" | null;
  /** The trusted human who invited the worker, when invited. */
  invitedBy?: string;
}

/** The fail-closed verdict, returned for anything that is not a clear invite. */
const NOT_INVITED: PrInvitation = { invited: false, via: null };

/** Trim, drop blanks, and lower-case a configured login list. */
function normaliseLogins(logins: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of logins ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Whether `login` may invite the worker onto a PR.
 *
 * A trusted human is one in `allowedAuthors` that is **not** a fleet
 * account. Fleet logins are required in `allowed_authors` for PR dedup
 * (`fleet_pr_authors`, Issue #3138), so without this exclusion a worker
 * could label or @mention its way onto a human's PR and call it an
 * invitation — the same self-trust hole `verifyOperationalLabels` closes
 * for operational labels (Issue #3225).
 */
function isTrustedInviter(
  login: string | null | undefined,
  allowedAuthors: readonly string[],
  fleetLogins: readonly string[],
): boolean {
  if (typeof login !== "string") return false;
  const key = login.trim().toLowerCase();
  if (key.length === 0) return false;
  if (fleetLogins.includes(key)) return false;
  return allowedAuthors.includes(key);
}

/**
 * Strip the regions of a Markdown body where an `@login` token is quoted
 * text rather than a mention: fenced code blocks, inline code spans, and
 * quoted (`>`) lines.
 *
 * A pasted CI log or a quoted reply routinely contains the worker's login;
 * treating those as invitations would let any body that merely *mentions*
 * the worker conscript it.
 */
function stripQuotedRegions(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence !== null) {
      // Inside a fence — the closing marker must use the same character.
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    // Block quote — someone else's words, not this commenter's instruction.
    if (/^\s{0,3}>/.test(line)) continue;
    kept.push(line);
  }
  // Inline code spans, including multi-backtick spans (`` `a` ``).
  return kept.join("\n").replace(/(`+)[\s\S]*?\1/g, " ");
}

/**
 * Every standalone `@login` token in a body.
 *
 * Hardcoded, not built per target: a regex compiled from configuration is
 * both a ReDoS surface and needless work per login. The character before
 * `@` may not be part of an address or path (so `email@host` and
 * `owner/repo@login` never match), and the captured token runs to the end
 * of the login characters, so `@Vibecoderbot-bot` yields `Vibecoderbot-bot`
 * and never the shorter `Vibecoderbot`.
 */
const MENTION_TOKEN = /(?:^|[^A-Za-z0-9_@/.-])@([A-Za-z0-9_-]+)/g;

/**
 * Whether `body` contains a real `@login` mention of any target login.
 *
 * Matching is case-insensitive — GitHub logins are.
 */
export function bodyMentionsAnyLogin(
  body: string | null | undefined,
  targets: readonly string[],
): boolean {
  if (typeof body !== "string" || body.trim().length === 0) return false;
  const wanted = new Set<string>();
  for (const target of targets) {
    if (typeof target !== "string") continue;
    const key = target.trim().toLowerCase();
    if (key.length > 0) wanted.add(key);
  }
  if (wanted.size === 0) return false;

  const visible = stripQuotedRegions(body);
  for (const match of visible.matchAll(MENTION_TOKEN)) {
    if (wanted.has(match[1]!.toLowerCase())) return true;
  }
  return false;
}

/**
 * Decide whether a trusted human has invited the worker onto this PR.
 *
 * Consulted only for PRs **outside** the maintenance set — fleet-authored
 * PRs are maintained regardless and never reach this predicate.
 *
 * The verdict is derived from the PR's current state only, so there is no
 * sticky invitation: drop the label (or the comment) and the next scan
 * sees `invited: false`.
 *
 * @param pr - The fetched PR facts (labels with adders, comments, reviews).
 * @param options - Host login, trusted humans, fleet logins, invite label.
 * @returns The verdict; `{ invited: false, via: null }` unless a trusted
 *   human's label or @mention is positively established.
 */
export function isPrInvited(
  pr: InvitationPr | null | undefined,
  options: PrInvitationOptions,
): PrInvitation {
  if (pr === null || typeof pr !== "object") return NOT_INVITED;

  const allowedAuthors = normaliseLogins(options.allowedAuthors);
  if (allowedAuthors.length === 0) return NOT_INVITED;

  // The fleet's own accounts: never inviters, always mention targets.
  const fleetLogins = normaliseLogins([
    options.githubUser,
    ...(options.fleetPrAuthors ?? []),
  ]);

  const inviteLabel =
    (typeof options.inviteLabel === "string"
      ? options.inviteLabel
      : DEFAULT_INVITE_LABEL).trim().toLowerCase();

  // Label signal — presence alone proves nothing; the adder must be trusted.
  if (inviteLabel.length > 0 && Array.isArray(pr.labels)) {
    for (const label of pr.labels) {
      if (typeof label?.name !== "string") continue;
      if (label.name.trim().toLowerCase() !== inviteLabel) continue;
      if (!isTrustedInviter(label.addedBy, allowedAuthors, fleetLogins)) {
        continue;
      }
      return {
        invited: true,
        via: "label",
        invitedBy: label.addedBy!.trim(),
      };
    }
  }

  // Mention signal — a trusted human asking this fleet, in their own words.
  if (fleetLogins.length > 0) {
    const bodies = [
      ...(Array.isArray(pr.comments) ? pr.comments : []),
      ...(Array.isArray(pr.reviews) ? pr.reviews : []),
    ];
    for (const entry of bodies) {
      const login = entry?.author?.login;
      if (!isTrustedInviter(login, allowedAuthors, fleetLogins)) continue;
      if (!bodyMentionsAnyLogin(entry?.body, fleetLogins)) continue;
      return { invited: true, via: "mention", invitedBy: login!.trim() };
    }
  }

  return NOT_INVITED;
}
