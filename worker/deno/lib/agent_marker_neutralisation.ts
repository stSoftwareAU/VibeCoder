/**
 * Neutralise worker marker syntax in agent-authored text (Issue #2236).
 *
 * The CI-fix and PR-feedback lanes post the agent's own `.pr_response_message`
 * verbatim into a comment the **fleet account** authors, and those
 * fleet-authored bodies are the fleet-wide record of CI-fix attempts and
 * deferrals (Issue #1879). That record is gated on the *comment's* author, so
 * a `<!-- vibe-ci-fix-attempt … -->` or `<!-- vibe-ci-fix-deferred … -->`
 * marker smuggled into the agent's message would be posted by the fleet and
 * read back as the fleet's own claim: a forged deferral parks a red pull
 * request for good, and forged attempts exhaust the shared attempt budget.
 *
 * The agent's message condenses the failing check's annotations, the fetched
 * Actions log and the branch's own files — all attacker-influenced on a
 * monitored repository — so it is untrusted text inside a trusted container.
 *
 * Two properties this module exists to hold:
 *
 * - **Neutralise by construction, never by name.** Every HTML-comment
 *   delimiter is made inert, so no marker of any name — including one added
 *   years from now — can be opened or closed by agent text. A filter naming
 *   the markers it knows is a bad-tag-filter, and the next marker name
 *   silently reopens the hole.
 * - **Fail loud.** Marker syntax in agent text is a prompt-injection attempt,
 *   not a formatting quirk. {@link neutraliseAgentMarkers} reports what it
 *   defused so the caller can log it rather than swallow it.
 *
 * The neutralisation runs on the agent's text alone. The worker's own marker
 * is concatenated afterwards and is untouched, so #1879's fleet-wide tally
 * still parses exactly as before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Most marker-like names carried in the report; the rest are counted only. */
const MAX_REPORTED_NAMES = 5;

/** Longest name reported, so a log line cannot be flooded. */
const MAX_NAME_LENGTH = 64;

/** Opening delimiter of an HTML comment — how every marker starts. */
const COMMENT_OPEN = /<!--/g;

/** Closing delimiter — how every marker ends. */
const COMMENT_CLOSE = /-->/g;

/**
 * The name directly after an opening delimiter.
 *
 * Used **only** to describe what was defused in the warning; the
 * neutralisation itself never consults it.
 */
const MARKER_NAME_RE = /<!--\s*([A-Za-z][A-Za-z0-9_:.-]*)/g;

/** What {@link neutraliseAgentMarkers} defused. */
export interface AgentMarkerNeutralisation {
  /** The text with every HTML-comment delimiter made inert. */
  text: string;
  /** How many delimiters were neutralised; `0` means the text is unchanged. */
  neutralised: number;
  /** Marker-like names seen, for the warning — never used as a filter. */
  names: string[];
}

/**
 * Make every HTML-comment delimiter in agent-authored text inert.
 *
 * A space is kept inside each neutralised token (`<!- -`, `- ->`) so a longer
 * run of dashes cannot re-form the delimiter, and the text stays readable:
 * the injected marker is visible in the posted comment rather than silently
 * deleted, which is what makes an attempt evident to a reviewer.
 *
 * @param text - The agent's own message.
 * @returns The inert text, plus what was defused.
 */
export function neutraliseAgentMarkers(
  text: string,
): AgentMarkerNeutralisation {
  const opens = text.match(COMMENT_OPEN)?.length ?? 0;
  const closes = text.match(COMMENT_CLOSE)?.length ?? 0;
  if (opens === 0 && closes === 0) {
    return { text, neutralised: 0, names: [] };
  }

  const names: string[] = [];
  for (const match of text.matchAll(MARKER_NAME_RE)) {
    const name = (match[1] ?? "").slice(0, MAX_NAME_LENGTH);
    if (name.length === 0 || names.includes(name)) continue;
    if (names.length >= MAX_REPORTED_NAMES) break;
    names.push(name);
  }

  return {
    text: text.replace(COMMENT_CLOSE, "- ->").replace(COMMENT_OPEN, "<!- -"),
    neutralised: opens + closes,
    names,
  };
}
