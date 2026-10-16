/**
 * Quality gate check: every direct `gh issue create` argv call site must be
 * on a reasoned allowlist (Issue #3746).
 *
 * Every new issue should be filed through the routed filing chokepoint
 * `fileRoutedIssue` in `worker/deno/lib/issue_routing_filing.ts` (Issue
 * #3743), which picks the repository that owns the issue, de-duplicates
 * against it, and only then files. A call site that builds the
 * `"issue", "create"` argv itself skips that routing, so a new direct call
 * site must either use `fileRoutedIssue` or be added to
 * {@link ISSUE_CREATE_ROUTING_ALLOWLIST} with a one-line reason. The real-tree
 * scan in `worker/deno/tests/issue_create_routing_check_test.ts` enforces
 * this, and fails closed: an empty or missing scan is an error, never a pass.
 *
 * Like the issue-create label guard (Issue #1276), this is an architectural,
 * whole-codebase invariant, so the scanning functions are pure and exported
 * for behavioural tests against literal inputs. Migrating an existing call
 * site is a separate change; this check only stops new ones appearing
 * unreviewed.
 *
 * Detection is textual and deliberately simple. A line is a candidate when it
 * holds an `"issue",` or `'issue',` argv element, and the verb that follows
 * (inline after it, or on the next non-blank line within a few lines) is
 * `create`. The `"issue"` literal followed by `||` (a comparison, not an
 * argv element) is therefore not a candidate.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single direct `gh issue create` call site found during scanning. */
export interface IssueCreateRoutingViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the `"issue"` argv element. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface IssueCreateRoutingCheckResult {
  violations: IssueCreateRoutingViolation[];
  /** Files actually scanned. Allowlisted files are skipped and not counted. */
  filesScanned: number;
}

/**
 * Files permitted to build a `gh issue create` argv directly, each with the
 * one-line reason it does so.
 */
export const ISSUE_CREATE_ROUTING_ALLOWLIST: ReadonlyMap<string, string> =
  new Map<string, string>([
    [
      "worker/deno/commands/maybe_file_idle_task.ts",
      "#1963 idle-task filer CLI; files into the picked monitored repo (targetRepo) with guarded labels; not yet routed",
    ],
    [
      "worker/deno/lib/alert_feeds/alert_feed_enable_issue.ts",
      "#3396 feed-unavailable enable/authorise issue, filed in the monitored repo it describes; not yet routed",
    ],
    [
      "worker/deno/lib/audit_failure_notifier.ts",
      "#2691 dependency-audit failure issue, filed in the monitored repo whose deno.lock advisory it reports; not yet routed",
    ],
    [
      "worker/deno/lib/baseline_carryover_tracker.ts",
      "#2605 deduplicated baseline-carryover tracking issue, filed in the repo whose baseline carried the findings; not yet routed",
    ],
    [
      "worker/deno/lib/bump_script_failure_streak.ts",
      "#207 bump-deps.sh rejection-streak issue, filed in the monitored repo whose bump script keeps failing; not yet routed",
    ],
    [
      "worker/deno/lib/create_all_idle_task_wrappers.ts",
      "#2577 seeds the standard idle-task wrapper issues into a freshly monitored repo; repo-scoped template filing; not yet routed",
    ],
    [
      "worker/deno/lib/degraded_delivery.ts",
      "#2562 degraded-run delivery issue, filed in the repo the run was delivering to; not yet routed",
    ],
    [
      "worker/deno/lib/idle_inversion_streak.ts",
      "#321/#459 idle-inversion escalation, filed in the worker's own repo by design (IDLE_INVERSION_TARGET_REPO); fleet-health diagnostic; not yet routed",
    ],
    [
      "worker/deno/lib/idle_starvation_escalation.ts",
      "#1052/#459 idle-capacity escalation, filed in the worker's own repo by design; fleet-health diagnostic; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/alert_feed_template.ts",
      "#3394 alert-feed idle-task template; files a repo-scoped idle task into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/bash_script_refs_template.ts",
      "#3228 bash script-reference idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/bash_syntax_audit_template.ts",
      "#3238 bash syntax-audit idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/best_practices_template.ts",
      "#2148 best-practices idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts",
      "#1597 gate-skip drift idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/github_actions_audit_template.ts",
      "#2256 GitHub Actions audit idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/workflow_annotation_scan_template.ts",
      "#3488 workflow-run annotation-scan idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/issue_routing_filing.ts",
      "the routed filing chokepoint itself (#3743); the direct call here is the one fileRoutedIssue makes",
    ],
    [
      "worker/deno/lib/merge_fallback_issue.ts",
      "#2304 merge-fallback flag issue, filed in the repo whose conflict fallback left it behind; not yet routed",
    ],
    [
      "worker/deno/lib/milestone_branch_self_heal.ts",
      "#3912 self-heal diagnostic for milestone branches deleted under open children, filed in the milestone's repo; not yet routed",
    ],
    [
      "worker/deno/lib/milestone_completion.ts",
      "milestone completion tracking issue, filed in the milestone's repo; not yet routed",
    ],
    [
      "worker/deno/lib/milestone_gate_wedge.ts",
      "#2388 wedged milestone-sync gate diagnostic, filed in the worker's own repo by design (GATE_WEDGE_DIAGNOSTIC_REPO); not yet routed",
    ],
    [
      "worker/deno/lib/planning_carrier.ts",
      "#2995 zero-sub-issue planning carrier safety net, filed in the planning repo; not yet routed",
    ],
    [
      "worker/deno/lib/pr_branch_update_failure_streak.ts",
      "#335 PR branch-update failure-streak issue, filed in the repo whose branch failed to update; not yet routed",
    ],
    [
      "worker/deno/lib/provider_outage_alert.ts",
      "#2613 provider-outage alert, filed in the worker's own repo by design (PROVIDER_OUTAGE_TARGET_REPO); fleet-health diagnostic; not yet routed",
    ],
    [
      "worker/deno/lib/references_refresh.ts",
      "#665 references refresh sweep issue, filed in the swept repository (slug); not yet routed",
    ],
    [
      "worker/deno/lib/repo_fast_failure_issue.ts",
      "#2956/#2592 fleet-wide fast-failure tally must stay in the monitored repository it describes; not yet routed",
    ],
    [
      "worker/deno/lib/run_failure_issue.ts",
      "#4329 worker-fault run-failure issue, filed in the worker's own repo by default (RUN_FAILURE_TARGET_REPO); not yet routed",
    ],
    [
      "worker/deno/lib/runner_deprecation_filer.ts",
      "#2256 runner-deprecation finding issue, filed in the monitored repo whose workflows are deprecated; not yet routed",
    ],
    [
      "worker/deno/lib/security_tree_sweep.ts",
      "#4193 whole-tree security sweep finding issue, filed in the swept repository (slug); not yet routed",
    ],
    [
      "worker/deno/lib/workflow_scan_common.ts",
      "#2500 shared workflow-scan scaffolding for github-actions-audit pre-filers; files into the scanned repo; not yet routed",
    ],
  ]);

/**
 * How many lines below the `"issue",` element the scanner looks for the verb
 * when it is not inline. Argv arrays put the verb on the very next element, so
 * three lines leaves room for a blank line or two without reaching into an
 * unrelated statement.
 */
const VERB_LOOKAHEAD_LINES = 3;

/** Matches an `"issue",` / `'issue',` argv element. Group 1 is the quote. */
const ISSUE_ELEMENT_PATTERN = /(["'])issue\1\s*,/g;

/** Matches a string literal that opens an argv entry, capturing its text. */
const LEADING_LITERAL_PATTERN = /^\s*["']([^"'\n]*)["']/;

/**
 * One quote-aware pass over the source, matching (left to right) either a
 * string literal to keep, or a comment to blank:
 *
 * - `"…"`, `'…'` and `` `…` `` literals, with backslash escapes, are kept. A
 *   literal ends at end of line, so an unterminated quote does not swallow the
 *   lines below it.
 * - `//` runs to the end of the line.
 * - Block comments (slash-star to star-slash) may span lines.
 *
 * Literals are matched where their opening quote appears, so a comment marker
 * inside one (such as `"/*"` or `"https://x"`) is consumed with the literal and
 * never opens a comment.
 */
const COMMENT_OR_STRING_PATTERN =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Blank every comment, keeping string literals as-is. Each comment character
 * becomes a space except newlines, so line numbers stay aligned with the raw
 * source.
 */
function stripComments(source: string): string {
  return source.replace(
    COMMENT_OR_STRING_PATTERN,
    (match: string, literal: string | undefined) =>
      literal ?? match.replace(/[^\n]/g, " "),
  );
}

/**
 * Resolve the verb that follows an `"issue",` element.
 *
 * The verb is the string literal that opens the rest of the same line (the
 * inline form, `["issue", "create", …]`), otherwise the literal that opens the
 * next non-blank line within {@link VERB_LOOKAHEAD_LINES}. Returns `null` when
 * neither is a string literal.
 *
 * @param lines - Comment-stripped source lines.
 * @param index - Zero-based index of the line holding the `"issue",` element.
 * @param rest - The text on that line after the `"issue",` element.
 */
function verbAfterIssueElement(
  lines: readonly string[],
  index: number,
  rest: string,
): string | null {
  const inline = LEADING_LITERAL_PATTERN.exec(rest);
  if (inline !== null) return inline[1] ?? null;

  const floor = Math.min(lines.length, index + VERB_LOOKAHEAD_LINES + 1);
  for (let j = index + 1; j < floor; j++) {
    const next = lines[j] ?? "";
    if (next.trim() === "") continue;
    return LEADING_LITERAL_PATTERN.exec(next)?.[1] ?? null;
  }
  return null;
}

/**
 * Scan a file's content for direct `gh issue create` argv call sites.
 *
 * Operates on comment-stripped source, so prose and commented-out code
 * mentioning the pattern cannot trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line, ordered by line number.
 */
export function scanContentForDirectIssueCreate(
  content: string,
  repoRelPath: string,
): IssueCreateRoutingViolation[] {
  const rawLines = content.split("\n");
  const lines = stripComments(content).split("\n");
  const violations: IssueCreateRoutingViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isCreate = [...line.matchAll(ISSUE_ELEMENT_PATTERN)].some((match) => {
      const rest = line.slice((match.index ?? 0) + match[0].length);
      return verbAfterIssueElement(lines, i, rest) === "create";
    });
    if (!isCreate) continue;
    violations.push({
      file: repoRelPath,
      line: i + 1,
      text: (rawLines[i] ?? "").trim(),
    });
  }

  return violations;
}

/** Recursively walk a directory yielding `.ts` file paths, sorted by name. */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  const entries = await Array.fromAsync(Deno.readDir(dir));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/**
 * Fail closed unless `absDir` exists and is a directory.
 *
 * @throws Error naming the directory when it is missing or not a directory.
 */
async function assertScannableDirectory(
  absDir: string,
  relDir: string,
): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(absDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `issue-create routing check: scan directory "${relDir}" does not exist`,
      );
    }
    throw error;
  }
  if (!info.isDirectory) {
    throw new Error(
      `issue-create routing check: scan path "${relDir}" is not a directory`,
    );
  }
}

/**
 * Scan the given repo-relative directories for direct `gh issue create` argv
 * call sites that are not on {@link ISSUE_CREATE_ROUTING_ALLOWLIST}.
 *
 * Allowlisted files are skipped and do not count towards `filesScanned`.
 * Fails closed: a missing or non-directory `relDir`, or a scan that examines
 * no `.ts` file at all, throws rather than reporting a pass.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 * @throws Error when a directory is missing, is not a directory, or yields no
 *   scannable `.ts` files.
 */
export async function scanDirectoriesForDirectIssueCreate(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<IssueCreateRoutingCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: IssueCreateRoutingViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    const absDir = `${root}/${relDir}`;
    await assertScannableDirectory(absDir, relDir);
    for await (const absFile of walkTsFiles(absDir)) {
      const repoRel = absFile.slice(root.length + 1);
      if (ISSUE_CREATE_ROUTING_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForDirectIssueCreate(content, repoRel));
    }
  }

  if (filesScanned === 0) {
    throw new Error(
      `issue-create routing check: no .ts files were scanned under ${
        relDirs.join(", ")
      } — refusing to report a pass for an empty scan`,
    );
  }

  return { violations, filesScanned };
}

/**
 * Find allowlist entries that no longer earn their place: the file is gone,
 * or it no longer contains a direct `gh issue create` call site.
 *
 * Keeps the allowlist honest after a call site is migrated. Entries are
 * checked whether or not the file is in a scanned directory.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param allowlist - The allowlist to audit.
 * @returns Stale repo-relative paths, sorted.
 */
export async function findStaleAllowlistEntries(
  repoRoot: string,
  allowlist: ReadonlyMap<string, string> = ISSUE_CREATE_ROUTING_ALLOWLIST,
): Promise<string[]> {
  const root = repoRoot.replace(/\/$/, "");
  const stale: string[] = [];

  for (const relPath of [...allowlist.keys()].sort()) {
    let content: string;
    try {
      content = await Deno.readTextFile(`${root}/${relPath}`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        stale.push(relPath);
        continue;
      }
      throw error;
    }
    if (scanContentForDirectIssueCreate(content, relPath).length === 0) {
      stale.push(relPath);
    }
  }

  return stale;
}

/**
 * Render violations as one line each, naming the file and line, for the
 * quality gate's failure message.
 *
 * @param violations - Violations to render.
 * @returns Newline-joined messages; empty when there are none.
 */
export function formatIssueCreateRoutingViolations(
  violations: readonly IssueCreateRoutingViolation[],
): string {
  return violations
    .map((v) =>
      `${v.file}:${v.line}: direct \`gh issue create\` call site is not on the routing allowlist — route it through fileRoutedIssue (issue_routing_filing.ts) or add an ISSUE_CREATE_ROUTING_ALLOWLIST entry with a one-line reason: ${v.text}`
    )
    .join("\n");
}
