/**
 * Language-validity CI-gate detector (Issue #3237, part of #3223).
 *
 * For each of a repository's detected main languages, determines whether a
 * native **basic-validity** check is wired into GitHub Actions CI — e.g.
 * `cargo check`, `deno check` / `tsc --noEmit`, `mvn compile` /
 * `gradle compileJava`, `python -m py_compile`. This is **basic validity
 * only** (does it compile / parse), NOT style or lint enforcement.
 *
 * Reuse over reimplementation:
 *   - The compile-gate detection for `rust`, `typescript`, `react`, and
 *     `java` is the SAME detection {@link checkLinterInCI} already performs
 *     (Issue #2175/#2177). This module reuses the exported
 *     `COMPILE_GATE_PATTERNS`, `loadWorkflows`, and `anyWorkflowMatches`
 *     helpers rather than re-deriving the regexes.
 *   - Python is net-new: it is not a best-practices bucket, so its
 *     `py_compile` / `compileall` detection is defined here.
 *   - The repo's main languages are enumerated from the same
 *     language / SLOC detection the best-practices bucket picker uses
 *     (`RepoLanguages` + the shared {@link isReactRepo} React decision).
 *
 * Scope boundaries:
 *   - Bash is NOT handled here — the shell `bash -n` + shellcheck gate is
 *     the sibling `bash_ci_gate_scanner.ts`'s concern. A repo whose only
 *     language is shell yields no findings from this detector.
 *   - Compiled / type-checked languages that already have an existing CI
 *     compile/check step simply pass — no duplicate step is proposed.
 *   - Static inspection only: `.github/workflows/*` is parsed with
 *     `@std/yaml` via the shared loaders; `cargo` / `deno` / `tsc` / `mvn`
 *     / `python` are never invoked.
 */

import {
  anyWorkflowMatches,
  COMPILE_GATE_PATTERNS,
  type LoadedWorkflow,
  loadWorkflows,
} from "./linter_in_ci_check.ts";
import { isReactRepo } from "./best_practices_bucket_picker.ts";
import type { RepoLanguages } from "./language_detector.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Languages for which this detector checks a native basic-validity gate.
 * Bash is deliberately excluded (sibling scanner); non-compiled buckets
 * (HTML, Terraform, CloudFormation) have no basic-validity gate concept.
 */
export type ValidityGateLanguage =
  | "rust"
  | "typescript"
  | "react"
  | "java"
  | "python";

/**
 * Per-language validity-gate result, following the `LinterCheckResult`
 * idiom (language + present flag + human-readable details).
 */
export interface LanguageValidityResult {
  /** The main language this result describes. */
  language: ValidityGateLanguage;
  /**
   * True iff a native basic-validity check for the language is invoked by
   * a GitHub Actions workflow.
   */
  present: boolean;
  /**
   * One short paragraph suitable for a GitHub issue body: when the gate is
   * missing it names the missing check and gives a concrete suggested
   * invocation; when present it states no action is required.
   */
  details: string;
  /**
   * Fail-safe flag (mirrors {@link LinterCheckResult.workflowsLoaded},
   * Issue #2881). `false` iff **zero** workflow files were loaded under
   * `.github/workflows/` — the gate status is then *unknown* rather than
   * confirmed-missing, so the consumer must NOT file a high-severity
   * "missing gate" finding off the back of it.
   */
  workflowsLoaded: boolean;
}

// ---------------------------------------------------------------------------
// Per-language specs
// ---------------------------------------------------------------------------

/**
 * Python basic-validity pattern. Accepts `python -m py_compile`,
 * `python -m compileall`, and a bare `py_compile` invocation. Matched
 * against the already-lowercased workflow `invocations` blob, so it is
 * written in lowercase; `python3` / `python3.12` prefixes are tolerated.
 */
const PYTHON_VALIDITY_PATTERN =
  /(python[0-9.]*\s+-m\s+(py_compile|compileall)\b|\bpy_compile\b)/;

interface ValiditySpec {
  /** Human-readable language label for the details message. */
  label: string;
  /** CI-invocation pattern that satisfies the basic-validity gate. */
  pattern: RegExp;
  /** Which native checks satisfy the gate (rendered in the happy path). */
  gatePhrase: string;
  /** Concrete suggested invocation for the finding body. */
  suggested: string;
}

const VALIDITY_SPECS: Record<ValidityGateLanguage, ValiditySpec> = {
  rust: {
    label: "Rust",
    pattern: COMPILE_GATE_PATTERNS.rust,
    gatePhrase: "`cargo check` / `cargo build`",
    suggested: "cargo check --all-targets",
  },
  typescript: {
    label: "TypeScript",
    pattern: COMPILE_GATE_PATTERNS.typescript,
    gatePhrase: "`deno check` / `tsc --noEmit`",
    suggested: "deno check **/*.ts` (or `npx tsc --noEmit",
  },
  react: {
    label: "React",
    pattern: COMPILE_GATE_PATTERNS.react,
    gatePhrase: "`deno check` / `tsc --noEmit`",
    suggested: "deno check **/*.ts` (or `npx tsc --noEmit",
  },
  java: {
    label: "Java",
    pattern: COMPILE_GATE_PATTERNS.java,
    gatePhrase: "`mvn compile` / `gradle compileJava`",
    suggested: "mvn compile` (or `./gradlew compileJava",
  },
  python: {
    label: "Python",
    pattern: PYTHON_VALIDITY_PATTERN,
    gatePhrase: "`python -m py_compile` / `python -m compileall`",
    suggested: "python -m compileall .",
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enumerate the repo's main languages that have a basic-validity gate
 * concept. Reuses the same language / SLOC signals the best-practices
 * bucket picker uses (`RepoLanguages.raw` byte counts plus the shared
 * {@link isReactRepo} React decision). Bash / shell is intentionally
 * excluded.
 */
export function detectValidityGateLanguages(
  langs: RepoLanguages,
): ValidityGateLanguage[] {
  const out: ValidityGateLanguage[] = [];
  const raw = langs.raw;

  if ((raw.Rust ?? 0) > 0) out.push("rust");
  if ((raw.TypeScript ?? 0) > 0) {
    out.push(isReactRepo(langs.bestPracticesMarkers) ? "react" : "typescript");
  }
  if ((raw.Java ?? 0) > 0) out.push("java");
  if ((raw.Python ?? 0) > 0) out.push("python");

  return out;
}

/**
 * For each of the repo's detected main languages, check whether a native
 * basic-validity gate is wired into CI. Returns one result per detected
 * language; a repo with no gate-bearing language (e.g. shell-only) returns
 * an empty array.
 *
 * @param repoPath Absolute or relative path to a local clone of the repo.
 * @param langs Detected language stats for the repo (same shape the
 *   best-practices bucket picker consumes).
 */
export async function checkLanguageValidityGates(
  repoPath: string,
  langs: RepoLanguages,
): Promise<LanguageValidityResult[]> {
  const languages = detectValidityGateLanguages(langs);
  if (languages.length === 0) return [];

  const workflows = await loadWorkflows(repoPath);
  return languages.map((language) => checkOne(language, workflows));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function checkOne(
  language: ValidityGateLanguage,
  workflows: LoadedWorkflow[],
): LanguageValidityResult {
  const spec = VALIDITY_SPECS[language];
  const workflowsLoaded = workflows.length > 0;

  if (!workflowsLoaded) {
    return {
      language,
      present: false,
      details:
        `No GitHub Actions workflows were found under \`.github/workflows/\`, ` +
        `so a native ${spec.label} basic-validity gate (${spec.gatePhrase}) ` +
        "cannot be confirmed in CI. Add a CI workflow that runs the check on " +
        "every push and pull request so syntax errors fail the build.",
      workflowsLoaded: false,
    };
  }

  const present = anyWorkflowMatches(workflows, spec.pattern);
  if (present) {
    return {
      language,
      present: true,
      details:
        `A ${spec.label} basic-validity gate (${spec.gatePhrase}) is invoked ` +
        "by a GitHub Actions workflow, so syntax errors are surfaced on every " +
        "push. No action required.",
      workflowsLoaded: true,
    };
  }

  return {
    language,
    present: false,
    details:
      `${spec.label} CI is missing a basic-validity gate: no ${spec.gatePhrase} ` +
      "step is invoked by any GitHub Actions workflow, so a simple syntax " +
      `error can land on main unnoticed. Add a step such as \`${spec.suggested}\` ` +
      "so syntax errors fail the build. Basic validity only — this is not a " +
      "style or lint requirement.",
    workflowsLoaded: true,
  };
}
