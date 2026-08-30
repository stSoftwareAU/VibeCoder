/**
 * Observed gitleaks coverage on recent pull requests (Issue #601, part of
 * #566).
 *
 * `auditRepoWorkflows` matches workflow file *content*, so a repo passes the
 * gitleaks check for merely committing a file that mentions gitleaks. A
 * present workflow can still never run: Actions disabled for the repository,
 * the workflow disabled in the Actions UI, a `pull_request` branch filter
 * that misses the PRs' base branch, a job `if:` that never fires, or a YAML
 * error that stops the workflow being registered. All of those read as
 * "present" today.
 *
 * This scanner closes the gap between "the workflow is committed" and "the
 * scan ran". Read-only via an injected {@link GhCommandFn}:
 *
 *   1. list the most recently updated closed pull requests for the repo;
 *   2. read the check runs on each PR's head SHA; and
 *   3. decide whether a gitleaks check actually *reported* — a `skipped`
 *      conclusion scans nothing, so it counts as not-reported.
 *
 * One `severity:medium` finding per repo, stable id
 * {@link GITLEAKS_PR_COVERAGE_FINDING_ID}, filed only when the repo has a
 * gitleaks workflow but no gitleaks check reported on any sampled PR. A repo
 * with no gitleaks workflow emits nothing — that gap is already the
 * missing-workflow issue raised by `setup/workflow_sync.ts`, and duplicating
 * it would be noise.
 *
 * **Never a clean verdict from a partial sample.** Fewer PRs than requested,
 * a failed listing, or a failed check-run lookup is stated in the finding's
 * evidence *and* reported through `onSamplingNote` so the worker log carries
 * it. When nothing at all could be inspected the scanner files nothing and
 * says so loudly, rather than reporting an unobservable repo as covered.
 *
 * The scan reports only. Per the per-repo isolation rule (Issue #3239) any
 * YAML or settings fix rides a normal per-repo change; this scanner raises no
 * PR and touches no other repository.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  CLI_INVOCATION as GITLEAKS_CLI_INVOCATION,
  usesGitleaksAction,
} from "./gitleaks_drift_scanner.ts";
import { isValidRepoSlug } from "./repo_rulesets.ts";
import {
  type GhCommandFn,
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Stable id of the one finding this scanner emits, per repo. */
export const GITLEAKS_PR_COVERAGE_FINDING_ID = "BP-GITLEAKS-NOT-OBSERVED";

/** Closed PRs sampled when the caller states no `sampleSize`. */
export const DEFAULT_PR_SAMPLE_SIZE = 10;

/** A gitleaks observed-coverage finding, ready for `fileWorkflowFinding`. */
export interface GitleaksPrCoverageFinding {
  /** Always {@link GITLEAKS_PR_COVERAGE_FINDING_ID}. */
  findingId: string;
  /** Always `medium`, matching the other gitleaks pre-filers. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** The gitleaks workflow the finding is raised against. */
  file: string;
  /** Best-effort 1-based line the finding cites (the `on:` key). */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance — the usual causes, in diagnosis order. */
  suggestedFix: string;
  /** `## Evidence` block — what was sampled, and what was not. */
  evidence: string;
}

/** Options for {@link scanGitleaksPrCoverage}. */
export interface ScanGitleaksPrCoverageOptions {
  /** Workflow files already read by the caller (`readWorkflowFiles`). */
  files: readonly WorkflowFile[];
  /** Injected `gh` runner — read-only calls only. */
  ghCommandFn: GhCommandFn;
  /** How many recent closed PRs to sample (default 10). */
  sampleSize?: number;
  /** Stable ids suppressed by prior triage — skip the finding. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip the finding. */
  knownOpenFindingIds?: Iterable<string>;
  /**
   * Report a sampling limitation (partial sample, failed lookup, nothing
   * observable). Callers wire this to the worker log so a degraded sample is
   * never silent.
   */
  onSamplingNote?: (note: string) => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MEDIUM_EMOJI = "🟠";

/** A closed pull request and the head SHA its checks ran against. */
interface SampledPr {
  number: number;
  sha: string;
}

/** What one PR's check runs told us about gitleaks. */
type PrObservation = "reported" | "skipped-only" | "absent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A job that runs gitleaks: its id and its declared `name:`, if any. */
interface GitleaksJob {
  id: string;
  name?: string;
}

/** Every job in `file` whose steps run gitleaks (via the action or the CLI). */
function gitleaksJobs(file: WorkflowFile): GitleaksJob[] {
  if (file.kind !== "workflow" || !isRecord(file.parsed)) return [];
  const jobs = file.parsed["jobs"];
  if (!isRecord(jobs)) return [];
  const out: GitleaksJob[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const steps = job["steps"];
    if (!Array.isArray(steps)) continue;
    const runsGitleaks = steps.some((step) => {
      if (!isRecord(step)) return false;
      const uses = typeof step["uses"] === "string" ? step["uses"] : "";
      const run = typeof step["run"] === "string" ? step["run"] : "";
      return usesGitleaksAction(uses) || GITLEAKS_CLI_INVOCATION.test(run);
    });
    if (!runsGitleaks) continue;
    const name = job["name"];
    out.push(typeof name === "string" && name !== "" ? { id, name } : { id });
  }
  return out;
}

/**
 * The lower-cased check-run names a gitleaks job may report under.
 *
 * GitHub names a check run after the job's `name:`, falling back to the job
 * id; the `<workflow> / <job>` form appears on the pull request page and in
 * ruleset check pickers. Both spellings are accepted so the match works
 * whichever surface the name came from.
 */
function candidateCheckNames(files: readonly WorkflowFile[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const workflowName = isRecord(file.parsed) &&
        typeof file.parsed["name"] === "string"
      ? (file.parsed["name"] as string)
      : file.path;
    for (const job of gitleaksJobs(file)) {
      const jobName = job.name ?? job.id;
      names.add(jobName.toLowerCase());
      names.add(`${workflowName} / ${jobName}`.toLowerCase());
    }
  }
  return names;
}

/**
 * Does `checkName` identify a gitleaks check?
 *
 * Any name mentioning gitleaks qualifies, as does an exact match on a
 * candidate derived from the repo's own workflows — the canonical template
 * (Issue #594) reports `gitleaks`, but a repo running the scan inside a
 * differently-named job reports that job's name instead. Matrix jobs expand
 * to `<name> (<combination>)`, so that prefix form is accepted too.
 */
function matchesGitleaksCheck(
  checkName: string,
  candidates: ReadonlySet<string>,
): boolean {
  const name = checkName.trim().toLowerCase();
  if (name === "") return false;
  if (name.includes("gitleaks")) return true;
  for (const candidate of candidates) {
    if (name === candidate || name.startsWith(`${candidate} (`)) return true;
  }
  return false;
}

/** Best-effort: 1-based line of the top-level `on:` key. */
function lineOfOnKey(rawText: string): number {
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^on\s*:/.test(lines[i] as string)) return i + 1;
  }
  return 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** List the most recently updated closed PRs. Throws on a `gh` failure. */
async function listClosedPrs(
  repo: string,
  ghCommandFn: GhCommandFn,
  sampleSize: number,
): Promise<SampledPr[]> {
  const raw = await ghCommandFn([
    "api",
    `repos/${repo}/pulls?state=closed&sort=updated&direction=desc` +
    `&per_page=${sampleSize}`,
  ]);
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(parsed)) return [];
  const prs: SampledPr[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const number = entry["number"];
    const head = entry["head"];
    const sha = isRecord(head) ? head["sha"] : undefined;
    if (typeof number !== "number" || typeof sha !== "string") continue;
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    prs.push({ number, sha });
  }
  return prs.slice(0, sampleSize);
}

/** Read one PR's check runs and classify them. Throws on a `gh` failure. */
async function observePr(
  repo: string,
  pr: SampledPr,
  ghCommandFn: GhCommandFn,
  candidates: ReadonlySet<string>,
): Promise<PrObservation> {
  const raw = await ghCommandFn([
    "api",
    `repos/${repo}/commits/${pr.sha}/check-runs?per_page=100`,
  ]);
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  const runs = isRecord(parsed) && Array.isArray(parsed["check_runs"])
    ? parsed["check_runs"]
    : [];
  let sawSkipped = false;
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const name = run["name"];
    if (typeof name !== "string") continue;
    if (!matchesGitleaksCheck(name, candidates)) continue;
    // A skipped job scans nothing, so it is not a report — but it does prove
    // the workflow was evaluated, which is worth citing in the evidence.
    if (run["conclusion"] === "skipped") {
      sawSkipped = true;
      continue;
    }
    return "reported";
  }
  return sawSkipped ? "skipped-only" : "absent";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sample recent closed pull requests and report when no gitleaks check ever
 * reported on them.
 *
 * Returns at most one finding. Returns none — never a silent clean verdict —
 * when the repo has no gitleaks workflow, when the finding is already open or
 * suppressed, or when nothing could be sampled; the last two cases are
 * reported through `onSamplingNote`.
 *
 * Never throws: every `gh` failure is caught, recorded, and surfaced.
 */
export async function scanGitleaksPrCoverage(
  repo: string,
  opts: ScanGitleaksPrCoverageOptions,
): Promise<GitleaksPrCoverageFinding[]> {
  const note = (message: string) => opts.onSamplingNote?.(message);

  // A repo with no gitleaks workflow is the missing-workflow issue's
  // business, not this scanner's.
  const gitleaksFiles = opts.files.filter((f) => gitleaksJobs(f).length > 0);
  if (gitleaksFiles.length === 0) return [];

  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  if (
    suppressed.has(GITLEAKS_PR_COVERAGE_FINDING_ID) ||
    knownOpen.has(GITLEAKS_PR_COVERAGE_FINDING_ID)
  ) {
    // Already tracked — spend no API budget re-deciding it.
    return [];
  }

  const primary = [...gitleaksFiles].sort((a, b) =>
    a.path.localeCompare(b.path)
  )[0] as WorkflowFile;
  const citedLine = lineOfOnKey(primary.rawText);
  if (
    isFindingSuppressed(
      primary.rawText,
      citedLine,
      GITLEAKS_PR_COVERAGE_FINDING_ID,
      primary.path,
    )
  ) {
    return [];
  }

  // The slug is interpolated into an API path — allowlist it rather than
  // trusting the caller.
  if (!isValidRepoSlug(repo)) {
    note(
      `gitleaks PR coverage: "${repo}" is not a valid owner/repo slug — no ` +
        "pull request was sampled and coverage is unknown",
    );
    return [];
  }

  const sampleSize =
    Number.isFinite(opts.sampleSize) && (opts.sampleSize ?? 0) > 0
      ? Math.floor(opts.sampleSize as number)
      : DEFAULT_PR_SAMPLE_SIZE;

  let prs: SampledPr[];
  try {
    prs = await listClosedPrs(repo, opts.ghCommandFn, sampleSize);
  } catch (err) {
    note(
      `gitleaks PR coverage: could not list closed pull requests for ${repo}: ` +
        `${errorMessage(err)} — coverage is unknown, not clean`,
    );
    return [];
  }

  if (prs.length === 0) {
    note(
      `gitleaks PR coverage: ${repo} has no closed pull request to sample — ` +
        "coverage is unobserved, not clean",
    );
    return [];
  }

  const candidates = candidateCheckNames(gitleaksFiles);
  const inspected: number[] = [];
  const skippedOnly: number[] = [];
  const failures: { number: number; reason: string }[] = [];
  let reportedOn: number | null = null;

  for (const pr of prs) {
    let observation: PrObservation;
    try {
      observation = await observePr(repo, pr, opts.ghCommandFn, candidates);
    } catch (err) {
      const reason = errorMessage(err);
      failures.push({ number: pr.number, reason });
      note(
        `gitleaks PR coverage: check-run lookup failed for ${repo}#${pr.number}: ` +
          `${reason} — that pull request was not inspected`,
      );
      continue;
    }
    inspected.push(pr.number);
    if (observation === "reported") {
      reportedOn = pr.number;
      break;
    }
    if (observation === "skipped-only") skippedOnly.push(pr.number);
  }

  // Observed running at least once — the control is live.
  if (reportedOn !== null) return [];

  if (inspected.length === 0) {
    note(
      `gitleaks PR coverage: no pull request of ${repo} could be inspected ` +
        `(${failures.length} check-run lookup(s) failed) — coverage is ` +
        "unknown, not clean",
    );
    return [];
  }

  if (prs.length < sampleSize) {
    note(
      `gitleaks PR coverage: ${repo} has only ${prs.length} closed pull ` +
        `request(s) to sample, fewer than the ${sampleSize} requested`,
    );
  }

  return [
    buildFinding({
      repo,
      files: gitleaksFiles,
      primary,
      citedLine,
      sampleSize,
      prs,
      inspected,
      skippedOnly,
      failures,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Finding body
// ---------------------------------------------------------------------------

interface BuildFindingArgs {
  repo: string;
  files: readonly WorkflowFile[];
  primary: WorkflowFile;
  citedLine: number;
  sampleSize: number;
  prs: readonly SampledPr[];
  inspected: readonly number[];
  skippedOnly: readonly number[];
  failures: readonly { number: number; reason: string }[];
}

function buildFinding(args: BuildFindingArgs): GitleaksPrCoverageFinding {
  const workflowList = args.files.map((f) => `\`${f.path}\``).join(", ");
  const inspectedList = args.inspected.map((n) => `#${n}`).join(", ");

  const evidence: string[] = [
    `Sampled the ${args.prs.length} most recently updated closed pull ` +
    `request(s) of \`${args.repo}\` (${args.sampleSize} requested); ` +
    `${args.inspected.length} inspected: ${inspectedList}.`,
    "",
    "No gitleaks check run reported on any of them, yet the repository " +
    `commits ${workflowList}.`,
  ];
  if (args.skippedOnly.length > 0) {
    evidence.push(
      "",
      `A gitleaks check was present but concluded \`skipped\` on ${
        args.skippedOnly.map((n) => `#${n}`).join(", ")
      } — a skipped job scans nothing, so it does not count as reported.`,
    );
  }
  if (args.failures.length > 0) {
    evidence.push(
      "",
      "**This is a partial sample.** The check-run lookup failed for " +
        `${
          args.failures.map((f) => `#${f.number} (${f.reason})`).join(", ")
        }, so those pull requests were not inspected and this verdict does ` +
        "not cover them.",
    );
  }
  if (args.prs.length < args.sampleSize) {
    evidence.push(
      "",
      `**This is a partial sample.** Only ${args.prs.length} closed pull ` +
        `request(s) exist, fewer than the ${args.sampleSize} requested.`,
    );
  }

  return {
    findingId: GITLEAKS_PR_COVERAGE_FINDING_ID,
    severity: "medium",
    title: `${MEDIUM_EMOJI} Gitleaks workflow is present but never reported ` +
      "on a recent pull request",
    file: args.primary.path,
    lines: args.citedLine,
    whyItMatters:
      "The workflow audit proves only that a file mentioning gitleaks is " +
      "committed; it cannot tell whether the scan ran. On the pull requests " +
      "sampled here it did not, so secrets in those diffs were never " +
      "scanned while the repository still counts as covered — a policy that " +
      "reads as an enforced control but blocks nothing. Being present and " +
      "being run are different claims, and only the second one protects " +
      "anything.",
    suggestedFix: "Work through the causes that make a committed workflow " +
      "never run, in this order:\n\n" +
      "1. **Actions disabled for the repository** — check **Settings → " +
      "Actions → General**; a disabled repository runs no workflow at all.\n" +
      "2. **The workflow disabled in the Actions UI** — open the workflow " +
      "under the **Actions** tab and re-enable it if it is marked disabled " +
      "(`gh api repos/" + args.repo + "/actions/workflows` reports each " +
      "workflow's `state`).\n" +
      "3. **A branch filter that misses the pull requests** — a " +
      "`pull_request.branches` filter that omits the base branches PRs " +
      "actually target skips every one of them, and a `*` glob never " +
      "matches a `/`, so it misses every `milestone/<slug>` branch " +
      "(Issue #1300).\n" +
      "4. **A job or step `if:` that never fires** — a condition on an " +
      "unset variable leaves the job skipped, which scans nothing.\n" +
      "5. **A YAML error** — a workflow that does not parse is never " +
      "registered; `actionlint` reports it.\n\n" +
      "Fix the cause, then confirm the check appears on the next pull " +
      "request before treating the repository as covered.",
    evidence: evidence.join("\n"),
  };
}
