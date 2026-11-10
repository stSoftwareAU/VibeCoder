/**
 * Prompt template management (Issue #197, #914, #844).
 *
 * Manages the prompt templates stored in the prompts/ directory. Each prompt
 * is a subdirectory holding a single editable `prompt.md`. Issue #844 removed
 * the `vN.md` versioning convention: the repo is public, so git history is the
 * record of how a template evolved, and a run's traceability comes from the
 * checkout's commit hash rather than a per-template version number.
 *
 * Migrated from worker/shared/prompt_manager.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { processEnvLookup } from "./env_lookup.ts";
import { runGitCommand } from "./git_timeout.ts";
/**
 * Known template types and their required placeholders.
 */ // Issue #3813: `CODING_GUIDELINES` is no longer required by any of the
// builder-hosted types. Since #1262 the guidelines ride in the system prompt,
// so `prompt_builder.ts` substituted the placeholder with an empty string and
// every host rendered a heading with nothing under it. The placeholder is gone
// from the issue, planning, question, pr_feedback, spelling_fix,
// workflow_setup and ci_fix templates; it stays registered as *optional* so a
// template that still carries it is not rejected.
const REQUIRED_PLACEHOLDERS = {
  issue: [
    "ISSUE_NUMBER",
    "QUALITY_INSTRUCTIONS"
  ],
  pr_feedback: [
    "PR_NUMBER",
    "QUALITY_INSTRUCTIONS"
  ],
  spelling_fix: [
    "PR_NUMBER",
    "QUALITY_INSTRUCTIONS"
  ],
  planning: [
    "REPO",
    "ISSUE_NUMBER",
    "PLANNING_LABEL"
  ],
  // Issue #2652: the second turn of the two-stage planning flow. It
  // adversarially critiques the draft plan, revises once, then publishes the
  // final sub-issues. The coding guidelines ride in the system prompt (as for
  // `planning`), so they are not a required body placeholder here.
  planning_critique: [
    "REPO",
    "ISSUE_NUMBER",
    "PLANNING_LABEL"
  ],
  // Issue #4110 (parent #4102): the two Quorum prompts. Both fence the issue
  // themselves — the boundary-integrity instruction is a placeholder rather
  // than builder-appended prose (the `grill-me` shape), so it is required:
  // a Quorum template rendered without it would hand an agent unfenced
  // GitHub text.
  quorum: [
    "REPO",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_LABELS",
    "ISSUE_BODY",
    "ISSUE_COMMENTS",
    "BOUNDARY_INTEGRITY_INSTRUCTION"
  ],
  // The judge additionally receives the two candidate plans, anonymised as A
  // and B. They are untrusted input like the issue text, so they are fenced
  // by the same instruction.
  quorum_judge: [
    "REPO",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_LABELS",
    "ISSUE_BODY",
    "ISSUE_COMMENTS",
    "PLAN_A",
    "PLAN_B",
    "BOUNDARY_INTEGRITY_INSTRUCTION"
  ],
  question: [
    "REPO",
    "ISSUE_NUMBER",
    "QUESTION_LABEL"
  ],
  // Issue #849 (parent #843): the grill-me interrogation rounds. The type was
  // unregistered, so an operator override of the phase had no placeholder
  // contract to validate against. Like the Quorum prompts, this template
  // fences the untrusted issue text itself, so
  // `BOUNDARY_INTEGRITY_INSTRUCTION` is required rather than
  // builder-appended: a grill-me template rendered without it would hand an
  // agent unfenced GitHub text.
  "grill-me": [
    "REPO",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_BODY",
    "COMMENT_HISTORY",
    "ROUND_NUMBER",
    "MAX_ROUNDS",
    "BOUNDARY_INTEGRITY_INSTRUCTION"
  ],
  ci_fix: [
    "PR_NUMBER",
    "QUALITY_INSTRUCTIONS"
  ],
  // Issue #84: the conflict-resolution pass. The template names the target,
  // the base branch being merged in, and the conflicted paths the worker found
  // after starting the merge — all three are load-bearing, so all three are
  // required.
  // Issue #1767: the target is a PR *or* a milestone branch, so the opening is
  // `TARGET_DESCRIPTION` rather than a bare PR number.
  // Issue #2306: the agent runs no quality gate itself, so the template carries
  // no `QUALITY_INSTRUCTIONS` block. Issue #4616: the worker runs the fast local
  // checks on a PR's staged merge before the push; a milestone branch has the
  // worker's type-check gate instead.
  merge_conflict: [
    "TARGET_DESCRIPTION",
    "BASE_BRANCH",
    "CONFLICTED_FILES"
  ],
  workflow_setup: [
    "REPO",
    "LANGUAGES",
    "MISSING_WORKFLOWS",
    "DEFAULT_BRANCH",
    "EXISTING_WORKFLOWS"
  ],
  security_scan: [
    // Issue #2135: `{{REPO_FULL_NAME}}` was retired — the worker's
    // cwd already points at the cloned repo, so `gh issue create`
    // operates on the right one without explicit substitution.
    // Issue #2159: `{{LANGUAGE_HINTS}}` was retired — the scanner
    // agent detects dominant languages at scan time as step zero of the
    // Phase 1 inventory.
    // Issue #2439: `{{ATTRIBUTION_FOOTER}}` was added as an *optional*
    // placeholder — see OPTIONAL_PLACEHOLDERS below.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  best_practices: [
    // Issue #2148: the best-practices template substitutes the picked
    // bucket and the two dedup lists at file time.
    // Issue #2439: `{{ATTRIBUTION_FOOTER}}` was added as an optional
    // placeholder — see OPTIONAL_PLACEHOLDERS below.
    "BUCKET",
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  test_audit: [
    // Issue #2250 (parent #2214): language-agnostic WHAT-vs-HOW test
    // quality scan. Same two dedup lists as best-practices and
    // security-scan; no bucket — the scan is language-agnostic.
    // Issue #2439: `{{ATTRIBUTION_FOOTER}}` was added as an optional
    // placeholder — see OPTIONAL_PLACEHOLDERS below.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  github_actions_audit: [
    // Issue #2255 (parent #2243): single-bucket GitHub Actions audit.
    // Same two dedup lists as the other scans, plus the two catalogue
    // tables rendered from `github_actions_catalogue.ts` at file time.
    // Issue #2439: `{{ATTRIBUTION_FOOTER}}` was added as an optional
    // placeholder — see OPTIONAL_PLACEHOLDERS below.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
    "ACTIONS_CATALOGUE_TABLE",
    "EOL_RUNTIMES_TABLE"
  ],
  supply_chain_readiness: [
    // Issue #2397 (parent #2396): repo-posture audit for surviving and
    // responding to supply-chain compromise. Same two dedup lists as the
    // other scan templates — the scan is ecosystem-aware but has no
    // bucket parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  supply_chain_detection: [
    // Issue #2443 (parent #2406): active malicious-dependency detection.
    // Same two dedup lists as the other scan templates — the scan is
    // ecosystem-aware, single-scope, and has no bucket parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  orphan_deps: [
    // Issue #2905 (parent #2902): phased orphan / unmaintained dependency
    // detection + maintained-replacement suggestion. Same two dedup lists
    // as the other scan templates — the scan is ecosystem-aware,
    // single-scope, and has no bucket parameter. Unlike the static-only
    // scans, this prompt is the one sanctioned exception that may read
    // registry / network metadata within a fixed allow-list.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  documentation_audit: [
    // Issue #3319 (template #13): prose / Markdown documentation
    // reconciliation audit — fold PR-summary learnings into the main
    // docs, prune stale content. Same two dedup lists as the other scan
    // templates — the audit is language-agnostic and has no bucket
    // parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  private_repo_reference_audit: [
    // Issue #3549 (template #16): public-repo private-reference audit —
    // detect direct references to a private stSoftwareAU repo. Only runs
    // against public repos. Same two dedup lists as the other scan
    // templates — language-agnostic, no bucket parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  doc_coverage: [
    // Issue #3807 (template #6): module-doc & README coverage scan. The
    // type was unregistered for a long while, so `validatePromptTemplate`
    // refused the surface and nothing guarded its two load-bearing
    // dedup placeholders.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  duplicated_knowledge: [
    // Issue #3609 (template #17): copy-paste blocks that encode the same
    // knowledge and should call one existing helper. Same two dedup lists
    // as the other scan templates — language-agnostic, no bucket — plus
    // the deterministic duplicate-block pre-pass, which is required
    // (unlike test-audit's COVERAGE_GAPS, which is optional).
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
    "DUPLICATE_BLOCKS"
  ],
  retro: [
    // Issue #664 (template #18): suggestion-only retrospective on a
    // finished run — environment improvements, not code changes. Same two
    // dedup lists as the other scan templates; language-agnostic, no
    // bucket, and no deterministic pre-pass (the artefacts are the input).
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  // Issue #536 (parent #523): dead-code, deprecated-API and format-drift file
  // findings like the other scans but were unregistered, so
  // `validatePromptTemplate` refused the surface outright and nothing guarded
  // their two dedup placeholders. All three templates carry both — the
  // `doc_coverage` precedent from #3807.
  dead_code: [
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  deprecated_api: [
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  format_drift: [
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS"
  ],
  coding_guidelines: []
};
/**
 * Optional placeholders that are valid but not required (Issue #1332).
 *
 * These placeholders may appear in newer template versions but are not
 * mandatory. Templates without them still pass validation (backward
 * compatible). Used for discoverability and documentation.
 *
 * Issue #3813: `CODING_GUIDELINES` moved here from REQUIRED_PLACEHOLDERS —
 * the builder-hosted templates no longer carry it.
 *
 * Issue #536 (parent #523): `OPEN_ISSUE_TITLES` — the all-open-issues dedup
 * block — is registered here for every scan type that files findings.
 * `{{KNOWN_OPEN_FINDING_IDS}}` stays the deterministic first line of dedup;
 * the title list is what lets the scanner skip a semantic duplicate already
 * open under another label. It is *optional* like `ATTRIBUTION_FOOTER`
 * (#2439) and `CODING_GUIDELINES` (#3813): a scan template that omits it is
 * still valid.
 */ export const OPTIONAL_PLACEHOLDERS = {
  // Issue #2343: `EXECUTOR_SPLIT_INSTRUCTIONS` carries the advisor/executor
  // block on a run with `issue_executor_split` on, and the empty string on
  // every other run — an operator's template is free to omit it, and the
  // builder warns when a split run reads one that does.
  issue: [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES",
    "EXECUTOR_SPLIT_INSTRUCTIONS"
  ],
  pr_feedback: [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES"
  ],
  spelling_fix: [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES"
  ],
  planning: [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES"
  ],
  planning_critique: [
    "VERBOSITY_INSTRUCTIONS",
    "MILESTONE_INSTRUCTIONS"
  ],
  // Issue #4110: the coding guidelines ride in the system prompt for both
  // Quorum prompts (as for `planning`), so only the verbosity block is
  // substituted into the body.
  quorum: [
    "VERBOSITY_INSTRUCTIONS"
  ],
  quorum_judge: [
    "VERBOSITY_INSTRUCTIONS"
  ],
  question: [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES"
  ],
  // Issue #849: the grill-me builder always substitutes the guidelines, the
  // verbosity block and the deterministic requirements rubric, but an
  // operator's override is free to omit any of them.
  // Issue #1933: `FORCED_FINAL_INSTRUCTION` carries the forced-final signal
  // the stop rule computes — empty on an ordinary round, so an operator's
  // override is free to omit it.
  "grill-me": [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES",
    "RUBRIC_FINDINGS",
    "FORCED_FINAL_INSTRUCTION"
  ],
  ci_fix: [
    "VERBOSITY_INSTRUCTIONS",
    "FAILURE_CLASSIFICATION",
    "PR_FAILURE_ACTIONS",
    "CODING_GUIDELINES"
  ],
  workflow_setup: [
    "VERBOSITY_INSTRUCTIONS",
    "CODING_GUIDELINES"
  ],
  // Issue #84: the coding guidelines ride in the system prompt, so only the
  // verbosity block is substituted into the merge-conflict body.
  // Issue #1114: `ISSUE_CONTEXT` carries the originating issues behind both
  // sides of the conflict. It is optional rather than required — a conflict
  // with nothing to consult substitutes it away, and an operator override
  // written before this change is still a valid template.
  // Issue #1965: `REPAIR_CONTEXT` carries the verification failure a repair
  // run answers. Optional for the same reason as `ISSUE_CONTEXT` — an
  // ordinary resolution substitutes it away, and an operator override written
  // before the repair rung existed is still a valid template.
  merge_conflict: [
    "VERBOSITY_INSTRUCTIONS",
    "ISSUE_CONTEXT",
    "REPAIR_CONTEXT"
  ],
  // Issue #2439: `ATTRIBUTION_FOOTER` is the attribution-footer
  // placeholder the four idle-task templates always supply at file time.
  // Issue #3014: `LLM_GATE` carries the worker's deterministic LLM-usage
  // verdict that gates the OWASP GenAI / LLM Top 10 taxonomy.
  security_scan: [
    "ATTRIBUTION_FOOTER",
    "LLM_GATE",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #2916: `COVERAGE_GAPS` is the pre-computed
  // untested-public-function list injected by the test-audit template at
  // scan time.
  test_audit: [
    "ATTRIBUTION_FOOTER",
    "COVERAGE_GAPS",
    "OPEN_ISSUE_TITLES"
  ],
  best_practices: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #2578: `COST_CANDIDATES` carries the deterministic cost and speed
  // leads (`workflow_cost_scanner.ts`) for checks 37–41, injected at scan
  // time; the file-time wrapper renders it `(none)`.
  github_actions_audit: [
    "ATTRIBUTION_FOOTER",
    "COST_CANDIDATES",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #536: the supply-chain scans file findings like the rest of the
  // family, so they take the all-open-issues dedup block. Their prompts carry
  // no attribution footer, so that placeholder is not registered for them.
  supply_chain_readiness: [
    "OPEN_ISSUE_TITLES"
  ],
  supply_chain_detection: [
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #2905: orphan-deps carries the attribution footer like the other
  // idle-task scan templates; optional for consistency with the family.
  orphan_deps: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #3549: private-repo-reference-audit carries the attribution footer
  // like the other idle-task scan templates; optional for consistency.
  private_repo_reference_audit: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #3808: documentation-audit was half-registered — it appeared in
  // REQUIRED_PLACEHOLDERS only, so the `{{ATTRIBUTION_FOOTER}}` every
  // version of its prompt carries, and which
  // `documentation_audit_template.ts` substitutes at file time, was an
  // unregistered placeholder and `getOptionalPlaceholders` errored on it.
  documentation_audit: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #3609: duplicated-knowledge carries the attribution footer like
  // the other idle-task scan templates; optional for consistency.
  duplicated_knowledge: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #3807: doc-coverage carries the attribution footer like the
  // other idle-task scan templates; optional for consistency.
  doc_coverage: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #664: retro carries the attribution footer like the other
  // idle-task scan templates; optional for consistency.
  retro: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  // Issue #536: dead-code, deprecated-API and format-drift carry the
  // attribution footer like the rest of the family, and take the
  // all-open-issues dedup block on the same optional terms.
  dead_code: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  deprecated_api: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  format_drift: [
    "ATTRIBUTION_FOOTER",
    "OPEN_ISSUE_TITLES"
  ],
  coding_guidelines: []
};
/**
 * Get the prompts directory path.
 *
 * Uses PROMPTS_DIR environment variable if set, otherwise derives from
 * the worker directory structure.
 *
 * Issue #968: `env` is the injected lookup seam. A test that wanted to see
 * what a `PROMPTS_DIR` or `VIBE_BASE_DIR` override resolves to had to write
 * those variables into the process, which races every other worker under
 * `deno test --parallel` — and, worse, made `tests/support/repo_prompts.ts`
 * delete them again at module scope for the thirty-odd suites that load a
 * real template. Handing the lookup in as a parameter removes both.
 *
 * @param workerDir - Optional worker directory path for deriving prompts dir
 * @param env - Environment lookup; defaults to the real process environment
 * @returns Path to the prompts directory
 */ export function getPromptsDir(workerDir, env = processEnvLookup) {
  const envDir = env("PROMPTS_DIR");
  if (envDir) {
    return envDir;
  }
  if (workerDir) {
    return `${workerDir}/../prompts`;
  }
  // The checkout the launcher named (Issue #4302): in container mode the
  // driver runs from a VM-local staged copy of worker/deno, so a
  // module-relative path would look for prompts/ under the staged copy —
  // observed live as "Prompt 'planning' not found in
  // ~/.worker-src/worker/deno/lib/../../../prompts".
  const baseDir = env("VIBE_BASE_DIR");
  if (baseDir) {
    return `${baseDir}/prompts`;
  }
  // Default: relative to the deno worker module (worker/deno/lib/)
  const moduleDir = new URL(".", import.meta.url).pathname;
  return `${moduleDir}../../../prompts`;
}
/** Filename every prompt type's template lives under (Issue #844). */ export const PROMPT_FILENAME = "prompt.md";
/**
 * The file a built-in prompt type is loaded from (Issue #849).
 *
 * Named separately from {@link loadPrompt} because the override resolver
 * records *which* file a phase used, and a run's traceability record must name
 * the built-in path as precisely as it names an operator's.
 *
 * @param promptName - Name of the prompt (matches subdirectory in prompts/)
 * @param promptsDir - Path to the prompts directory
 * @returns Absolute or caller-relative path of the template file
 */ export function promptTemplatePath(promptName, promptsDir) {
  return `${promptsDir ?? getPromptsDir()}/${promptName}/${PROMPT_FILENAME}`;
}
/**
 * Load a prompt template by name.
 *
 * @param promptName - Name of the prompt (matches subdirectory in prompts/)
 * @param promptsDir - Path to the prompts directory
 * @returns The prompt template content
 */ export async function loadPrompt(promptName, promptsDir) {
  const templateFile = promptTemplatePath(promptName, promptsDir);
  try {
    const content = await Deno.readTextFile(templateFile);
    return {
      ok: true,
      value: content
    };
  } catch  {
    return {
      ok: false,
      error: new Error(`Prompt '${promptName}' not found at ${templateFile}`)
    };
  }
}
/**
 * Record which prompt revision a run used, for traceability (Issue #212,
 * #844).
 *
 * Versioned filenames are gone, so the checkout's git commit is what
 * identifies the template text a run saw. Appends a timestamped entry to the
 * specified log file.
 *
 * @param logFile - Path to the prompt revision log file
 * @param commit - Short commit hash of the checkout the templates came from
 */ export async function recordPromptCommit(logFile, commit) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const entry = `${timestamp} prompts_commit=${commit}\n`;
  try {
    await Deno.writeTextFile(logFile, entry, {
      append: true
    });
    return {
      ok: true,
      value: undefined
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to record prompt commit: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Resolve the short commit hash of a checkout (Issue #844).
 *
 * This is the replacement for the per-template version number: it identifies
 * exactly which prompt text a run loaded. Fails loud rather than returning a
 * placeholder, so a broken checkout is never logged as a clean revision.
 *
 * @param repoDir - Path inside the checkout. Defaults to the prompts
 *   directory, which is what `git` is asked about.
 * @returns The short commit hash (e.g. "2326b04")
 */ export async function getPromptsCommit(repoDir) {
  const dir = repoDir ?? getPromptsDir();
  try {
    // Issue #1214: every git spawn goes through the timeout chokepoint.
    const result = await runGitCommand([
      "-C",
      dir,
      "rev-parse",
      "--short",
      "HEAD"
    ]);
    if (!result.ok) {
      return {
        ok: false,
        error: new Error(`Failed to resolve prompts commit in ${dir}: ${result.error.message}`)
      };
    }
    const output = result.value;
    if (output.code !== 0) {
      const stderr = output.stderr.trim();
      return {
        ok: false,
        error: new Error(`Failed to resolve prompts commit in ${dir}: ${stderr}`)
      };
    }
    const commit = output.stdout.trim();
    if (!commit) {
      return {
        ok: false,
        error: new Error(`Empty commit hash resolved in ${dir}`)
      };
    }
    return {
      ok: true,
      value: commit
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to resolve prompts commit in ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Get the required placeholders for a template type.
 *
 * @param templateType - Name of the template type
 * @returns Array of placeholder names, or error for unknown types
 */ export function getRequiredPlaceholders(templateType) {
  const placeholders = REQUIRED_PLACEHOLDERS[templateType];
  if (placeholders === undefined) {
    return {
      ok: false,
      error: new Error(`Unknown template type '${templateType}'`)
    };
  }
  return {
    ok: true,
    value: placeholders
  };
}
/**
 * Get the optional placeholders for a template type (Issue #1332).
 *
 * Optional placeholders are valid in templates but not required. They are
 * used for features like verbosity instructions that may not be present
 * in older template versions.
 *
 * @param templateType - Name of the template type
 * @returns Array of optional placeholder names, or error for unknown types
 */ export function getOptionalPlaceholders(templateType) {
  const placeholders = OPTIONAL_PLACEHOLDERS[templateType];
  if (placeholders === undefined) {
    return {
      ok: false,
      error: new Error(`Unknown template type '${templateType}'`)
    };
  }
  return {
    ok: true,
    value: placeholders
  };
}
/**
 * Validate that a template contains all required placeholders.
 *
 * @param templateType - Name of the template type
 * @param templateContent - The loaded template content to validate
 * @returns Result with missing placeholders if any
 */ export function validatePromptTemplate(templateType, templateContent) {
  const placeholdersResult = getRequiredPlaceholders(templateType);
  if (!placeholdersResult.ok) {
    return placeholdersResult;
  }
  const required = placeholdersResult.value;
  if (required.length === 0) {
    return {
      ok: true,
      value: []
    };
  }
  const missing = [];
  for (const placeholder of required){
    if (!templateContent.includes(`{{${placeholder}}}`)) {
      missing.push(placeholder);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: new Error(`Template '${templateType}' is missing required placeholders: ${missing.join(", ")}`)
    };
  }
  return {
    ok: true,
    value: []
  };
}
/**
 * Validate all prompt templates have required placeholders.
 *
 * @param promptsDir - Path to the prompts directory
 * @returns Result with list of errors if any templates fail validation
 */ export async function validateAllPromptTemplates(promptsDir) {
  const templateTypes = [
    "coding_guidelines",
    "issue",
    "planning",
    "question",
    "pr_feedback",
    "spelling_fix",
    "workflow_setup",
    "security_scan"
  ];
  const errors = [];
  for (const templateType of templateTypes){
    const loadResult = await loadPrompt(templateType, promptsDir);
    if (!loadResult.ok) {
      errors.push(`Failed to load template '${templateType}': ${loadResult.error.message}`);
      continue;
    }
    const validateResult = validatePromptTemplate(templateType, loadResult.value);
    if (!validateResult.ok) {
      errors.push(validateResult.error.message);
    }
  }
  if (errors.length > 0) {
    return {
      ok: false,
      error: new Error(errors.join("\n"))
    };
  }
  return {
    ok: true,
    value: []
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcm9tcHRfbWFuYWdlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFByb21wdCB0ZW1wbGF0ZSBtYW5hZ2VtZW50IChJc3N1ZSAjMTk3LCAjOTE0LCAjODQ0KS5cbiAqXG4gKiBNYW5hZ2VzIHRoZSBwcm9tcHQgdGVtcGxhdGVzIHN0b3JlZCBpbiB0aGUgcHJvbXB0cy8gZGlyZWN0b3J5LiBFYWNoIHByb21wdFxuICogaXMgYSBzdWJkaXJlY3RvcnkgaG9sZGluZyBhIHNpbmdsZSBlZGl0YWJsZSBgcHJvbXB0Lm1kYC4gSXNzdWUgIzg0NCByZW1vdmVkXG4gKiB0aGUgYHZOLm1kYCB2ZXJzaW9uaW5nIGNvbnZlbnRpb246IHRoZSByZXBvIGlzIHB1YmxpYywgc28gZ2l0IGhpc3RvcnkgaXMgdGhlXG4gKiByZWNvcmQgb2YgaG93IGEgdGVtcGxhdGUgZXZvbHZlZCwgYW5kIGEgcnVuJ3MgdHJhY2VhYmlsaXR5IGNvbWVzIGZyb20gdGhlXG4gKiBjaGVja291dCdzIGNvbW1pdCBoYXNoIHJhdGhlciB0aGFuIGEgcGVyLXRlbXBsYXRlIHZlcnNpb24gbnVtYmVyLlxuICpcbiAqIE1pZ3JhdGVkIGZyb20gd29ya2VyL3NoYXJlZC9wcm9tcHRfbWFuYWdlci5zaC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgdHlwZSBFbnZMb29rdXAsIHByb2Nlc3NFbnZMb29rdXAgfSBmcm9tIFwiLi9lbnZfbG9va3VwLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcblxuLyoqXG4gKiBLbm93biB0ZW1wbGF0ZSB0eXBlcyBhbmQgdGhlaXIgcmVxdWlyZWQgcGxhY2Vob2xkZXJzLlxuICovXG4vLyBJc3N1ZSAjMzgxMzogYENPRElOR19HVUlERUxJTkVTYCBpcyBubyBsb25nZXIgcmVxdWlyZWQgYnkgYW55IG9mIHRoZVxuLy8gYnVpbGRlci1ob3N0ZWQgdHlwZXMuIFNpbmNlICMxMjYyIHRoZSBndWlkZWxpbmVzIHJpZGUgaW4gdGhlIHN5c3RlbSBwcm9tcHQsXG4vLyBzbyBgcHJvbXB0X2J1aWxkZXIudHNgIHN1YnN0aXR1dGVkIHRoZSBwbGFjZWhvbGRlciB3aXRoIGFuIGVtcHR5IHN0cmluZyBhbmRcbi8vIGV2ZXJ5IGhvc3QgcmVuZGVyZWQgYSBoZWFkaW5nIHdpdGggbm90aGluZyB1bmRlciBpdC4gVGhlIHBsYWNlaG9sZGVyIGlzIGdvbmVcbi8vIGZyb20gdGhlIGlzc3VlLCBwbGFubmluZywgcXVlc3Rpb24sIHByX2ZlZWRiYWNrLCBzcGVsbGluZ19maXgsXG4vLyB3b3JrZmxvd19zZXR1cCBhbmQgY2lfZml4IHRlbXBsYXRlczsgaXQgc3RheXMgcmVnaXN0ZXJlZCBhcyAqb3B0aW9uYWwqIHNvIGFcbi8vIHRlbXBsYXRlIHRoYXQgc3RpbGwgY2FycmllcyBpdCBpcyBub3QgcmVqZWN0ZWQuXG5jb25zdCBSRVFVSVJFRF9QTEFDRUhPTERFUlM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IHtcbiAgaXNzdWU6IFtcIklTU1VFX05VTUJFUlwiLCBcIlFVQUxJVFlfSU5TVFJVQ1RJT05TXCJdLFxuICBwcl9mZWVkYmFjazogW1wiUFJfTlVNQkVSXCIsIFwiUVVBTElUWV9JTlNUUlVDVElPTlNcIl0sXG4gIHNwZWxsaW5nX2ZpeDogW1wiUFJfTlVNQkVSXCIsIFwiUVVBTElUWV9JTlNUUlVDVElPTlNcIl0sXG4gIHBsYW5uaW5nOiBbXCJSRVBPXCIsIFwiSVNTVUVfTlVNQkVSXCIsIFwiUExBTk5JTkdfTEFCRUxcIl0sXG4gIC8vIElzc3VlICMyNjUyOiB0aGUgc2Vjb25kIHR1cm4gb2YgdGhlIHR3by1zdGFnZSBwbGFubmluZyBmbG93LiBJdFxuICAvLyBhZHZlcnNhcmlhbGx5IGNyaXRpcXVlcyB0aGUgZHJhZnQgcGxhbiwgcmV2aXNlcyBvbmNlLCB0aGVuIHB1Ymxpc2hlcyB0aGVcbiAgLy8gZmluYWwgc3ViLWlzc3Vlcy4gVGhlIGNvZGluZyBndWlkZWxpbmVzIHJpZGUgaW4gdGhlIHN5c3RlbSBwcm9tcHQgKGFzIGZvclxuICAvLyBgcGxhbm5pbmdgKSwgc28gdGhleSBhcmUgbm90IGEgcmVxdWlyZWQgYm9keSBwbGFjZWhvbGRlciBoZXJlLlxuICBwbGFubmluZ19jcml0aXF1ZTogW1wiUkVQT1wiLCBcIklTU1VFX05VTUJFUlwiLCBcIlBMQU5OSU5HX0xBQkVMXCJdLFxuICAvLyBJc3N1ZSAjNDExMCAocGFyZW50ICM0MTAyKTogdGhlIHR3byBRdW9ydW0gcHJvbXB0cy4gQm90aCBmZW5jZSB0aGUgaXNzdWVcbiAgLy8gdGhlbXNlbHZlcyDigJQgdGhlIGJvdW5kYXJ5LWludGVncml0eSBpbnN0cnVjdGlvbiBpcyBhIHBsYWNlaG9sZGVyIHJhdGhlclxuICAvLyB0aGFuIGJ1aWxkZXItYXBwZW5kZWQgcHJvc2UgKHRoZSBgZ3JpbGwtbWVgIHNoYXBlKSwgc28gaXQgaXMgcmVxdWlyZWQ6XG4gIC8vIGEgUXVvcnVtIHRlbXBsYXRlIHJlbmRlcmVkIHdpdGhvdXQgaXQgd291bGQgaGFuZCBhbiBhZ2VudCB1bmZlbmNlZFxuICAvLyBHaXRIdWIgdGV4dC5cbiAgcXVvcnVtOiBbXG4gICAgXCJSRVBPXCIsXG4gICAgXCJJU1NVRV9OVU1CRVJcIixcbiAgICBcIklTU1VFX1RJVExFXCIsXG4gICAgXCJJU1NVRV9MQUJFTFNcIixcbiAgICBcIklTU1VFX0JPRFlcIixcbiAgICBcIklTU1VFX0NPTU1FTlRTXCIsXG4gICAgXCJCT1VOREFSWV9JTlRFR1JJVFlfSU5TVFJVQ1RJT05cIixcbiAgXSxcbiAgLy8gVGhlIGp1ZGdlIGFkZGl0aW9uYWxseSByZWNlaXZlcyB0aGUgdHdvIGNhbmRpZGF0ZSBwbGFucywgYW5vbnltaXNlZCBhcyBBXG4gIC8vIGFuZCBCLiBUaGV5IGFyZSB1bnRydXN0ZWQgaW5wdXQgbGlrZSB0aGUgaXNzdWUgdGV4dCwgc28gdGhleSBhcmUgZmVuY2VkXG4gIC8vIGJ5IHRoZSBzYW1lIGluc3RydWN0aW9uLlxuICBxdW9ydW1fanVkZ2U6IFtcbiAgICBcIlJFUE9cIixcbiAgICBcIklTU1VFX05VTUJFUlwiLFxuICAgIFwiSVNTVUVfVElUTEVcIixcbiAgICBcIklTU1VFX0xBQkVMU1wiLFxuICAgIFwiSVNTVUVfQk9EWVwiLFxuICAgIFwiSVNTVUVfQ09NTUVOVFNcIixcbiAgICBcIlBMQU5fQVwiLFxuICAgIFwiUExBTl9CXCIsXG4gICAgXCJCT1VOREFSWV9JTlRFR1JJVFlfSU5TVFJVQ1RJT05cIixcbiAgXSxcbiAgcXVlc3Rpb246IFtcbiAgICBcIlJFUE9cIixcbiAgICBcIklTU1VFX05VTUJFUlwiLFxuICAgIFwiUVVFU1RJT05fTEFCRUxcIixcbiAgXSxcbiAgLy8gSXNzdWUgIzg0OSAocGFyZW50ICM4NDMpOiB0aGUgZ3JpbGwtbWUgaW50ZXJyb2dhdGlvbiByb3VuZHMuIFRoZSB0eXBlIHdhc1xuICAvLyB1bnJlZ2lzdGVyZWQsIHNvIGFuIG9wZXJhdG9yIG92ZXJyaWRlIG9mIHRoZSBwaGFzZSBoYWQgbm8gcGxhY2Vob2xkZXJcbiAgLy8gY29udHJhY3QgdG8gdmFsaWRhdGUgYWdhaW5zdC4gTGlrZSB0aGUgUXVvcnVtIHByb21wdHMsIHRoaXMgdGVtcGxhdGVcbiAgLy8gZmVuY2VzIHRoZSB1bnRydXN0ZWQgaXNzdWUgdGV4dCBpdHNlbGYsIHNvXG4gIC8vIGBCT1VOREFSWV9JTlRFR1JJVFlfSU5TVFJVQ1RJT05gIGlzIHJlcXVpcmVkIHJhdGhlciB0aGFuXG4gIC8vIGJ1aWxkZXItYXBwZW5kZWQ6IGEgZ3JpbGwtbWUgdGVtcGxhdGUgcmVuZGVyZWQgd2l0aG91dCBpdCB3b3VsZCBoYW5kIGFuXG4gIC8vIGFnZW50IHVuZmVuY2VkIEdpdEh1YiB0ZXh0LlxuICBcImdyaWxsLW1lXCI6IFtcbiAgICBcIlJFUE9cIixcbiAgICBcIklTU1VFX05VTUJFUlwiLFxuICAgIFwiSVNTVUVfVElUTEVcIixcbiAgICBcIklTU1VFX0JPRFlcIixcbiAgICBcIkNPTU1FTlRfSElTVE9SWVwiLFxuICAgIFwiUk9VTkRfTlVNQkVSXCIsXG4gICAgXCJNQVhfUk9VTkRTXCIsXG4gICAgXCJCT1VOREFSWV9JTlRFR1JJVFlfSU5TVFJVQ1RJT05cIixcbiAgXSxcbiAgY2lfZml4OiBbXCJQUl9OVU1CRVJcIiwgXCJRVUFMSVRZX0lOU1RSVUNUSU9OU1wiXSxcbiAgLy8gSXNzdWUgIzg0OiB0aGUgY29uZmxpY3QtcmVzb2x1dGlvbiBwYXNzLiBUaGUgdGVtcGxhdGUgbmFtZXMgdGhlIHRhcmdldCxcbiAgLy8gdGhlIGJhc2UgYnJhbmNoIGJlaW5nIG1lcmdlZCBpbiwgYW5kIHRoZSBjb25mbGljdGVkIHBhdGhzIHRoZSB3b3JrZXIgZm91bmRcbiAgLy8gYWZ0ZXIgc3RhcnRpbmcgdGhlIG1lcmdlIOKAlCBhbGwgdGhyZWUgYXJlIGxvYWQtYmVhcmluZywgc28gYWxsIHRocmVlIGFyZVxuICAvLyByZXF1aXJlZC5cbiAgLy8gSXNzdWUgIzE3Njc6IHRoZSB0YXJnZXQgaXMgYSBQUiAqb3IqIGEgbWlsZXN0b25lIGJyYW5jaCwgc28gdGhlIG9wZW5pbmcgaXNcbiAgLy8gYFRBUkdFVF9ERVNDUklQVElPTmAgcmF0aGVyIHRoYW4gYSBiYXJlIFBSIG51bWJlci5cbiAgLy8gSXNzdWUgIzIzMDY6IHRoZSBhZ2VudCBydW5zIG5vIHF1YWxpdHkgZ2F0ZSBpdHNlbGYsIHNvIHRoZSB0ZW1wbGF0ZSBjYXJyaWVzXG4gIC8vIG5vIGBRVUFMSVRZX0lOU1RSVUNUSU9OU2AgYmxvY2suIElzc3VlICM0NjE2OiB0aGUgd29ya2VyIHJ1bnMgdGhlIGZhc3QgbG9jYWxcbiAgLy8gY2hlY2tzIG9uIGEgUFIncyBzdGFnZWQgbWVyZ2UgYmVmb3JlIHRoZSBwdXNoOyBhIG1pbGVzdG9uZSBicmFuY2ggaGFzIHRoZVxuICAvLyB3b3JrZXIncyB0eXBlLWNoZWNrIGdhdGUgaW5zdGVhZC5cbiAgbWVyZ2VfY29uZmxpY3Q6IFtcbiAgICBcIlRBUkdFVF9ERVNDUklQVElPTlwiLFxuICAgIFwiQkFTRV9CUkFOQ0hcIixcbiAgICBcIkNPTkZMSUNURURfRklMRVNcIixcbiAgXSxcbiAgd29ya2Zsb3dfc2V0dXA6IFtcbiAgICBcIlJFUE9cIixcbiAgICBcIkxBTkdVQUdFU1wiLFxuICAgIFwiTUlTU0lOR19XT1JLRkxPV1NcIixcbiAgICBcIkRFRkFVTFRfQlJBTkNIXCIsXG4gICAgXCJFWElTVElOR19XT1JLRkxPV1NcIixcbiAgXSxcbiAgc2VjdXJpdHlfc2NhbjogW1xuICAgIC8vIElzc3VlICMyMTM1OiBge3tSRVBPX0ZVTExfTkFNRX19YCB3YXMgcmV0aXJlZCDigJQgdGhlIHdvcmtlcidzXG4gICAgLy8gY3dkIGFscmVhZHkgcG9pbnRzIGF0IHRoZSBjbG9uZWQgcmVwbywgc28gYGdoIGlzc3VlIGNyZWF0ZWBcbiAgICAvLyBvcGVyYXRlcyBvbiB0aGUgcmlnaHQgb25lIHdpdGhvdXQgZXhwbGljaXQgc3Vic3RpdHV0aW9uLlxuICAgIC8vIElzc3VlICMyMTU5OiBge3tMQU5HVUFHRV9ISU5UU319YCB3YXMgcmV0aXJlZCDigJQgdGhlIHNjYW5uZXJcbiAgICAvLyBhZ2VudCBkZXRlY3RzIGRvbWluYW50IGxhbmd1YWdlcyBhdCBzY2FuIHRpbWUgYXMgc3RlcCB6ZXJvIG9mIHRoZVxuICAgIC8vIFBoYXNlIDEgaW52ZW50b3J5LlxuICAgIC8vIElzc3VlICMyNDM5OiBge3tBVFRSSUJVVElPTl9GT09URVJ9fWAgd2FzIGFkZGVkIGFzIGFuICpvcHRpb25hbCpcbiAgICAvLyBwbGFjZWhvbGRlciDigJQgc2VlIE9QVElPTkFMX1BMQUNFSE9MREVSUyBiZWxvdy5cbiAgICBcIlNVUFBSRVNTRURfSURTXCIsXG4gICAgXCJLTk9XTl9PUEVOX0ZJTkRJTkdfSURTXCIsXG4gIF0sXG4gIGJlc3RfcHJhY3RpY2VzOiBbXG4gICAgLy8gSXNzdWUgIzIxNDg6IHRoZSBiZXN0LXByYWN0aWNlcyB0ZW1wbGF0ZSBzdWJzdGl0dXRlcyB0aGUgcGlja2VkXG4gICAgLy8gYnVja2V0IGFuZCB0aGUgdHdvIGRlZHVwIGxpc3RzIGF0IGZpbGUgdGltZS5cbiAgICAvLyBJc3N1ZSAjMjQzOTogYHt7QVRUUklCVVRJT05fRk9PVEVSfX1gIHdhcyBhZGRlZCBhcyBhbiBvcHRpb25hbFxuICAgIC8vIHBsYWNlaG9sZGVyIOKAlCBzZWUgT1BUSU9OQUxfUExBQ0VIT0xERVJTIGJlbG93LlxuICAgIFwiQlVDS0VUXCIsXG4gICAgXCJTVVBQUkVTU0VEX0lEU1wiLFxuICAgIFwiS05PV05fT1BFTl9GSU5ESU5HX0lEU1wiLFxuICBdLFxuICB0ZXN0X2F1ZGl0OiBbXG4gICAgLy8gSXNzdWUgIzIyNTAgKHBhcmVudCAjMjIxNCk6IGxhbmd1YWdlLWFnbm9zdGljIFdIQVQtdnMtSE9XIHRlc3RcbiAgICAvLyBxdWFsaXR5IHNjYW4uIFNhbWUgdHdvIGRlZHVwIGxpc3RzIGFzIGJlc3QtcHJhY3RpY2VzIGFuZFxuICAgIC8vIHNlY3VyaXR5LXNjYW47IG5vIGJ1Y2tldCDigJQgdGhlIHNjYW4gaXMgbGFuZ3VhZ2UtYWdub3N0aWMuXG4gICAgLy8gSXNzdWUgIzI0Mzk6IGB7e0FUVFJJQlVUSU9OX0ZPT1RFUn19YCB3YXMgYWRkZWQgYXMgYW4gb3B0aW9uYWxcbiAgICAvLyBwbGFjZWhvbGRlciDigJQgc2VlIE9QVElPTkFMX1BMQUNFSE9MREVSUyBiZWxvdy5cbiAgICBcIlNVUFBSRVNTRURfSURTXCIsXG4gICAgXCJLTk9XTl9PUEVOX0ZJTkRJTkdfSURTXCIsXG4gIF0sXG4gIGdpdGh1Yl9hY3Rpb25zX2F1ZGl0OiBbXG4gICAgLy8gSXNzdWUgIzIyNTUgKHBhcmVudCAjMjI0Myk6IHNpbmdsZS1idWNrZXQgR2l0SHViIEFjdGlvbnMgYXVkaXQuXG4gICAgLy8gU2FtZSB0d28gZGVkdXAgbGlzdHMgYXMgdGhlIG90aGVyIHNjYW5zLCBwbHVzIHRoZSB0d28gY2F0YWxvZ3VlXG4gICAgLy8gdGFibGVzIHJlbmRlcmVkIGZyb20gYGdpdGh1Yl9hY3Rpb25zX2NhdGFsb2d1ZS50c2AgYXQgZmlsZSB0aW1lLlxuICAgIC8vIElzc3VlICMyNDM5OiBge3tBVFRSSUJVVElPTl9GT09URVJ9fWAgd2FzIGFkZGVkIGFzIGFuIG9wdGlvbmFsXG4gICAgLy8gcGxhY2Vob2xkZXIg4oCUIHNlZSBPUFRJT05BTF9QTEFDRUhPTERFUlMgYmVsb3cuXG4gICAgXCJTVVBQUkVTU0VEX0lEU1wiLFxuICAgIFwiS05PV05fT1BFTl9GSU5ESU5HX0lEU1wiLFxuICAgIFwiQUNUSU9OU19DQVRBTE9HVUVfVEFCTEVcIixcbiAgICBcIkVPTF9SVU5USU1FU19UQUJMRVwiLFxuICBdLFxuICBzdXBwbHlfY2hhaW5fcmVhZGluZXNzOiBbXG4gICAgLy8gSXNzdWUgIzIzOTcgKHBhcmVudCAjMjM5Nik6IHJlcG8tcG9zdHVyZSBhdWRpdCBmb3Igc3Vydml2aW5nIGFuZFxuICAgIC8vIHJlc3BvbmRpbmcgdG8gc3VwcGx5LWNoYWluIGNvbXByb21pc2UuIFNhbWUgdHdvIGRlZHVwIGxpc3RzIGFzIHRoZVxuICAgIC8vIG90aGVyIHNjYW4gdGVtcGxhdGVzIOKAlCB0aGUgc2NhbiBpcyBlY29zeXN0ZW0tYXdhcmUgYnV0IGhhcyBub1xuICAgIC8vIGJ1Y2tldCBwYXJhbWV0ZXIuXG4gICAgXCJTVVBQUkVTU0VEX0lEU1wiLFxuICAgIFwiS05PV05fT1BFTl9GSU5ESU5HX0lEU1wiLFxuICBdLFxuICBzdXBwbHlfY2hhaW5fZGV0ZWN0aW9uOiBbXG4gICAgLy8gSXNzdWUgIzI0NDMgKHBhcmVudCAjMjQwNik6IGFjdGl2ZSBtYWxpY2lvdXMtZGVwZW5kZW5jeSBkZXRlY3Rpb24uXG4gICAgLy8gU2FtZSB0d28gZGVkdXAgbGlzdHMgYXMgdGhlIG90aGVyIHNjYW4gdGVtcGxhdGVzIOKAlCB0aGUgc2NhbiBpc1xuICAgIC8vIGVjb3N5c3RlbS1hd2FyZSwgc2luZ2xlLXNjb3BlLCBhbmQgaGFzIG5vIGJ1Y2tldCBwYXJhbWV0ZXIuXG4gICAgXCJTVVBQUkVTU0VEX0lEU1wiLFxuICAgIFwiS05PV05fT1BFTl9GSU5ESU5HX0lEU1wiLFxuICBdLFxuICBvcnBoYW5fZGVwczogW1xuICAgIC8vIElzc3VlICMyOTA1IChwYXJlbnQgIzI5MDIpOiBwaGFzZWQgb3JwaGFuIC8gdW5tYWludGFpbmVkIGRlcGVuZGVuY3lcbiAgICAvLyBkZXRlY3Rpb24gKyBtYWludGFpbmVkLXJlcGxhY2VtZW50IHN1Z2dlc3Rpb24uIFNhbWUgdHdvIGRlZHVwIGxpc3RzXG4gICAgLy8gYXMgdGhlIG90aGVyIHNjYW4gdGVtcGxhdGVzIOKAlCB0aGUgc2NhbiBpcyBlY29zeXN0ZW0tYXdhcmUsXG4gICAgLy8gc2luZ2xlLXNjb3BlLCBhbmQgaGFzIG5vIGJ1Y2tldCBwYXJhbWV0ZXIuIFVubGlrZSB0aGUgc3RhdGljLW9ubHlcbiAgICAvLyBzY2FucywgdGhpcyBwcm9tcHQgaXMgdGhlIG9uZSBzYW5jdGlvbmVkIGV4Y2VwdGlvbiB0aGF0IG1heSByZWFkXG4gICAgLy8gcmVnaXN0cnkgLyBuZXR3b3JrIG1ldGFkYXRhIHdpdGhpbiBhIGZpeGVkIGFsbG93LWxpc3QuXG4gICAgXCJTVVBQUkVTU0VEX0lEU1wiLFxuICAgIFwiS05PV05fT1BFTl9GSU5ESU5HX0lEU1wiLFxuICBdLFxuICBkb2N1bWVudGF0aW9uX2F1ZGl0OiBbXG4gICAgLy8gSXNzdWUgIzMzMTkgKHRlbXBsYXRlICMxMyk6IHByb3NlIC8gTWFya2Rvd24gZG9jdW1lbnRhdGlvblxuICAgIC8vIHJlY29uY2lsaWF0aW9uIGF1ZGl0IOKAlCBmb2xkIFBSLXN1bW1hcnkgbGVhcm5pbmdzIGludG8gdGhlIG1haW5cbiAgICAvLyBkb2NzLCBwcnVuZSBzdGFsZSBjb250ZW50LiBTYW1lIHR3byBkZWR1cCBsaXN0cyBhcyB0aGUgb3RoZXIgc2NhblxuICAgIC8vIHRlbXBsYXRlcyDigJQgdGhlIGF1ZGl0IGlzIGxhbmd1YWdlLWFnbm9zdGljIGFuZCBoYXMgbm8gYnVja2V0XG4gICAgLy8gcGFyYW1ldGVyLlxuICAgIFwiU1VQUFJFU1NFRF9JRFNcIixcbiAgICBcIktOT1dOX09QRU5fRklORElOR19JRFNcIixcbiAgXSxcbiAgcHJpdmF0ZV9yZXBvX3JlZmVyZW5jZV9hdWRpdDogW1xuICAgIC8vIElzc3VlICMzNTQ5ICh0ZW1wbGF0ZSAjMTYpOiBwdWJsaWMtcmVwbyBwcml2YXRlLXJlZmVyZW5jZSBhdWRpdCDigJRcbiAgICAvLyBkZXRlY3QgZGlyZWN0IHJlZmVyZW5jZXMgdG8gYSBwcml2YXRlIHN0U29mdHdhcmVBVSByZXBvLiBPbmx5IHJ1bnNcbiAgICAvLyBhZ2FpbnN0IHB1YmxpYyByZXBvcy4gU2FtZSB0d28gZGVkdXAgbGlzdHMgYXMgdGhlIG90aGVyIHNjYW5cbiAgICAvLyB0ZW1wbGF0ZXMg4oCUIGxhbmd1YWdlLWFnbm9zdGljLCBubyBidWNrZXQgcGFyYW1ldGVyLlxuICAgIFwiU1VQUFJFU1NFRF9JRFNcIixcbiAgICBcIktOT1dOX09QRU5fRklORElOR19JRFNcIixcbiAgXSxcbiAgZG9jX2NvdmVyYWdlOiBbXG4gICAgLy8gSXNzdWUgIzM4MDcgKHRlbXBsYXRlICM2KTogbW9kdWxlLWRvYyAmIFJFQURNRSBjb3ZlcmFnZSBzY2FuLiBUaGVcbiAgICAvLyB0eXBlIHdhcyB1bnJlZ2lzdGVyZWQgZm9yIGEgbG9uZyB3aGlsZSwgc28gYHZhbGlkYXRlUHJvbXB0VGVtcGxhdGVgXG4gICAgLy8gcmVmdXNlZCB0aGUgc3VyZmFjZSBhbmQgbm90aGluZyBndWFyZGVkIGl0cyB0d28gbG9hZC1iZWFyaW5nXG4gICAgLy8gZGVkdXAgcGxhY2Vob2xkZXJzLlxuICAgIFwiU1VQUFJFU1NFRF9JRFNcIixcbiAgICBcIktOT1dOX09QRU5fRklORElOR19JRFNcIixcbiAgXSxcbiAgZHVwbGljYXRlZF9rbm93bGVkZ2U6IFtcbiAgICAvLyBJc3N1ZSAjMzYwOSAodGVtcGxhdGUgIzE3KTogY29weS1wYXN0ZSBibG9ja3MgdGhhdCBlbmNvZGUgdGhlIHNhbWVcbiAgICAvLyBrbm93bGVkZ2UgYW5kIHNob3VsZCBjYWxsIG9uZSBleGlzdGluZyBoZWxwZXIuIFNhbWUgdHdvIGRlZHVwIGxpc3RzXG4gICAgLy8gYXMgdGhlIG90aGVyIHNjYW4gdGVtcGxhdGVzIOKAlCBsYW5ndWFnZS1hZ25vc3RpYywgbm8gYnVja2V0IOKAlCBwbHVzXG4gICAgLy8gdGhlIGRldGVybWluaXN0aWMgZHVwbGljYXRlLWJsb2NrIHByZS1wYXNzLCB3aGljaCBpcyByZXF1aXJlZFxuICAgIC8vICh1bmxpa2UgdGVzdC1hdWRpdCdzIENPVkVSQUdFX0dBUFMsIHdoaWNoIGlzIG9wdGlvbmFsKS5cbiAgICBcIlNVUFBSRVNTRURfSURTXCIsXG4gICAgXCJLTk9XTl9PUEVOX0ZJTkRJTkdfSURTXCIsXG4gICAgXCJEVVBMSUNBVEVfQkxPQ0tTXCIsXG4gIF0sXG4gIHJldHJvOiBbXG4gICAgLy8gSXNzdWUgIzY2NCAodGVtcGxhdGUgIzE4KTogc3VnZ2VzdGlvbi1vbmx5IHJldHJvc3BlY3RpdmUgb24gYVxuICAgIC8vIGZpbmlzaGVkIHJ1biDigJQgZW52aXJvbm1lbnQgaW1wcm92ZW1lbnRzLCBub3QgY29kZSBjaGFuZ2VzLiBTYW1lIHR3b1xuICAgIC8vIGRlZHVwIGxpc3RzIGFzIHRoZSBvdGhlciBzY2FuIHRlbXBsYXRlczsgbGFuZ3VhZ2UtYWdub3N0aWMsIG5vXG4gICAgLy8gYnVja2V0LCBhbmQgbm8gZGV0ZXJtaW5pc3RpYyBwcmUtcGFzcyAodGhlIGFydGVmYWN0cyBhcmUgdGhlIGlucHV0KS5cbiAgICBcIlNVUFBSRVNTRURfSURTXCIsXG4gICAgXCJLTk9XTl9PUEVOX0ZJTkRJTkdfSURTXCIsXG4gIF0sXG4gIC8vIElzc3VlICM1MzYgKHBhcmVudCAjNTIzKTogZGVhZC1jb2RlLCBkZXByZWNhdGVkLUFQSSBhbmQgZm9ybWF0LWRyaWZ0IGZpbGVcbiAgLy8gZmluZGluZ3MgbGlrZSB0aGUgb3RoZXIgc2NhbnMgYnV0IHdlcmUgdW5yZWdpc3RlcmVkLCBzb1xuICAvLyBgdmFsaWRhdGVQcm9tcHRUZW1wbGF0ZWAgcmVmdXNlZCB0aGUgc3VyZmFjZSBvdXRyaWdodCBhbmQgbm90aGluZyBndWFyZGVkXG4gIC8vIHRoZWlyIHR3byBkZWR1cCBwbGFjZWhvbGRlcnMuIEFsbCB0aHJlZSB0ZW1wbGF0ZXMgY2FycnkgYm90aCDigJQgdGhlXG4gIC8vIGBkb2NfY292ZXJhZ2VgIHByZWNlZGVudCBmcm9tICMzODA3LlxuICBkZWFkX2NvZGU6IFtcbiAgICBcIlNVUFBSRVNTRURfSURTXCIsXG4gICAgXCJLTk9XTl9PUEVOX0ZJTkRJTkdfSURTXCIsXG4gIF0sXG4gIGRlcHJlY2F0ZWRfYXBpOiBbXG4gICAgXCJTVVBQUkVTU0VEX0lEU1wiLFxuICAgIFwiS05PV05fT1BFTl9GSU5ESU5HX0lEU1wiLFxuICBdLFxuICBmb3JtYXRfZHJpZnQ6IFtcbiAgICBcIlNVUFBSRVNTRURfSURTXCIsXG4gICAgXCJLTk9XTl9PUEVOX0ZJTkRJTkdfSURTXCIsXG4gIF0sXG4gIGNvZGluZ19ndWlkZWxpbmVzOiBbXSxcbn07XG5cbi8qKlxuICogT3B0aW9uYWwgcGxhY2Vob2xkZXJzIHRoYXQgYXJlIHZhbGlkIGJ1dCBub3QgcmVxdWlyZWQgKElzc3VlICMxMzMyKS5cbiAqXG4gKiBUaGVzZSBwbGFjZWhvbGRlcnMgbWF5IGFwcGVhciBpbiBuZXdlciB0ZW1wbGF0ZSB2ZXJzaW9ucyBidXQgYXJlIG5vdFxuICogbWFuZGF0b3J5LiBUZW1wbGF0ZXMgd2l0aG91dCB0aGVtIHN0aWxsIHBhc3MgdmFsaWRhdGlvbiAoYmFja3dhcmRcbiAqIGNvbXBhdGlibGUpLiBVc2VkIGZvciBkaXNjb3ZlcmFiaWxpdHkgYW5kIGRvY3VtZW50YXRpb24uXG4gKlxuICogSXNzdWUgIzM4MTM6IGBDT0RJTkdfR1VJREVMSU5FU2AgbW92ZWQgaGVyZSBmcm9tIFJFUVVJUkVEX1BMQUNFSE9MREVSUyDigJRcbiAqIHRoZSBidWlsZGVyLWhvc3RlZCB0ZW1wbGF0ZXMgbm8gbG9uZ2VyIGNhcnJ5IGl0LlxuICpcbiAqIElzc3VlICM1MzYgKHBhcmVudCAjNTIzKTogYE9QRU5fSVNTVUVfVElUTEVTYCDigJQgdGhlIGFsbC1vcGVuLWlzc3VlcyBkZWR1cFxuICogYmxvY2sg4oCUIGlzIHJlZ2lzdGVyZWQgaGVyZSBmb3IgZXZlcnkgc2NhbiB0eXBlIHRoYXQgZmlsZXMgZmluZGluZ3MuXG4gKiBge3tLTk9XTl9PUEVOX0ZJTkRJTkdfSURTfX1gIHN0YXlzIHRoZSBkZXRlcm1pbmlzdGljIGZpcnN0IGxpbmUgb2YgZGVkdXA7XG4gKiB0aGUgdGl0bGUgbGlzdCBpcyB3aGF0IGxldHMgdGhlIHNjYW5uZXIgc2tpcCBhIHNlbWFudGljIGR1cGxpY2F0ZSBhbHJlYWR5XG4gKiBvcGVuIHVuZGVyIGFub3RoZXIgbGFiZWwuIEl0IGlzICpvcHRpb25hbCogbGlrZSBgQVRUUklCVVRJT05fRk9PVEVSYFxuICogKCMyNDM5KSBhbmQgYENPRElOR19HVUlERUxJTkVTYCAoIzM4MTMpOiBhIHNjYW4gdGVtcGxhdGUgdGhhdCBvbWl0cyBpdCBpc1xuICogc3RpbGwgdmFsaWQuXG4gKi9cbmV4cG9ydCBjb25zdCBPUFRJT05BTF9QTEFDRUhPTERFUlM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IHtcbiAgLy8gSXNzdWUgIzIzNDM6IGBFWEVDVVRPUl9TUExJVF9JTlNUUlVDVElPTlNgIGNhcnJpZXMgdGhlIGFkdmlzb3IvZXhlY3V0b3JcbiAgLy8gYmxvY2sgb24gYSBydW4gd2l0aCBgaXNzdWVfZXhlY3V0b3Jfc3BsaXRgIG9uLCBhbmQgdGhlIGVtcHR5IHN0cmluZyBvblxuICAvLyBldmVyeSBvdGhlciBydW4g4oCUIGFuIG9wZXJhdG9yJ3MgdGVtcGxhdGUgaXMgZnJlZSB0byBvbWl0IGl0LCBhbmQgdGhlXG4gIC8vIGJ1aWxkZXIgd2FybnMgd2hlbiBhIHNwbGl0IHJ1biByZWFkcyBvbmUgdGhhdCBkb2VzLlxuICBpc3N1ZTogW1xuICAgIFwiVkVSQk9TSVRZX0lOU1RSVUNUSU9OU1wiLFxuICAgIFwiQ09ESU5HX0dVSURFTElORVNcIixcbiAgICBcIkVYRUNVVE9SX1NQTElUX0lOU1RSVUNUSU9OU1wiLFxuICBdLFxuICBwcl9mZWVkYmFjazogW1wiVkVSQk9TSVRZX0lOU1RSVUNUSU9OU1wiLCBcIkNPRElOR19HVUlERUxJTkVTXCJdLFxuICBzcGVsbGluZ19maXg6IFtcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIiwgXCJDT0RJTkdfR1VJREVMSU5FU1wiXSxcbiAgcGxhbm5pbmc6IFtcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIiwgXCJDT0RJTkdfR1VJREVMSU5FU1wiXSxcbiAgcGxhbm5pbmdfY3JpdGlxdWU6IFtcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIiwgXCJNSUxFU1RPTkVfSU5TVFJVQ1RJT05TXCJdLFxuICAvLyBJc3N1ZSAjNDExMDogdGhlIGNvZGluZyBndWlkZWxpbmVzIHJpZGUgaW4gdGhlIHN5c3RlbSBwcm9tcHQgZm9yIGJvdGhcbiAgLy8gUXVvcnVtIHByb21wdHMgKGFzIGZvciBgcGxhbm5pbmdgKSwgc28gb25seSB0aGUgdmVyYm9zaXR5IGJsb2NrIGlzXG4gIC8vIHN1YnN0aXR1dGVkIGludG8gdGhlIGJvZHkuXG4gIHF1b3J1bTogW1wiVkVSQk9TSVRZX0lOU1RSVUNUSU9OU1wiXSxcbiAgcXVvcnVtX2p1ZGdlOiBbXCJWRVJCT1NJVFlfSU5TVFJVQ1RJT05TXCJdLFxuICBxdWVzdGlvbjogW1wiVkVSQk9TSVRZX0lOU1RSVUNUSU9OU1wiLCBcIkNPRElOR19HVUlERUxJTkVTXCJdLFxuICAvLyBJc3N1ZSAjODQ5OiB0aGUgZ3JpbGwtbWUgYnVpbGRlciBhbHdheXMgc3Vic3RpdHV0ZXMgdGhlIGd1aWRlbGluZXMsIHRoZVxuICAvLyB2ZXJib3NpdHkgYmxvY2sgYW5kIHRoZSBkZXRlcm1pbmlzdGljIHJlcXVpcmVtZW50cyBydWJyaWMsIGJ1dCBhblxuICAvLyBvcGVyYXRvcidzIG92ZXJyaWRlIGlzIGZyZWUgdG8gb21pdCBhbnkgb2YgdGhlbS5cbiAgLy8gSXNzdWUgIzE5MzM6IGBGT1JDRURfRklOQUxfSU5TVFJVQ1RJT05gIGNhcnJpZXMgdGhlIGZvcmNlZC1maW5hbCBzaWduYWxcbiAgLy8gdGhlIHN0b3AgcnVsZSBjb21wdXRlcyDigJQgZW1wdHkgb24gYW4gb3JkaW5hcnkgcm91bmQsIHNvIGFuIG9wZXJhdG9yJ3NcbiAgLy8gb3ZlcnJpZGUgaXMgZnJlZSB0byBvbWl0IGl0LlxuICBcImdyaWxsLW1lXCI6IFtcbiAgICBcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIixcbiAgICBcIkNPRElOR19HVUlERUxJTkVTXCIsXG4gICAgXCJSVUJSSUNfRklORElOR1NcIixcbiAgICBcIkZPUkNFRF9GSU5BTF9JTlNUUlVDVElPTlwiLFxuICBdLFxuICBjaV9maXg6IFtcbiAgICBcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIixcbiAgICBcIkZBSUxVUkVfQ0xBU1NJRklDQVRJT05cIixcbiAgICBcIlBSX0ZBSUxVUkVfQUNUSU9OU1wiLFxuICAgIFwiQ09ESU5HX0dVSURFTElORVNcIixcbiAgXSxcbiAgd29ya2Zsb3dfc2V0dXA6IFtcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIiwgXCJDT0RJTkdfR1VJREVMSU5FU1wiXSxcbiAgLy8gSXNzdWUgIzg0OiB0aGUgY29kaW5nIGd1aWRlbGluZXMgcmlkZSBpbiB0aGUgc3lzdGVtIHByb21wdCwgc28gb25seSB0aGVcbiAgLy8gdmVyYm9zaXR5IGJsb2NrIGlzIHN1YnN0aXR1dGVkIGludG8gdGhlIG1lcmdlLWNvbmZsaWN0IGJvZHkuXG4gIC8vIElzc3VlICMxMTE0OiBgSVNTVUVfQ09OVEVYVGAgY2FycmllcyB0aGUgb3JpZ2luYXRpbmcgaXNzdWVzIGJlaGluZCBib3RoXG4gIC8vIHNpZGVzIG9mIHRoZSBjb25mbGljdC4gSXQgaXMgb3B0aW9uYWwgcmF0aGVyIHRoYW4gcmVxdWlyZWQg4oCUIGEgY29uZmxpY3RcbiAgLy8gd2l0aCBub3RoaW5nIHRvIGNvbnN1bHQgc3Vic3RpdHV0ZXMgaXQgYXdheSwgYW5kIGFuIG9wZXJhdG9yIG92ZXJyaWRlXG4gIC8vIHdyaXR0ZW4gYmVmb3JlIHRoaXMgY2hhbmdlIGlzIHN0aWxsIGEgdmFsaWQgdGVtcGxhdGUuXG4gIC8vIElzc3VlICMxOTY1OiBgUkVQQUlSX0NPTlRFWFRgIGNhcnJpZXMgdGhlIHZlcmlmaWNhdGlvbiBmYWlsdXJlIGEgcmVwYWlyXG4gIC8vIHJ1biBhbnN3ZXJzLiBPcHRpb25hbCBmb3IgdGhlIHNhbWUgcmVhc29uIGFzIGBJU1NVRV9DT05URVhUYCDigJQgYW5cbiAgLy8gb3JkaW5hcnkgcmVzb2x1dGlvbiBzdWJzdGl0dXRlcyBpdCBhd2F5LCBhbmQgYW4gb3BlcmF0b3Igb3ZlcnJpZGUgd3JpdHRlblxuICAvLyBiZWZvcmUgdGhlIHJlcGFpciBydW5nIGV4aXN0ZWQgaXMgc3RpbGwgYSB2YWxpZCB0ZW1wbGF0ZS5cbiAgbWVyZ2VfY29uZmxpY3Q6IFtcIlZFUkJPU0lUWV9JTlNUUlVDVElPTlNcIiwgXCJJU1NVRV9DT05URVhUXCIsIFwiUkVQQUlSX0NPTlRFWFRcIl0sXG4gIC8vIElzc3VlICMyNDM5OiBgQVRUUklCVVRJT05fRk9PVEVSYCBpcyB0aGUgYXR0cmlidXRpb24tZm9vdGVyXG4gIC8vIHBsYWNlaG9sZGVyIHRoZSBmb3VyIGlkbGUtdGFzayB0ZW1wbGF0ZXMgYWx3YXlzIHN1cHBseSBhdCBmaWxlIHRpbWUuXG4gIC8vIElzc3VlICMzMDE0OiBgTExNX0dBVEVgIGNhcnJpZXMgdGhlIHdvcmtlcidzIGRldGVybWluaXN0aWMgTExNLXVzYWdlXG4gIC8vIHZlcmRpY3QgdGhhdCBnYXRlcyB0aGUgT1dBU1AgR2VuQUkgLyBMTE0gVG9wIDEwIHRheG9ub215LlxuICBzZWN1cml0eV9zY2FuOiBbXCJBVFRSSUJVVElPTl9GT09URVJcIiwgXCJMTE1fR0FURVwiLCBcIk9QRU5fSVNTVUVfVElUTEVTXCJdLFxuICAvLyBJc3N1ZSAjMjkxNjogYENPVkVSQUdFX0dBUFNgIGlzIHRoZSBwcmUtY29tcHV0ZWRcbiAgLy8gdW50ZXN0ZWQtcHVibGljLWZ1bmN0aW9uIGxpc3QgaW5qZWN0ZWQgYnkgdGhlIHRlc3QtYXVkaXQgdGVtcGxhdGUgYXRcbiAgLy8gc2NhbiB0aW1lLlxuICB0ZXN0X2F1ZGl0OiBbXCJBVFRSSUJVVElPTl9GT09URVJcIiwgXCJDT1ZFUkFHRV9HQVBTXCIsIFwiT1BFTl9JU1NVRV9USVRMRVNcIl0sXG4gIGJlc3RfcHJhY3RpY2VzOiBbXCJBVFRSSUJVVElPTl9GT09URVJcIiwgXCJPUEVOX0lTU1VFX1RJVExFU1wiXSxcbiAgLy8gSXNzdWUgIzI1Nzg6IGBDT1NUX0NBTkRJREFURVNgIGNhcnJpZXMgdGhlIGRldGVybWluaXN0aWMgY29zdCBhbmQgc3BlZWRcbiAgLy8gbGVhZHMgKGB3b3JrZmxvd19jb3N0X3NjYW5uZXIudHNgKSBmb3IgY2hlY2tzIDM34oCTNDEsIGluamVjdGVkIGF0IHNjYW5cbiAgLy8gdGltZTsgdGhlIGZpbGUtdGltZSB3cmFwcGVyIHJlbmRlcnMgaXQgYChub25lKWAuXG4gIGdpdGh1Yl9hY3Rpb25zX2F1ZGl0OiBbXG4gICAgXCJBVFRSSUJVVElPTl9GT09URVJcIixcbiAgICBcIkNPU1RfQ0FORElEQVRFU1wiLFxuICAgIFwiT1BFTl9JU1NVRV9USVRMRVNcIixcbiAgXSxcbiAgLy8gSXNzdWUgIzUzNjogdGhlIHN1cHBseS1jaGFpbiBzY2FucyBmaWxlIGZpbmRpbmdzIGxpa2UgdGhlIHJlc3Qgb2YgdGhlXG4gIC8vIGZhbWlseSwgc28gdGhleSB0YWtlIHRoZSBhbGwtb3Blbi1pc3N1ZXMgZGVkdXAgYmxvY2suIFRoZWlyIHByb21wdHMgY2FycnlcbiAgLy8gbm8gYXR0cmlidXRpb24gZm9vdGVyLCBzbyB0aGF0IHBsYWNlaG9sZGVyIGlzIG5vdCByZWdpc3RlcmVkIGZvciB0aGVtLlxuICBzdXBwbHlfY2hhaW5fcmVhZGluZXNzOiBbXCJPUEVOX0lTU1VFX1RJVExFU1wiXSxcbiAgc3VwcGx5X2NoYWluX2RldGVjdGlvbjogW1wiT1BFTl9JU1NVRV9USVRMRVNcIl0sXG4gIC8vIElzc3VlICMyOTA1OiBvcnBoYW4tZGVwcyBjYXJyaWVzIHRoZSBhdHRyaWJ1dGlvbiBmb290ZXIgbGlrZSB0aGUgb3RoZXJcbiAgLy8gaWRsZS10YXNrIHNjYW4gdGVtcGxhdGVzOyBvcHRpb25hbCBmb3IgY29uc2lzdGVuY3kgd2l0aCB0aGUgZmFtaWx5LlxuICBvcnBoYW5fZGVwczogW1wiQVRUUklCVVRJT05fRk9PVEVSXCIsIFwiT1BFTl9JU1NVRV9USVRMRVNcIl0sXG4gIC8vIElzc3VlICMzNTQ5OiBwcml2YXRlLXJlcG8tcmVmZXJlbmNlLWF1ZGl0IGNhcnJpZXMgdGhlIGF0dHJpYnV0aW9uIGZvb3RlclxuICAvLyBsaWtlIHRoZSBvdGhlciBpZGxlLXRhc2sgc2NhbiB0ZW1wbGF0ZXM7IG9wdGlvbmFsIGZvciBjb25zaXN0ZW5jeS5cbiAgcHJpdmF0ZV9yZXBvX3JlZmVyZW5jZV9hdWRpdDogW1wiQVRUUklCVVRJT05fRk9PVEVSXCIsIFwiT1BFTl9JU1NVRV9USVRMRVNcIl0sXG4gIC8vIElzc3VlICMzODA4OiBkb2N1bWVudGF0aW9uLWF1ZGl0IHdhcyBoYWxmLXJlZ2lzdGVyZWQg4oCUIGl0IGFwcGVhcmVkIGluXG4gIC8vIFJFUVVJUkVEX1BMQUNFSE9MREVSUyBvbmx5LCBzbyB0aGUgYHt7QVRUUklCVVRJT05fRk9PVEVSfX1gIGV2ZXJ5XG4gIC8vIHZlcnNpb24gb2YgaXRzIHByb21wdCBjYXJyaWVzLCBhbmQgd2hpY2hcbiAgLy8gYGRvY3VtZW50YXRpb25fYXVkaXRfdGVtcGxhdGUudHNgIHN1YnN0aXR1dGVzIGF0IGZpbGUgdGltZSwgd2FzIGFuXG4gIC8vIHVucmVnaXN0ZXJlZCBwbGFjZWhvbGRlciBhbmQgYGdldE9wdGlvbmFsUGxhY2Vob2xkZXJzYCBlcnJvcmVkIG9uIGl0LlxuICBkb2N1bWVudGF0aW9uX2F1ZGl0OiBbXCJBVFRSSUJVVElPTl9GT09URVJcIiwgXCJPUEVOX0lTU1VFX1RJVExFU1wiXSxcbiAgLy8gSXNzdWUgIzM2MDk6IGR1cGxpY2F0ZWQta25vd2xlZGdlIGNhcnJpZXMgdGhlIGF0dHJpYnV0aW9uIGZvb3RlciBsaWtlXG4gIC8vIHRoZSBvdGhlciBpZGxlLXRhc2sgc2NhbiB0ZW1wbGF0ZXM7IG9wdGlvbmFsIGZvciBjb25zaXN0ZW5jeS5cbiAgZHVwbGljYXRlZF9rbm93bGVkZ2U6IFtcIkFUVFJJQlVUSU9OX0ZPT1RFUlwiLCBcIk9QRU5fSVNTVUVfVElUTEVTXCJdLFxuICAvLyBJc3N1ZSAjMzgwNzogZG9jLWNvdmVyYWdlIGNhcnJpZXMgdGhlIGF0dHJpYnV0aW9uIGZvb3RlciBsaWtlIHRoZVxuICAvLyBvdGhlciBpZGxlLXRhc2sgc2NhbiB0ZW1wbGF0ZXM7IG9wdGlvbmFsIGZvciBjb25zaXN0ZW5jeS5cbiAgZG9jX2NvdmVyYWdlOiBbXCJBVFRSSUJVVElPTl9GT09URVJcIiwgXCJPUEVOX0lTU1VFX1RJVExFU1wiXSxcbiAgLy8gSXNzdWUgIzY2NDogcmV0cm8gY2FycmllcyB0aGUgYXR0cmlidXRpb24gZm9vdGVyIGxpa2UgdGhlIG90aGVyXG4gIC8vIGlkbGUtdGFzayBzY2FuIHRlbXBsYXRlczsgb3B0aW9uYWwgZm9yIGNvbnNpc3RlbmN5LlxuICByZXRybzogW1wiQVRUUklCVVRJT05fRk9PVEVSXCIsIFwiT1BFTl9JU1NVRV9USVRMRVNcIl0sXG4gIC8vIElzc3VlICM1MzY6IGRlYWQtY29kZSwgZGVwcmVjYXRlZC1BUEkgYW5kIGZvcm1hdC1kcmlmdCBjYXJyeSB0aGVcbiAgLy8gYXR0cmlidXRpb24gZm9vdGVyIGxpa2UgdGhlIHJlc3Qgb2YgdGhlIGZhbWlseSwgYW5kIHRha2UgdGhlXG4gIC8vIGFsbC1vcGVuLWlzc3VlcyBkZWR1cCBibG9jayBvbiB0aGUgc2FtZSBvcHRpb25hbCB0ZXJtcy5cbiAgZGVhZF9jb2RlOiBbXCJBVFRSSUJVVElPTl9GT09URVJcIiwgXCJPUEVOX0lTU1VFX1RJVExFU1wiXSxcbiAgZGVwcmVjYXRlZF9hcGk6IFtcIkFUVFJJQlVUSU9OX0ZPT1RFUlwiLCBcIk9QRU5fSVNTVUVfVElUTEVTXCJdLFxuICBmb3JtYXRfZHJpZnQ6IFtcIkFUVFJJQlVUSU9OX0ZPT1RFUlwiLCBcIk9QRU5fSVNTVUVfVElUTEVTXCJdLFxuICBjb2RpbmdfZ3VpZGVsaW5lczogW10sXG59O1xuXG4vKipcbiAqIEdldCB0aGUgcHJvbXB0cyBkaXJlY3RvcnkgcGF0aC5cbiAqXG4gKiBVc2VzIFBST01QVFNfRElSIGVudmlyb25tZW50IHZhcmlhYmxlIGlmIHNldCwgb3RoZXJ3aXNlIGRlcml2ZXMgZnJvbVxuICogdGhlIHdvcmtlciBkaXJlY3Rvcnkgc3RydWN0dXJlLlxuICpcbiAqIElzc3VlICM5Njg6IGBlbnZgIGlzIHRoZSBpbmplY3RlZCBsb29rdXAgc2VhbS4gQSB0ZXN0IHRoYXQgd2FudGVkIHRvIHNlZVxuICogd2hhdCBhIGBQUk9NUFRTX0RJUmAgb3IgYFZJQkVfQkFTRV9ESVJgIG92ZXJyaWRlIHJlc29sdmVzIHRvIGhhZCB0byB3cml0ZVxuICogdGhvc2UgdmFyaWFibGVzIGludG8gdGhlIHByb2Nlc3MsIHdoaWNoIHJhY2VzIGV2ZXJ5IG90aGVyIHdvcmtlciB1bmRlclxuICogYGRlbm8gdGVzdCAtLXBhcmFsbGVsYCDigJQgYW5kLCB3b3JzZSwgbWFkZSBgdGVzdHMvc3VwcG9ydC9yZXBvX3Byb21wdHMudHNgXG4gKiBkZWxldGUgdGhlbSBhZ2FpbiBhdCBtb2R1bGUgc2NvcGUgZm9yIHRoZSB0aGlydHktb2RkIHN1aXRlcyB0aGF0IGxvYWQgYVxuICogcmVhbCB0ZW1wbGF0ZS4gSGFuZGluZyB0aGUgbG9va3VwIGluIGFzIGEgcGFyYW1ldGVyIHJlbW92ZXMgYm90aC5cbiAqXG4gKiBAcGFyYW0gd29ya2VyRGlyIC0gT3B0aW9uYWwgd29ya2VyIGRpcmVjdG9yeSBwYXRoIGZvciBkZXJpdmluZyBwcm9tcHRzIGRpclxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cDsgZGVmYXVsdHMgdG8gdGhlIHJlYWwgcHJvY2VzcyBlbnZpcm9ubWVudFxuICogQHJldHVybnMgUGF0aCB0byB0aGUgcHJvbXB0cyBkaXJlY3RvcnlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFByb21wdHNEaXIoXG4gIHdvcmtlckRpcj86IHN0cmluZyxcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgZW52RGlyID0gZW52KFwiUFJPTVBUU19ESVJcIik7XG4gIGlmIChlbnZEaXIpIHtcbiAgICByZXR1cm4gZW52RGlyO1xuICB9XG5cbiAgaWYgKHdvcmtlckRpcikge1xuICAgIHJldHVybiBgJHt3b3JrZXJEaXJ9Ly4uL3Byb21wdHNgO1xuICB9XG5cbiAgLy8gVGhlIGNoZWNrb3V0IHRoZSBsYXVuY2hlciBuYW1lZCAoSXNzdWUgIzQzMDIpOiBpbiBjb250YWluZXIgbW9kZSB0aGVcbiAgLy8gZHJpdmVyIHJ1bnMgZnJvbSBhIFZNLWxvY2FsIHN0YWdlZCBjb3B5IG9mIHdvcmtlci9kZW5vLCBzbyBhXG4gIC8vIG1vZHVsZS1yZWxhdGl2ZSBwYXRoIHdvdWxkIGxvb2sgZm9yIHByb21wdHMvIHVuZGVyIHRoZSBzdGFnZWQgY29weSDigJRcbiAgLy8gb2JzZXJ2ZWQgbGl2ZSBhcyBcIlByb21wdCAncGxhbm5pbmcnIG5vdCBmb3VuZCBpblxuICAvLyB+Ly53b3JrZXItc3JjL3dvcmtlci9kZW5vL2xpYi8uLi8uLi8uLi9wcm9tcHRzXCIuXG4gIGNvbnN0IGJhc2VEaXIgPSBlbnYoXCJWSUJFX0JBU0VfRElSXCIpO1xuICBpZiAoYmFzZURpcikge1xuICAgIHJldHVybiBgJHtiYXNlRGlyfS9wcm9tcHRzYDtcbiAgfVxuXG4gIC8vIERlZmF1bHQ6IHJlbGF0aXZlIHRvIHRoZSBkZW5vIHdvcmtlciBtb2R1bGUgKHdvcmtlci9kZW5vL2xpYi8pXG4gIGNvbnN0IG1vZHVsZURpciA9IG5ldyBVUkwoXCIuXCIsIGltcG9ydC5tZXRhLnVybCkucGF0aG5hbWU7XG4gIHJldHVybiBgJHttb2R1bGVEaXJ9Li4vLi4vLi4vcHJvbXB0c2A7XG59XG5cbi8qKiBGaWxlbmFtZSBldmVyeSBwcm9tcHQgdHlwZSdzIHRlbXBsYXRlIGxpdmVzIHVuZGVyIChJc3N1ZSAjODQ0KS4gKi9cbmV4cG9ydCBjb25zdCBQUk9NUFRfRklMRU5BTUUgPSBcInByb21wdC5tZFwiO1xuXG4vKipcbiAqIFRoZSBmaWxlIGEgYnVpbHQtaW4gcHJvbXB0IHR5cGUgaXMgbG9hZGVkIGZyb20gKElzc3VlICM4NDkpLlxuICpcbiAqIE5hbWVkIHNlcGFyYXRlbHkgZnJvbSB7QGxpbmsgbG9hZFByb21wdH0gYmVjYXVzZSB0aGUgb3ZlcnJpZGUgcmVzb2x2ZXJcbiAqIHJlY29yZHMgKndoaWNoKiBmaWxlIGEgcGhhc2UgdXNlZCwgYW5kIGEgcnVuJ3MgdHJhY2VhYmlsaXR5IHJlY29yZCBtdXN0IG5hbWVcbiAqIHRoZSBidWlsdC1pbiBwYXRoIGFzIHByZWNpc2VseSBhcyBpdCBuYW1lcyBhbiBvcGVyYXRvcidzLlxuICpcbiAqIEBwYXJhbSBwcm9tcHROYW1lIC0gTmFtZSBvZiB0aGUgcHJvbXB0IChtYXRjaGVzIHN1YmRpcmVjdG9yeSBpbiBwcm9tcHRzLylcbiAqIEBwYXJhbSBwcm9tcHRzRGlyIC0gUGF0aCB0byB0aGUgcHJvbXB0cyBkaXJlY3RvcnlcbiAqIEByZXR1cm5zIEFic29sdXRlIG9yIGNhbGxlci1yZWxhdGl2ZSBwYXRoIG9mIHRoZSB0ZW1wbGF0ZSBmaWxlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9tcHRUZW1wbGF0ZVBhdGgoXG4gIHByb21wdE5hbWU6IHN0cmluZyxcbiAgcHJvbXB0c0Rpcj86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcm9tcHRzRGlyID8/IGdldFByb21wdHNEaXIoKX0vJHtwcm9tcHROYW1lfS8ke1BST01QVF9GSUxFTkFNRX1gO1xufVxuXG4vKipcbiAqIExvYWQgYSBwcm9tcHQgdGVtcGxhdGUgYnkgbmFtZS5cbiAqXG4gKiBAcGFyYW0gcHJvbXB0TmFtZSAtIE5hbWUgb2YgdGhlIHByb21wdCAobWF0Y2hlcyBzdWJkaXJlY3RvcnkgaW4gcHJvbXB0cy8pXG4gKiBAcGFyYW0gcHJvbXB0c0RpciAtIFBhdGggdG8gdGhlIHByb21wdHMgZGlyZWN0b3J5XG4gKiBAcmV0dXJucyBUaGUgcHJvbXB0IHRlbXBsYXRlIGNvbnRlbnRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRQcm9tcHQoXG4gIHByb21wdE5hbWU6IHN0cmluZyxcbiAgcHJvbXB0c0Rpcj86IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgY29uc3QgdGVtcGxhdGVGaWxlID0gcHJvbXB0VGVtcGxhdGVQYXRoKHByb21wdE5hbWUsIHByb21wdHNEaXIpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHRlbXBsYXRlRmlsZSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBjb250ZW50IH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgUHJvbXB0ICcke3Byb21wdE5hbWV9JyBub3QgZm91bmQgYXQgJHt0ZW1wbGF0ZUZpbGV9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFJlY29yZCB3aGljaCBwcm9tcHQgcmV2aXNpb24gYSBydW4gdXNlZCwgZm9yIHRyYWNlYWJpbGl0eSAoSXNzdWUgIzIxMixcbiAqICM4NDQpLlxuICpcbiAqIFZlcnNpb25lZCBmaWxlbmFtZXMgYXJlIGdvbmUsIHNvIHRoZSBjaGVja291dCdzIGdpdCBjb21taXQgaXMgd2hhdFxuICogaWRlbnRpZmllcyB0aGUgdGVtcGxhdGUgdGV4dCBhIHJ1biBzYXcuIEFwcGVuZHMgYSB0aW1lc3RhbXBlZCBlbnRyeSB0byB0aGVcbiAqIHNwZWNpZmllZCBsb2cgZmlsZS5cbiAqXG4gKiBAcGFyYW0gbG9nRmlsZSAtIFBhdGggdG8gdGhlIHByb21wdCByZXZpc2lvbiBsb2cgZmlsZVxuICogQHBhcmFtIGNvbW1pdCAtIFNob3J0IGNvbW1pdCBoYXNoIG9mIHRoZSBjaGVja291dCB0aGUgdGVtcGxhdGVzIGNhbWUgZnJvbVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVjb3JkUHJvbXB0Q29tbWl0KFxuICBsb2dGaWxlOiBzdHJpbmcsXG4gIGNvbW1pdDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1xcLlxcZHszfVokLywgXCJaXCIpO1xuICBjb25zdCBlbnRyeSA9IGAke3RpbWVzdGFtcH0gcHJvbXB0c19jb21taXQ9JHtjb21taXR9XFxuYDtcblxuICB0cnkge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShsb2dGaWxlLCBlbnRyeSwgeyBhcHBlbmQ6IHRydWUgfSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byByZWNvcmQgcHJvbXB0IGNvbW1pdDogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBzaG9ydCBjb21taXQgaGFzaCBvZiBhIGNoZWNrb3V0IChJc3N1ZSAjODQ0KS5cbiAqXG4gKiBUaGlzIGlzIHRoZSByZXBsYWNlbWVudCBmb3IgdGhlIHBlci10ZW1wbGF0ZSB2ZXJzaW9uIG51bWJlcjogaXQgaWRlbnRpZmllc1xuICogZXhhY3RseSB3aGljaCBwcm9tcHQgdGV4dCBhIHJ1biBsb2FkZWQuIEZhaWxzIGxvdWQgcmF0aGVyIHRoYW4gcmV0dXJuaW5nIGFcbiAqIHBsYWNlaG9sZGVyLCBzbyBhIGJyb2tlbiBjaGVja291dCBpcyBuZXZlciBsb2dnZWQgYXMgYSBjbGVhbiByZXZpc2lvbi5cbiAqXG4gKiBAcGFyYW0gcmVwb0RpciAtIFBhdGggaW5zaWRlIHRoZSBjaGVja291dC4gRGVmYXVsdHMgdG8gdGhlIHByb21wdHNcbiAqICAgZGlyZWN0b3J5LCB3aGljaCBpcyB3aGF0IGBnaXRgIGlzIGFza2VkIGFib3V0LlxuICogQHJldHVybnMgVGhlIHNob3J0IGNvbW1pdCBoYXNoIChlLmcuIFwiMjMyNmIwNFwiKVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UHJvbXB0c0NvbW1pdChcbiAgcmVwb0Rpcj86IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgY29uc3QgZGlyID0gcmVwb0RpciA/PyBnZXRQcm9tcHRzRGlyKCk7XG4gIHRyeSB7XG4gICAgLy8gSXNzdWUgIzEyMTQ6IGV2ZXJ5IGdpdCBzcGF3biBnb2VzIHRocm91Z2ggdGhlIHRpbWVvdXQgY2hva2Vwb2ludC5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wiLUNcIiwgZGlyLCBcInJldi1wYXJzZVwiLCBcIi0tc2hvcnRcIiwgXCJIRUFEXCJdLFxuICAgICk7XG4gICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgRmFpbGVkIHRvIHJlc29sdmUgcHJvbXB0cyBjb21taXQgaW4gJHtkaXJ9OiAke3Jlc3VsdC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBvdXRwdXQgPSByZXN1bHQudmFsdWU7XG4gICAgaWYgKG91dHB1dC5jb2RlICE9PSAwKSB7XG4gICAgICBjb25zdCBzdGRlcnIgPSBvdXRwdXQuc3RkZXJyLnRyaW0oKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgRmFpbGVkIHRvIHJlc29sdmUgcHJvbXB0cyBjb21taXQgaW4gJHtkaXJ9OiAke3N0ZGVycn1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgY29tbWl0ID0gb3V0cHV0LnN0ZG91dC50cmltKCk7XG4gICAgaWYgKCFjb21taXQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihgRW1wdHkgY29tbWl0IGhhc2ggcmVzb2x2ZWQgaW4gJHtkaXJ9YCksXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGNvbW1pdCB9O1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvIHJlc29sdmUgcHJvbXB0cyBjb21taXQgaW4gJHtkaXJ9OiAke1xuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgcmVxdWlyZWQgcGxhY2Vob2xkZXJzIGZvciBhIHRlbXBsYXRlIHR5cGUuXG4gKlxuICogQHBhcmFtIHRlbXBsYXRlVHlwZSAtIE5hbWUgb2YgdGhlIHRlbXBsYXRlIHR5cGVcbiAqIEByZXR1cm5zIEFycmF5IG9mIHBsYWNlaG9sZGVyIG5hbWVzLCBvciBlcnJvciBmb3IgdW5rbm93biB0eXBlc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVxdWlyZWRQbGFjZWhvbGRlcnMoXG4gIHRlbXBsYXRlVHlwZTogc3RyaW5nLFxuKTogUmVzdWx0PHJlYWRvbmx5IHN0cmluZ1tdPiB7XG4gIGNvbnN0IHBsYWNlaG9sZGVycyA9IFJFUVVJUkVEX1BMQUNFSE9MREVSU1t0ZW1wbGF0ZVR5cGVdO1xuICBpZiAocGxhY2Vob2xkZXJzID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgVW5rbm93biB0ZW1wbGF0ZSB0eXBlICcke3RlbXBsYXRlVHlwZX0nYCksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHBsYWNlaG9sZGVycyB9O1xufVxuXG4vKipcbiAqIEdldCB0aGUgb3B0aW9uYWwgcGxhY2Vob2xkZXJzIGZvciBhIHRlbXBsYXRlIHR5cGUgKElzc3VlICMxMzMyKS5cbiAqXG4gKiBPcHRpb25hbCBwbGFjZWhvbGRlcnMgYXJlIHZhbGlkIGluIHRlbXBsYXRlcyBidXQgbm90IHJlcXVpcmVkLiBUaGV5IGFyZVxuICogdXNlZCBmb3IgZmVhdHVyZXMgbGlrZSB2ZXJib3NpdHkgaW5zdHJ1Y3Rpb25zIHRoYXQgbWF5IG5vdCBiZSBwcmVzZW50XG4gKiBpbiBvbGRlciB0ZW1wbGF0ZSB2ZXJzaW9ucy5cbiAqXG4gKiBAcGFyYW0gdGVtcGxhdGVUeXBlIC0gTmFtZSBvZiB0aGUgdGVtcGxhdGUgdHlwZVxuICogQHJldHVybnMgQXJyYXkgb2Ygb3B0aW9uYWwgcGxhY2Vob2xkZXIgbmFtZXMsIG9yIGVycm9yIGZvciB1bmtub3duIHR5cGVzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRPcHRpb25hbFBsYWNlaG9sZGVycyhcbiAgdGVtcGxhdGVUeXBlOiBzdHJpbmcsXG4pOiBSZXN1bHQ8cmVhZG9ubHkgc3RyaW5nW10+IHtcbiAgY29uc3QgcGxhY2Vob2xkZXJzID0gT1BUSU9OQUxfUExBQ0VIT0xERVJTW3RlbXBsYXRlVHlwZV07XG4gIGlmIChwbGFjZWhvbGRlcnMgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBVbmtub3duIHRlbXBsYXRlIHR5cGUgJyR7dGVtcGxhdGVUeXBlfSdgKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGxhY2Vob2xkZXJzIH07XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhhdCBhIHRlbXBsYXRlIGNvbnRhaW5zIGFsbCByZXF1aXJlZCBwbGFjZWhvbGRlcnMuXG4gKlxuICogQHBhcmFtIHRlbXBsYXRlVHlwZSAtIE5hbWUgb2YgdGhlIHRlbXBsYXRlIHR5cGVcbiAqIEBwYXJhbSB0ZW1wbGF0ZUNvbnRlbnQgLSBUaGUgbG9hZGVkIHRlbXBsYXRlIGNvbnRlbnQgdG8gdmFsaWRhdGVcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIG1pc3NpbmcgcGxhY2Vob2xkZXJzIGlmIGFueVxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVQcm9tcHRUZW1wbGF0ZShcbiAgdGVtcGxhdGVUeXBlOiBzdHJpbmcsXG4gIHRlbXBsYXRlQ29udGVudDogc3RyaW5nLFxuKTogUmVzdWx0PHN0cmluZ1tdPiB7XG4gIGNvbnN0IHBsYWNlaG9sZGVyc1Jlc3VsdCA9IGdldFJlcXVpcmVkUGxhY2Vob2xkZXJzKHRlbXBsYXRlVHlwZSk7XG4gIGlmICghcGxhY2Vob2xkZXJzUmVzdWx0Lm9rKSB7XG4gICAgcmV0dXJuIHBsYWNlaG9sZGVyc1Jlc3VsdCBhcyBSZXN1bHQ8c3RyaW5nW10+O1xuICB9XG5cbiAgY29uc3QgcmVxdWlyZWQgPSBwbGFjZWhvbGRlcnNSZXN1bHQudmFsdWU7XG4gIGlmIChyZXF1aXJlZC5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IFtdIH07XG4gIH1cblxuICBjb25zdCBtaXNzaW5nOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBsYWNlaG9sZGVyIG9mIHJlcXVpcmVkKSB7XG4gICAgaWYgKCF0ZW1wbGF0ZUNvbnRlbnQuaW5jbHVkZXMoYHt7JHtwbGFjZWhvbGRlcn19fWApKSB7XG4gICAgICBtaXNzaW5nLnB1c2gocGxhY2Vob2xkZXIpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChtaXNzaW5nLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFRlbXBsYXRlICcke3RlbXBsYXRlVHlwZX0nIGlzIG1pc3NpbmcgcmVxdWlyZWQgcGxhY2Vob2xkZXJzOiAke1xuICAgICAgICAgIG1pc3Npbmcuam9pbihcIiwgXCIpXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBbXSB9O1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGFsbCBwcm9tcHQgdGVtcGxhdGVzIGhhdmUgcmVxdWlyZWQgcGxhY2Vob2xkZXJzLlxuICpcbiAqIEBwYXJhbSBwcm9tcHRzRGlyIC0gUGF0aCB0byB0aGUgcHJvbXB0cyBkaXJlY3RvcnlcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIGxpc3Qgb2YgZXJyb3JzIGlmIGFueSB0ZW1wbGF0ZXMgZmFpbCB2YWxpZGF0aW9uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2YWxpZGF0ZUFsbFByb21wdFRlbXBsYXRlcyhcbiAgcHJvbXB0c0Rpcj86IHN0cmluZyxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZ1tdPj4ge1xuICBjb25zdCB0ZW1wbGF0ZVR5cGVzID0gW1xuICAgIFwiY29kaW5nX2d1aWRlbGluZXNcIixcbiAgICBcImlzc3VlXCIsXG4gICAgXCJwbGFubmluZ1wiLFxuICAgIFwicXVlc3Rpb25cIixcbiAgICBcInByX2ZlZWRiYWNrXCIsXG4gICAgXCJzcGVsbGluZ19maXhcIixcbiAgICBcIndvcmtmbG93X3NldHVwXCIsXG4gICAgXCJzZWN1cml0eV9zY2FuXCIsXG4gIF07XG4gIGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHRlbXBsYXRlVHlwZSBvZiB0ZW1wbGF0ZVR5cGVzKSB7XG4gICAgY29uc3QgbG9hZFJlc3VsdCA9IGF3YWl0IGxvYWRQcm9tcHQodGVtcGxhdGVUeXBlLCBwcm9tcHRzRGlyKTtcbiAgICBpZiAoIWxvYWRSZXN1bHQub2spIHtcbiAgICAgIGVycm9ycy5wdXNoKFxuICAgICAgICBgRmFpbGVkIHRvIGxvYWQgdGVtcGxhdGUgJyR7dGVtcGxhdGVUeXBlfSc6ICR7bG9hZFJlc3VsdC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgdmFsaWRhdGVSZXN1bHQgPSB2YWxpZGF0ZVByb21wdFRlbXBsYXRlKFxuICAgICAgdGVtcGxhdGVUeXBlLFxuICAgICAgbG9hZFJlc3VsdC52YWx1ZSxcbiAgICApO1xuICAgIGlmICghdmFsaWRhdGVSZXN1bHQub2spIHtcbiAgICAgIGVycm9ycy5wdXNoKHZhbGlkYXRlUmVzdWx0LmVycm9yLm1lc3NhZ2UpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChlcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG5ldyBFcnJvcihlcnJvcnMuam9pbihcIlxcblwiKSkgfTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogW10gfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FHRCxTQUF5QixnQkFBZ0IsUUFBUSxrQkFBa0I7QUFDbkUsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBRWpEOztDQUVDLEdBQ0QsdUVBQXVFO0FBQ3ZFLDhFQUE4RTtBQUM5RSw4RUFBOEU7QUFDOUUsK0VBQStFO0FBQy9FLGlFQUFpRTtBQUNqRSw4RUFBOEU7QUFDOUUsa0RBQWtEO0FBQ2xE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
// denoCacheMetadata=9853945345309923114,14110285075738267884