/**
 * Detection of an "already resolved, with evidence" agent outcome (Issue #241).
 *
 * A `work-on` run that reads the code, finds the issue already fixed on the
 * default branch and says so should end with the issue **closed with a note**.
 * VibeCoder#241 records the failure: on NEAT-AI-Backpropagation#96 the agent
 * verified the fix (commit `4c6f932`, PR #97, test re-run) and the worker still
 * posted a "Partial Answer" and escalated to `needs-human`, because the #519
 * keyword list did not contain the phrasing the agent actually used.
 *
 * Two signals are read here, in order:
 *
 *   1. **The marker** — {@link ALREADY_RESOLVED_MARKER_NAME}, parsed
 *      deterministically like `vibe-cross-repo-pr`. This is the primary signal
 *      and carries its evidence as attributes.
 *   2. **A keyword claim** — the broadened phrase list, kept so older prompt
 *      versions still close. It closes only when the output *also* cites a
 *      commit SHA or a PR reference.
 *
 * Either way, closing requires **cited evidence**: a commit and/or PR reference
 * (and, on the marker path, how the fix was verified). A bare "this is already
 * fixed" is reported as {@link AlreadyResolvedDetection} `unverified` and the
 * caller falls back to the analysis-only hand-off — deliberately tighter than
 * the #519 keyword path it replaces, and the reason this cannot recreate the
 * #174 failure of closing an issue by inference from a PR reference.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { detectAlreadyComplete } from "./claude_executor.ts";

/**
 * The marker an agent emits to declare the issue already resolved.
 *
 * Canonical form (on its own line):
 *
 *   <!-- vibe-already-resolved commit="4c6f932" pr="owner/repo#97"
 *        verified="ran deno test tests/foo_test.ts — passes on Develop" -->
 *
 * `verified` is required, as is at least one of `commit` / `pr`.
 */
export const ALREADY_RESOLVED_MARKER_NAME = "vibe-already-resolved";

/** Longest verification note quoted into the close comment. */
const MAX_VERIFICATION_LENGTH = 600;

/** The evidence backing an already-resolved close. */
export interface AlreadyResolvedEvidence {
  /** Commit that landed the fix, normalised to a lowercase SHA. */
  commit?: string;
  /** PR that landed the fix, as `#N` or `owner/repo#N`. */
  pr?: string;
  /** How the agent verified the fix (e.g. the test it ran). */
  verification?: string;
}

/** An evidence-backed already-resolved outcome. */
export interface AlreadyResolvedOutcome {
  evidence: AlreadyResolvedEvidence;
  /** Which signal fired — the explicit marker, or the keyword fallback. */
  source: "marker" | "keyword";
}

/** Outcome of scanning agent output for an already-resolved claim. */
export type AlreadyResolvedDetection =
  | { status: "none" }
  | { status: "resolved"; outcome: AlreadyResolvedOutcome }
  | { status: "unverified"; reason: string };

const MARKER_RE = new RegExp(
  `<!--\\s*${ALREADY_RESOLVED_MARKER_NAME}\\b([^]*?)-->`,
  "i",
);

/**
 * Matches every `name="…"` / `name='…'` attribute in the marker's inner text.
 * The name is data, matched against the captured group, so no pattern is ever
 * compiled from a variable.
 */
const ATTRIBUTE_RE = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A commit SHA: 7–40 hex characters. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Any SHA-shaped token inside a line, ignoring surrounding backticks. */
const SHA_TOKEN_RE = /(?:^|[\s(`'"[])([0-9a-f]{7,40})(?=[\s)`'".,;:\]]|$)/gi;

/** A line that names a commit — where a SHA token counts as evidence. */
const COMMIT_CONTEXT_RE = /\bcommits?\b/i;

/** `PR #N` / `pull request owner/repo#N`, anywhere in the output. */
const PR_MENTION_RE =
  /\b(?:prs?|pull requests?)\b[^\n#]{0,24}?(?:([A-Za-z0-9][\w.-]*\/[\w.-]+))?#(\d+)/gi;

/** A PR reference as written in the marker's `pr` attribute. */
const PR_FIELD_RE = /^(?:([A-Za-z0-9][\w.-]*\/[\w.-]+))?#?(\d+)$/;

/** A GitHub PR URL, as the marker's `pr` attribute may carry one. */
const PR_URL_RE =
  /^https?:\/\/[^\s/]+\/([A-Za-z0-9][\w.-]*\/[\w.-]+)\/pull\/(\d+)\b/i;

/**
 * Phrasings the #519 list missed, kept alongside `detectAlreadyComplete()`
 * rather than folded into it: that regex also drives the `claude_runner`
 * command, and widening it there would change an unrelated caller.
 */
const EXTRA_CLAIM_RE =
  /(?:no code change(?:s)? (?:is|was|are|were) (?:needed|required|necessary))|(?:\b(?:was|is|has been) (?:already )?(?:fixed|resolved|implemented|addressed) (?:on|in|by|via)\b)/i;

/** Case-insensitive `owner/repo` comparison. */
function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Flatten and length-cap an untrusted marker field so it is safe to publish in
 * a GitHub comment: control characters collapse to spaces, and HTML-comment
 * breakout sequences are neutralised. Deliberately local rather than shared
 * with `cross_repo_pr_handoff.ts` — importing that module would drag `gh`
 * spawning and the write-repo allowlist into a pure detection module.
 */
function flattenField(raw: string | undefined, maxLen: number): string {
  if (!raw) return "";
  let out = raw
    // Keep a space inside the token so a longer run cannot re-form it.
    .replace(/-->/g, "- ->")
    .replace(/<!--/g, "<!- -")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > maxLen) out = out.slice(0, maxLen).trimEnd() + "…";
  return out;
}

/** Extract one attribute from the marker's inner text. */
function attribute(inner: string, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const match of inner.matchAll(ATTRIBUTE_RE)) {
    if (match[1]?.toLowerCase() !== wanted) continue;
    return match[2] ?? match[3];
  }
  return undefined;
}

/** The issue being worked, so it is never cited as its own evidence. */
export interface AlreadyResolvedSelf {
  repo: string;
  issueNumber: number;
}

/** Render a PR reference, dropping the repo when it is the issue's own. */
function formatPrRef(
  repo: string | undefined,
  number: number,
  self: AlreadyResolvedSelf,
): string | undefined {
  // The issue can never be the PR that fixed it — a self-reference is a
  // restatement of the issue, not evidence (Issue #174).
  if (
    number === self.issueNumber &&
    (repo === undefined || sameRepo(repo, self.repo))
  ) {
    return undefined;
  }
  return repo && !sameRepo(repo, self.repo)
    ? `${repo}#${number}`
    : `#${number}`;
}

/** Normalise the marker's `commit` attribute to a lowercase SHA. */
function normaliseCommit(raw: string): string | undefined {
  const text = raw.replace(/[`'"]/g, "").trim();
  return SHA_RE.test(text) ? text.toLowerCase() : undefined;
}

/** Normalise the marker's `pr` attribute to `#N` / `owner/repo#N`. */
function normalisePr(
  raw: string,
  self: AlreadyResolvedSelf,
): string | undefined {
  const text = raw.replace(/[`'"]/g, "").replace(
    /^(?:prs?|pull request)\s*/i,
    "",
  )
    .trim();
  const url = PR_URL_RE.exec(text);
  if (url) return formatPrRef(url[1], parseInt(url[2]!, 10), self);
  const ref = PR_FIELD_RE.exec(text);
  if (!ref) return undefined;
  return formatPrRef(ref[1], parseInt(ref[2]!, 10), self);
}

/** The first commit SHA cited on a line that names a commit. */
function citedCommit(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (!COMMIT_CONTEXT_RE.test(line)) continue;
    SHA_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SHA_TOKEN_RE.exec(line)) !== null) {
      const token = match[1]!;
      // A run of digits is an issue number or a date, not a SHA.
      if (!/[a-f]/i.test(token)) continue;
      return token.toLowerCase();
    }
  }
  return undefined;
}

/** The first PR reference cited in the output, other than the issue itself. */
function citedPr(
  output: string,
  self: AlreadyResolvedSelf,
): string | undefined {
  PR_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PR_MENTION_RE.exec(output)) !== null) {
    const ref = formatPrRef(match[1], parseInt(match[2]!, 10), self);
    if (ref) return ref;
  }
  return undefined;
}

/** Parse the marker, when the output carries one. */
function detectMarker(
  output: string,
  self: AlreadyResolvedSelf,
): AlreadyResolvedDetection {
  const markerMatch = MARKER_RE.exec(output);
  if (!markerMatch) return { status: "none" };

  const inner = markerMatch[1] ?? "";
  const commit = normaliseCommit(flattenField(attribute(inner, "commit"), 64));
  const pr = normalisePr(flattenField(attribute(inner, "pr"), 200), self);
  const verification = flattenField(
    attribute(inner, "verified") ?? attribute(inner, "verification"),
    MAX_VERIFICATION_LENGTH,
  );

  if (!commit && !pr) {
    return {
      status: "unverified",
      reason:
        "the already-resolved marker cites no usable commit or PR reference",
    };
  }
  if (verification.length === 0) {
    return {
      status: "unverified",
      reason:
        "the already-resolved marker does not say how the fix was verified",
    };
  }
  return {
    status: "resolved",
    outcome: {
      source: "marker",
      evidence: {
        ...(commit ? { commit } : {}),
        ...(pr ? { pr } : {}),
        verification,
      },
    },
  };
}

/**
 * Detect an evidence-backed "already resolved" outcome in an agent's output.
 *
 * @param output - The agent's stdout for the run.
 * @param self - The issue being worked, so it is never its own evidence.
 * @returns `resolved` with the cited evidence, `unverified` when the run
 *   claimed the issue was already fixed without citing any, or `none` when it
 *   made no such claim at all.
 */
export function detectAlreadyResolved(
  output: string | undefined | null,
  self: AlreadyResolvedSelf,
): AlreadyResolvedDetection {
  if (!output || !output.trim()) return { status: "none" };

  // The marker is the primary signal and is authoritative: a marker that is
  // present but missing its evidence hands off rather than falling through to
  // the looser keyword path.
  const marker = detectMarker(output, self);
  if (marker.status !== "none") return marker;

  const claimed = detectAlreadyComplete(output) || EXTRA_CLAIM_RE.test(output);
  if (!claimed) return { status: "none" };

  const commit = citedCommit(output);
  const pr = citedPr(output, self);
  if (!commit && !pr) {
    return {
      status: "unverified",
      reason:
        "the run reported the issue already fixed but cited no commit or PR",
    };
  }
  return {
    status: "resolved",
    outcome: {
      source: "keyword",
      evidence: {
        ...(commit ? { commit } : {}),
        ...(pr ? { pr } : {}),
      },
    },
  };
}

/**
 * Render the evidence as markdown bullets for the close comment, so the
 * closure is auditable from the issue alone.
 */
export function formatAlreadyResolvedEvidence(
  evidence: AlreadyResolvedEvidence,
): string {
  const lines: string[] = [];
  if (evidence.commit) lines.push(`- **Commit:** \`${evidence.commit}\``);
  if (evidence.pr) lines.push(`- **PR:** ${evidence.pr}`);
  if (evidence.verification) {
    lines.push(`- **Verified by:** ${evidence.verification}`);
  }
  return lines.join("\n");
}
