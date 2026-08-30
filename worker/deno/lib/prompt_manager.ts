/**
 * Prompt versioning and template management (Issue #197, #914).
 *
 * Manages versioned prompt templates stored in the prompts/ directory.
 * Each prompt is a subdirectory containing versioned markdown files
 * (v1.md, v2.md, etc.). This enables rapid iteration, easy rollback,
 * and traceability of which prompt version was used for each issue.
 *
 * Migrated from worker/shared/prompt_manager.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/**
 * Known template types and their required placeholders.
 */
// Issue #3813: `CODING_GUIDELINES` is no longer required by any of the
// builder-hosted types. Since #1262 the guidelines ride in the system prompt,
// so `prompt_builder.ts` substituted the placeholder with an empty string and
// every host rendered a heading with nothing under it. The placeholder is gone
// from issue v31, planning v21, question v9, pr_feedback v12, spelling_fix v6,
// workflow_setup v6 and ci_fix v11; it stays registered as *optional* so the
// immutability tests pinned to the earlier versions still validate.
const REQUIRED_PLACEHOLDERS: Record<string, readonly string[]> = {
  issue: ["ISSUE_NUMBER", "QUALITY_INSTRUCTIONS"],
  pr_feedback: ["PR_NUMBER", "QUALITY_INSTRUCTIONS"],
  spelling_fix: ["PR_NUMBER", "QUALITY_INSTRUCTIONS"],
  planning: ["REPO", "ISSUE_NUMBER", "PLANNING_LABEL"],
  // Issue #2652: the second turn of the two-stage planning flow. It
  // adversarially critiques the draft plan, revises once, then publishes the
  // final sub-issues. The coding guidelines ride in the system prompt (as for
  // `planning`), so they are not a required body placeholder here.
  planning_critique: ["REPO", "ISSUE_NUMBER", "PLANNING_LABEL"],
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
    "BOUNDARY_INTEGRITY_INSTRUCTION",
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
    "BOUNDARY_INTEGRITY_INSTRUCTION",
  ],
  question: [
    "REPO",
    "ISSUE_NUMBER",
    "QUESTION_LABEL",
  ],
  ci_fix: ["PR_NUMBER", "QUALITY_INSTRUCTIONS"],
  // Issue #84: the conflict-resolution pass. The template names the PR, the
  // base branch being merged in, and the conflicted paths the worker found
  // after starting the merge — all three are load-bearing, so all three are
  // required from v1.
  merge_conflict: [
    "PR_NUMBER",
    "QUALITY_INSTRUCTIONS",
    "BASE_BRANCH",
    "CONFLICTED_FILES",
  ],
  workflow_setup: [
    "REPO",
    "LANGUAGES",
    "MISSING_WORKFLOWS",
    "DEFAULT_BRANCH",
    "EXISTING_WORKFLOWS",
  ],
  security_scan: [
    // Issue #2135 (v6): `{{REPO_FULL_NAME}}` was retired — the worker's
    // cwd already points at the cloned repo, so `gh issue create`
    // operates on the right one without explicit substitution.
    // Issue #2159 (v8): `{{LANGUAGE_HINTS}}` was retired — the scanner
    // agent detects dominant languages at scan time as step zero of the
    // Phase 1 inventory.
    // Issue #2439 (v11): `{{ATTRIBUTION_FOOTER}}` was added as an
    // *optional* placeholder — see OPTIONAL_PLACEHOLDERS below. Keeping
    // it optional preserves backwards compatibility with the
    // immutability tests pinned to older versions.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  best_practices: [
    // Issue #2148: the best-practices template substitutes the picked
    // bucket and the two dedup lists at file time.
    // Issue #2439 (v4): `{{ATTRIBUTION_FOOTER}}` was added as an
    // optional placeholder — see OPTIONAL_PLACEHOLDERS below.
    "BUCKET",
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  test_audit: [
    // Issue #2250 (parent #2214): language-agnostic WHAT-vs-HOW test
    // quality scan. Same two dedup lists as best-practices and
    // security-scan; no bucket — the scan is language-agnostic.
    // Issue #2439 (v2): `{{ATTRIBUTION_FOOTER}}` was added as an
    // optional placeholder — see OPTIONAL_PLACEHOLDERS below.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  github_actions_audit: [
    // Issue #2255 (parent #2243): single-bucket GitHub Actions audit.
    // Same two dedup lists as the other scans, plus the two catalogue
    // tables rendered from `github_actions_catalogue.ts` at file time.
    // Issue #2439 (v7): `{{ATTRIBUTION_FOOTER}}` was added as an
    // optional placeholder — see OPTIONAL_PLACEHOLDERS below.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
    "ACTIONS_CATALOGUE_TABLE",
    "EOL_RUNTIMES_TABLE",
  ],
  supply_chain_readiness: [
    // Issue #2397 (parent #2396): repo-posture audit for surviving and
    // responding to supply-chain compromise. Same two dedup lists as the
    // other scan templates — the scan is ecosystem-aware but has no
    // bucket parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  supply_chain_detection: [
    // Issue #2443 (parent #2406): active malicious-dependency detection.
    // Same two dedup lists as the other scan templates — the scan is
    // ecosystem-aware, single-scope, and has no bucket parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  orphan_deps: [
    // Issue #2905 (parent #2902): phased orphan / unmaintained dependency
    // detection + maintained-replacement suggestion. Same two dedup lists
    // as the other scan templates — the scan is ecosystem-aware,
    // single-scope, and has no bucket parameter. Unlike the static-only
    // scans, this prompt is the one sanctioned exception that may read
    // registry / network metadata within a fixed allow-list.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  documentation_audit: [
    // Issue #3319 (template #13): prose / Markdown documentation
    // reconciliation audit — fold PR-summary learnings into the main
    // docs, prune stale content. Same two dedup lists as the other scan
    // templates — the audit is language-agnostic and has no bucket
    // parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  private_repo_reference_audit: [
    // Issue #3549 (template #16): public-repo private-reference audit —
    // detect direct references to a private stSoftwareAU repo. Only runs
    // against public repos. Same two dedup lists as the other scan
    // templates — language-agnostic, no bucket parameter.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  doc_coverage: [
    // Issue #3807 (template #6): module-doc & README coverage scan. The
    // type was unregistered until v6, so `validatePromptTemplate`
    // refused the surface and nothing guarded its two load-bearing
    // dedup placeholders. Every shipped version (v1 onwards) carries
    // both, so registering them is backwards compatible.
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  duplicated_knowledge: [
    // Issue #3609 (template #17): copy-paste blocks that encode the same
    // knowledge and should call one existing helper. Same two dedup lists
    // as the other scan templates — language-agnostic, no bucket — plus
    // the deterministic duplicate-block pre-pass, which is required from
    // v1 (unlike test-audit's COVERAGE_GAPS, added in a later version).
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
    "DUPLICATE_BLOCKS",
  ],
  // Issue #536 (parent #523): dead-code, deprecated-API and format-drift file
  // findings like the other scans but were unregistered, so
  // `validatePromptTemplate` refused the surface outright and nothing guarded
  // their two dedup placeholders. Every shipped version (v1 onwards) of all
  // three carries both, so registering them is backwards compatible — the
  // `doc_coverage` precedent from #3807.
  dead_code: [
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  deprecated_api: [
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  format_drift: [
    "SUPPRESSED_IDS",
    "KNOWN_OPEN_FINDING_IDS",
  ],
  coding_guidelines: [],
};

/**
 * Optional placeholders that are valid but not required (Issue #1332).
 *
 * These placeholders may appear in newer template versions but are not
 * mandatory. Templates without them still pass validation (backward
 * compatible). Used for discoverability and documentation.
 *
 * Issue #3813: `CODING_GUIDELINES` moved here from REQUIRED_PLACEHOLDERS —
 * versions up to and including issue v30 carry it, later ones do not.
 *
 * Issue #536 (parent #523): `OPEN_ISSUE_TITLES` — the all-open-issues dedup
 * block — is registered here for every scan type that files findings.
 * `{{KNOWN_OPEN_FINDING_IDS}}` stays the deterministic first line of dedup;
 * the title list is what lets the scanner skip a semantic duplicate already
 * open under another label. It is *optional* like `ATTRIBUTION_FOOTER`
 * (#2439) and `CODING_GUIDELINES` (#3813): REQUIRED_PLACEHOLDERS is enforced
 * against every shipped version of a type, so requiring it would retroactively
 * invalidate the ~14 prompt histories the immutability tests pin.
 */
export const OPTIONAL_PLACEHOLDERS: Record<string, readonly string[]> = {
  issue: ["VERBOSITY_INSTRUCTIONS", "CODING_GUIDELINES"],
  pr_feedback: ["VERBOSITY_INSTRUCTIONS", "CODING_GUIDELINES"],
  spelling_fix: ["VERBOSITY_INSTRUCTIONS", "CODING_GUIDELINES"],
  planning: ["VERBOSITY_INSTRUCTIONS", "CODING_GUIDELINES"],
  planning_critique: ["VERBOSITY_INSTRUCTIONS", "MILESTONE_INSTRUCTIONS"],
  // Issue #4110: the coding guidelines ride in the system prompt for both
  // Quorum prompts (as for `planning`), so only the verbosity block is
  // substituted into the body.
  quorum: ["VERBOSITY_INSTRUCTIONS"],
  quorum_judge: ["VERBOSITY_INSTRUCTIONS"],
  question: ["VERBOSITY_INSTRUCTIONS", "CODING_GUIDELINES"],
  ci_fix: [
    "VERBOSITY_INSTRUCTIONS",
    "FAILURE_CLASSIFICATION",
    "PR_FAILURE_ACTIONS",
    "CODING_GUIDELINES",
  ],
  workflow_setup: ["VERBOSITY_INSTRUCTIONS", "CODING_GUIDELINES"],
  // Issue #84: the coding guidelines ride in the system prompt, so only the
  // verbosity block is substituted into the merge-conflict body.
  merge_conflict: ["VERBOSITY_INSTRUCTIONS"],
  // Issue #2439: `ATTRIBUTION_FOOTER` is the attribution-footer
  // placeholder added in the v11 / v4 / v2 / v7 prompt bumps. It is
  // *optional* so the immutability tests pinned to the previous
  // versions (which do not carry the placeholder) continue to pass.
  // The four idle-task templates always supply it at file time.
  // Issue #3014 (v18): `LLM_GATE` carries the worker's deterministic
  // LLM-usage verdict that gates the OWASP GenAI / LLM Top 10 taxonomy.
  // Optional so the immutability tests pinned to v1–v17 (which do not
  // carry the placeholder) continue to pass.
  security_scan: ["ATTRIBUTION_FOOTER", "LLM_GATE", "OPEN_ISSUE_TITLES"],
  // Issue #2916 (v4): `COVERAGE_GAPS` is the pre-computed
  // untested-public-function list injected by the test-audit template at
  // scan time. Optional so the immutability tests pinned to v1–v3 (which
  // do not carry the placeholder) continue to pass.
  test_audit: ["ATTRIBUTION_FOOTER", "COVERAGE_GAPS", "OPEN_ISSUE_TITLES"],
  best_practices: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  github_actions_audit: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  // Issue #536: the supply-chain scans file findings like the rest of the
  // family, so they take the all-open-issues dedup block. Their prompts carry
  // no attribution footer, so that placeholder is not registered for them.
  supply_chain_readiness: ["OPEN_ISSUE_TITLES"],
  supply_chain_detection: ["OPEN_ISSUE_TITLES"],
  // Issue #2905: orphan-deps carries the attribution footer like the other
  // idle-task scan templates; optional for consistency with the family.
  orphan_deps: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  // Issue #3549: private-repo-reference-audit carries the attribution footer
  // like the other idle-task scan templates; optional for consistency.
  private_repo_reference_audit: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  // Issue #3808: documentation-audit was half-registered — it appeared in
  // REQUIRED_PLACEHOLDERS only, so the `{{ATTRIBUTION_FOOTER}}` every
  // version of its prompt carries, and which
  // `documentation_audit_template.ts` substitutes at file time, was an
  // unregistered placeholder and `getOptionalPlaceholders` errored on it.
  documentation_audit: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  // Issue #3609: duplicated-knowledge carries the attribution footer like
  // the other idle-task scan templates; optional for consistency.
  duplicated_knowledge: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  // Issue #3807: doc-coverage carries the attribution footer like the
  // other idle-task scan templates; optional for consistency.
  doc_coverage: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  // Issue #536: dead-code, deprecated-API and format-drift carry the
  // attribution footer like the rest of the family, and take the
  // all-open-issues dedup block on the same optional terms.
  dead_code: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  deprecated_api: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  format_drift: ["ATTRIBUTION_FOOTER", "OPEN_ISSUE_TITLES"],
  coding_guidelines: [],
};

/**
 * Get the prompts directory path.
 *
 * Uses PROMPTS_DIR environment variable if set, otherwise derives from
 * the worker directory structure.
 *
 * @param workerDir - Optional worker directory path for deriving prompts dir
 * @returns Path to the prompts directory
 */
export function getPromptsDir(workerDir?: string): string {
  const envDir = Deno.env.get("PROMPTS_DIR");
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
  const baseDir = Deno.env.get("VIBE_BASE_DIR");
  if (baseDir) {
    return `${baseDir}/prompts`;
  }

  // Default: relative to the deno worker module (worker/deno/lib/)
  const moduleDir = new URL(".", import.meta.url).pathname;
  return `${moduleDir}../../../prompts`;
}

/**
 * List available versions for a prompt template.
 *
 * @param promptName - Name of the prompt (matches subdirectory in prompts/)
 * @param promptsDir - Path to the prompts directory
 * @returns Sorted array of version strings (e.g., ["v1", "v2"])
 */
export async function listPromptVersions(
  promptName: string,
  promptsDir?: string,
): Promise<Result<string[]>> {
  const dir = promptsDir ?? getPromptsDir();
  const promptDir = `${dir}/${promptName}`;

  try {
    const entries = [];
    for await (const entry of Deno.readDir(promptDir)) {
      if (entry.isFile && /^v\d+\.md$/.test(entry.name)) {
        entries.push(entry.name.replace(/\.md$/, ""));
      }
    }

    if (entries.length === 0) {
      return {
        ok: false,
        error: new Error(`No versions found for prompt '${promptName}'`),
      };
    }

    // Sort numerically by version number
    entries.sort((a, b) => {
      const numA = parseInt(a.replace("v", ""), 10);
      const numB = parseInt(b.replace("v", ""), 10);
      return numA - numB;
    });

    return { ok: true, value: entries };
  } catch {
    return {
      ok: false,
      error: new Error(
        `Prompt '${promptName}' not found in ${dir}`,
      ),
    };
  }
}

/**
 * Get the latest (highest) version for a prompt.
 *
 * @param promptName - Name of the prompt
 * @param promptsDir - Path to the prompts directory
 * @returns The latest version string (e.g., "v2")
 */
export async function getLatestVersion(
  promptName: string,
  promptsDir?: string,
): Promise<Result<string>> {
  const result = await listPromptVersions(promptName, promptsDir);
  if (!result.ok) {
    return result;
  }

  const versions = result.value;
  const latest = versions[versions.length - 1]!;
  return { ok: true, value: latest };
}

/**
 * Load a prompt template by name and optional version.
 *
 * @param promptName - Name of the prompt (matches subdirectory in prompts/)
 * @param version - Version string (e.g., "v1"). Defaults to latest version.
 * @param promptsDir - Path to the prompts directory
 * @returns The prompt template content
 */
export async function loadPrompt(
  promptName: string,
  version?: string,
  promptsDir?: string,
): Promise<Result<string>> {
  const dir = promptsDir ?? getPromptsDir();
  const promptDir = `${dir}/${promptName}`;

  // Default to latest version if not specified
  let resolvedVersion = version;
  if (!resolvedVersion) {
    const latestResult = await getLatestVersion(promptName, dir);
    if (!latestResult.ok) {
      return latestResult;
    }
    resolvedVersion = latestResult.value;
  }

  const templateFile = `${promptDir}/${resolvedVersion}.md`;

  try {
    const content = await Deno.readTextFile(templateFile);
    return { ok: true, value: content };
  } catch {
    return {
      ok: false,
      error: new Error(
        `Version '${resolvedVersion}' not found for prompt '${promptName}'`,
      ),
    };
  }
}

/**
 * Record which prompt version was used for traceability (Issue #212).
 *
 * Appends a timestamped entry to the specified log file.
 *
 * @param logFile - Path to the prompt versions log file
 * @param promptName - Name of the prompt that was used
 * @param version - Version string that was used
 */
export async function recordPromptVersion(
  logFile: string,
  promptName: string,
  version: string,
): Promise<Result<void>> {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const entry = `${timestamp} prompt=${promptName} version=${version}\n`;

  try {
    await Deno.writeTextFile(logFile, entry, { append: true });
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to record prompt version: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Get the required placeholders for a template type.
 *
 * @param templateType - Name of the template type
 * @returns Array of placeholder names, or error for unknown types
 */
export function getRequiredPlaceholders(
  templateType: string,
): Result<readonly string[]> {
  const placeholders = REQUIRED_PLACEHOLDERS[templateType];
  if (placeholders === undefined) {
    return {
      ok: false,
      error: new Error(`Unknown template type '${templateType}'`),
    };
  }
  return { ok: true, value: placeholders };
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
 */
export function getOptionalPlaceholders(
  templateType: string,
): Result<readonly string[]> {
  const placeholders = OPTIONAL_PLACEHOLDERS[templateType];
  if (placeholders === undefined) {
    return {
      ok: false,
      error: new Error(`Unknown template type '${templateType}'`),
    };
  }
  return { ok: true, value: placeholders };
}

/**
 * Validate that a template contains all required placeholders.
 *
 * @param templateType - Name of the template type
 * @param templateContent - The loaded template content to validate
 * @returns Result with missing placeholders if any
 */
export function validatePromptTemplate(
  templateType: string,
  templateContent: string,
): Result<string[]> {
  const placeholdersResult = getRequiredPlaceholders(templateType);
  if (!placeholdersResult.ok) {
    return placeholdersResult as Result<string[]>;
  }

  const required = placeholdersResult.value;
  if (required.length === 0) {
    return { ok: true, value: [] };
  }

  const missing: string[] = [];
  for (const placeholder of required) {
    if (!templateContent.includes(`{{${placeholder}}}`)) {
      missing.push(placeholder);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: new Error(
        `Template '${templateType}' is missing required placeholders: ${
          missing.join(", ")
        }`,
      ),
    };
  }

  return { ok: true, value: [] };
}

/**
 * Validate all prompt templates have required placeholders.
 *
 * @param promptsDir - Path to the prompts directory
 * @returns Result with list of errors if any templates fail validation
 */
export async function validateAllPromptTemplates(
  promptsDir?: string,
): Promise<Result<string[]>> {
  const templateTypes = [
    "coding_guidelines",
    "issue",
    "planning",
    "question",
    "pr_feedback",
    "spelling_fix",
    "workflow_setup",
    "security_scan",
  ];
  const errors: string[] = [];

  for (const templateType of templateTypes) {
    const loadResult = await loadPrompt(templateType, undefined, promptsDir);
    if (!loadResult.ok) {
      errors.push(
        `Failed to load template '${templateType}': ${loadResult.error.message}`,
      );
      continue;
    }

    const validateResult = validatePromptTemplate(
      templateType,
      loadResult.value,
    );
    if (!validateResult.ok) {
      errors.push(validateResult.error.message);
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: new Error(errors.join("\n")) };
  }

  return { ok: true, value: [] };
}

/**
 * Validate prompt immutability — check that no existing prompt versions
 * have been modified (Issue #235).
 *
 * Uses git to detect modifications to existing committed prompt version files.
 * New files (additions) are allowed — only modifications to existing files
 * are rejected.
 *
 * @param repoDir - Path to the git repository root
 * @param baseBranch - Base branch to compare against (optional)
 * @returns Result with list of modified files if any violations found
 */
export async function validatePromptImmutability(
  repoDir: string,
  baseBranch?: string,
): Promise<Result<string[]>> {
  const promptsRelDir = "prompts";
  const modifiedFiles: string[] = [];

  // Helper to run git command and collect output
  async function gitDiff(args: string[]): Promise<string> {
    const command = new Deno.Command("git", {
      args: ["-C", repoDir, ...args],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    return new TextDecoder().decode(output.stdout).trim();
  }

  // Check for unstaged modifications
  const unstaged = await gitDiff([
    "diff",
    "--name-only",
    "--",
    `${promptsRelDir}/`,
  ]);
  if (unstaged) {
    modifiedFiles.push(...unstaged.split("\n"));
  }

  // Check for staged modifications (exclude additions)
  const staged = await gitDiff([
    "diff",
    "--cached",
    "--diff-filter=M",
    "--name-only",
    "--",
    `${promptsRelDir}/`,
  ]);
  if (staged) {
    modifiedFiles.push(...staged.split("\n"));
  }

  // Check for committed modifications against base branch
  if (baseBranch) {
    const committed = await gitDiff([
      "diff",
      "--diff-filter=M",
      "--name-only",
      `${baseBranch}...HEAD`,
      "--",
      `${promptsRelDir}/`,
    ]);
    if (committed) {
      modifiedFiles.push(...committed.split("\n"));
    }
  }

  // Deduplicate and filter to only v*.md files
  const versionFiles = [
    ...new Set(modifiedFiles.filter((f) => /\/v\d+\.md$/.test(f))),
  ];

  if (versionFiles.length > 0) {
    return {
      ok: false,
      error: new Error(
        `Existing prompt versions must not be modified (Issue #235). Create a new version instead. Modified files: ${
          versionFiles.join(", ")
        }`,
      ),
    };
  }

  return { ok: true, value: [] };
}
