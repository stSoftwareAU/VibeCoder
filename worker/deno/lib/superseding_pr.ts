/**
 * Existing-PR disposition for a run that was interrupted or produced nothing
 * to raise (Issue #218).
 *
 * The worker's self-healing shortcut "a PR exists for this issue → treat the
 * run as a success and continue" was written for the case it was named for
 * (Issue #386): OUR run pushed a PR just before the watchdog fired. It reads
 * only whether `findExistingPrForIssue` returned something, so ANY PR — open
 * or merged or recently closed, ours or a sibling worker's — silenced the
 * interrupted-run handling.
 *
 * On VibeCoder#185 that misfired twice over: a sibling host's PR #215 merged
 * mid-run, the timeout path took the shortcut before preserving 51 minutes of
 * uncommitted work, and the run then continued into a completion phase whose
 * branch was by then level with `main` ("no commits ahead", released as an
 * `unknown` failure).
 *
 * This module splits the two cases apart:
 *
 *  - **open** — work is in flight on a PR; continuing is right, as before;
 *  - **superseded** — the PR is MERGED or CLOSED, so this run has nothing
 *    left to raise. The caller stops with a `superseded:pr#N` outcome rather
 *    than grinding through the rest of the pipeline and blaming the agent.
 *
 * Every lookup failure fails safe to `open`, which is the pre-#218
 * behaviour ("continue"): a `gh` hiccup must never turn a live run into a
 * spurious "superseded" stop.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { prNumberFromUrl } from "./run_outcome.ts";

/** PR states that mean this run has nothing left to raise. */
export type SupersedingPrState = "MERGED" | "CLOSED";

/** What an existing PR for the issue means for the run asking about it. */
export type ExistingPrDisposition =
  | { kind: "none" }
  | {
    kind: "open";
    prUrl: string;
    /** 0 when the URL carried no parseable number. */
    prNumber: number;
    /** Branch the PR was raised from, when `gh` reported it. */
    headRefName?: string;
  }
  | {
    kind: "superseded";
    prState: SupersedingPrState;
    prUrl: string;
    prNumber: number;
    headRefName?: string;
  };

/** Injectable seams — the phase passes its own `deps.pr` / `deps.github`. */
export interface ClassifyExistingPrDeps {
  findExistingPrForIssue: (
    repo: string,
    issueNumber: number,
  ) => Promise<Result<string, Error>>;
  runGhCommand: (args: string[]) => Promise<string>;
  /** Optional — every fail-safe fallback is logged rather than swallowed. */
  warn?: (message: string) => void;
}

/**
 * Normalise what an existing-PR lookup returned into a URL and a number.
 *
 * `findExistingPrForIssue` resolves to a PR URL string, but the same seam is
 * mocked with `{ url, number }` objects and with `null` across the suite, and
 * `merged_pr_precheck_phase.ts` already carries a defensive check for it.
 * Returns null when the value names no PR at all.
 */
function normalisePrReference(
  value: unknown,
): { prUrl: string; prNumber: number } | null {
  if (typeof value === "string") {
    return value.length > 0
      ? { prUrl: value, prNumber: prNumberFromUrl(value) }
      : null;
  }
  if (value && typeof value === "object") {
    const record = value as { url?: unknown; number?: unknown };
    const prUrl = typeof record.url === "string" ? record.url : "";
    const prNumber = typeof record.number === "number" && record.number > 0
      ? record.number
      : prNumberFromUrl(prUrl);
    if (prUrl.length > 0 || prNumber > 0) return { prUrl, prNumber };
  }
  return null;
}

/**
 * Classify the existing PR for an issue as absent, open, or superseding.
 *
 * Never throws: a lookup that errors resolves to `none` (no PR found) or
 * `open` (PR found, state unreadable) — the two dispositions that preserve
 * the caller's pre-#218 behaviour — with the reason logged through `warn`.
 */
export async function classifyExistingPrForIssue(
  repo: string,
  issueNumber: number,
  deps: ClassifyExistingPrDeps,
): Promise<ExistingPrDisposition> {
  const warn = deps.warn ?? (() => {});

  let found: Result<string, Error>;
  try {
    found = await deps.findExistingPrForIssue(repo, issueNumber);
  } catch (err) {
    warn(
      `Existing-PR lookup for ${repo}#${issueNumber} threw (treated as no ` +
        `PR): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "none" };
  }
  if (!found.ok) return { kind: "none" };
  const reference = normalisePrReference(found.value);
  if (!reference) return { kind: "none" };
  const { prUrl, prNumber } = reference;
  if (prNumber <= 0) {
    warn(
      `Could not parse a PR number from '${prUrl}' — treating the PR as open ` +
        `(Issue #218)`,
    );
    return { kind: "open", prUrl, prNumber: 0 };
  }

  let state = "";
  let headRefName: string | undefined;
  try {
    const output = await deps.runGhCommand([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,headRefName",
    ]);
    const parsed = JSON.parse(output) as {
      state?: unknown;
      headRefName?: unknown;
    };
    state = typeof parsed.state === "string" ? parsed.state.toUpperCase() : "";
    headRefName = typeof parsed.headRefName === "string"
      ? parsed.headRefName
      : undefined;
  } catch (err) {
    warn(
      `Could not read the state of PR #${prNumber} on ${repo} — treating it ` +
        `as open (Issue #218): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return { kind: "open", prUrl, prNumber };
  }

  if (state === "MERGED" || state === "CLOSED") {
    return {
      kind: "superseded",
      prState: state,
      prUrl,
      prNumber,
      ...(headRefName ? { headRefName } : {}),
    };
  }
  if (state !== "OPEN") {
    warn(
      `Unrecognised state '${state}' for PR #${prNumber} on ${repo} — ` +
        `treating it as open (Issue #218)`,
    );
  }
  return {
    kind: "open",
    prUrl,
    prNumber,
    ...(headRefName ? { headRefName } : {}),
  };
}

/**
 * Failure-free reason string for a superseded run, carried into the
 * claim-release comment.
 *
 * Starts with the stable `superseded:pr#N` token so a log line and the
 * derived {@link RunOutcome} read the same way, and names the preserved WIP
 * when there was any — the branch is the only place that work now lives.
 */
export function formatSupersededReason(
  disposition: Extract<ExistingPrDisposition, { kind: "superseded" }>,
  wipNote?: string,
): string {
  const verb = disposition.prState === "MERGED" ? "merged" : "closed";
  return `superseded:pr#${disposition.prNumber} — this issue is already ` +
    `resolved by ${verb} PR ${disposition.prUrl}, so this run raised none` +
    (wipNote ? ` — ${wipNote}` : "");
}
