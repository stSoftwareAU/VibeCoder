/**
 * Deterministic severity-corroboration gate for LLM-filed orphan-deps
 * findings (Issue #1549).
 *
 * The orphan-deps scan is the one idle-task template permitted to read live
 * third-party text mid-run (registry metadata, a source repo's description).
 * The publisher of a dependency authors that text, so a hostile or
 * compromised dependency can try to steer the model's *verdict* — talking a
 * genuinely archived package down to `severity:low`, or a healthy one up to
 * `severity:high` to bury a real finding in noise. Prompt wording alone
 * cannot detect that, so this module re-derives, deterministically, whether
 * the severity the model attached is consistent with the structured signals
 * the native pre-filer (`orphan_deps_scanner.ts`) uses:
 *
 *   - `severity:high` is reachable only from a **strong** structured signal
 *     — a registry `deprecated` / `yanked` flag, or an archived source
 *     repository. A high with none of those cited is `overstated`.
 *   - A finding that **does** cite a strong signal but claims anything
 *     weaker than high is `understated`.
 *   - Everything else (staleness at `severity:low`) is `corroborated`.
 *
 * The citation must appear **outside** any untrusted fence in the body: the
 * companion `orphan_deps_untrusted.ts` boundary is what makes that region
 * identifiable, so a `archived: true` planted by an attacker inside quoted
 * registry text corroborates nothing.
 *
 * A disagreement is never silently corrected — the severity the scan filed
 * stands, and the issue is flagged for a human with an explanatory comment
 * (the label-plus-comment pairing the escalation rule requires). A lookup or
 * escalation that fails is returned in `failures` so the caller reports it
 * rather than treating silence as a pass.
 *
 * Australian English spelling used throughout (behaviour, organisation,
 * authorised).
 */

/** Severity bands an orphan-deps finding may carry. */
export type OrphanSeverityBand = "high" | "medium" | "low";

/** Label applied to a finding whose severity could not be corroborated. */
export const ORPHAN_SEVERITY_REVIEW_LABEL = "needs-human";

/** Colour used when the escalation label has to be created. */
const REVIEW_LABEL_COLOUR = "D93F0B";

/**
 * Machine-checkable citations of a **strong** orphan signal, in the exact
 * vocabulary `orphan_deps_scanner.ts` emits and `prompts/orphan_deps` asks
 * Claude for: the two strong check classes, the backticked registry field,
 * an `archived: true` repository flag, and a yanked package/version.
 */
const STRONG_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bORPHAN-DEPRECATED\b/,
  /\bORPHAN-ARCHIVED\b/,
  /`deprecated`/,
  /\barchived:\s*true\b/i,
  /\byanked\b/i,
];

/** A complete untrusted fence, as rendered by `fenceUntrustedIssueText`. */
const FENCED_BLOCK =
  /^---BEGIN UNTRUSTED USER CONTENT BOUNDARY_[0-9A-Za-z]+---$[\s\S]*?^---END UNTRUSTED USER CONTENT BOUNDARY_[0-9A-Za-z]+---$/gm;

/** The opening marker on its own line — used to find a dangling fence. */
const FENCE_START =
  /^---BEGIN UNTRUSTED USER CONTENT BOUNDARY_[0-9A-Za-z]+---$/m;

/**
 * Remove every untrusted-fenced region from `body`.
 *
 * A fence with no closing marker is treated as running to the end of the
 * body — the safe reading, since the alternative would let an attacker
 * escape the exclusion simply by omitting the closing marker.
 *
 * Pure — no I/O.
 *
 * @param body - The filed issue body
 * @returns The body with all quoted untrusted text removed
 */
export function stripFencedUntrustedText(body: string): string {
  const withoutBlocks = body.replace(FENCED_BLOCK, "");
  const dangling = withoutBlocks.search(FENCE_START);
  return dangling === -1 ? withoutBlocks : withoutBlocks.slice(0, dangling);
}

/**
 * Does `body` cite a strong structured orphan signal in the worker's own
 * voice — that is, outside any quoted untrusted region?
 *
 * Pure — no I/O.
 *
 * @param body - The filed issue body
 * @returns True when a deprecated / yanked / archived citation is present
 */
export function citesStrongOrphanSignal(body: string): boolean {
  const trusted = stripFencedUntrustedText(body);
  return STRONG_SIGNAL_PATTERNS.some((pattern) => pattern.test(trusted));
}

/**
 * Read the single `severity:<band>` label off a filed finding.
 *
 * Pure — no I/O.
 *
 * @param labels - The issue's label names
 * @returns The claimed band, or `null` when none (or more than one) is set
 */
export function claimedSeverity(
  labels: readonly string[],
): OrphanSeverityBand | null {
  const bands = labels
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.startsWith("severity:"))
    .map((name) => name.slice("severity:".length));
  const unique = [...new Set(bands)];
  if (unique.length !== 1) return null;
  const band = unique[0];
  return band === "high" || band === "medium" || band === "low" ? band : null;
}

/** How a filed severity compares with the structured evidence in its body. */
export type OrphanSeverityStatus =
  | "corroborated"
  | "overstated"
  | "understated"
  | "unlabelled";

/** The gate's verdict on one filed finding. */
export interface OrphanSeverityVerdict {
  /** The band the finding claims, or `null` when it carries none. */
  claimed: OrphanSeverityBand | null;
  /** Whether the claim is consistent with the body's structured evidence. */
  status: OrphanSeverityStatus;
  /** One line explaining the verdict — quoted into the flag comment. */
  reason: string;
}

/** True when the verdict needs a human to look at the finding. */
export function isFlaggedVerdict(verdict: OrphanSeverityVerdict): boolean {
  return verdict.status !== "corroborated";
}

/**
 * Compare a filed finding's severity label against the structured evidence
 * its body cites.
 *
 * Pure — no I/O.
 *
 * @param opts - The issue's labels and body
 * @returns The verdict
 */
export function gateOrphanDepsSeverity(
  opts: { labels: readonly string[]; body: string },
): OrphanSeverityVerdict {
  const claimed = claimedSeverity(opts.labels);
  const strong = citesStrongOrphanSignal(opts.body);

  if (claimed === null) {
    return {
      claimed: null,
      status: "unlabelled",
      reason:
        "the finding carries no single `severity:<level>` label, so its " +
        "severity cannot be corroborated against the scan's structured " +
        "signals",
    };
  }
  if (claimed === "high" && !strong) {
    return {
      claimed,
      status: "overstated",
      reason:
        "`severity:high` is reachable only from a structured signal the " +
        "scan can check — a registry `deprecated` / `yanked` flag or an " +
        "archived source repository — and the body cites none outside its " +
        "quoted third-party text",
    };
  }
  if (claimed !== "high" && strong) {
    return {
      claimed,
      status: "understated",
      reason:
        `the body cites a strong signal (registry \`deprecated\` / yanked, ` +
        `or an archived source repository) yet the finding claims ` +
        `\`severity:${claimed}\``,
    };
  }
  return {
    claimed,
    status: "corroborated",
    reason: `\`severity:${claimed}\` agrees with the structured evidence ` +
      "cited in the body",
  };
}

/** A finding the gate could not corroborate. */
export interface FlaggedOrphanFinding {
  issueNumber: number;
  verdict: OrphanSeverityVerdict;
}

/** Outcome of verifying one run's newly-filed findings. */
export interface OrphanSeverityGateReport {
  /** Findings whose severity the gate could not corroborate. */
  flagged: FlaggedOrphanFinding[];
  /**
   * Lookups or escalations that did not complete. Never empty-and-ignored:
   * the caller reports these so an unchecked finding is visible rather than
   * mistaken for a pass.
   */
  failures: string[];
}

/** Inputs to {@link verifyFiledOrphanSeverities}. */
export interface VerifyFiledOrphanSeveritiesOptions {
  /** Target repo in `owner/repo` form. */
  repo: string;
  /** Issue numbers filed by this run's scan. */
  issueNumbers: readonly number[];
  /** `gh` CLI runner (injected in tests). */
  ghCommandFn: (args: string[]) => Promise<string>;
}

/** Render the comment posted on a flagged finding. */
function flagComment(verdict: OrphanSeverityVerdict): string {
  const claimed = verdict.claimed === null
    ? "no `severity:<level>` label"
    : `\`severity:${verdict.claimed}\``;
  return [
    "## Severity not corroborated — human review needed",
    "",
    `This orphan-dependency finding was filed with ${claimed}, but the ` +
    "deterministic severity gate could not corroborate that against the " +
    "structured signals the scan checks (Issue #1549).",
    "",
    `**Why:** ${verdict.reason}.`,
    "",
    "The scan reads live registry / source-host metadata authored by each " +
    "package's publisher, so a steered verdict is a real possibility. " +
    "Nothing has been changed automatically — the severity above still " +
    "stands. A human should confirm the band against the cited evidence, " +
    `then remove \`${ORPHAN_SEVERITY_REVIEW_LABEL}\`.`,
  ].join("\n");
}

/**
 * Verify the severity of each finding a scan run filed, and flag every one
 * the structured evidence does not corroborate.
 *
 * For a flagged finding the gate posts an explanatory comment and applies
 * {@link ORPHAN_SEVERITY_REVIEW_LABEL} — comment and label together, as the
 * escalation rule requires. It never edits the severity itself.
 *
 * Never throws: a failed lookup or escalation is recorded in
 * `failures` so the caller can surface it.
 *
 * @param opts - Repo, filed issue numbers, and the `gh` runner
 * @returns The flagged findings and any failures
 */
export async function verifyFiledOrphanSeverities(
  opts: VerifyFiledOrphanSeveritiesOptions,
): Promise<OrphanSeverityGateReport> {
  const flagged: FlaggedOrphanFinding[] = [];
  const failures: string[] = [];

  for (const issueNumber of opts.issueNumbers) {
    let raw: string;
    try {
      raw = await opts.ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        opts.repo,
        "--json",
        "labels,body",
      ]);
    } catch (err) {
      failures.push(
        `orphan-deps severity gate: could not read #${issueNumber} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    let parsed: { labels?: unknown; body?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      failures.push(
        `orphan-deps severity gate: unparseable \`gh issue view\` output ` +
          `for #${issueNumber} — ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      continue;
    }

    // An unexpected response shape is a check that did not happen, not a
    // pass: record it and move on rather than inventing a verdict from an
    // empty label set.
    if (!Array.isArray(parsed.labels) || typeof parsed.body !== "string") {
      failures.push(
        `orphan-deps severity gate: unexpected \`gh issue view\` shape for ` +
          `#${issueNumber} — no labels/body to check`,
      );
      continue;
    }
    const labels = (parsed.labels as Array<{ name?: unknown }>)
      .map((label) => label?.name)
      .filter((name): name is string => typeof name === "string");
    const body = parsed.body;
    const verdict = gateOrphanDepsSeverity({ labels, body });
    if (!isFlaggedVerdict(verdict)) continue;

    flagged.push({ issueNumber, verdict });
    const escalation = await escalate(opts, issueNumber, verdict);
    if (escalation !== null) failures.push(escalation);
  }

  return { flagged, failures };
}

/**
 * Comment on and label a flagged finding. Returns `null` on success, or the
 * failure message to record.
 */
async function escalate(
  opts: VerifyFiledOrphanSeveritiesOptions,
  issueNumber: number,
  verdict: OrphanSeverityVerdict,
): Promise<string | null> {
  try {
    await opts.ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      opts.repo,
      "--body",
      flagComment(verdict),
    ]);
  } catch (err) {
    return `orphan-deps severity gate: could not comment on #${issueNumber} ` +
      `— ${err instanceof Error ? err.message : String(err)}`;
  }

  // The label must exist before it can be added; an already-existing label
  // makes `gh label create` fail, which is the expected case and not a
  // failure of the escalation.
  try {
    await opts.ghCommandFn([
      "label",
      "create",
      ORPHAN_SEVERITY_REVIEW_LABEL,
      "--repo",
      opts.repo,
      "--color",
      REVIEW_LABEL_COLOUR,
      "--description",
      "Needs a human to take over",
    ]);
  } catch {
    // Already present — proceed to the add below, which is the step that
    // must succeed.
  }

  try {
    await opts.ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      opts.repo,
      "--add-label",
      ORPHAN_SEVERITY_REVIEW_LABEL,
    ]);
  } catch (err) {
    return `orphan-deps severity gate: could not label #${issueNumber} with ` +
      `${ORPHAN_SEVERITY_REVIEW_LABEL} — ${
        err instanceof Error ? err.message : String(err)
      }`;
  }
  return null;
}
