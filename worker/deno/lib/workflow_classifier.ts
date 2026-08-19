/**
 * CI workflow trigger classifier (Issue #2585, part of #2561).
 *
 * `classifyWorkflow(parsedYaml)` is a pure function that decides whether
 * a parsed GitHub Actions workflow is:
 *
 *   - `deploy`     — deploy/publish/release. Re-running on push-to-default
 *                    is required: reporting a publish failure at the PR
 *                    stage is too late.
 *   - `test`       — test/lint/scan. Should be PR-only so it does not
 *                    re-run post-merge on the default branch.
 *   - `ambiguous`  — mixes both kinds of step, or matches neither. Left
 *                    as-is by the trigger-normalisation caller.
 *
 * It is the foundation for the workflow-trigger normalisation described
 * in #2561: a downstream auditor uses the category to decide whether a
 * workflow's `push:` trigger should be dropped, kept, or left untouched.
 *
 * The classifier takes the parsed YAML (callers use
 * `workflow_scan_common.ts` `readWorkflowFiles()` to read and parse the
 * `.github/workflows/*.{yml,yaml}` files). It never reads the filesystem
 * and never throws on malformed input — an unrecognised shape simply
 * yields `ambiguous`/`low`.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

/** The three trigger categories a workflow can fall into. */
export type WorkflowCategory = "test" | "deploy" | "ambiguous";

/** How confident the classifier is in the assigned {@link WorkflowCategory}. */
export type ClassificationConfidence = "high" | "medium" | "low";

/** Result of {@link classifyWorkflow}. */
export interface WorkflowClassification {
  /** The decided category. */
  category: WorkflowCategory;
  /** Confidence in the decision. */
  confidence: ClassificationConfidence;
  /**
   * Human-readable evidence strings naming each matched signature, e.g.
   * `deploy signature: npm publish`. Deduplicated and stable-ordered
   * (deploy signatures first, then test). Empty when nothing matched.
   */
  evidence: string[];
}

/** A signature matched against a step's `uses:` ref or `run:` script. */
interface Signature {
  /** The category this signature votes for. */
  kind: "deploy" | "test";
  /** A short label naming the signature (used in evidence). */
  label: string;
  /** Pattern tested against the combined step text. */
  pattern: RegExp;
}

/**
 * Deploy/publish/release signatures. Any match makes the workflow a
 * publisher: it ships an artefact, cuts a release, or pushes to a hosting
 * target. These take precedence over test signatures (e.g. `cargo
 * publish` beats `cargo test`).
 */
const DEPLOY_SIGNATURES: readonly Signature[] = [
  { kind: "deploy", label: "gh release", pattern: /\bgh\s+release\b/ },
  { kind: "deploy", label: "npm publish", pattern: /\bnpm\s+publish\b/ },
  { kind: "deploy", label: "cargo publish", pattern: /\bcargo\s+publish\b/ },
  { kind: "deploy", label: "deno publish", pattern: /\bdeno\s+publish\b/ },
  {
    kind: "deploy",
    label: "softprops/action-gh-release",
    pattern: /softprops\/action-gh-release/,
  },
  {
    kind: "deploy",
    label: "actions/deploy-pages",
    pattern: /actions\/deploy-pages/,
  },
  {
    kind: "deploy",
    label: "actions/upload-pages-artifact",
    pattern: /actions\/upload-pages-artifact/,
  },
  { kind: "deploy", label: "aws-actions/*", pattern: /aws-actions\// },
  { kind: "deploy", label: "cloudflare/*", pattern: /cloudflare\// },
  { kind: "deploy", label: "docker push", pattern: /\bdocker\s+push\b/ },
  {
    kind: "deploy",
    label: "docker/build-push-action",
    pattern: /docker\/build-push-action/,
  },
  {
    kind: "deploy",
    label: "release-asset upload",
    pattern: /upload-release-asset|gh\s+release\s+upload/,
  },
] as const;

/**
 * Test/lint/scan signatures. Any match (in the absence of a deploy
 * signature) makes the workflow a checker: it runs tests, linters,
 * formatters, type-checks, or security scanners.
 */
const TEST_SIGNATURES: readonly Signature[] = [
  { kind: "test", label: "deno test", pattern: /\bdeno\s+test\b/ },
  { kind: "test", label: "deno lint", pattern: /\bdeno\s+lint\b/ },
  { kind: "test", label: "deno check", pattern: /\bdeno\s+check\b/ },
  { kind: "test", label: "deno fmt", pattern: /\bdeno\s+fmt\b/ },
  { kind: "test", label: "cargo fmt", pattern: /\bcargo\s+fmt\b/ },
  { kind: "test", label: "cargo clippy", pattern: /\bcargo\s+clippy\b/ },
  { kind: "test", label: "cargo test", pattern: /\bcargo\s+test\b/ },
  { kind: "test", label: "cargo check", pattern: /\bcargo\s+check\b/ },
  { kind: "test", label: "eslint", pattern: /\beslint\b/ },
  { kind: "test", label: "pytest", pattern: /\bpytest\b/ },
  { kind: "test", label: "actionlint", pattern: /\bactionlint\b/ },
  { kind: "test", label: "semgrep", pattern: /\bsemgrep\b/ },
  { kind: "test", label: "gitleaks", pattern: /\bgitleaks\b/ },
  { kind: "test", label: "markdownlint", pattern: /\bmarkdownlint\b/ },
  { kind: "test", label: "npm audit", pattern: /\bnpm\s+audit\b/ },
  { kind: "test", label: "cargo audit", pattern: /\bcargo\s+audit\b/ },
  { kind: "test", label: "npm test", pattern: /\bnpm\s+(?:run\s+)?test\b/ },
] as const;

/**
 * Classify a parsed GitHub Actions workflow as test/lint/scan,
 * deploy/publish/release, or ambiguous.
 *
 * Decision rules:
 *
 *   - Any deploy signature present, no test signature → `deploy` (high).
 *   - Any test signature present, no deploy signature → `test` (high).
 *   - Both kinds present → `ambiguous` (medium) — the caller leaves the
 *     workflow's triggers untouched.
 *   - Neither present (or an unrecognised/empty shape) → `ambiguous`
 *     (low).
 *
 * Pure and total: never reads the filesystem, never throws.
 */
export function classifyWorkflow(parsedYaml: unknown): WorkflowClassification {
  const stepTexts = collectStepTexts(parsedYaml);

  const deployMatches = matchSignatures(stepTexts, DEPLOY_SIGNATURES);
  const testMatches = matchSignatures(stepTexts, TEST_SIGNATURES);

  const evidence: string[] = [
    ...deployMatches.map((label) => `deploy signature: ${label}`),
    ...testMatches.map((label) => `test signature: ${label}`),
  ];

  if (deployMatches.length > 0 && testMatches.length > 0) {
    return { category: "ambiguous", confidence: "medium", evidence };
  }
  if (deployMatches.length > 0) {
    return { category: "deploy", confidence: "high", evidence };
  }
  if (testMatches.length > 0) {
    return { category: "test", confidence: "high", evidence };
  }
  return { category: "ambiguous", confidence: "low", evidence: [] };
}

/**
 * Match `signatures` against the combined step text, returning the
 * deduplicated, source-ordered labels of every signature that matched at
 * least once.
 */
function matchSignatures(
  stepTexts: readonly string[],
  signatures: readonly Signature[],
): string[] {
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const sig of signatures) {
    if (seen.has(sig.label)) continue;
    if (stepTexts.some((text) => sig.pattern.test(text))) {
      matched.push(sig.label);
      seen.add(sig.label);
    }
  }
  return matched;
}

/**
 * Walk every `jobs.<job>.steps[]` entry and return one text blob per
 * step, concatenating its `uses:` ref and `run:` script. Unknown shapes
 * are skipped silently so partially-valid YAML never throws.
 */
function collectStepTexts(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const jobs = parsed.jobs;
  if (!isRecord(jobs)) return [];

  const out: string[] = [];
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const parts: string[] = [];
      if (typeof step.uses === "string") parts.push(step.uses);
      if (typeof step.run === "string") parts.push(step.run);
      if (parts.length > 0) out.push(parts.join("\n"));
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
