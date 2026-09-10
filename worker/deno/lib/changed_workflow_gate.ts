/**
 * Pre-PR gate: run {@link WORKFLOW_FILE_CHECKS} over the `.github/workflows/`
 * files this run added or changed (Issue #1859, split out of #1755).
 *
 * #1755 hardens the provisioning path **by construction** — the templates, the
 * filing-time pin resolution, and the `prompts/issue/prompt.md` rule. All three
 * are instructions an LLM run follows; none is a gate. A run that embellishes
 * what it was given (a bare-digest pin), or writes a workflow no template
 * produces, still ships a file the `github-actions-audit` idle task files a
 * finding against days later, in a repository the fleet does not own.
 *
 * The checks in the table are pure functions over workflow **text** — no
 * network, no run history, no repository settings — so they are callable at PR
 * time, on the branch diff, in milliseconds. This module is the seam: the
 * caller injects "what did the branch change" and "read this path", and the
 * gate answers with the findings, or with the reason it could not.
 *
 * **Known limitation — a check that reasons across files sees only the changed
 * subset.** `scanGitleaksDrift` decides "no gitleaks workflow in this repo has
 * a `pull_request` trigger" from the set it is handed, and
 * `findVersionCommentDrift` compares pins "across the repo" the same way. Given
 * one changed file they answer from that file, so the first can over-report and
 * the second under-report against what the idle-task audit — which reads every
 * workflow — would say. Reading the whole tree here to close that gap would put
 * untouched files back in scope, which is exactly what the rule below forbids;
 * the audit remains the authority on repository-wide questions.
 *
 * **Scope — only what the run touched.** A repository whose *pre-existing*
 * workflow files already carry findings is not this gate's business: an
 * untouched offender must not block an unrelated PR (the idle-task audit files
 * those). Deletions are out of scope too — the caller's diff filter excludes
 * them, so a path this gate cannot read is a genuine fault, not a removal.
 *
 * **Fail loud** (Issue #3234). A diff that cannot be collected, a file that
 * cannot be read, and a file whose YAML does not parse are all reported as
 * errors, never as "no findings": absence of a finding is only a pass when the
 * checks actually ran over the text.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import type { WorkflowFile } from "./workflow_scan_common.ts";
import {
  WORKFLOW_FILE_CHECKS,
  type WorkflowFileCheckFinding,
} from "./workflow_file_checks.ts";
import { isWorkflowPath, WORKFLOWS_DIR } from "./workflow_scope.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** The two reads the gate needs, injected so the whole path unit-tests. */
export interface ChangedWorkflowGateDeps {
  /**
   * Repo-relative paths the branch added, changed or renamed — deletions
   * excluded. Throw rather than return an empty list when the diff failed.
   */
  listChangedFiles(): Promise<readonly string[]>;
  /** Read one repo-relative path as text. Throw when it cannot be read. */
  readFile(path: string): Promise<string>;
}

/** Verdict of the changed-workflow gate. */
export interface ChangedWorkflowGateResult {
  /** True only when every in-scope file was read and carried no finding. */
  ok: boolean;
  /** The in-scope files the checks actually ran over, sorted by path. */
  scannedFiles: string[];
  /** One entry per violation, in check-table order. */
  findings: WorkflowFileCheckFinding[];
  /** One entry per read/parse/collection fault — never silently empty. */
  errors: string[];
}

/**
 * Only `*.yml` / `*.yaml` **directly** under `.github/workflows/` are workflow
 * files: GitHub runs nothing nested below that directory, and the audit's own
 * reader (`readWorkflowFiles`) is non-recursive, so a fixture in
 * `.github/workflows/templates/` must not block a PR the audit would never
 * file against.
 *
 * A path with a `..` segment is refused before that: the caller turns these
 * into a filesystem read, and git never emits one, so it can only be mischief.
 */
function isWorkflowYaml(path: string): boolean {
  const normalised = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalised.split("/").includes("..")) return false;
  if (!isWorkflowPath(normalised)) return false;
  if (normalised.slice(WORKFLOWS_DIR.length).includes("/")) return false;
  return normalised.endsWith(".yml") || normalised.endsWith(".yaml");
}

/** Findings named in the failure message before it is truncated. */
const MAX_LISTED_FINDINGS = 20;

/**
 * Run every file-scoped audit check over the workflow files the branch
 * touched.
 *
 * @param opts.defaultBranch - The target repository's default branch, the
 *   check context (`workflow-triggers` decides against it)
 * @param opts.deps - Diff and file reads, injected
 * @returns The verdict; `ok` is true when nothing was in scope
 */
export async function evaluateChangedWorkflowGate(
  opts: { defaultBranch: string; deps: ChangedWorkflowGateDeps },
): Promise<ChangedWorkflowGateResult> {
  const errors: string[] = [];

  let changed: readonly string[];
  try {
    changed = await opts.deps.listChangedFiles();
  } catch (err) {
    // The collection step itself failed: report that, never "no findings".
    return {
      ok: false,
      scannedFiles: [],
      findings: [],
      errors: [
        `could not collect the branch diff: ${messageOf(err)}`,
      ],
    };
  }

  const inScope = [...new Set(changed.filter(isWorkflowYaml))].sort();
  if (inScope.length === 0) {
    return { ok: true, scannedFiles: [], findings: [], errors: [] };
  }

  const files: WorkflowFile[] = [];
  for (const path of inScope) {
    let rawText: string;
    try {
      rawText = await opts.deps.readFile(path);
    } catch (err) {
      errors.push(`could not read ${path}: ${messageOf(err)}`);
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = parseYaml(rawText);
    } catch (err) {
      // A file the structural checks cannot inspect decided nothing, so it is
      // a fault rather than a pass. The raw-text checks still run over it.
      errors.push(`could not parse ${path} as YAML: ${messageOf(err)}`);
    }
    files.push({ path, rawText, parsed, kind: "workflow" });
  }

  const findings: WorkflowFileCheckFinding[] = [];
  const scanned = new Set(files.map((file) => file.path));
  for (const check of WORKFLOW_FILE_CHECKS) {
    let checkFindings: WorkflowFileCheckFinding[];
    try {
      checkFindings = check.run(files, { defaultBranch: opts.defaultBranch });
    } catch (err) {
      errors.push(`check \`${check.id}\` threw: ${messageOf(err)}`);
      continue;
    }
    // A check may reason across the set it is given; only the files this run
    // touched are in scope, so anything else it names is dropped.
    findings.push(...checkFindings.filter((f) => scanned.has(f.file)));
  }

  return {
    ok: errors.length === 0 && findings.length === 0,
    scannedFiles: [...scanned].sort(),
    findings,
    errors,
  };
}

/** An error's message, without leaking a stack trace into an issue comment. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The failure message for a blocked run: every finding named by check id,
 * file, line and detail, and every fault that stopped a check from deciding.
 *
 * The message goes to an issue comment and the run record, and an error line
 * can carry a tail of `git` stderr, so the whole thing goes through the
 * `redactSecrets()` chokepoint before it leaves.
 *
 * @param result - A verdict whose `ok` is false
 * @returns One multi-line message for the phase failure and the issue thread
 */
export function buildChangedWorkflowGateMessage(
  result: ChangedWorkflowGateResult,
): string {
  const lines: string[] = [
    "Workflow files changed by this run did not pass the GitHub Actions " +
    "file checks, so no PR was raised (Issue #1859). Only files this run " +
    "touched are checked, so the fix is in the file itself: correct it, or — " +
    "for a scanner finding that genuinely does not apply — add a " +
    "`# best-practice-ignore: <finding-id>` comment beside the offending " +
    "line. Prose in the PR summary does not clear this gate.",
  ];

  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of result.findings.slice(0, MAX_LISTED_FINDINGS)) {
      lines.push(
        `- [${finding.id}] ${finding.file}:${finding.line} — ${finding.detail}`,
      );
    }
    const hidden = result.findings.length - MAX_LISTED_FINDINGS;
    if (hidden > 0) lines.push(`- …and ${hidden} more`);
  }

  if (result.errors.length > 0) {
    lines.push(
      "",
      "The checks could not decide the following, which is a failure, not a " +
        "pass:",
    );
    for (const error of result.errors) lines.push(`- ${error}`);
  }

  return redactSecrets(lines.join("\n"));
}
