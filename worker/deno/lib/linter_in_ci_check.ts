/**
 * Linter-in-CI check helper.
 *
 * Determines, for a supported language, whether the standard linter for
 * that language is both configured in the repository AND invoked by a
 * GitHub Actions workflow. The result powers the highest-priority
 * finding for a language-targeted best-practices idle-task run
 * (Issue #2145 — part of #2143).
 *
 * For the languages where a compile/syntax check is meaningful
 * (`rust`, `typescript`, `react`, `java`), the helper additionally
 * verifies a separate **compile-gate** invocation is wired into CI.
 * Linter and compile are treated as two independent gates — a bucket
 * only passes when both are present (Issue #2177, part of #2175).
 * A linter that incidentally typechecks (e.g. ESLint with
 * `@typescript-eslint`) does NOT satisfy the compile gate — the
 * gates are detected independently.
 *
 * Detection rules per language (all CI invocation is searched across
 * `.github/workflows/*.yml` and `*.yaml`; parsing is done in-process
 * with `@std/yaml`):
 *
 *   - `rust`               — linter: `cargo clippy`;
 *                            compile: `cargo check` OR `cargo build`.
 *   - `typescript`         — linter: `.eslintrc*` or `eslint.config.*`
 *                            config file present AND ESLint invoked
 *                            in CI, OR `deno lint` invoked in CI
 *                            (Deno's built-in linter needs no config);
 *                            compile: `deno check` OR `tsc --noEmit`.
 *   - `react`              — same as `typescript`.
 *   - `java`               — linter: Checkstyle, SpotBugs, or PMD
 *                            config file present AND the same tool
 *                            invoked in CI;
 *                            compile: `mvn compile` OR `gradle
 *                            compileJava`.
 *   - `html`               — `htmlhint` or `html-validate` invoked in CI
 *                            (no compile gate).
 *   - `github-actions`     — `actionlint` invoked in CI (no compile gate).
 *   - `aws-cloudformation` — `cfn-lint` invoked in CI (no compile gate).
 *   - `terraform`          — `tflint` invoked OR (`terraform validate`
 *     AND `terraform fmt -check`) both invoked in CI (no compile gate).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import type { SupportedLanguage } from "./best_practices_bucket_picker.ts";
import { assertNever } from "./assert_never.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Outcome of a linter-in-CI check for a single language. */
export interface LinterCheckResult {
  /**
   * True iff every applicable gate for the language is present.
   *
   * For buckets where a compile/syntax check is meaningful
   * (`rust`, `typescript`, `react`, `java`), this requires BOTH the
   * linter gate AND the compile gate to be present. For the remaining
   * buckets (`html`, `github-actions`, `aws-cloudformation`,
   * `terraform`) only the linter gate is required.
   */
  configured: boolean;
  /** Human-readable linter name (e.g. "cargo clippy", "ESLint"). */
  linter: string;
  /**
   * One short paragraph suitable for direct use in a GitHub issue body:
   * what was found / what is missing, why it matters, and a suggested
   * action. When one or both gates are missing the message names which
   * gate(s) are missing and gives a concrete suggested invocation.
   */
  details: string;
  /**
   * Per-gate status. Only populated for buckets where a compile gate
   * is meaningful (`rust`, `typescript`, `react`, `java`). Consumers
   * may read this to render finer-grained UI; the legacy
   * `{ configured, linter, details }` shape is unchanged when this
   * field is absent.
   */
  gates?: {
    /** True iff the standard linter gate is present in CI. */
    linter: boolean;
    /** True iff a separate compile/syntax gate is invoked in CI. */
    compile: boolean;
  };
  /**
   * Fail-safe flag (Issue #2881). `false` iff **zero** workflow files were
   * loaded under `.github/workflows/` — a state more likely caused by a
   * scan glitch (wrong path, mid-clone, checkout race) than a genuine
   * absence of CI. When `false`, the gate status is *unknown* rather than
   * confirmed-missing, so the consumer must NOT file a `severity:high`
   * "missing gate" finding off the back of it. Absent/`true` means
   * workflows were present and the gate result is trustworthy.
   */
  workflowsLoaded?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Languages accepted by {@link checkLinterInCI}. This is the
 * best-practices `SupportedLanguage` set plus `"github-actions"`, which
 * the dedicated weekly github-actions-audit template (#2256) still routes
 * through this helper even though the daily best-practices scan no longer
 * picks the `github-actions` bucket (#2257).
 */
export type LinterCheckLanguage = SupportedLanguage | "github-actions";

/**
 * Languages for which a compile/basic-validity gate is meaningful. These
 * are the buckets where {@link checkLinterInCI} additionally verifies a
 * compile-gate invocation (Issue #2175/#2177).
 */
export type CompileGateLanguage = "rust" | "typescript" | "react" | "java";

/**
 * Compile/basic-validity-gate invocation patterns, keyed by language.
 *
 * These are the single source of truth for compile-gate detection: the
 * per-language dual-gate checks below reference them, and the
 * language-validity-gate detector (Issue #3237) reuses them rather than
 * reimplementing the regexes. All patterns are matched against the
 * already-lowercased `invocations` blob, so they must be written in
 * lowercase.
 */
export const COMPILE_GATE_PATTERNS: Record<CompileGateLanguage, RegExp> = {
  rust: /cargo\s+(check|build)\b/,
  typescript: /(deno\s+check\b|tsc\s+[^\n]*--noemit)/,
  react: /(deno\s+check\b|tsc\s+[^\n]*--noemit)/,
  java: /(mvnw?\s+compile|gradlew?\s+compilejava)/,
};

/**
 * Check whether the standard linter for `language` is configured AND
 * invoked in CI for the repository checked out at `repoPath`.
 *
 * @param repoPath Absolute or relative path to a local clone of the repo.
 * @param language One of the buckets supported by the best-practices
 *   idle task (see `SupportedLanguage` in
 *   `best_practices_bucket_picker.ts`), or `"github-actions"` for the
 *   github-actions-audit template.
 */
export async function checkLinterInCI(
  repoPath: string,
  language: LinterCheckLanguage,
): Promise<LinterCheckResult> {
  const workflows = await loadWorkflows(repoPath);
  const rootFiles = await listRootFiles(repoPath);
  const ctx: CheckContext = { repoPath, workflows, rootFiles };

  switch (language) {
    case "rust":
      return checkRust(ctx);
    case "typescript":
      return checkEslint(ctx, "typescript");
    case "react":
      return checkEslint(ctx, "react");
    case "java":
      return checkJava(ctx);
    case "html":
      return checkHtml(ctx);
    case "github-actions":
      return checkActionlint(ctx);
    case "aws-cloudformation":
      return checkCfnLint(ctx);
    case "terraform":
      return checkTerraform(ctx);
    default:
      return assertNever(language);
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A workflow file loaded from `.github/workflows/`. */
export interface LoadedWorkflow {
  /** Filename relative to `.github/workflows/`. */
  filename: string;
  /** Raw text content. */
  rawContent: string;
  /**
   * Concatenation of every `step.run` string and every `step.uses`
   * string in the workflow — lowercased for case-insensitive matching.
   * This is the body searched for linter invocations.
   */
  invocations: string;
}

/** Shared context handed to every per-language check. */
interface CheckContext {
  repoPath: string;
  workflows: LoadedWorkflow[];
  rootFiles: Set<string>;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Load every workflow under `.github/workflows/`. Empty when missing. */
export async function loadWorkflows(
  repoPath: string,
): Promise<LoadedWorkflow[]> {
  const dir = `${repoPath}/.github/workflows`;
  const out: LoadedWorkflow[] = [];
  let dirMissing = false;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
      const rawContent = await Deno.readTextFile(path);
      let parsed: unknown = null;
      try {
        parsed = parseYaml(rawContent);
      } catch {
        // Unparseable workflows are skipped — we cannot reliably
        // enumerate steps without a parsed structure.
        continue;
      }
      out.push({
        filename: entry.name,
        rawContent,
        invocations: collectInvocations(parsed).toLowerCase(),
      });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      dirMissing = true;
    } else {
      throw err;
    }
  }
  if (out.length === 0) {
    // Diagnostic (Issue #2880): an empty load is otherwise
    // indistinguishable from a genuinely workflow-free repo. Recording
    // whether the directory existed tells the two apart — a missing
    // directory at scan time usually means the wrong path was passed
    // (e.g. the parent work dir instead of the repo checkout root).
    console.warn(
      `[linter-in-ci] loaded 0 workflows from "${dir}" ` +
        `(directory ${dirMissing ? "missing" : "present but empty"})`,
    );
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

/** List file (not directory) names at the repository root. */
async function listRootFiles(repoPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(repoPath);
  } catch {
    return out;
  }
  for await (const entry of entries) {
    if (entry.isFile) out.add(entry.name);
  }
  return out;
}

/**
 * Walk a parsed workflow YAML and collect every `step.run` and
 * `step.uses` string into a single newline-joined blob — the search
 * body for linter invocations.
 */
function collectInvocations(parsed: unknown): string {
  if (!isRecord(parsed)) return "";
  const jobs = parsed.jobs;
  if (!isRecord(jobs)) return "";
  const parts: string[] = [];
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      if (typeof step.run === "string") parts.push(step.run);
      if (typeof step.uses === "string") parts.push(step.uses);
    }
  }
  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Per-language checks
// ---------------------------------------------------------------------------

function checkRust(ctx: CheckContext): LinterCheckResult {
  const linter = "cargo clippy";
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter,
      details: missingWorkflowsDetail(linter, "Rust"),
      gates: { linter: false, compile: false },
      workflowsLoaded: false,
    };
  }
  const lintInvoked = anyWorkflowMatches(ctx.workflows, /cargo\s+clippy/);
  const compileInvoked = anyWorkflowMatches(
    ctx.workflows,
    COMPILE_GATE_PATTERNS.rust,
  );
  return buildDualGateResult({
    linter,
    languageLabel: "Rust",
    lintInvoked,
    compileInvoked,
    bothPresentDetail:
      "`cargo clippy` and a Rust compile gate (`cargo check` / `cargo " +
      "build`) are both invoked by a GitHub Actions workflow. Lint " +
      "warnings AND syntax errors are surfaced on every push. No action " +
      "required.",
    linterMissingPhrase:
      "no `cargo clippy` invocation (Clippy is the Rust ecosystem's " +
      "standard linter — without it lint regressions land unnoticed; " +
      "add a step such as `cargo clippy --all-targets -- -D warnings`)",
    compileMissingPhrase:
      "no compile gate (issue #2175: a simple syntax error reached main " +
      "because no `cargo check`/`cargo build` step ran in CI; add a step " +
      "such as `cargo check --all-targets` so syntax errors fail the build)",
  });
}

const ESLINT_CONFIG_PREFIXES = [".eslintrc", "eslint.config."];

function checkEslint(
  ctx: CheckContext,
  flavour: "typescript" | "react",
): LinterCheckResult {
  const linter = "ESLint";
  const configFile = findEslintConfig(ctx.rootFiles);
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter,
      details: missingWorkflowsDetail(linter, flavour),
      gates: { linter: false, compile: false },
      workflowsLoaded: false,
    };
  }
  const eslintInvoked = anyWorkflowMatches(ctx.workflows, /\beslint\b/);
  // Deno-based TypeScript/React repos use Deno's built-in linter
  // (`deno lint`) instead of ESLint. It ships sensible defaults, so no
  // config file is required — invoking it in CI satisfies the linter gate.
  const denoLintInvoked = anyWorkflowMatches(ctx.workflows, /deno\s+lint\b/);
  const eslintLintGate = configFile !== null && eslintInvoked;
  const lintInvoked = eslintLintGate || denoLintInvoked;
  // The compile gate is satisfied by `deno check` OR `tsc --noEmit`.
  // ESLint with @typescript-eslint does NOT satisfy the compile gate —
  // the gates are detected independently (Issue #2177).
  const compileInvoked = anyWorkflowMatches(
    ctx.workflows,
    COMPILE_GATE_PATTERNS[flavour],
  );

  // Report whichever linter satisfied the gate; ESLint takes precedence
  // when both are present so the existing config-based wording applies.
  const linterName = eslintLintGate
    ? "ESLint"
    : denoLintInvoked
    ? "deno lint"
    : linter;
  const bothPresentDetail = eslintLintGate
    ? `ESLint is configured (\`${configFile}\`) and ` +
      "invoked by a GitHub Actions workflow, and a separate compile gate " +
      "(`deno check` / `tsc --noEmit`) is also invoked. Lint AND syntax " +
      "errors are caught in CI. No action required."
    : "`deno lint` is invoked by a GitHub Actions workflow, and a separate " +
      "compile gate (`deno check` / `tsc --noEmit`) is also invoked. Lint " +
      "AND syntax errors are caught in CI. No action required.";

  // Compose a linter-side phrase that captures the ESLint nuance
  // (config file vs CI invocation may be missing independently).
  const linterMissingPhrase = buildEslintMissingPhrase(
    configFile,
    eslintInvoked,
  );

  return buildDualGateResult({
    linter: linterName,
    languageLabel: flavour === "react" ? "React" : "TypeScript",
    lintInvoked,
    compileInvoked,
    bothPresentDetail,
    linterMissingPhrase,
    compileMissingPhrase:
      "no compile gate (issue #2175: a simple syntax error reached main " +
      "because no `deno check`/`tsc --noEmit` step ran in CI; ESLint " +
      "alone does not catch all syntax errors — add a step such as " +
      "`deno check **/*.ts` or `npx tsc --noEmit` so syntax errors fail " +
      "the build)",
  });
}

/**
 * Build the ESLint-side "missing" phrase for the dual-gate details
 * message. ESLint has TWO sub-requirements (config file + CI invocation),
 * so this disambiguates which sub-requirement is missing without losing
 * the wording the prior single-gate code used.
 */
function buildEslintMissingPhrase(
  configFile: string | null,
  eslintInvoked: boolean,
): string {
  if (configFile === null && !eslintInvoked) {
    return (
      "no ESLint config file (`.eslintrc*` or `eslint.config.*`) is " +
      "present at the repository root, and no workflow invokes ESLint or " +
      "`deno lint` — add a flat-config file (`eslint.config.js`) and a CI " +
      "step that runs `npx eslint .`, or (for a Deno project) add a step " +
      "that runs `deno lint`"
    );
  }
  if (configFile === null) {
    return (
      "a workflow invokes ESLint but no config file is present at the " +
      "repository root — add an `eslint.config.js` (or `.eslintrc.json`) " +
      "so rules are version-controlled"
    );
  }
  // config present, no CI invocation
  return (
    `an ESLint config (\`${configFile}\`) is present but no GitHub ` +
    "Actions workflow invokes ESLint, so lint failures are never " +
    "enforced in CI — add a step such as `npx eslint .`"
  );
}

function findEslintConfig(rootFiles: Set<string>): string | null {
  for (const name of rootFiles) {
    for (const prefix of ESLINT_CONFIG_PREFIXES) {
      if (name === prefix.slice(0, -1)) return name; // ".eslintrc" exactly
      if (name.startsWith(prefix)) return name;
    }
  }
  return null;
}

interface JavaLinterSpec {
  name: string;
  configFiles: readonly string[];
  invocationPattern: RegExp;
}

const JAVA_LINTERS: readonly JavaLinterSpec[] = [
  {
    name: "Checkstyle",
    configFiles: ["checkstyle.xml", "checkstyle-config.xml"],
    invocationPattern: /checkstyle/i,
  },
  {
    name: "SpotBugs",
    configFiles: ["spotbugs.xml", "spotbugs-exclude.xml", "findbugs.xml"],
    invocationPattern: /spotbugs|findbugs/i,
  },
  {
    name: "PMD",
    configFiles: ["pmd.xml", "pmd-rules.xml", "pmd-ruleset.xml"],
    invocationPattern: /\bpmd\b/i,
  },
];

function checkJava(ctx: CheckContext): LinterCheckResult {
  const defaultLinter = "Checkstyle / SpotBugs / PMD";
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter: defaultLinter,
      details: missingWorkflowsDetail(defaultLinter, "Java"),
      gates: { linter: false, compile: false },
      workflowsLoaded: false,
    };
  }

  // Locate the first (spec, config) pair where BOTH config + invocation
  // are present — that's the linter gate.
  let linterSpec: JavaLinterSpec | null = null;
  let linterConfigFile: string | null = null;
  for (const spec of JAVA_LINTERS) {
    const config = spec.configFiles.find((f) => ctx.rootFiles.has(f));
    const invoked = anyWorkflowMatches(ctx.workflows, spec.invocationPattern);
    if (config && invoked) {
      linterSpec = spec;
      linterConfigFile = config;
      break;
    }
  }
  const lintInvoked = linterSpec !== null;

  // Compile gate: `mvn compile` OR `gradle compileJava` invoked
  // anywhere. The Maven / Gradle wrapper forms (`./mvnw`, `./gradlew`)
  // are accepted too — they are the conventional CI invocation.
  const compileInvoked = anyWorkflowMatches(
    ctx.workflows,
    COMPILE_GATE_PATTERNS.java,
  );

  // Compose a friendly linter name for the result. When the linter
  // gate is satisfied we use the matched tool; otherwise we describe
  // the standard alternatives.
  const linterName = linterSpec?.name ?? defaultLinter;

  return buildDualGateResult({
    linter: linterName,
    languageLabel: "Java",
    lintInvoked,
    compileInvoked,
    bothPresentDetail: linterSpec && linterConfigFile
      ? `${linterSpec.name} is configured (\`${linterConfigFile}\`) and ` +
        "invoked by a GitHub Actions workflow, and a separate compile " +
        "gate (`mvn compile` / `gradle compileJava`) is also invoked. " +
        "Lint AND syntax errors are caught in CI. No action required."
      // Defensive — bothPresent implies linterSpec is set, but keep a
      // safe fallback to satisfy the type checker.
      : "Both Java lint and compile gates are invoked in CI. No action " +
        "required.",
    linterMissingPhrase: buildJavaLinterMissingPhrase(ctx),
    compileMissingPhrase:
      "no compile gate (issue #2175: a simple syntax error reached main " +
      "because no `mvn compile`/`gradle compileJava` step ran in CI; " +
      "add a step such as `mvn compile` or `./gradlew compileJava` so " +
      "syntax errors fail the build)",
  });
}

/**
 * Build the Java linter-side "missing" phrase. The original code chose
 * its wording based on which sub-requirement was missing (config file
 * vs CI invocation, across Checkstyle/SpotBugs/PMD). Preserve that
 * nuance here.
 */
function buildJavaLinterMissingPhrase(ctx: CheckContext): string {
  const anyConfig = JAVA_LINTERS.find((s) =>
    s.configFiles.some((f) => ctx.rootFiles.has(f))
  );
  const anyInvoked = JAVA_LINTERS.find((s) =>
    anyWorkflowMatches(ctx.workflows, s.invocationPattern)
  );
  if (anyConfig && !anyInvoked) {
    return (
      `${anyConfig.name} config is present but no GitHub Actions ` +
      "workflow invokes the linter, so violations are never enforced " +
      `in CI — add a step that runs ${anyConfig.name} (for example, ` +
      `\`mvn ${anyConfig.name.toLowerCase()}:check\`)`
    );
  }
  if (!anyConfig && anyInvoked) {
    return (
      `a workflow invokes ${anyInvoked.name} but no config file is ` +
      "present at the repository root — add the matching config file " +
      "(e.g. `checkstyle.xml`)"
    );
  }
  return (
    "no Java linter (Checkstyle, SpotBugs, or PMD) is configured or " +
    "invoked in CI — pick one of the standard tools (Checkstyle is the " +
    "most common), add the config file at the repository root, and call " +
    "it from a GitHub Actions step (e.g. `mvn checkstyle:check`)"
  );
}

function checkHtml(ctx: CheckContext): LinterCheckResult {
  const linter = "htmlhint / html-validate";
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter,
      details: missingWorkflowsDetail(linter, "HTML"),
      workflowsLoaded: false,
    };
  }
  if (anyWorkflowMatches(ctx.workflows, /htmlhint/i)) {
    return {
      configured: true,
      linter: "htmlhint",
      details:
        "`htmlhint` is invoked by a GitHub Actions workflow. No action " +
        "required.",
    };
  }
  if (anyWorkflowMatches(ctx.workflows, /html-validate/i)) {
    return {
      configured: true,
      linter: "html-validate",
      details:
        "`html-validate` is invoked by a GitHub Actions workflow. No action " +
        "required.",
    };
  }
  return {
    configured: false,
    linter,
    details:
      "No GitHub Actions workflow invokes an HTML linter. The standard " +
      "choices are `htmlhint` and `html-validate`. Add a CI step such as " +
      '`npx htmlhint "**/*.html"` so malformed markup fails the build.',
  };
}

function checkActionlint(ctx: CheckContext): LinterCheckResult {
  const linter = "actionlint";
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter,
      details: missingWorkflowsDetail(linter, "GitHub Actions"),
      workflowsLoaded: false,
    };
  }
  if (anyWorkflowMatches(ctx.workflows, /actionlint/i)) {
    return {
      configured: true,
      linter,
      details:
        "`actionlint` is invoked by a GitHub Actions workflow, so workflow " +
        "syntax errors and shellcheck failures are caught before merge. No " +
        "action required.",
    };
  }
  return {
    configured: false,
    linter,
    details:
      "No GitHub Actions workflow invokes `actionlint`. `actionlint` is the " +
      "standard linter for workflow YAML — it catches syntax errors, " +
      "invalid expressions, and shellcheck issues inside `run:` blocks. " +
      "Add a step using `rhysd/actionlint@v1` (or `actionlint -color`) so " +
      "workflow regressions fail the build.",
  };
}

function checkCfnLint(ctx: CheckContext): LinterCheckResult {
  const linter = "cfn-lint";
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter,
      details: missingWorkflowsDetail(linter, "AWS CloudFormation"),
      workflowsLoaded: false,
    };
  }
  if (anyWorkflowMatches(ctx.workflows, /cfn-lint/i)) {
    return {
      configured: true,
      linter,
      details:
        "`cfn-lint` is invoked by a GitHub Actions workflow. No action " +
        "required.",
    };
  }
  return {
    configured: false,
    linter,
    details:
      "No GitHub Actions workflow invokes `cfn-lint`. `cfn-lint` is the " +
      "standard linter for AWS CloudFormation templates — it catches " +
      "schema errors, invalid intrinsic functions, and resource-property " +
      "mistakes before deployment. Add a CI step such as `cfn-lint " +
      "templates/**/*.yaml` so template regressions fail the build.",
  };
}

function checkTerraform(ctx: CheckContext): LinterCheckResult {
  const linter = "tflint";
  if (ctx.workflows.length === 0) {
    return {
      configured: false,
      linter,
      details: missingWorkflowsDetail(linter, "Terraform"),
      workflowsLoaded: false,
    };
  }
  if (anyWorkflowMatches(ctx.workflows, /\btflint\b/i)) {
    return {
      configured: true,
      linter,
      details: "`tflint` is invoked by a GitHub Actions workflow. No action " +
        "required.",
    };
  }
  const hasValidate = anyWorkflowMatches(
    ctx.workflows,
    /terraform\s+validate/i,
  );
  const hasFmtCheck = anyWorkflowMatches(
    ctx.workflows,
    /terraform\s+fmt[^\n]*-check/i,
  );
  if (hasValidate && hasFmtCheck) {
    return {
      configured: true,
      linter: "terraform validate + fmt -check",
      details:
        "`terraform validate` and `terraform fmt -check` are both invoked " +
        "by a GitHub Actions workflow, providing baseline Terraform " +
        "linting. No action required, though `tflint` would catch " +
        "additional provider-specific issues.",
    };
  }
  return {
    configured: false,
    linter,
    details:
      "No GitHub Actions workflow runs a Terraform linter. The standard " +
      "tool is `tflint`; the minimum acceptable alternative is to invoke " +
      "both `terraform validate` and `terraform fmt -check` in CI. Add a " +
      "step using `terraform-linters/setup-tflint@v4` followed by `tflint " +
      "--recursive` so HCL regressions fail the build.",
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function anyWorkflowMatches(
  workflows: LoadedWorkflow[],
  pattern: RegExp,
): boolean {
  // `invocations` is already lowercased at load time, so matching is
  // case-insensitive by construction — no need to rebuild the pattern.
  return workflows.some((w) => pattern.test(w.invocations));
}

/**
 * Build a `LinterCheckResult` for a bucket where BOTH a linter gate and
 * a compile gate must be present (Rust, TypeScript, React, Java).
 *
 * - When both gates are present the result is `configured: true` with
 *   the supplied happy-path message.
 * - When one or both are missing the result is `configured: false` and
 *   `details` names which gate(s) are missing, why it matters
 *   (linking back to issue #2175), and includes a concrete suggested
 *   invocation.
 *
 * The `*MissingPhrase` arguments are written as standalone clauses
 * (lowercase, no terminating punctuation) so they slot cleanly into
 * the "no X" / "no X and no Y" composition.
 */
function buildDualGateResult(args: {
  linter: string;
  languageLabel: string;
  lintInvoked: boolean;
  compileInvoked: boolean;
  bothPresentDetail: string;
  linterMissingPhrase: string;
  compileMissingPhrase: string;
}): LinterCheckResult {
  const gates = { linter: args.lintInvoked, compile: args.compileInvoked };
  if (args.lintInvoked && args.compileInvoked) {
    return {
      configured: true,
      linter: args.linter,
      details: args.bothPresentDetail,
      gates,
    };
  }

  const missingClauses: string[] = [];
  if (!args.lintInvoked) missingClauses.push(args.linterMissingPhrase);
  if (!args.compileInvoked) missingClauses.push(args.compileMissingPhrase);
  // Highlight headline at the start so a reader sees instantly which
  // gates are missing — the existing best-practices template renders
  // the first line into the issue title context.
  const headline = !args.lintInvoked && !args.compileInvoked
    ? "no linter and no compile gate"
    : !args.lintInvoked
    ? "no linter gate"
    : "no compile gate";
  return {
    configured: false,
    linter: args.linter,
    details: `${args.languageLabel} CI is missing ${headline}: ` +
      `${missingClauses.join("; AND ")}. Without both gates, lint and ` +
      "syntax regressions can land on main unnoticed (see issue #2175).",
    gates,
  };
}

function missingWorkflowsDetail(linter: string, languageLabel: string): string {
  return (
    `No GitHub Actions workflows were found under \`.github/workflows/\`, ` +
    `so the standard ${languageLabel} linter (${linter}) cannot be ` +
    "invoked in CI. Add a CI workflow that runs the linter on every push " +
    "and pull request so lint regressions fail the build."
  );
}
