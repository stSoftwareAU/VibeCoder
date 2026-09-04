/**
 * Best-practices idle-task template (Issue #2148, parent #2143).
 *
 * Composes the foundations from #2144 (bucket picker), #2145 (linter-in-CI
 * check), and #2147 (orchestrating prompt + per-bucket guides) into a
 * working scanner.
 *
 * Design notes:
 *
 *   - **Outcome-only Claude contract.** Mirrors `security_scan_template`
 *     (#2097): the orchestrating prompt at `prompts/best_practices/prompt.md`
 *     instructs Claude to file findings directly via `gh issue create`.
 *     `runTask` verifies success by snapshotting the repo's open
 *     `best-practices`-labelled issues before and after the scan and
 *     diffing them — no JSON parsing.
 *   - **Bucket pick at file time.** `buildIssueBody` picks the bucket
 *     using `pickBucket()` (#2144), substitutes `{{BUCKET}}` into the
 *     prompt, inlines the matching `prompts/best_practices/buckets/<b>.md`
 *     guide, and records the bucket inside a `**Bucket:** \`<bucket>\``
 *     line in the body so `runTask` can recover it.
 *   - **Linter-in-CI pre-check.** For language-targeted runs (bucket !=
 *     `general`), `runTask` calls `checkLinterInCI()` (#2145) before
 *     invoking Claude. When the bucket's standard linter is not invoked
 *     in CI, the template files a `missing-linter` finding as a
 *     standalone `best-practices` issue at `severity:high`. The
 *     pre-filed issue counts against the run's 6-cap because the prompt
 *     receives its id in the known-open list, so Claude treats it as
 *     already filed and does not re-emit a linter finding (and can fill
 *     at most 5 more findings without exceeding the cap).
 *   - **Dedup.** The known-open list passed to Claude is built from the
 *     repo's existing open `best-practices` issues — Claude is
 *     instructed to skip any finding whose `BP-…` id is in the list.
 *
 * Australian English used throughout (behaviour, organisation,
 * authorised).
 */

import {
  type IdleTaskBodyOptions,
  type IdleTaskRunOptions,
  type IdleTaskRunResult,
  type IdleTaskShouldFileOptions,
  type IdleTaskTemplate,
  registerTemplate,
} from "../idle_task_template.ts";
import {
  type BucketPick,
  pickBucket as defaultPickBucket,
  type SupportedLanguage,
} from "../best_practices_bucket_picker.ts";
import {
  checkLinterInCI as defaultCheckLinterInCI,
  type LinterCheckResult,
} from "../linter_in_ci_check.ts";
import {
  detectRepoLanguages as defaultDetectLanguages,
  type RepoLanguages,
} from "../language_detector.ts";
import { runGhCommand as defaultGhCommand } from "../github.ts";
import {
  getPromptsDir,
  loadPrompt as defaultLoadPrompt,
} from "../prompt_manager.ts";
import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";
import { repoCheckoutPath } from "../repo_checkout_path.ts";
import { RUN_ID_ENV_VAR } from "../run_id.ts";
import { buildAttributionFooter } from "../idle_task_attribution.ts";
import {
  diffNewlyFiled,
  fileFindingOnce,
  listAllOpenIssueTitles,
  listKnownOpenFindingIds,
  listOpenIssueNumbersByLabel,
  type OpenIssueTitle,
  parseGhJsonArray,
  renderOpenIssueTitles,
} from "../idle_task_snapshot.ts";
import type { Result } from "../../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME = "best-practices";

const DESCRIPTION =
  "Run an evidence-backed best-practices review against a single language " +
  "or framework bucket and file each surviving finding as its own issue.";

/** Label every filed best-practices issue (wrapper or finding) carries. */
export const BEST_PRACTICES_LABEL = "best-practices";

/** Static wrapper title — dispatch matches against this string. */
export const BEST_PRACTICES_ISSUE_TITLE = "Run a best-practices scan";

/** Prompt template directory under `prompts/`. */
const PROMPT_NAME = "best_practices";

/**
 * Per-bucket relative path to the guide file. The file body is read at
 * file time and inlined into the wrapper body so the wrapper is
 * self-contained (a human can paste the same wrapper into a fresh issue
 * and get the same scan).
 */
export function bucketGuidePath(bucket: string): string {
  return `prompts/best_practices/buckets/${bucket}.md`;
}

/**
 * Read a bucket guide, resolving the repo-root-relative path against the same
 * prompts directory the prompt loader uses.
 *
 * `Deno.readTextFile("prompts/…")` alone resolves against the process's
 * working directory, so the read succeeded only when the worker happened to be
 * started from the repository root.
 *
 * @param path - Repo-root-relative guide path from {@link bucketGuidePath}.
 * @returns The guide's text.
 */
export async function readBucketGuide(path: string): Promise<string> {
  const prefix = "prompts/";
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return await Deno.readTextFile(`${getPromptsDir()}/${relative}`);
}

/**
 * Body fingerprint that uniquely identifies a best-practices wrapper.
 * Anchored to a Markdown heading at start-of-line, matching the
 * `security_scan_template` convention (Issue #2118).
 */
export const BEST_PRACTICES_BODY_FINGERPRINT = /^#+\s+Best-Practices Review\b/m;

/**
 * Regex that recovers the bucket name from a wrapper body. The body
 * builder always writes `**Bucket:** \`<bucket>\`` on its own line, so
 * the recover step is a single match.
 *
 * Exported so tests can assert against the same regex the template
 * uses.
 */
export const BUCKET_LINE_REGEX = /^\*\*Bucket:\*\*\s*`([a-z][a-z0-9-]*)`/m;

/** Buckets that count as a language-targeted run (linter pre-check fires). */
const LANGUAGE_BUCKETS: ReadonlySet<SupportedLanguage> = new Set([
  "rust",
  "typescript",
  "react",
  "java",
  "html",
  "aws-cloudformation",
  "terraform",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link createBestPracticesTemplate}.
 *
 * Tests inject stubs for every external interaction (gh CLI, Claude,
 * filesystem reads, language detection, RNG) so they never touch the
 * network or block on Claude.
 */
export interface BestPracticesTemplateDeps {
  /**
   * Detect languages for a repo — defaults to the production
   * `detectRepoLanguages`. Tests inject a stub that returns a fixed
   * `RepoLanguages`.
   */
  detectLanguagesFn?: (
    repo: string,
  ) => Promise<Result<RepoLanguages, string>>;
  /**
   * Pick a bucket given language stats — defaults to the SLOC-weighted
   * picker. Tests inject a deterministic picker.
   */
  pickBucketFn?: (langs: RepoLanguages, rng?: () => number) => BucketPick;
  /** RNG forwarded to `pickBucketFn` — defaults to `Math.random`. */
  rng?: () => number;
  /** Prompt loader — defaults to `loadPrompt`. */
  loadPromptFn?: (name: string) => Promise<Result<string>>;
  /**
   * Read a bucket-guide markdown file relative to the repo root.
   * Defaults to `Deno.readTextFile`. Tests inject a stub so the
   * filesystem stays untouched.
   */
  readBucketGuideFn?: (path: string) => Promise<string>;
  /** gh CLI runner used for snapshots, dedup, and issue filing. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Linter-in-CI pre-check — defaults to the real check. */
  checkLinterInCIFn?: (
    repoPath: string,
    language: SupportedLanguage,
  ) => Promise<LinterCheckResult>;
  /**
   * Best-practices scan runner — invokes Claude with the assembled
   * prompt. Defaults to the production `claude_runner` wrapper. Tests
   * inject a stub that returns success without invoking Claude.
   *
   * Returns `ok: true` when Claude exited cleanly; the caller verifies
   * the outcome by diffing the snapshot. `ok: false` surfaces the
   * structured error in the wrapper close summary.
   */
  runScanFn?: (opts: RunScanOptions) => Promise<Result<true, ScanError>>;
}

/** Inputs to a best-practices Claude run. */
export interface RunScanOptions {
  repo: string;
  workDir: string;
  bucket: string;
  /** Stable ids already open as `best-practices` issues — skip-list. */
  knownOpenFindingIds: string[];
  /**
   * Every issue currently open in the repo, whatever its label — the
   * cross-label dedup list (Issue #537).
   */
  openIssueTitles: OpenIssueTitle[];
  /** Stable ids the run should suppress (in-source markers, prior triage). */
  suppressedIds: string[];
}

/** Discriminated failure mode from `runScanFn`. */
export interface ScanError {
  kind: "prompt" | "claude" | "timeout";
  message: string;
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

/**
 * Return the bucket slug for a `BucketPick` — the language string for a
 * language pick, otherwise the language-agnostic bucket's own name
 * (`"general"`, or `"design"` from Issue #662).
 */
export function bucketSlug(pick: BucketPick): string {
  return pick.kind === "language" ? pick.language : pick.kind;
}

/**
 * Recover the bucket slug from a wrapper body. Returns `null` when the
 * body does not contain the expected `**Bucket:** \`<bucket>\`` line —
 * the caller treats that as "cannot run", reports it in the summary,
 * and exits without invoking Claude.
 *
 * Exported so tests can drive it directly.
 */
export function parseBucketFromBody(body: string): string | null {
  const m = body.match(BUCKET_LINE_REGEX);
  return m === null ? null : m[1] ?? null;
}

/**
 * Return true when `slug` is one of the language buckets that triggers
 * the linter-in-CI pre-check. The language-agnostic buckets (`general`,
 * `design`) and any unknown slug return false.
 */
export function isLanguageBucket(slug: string): slug is SupportedLanguage {
  return LANGUAGE_BUCKETS.has(slug as SupportedLanguage);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Substitute the three placeholders defined by
 * `prompts/best_practices/prompt.md` and append the inlined bucket guide
 * under a dedicated section so the wrapper is self-contained.
 *
 * Empty id lists render as `(none)` — same convention as
 * `security_scanner.buildSecurityScanPrompt` so wrappers read naturally
 * both standalone and inline.
 *
 * Pure — no I/O.
 */
export function assembleBestPracticesPrompt(
  template: string,
  bucketGuide: string,
  opts: {
    bucket: string;
    suppressedIds: readonly string[];
    knownOpenFindingIds: readonly string[];
    /**
     * Every issue currently open in the target repo, whatever its
     * label (Issue #537) — the semantic second line of dedup. An
     * empty list renders the `(none)` sentinel.
     */
    openIssueTitles?: readonly OpenIssueTitle[];
    attributionFooter?: string;
  },
): string {
  const suppressed = opts.suppressedIds.length > 0
    ? opts.suppressedIds.join("\n")
    : "(none)";
  const known = opts.knownOpenFindingIds.length > 0
    ? opts.knownOpenFindingIds.join("\n")
    : "(none)";
  const openIssues = renderOpenIssueTitles(opts.openIssueTitles ?? []);
  const footer = opts.attributionFooter ?? "";

  const substitute = (text: string): string =>
    text
      .replaceAll("{{BUCKET}}", opts.bucket)
      .replaceAll("{{SUPPRESSED_IDS}}", suppressed)
      .replaceAll("{{KNOWN_OPEN_FINDING_IDS}}", known)
      .replaceAll("{{OPEN_ISSUE_TITLES}}", openIssues)
      .replaceAll("{{ATTRIBUTION_FOOTER}}", footer);

  const body = substitute(template);

  const bucketLine = `**Bucket:** \`${opts.bucket}\``;
  const guideSection = [
    "",
    "---",
    "",
    `## Bucket Guide — \`${opts.bucket}\` (inlined)`,
    "",
    substitute(bucketGuide).trim(),
    "",
  ].join("\n");

  return [bucketLine, "", body.trim(), guideSection].join("\n");
}

// ---------------------------------------------------------------------------
// gh snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Return true when an open wrapper titled exactly
 * `Run a best-practices scan` already exists in `repo`. Used to
 * prevent piling new wrappers on top of an un-triaged one.
 */
async function hasOpenBestPracticesWrapper(
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `"${BEST_PRACTICES_ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
      "--limit",
      "10",
    ]);
  } catch {
    return false;
  }
  for (const item of parseGhJsonArray(raw, "find best-practices wrapper")) {
    if (item === null || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (
      typeof title === "string" &&
      title.trim() === BEST_PRACTICES_ISSUE_TITLE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Accepted compile-gate commands per language bucket — used to render a
 * concrete "Suggested fix" when the compile gate is missing. Only the
 * buckets where a compile/syntax gate is meaningful appear here; the
 * remaining buckets (`html`, `aws-cloudformation`, `terraform`) have no
 * compile gate so they never trigger the compile-missing branch.
 */
const COMPILE_GATE_COMMANDS: Partial<
  Record<SupportedLanguage, readonly string[]>
> = {
  rust: ["cargo check --all-targets", "cargo build"],
  typescript: ["deno check **/*.ts", "npx tsc --noEmit"],
  react: ["deno check **/*.ts", "npx tsc --noEmit"],
  java: ["mvn compile", "./gradlew compileJava"],
};

/**
 * Compute which failure-mode title phrase applies to a check result.
 * Used by both the title and the body's "Suggested fix" section.
 *
 * The `gates` field on `LinterCheckResult` is only populated for buckets
 * where a compile gate is meaningful (`rust`, `typescript`, `react`,
 * `java`). For buckets without a compile gate, only the linter can be
 * missing — fall back to "lint gate".
 */
function classifyMissingGates(check: LinterCheckResult): {
  lintMissing: boolean;
  compileMissing: boolean;
  titlePhrase: string;
} {
  const lintMissing = check.gates ? !check.gates.linter : !check.configured;
  const compileMissing = check.gates ? !check.gates.compile : false;
  let titlePhrase: string;
  if (lintMissing && compileMissing) {
    titlePhrase = "lint + compile gates";
  } else if (compileMissing) {
    titlePhrase = "compile/syntax gate";
  } else {
    titlePhrase = "lint gate";
  }
  return { lintMissing, compileMissing, titlePhrase };
}

/** Render the "Suggested fix" section for the missing-CI-gate finding. */
function buildSuggestedFix(
  bucket: SupportedLanguage,
  lintMissing: boolean,
  compileMissing: boolean,
): string {
  const sections: string[] = [];
  if (lintMissing) {
    sections.push(
      "Add a CI step that invokes the standard linter so lint regressions " +
        "fail the build. See the bucket guide for the recommended invocation.",
    );
  }
  if (compileMissing) {
    const commands = COMPILE_GATE_COMMANDS[bucket] ?? [];
    if (commands.length > 0) {
      const formatted = commands.map((c) => `\`${c}\``).join(" OR ");
      sections.push(
        `Add a CI step that invokes a compile/syntax gate (${formatted}) ` +
          "so syntax errors fail the build.",
      );
    } else {
      sections.push(
        "Add a CI step that invokes a compile/syntax gate so syntax " +
          "errors fail the build.",
      );
    }
  }
  return sections.join("\n\n");
}

/**
 * File a synthetic missing-CI-gate `best-practices` issue and return its
 * number. The finding carries:
 *   - `BP-LINTER-<bucket>` stable id (embedded in the body marker).
 *     **Back-compat:** the id retains the historical `BP-LINTER-` prefix
 *     even when only the compile gate is missing, so dedup against
 *     findings filed before Issue #2178 introduced the combined-gate
 *     finding continues to work. Do NOT split this into a separate
 *     `BP-COMPILE-<bucket>` id — see #2178.
 *   - `best-practices`, `lang:<bucket>`, `severity:high` labels.
 *   - A title that distinguishes the three failure modes: lint gate
 *     only, compile/syntax gate only, or both gates missing.
 *   - A body that carries the extended `details` string from
 *     `LinterCheckResult` verbatim under "Why this matters" plus a
 *     "Suggested fix" listing the accepted compile-gate commands for
 *     the bucket (when the compile gate is missing).
 *
 * Returns `null` on any gh failure — the caller logs the issue in the
 * summary and continues.
 */
async function fileMissingCIGateIssue(
  repo: string,
  bucket: SupportedLanguage,
  check: LinterCheckResult,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<{ number: number; findingId: string } | null> {
  const findingId = `BP-LINTER-${bucket}`;
  const { lintMissing, compileMissing, titlePhrase } = classifyMissingGates(
    check,
  );
  const title = `🟠 Missing CI ${titlePhrase} for \`${bucket}\``;
  const body = [
    `<!-- finding-id: ${findingId} -->`,
    "",
    `**Bucket:** \`${bucket}\``,
    `**Severity:** high (missing CI ${titlePhrase})`,
    "",
    "## Why this matters",
    "",
    check.details,
    "",
    "## Suggested fix",
    "",
    buildSuggestedFix(bucket, lintMissing, compileMissing),
  ].join("\n");

  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      BEST_PRACTICES_LABEL,
      "--label",
      `lang:${bucket}`,
      "--label",
      "severity:high",
    ]);
  } catch {
    return null;
  }

  // `gh issue create` prints the URL; parse the trailing `/issues/N`.
  const m = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (!m || !m[1]) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number)) return null;
  return { number, findingId };
}

// ---------------------------------------------------------------------------
// Production Claude runner
// ---------------------------------------------------------------------------

/**
 * Default Claude runner. Loads `prompts/best_practices/prompt.md`, inlines
 * the matching bucket guide, substitutes placeholders, and invokes
 * Claude with the same write-tool blocklist as `security_scanner`.
 *
 * Tests do NOT exercise this path — they inject a `runScanFn` stub.
 * Kept here so the production wiring is symmetric with security-scan.
 */
async function defaultRunScan(
  opts: RunScanOptions,
  loadPromptFn: (name: string) => Promise<Result<string>>,
  readBucketGuideFn: (path: string) => Promise<string>,
): Promise<Result<true, ScanError>> {
  const promptResult = await loadPromptFn(PROMPT_NAME);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: { kind: "prompt", message: promptResult.error.message },
    };
  }
  let bucketGuide: string;
  try {
    bucketGuide = await readBucketGuideFn(bucketGuidePath(opts.bucket));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: "prompt", message } };
  }

  const prompt = assembleBestPracticesPrompt(promptResult.value, bucketGuide, {
    bucket: opts.bucket,
    suppressedIds: opts.suppressedIds,
    knownOpenFindingIds: opts.knownOpenFindingIds,
    openIssueTitles: opts.openIssueTitles,
  });

  const result = await runIdleTaskClaude({
    prompt,
    cwd: opts.workDir,
    phase: "best_practices",
    disallowedTools: [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "EnterPlanMode",
      "ExitPlanMode",
    ],
  });
  if (!result.ok) {
    return {
      ok: false,
      error: { kind: "claude", message: result.error.message },
    };
  }
  const { exitCode, timedOut } = result.value;
  if (timedOut) {
    return {
      ok: false,
      error: {
        kind: "timeout",
        message: "Claude best-practices scan timed out",
      },
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      error: { kind: "claude", message: `Claude exited with code ${exitCode}` },
    };
  }
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/**
 * Render the close-comment summary for the wrapper idle-task issue.
 *
 *   - No newly-filed issues → `"no findings"`.
 *   - One or more newly-filed issues →
 *     `"Best-practices scan complete (bucket: <b>). Filed N issues: #A, #B, …"`
 *
 * Exported so tests can assert on the exact wording.
 */
export function renderBestPracticesSummary(
  bucket: string,
  newlyFiled: readonly number[],
): string {
  if (newlyFiled.length === 0) {
    return "no findings";
  }
  const sorted = [...newlyFiled].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return `Best-practices scan complete (bucket: ${bucket}). Filed ` +
    `${sorted.length} issues: ${list}`;
}

// ---------------------------------------------------------------------------
// Template factory
// ---------------------------------------------------------------------------

/**
 * Build the best-practices template using the supplied deps. Default
 * deps wire production behaviour; tests inject stubs.
 */
export function createBestPracticesTemplate(
  deps: BestPracticesTemplateDeps = {},
): IdleTaskTemplate {
  const detectLanguagesFn = deps.detectLanguagesFn ??
    ((repo) => defaultDetectLanguages(repo));
  const pickBucketFn = deps.pickBucketFn ?? defaultPickBucket;
  const rng = deps.rng;
  const loadPromptFn = deps.loadPromptFn ??
    ((name) => defaultLoadPrompt(name));
  const readBucketGuideFn = deps.readBucketGuideFn ?? readBucketGuide;
  const ghCommandFn = deps.ghCommandFn ?? ((args) => defaultGhCommand(args));
  const checkLinterInCIFn = deps.checkLinterInCIFn ??
    ((path, lang) => defaultCheckLinterInCI(path, lang));
  const runScanFn = deps.runScanFn ??
    ((opts) => defaultRunScan(opts, loadPromptFn, readBucketGuideFn));

  async function buildIssueBody(opts: IdleTaskBodyOptions): Promise<string> {
    // 1. Detect languages.
    const langsResult = await detectLanguagesFn(opts.repo);
    const langs: RepoLanguages = langsResult.ok
      ? langsResult.value
      : { detected: [], primary: "unknown", raw: {} };

    // 2. Pick the bucket.
    const pick = pickBucketFn(langs, rng);
    const bucket = bucketSlug(pick);

    // 3. Load the prompt template.
    const promptResult = await loadPromptFn(PROMPT_NAME);
    if (!promptResult.ok) {
      throw new Error(
        `best-practices: failed to load prompt template ${PROMPT_NAME}: ` +
          promptResult.error.message,
      );
    }

    // 4. Load the matching bucket guide.
    const guidePath = bucketGuidePath(bucket);
    let bucketGuide: string;
    try {
      bucketGuide = await readBucketGuideFn(guidePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `best-practices: failed to load bucket guide ${guidePath}: ${message}`,
      );
    }

    // 5. Assemble — substitute + inline the guide + prepend the bucket line.
    const attributionFooter = buildAttributionFooter({
      template: NAME,
      runId: Deno.env.get(RUN_ID_ENV_VAR) ?? "unknown",
    });
    return assembleBestPracticesPrompt(promptResult.value, bucketGuide, {
      bucket,
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter,
    });
  }

  function buildIssueTitle(_repo: string): string {
    return BEST_PRACTICES_ISSUE_TITLE;
  }

  async function shouldFile(
    opts: IdleTaskShouldFileOptions,
  ): Promise<boolean> {
    // Refuse to pile on while a wrapper is still being triaged. The
    // generic backlog gate handles open-findings count separately via
    // the `outputLabel` declaration below.
    if (await hasOpenBestPracticesWrapper(opts.repo, ghCommandFn)) {
      return false;
    }
    return true;
  }

  async function runTask(opts: IdleTaskRunOptions): Promise<IdleTaskRunResult> {
    try {
      // 1. Snapshot the repo's open best-practices issues before any
      //    filing happens this run.
      const before = await listOpenIssueNumbersByLabel(
        opts.repo,
        BEST_PRACTICES_LABEL,
        ghCommandFn,
      );

      // 2. Recover the bucket from the wrapper body so the linter
      //    pre-check and the scan use the same bucket the wrapper was
      //    filed against.
      const wrapperBody = await fetchIssueBody(
        opts.repo,
        opts.idleTaskIssueNumber,
        ghCommandFn,
      );
      const bucket = parseBucketFromBody(wrapperBody);
      if (bucket === null) {
        return {
          ok: false,
          summary:
            "best-practices: wrapper body did not declare a bucket — refused",
        };
      }

      // 3. Linter-in-CI pre-check for language-targeted runs only.
      //    `general` is repo-level hygiene; the bucket guide does not
      //    address CI lint invocation.
      const preFiled: string[] = [];
      if (isLanguageBucket(bucket)) {
        // Issue #2880: `opts.workDir` is the PARENT directory that holds
        // the clones, not the repo root — `setupRepo` checks the repo out
        // at `${workDir}/${repoName}`. Passing the parent made the check
        // read a non-existent `.github/workflows`, load zero workflows,
        // and file a false BP-LINTER finding. Derive the checkout path.
        const repoPath = repoCheckoutPath(opts.workDir, opts.repo);
        const check = await checkLinterInCIFn(repoPath, bucket);
        // Fail safe (Issue #2881): a zero-workflow load makes the gate
        // status *unknown*, not confirmed-missing — far more likely a scan
        // glitch than a genuine absence of CI. Skip filing the
        // `severity:high` BP-LINTER finding in that case (matches the
        // sibling github-actions-audit guard).
        if (!check.configured && check.workflowsLoaded !== false) {
          // Pre-file dedup (Issue #2882): skip creating when an open issue
          // with this finding-id already exists, so one finding never files
          // two open issues (observed: BP-LINTER-typescript private-repo-14
          // #2990/#2991). A closed prior issue does not block re-filing.
          const filed = await fileFindingOnce({
            repo: opts.repo,
            logLabel: BEST_PRACTICES_LABEL,
            findingId: `BP-LINTER-${bucket}`,
            ghCommandFn,
            fileFn: () =>
              fileMissingCIGateIssue(opts.repo, bucket, check, ghCommandFn),
          });
          if (filed !== null) {
            preFiled.push(filed.findingId);
          }
        }
      }

      // 3b. Build the existing-known-open list now so the runner
      //     pre-filer can dedup against it (and the post-runner-scan
      //     known-open list).
      const existingIds = await listKnownOpenFindingIds(
        opts.repo,
        BEST_PRACTICES_LABEL,
        ghCommandFn,
      );

      // 4. Build the known-open list (existing open findings + the
      //    pre-filed ids from this run) so Claude does not re-emit
      //    findings the repo already tracks.
      //
      //    Pre-file dedup (Issue #2882): the CI-gate pre-filer above routes
      //    through `fileFindingOnce`, which looks up an existing open issue by
      //    `finding-id` before creating, so one finding never yields two open
      //    issues (the duplicate observed in the previously-documented #2411
      //    race — BP-LINTER-typescript private-repo-14#2990/#2991). A residual
      //    micro-race between the look-up and the create is acceptable; the
      //    guard closes the routine window, it is not a distributed lock.
      const knownOpenFindingIds = Array.from(
        new Set([...existingIds, ...preFiled]),
      );

      // Repo-wide open-issue titles (Issue #537) — the semantic second
      // line of dedup, so a finding already open under another label is
      // not re-filed. A gh failure returns an empty list, which renders
      // `(none)` and leaves the scan running.
      const openIssueTitles = await listAllOpenIssueTitles(
        opts.repo,
        ghCommandFn,
      );

      // 5. Invoke Claude. It files surviving findings via `gh issue
      //    create` directly — no JSON parsing here.
      const scanResult = await runScanFn({
        repo: opts.repo,
        workDir: opts.workDir,
        bucket,
        knownOpenFindingIds,
        openIssueTitles,
        suppressedIds: [],
      });
      if (!scanResult.ok) {
        return {
          ok: false,
          summary: `best-practices failed: ${scanResult.error.kind} — ` +
            scanResult.error.message,
        };
      }

      // 6. Snapshot again and compute the newly-filed set.
      const after = await listOpenIssueNumbersByLabel(
        opts.repo,
        BEST_PRACTICES_LABEL,
        ghCommandFn,
      );
      const newlyFiled = diffNewlyFiled(before, after);

      return {
        ok: true,
        summary: renderBestPracticesSummary(bucket, newlyFiled),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `best-practices threw: ${message}`,
      };
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    buildIssueTitle,
    buildIssueBody,
    shouldFile,
    runTask,
    matchesIdleTaskBody: (body) => BEST_PRACTICES_BODY_FINGERPRINT.test(body),
    skipMilestone: true,
    outputLabel: BEST_PRACTICES_LABEL,
    requiresStructuredOutput: true,
  };
}

/**
 * Fetch the body of a single issue. Returns the empty string on any
 * gh failure or malformed response — the caller treats that as "no
 * bucket" and exits.
 */
async function fetchIssueBody(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "body",
    ]);
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed !== null && typeof parsed === "object" &&
      typeof (parsed as { body?: unknown }).body === "string"
    ) {
      return (parsed as { body: string }).body;
    }
  } catch {
    // fall through
  }
  return "";
}

/** Module-load registration so importing this file wires the template up. */
export const bestPracticesTemplate: IdleTaskTemplate =
  createBestPracticesTemplate();

registerTemplate(bestPracticesTemplate);
