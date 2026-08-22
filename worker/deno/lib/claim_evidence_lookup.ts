/**
 * Claim-time evidence lookup for the adaptive runway floor (Issue #245).
 *
 * `claim_runway_evidence.ts` decides; this fetches what it decides on. One
 * `gh issue view --json labels,comments` per candidate answers all three
 * evidence sources: the labels carry the size label, and the fleet's own
 * release comments carry the preserved-WIP marker and the collapsed attempt
 * tally naming a prior `timeout` in `execute`.
 *
 * Only **fleet-authored** comments are read. Those markers are worker-written,
 * so a comment from an untrusted author that spelled one out would otherwise
 * be able to keep an issue from ever being claimed late in a cycle.
 *
 * A failed lookup is reported, never swallowed: the caller receives
 * `lookupError` and logs it, and the claim proceeds exactly as it did before
 * this gate existed — the gate only ever *refuses* claims, so failing open
 * cannot invent a skip from a `gh` outage.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  evidenceFromIssueSignals,
  type IssueClaimEvidence,
} from "./claim_runway_evidence.ts";

/** What {@link fetchIssueClaimEvidence} found — and why, when it found nothing. */
export interface ClaimEvidenceLookup {
  evidence: IssueClaimEvidence;
  /** Set when the lookup could not complete; the caller must log it. */
  lookupError?: string;
}

/** Fetch an issue's claim-time evidence. Never throws. */
export async function fetchIssueClaimEvidence(options: {
  repo: string;
  issueNumber: number;
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Logins whose comments are trusted as worker output. */
  fleetAuthors: readonly string[];
  /** Configured long-job labels; defaults apply when absent. */
  longJobLabels?: readonly string[];
}): Promise<ClaimEvidenceLookup> {
  const { repo, issueNumber, ghCommandFn } = options;
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels,comments",
    ]);
  } catch (err) {
    return {
      evidence: {},
      lookupError: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: {
    labels?: Array<{ name?: unknown }>;
    comments?: Array<{ body?: unknown; author?: { login?: unknown } }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      evidence: {},
      lookupError: `unparseable \`gh issue view\` output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const fleet = new Set(
    options.fleetAuthors.map((author) => author.trim().toLowerCase()).filter(
      (author) => author.length > 0,
    ),
  );
  const labels = (parsed.labels ?? [])
    .map((label) => label?.name)
    .filter((name): name is string => typeof name === "string");
  const commentBodies = (parsed.comments ?? [])
    .filter((comment) => {
      const login = comment?.author?.login;
      return typeof login === "string" && fleet.has(login.trim().toLowerCase());
    })
    .map((comment) => comment?.body)
    .filter((body): body is string => typeof body === "string");

  return {
    evidence: evidenceFromIssueSignals({
      labels,
      commentBodies,
      ...(options.longJobLabels
        ? { longJobLabels: options.longJobLabels }
        : {}),
    }),
  };
}
