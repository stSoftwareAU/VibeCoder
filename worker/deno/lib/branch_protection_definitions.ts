/**
 * Branch-protection required-checks definitions with visibility-aware
 * filtering.
 *
 * Defines a canonical list of the CI status checks that branch protection
 * should mark as *required*, and a query that returns only the **satisfiable**
 * subset for a given repository. The guiding invariant is:
 *
 *   Never require an unsatisfiable check.
 *
 * A check that can never pass on a repo (e.g. `dependency-review`, which needs
 * GitHub Advanced Security and only runs on public / GHAS-enabled repos) must
 * never be marked required there — otherwise it blocks every merge (Issue
 * #2561). Filtering is therefore visibility-aware and language-aware:
 *
 *   - `requiresPublic` checks are dropped on non-public repos.
 *   - Language-gated checks are dropped when the language is absent (or when
 *     the detected-language set is unknown).
 *
 * The public-only signal is **reused** from `workflow_definitions.ts`
 * (`visibilityScope: "public-only"`) rather than re-derived, so the two stay
 * in lock-step.
 *
 * Fail-safe: any visibility other than the literal `"public"` (including
 * `"private"`, `"unknown"`, or `undefined`) is treated as private, so a
 * public-only check is never required when the answer is uncertain. This
 * mirrors `getRepoVisibility()` in `repo_visibility.ts`.
 *
 * The catalogue names **candidate** contexts only. Since Issue #4163 the
 * configurator intersects them with the names a repo has genuinely reported,
 * so a context nothing reports is never marked required.
 *
 * Issue #2583.
 */

import type { RepoVisibility } from "./repo_visibility.ts";
import { WORKFLOW_SPECS } from "./workflow_definitions.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Specification for a CI status check that branch protection may require.
 */
export interface CheckSpec {
  /** Unique identifier, typically matching the workflow spec id. */
  id: string;
  /**
   * **Candidate** GitHub status-check context strings the workflow may produce
   * — the job name as shown in the Checks tab. Multiple entries cover
   * alternative renderings (workflow display name vs. job id vs. a repo's own
   * bespoke job name), because the same capability is named differently across
   * repos.
   *
   * These are candidates, never a guarantee. A configurator must intersect
   * them with the names the repo has **genuinely reported**
   * (`getReportedCheckNames()`) and require only the alternative that matched
   * — requiring an unreported name leaves the merge box on *"Expected —
   * Waiting for status to be reported"* forever (Issue #4163).
   */
  contextNames: string[];
  /**
   * When `true`, the check can only pass on public (or GHAS-enabled) repos
   * and must be excluded on non-public repos. Reuse the
   * `visibilityScope: "public-only"` signal from `workflow_definitions.ts`
   * (see {@link workflowRequiresPublic}) rather than hard-coding it.
   */
  requiresPublic?: boolean;
  /**
   * When set, the check only applies to repos whose detected languages
   * intersect this list. A language-gated check is excluded when none of its
   * languages are present (or the detected set is unknown).
   */
  languages?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reuse the public-only signal from `workflow_definitions.ts`.
 *
 * Returns `true` when the named workflow spec is marked
 * `visibilityScope: "public-only"`, so required-check definitions inherit the
 * single source of truth instead of re-deriving which checks are public-only.
 */
function workflowRequiresPublic(workflowId: string): boolean {
  const spec = WORKFLOW_SPECS.find((s) => s.id === workflowId);
  return spec?.visibilityScope === "public-only";
}

// ---------------------------------------------------------------------------
// Canonical required-checks catalogue
// ---------------------------------------------------------------------------

/**
 * Canonical list of CI status checks branch protection should require.
 *
 * Deliberately small and high-confidence: the universal security/quality
 * checks every monitored repo runs, plus a couple of language-gated quality
 * gates. Grow this list only with checks that are genuinely expected to be
 * present and green on the targeted repos.
 */
export const REQUIRED_CHECKS: CheckSpec[] = [
  // Universal checks — every monitored repo runs these. The extra candidates
  // are the names observed on repos that carry their own workflows rather than
  // the canonical templates (Issue #4163): gitleaks often runs as a step inside
  // a `quality` job, and semgrep as a job named `Semgrep SAST scan`.
  { id: "gitleaks", contextNames: ["gitleaks", "Gitleaks", "quality"] },
  { id: "semgrep", contextNames: ["semgrep", "Semgrep", "Semgrep SAST scan"] },
  { id: "markdown-lint", contextNames: ["markdownlint", "Markdown Lint"] },
  // Public-only: needs GHAS on private repos, so it can never pass there.
  // The `requiresPublic` flag is taken from workflow_definitions.ts.
  {
    id: "dependency-review",
    contextNames: ["dependency-review", "Dependency Review"],
    requiresPublic: workflowRequiresPublic("dependency-review"),
  },
  // Language-gated quality gates — only required when the language is present.
  {
    id: "deno-quality",
    contextNames: ["quality", "Deno Quality"],
    languages: ["Deno"],
  },
  {
    id: "cargo-quality",
    contextNames: ["quality", "Cargo Quality"],
    languages: ["Rust"],
  },
];

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Visibility input for {@link getRequiredChecksForRepo}.
 *
 * Accepts the `RepoVisibility` union plus `"unknown"` / `undefined` so callers
 * can pass an unresolved value directly; anything that is not `"public"` is
 * treated as private (fail-safe).
 */
export type CheckVisibility = RepoVisibility | "unknown" | undefined;

/**
 * Return the **satisfiable** subset of {@link REQUIRED_CHECKS} for a repo.
 *
 * Filtering rules (both enforce "never require an unsatisfiable check"):
 *
 *   - A `requiresPublic` check is excluded unless `visibility === "public"`.
 *     Unknown or undefined visibility is treated as private.
 *   - A language-gated check is excluded unless at least one of its languages
 *     appears in `detectedLanguages`. When `detectedLanguages` is omitted, no
 *     language can be confirmed present, so every language-gated check is
 *     excluded.
 *
 * @param visibility - Repository visibility (`"public"`, `"private"`,
 *   `"unknown"`, or `undefined`).
 * @param detectedLanguages - Optional set of languages detected in the repo.
 * @returns The satisfiable subset of required checks.
 */
export function getRequiredChecksForRepo(
  visibility: CheckVisibility,
  detectedLanguages?: string[],
): CheckSpec[] {
  // Fail-safe: only the literal "public" counts as public.
  const isPublic = visibility === "public";
  const langSet = detectedLanguages !== undefined
    ? new Set(detectedLanguages)
    : undefined;

  return REQUIRED_CHECKS.filter((check) => {
    if (check.requiresPublic && !isPublic) {
      return false;
    }
    if (check.languages !== undefined && check.languages.length > 0) {
      if (langSet === undefined) {
        return false;
      }
      if (!check.languages.some((lang) => langSet.has(lang))) {
        return false;
      }
    }
    return true;
  });
}
