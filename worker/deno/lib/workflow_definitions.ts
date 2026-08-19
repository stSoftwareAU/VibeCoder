/**
 * GitHub Actions workflow specifications per language.
 *
 * Defines the expected workflows that the setup process checks for
 * and recommends. Each specification includes detection patterns for
 * auditing existing workflows and template YAML for creating new ones.
 *
 * Issue #1392: Define expected GitHub Actions workflow specifications per language.
 */

import type { RepoVisibility } from "./repo_visibility.ts";
import {
  CANONICAL_MINIMUM_DEPENDENCY_AGE,
  INTERNAL_SCOPE_EXCLUDES,
} from "./deno_minimum_dependency_age.ts";
import { pinnedAction, SEMGREP_IMAGE } from "./pinned_actions.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Specification for a GitHub Actions workflow. */
export interface WorkflowSpec {
  /** Unique identifier, e.g. "gitleaks", "cargo-audit". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Which languages this applies to, or "universal" for all repos. */
  appliesTo: "universal" | string[];
  /** Trigger events (e.g. "pull_request", "schedule"). */
  triggers: string[];
  /**
   * Groups of detection patterns. A workflow is considered "present" when
   * at least one pattern from EACH group matches the workflow content.
   *
   * Semantics: groups are AND-combined; patterns within a group are
   * OR-combined (i.e. alternative valid implementations of the same
   * capability). A spec that requires all of `[A, B, C]` should be modelled
   * as `[["A"], ["B"], ["C"]]`. A spec that accepts any one of `[A, B, C]`
   * as the implementation should be modelled as `[["A", "B", "C"]]`.
   */
  detectionPatternGroups: string[][];
  /**
   * Human-readable capability label per detection group. Same length as
   * `detectionPatternGroups`; `capabilities[i]` describes the capability
   * that `detectionPatternGroups[i]` verifies (e.g. "Linting" for the
   * group `["cargo clippy", "clippy"]`). When absent or shorter than the
   * groups array, the rendering layer falls back to the first pattern in
   * the group as the label.
   */
  capabilities?: string[];
  /** Suggested workflow filename. */
  suggestedFilename: string;
  /** Template YAML content. */
  template: string;
  /** Category of the workflow. */
  category: "security" | "dependency-update" | "quality";
  /**
   * Repository visibilities for which this spec applies.
   *
   * - `"any"` (default when omitted) — apply to all repositories.
   * - `"public-only"` — apply only to public repositories. Specs that
   *   require a feature only available on public repos (e.g. GitHub
   *   Advanced Security's dependency-review action without a paid GHAS
   *   licence on private repos) should opt in to this scope so the
   *   workflow auditor does not raise issues against private repos.
   *
   * Issue #1753.
   */
  visibilityScope?: "any" | "public-only";
}

// ---------------------------------------------------------------------------
// Universal workflows (all repos)
// ---------------------------------------------------------------------------

const gitleaks: WorkflowSpec = {
  id: "gitleaks",
  name: "Gitleaks Secrets Detection",
  appliesTo: "universal",
  triggers: ["pull_request"],
  detectionPatternGroups: [["gitleaks/gitleaks-action", "gitleaks"]],
  capabilities: ["Secret scanning"],
  suggestedFilename: "gitleaks.yml",
  category: "security",
  // Mirrors the canonical pattern in stSoftwareAU/private-repo-14
  // (.github/workflows/quality.yml). gitleaks-action@v2 fails with
  // ErrLicense on organisation-owned repos when GITLEAKS_LICENSE is
  // unset (Issue #1636), so the licence env var is wired through.
  // Dependabot-authored PRs never receive Actions secrets, so the
  // licence is empty for them and the action would always fail
  // (Issue #2981) — for those licence-less runs we fall back to the
  // free, open-source gitleaks CLI, pinned by version and verified
  // against a published SHA-256 checksum. Third-party actions are
  // pinned to 40-character commit SHAs per the supply-chain hardening
  // policy (Issue #1756) — tag hijack on actions/checkout or
  // gitleaks-action would otherwise give an attacker access to every
  // secret available to CI.
  template: `name: Gitleaks

# Detect secrets in pull request diffs.
#
# Mirrors the canonical private-repo-14 pattern at
# stSoftwareAU/private-repo-14/.github/workflows/quality.yml. Third-party
# actions are pinned to 40-character commit SHAs (Issue #1756) so a
# hijacked tag cannot exfiltrate CI secrets.
#
# gitleaks-action@v2 requires an organisation licence (GITLEAKS_LICENSE)
# on org-owned repos. Dependabot-authored PRs do not receive Actions
# secrets, so the licence is empty for them and the action exits with
# ErrLicense (Issue #2981). For those licence-less runs we fall back to
# the free, open-source gitleaks CLI, which needs no licence.

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read
  pull-requests: read

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # Exposed at job level so step-level \`if:\` can branch on whether the
    # org licence secret is present — the \`secrets\` context is not
    # available in \`if:\` conditions, but \`env\` is.
    env:
      GITLEAKS_LICENSE: \${{ secrets.GITLEAKS_LICENSE }}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
        with:
          fetch-depth: 0
      # Fetch the PR base branch so the computed commit range
      # (\`<base_sha>..<head_sha>\`) resolves on the runner. Without this
      # step gitleaks fails with "fatal: Invalid revision range" because
      # the base ref is not in the shallow checkout (Issue #1756).
      # Mirrors the private-repo-14 quality.yml pattern.
      - name: Fetch base branch
        if: github.event_name == 'pull_request'
        env:
          BASE_REF: \${{ github.base_ref }}
        run: git fetch origin "$BASE_REF:$BASE_REF" || true
      # Licensed path: when the org Gitleaks Pro licence (Issue #1636) is
      # available, use the upstream action so the licence is applied.
      - name: Gitleaks (licensed action)
        if: env.GITLEAKS_LICENSE != ''
        uses: ${pinnedAction("gitleaks/gitleaks-action")}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_LICENSE: \${{ secrets.GITLEAKS_LICENSE }}
      # Licence-less fallback (e.g. Dependabot PRs, Issue #2981): the free
      # open-source gitleaks CLI needs no licence. It scans the PR commit
      # range, mirroring the action's diff scan.
      - name: Gitleaks (open-source CLI fallback)
        if: env.GITLEAKS_LICENSE == ''
        env:
          GITLEAKS_VERSION: "8.30.1"
          GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          set -euo pipefail
          archive="gitleaks_\${GITLEAKS_VERSION}_linux_x64.tar.gz"
          url="https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/\${archive}"
          curl -sSfL "$url" -o "$archive"
          echo "\${GITLEAKS_SHA256}  \${archive}" | sha256sum -c -
          tar -xzf "$archive" gitleaks
          ./gitleaks git --redact --no-banner --exit-code 1 \\
            --log-opts="\${BASE_SHA}..\${HEAD_SHA}" .
`,
};

const semgrep: WorkflowSpec = {
  id: "semgrep",
  name: "Semgrep SAST Scanning",
  appliesTo: "universal",
  triggers: ["pull_request"],
  detectionPatternGroups: [["semgrep/semgrep-action", "semgrep"]],
  capabilities: ["SAST scanning"],
  suggestedFilename: "semgrep.yml",
  category: "security",
  // The container image is pinned to an immutable digest — identical to
  // this repository's own .github/workflows/semgrep.yml — so a hijacked
  // `latest` tag cannot run with SEMGREP_APP_TOKEN in scope (Issue #3645).
  template: `name: Semgrep

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read

jobs:
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: ${SEMGREP_IMAGE}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - run: semgrep ci --config p/default
        env:
          SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
`,
};

// actions/dependency-review-action runs free on public repos but requires
// GitHub Advanced Security (GHAS) on private repos. Marking this spec
// `visibilityScope: "public-only"` keeps workflow-sync from raising it
// against private repos where it would be a permanently failing check.
// (Issues #1656 — original removal; #1753 — visibility-aware filter;
//  #1754 — re-introduction as public-only.)
const dependencyReview: WorkflowSpec = {
  id: "dependency-review",
  name: "Dependency Review",
  appliesTo: "universal",
  visibilityScope: "public-only",
  triggers: ["pull_request"],
  detectionPatternGroups: [[
    "actions/dependency-review-action",
    "dependency-review-action",
  ]],
  capabilities: ["Dependency vulnerability and licence review"],
  suggestedFilename: "dependency-review.yml",
  category: "security",
  // Mirrors the canonical template documented in the archived
  // pr-summary-1634 — the detection patterns are unchanged, so workflow
  // files copied from that PR keep classifying as `present` — with the
  // actions pinned to commit SHAs (Issue #3645).
  template: `name: Dependency Review

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("actions/dependency-review-action")}
`,
};

// ---------------------------------------------------------------------------
// Rust workflows
// ---------------------------------------------------------------------------

const cargoAudit: WorkflowSpec = {
  id: "cargo-audit",
  name: "Cargo Security Audit",
  appliesTo: ["Rust"],
  triggers: ["pull_request", "schedule"],
  detectionPatternGroups: [[
    "cargo audit",
    "cargo-audit",
    "rustsec/audit-check",
  ]],
  capabilities: ["Cargo security audit"],
  suggestedFilename: "cargo-audit.yml",
  category: "security",
  template: `name: Cargo Audit

on:
  pull_request:
    branches: ["*"]
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      # SHA-pinned, so the toolchain can no longer be read from the ref
      # name — it is named explicitly instead (Issue #3645).
      - uses: ${pinnedAction("dtolnay/rust-toolchain")}
        with:
          toolchain: stable
      - run: cargo install cargo-audit
      - run: cargo audit
`,
};

const cargoUpgrade: WorkflowSpec = {
  id: "cargo-upgrade",
  name: "Cargo Dependency Updates",
  appliesTo: ["Rust"],
  triggers: ["schedule", "workflow_dispatch"],
  detectionPatternGroups: [["cargo upgrade", "cargo-edit", "cargo update"]],
  capabilities: ["Cargo dependency update"],
  suggestedFilename: "cargo-upgrade.yml",
  category: "dependency-update",
  template: `name: Cargo Dependency Updates

on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      # SHA-pinned, so the toolchain can no longer be read from the ref
      # name — it is named explicitly instead (Issue #3645).
      - uses: ${pinnedAction("dtolnay/rust-toolchain")}
        with:
          toolchain: stable
      - run: cargo install cargo-edit
      - run: cargo upgrade
      - run: cargo update
      - uses: ${pinnedAction("peter-evans/create-pull-request")}
        with:
          # Org-level PAT (Issue #1636); falls back to GITHUB_TOKEN when
          # the secret is unset. Using the PAT ensures downstream PR
          # workflows fire on the resulting pull request.
          token: \${{ secrets.ACTIONS_PUSH || secrets.GITHUB_TOKEN }}
          commit-message: "chore: update Cargo dependencies"
          title: "chore: update Cargo dependencies"
          branch: chore/cargo-upgrade
          body: "Automated Cargo dependency update via cargo-edit."
`,
};

const cargoQuality: WorkflowSpec = {
  id: "cargo-quality",
  name: "Cargo Format and Clippy",
  appliesTo: ["Rust"],
  triggers: ["pull_request"],
  detectionPatternGroups: [
    ["cargo fmt", "rustfmt"],
    ["cargo clippy", "clippy"],
  ],
  capabilities: [
    "Format check (cargo fmt or rustfmt)",
    "Lint check (cargo clippy or clippy)",
  ],
  suggestedFilename: "cargo-quality.yml",
  category: "quality",
  template: `name: Cargo Quality

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      # SHA-pinned, so the toolchain can no longer be read from the ref
      # name — it is named explicitly instead (Issue #3645).
      - uses: ${pinnedAction("dtolnay/rust-toolchain")}
        with:
          toolchain: stable
          components: rustfmt, clippy
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings
      # Run tests with coverage and upload to Codecov (Issue #1636).
      # SHA-pinned, so the tool is named explicitly rather than read from
      # the ref name (Issue #3645).
      - uses: ${pinnedAction("taiki-e/install-action")}
        with:
          tool: cargo-llvm-cov
      - run: cargo llvm-cov --lcov --output-path lcov.info
      - uses: ${pinnedAction("codecov/codecov-action")}
        with:
          files: lcov.info
          token: \${{ secrets.CODECOV_TOKEN }}
          fail_ci_if_error: false
`,
};

// ---------------------------------------------------------------------------
// Deno workflows
// ---------------------------------------------------------------------------

const denoOutdated: WorkflowSpec = {
  id: "deno-outdated",
  name: "Deno Dependency Updates",
  appliesTo: ["Deno"],
  triggers: ["schedule", "workflow_dispatch"],
  detectionPatternGroups: [["deno outdated", "deno-outdated"]],
  capabilities: ["Deno outdated dependency check"],
  suggestedFilename: "deno-outdated.yml",
  category: "dependency-update",
  template: `name: Deno Dependency Updates

on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  outdated:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("denoland/setup-deno")}
        with:
          deno-version: v2.x
      # Supply-chain quarantine via native Deno tooling (Issues #2540, #2539):
      # external Deno deps must be at least 24h old (${CANONICAL_MINIMUM_DEPENDENCY_AGE} floor).
      # Internal stSoftwareAU scopes (${INTERNAL_SCOPE_EXCLUDES.join(", ")})
      # update immediately (0h) — exempt via this repo's deno.json
      # minimumDependencyAge.exclude list. No custom quarantine script.
      - run: deno outdated --update --latest --minimum-dependency-age=${CANONICAL_MINIMUM_DEPENDENCY_AGE}
      - uses: ${pinnedAction("peter-evans/create-pull-request")}
        with:
          # Org-level PAT (Issue #1636); falls back to GITHUB_TOKEN when
          # the secret is unset. Using the PAT ensures downstream PR
          # workflows fire on the resulting pull request.
          token: \${{ secrets.ACTIONS_PUSH || secrets.GITHUB_TOKEN }}
          commit-message: "chore: update Deno dependencies"
          title: "chore: update Deno dependencies"
          branch: chore/deno-outdated
          body: "Automated Deno dependency update via deno outdated."
`,
};

const denoQuality: WorkflowSpec = {
  id: "deno-quality",
  name: "Deno Lint and Format",
  appliesTo: ["Deno"],
  triggers: ["pull_request"],
  detectionPatternGroups: [["deno lint"], ["deno fmt"], ["deno check"]],
  capabilities: ["Linting", "Formatting", "Type checking"],
  suggestedFilename: "deno-quality.yml",
  category: "quality",
  template: `name: Deno Quality

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("denoland/setup-deno")}
        with:
          deno-version: v2.x
      - run: deno lint
      - run: deno fmt --check
      - run: deno check mod.ts
      # Run tests with coverage and upload to Codecov (Issue #1636).
      # The codecov-action is a no-op when no test files are found.
      - run: deno test --allow-read --allow-env --coverage=cov_profile
      - run: deno coverage cov_profile --lcov --output=coverage.lcov
      - uses: ${pinnedAction("codecov/codecov-action")}
        with:
          files: coverage.lcov
          token: \${{ secrets.CODECOV_TOKEN }}
          fail_ci_if_error: false
`,
};

// ---------------------------------------------------------------------------
// Node workflows
// ---------------------------------------------------------------------------

const npmAudit: WorkflowSpec = {
  id: "npm-audit",
  name: "NPM Security Audit",
  appliesTo: ["Node", "React/Web"],
  triggers: ["pull_request", "schedule"],
  detectionPatternGroups: [["npm audit", "npm-audit", "audit-ci"]],
  capabilities: ["NPM security audit"],
  suggestedFilename: "npm-audit.yml",
  category: "security",
  template: `name: NPM Audit

on:
  pull_request:
    branches: ["*"]
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("actions/setup-node")}
        with:
          node-version: "lts/*"
      - run: npm ci
      - run: npm audit --audit-level=high
`,
};

const npmDependencyUpdates: WorkflowSpec = {
  id: "npm-dependency-updates",
  name: "NPM Dependency Updates",
  appliesTo: ["Node", "React/Web"],
  triggers: ["schedule"],
  detectionPatternGroups: [[
    "dependabot",
    "renovate",
    "npm-check-updates",
    "ncu",
  ]],
  capabilities: ["Automated dependency updates"],
  suggestedFilename: "dependabot.yml",
  category: "dependency-update",
  template: `# Dependabot configuration (place in .github/dependabot.yml)
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    labels:
      - dependencies
`,
};

const eslintQuality: WorkflowSpec = {
  id: "eslint-quality",
  name: "ESLint Code Quality",
  appliesTo: ["Node", "React/Web"],
  triggers: ["pull_request"],
  detectionPatternGroups: [["eslint", "npx eslint", "npm run lint"]],
  capabilities: ["ESLint linting"],
  suggestedFilename: "eslint.yml",
  category: "quality",
  template: `name: ESLint

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("actions/setup-node")}
        with:
          node-version: "lts/*"
      - run: npm ci
      - run: npx eslint .
`,
};

// ---------------------------------------------------------------------------
// Java workflows
// ---------------------------------------------------------------------------

const javaDependencyCheck: WorkflowSpec = {
  id: "java-dependency-check",
  name: "Java Dependency Security Check",
  appliesTo: ["Java"],
  triggers: ["pull_request", "schedule"],
  detectionPatternGroups: [[
    "owasp",
    "dependency-check",
    "mvn dependency:check",
    "org.owasp",
  ]],
  capabilities: ["Dependency vulnerability scan"],
  suggestedFilename: "java-dependency-check.yml",
  category: "security",
  template: `name: Java Dependency Check

on:
  pull_request:
    branches: ["*"]
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read

jobs:
  dependency-check:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("actions/setup-java")}
        with:
          distribution: temurin
          java-version: "21"
      - name: OWASP Dependency Check
        uses: ${pinnedAction("dependency-check/Dependency-Check_Action")}
        with:
          project: \${{ github.repository }}
          path: .
          format: HTML
      - uses: ${pinnedAction("actions/upload-artifact")}
        with:
          name: dependency-check-report
          path: reports/
`,
};

const javaDependencyUpdates: WorkflowSpec = {
  id: "java-dependency-updates",
  name: "Java Dependency Updates",
  appliesTo: ["Java"],
  triggers: ["schedule"],
  detectionPatternGroups: [[
    "dependabot",
    "renovate",
    "versions-maven-plugin",
    "gradle-versions-plugin",
  ]],
  capabilities: ["Automated dependency updates"],
  suggestedFilename: "java-dependabot.yml",
  category: "dependency-update",
  template:
    `# Dependabot configuration for Maven/Gradle (place in .github/dependabot.yml)
version: 2
updates:
  - package-ecosystem: maven
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    labels:
      - dependencies
`,
};

// ---------------------------------------------------------------------------
// Universal Markdown workflows
// ---------------------------------------------------------------------------

const markdownLint: WorkflowSpec = {
  id: "markdown-lint",
  name: "Markdown Lint",
  appliesTo: "universal",
  triggers: ["pull_request", "push"],
  detectionPatternGroups: [["markdownlint-cli2", "markdownlint"]],
  capabilities: ["Markdown structural linting"],
  suggestedFilename: "markdown-lint.yml",
  category: "quality",
  // Triggers on PRs and pushes to the default branch. Pins third-party
  // actions to commit SHAs (Issue #1686) so a hijacked tag cannot inject
  // code into CI. Reuses the same `.markdownlint-cli2.jsonc` configuration
  // that local `quality.sh` consumes — single source of truth, no drift.
  // The optional Mermaid step mirrors the local `check-mermaid` quality
  // gate (Issue #1683); it runs only when `worker/deno/mod.ts` is present.
  template: `name: Markdown Lint

on:
  pull_request:
    branches: ["*"]
  push:
    branches: [main, master]

permissions:
  contents: read

jobs:
  markdownlint:
    runs-on: ubuntu-latest
    steps:
      # checkout and setup-node run on the Node 24 runtime (Issues #2316,
      # #2317); the v4 line ran on Node 20, deprecated for forced upgrade
      # 2026-06-02 and full removal 2026-09-16.
      - uses: ${pinnedAction("actions/checkout")}
      - uses: ${pinnedAction("actions/setup-node")}
        with:
          node-version: "lts/*"
      - name: Install markdownlint-cli2
        run: npm install -g markdownlint-cli2
      - name: Run markdownlint-cli2
        run: markdownlint-cli2
      # Optional: mirror the local check-mermaid quality gate when Deno
      # and the worker module are available in the repo (Issue #1683).
      - name: Detect Deno worker module
        id: detect-deno
        run: |
          if [ -f worker/deno/mod.ts ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
          else
            echo "present=false" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.detect-deno.outputs.present == 'true'
        uses: ${pinnedAction("denoland/setup-deno")}
        with:
          deno-version: v2.x
      - if: steps.detect-deno.outputs.present == 'true'
        name: Validate Mermaid blocks
        run: deno run --allow-read --allow-env=DEBUG,LOG_LEVEL,CONFIG_PATH,OUTPUT_JSON worker/deno/mod.ts check-mermaid
`,
};

// ---------------------------------------------------------------------------
// Bash workflows
// ---------------------------------------------------------------------------

const shellcheck: WorkflowSpec = {
  id: "shellcheck",
  name: "ShellCheck Lint",
  appliesTo: ["Bash"],
  triggers: ["pull_request"],
  detectionPatternGroups: [[
    "shellcheck",
    "koalaman/shellcheck",
    "ludeeus/action-shellcheck",
  ]],
  capabilities: ["Shell script linting"],
  suggestedFilename: "shellcheck.yml",
  category: "quality",
  template: `name: ShellCheck

on:
  pull_request:
    branches: ["*"]

permissions:
  contents: read

jobs:
  shellcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: ${pinnedAction("actions/checkout")}
      - name: Run ShellCheck
        uses: ${pinnedAction("ludeeus/action-shellcheck")}
        with:
          scandir: .
          severity: warning
`,
};

// ---------------------------------------------------------------------------
// Exported catalogue
// ---------------------------------------------------------------------------

/** Complete catalogue of all workflow specifications. */
export const WORKFLOW_SPECS: ReadonlyArray<WorkflowSpec> = [
  // Universal
  gitleaks,
  semgrep,
  dependencyReview,
  markdownLint,
  // Rust
  cargoAudit,
  cargoUpgrade,
  cargoQuality,
  // Deno
  denoOutdated,
  denoQuality,
  // Node (also covers React/Web)
  npmAudit,
  npmDependencyUpdates,
  eslintQuality,
  // Java
  javaDependencyCheck,
  javaDependencyUpdates,
  // Bash
  shellcheck,
];

/**
 * Resolve a human-readable capability label for a detection-pattern group.
 *
 * Looks up the matching `capabilities[i]` entry in the spec when the group
 * appears in `spec.detectionPatternGroups`. Falls back to the first pattern
 * in the group when no explicit label is configured, so older specs that
 * predate the `capabilities` field still produce a readable bullet rather
 * than an empty string.
 */
export function capabilityLabelForGroup(
  spec: WorkflowSpec,
  group: string[],
): string {
  const idx = spec.detectionPatternGroups.findIndex(
    (g) => g.length === group.length && g.every((p, i) => p === group[i]),
  );
  if (idx >= 0 && spec.capabilities && spec.capabilities[idx]) {
    return spec.capabilities[idx]!;
  }
  return group[0] ?? "Detection pattern";
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Return workflow specs relevant to the given languages.
 *
 * Always includes universal specs. Language-specific specs are included
 * when at least one of the spec's `appliesTo` languages matches the
 * requested set.
 */
export function getWorkflowsForLanguages(
  languages: string[],
): WorkflowSpec[] {
  const langSet = new Set(languages);
  const seen = new Set<string>();
  const result: WorkflowSpec[] = [];

  for (const spec of WORKFLOW_SPECS) {
    if (seen.has(spec.id)) continue;

    if (spec.appliesTo === "universal") {
      seen.add(spec.id);
      result.push(spec);
      continue;
    }

    // Language-specific: include if any of the spec's languages match.
    const matches = spec.appliesTo.some((lang) => langSet.has(lang));
    if (matches) {
      seen.add(spec.id);
      result.push(spec);
    }
  }

  return result;
}

/**
 * Return workflow specs relevant to the given languages, filtered by
 * repository visibility.
 *
 * Delegates to {@link getWorkflowsForLanguages} and then drops any spec
 * marked `visibilityScope: "public-only"` when `visibility === "private"`.
 * Specs without an explicit `visibilityScope` are treated as `"any"` and
 * always pass the filter.
 *
 * Issue #1753.
 */
export function getWorkflowsForLanguagesAndVisibility(
  languages: string[],
  visibility: RepoVisibility,
): WorkflowSpec[] {
  const specs = getWorkflowsForLanguages(languages);
  if (visibility === "public") {
    return specs;
  }
  return specs.filter((s) => s.visibilityScope !== "public-only");
}
