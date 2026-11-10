/**
 * GitHub Actions workflow specifications per language.
 *
 * Defines the expected workflows that the setup process checks for
 * and recommends. Each specification includes detection patterns for
 * auditing existing workflows and template YAML for creating new ones.
 *
 * Issue #1392: Define expected GitHub Actions workflow specifications per language.
 */ import { CANONICAL_MINIMUM_DEPENDENCY_AGE, INTERNAL_SCOPE_EXCLUDES } from "./deno_minimum_dependency_age.ts";
import { pinnedAction, SEMGREP_IMAGE } from "./pinned_actions.ts";
// ---------------------------------------------------------------------------
// Shared hardening fragments (Issue #1639)
// ---------------------------------------------------------------------------
//
// The fleet's own GitHub Actions audit scans every repository it monitors,
// including the ones it has just provisioned. Before Issue #1639 only the
// gitleaks template (Issue #594) was shaped to pass that audit, so a freshly
// set-up repository immediately accrued a pile of audit issues against
// workflows the fleet itself had written. These fragments carry the audit's
// requirements into every template, and
// `worker/deno/tests/workflow_template_audit_conformance_test.ts` runs the
// audit's own native pre-filers over the rendered templates so the two
// cannot drift apart.
/**
 * Explicit `pull_request` target branches.
 *
 * A GitHub branch filter `*` never matches a `/`, so the former `["*"]` read
 * as "every branch" while silently skipping every `milestone/<slug>` PR
 * (Issue #1300) — the dominant merge path in this fleet. The targets are
 * listed explicitly instead, which is what the milestone-branch-filter
 * pre-filer requires.
 */ const PULL_REQUEST_BRANCHES = "[Develop, main, milestone/*]";
/**
 * Cancelling concurrency group (audit check #4). Only the latest run for a
 * given ref matters, so cancellation stops rapid pushes — or overlapping
 * scheduled runs — spawning parallel, redundant work.
 */ const CONCURRENCY_BLOCK = `# Only the latest run for a given ref matters, so a per-ref group with
# cancellation stops rapid pushes (or overlapping scheduled runs)
# spawning parallel, redundant work.
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true`;
/**
 * Job timeout for scan and quality jobs (audit check #5). Without an
 * explicit timeout a wedged job holds a runner for GitHub's six-hour
 * default.
 */ const SCAN_TIMEOUT_MINUTES = 10;
/**
 * Job timeout for dependency-update jobs, which resolve the whole
 * dependency graph and then open a pull request.
 */ const DEPENDENCY_UPDATE_TIMEOUT_MINUTES = 20;
/**
 * Checkout `with:` block for a job that only reads the repository.
 *
 * By default `actions/checkout` writes the workflow's `GITHUB_TOKEN` into
 * `.git/config`, where any later step — including a compromised dependency —
 * can read it. A scan/build/lint job never needs that, so the credential is
 * not left on disk.
 */ const CHECKOUT_NO_CREDENTIALS = `        with:
          # The checkout credential is not needed, so do not leave it in
          # .git/config where a later step could read it.
          persist-credentials: false`;
/**
 * Exact `markdownlint-cli2` version installed by the Markdown lint template.
 *
 * A `run:` install is not a manifest, so no dependency manager governs it —
 * an unpinned install resolves to whatever the registry serves at run time,
 * outside the 24h supply-chain quarantine. Bump this in lock-step with
 * `container/tools.json` and `.github/workflows/markdown-lint.yml`.
 */ const MARKDOWNLINT_CLI2_VERSION = "0.24.0";
/**
 * Exact `cargo-audit` version installed by the cargo-audit template.
 *
 * A `run:` install is not a manifest, so no dependency manager governs it.
 * `--locked` makes cargo use the crate's own `Cargo.lock` instead of
 * re-resolving its dependency tree to the newest crates.io releases on every
 * run, which would otherwise land outside the 24h supply-chain quarantine.
 * Bump in lock-step with `.github/workflows/cargo-audit.yml`, which tests keep
 * equal to this constant, so bumps stay deliberate.
 */ const CARGO_AUDIT_VERSION = "0.22.2";
/**
 * Exact `cargo-edit` version installed by the cargo-upgrade template.
 *
 * A `run:` install is not a manifest, so no dependency manager governs it.
 * `--locked` makes cargo use the crate's own `Cargo.lock` instead of
 * re-resolving its dependency tree to the newest crates.io releases on every
 * run, which would otherwise land outside the 24h supply-chain quarantine.
 * Bump in lock-step with `.github/workflows/cargo-upgrade.yml`, which tests keep
 * equal to this constant, so bumps stay deliberate.
 */ const CARGO_EDIT_VERSION = "0.13.14";
// ---------------------------------------------------------------------------
// Universal workflows (all repos)
// ---------------------------------------------------------------------------
const gitleaks = {
  id: "gitleaks",
  name: "Gitleaks Secrets Detection",
  appliesTo: "universal",
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "gitleaks/gitleaks-action",
      "gitleaks"
    ]
  ],
  capabilities: [
    "Secret scanning"
  ],
  suggestedFilename: "gitleaks.yml",
  category: "security",
  // Mirrors the canonical pattern in stSoftwareAU/private-repo-14
  // (.github/workflows/quality.yml). gitleaks-action@v3 fails with
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
  // secret available to CI. Issue #594 refreshed the template against
  // this repository's own gitleaks.yml: milestone-aware branch filter,
  // credential persistence disabled on checkout, and a cancelling
  // concurrency group. `worker/deno/tests/gitleaks_template_conformance_test.ts`
  // locks those invariants.
  template: `name: Gitleaks

# Detect secrets in pull request diffs.
#
# Mirrors the canonical private-repo-14 pattern at
# stSoftwareAU/private-repo-14/.github/workflows/quality.yml. Third-party
# actions are pinned to 40-character commit SHAs (Issue #1756) so a
# hijacked tag cannot exfiltrate CI secrets.
#
# gitleaks-action@v3 requires an organisation licence (GITLEAKS_LICENSE)
# on org-owned repos (v2 behaved the same way). Dependabot-authored PRs
# do not receive Actions secrets, so the licence is empty for them and
# the action exits with ErrLicense before scanning (Issue #2981). For
# those licence-less runs we fall back to the free, open-source gitleaks
# CLI, which needs no licence.
#
# Deliberately omitted (Issue #594) so the template runs unmodified on a
# freshly set-up repository, which has neither of them yet:
#   - the \`environment: scanning-secrets\` gate this repository's own copy
#     uses to scope the licence secret — add it once the GitHub
#     Environment exists;
#   - \`GITLEAKS_CONFIG: .github/gitleaks.toml\` — add it once the repo
#     commits an allowlist config, and pass \`--config\` to the CLI
#     fallback so both scanners share it.

on:
  pull_request:
    # A GitHub branch filter \`*\` never matches a \`/\`, so the former
    # \`["*"]\` read as "every branch" while silently skipping every
    # \`milestone/<slug>\` PR (Issue #1300) — the dominant merge path. The
    # targets are listed explicitly instead (Issues #3360, #594).
    branches: [Develop, main, milestone/*]

permissions:
  contents: read
  pull-requests: read

# Only the latest commit's result matters for a PR check, so a per-ref
# group with cancellation stops rapid pushes spawning parallel,
# redundant runs (Issue #2972).
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

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
          # Nothing here pushes, so the job token must not be left behind
          # in .git/config where a later step could read it.
          persist-credentials: false
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
`
};
const semgrep = {
  id: "semgrep",
  name: "Semgrep SAST Scanning",
  appliesTo: "universal",
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "semgrep/semgrep-action",
      "semgrep"
    ]
  ],
  capabilities: [
    "SAST scanning"
  ],
  suggestedFilename: "semgrep.yml",
  category: "security",
  // The container image is pinned to an immutable digest — identical to
  // this repository's own .github/workflows/semgrep.yml — so a hijacked
  // `latest` tag cannot run in CI (Issue #3645). No SEMGREP_APP_TOKEN is
  // passed: `semgrep ci` exits fatally when a token is combined with an
  // explicit `--config` (Issue #4341; semgrep v1.173.0
  // cli/src/semgrep/commands/ci.py), so the scan stays a plain p/default
  // scan like the local gate stage in semgrep_check.ts.
  template: `name: Semgrep

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  semgrep:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    container:
      image: ${SEMGREP_IMAGE}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - run: semgrep ci --config p/default
`
};
// actions/dependency-review-action runs free on public repos but requires
// GitHub Advanced Security (GHAS) on private repos. Marking this spec
// `visibilityScope: "public-only"` keeps workflow-sync from raising it
// against private repos where it would be a permanently failing check.
// (Issues #1656 — original removal; #1753 — visibility-aware filter;
//  #1754 — re-introduction as public-only.)
const dependencyReview = {
  id: "dependency-review",
  name: "Dependency Review",
  appliesTo: "universal",
  visibilityScope: "public-only",
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "actions/dependency-review-action",
      "dependency-review-action"
    ]
  ],
  capabilities: [
    "Dependency vulnerability and licence review"
  ],
  suggestedFilename: "dependency-review.yml",
  category: "security",
  // Mirrors the canonical template documented in the archived
  // pr-summary-1634 — the detection patterns are unchanged, so workflow
  // files copied from that PR keep classifying as `present` — with the
  // actions pinned to commit SHAs (Issue #3645).
  template: `name: Dependency Review

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - uses: ${pinnedAction("actions/dependency-review-action")}
`
};
// ---------------------------------------------------------------------------
// Rust workflows
// ---------------------------------------------------------------------------
const cargoAudit = {
  id: "cargo-audit",
  name: "Cargo Security Audit",
  appliesTo: [
    "Rust"
  ],
  rootProjectMarkers: [
    "Cargo.toml"
  ],
  triggers: [
    "pull_request",
    "schedule"
  ],
  detectionPatternGroups: [
    [
      "cargo audit",
      "cargo-audit",
      "rustsec/audit-check"
    ]
  ],
  capabilities: [
    "Cargo security audit"
  ],
  suggestedFilename: "cargo-audit.yml",
  category: "security",
  template: `name: Cargo Audit

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      # SHA-pinned, so the toolchain can no longer be read from the ref
      # name — it is named explicitly instead (Issue #3645).
      - uses: ${pinnedAction("dtolnay/rust-toolchain")}
        with:
          toolchain: stable
      - run: cargo install --locked cargo-audit --version ${CARGO_AUDIT_VERSION}
      - run: cargo audit
`
};
const cargoUpgrade = {
  id: "cargo-upgrade",
  name: "Cargo Dependency Updates",
  appliesTo: [
    "Rust"
  ],
  rootProjectMarkers: [
    "Cargo.toml"
  ],
  triggers: [
    "schedule",
    "workflow_dispatch"
  ],
  detectionPatternGroups: [
    [
      "cargo upgrade",
      "cargo-edit",
      "cargo update"
    ]
  ],
  capabilities: [
    "Cargo dependency update"
  ],
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

${CONCURRENCY_BLOCK}

jobs:
  upgrade:
    runs-on: ubuntu-latest
    timeout-minutes: ${DEPENDENCY_UPDATE_TIMEOUT_MINUTES}
    steps:
      # create-pull-request pushes with its own \`token\` input, so the checkout
      # credential is not needed and is not persisted.
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      # SHA-pinned, so the toolchain can no longer be read from the ref
      # name — it is named explicitly instead (Issue #3645).
      - uses: ${pinnedAction("dtolnay/rust-toolchain")}
        with:
          toolchain: stable
      - run: cargo install --locked cargo-edit --version ${CARGO_EDIT_VERSION}
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
`
};
const cargoQuality = {
  id: "cargo-quality",
  name: "Cargo Format and Clippy",
  appliesTo: [
    "Rust"
  ],
  rootProjectMarkers: [
    "Cargo.toml"
  ],
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "cargo fmt",
      "rustfmt"
    ],
    [
      "cargo clippy",
      "clippy"
    ]
  ],
  capabilities: [
    "Format check (cargo fmt or rustfmt)",
    "Lint check (cargo clippy or clippy)"
  ],
  suggestedFilename: "cargo-quality.yml",
  category: "quality",
  template: `name: Cargo Quality

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
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
`
};
// ---------------------------------------------------------------------------
// Deno workflows
// ---------------------------------------------------------------------------
const denoOutdated = {
  id: "deno-outdated",
  name: "Deno Dependency Updates",
  appliesTo: [
    "Deno"
  ],
  rootProjectMarkers: [
    "deno.json",
    "deno.jsonc"
  ],
  triggers: [
    "schedule",
    "workflow_dispatch"
  ],
  detectionPatternGroups: [
    [
      "deno outdated",
      "deno-outdated"
    ]
  ],
  capabilities: [
    "Deno outdated dependency check"
  ],
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

${CONCURRENCY_BLOCK}

jobs:
  outdated:
    runs-on: ubuntu-latest
    timeout-minutes: ${DEPENDENCY_UPDATE_TIMEOUT_MINUTES}
    steps:
      # create-pull-request pushes with its own \`token\` input, so the checkout
      # credential is not needed and is not persisted.
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
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
`
};
const denoQuality = {
  id: "deno-quality",
  name: "Deno Lint and Format",
  appliesTo: [
    "Deno"
  ],
  rootProjectMarkers: [
    "deno.json",
    "deno.jsonc"
  ],
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "deno lint"
    ],
    [
      "deno fmt"
    ],
    [
      "deno check"
    ]
  ],
  capabilities: [
    "Linting",
    "Formatting",
    "Type checking"
  ],
  suggestedFilename: "deno-quality.yml",
  category: "quality",
  template: `name: Deno Quality

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - uses: ${pinnedAction("denoland/setup-deno")}
        with:
          deno-version: v2.x
      - run: deno lint
      - run: deno fmt --check
      - run: deno check .
      # Run tests with coverage and upload to Codecov (Issue #1636).
      # The codecov-action is a no-op when no test files are found.
      - run: deno test --allow-read --allow-env --coverage=cov_profile
      - run: deno coverage cov_profile --lcov --output=coverage.lcov
      - uses: ${pinnedAction("codecov/codecov-action")}
        with:
          files: coverage.lcov
          token: \${{ secrets.CODECOV_TOKEN }}
          fail_ci_if_error: false
`
};
// ---------------------------------------------------------------------------
// Node workflows
// ---------------------------------------------------------------------------
const npmAudit = {
  id: "npm-audit",
  name: "NPM Security Audit",
  appliesTo: [
    "Node",
    "React/Web"
  ],
  rootProjectMarkers: [
    "package.json"
  ],
  triggers: [
    "pull_request",
    "schedule"
  ],
  detectionPatternGroups: [
    [
      "npm audit",
      "npm-audit",
      "audit-ci"
    ]
  ],
  capabilities: [
    "NPM security audit"
  ],
  suggestedFilename: "npm-audit.yml",
  category: "security",
  template: `name: NPM Audit

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - uses: ${pinnedAction("actions/setup-node")}
        with:
          node-version: "lts/*"
      - run: npm ci
      - run: npm audit --audit-level=high
`
};
const npmDependencyUpdates = {
  id: "npm-dependency-updates",
  name: "NPM Dependency Updates",
  appliesTo: [
    "Node",
    "React/Web"
  ],
  rootProjectMarkers: [
    "package.json"
  ],
  triggers: [
    "schedule"
  ],
  detectionPatternGroups: [
    [
      "dependabot",
      "renovate",
      "npm-check-updates",
      "ncu"
    ]
  ],
  capabilities: [
    "Automated dependency updates"
  ],
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
`
};
const eslintQuality = {
  id: "eslint-quality",
  name: "ESLint Code Quality",
  appliesTo: [
    "Node",
    "React/Web"
  ],
  rootProjectMarkers: [
    "package.json"
  ],
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "eslint",
      "npx eslint",
      "npm run lint"
    ]
  ],
  capabilities: [
    "ESLint linting"
  ],
  suggestedFilename: "eslint.yml",
  category: "quality",
  template: `name: ESLint

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - uses: ${pinnedAction("actions/setup-node")}
        with:
          node-version: "lts/*"
      - run: npm ci
      - run: npx eslint .
`
};
// ---------------------------------------------------------------------------
// Java workflows
// ---------------------------------------------------------------------------
const javaDependencyCheck = {
  id: "java-dependency-check",
  name: "Java Dependency Security Check",
  appliesTo: [
    "Java"
  ],
  triggers: [
    "pull_request",
    "schedule"
  ],
  detectionPatternGroups: [
    [
      "owasp",
      "dependency-check",
      "mvn dependency:check",
      "org.owasp"
    ]
  ],
  capabilities: [
    "Dependency vulnerability scan"
  ],
  suggestedFilename: "java-dependency-check.yml",
  category: "security",
  template: `name: Java Dependency Check

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}
  schedule:
    - cron: "0 6 * * 1"

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  dependency-check:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
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
`
};
// Maven and Gradle are split into separate specs so each one is keyed to its
// own root build file and detects only its own Dependabot ecosystem entry. A
// repo with both build files needs both `updates` entries in the one
// .github/dependabot.yml.
const javaDependencyUpdates = {
  id: "java-dependency-updates",
  name: "Java Maven Dependency Updates",
  appliesTo: [
    "Java"
  ],
  rootProjectMarkers: [
    "pom.xml"
  ],
  triggers: [
    "schedule"
  ],
  detectionPatternGroups: [
    [
      "package-ecosystem: maven",
      'package-ecosystem: "maven"',
      "renovate",
      "versions-maven-plugin"
    ]
  ],
  capabilities: [
    "Automated dependency updates"
  ],
  suggestedFilename: "java-dependabot.yml",
  category: "dependency-update",
  template: `# Dependabot configuration for Maven (place in .github/dependabot.yml)
version: 2
updates:
  - package-ecosystem: maven
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    labels:
      - dependencies
`
};
const javaGradleDependencyUpdates = {
  id: "java-gradle-dependency-updates",
  name: "Java Gradle Dependency Updates",
  appliesTo: [
    "Java"
  ],
  rootProjectMarkers: [
    "build.gradle",
    "build.gradle.kts"
  ],
  triggers: [
    "schedule"
  ],
  detectionPatternGroups: [
    [
      "package-ecosystem: gradle",
      'package-ecosystem: "gradle"',
      "renovate",
      "gradle-versions-plugin"
    ]
  ],
  capabilities: [
    "Automated dependency updates"
  ],
  suggestedFilename: "java-gradle-dependabot.yml",
  category: "dependency-update",
  template: `# Dependabot configuration for Gradle (place in .github/dependabot.yml)
version: 2
updates:
  - package-ecosystem: gradle
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    labels:
      - dependencies
`
};
// ---------------------------------------------------------------------------
// Universal Markdown workflows
// ---------------------------------------------------------------------------
const markdownLint = {
  id: "markdown-lint",
  name: "Markdown Lint",
  appliesTo: "universal",
  // Issue #1639 — pull-request only. Re-running the gate on the post-merge
  // push duplicates the PR run with no enforcement value, and the audit's
  // trigger pre-filer files it as a finding against the fleet's own template.
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "markdownlint-cli2",
      "markdownlint"
    ]
  ],
  capabilities: [
    "Markdown structural linting"
  ],
  suggestedFilename: "markdown-lint.yml",
  category: "quality",
  // Pins third-party actions to commit SHAs (Issue #1686) so a hijacked tag
  // cannot inject code into CI, and `markdownlint-cli2` to an exact version
  // (Issue #1639) so the install sits inside the supply-chain quarantine.
  // Reuses the same `.markdownlint-cli2.jsonc` configuration that local
  // `quality.sh` consumes — single source of truth, no drift.
  template: `name: Markdown Lint

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  markdownlint:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      # checkout and setup-node run on the Node 24 runtime (Issues #2316,
      # #2317); the v4 line ran on Node 20, deprecated for forced upgrade
      # 2026-06-02 and full removal 2026-09-16.
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - uses: ${pinnedAction("actions/setup-node")}
        with:
          node-version: "lts/*"
      # Pinned to an exact version so the install sits inside the 24h
      # dependency quarantine — a \`run:\` install is not a manifest, so no
      # dependency manager governs it. \`--ignore-scripts\` keeps
      # install-time lifecycle scripts from the dependency tree off the
      # runner.
      - name: Install markdownlint-cli2
        run: npm install -g --ignore-scripts markdownlint-cli2@${MARKDOWNLINT_CLI2_VERSION}
      - name: Run markdownlint-cli2
        run: markdownlint-cli2
`
};
// ---------------------------------------------------------------------------
// Bash workflows
// ---------------------------------------------------------------------------
const shellcheck = {
  id: "shellcheck",
  name: "ShellCheck Lint",
  appliesTo: [
    "Bash"
  ],
  triggers: [
    "pull_request"
  ],
  detectionPatternGroups: [
    [
      "shellcheck",
      "koalaman/shellcheck",
      "ludeeus/action-shellcheck"
    ]
  ],
  capabilities: [
    "Shell script linting"
  ],
  suggestedFilename: "shellcheck.yml",
  category: "quality",
  template: `name: ShellCheck

on:
  pull_request:
    branches: ${PULL_REQUEST_BRANCHES}

permissions:
  contents: read

${CONCURRENCY_BLOCK}

jobs:
  shellcheck:
    runs-on: ubuntu-latest
    timeout-minutes: ${SCAN_TIMEOUT_MINUTES}
    steps:
      - uses: ${pinnedAction("actions/checkout")}
${CHECKOUT_NO_CREDENTIALS}
      - name: Run ShellCheck
        uses: ${pinnedAction("ludeeus/action-shellcheck")}
        with:
          scandir: .
          severity: warning
`
};
// ---------------------------------------------------------------------------
// Exported catalogue
// ---------------------------------------------------------------------------
/** Complete catalogue of all workflow specifications. */ export const WORKFLOW_SPECS = [
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
  javaGradleDependencyUpdates,
  // Bash
  shellcheck
];
/**
 * Resolve a human-readable capability label for a detection-pattern group.
 *
 * Looks up the matching `capabilities[i]` entry in the spec when the group
 * appears in `spec.detectionPatternGroups`. Falls back to the first pattern
 * in the group when no explicit label is configured, so older specs that
 * predate the `capabilities` field still produce a readable bullet rather
 * than an empty string.
 */ export function capabilityLabelForGroup(spec, group) {
  const idx = spec.detectionPatternGroups.findIndex((g)=>g.length === group.length && g.every((p, i)=>p === group[i]));
  if (idx >= 0 && spec.capabilities && spec.capabilities[idx]) {
    return spec.capabilities[idx];
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
 */ export function getWorkflowsForLanguages(languages) {
  const langSet = new Set(languages);
  const seen = new Set();
  const result = [];
  for (const spec of WORKFLOW_SPECS){
    if (seen.has(spec.id)) continue;
    if (spec.appliesTo === "universal") {
      seen.add(spec.id);
      result.push(spec);
      continue;
    }
    // Language-specific: include if any of the spec's languages match.
    const matches = spec.appliesTo.some((lang)=>langSet.has(lang));
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
 */ export function getWorkflowsForLanguagesAndVisibility(languages, visibility) {
  const specs = getWorkflowsForLanguages(languages);
  if (visibility === "public") {
    return specs;
  }
  return specs.filter((s)=>s.visibilityScope !== "public-only");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi93b3JrZmxvd19kZWZpbml0aW9ucy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdpdEh1YiBBY3Rpb25zIHdvcmtmbG93IHNwZWNpZmljYXRpb25zIHBlciBsYW5ndWFnZS5cbiAqXG4gKiBEZWZpbmVzIHRoZSBleHBlY3RlZCB3b3JrZmxvd3MgdGhhdCB0aGUgc2V0dXAgcHJvY2VzcyBjaGVja3MgZm9yXG4gKiBhbmQgcmVjb21tZW5kcy4gRWFjaCBzcGVjaWZpY2F0aW9uIGluY2x1ZGVzIGRldGVjdGlvbiBwYXR0ZXJucyBmb3JcbiAqIGF1ZGl0aW5nIGV4aXN0aW5nIHdvcmtmbG93cyBhbmQgdGVtcGxhdGUgWUFNTCBmb3IgY3JlYXRpbmcgbmV3IG9uZXMuXG4gKlxuICogSXNzdWUgIzEzOTI6IERlZmluZSBleHBlY3RlZCBHaXRIdWIgQWN0aW9ucyB3b3JrZmxvdyBzcGVjaWZpY2F0aW9ucyBwZXIgbGFuZ3VhZ2UuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXBvVmlzaWJpbGl0eSB9IGZyb20gXCIuL3JlcG9fdmlzaWJpbGl0eS50c1wiO1xuaW1wb3J0IHtcbiAgQ0FOT05JQ0FMX01JTklNVU1fREVQRU5ERU5DWV9BR0UsXG4gIElOVEVSTkFMX1NDT1BFX0VYQ0xVREVTLFxufSBmcm9tIFwiLi9kZW5vX21pbmltdW1fZGVwZW5kZW5jeV9hZ2UudHNcIjtcbmltcG9ydCB7IHBpbm5lZEFjdGlvbiwgU0VNR1JFUF9JTUFHRSB9IGZyb20gXCIuL3Bpbm5lZF9hY3Rpb25zLnRzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU2hhcmVkIGhhcmRlbmluZyBmcmFnbWVudHMgKElzc3VlICMxNjM5KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gVGhlIGZsZWV0J3Mgb3duIEdpdEh1YiBBY3Rpb25zIGF1ZGl0IHNjYW5zIGV2ZXJ5IHJlcG9zaXRvcnkgaXQgbW9uaXRvcnMsXG4vLyBpbmNsdWRpbmcgdGhlIG9uZXMgaXQgaGFzIGp1c3QgcHJvdmlzaW9uZWQuIEJlZm9yZSBJc3N1ZSAjMTYzOSBvbmx5IHRoZVxuLy8gZ2l0bGVha3MgdGVtcGxhdGUgKElzc3VlICM1OTQpIHdhcyBzaGFwZWQgdG8gcGFzcyB0aGF0IGF1ZGl0LCBzbyBhIGZyZXNobHlcbi8vIHNldC11cCByZXBvc2l0b3J5IGltbWVkaWF0ZWx5IGFjY3J1ZWQgYSBwaWxlIG9mIGF1ZGl0IGlzc3VlcyBhZ2FpbnN0XG4vLyB3b3JrZmxvd3MgdGhlIGZsZWV0IGl0c2VsZiBoYWQgd3JpdHRlbi4gVGhlc2UgZnJhZ21lbnRzIGNhcnJ5IHRoZSBhdWRpdCdzXG4vLyByZXF1aXJlbWVudHMgaW50byBldmVyeSB0ZW1wbGF0ZSwgYW5kXG4vLyBgd29ya2VyL2Rlbm8vdGVzdHMvd29ya2Zsb3dfdGVtcGxhdGVfYXVkaXRfY29uZm9ybWFuY2VfdGVzdC50c2AgcnVucyB0aGVcbi8vIGF1ZGl0J3Mgb3duIG5hdGl2ZSBwcmUtZmlsZXJzIG92ZXIgdGhlIHJlbmRlcmVkIHRlbXBsYXRlcyBzbyB0aGUgdHdvXG4vLyBjYW5ub3QgZHJpZnQgYXBhcnQuXG5cbi8qKlxuICogRXhwbGljaXQgYHB1bGxfcmVxdWVzdGAgdGFyZ2V0IGJyYW5jaGVzLlxuICpcbiAqIEEgR2l0SHViIGJyYW5jaCBmaWx0ZXIgYCpgIG5ldmVyIG1hdGNoZXMgYSBgL2AsIHNvIHRoZSBmb3JtZXIgYFtcIipcIl1gIHJlYWRcbiAqIGFzIFwiZXZlcnkgYnJhbmNoXCIgd2hpbGUgc2lsZW50bHkgc2tpcHBpbmcgZXZlcnkgYG1pbGVzdG9uZS88c2x1Zz5gIFBSXG4gKiAoSXNzdWUgIzEzMDApIOKAlCB0aGUgZG9taW5hbnQgbWVyZ2UgcGF0aCBpbiB0aGlzIGZsZWV0LiBUaGUgdGFyZ2V0cyBhcmVcbiAqIGxpc3RlZCBleHBsaWNpdGx5IGluc3RlYWQsIHdoaWNoIGlzIHdoYXQgdGhlIG1pbGVzdG9uZS1icmFuY2gtZmlsdGVyXG4gKiBwcmUtZmlsZXIgcmVxdWlyZXMuXG4gKi9cbmNvbnN0IFBVTExfUkVRVUVTVF9CUkFOQ0hFUyA9IFwiW0RldmVsb3AsIG1haW4sIG1pbGVzdG9uZS8qXVwiO1xuXG4vKipcbiAqIENhbmNlbGxpbmcgY29uY3VycmVuY3kgZ3JvdXAgKGF1ZGl0IGNoZWNrICM0KS4gT25seSB0aGUgbGF0ZXN0IHJ1biBmb3IgYVxuICogZ2l2ZW4gcmVmIG1hdHRlcnMsIHNvIGNhbmNlbGxhdGlvbiBzdG9wcyByYXBpZCBwdXNoZXMg4oCUIG9yIG92ZXJsYXBwaW5nXG4gKiBzY2hlZHVsZWQgcnVucyDigJQgc3Bhd25pbmcgcGFyYWxsZWwsIHJlZHVuZGFudCB3b3JrLlxuICovXG5jb25zdCBDT05DVVJSRU5DWV9CTE9DSyA9XG4gIGAjIE9ubHkgdGhlIGxhdGVzdCBydW4gZm9yIGEgZ2l2ZW4gcmVmIG1hdHRlcnMsIHNvIGEgcGVyLXJlZiBncm91cCB3aXRoXG4jIGNhbmNlbGxhdGlvbiBzdG9wcyByYXBpZCBwdXNoZXMgKG9yIG92ZXJsYXBwaW5nIHNjaGVkdWxlZCBydW5zKVxuIyBzcGF3bmluZyBwYXJhbGxlbCwgcmVkdW5kYW50IHdvcmsuXG5jb25jdXJyZW5jeTpcbiAgZ3JvdXA6IFxcJHt7IGdpdGh1Yi53b3JrZmxvdyB9fS1cXCR7eyBnaXRodWIucmVmIH19XG4gIGNhbmNlbC1pbi1wcm9ncmVzczogdHJ1ZWA7XG5cbi8qKlxuICogSm9iIHRpbWVvdXQgZm9yIHNjYW4gYW5kIHF1YWxpdHkgam9icyAoYXVkaXQgY2hlY2sgIzUpLiBXaXRob3V0IGFuXG4gKiBleHBsaWNpdCB0aW1lb3V0IGEgd2VkZ2VkIGpvYiBob2xkcyBhIHJ1bm5lciBmb3IgR2l0SHViJ3Mgc2l4LWhvdXJcbiAqIGRlZmF1bHQuXG4gKi9cbmNvbnN0IFNDQU5fVElNRU9VVF9NSU5VVEVTID0gMTA7XG5cbi8qKlxuICogSm9iIHRpbWVvdXQgZm9yIGRlcGVuZGVuY3ktdXBkYXRlIGpvYnMsIHdoaWNoIHJlc29sdmUgdGhlIHdob2xlXG4gKiBkZXBlbmRlbmN5IGdyYXBoIGFuZCB0aGVuIG9wZW4gYSBwdWxsIHJlcXVlc3QuXG4gKi9cbmNvbnN0IERFUEVOREVOQ1lfVVBEQVRFX1RJTUVPVVRfTUlOVVRFUyA9IDIwO1xuXG4vKipcbiAqIENoZWNrb3V0IGB3aXRoOmAgYmxvY2sgZm9yIGEgam9iIHRoYXQgb25seSByZWFkcyB0aGUgcmVwb3NpdG9yeS5cbiAqXG4gKiBCeSBkZWZhdWx0IGBhY3Rpb25zL2NoZWNrb3V0YCB3cml0ZXMgdGhlIHdvcmtmbG93J3MgYEdJVEhVQl9UT0tFTmAgaW50b1xuICogYC5naXQvY29uZmlnYCwgd2hlcmUgYW55IGxhdGVyIHN0ZXAg4oCUIGluY2x1ZGluZyBhIGNvbXByb21pc2VkIGRlcGVuZGVuY3kg4oCUXG4gKiBjYW4gcmVhZCBpdC4gQSBzY2FuL2J1aWxkL2xpbnQgam9iIG5ldmVyIG5lZWRzIHRoYXQsIHNvIHRoZSBjcmVkZW50aWFsIGlzXG4gKiBub3QgbGVmdCBvbiBkaXNrLlxuICovXG5jb25zdCBDSEVDS09VVF9OT19DUkVERU5USUFMUyA9IGAgICAgICAgIHdpdGg6XG4gICAgICAgICAgIyBUaGUgY2hlY2tvdXQgY3JlZGVudGlhbCBpcyBub3QgbmVlZGVkLCBzbyBkbyBub3QgbGVhdmUgaXQgaW5cbiAgICAgICAgICAjIC5naXQvY29uZmlnIHdoZXJlIGEgbGF0ZXIgc3RlcCBjb3VsZCByZWFkIGl0LlxuICAgICAgICAgIHBlcnNpc3QtY3JlZGVudGlhbHM6IGZhbHNlYDtcblxuLyoqXG4gKiBFeGFjdCBgbWFya2Rvd25saW50LWNsaTJgIHZlcnNpb24gaW5zdGFsbGVkIGJ5IHRoZSBNYXJrZG93biBsaW50IHRlbXBsYXRlLlxuICpcbiAqIEEgYHJ1bjpgIGluc3RhbGwgaXMgbm90IGEgbWFuaWZlc3QsIHNvIG5vIGRlcGVuZGVuY3kgbWFuYWdlciBnb3Zlcm5zIGl0IOKAlFxuICogYW4gdW5waW5uZWQgaW5zdGFsbCByZXNvbHZlcyB0byB3aGF0ZXZlciB0aGUgcmVnaXN0cnkgc2VydmVzIGF0IHJ1biB0aW1lLFxuICogb3V0c2lkZSB0aGUgMjRoIHN1cHBseS1jaGFpbiBxdWFyYW50aW5lLiBCdW1wIHRoaXMgaW4gbG9jay1zdGVwIHdpdGhcbiAqIGBjb250YWluZXIvdG9vbHMuanNvbmAgYW5kIGAuZ2l0aHViL3dvcmtmbG93cy9tYXJrZG93bi1saW50LnltbGAuXG4gKi9cbmNvbnN0IE1BUktET1dOTElOVF9DTEkyX1ZFUlNJT04gPSBcIjAuMjQuMFwiO1xuXG4vKipcbiAqIEV4YWN0IGBjYXJnby1hdWRpdGAgdmVyc2lvbiBpbnN0YWxsZWQgYnkgdGhlIGNhcmdvLWF1ZGl0IHRlbXBsYXRlLlxuICpcbiAqIEEgYHJ1bjpgIGluc3RhbGwgaXMgbm90IGEgbWFuaWZlc3QsIHNvIG5vIGRlcGVuZGVuY3kgbWFuYWdlciBnb3Zlcm5zIGl0LlxuICogYC0tbG9ja2VkYCBtYWtlcyBjYXJnbyB1c2UgdGhlIGNyYXRlJ3Mgb3duIGBDYXJnby5sb2NrYCBpbnN0ZWFkIG9mXG4gKiByZS1yZXNvbHZpbmcgaXRzIGRlcGVuZGVuY3kgdHJlZSB0byB0aGUgbmV3ZXN0IGNyYXRlcy5pbyByZWxlYXNlcyBvbiBldmVyeVxuICogcnVuLCB3aGljaCB3b3VsZCBvdGhlcndpc2UgbGFuZCBvdXRzaWRlIHRoZSAyNGggc3VwcGx5LWNoYWluIHF1YXJhbnRpbmUuXG4gKiBCdW1wIGluIGxvY2stc3RlcCB3aXRoIGAuZ2l0aHViL3dvcmtmbG93cy9jYXJnby1hdWRpdC55bWxgLCB3aGljaCB0ZXN0cyBrZWVwXG4gKiBlcXVhbCB0byB0aGlzIGNvbnN0YW50LCBzbyBidW1wcyBzdGF5IGRlbGliZXJhdGUuXG4gKi9cbmNvbnN0IENBUkdPX0FVRElUX1ZFUlNJT04gPSBcIjAuMjIuMlwiO1xuXG4vKipcbiAqIEV4YWN0IGBjYXJnby1lZGl0YCB2ZXJzaW9uIGluc3RhbGxlZCBieSB0aGUgY2FyZ28tdXBncmFkZSB0ZW1wbGF0ZS5cbiAqXG4gKiBBIGBydW46YCBpbnN0YWxsIGlzIG5vdCBhIG1hbmlmZXN0LCBzbyBubyBkZXBlbmRlbmN5IG1hbmFnZXIgZ292ZXJucyBpdC5cbiAqIGAtLWxvY2tlZGAgbWFrZXMgY2FyZ28gdXNlIHRoZSBjcmF0ZSdzIG93biBgQ2FyZ28ubG9ja2AgaW5zdGVhZCBvZlxuICogcmUtcmVzb2x2aW5nIGl0cyBkZXBlbmRlbmN5IHRyZWUgdG8gdGhlIG5ld2VzdCBjcmF0ZXMuaW8gcmVsZWFzZXMgb24gZXZlcnlcbiAqIHJ1biwgd2hpY2ggd291bGQgb3RoZXJ3aXNlIGxhbmQgb3V0c2lkZSB0aGUgMjRoIHN1cHBseS1jaGFpbiBxdWFyYW50aW5lLlxuICogQnVtcCBpbiBsb2NrLXN0ZXAgd2l0aCBgLmdpdGh1Yi93b3JrZmxvd3MvY2FyZ28tdXBncmFkZS55bWxgLCB3aGljaCB0ZXN0cyBrZWVwXG4gKiBlcXVhbCB0byB0aGlzIGNvbnN0YW50LCBzbyBidW1wcyBzdGF5IGRlbGliZXJhdGUuXG4gKi9cbmNvbnN0IENBUkdPX0VESVRfVkVSU0lPTiA9IFwiMC4xMy4xNFwiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFB1YmxpYyB0eXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBTcGVjaWZpY2F0aW9uIGZvciBhIEdpdEh1YiBBY3Rpb25zIHdvcmtmbG93LiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3JrZmxvd1NwZWMge1xuICAvKiogVW5pcXVlIGlkZW50aWZpZXIsIGUuZy4gXCJnaXRsZWFrc1wiLCBcImNhcmdvLWF1ZGl0XCIuICovXG4gIGlkOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBuYW1lLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBXaGljaCBsYW5ndWFnZXMgdGhpcyBhcHBsaWVzIHRvLCBvciBcInVuaXZlcnNhbFwiIGZvciBhbGwgcmVwb3MuICovXG4gIGFwcGxpZXNUbzogXCJ1bml2ZXJzYWxcIiB8IHN0cmluZ1tdO1xuICAvKiogUm9vdCBwcm9qZWN0IGZpbGVzIHJlcXVpcmVkIGJ5IHRlbXBsYXRlcyB0aGF0IHJ1biB0b29scyBmcm9tIHRoZSByb290LiAqL1xuICByb290UHJvamVjdE1hcmtlcnM/OiBzdHJpbmdbXTtcbiAgLyoqIFRyaWdnZXIgZXZlbnRzIChlLmcuIFwicHVsbF9yZXF1ZXN0XCIsIFwic2NoZWR1bGVcIikuICovXG4gIHRyaWdnZXJzOiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIEdyb3VwcyBvZiBkZXRlY3Rpb24gcGF0dGVybnMuIEEgd29ya2Zsb3cgaXMgY29uc2lkZXJlZCBcInByZXNlbnRcIiB3aGVuXG4gICAqIGF0IGxlYXN0IG9uZSBwYXR0ZXJuIGZyb20gRUFDSCBncm91cCBtYXRjaGVzIHRoZSB3b3JrZmxvdyBjb250ZW50LlxuICAgKlxuICAgKiBTZW1hbnRpY3M6IGdyb3VwcyBhcmUgQU5ELWNvbWJpbmVkOyBwYXR0ZXJucyB3aXRoaW4gYSBncm91cCBhcmVcbiAgICogT1ItY29tYmluZWQgKGkuZS4gYWx0ZXJuYXRpdmUgdmFsaWQgaW1wbGVtZW50YXRpb25zIG9mIHRoZSBzYW1lXG4gICAqIGNhcGFiaWxpdHkpLiBBIHNwZWMgdGhhdCByZXF1aXJlcyBhbGwgb2YgYFtBLCBCLCBDXWAgc2hvdWxkIGJlIG1vZGVsbGVkXG4gICAqIGFzIGBbW1wiQVwiXSwgW1wiQlwiXSwgW1wiQ1wiXV1gLiBBIHNwZWMgdGhhdCBhY2NlcHRzIGFueSBvbmUgb2YgYFtBLCBCLCBDXWBcbiAgICogYXMgdGhlIGltcGxlbWVudGF0aW9uIHNob3VsZCBiZSBtb2RlbGxlZCBhcyBgW1tcIkFcIiwgXCJCXCIsIFwiQ1wiXV1gLlxuICAgKi9cbiAgZGV0ZWN0aW9uUGF0dGVybkdyb3Vwczogc3RyaW5nW11bXTtcbiAgLyoqXG4gICAqIEh1bWFuLXJlYWRhYmxlIGNhcGFiaWxpdHkgbGFiZWwgcGVyIGRldGVjdGlvbiBncm91cC4gU2FtZSBsZW5ndGggYXNcbiAgICogYGRldGVjdGlvblBhdHRlcm5Hcm91cHNgOyBgY2FwYWJpbGl0aWVzW2ldYCBkZXNjcmliZXMgdGhlIGNhcGFiaWxpdHlcbiAgICogdGhhdCBgZGV0ZWN0aW9uUGF0dGVybkdyb3Vwc1tpXWAgdmVyaWZpZXMgKGUuZy4gXCJMaW50aW5nXCIgZm9yIHRoZVxuICAgKiBncm91cCBgW1wiY2FyZ28gY2xpcHB5XCIsIFwiY2xpcHB5XCJdYCkuIFdoZW4gYWJzZW50IG9yIHNob3J0ZXIgdGhhbiB0aGVcbiAgICogZ3JvdXBzIGFycmF5LCB0aGUgcmVuZGVyaW5nIGxheWVyIGZhbGxzIGJhY2sgdG8gdGhlIGZpcnN0IHBhdHRlcm4gaW5cbiAgICogdGhlIGdyb3VwIGFzIHRoZSBsYWJlbC5cbiAgICovXG4gIGNhcGFiaWxpdGllcz86IHN0cmluZ1tdO1xuICAvKiogU3VnZ2VzdGVkIHdvcmtmbG93IGZpbGVuYW1lLiAqL1xuICBzdWdnZXN0ZWRGaWxlbmFtZTogc3RyaW5nO1xuICAvKiogVGVtcGxhdGUgWUFNTCBjb250ZW50LiAqL1xuICB0ZW1wbGF0ZTogc3RyaW5nO1xuICAvKiogQ2F0ZWdvcnkgb2YgdGhlIHdvcmtmbG93LiAqL1xuICBjYXRlZ29yeTogXCJzZWN1cml0eVwiIHwgXCJkZXBlbmRlbmN5LXVwZGF0ZVwiIHwgXCJxdWFsaXR5XCI7XG4gIC8qKlxuICAgKiBSZXBvc2l0b3J5IHZpc2liaWxpdGllcyBmb3Igd2hpY2ggdGhpcyBzcGVjIGFwcGxpZXMuXG4gICAqXG4gICAqIC0gYFwiYW55XCJgIChkZWZhdWx0IHdoZW4gb21pdHRlZCkg4oCUIGFwcGx5IHRvIGFsbCByZXBvc2l0b3JpZXMuXG4gICAqIC0gYFwicHVibGljLW9ubHlcImAg4oCUIGFwcGx5IG9ubHkgdG8gcHVibGljIHJlcG9zaXRvcmllcy4gU3BlY3MgdGhhdFxuICAgKiAgIHJlcXVpcmUgYSBmZWF0dXJlIG9ubHkgYXZhaWxhYmxlIG9uIHB1YmxpYyByZXBvcyAoZS5nLiBHaXRIdWJcbiAgICogICBBZHZhbmNlZCBTZWN1cml0eSdzIGRlcGVuZGVuY3ktcmV2aWV3IGFjdGlvbiB3aXRob3V0IGEgcGFpZCBHSEFTXG4gICAqICAgbGljZW5jZSBvbiBwcml2YXRlIHJlcG9zKSBzaG91bGQgb3B0IGluIHRvIHRoaXMgc2NvcGUgc28gdGhlXG4gICAqICAgd29ya2Zsb3cgYXVkaXRvciBkb2VzIG5vdCByYWlzZSBpc3N1ZXMgYWdhaW5zdCBwcml2YXRlIHJlcG9zLlxuICAgKlxuICAgKiBJc3N1ZSAjMTc1My5cbiAgICovXG4gIHZpc2liaWxpdHlTY29wZT86IFwiYW55XCIgfCBcInB1YmxpYy1vbmx5XCI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVW5pdmVyc2FsIHdvcmtmbG93cyAoYWxsIHJlcG9zKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNvbnN0IGdpdGxlYWtzOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcImdpdGxlYWtzXCIsXG4gIG5hbWU6IFwiR2l0bGVha3MgU2VjcmV0cyBEZXRlY3Rpb25cIixcbiAgYXBwbGllc1RvOiBcInVuaXZlcnNhbFwiLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1wiZ2l0bGVha3MvZ2l0bGVha3MtYWN0aW9uXCIsIFwiZ2l0bGVha3NcIl1dLFxuICBjYXBhYmlsaXRpZXM6IFtcIlNlY3JldCBzY2FubmluZ1wiXSxcbiAgc3VnZ2VzdGVkRmlsZW5hbWU6IFwiZ2l0bGVha3MueW1sXCIsXG4gIGNhdGVnb3J5OiBcInNlY3VyaXR5XCIsXG4gIC8vIE1pcnJvcnMgdGhlIGNhbm9uaWNhbCBwYXR0ZXJuIGluIHN0U29mdHdhcmVBVS9wcml2YXRlLXJlcG8tMTRcbiAgLy8gKC5naXRodWIvd29ya2Zsb3dzL3F1YWxpdHkueW1sKS4gZ2l0bGVha3MtYWN0aW9uQHYzIGZhaWxzIHdpdGhcbiAgLy8gRXJyTGljZW5zZSBvbiBvcmdhbmlzYXRpb24tb3duZWQgcmVwb3Mgd2hlbiBHSVRMRUFLU19MSUNFTlNFIGlzXG4gIC8vIHVuc2V0IChJc3N1ZSAjMTYzNiksIHNvIHRoZSBsaWNlbmNlIGVudiB2YXIgaXMgd2lyZWQgdGhyb3VnaC5cbiAgLy8gRGVwZW5kYWJvdC1hdXRob3JlZCBQUnMgbmV2ZXIgcmVjZWl2ZSBBY3Rpb25zIHNlY3JldHMsIHNvIHRoZVxuICAvLyBsaWNlbmNlIGlzIGVtcHR5IGZvciB0aGVtIGFuZCB0aGUgYWN0aW9uIHdvdWxkIGFsd2F5cyBmYWlsXG4gIC8vIChJc3N1ZSAjMjk4MSkg4oCUIGZvciB0aG9zZSBsaWNlbmNlLWxlc3MgcnVucyB3ZSBmYWxsIGJhY2sgdG8gdGhlXG4gIC8vIGZyZWUsIG9wZW4tc291cmNlIGdpdGxlYWtzIENMSSwgcGlubmVkIGJ5IHZlcnNpb24gYW5kIHZlcmlmaWVkXG4gIC8vIGFnYWluc3QgYSBwdWJsaXNoZWQgU0hBLTI1NiBjaGVja3N1bS4gVGhpcmQtcGFydHkgYWN0aW9ucyBhcmVcbiAgLy8gcGlubmVkIHRvIDQwLWNoYXJhY3RlciBjb21taXQgU0hBcyBwZXIgdGhlIHN1cHBseS1jaGFpbiBoYXJkZW5pbmdcbiAgLy8gcG9saWN5IChJc3N1ZSAjMTc1Nikg4oCUIHRhZyBoaWphY2sgb24gYWN0aW9ucy9jaGVja291dCBvclxuICAvLyBnaXRsZWFrcy1hY3Rpb24gd291bGQgb3RoZXJ3aXNlIGdpdmUgYW4gYXR0YWNrZXIgYWNjZXNzIHRvIGV2ZXJ5XG4gIC8vIHNlY3JldCBhdmFpbGFibGUgdG8gQ0kuIElzc3VlICM1OTQgcmVmcmVzaGVkIHRoZSB0ZW1wbGF0ZSBhZ2FpbnN0XG4gIC8vIHRoaXMgcmVwb3NpdG9yeSdzIG93biBnaXRsZWFrcy55bWw6IG1pbGVzdG9uZS1hd2FyZSBicmFuY2ggZmlsdGVyLFxuICAvLyBjcmVkZW50aWFsIHBlcnNpc3RlbmNlIGRpc2FibGVkIG9uIGNoZWNrb3V0LCBhbmQgYSBjYW5jZWxsaW5nXG4gIC8vIGNvbmN1cnJlbmN5IGdyb3VwLiBgd29ya2VyL2Rlbm8vdGVzdHMvZ2l0bGVha3NfdGVtcGxhdGVfY29uZm9ybWFuY2VfdGVzdC50c2BcbiAgLy8gbG9ja3MgdGhvc2UgaW52YXJpYW50cy5cbiAgdGVtcGxhdGU6IGBuYW1lOiBHaXRsZWFrc1xuXG4jIERldGVjdCBzZWNyZXRzIGluIHB1bGwgcmVxdWVzdCBkaWZmcy5cbiNcbiMgTWlycm9ycyB0aGUgY2Fub25pY2FsIHByaXZhdGUtcmVwby0xNCBwYXR0ZXJuIGF0XG4jIHN0U29mdHdhcmVBVS9wcml2YXRlLXJlcG8tMTQvLmdpdGh1Yi93b3JrZmxvd3MvcXVhbGl0eS55bWwuIFRoaXJkLXBhcnR5XG4jIGFjdGlvbnMgYXJlIHBpbm5lZCB0byA0MC1jaGFyYWN0ZXIgY29tbWl0IFNIQXMgKElzc3VlICMxNzU2KSBzbyBhXG4jIGhpamFja2VkIHRhZyBjYW5ub3QgZXhmaWx0cmF0ZSBDSSBzZWNyZXRzLlxuI1xuIyBnaXRsZWFrcy1hY3Rpb25AdjMgcmVxdWlyZXMgYW4gb3JnYW5pc2F0aW9uIGxpY2VuY2UgKEdJVExFQUtTX0xJQ0VOU0UpXG4jIG9uIG9yZy1vd25lZCByZXBvcyAodjIgYmVoYXZlZCB0aGUgc2FtZSB3YXkpLiBEZXBlbmRhYm90LWF1dGhvcmVkIFBSc1xuIyBkbyBub3QgcmVjZWl2ZSBBY3Rpb25zIHNlY3JldHMsIHNvIHRoZSBsaWNlbmNlIGlzIGVtcHR5IGZvciB0aGVtIGFuZFxuIyB0aGUgYWN0aW9uIGV4aXRzIHdpdGggRXJyTGljZW5zZSBiZWZvcmUgc2Nhbm5pbmcgKElzc3VlICMyOTgxKS4gRm9yXG4jIHRob3NlIGxpY2VuY2UtbGVzcyBydW5zIHdlIGZhbGwgYmFjayB0byB0aGUgZnJlZSwgb3Blbi1zb3VyY2UgZ2l0bGVha3NcbiMgQ0xJLCB3aGljaCBuZWVkcyBubyBsaWNlbmNlLlxuI1xuIyBEZWxpYmVyYXRlbHkgb21pdHRlZCAoSXNzdWUgIzU5NCkgc28gdGhlIHRlbXBsYXRlIHJ1bnMgdW5tb2RpZmllZCBvbiBhXG4jIGZyZXNobHkgc2V0LXVwIHJlcG9zaXRvcnksIHdoaWNoIGhhcyBuZWl0aGVyIG9mIHRoZW0geWV0OlxuIyAgIC0gdGhlIFxcYGVudmlyb25tZW50OiBzY2FubmluZy1zZWNyZXRzXFxgIGdhdGUgdGhpcyByZXBvc2l0b3J5J3Mgb3duIGNvcHlcbiMgICAgIHVzZXMgdG8gc2NvcGUgdGhlIGxpY2VuY2Ugc2VjcmV0IOKAlCBhZGQgaXQgb25jZSB0aGUgR2l0SHViXG4jICAgICBFbnZpcm9ubWVudCBleGlzdHM7XG4jICAgLSBcXGBHSVRMRUFLU19DT05GSUc6IC5naXRodWIvZ2l0bGVha3MudG9tbFxcYCDigJQgYWRkIGl0IG9uY2UgdGhlIHJlcG9cbiMgICAgIGNvbW1pdHMgYW4gYWxsb3dsaXN0IGNvbmZpZywgYW5kIHBhc3MgXFxgLS1jb25maWdcXGAgdG8gdGhlIENMSVxuIyAgICAgZmFsbGJhY2sgc28gYm90aCBzY2FubmVycyBzaGFyZSBpdC5cblxub246XG4gIHB1bGxfcmVxdWVzdDpcbiAgICAjIEEgR2l0SHViIGJyYW5jaCBmaWx0ZXIgXFxgKlxcYCBuZXZlciBtYXRjaGVzIGEgXFxgL1xcYCwgc28gdGhlIGZvcm1lclxuICAgICMgXFxgW1wiKlwiXVxcYCByZWFkIGFzIFwiZXZlcnkgYnJhbmNoXCIgd2hpbGUgc2lsZW50bHkgc2tpcHBpbmcgZXZlcnlcbiAgICAjIFxcYG1pbGVzdG9uZS88c2x1Zz5cXGAgUFIgKElzc3VlICMxMzAwKSDigJQgdGhlIGRvbWluYW50IG1lcmdlIHBhdGguIFRoZVxuICAgICMgdGFyZ2V0cyBhcmUgbGlzdGVkIGV4cGxpY2l0bHkgaW5zdGVhZCAoSXNzdWVzICMzMzYwLCAjNTk0KS5cbiAgICBicmFuY2hlczogW0RldmVsb3AsIG1haW4sIG1pbGVzdG9uZS8qXVxuXG5wZXJtaXNzaW9uczpcbiAgY29udGVudHM6IHJlYWRcbiAgcHVsbC1yZXF1ZXN0czogcmVhZFxuXG4jIE9ubHkgdGhlIGxhdGVzdCBjb21taXQncyByZXN1bHQgbWF0dGVycyBmb3IgYSBQUiBjaGVjaywgc28gYSBwZXItcmVmXG4jIGdyb3VwIHdpdGggY2FuY2VsbGF0aW9uIHN0b3BzIHJhcGlkIHB1c2hlcyBzcGF3bmluZyBwYXJhbGxlbCxcbiMgcmVkdW5kYW50IHJ1bnMgKElzc3VlICMyOTcyKS5cbmNvbmN1cnJlbmN5OlxuICBncm91cDogXFwke3sgZ2l0aHViLndvcmtmbG93IH19LVxcJHt7IGdpdGh1Yi5yZWYgfX1cbiAgY2FuY2VsLWluLXByb2dyZXNzOiB0cnVlXG5cbmpvYnM6XG4gIGdpdGxlYWtzOlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6IDEwXG4gICAgIyBFeHBvc2VkIGF0IGpvYiBsZXZlbCBzbyBzdGVwLWxldmVsIFxcYGlmOlxcYCBjYW4gYnJhbmNoIG9uIHdoZXRoZXIgdGhlXG4gICAgIyBvcmcgbGljZW5jZSBzZWNyZXQgaXMgcHJlc2VudCDigJQgdGhlIFxcYHNlY3JldHNcXGAgY29udGV4dCBpcyBub3RcbiAgICAjIGF2YWlsYWJsZSBpbiBcXGBpZjpcXGAgY29uZGl0aW9ucywgYnV0IFxcYGVudlxcYCBpcy5cbiAgICBlbnY6XG4gICAgICBHSVRMRUFLU19MSUNFTlNFOiBcXCR7eyBzZWNyZXRzLkdJVExFQUtTX0xJQ0VOU0UgfX1cbiAgICBzdGVwczpcbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL2NoZWNrb3V0XCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgICMgTm90aGluZyBoZXJlIHB1c2hlcywgc28gdGhlIGpvYiB0b2tlbiBtdXN0IG5vdCBiZSBsZWZ0IGJlaGluZFxuICAgICAgICAgICMgaW4gLmdpdC9jb25maWcgd2hlcmUgYSBsYXRlciBzdGVwIGNvdWxkIHJlYWQgaXQuXG4gICAgICAgICAgcGVyc2lzdC1jcmVkZW50aWFsczogZmFsc2VcbiAgICAgICAgICBmZXRjaC1kZXB0aDogMFxuICAgICAgIyBGZXRjaCB0aGUgUFIgYmFzZSBicmFuY2ggc28gdGhlIGNvbXB1dGVkIGNvbW1pdCByYW5nZVxuICAgICAgIyAoXFxgPGJhc2Vfc2hhPi4uPGhlYWRfc2hhPlxcYCkgcmVzb2x2ZXMgb24gdGhlIHJ1bm5lci4gV2l0aG91dCB0aGlzXG4gICAgICAjIHN0ZXAgZ2l0bGVha3MgZmFpbHMgd2l0aCBcImZhdGFsOiBJbnZhbGlkIHJldmlzaW9uIHJhbmdlXCIgYmVjYXVzZVxuICAgICAgIyB0aGUgYmFzZSByZWYgaXMgbm90IGluIHRoZSBzaGFsbG93IGNoZWNrb3V0IChJc3N1ZSAjMTc1NikuXG4gICAgICAjIE1pcnJvcnMgdGhlIHByaXZhdGUtcmVwby0xNCBxdWFsaXR5LnltbCBwYXR0ZXJuLlxuICAgICAgLSBuYW1lOiBGZXRjaCBiYXNlIGJyYW5jaFxuICAgICAgICBpZjogZ2l0aHViLmV2ZW50X25hbWUgPT0gJ3B1bGxfcmVxdWVzdCdcbiAgICAgICAgZW52OlxuICAgICAgICAgIEJBU0VfUkVGOiBcXCR7eyBnaXRodWIuYmFzZV9yZWYgfX1cbiAgICAgICAgcnVuOiBnaXQgZmV0Y2ggb3JpZ2luIFwiJEJBU0VfUkVGOiRCQVNFX1JFRlwiIHx8IHRydWVcbiAgICAgICMgTGljZW5zZWQgcGF0aDogd2hlbiB0aGUgb3JnIEdpdGxlYWtzIFBybyBsaWNlbmNlIChJc3N1ZSAjMTYzNikgaXNcbiAgICAgICMgYXZhaWxhYmxlLCB1c2UgdGhlIHVwc3RyZWFtIGFjdGlvbiBzbyB0aGUgbGljZW5jZSBpcyBhcHBsaWVkLlxuICAgICAgLSBuYW1lOiBHaXRsZWFrcyAobGljZW5zZWQgYWN0aW9uKVxuICAgICAgICBpZjogZW52LkdJVExFQUtTX0xJQ0VOU0UgIT0gJydcbiAgICAgICAgdXNlczogJHtwaW5uZWRBY3Rpb24oXCJnaXRsZWFrcy9naXRsZWFrcy1hY3Rpb25cIil9XG4gICAgICAgIGVudjpcbiAgICAgICAgICBHSVRIVUJfVE9LRU46IFxcJHt7IHNlY3JldHMuR0lUSFVCX1RPS0VOIH19XG4gICAgICAgICAgR0lUTEVBS1NfTElDRU5TRTogXFwke3sgc2VjcmV0cy5HSVRMRUFLU19MSUNFTlNFIH19XG4gICAgICAjIExpY2VuY2UtbGVzcyBmYWxsYmFjayAoZS5nLiBEZXBlbmRhYm90IFBScywgSXNzdWUgIzI5ODEpOiB0aGUgZnJlZVxuICAgICAgIyBvcGVuLXNvdXJjZSBnaXRsZWFrcyBDTEkgbmVlZHMgbm8gbGljZW5jZS4gSXQgc2NhbnMgdGhlIFBSIGNvbW1pdFxuICAgICAgIyByYW5nZSwgbWlycm9yaW5nIHRoZSBhY3Rpb24ncyBkaWZmIHNjYW4uXG4gICAgICAtIG5hbWU6IEdpdGxlYWtzIChvcGVuLXNvdXJjZSBDTEkgZmFsbGJhY2spXG4gICAgICAgIGlmOiBlbnYuR0lUTEVBS1NfTElDRU5TRSA9PSAnJ1xuICAgICAgICBlbnY6XG4gICAgICAgICAgR0lUTEVBS1NfVkVSU0lPTjogXCI4LjMwLjFcIlxuICAgICAgICAgIEdJVExFQUtTX1NIQTI1NjogXCI1NTFmNmZjODNlYTQ1N2Q2MmEwZDk4MjM3Y2JhZDEwNWFmOGQ1NTcwMDMwNTFmNDFmM2U3Y2E3YjNmMjQ3MGViXCJcbiAgICAgICAgICBCQVNFX1NIQTogXFwke3sgZ2l0aHViLmV2ZW50LnB1bGxfcmVxdWVzdC5iYXNlLnNoYSB9fVxuICAgICAgICAgIEhFQURfU0hBOiBcXCR7eyBnaXRodWIuZXZlbnQucHVsbF9yZXF1ZXN0LmhlYWQuc2hhIH19XG4gICAgICAgIHJ1bjogfFxuICAgICAgICAgIHNldCAtZXVvIHBpcGVmYWlsXG4gICAgICAgICAgYXJjaGl2ZT1cImdpdGxlYWtzX1xcJHtHSVRMRUFLU19WRVJTSU9OfV9saW51eF94NjQudGFyLmd6XCJcbiAgICAgICAgICB1cmw9XCJodHRwczovL2dpdGh1Yi5jb20vZ2l0bGVha3MvZ2l0bGVha3MvcmVsZWFzZXMvZG93bmxvYWQvdlxcJHtHSVRMRUFLU19WRVJTSU9OfS9cXCR7YXJjaGl2ZX1cIlxuICAgICAgICAgIGN1cmwgLXNTZkwgXCIkdXJsXCIgLW8gXCIkYXJjaGl2ZVwiXG4gICAgICAgICAgZWNobyBcIlxcJHtHSVRMRUFLU19TSEEyNTZ9ICBcXCR7YXJjaGl2ZX1cIiB8IHNoYTI1NnN1bSAtYyAtXG4gICAgICAgICAgdGFyIC14emYgXCIkYXJjaGl2ZVwiIGdpdGxlYWtzXG4gICAgICAgICAgLi9naXRsZWFrcyBnaXQgLS1yZWRhY3QgLS1uby1iYW5uZXIgLS1leGl0LWNvZGUgMSBcXFxcXG4gICAgICAgICAgICAtLWxvZy1vcHRzPVwiXFwke0JBU0VfU0hBfS4uXFwke0hFQURfU0hBfVwiIC5cbmAsXG59O1xuXG5jb25zdCBzZW1ncmVwOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcInNlbWdyZXBcIixcbiAgbmFtZTogXCJTZW1ncmVwIFNBU1QgU2Nhbm5pbmdcIixcbiAgYXBwbGllc1RvOiBcInVuaXZlcnNhbFwiLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1wic2VtZ3JlcC9zZW1ncmVwLWFjdGlvblwiLCBcInNlbWdyZXBcIl1dLFxuICBjYXBhYmlsaXRpZXM6IFtcIlNBU1Qgc2Nhbm5pbmdcIl0sXG4gIHN1Z2dlc3RlZEZpbGVuYW1lOiBcInNlbWdyZXAueW1sXCIsXG4gIGNhdGVnb3J5OiBcInNlY3VyaXR5XCIsXG4gIC8vIFRoZSBjb250YWluZXIgaW1hZ2UgaXMgcGlubmVkIHRvIGFuIGltbXV0YWJsZSBkaWdlc3Qg4oCUIGlkZW50aWNhbCB0b1xuICAvLyB0aGlzIHJlcG9zaXRvcnkncyBvd24gLmdpdGh1Yi93b3JrZmxvd3Mvc2VtZ3JlcC55bWwg4oCUIHNvIGEgaGlqYWNrZWRcbiAgLy8gYGxhdGVzdGAgdGFnIGNhbm5vdCBydW4gaW4gQ0kgKElzc3VlICMzNjQ1KS4gTm8gU0VNR1JFUF9BUFBfVE9LRU4gaXNcbiAgLy8gcGFzc2VkOiBgc2VtZ3JlcCBjaWAgZXhpdHMgZmF0YWxseSB3aGVuIGEgdG9rZW4gaXMgY29tYmluZWQgd2l0aCBhblxuICAvLyBleHBsaWNpdCBgLS1jb25maWdgIChJc3N1ZSAjNDM0MTsgc2VtZ3JlcCB2MS4xNzMuMFxuICAvLyBjbGkvc3JjL3NlbWdyZXAvY29tbWFuZHMvY2kucHkpLCBzbyB0aGUgc2NhbiBzdGF5cyBhIHBsYWluIHAvZGVmYXVsdFxuICAvLyBzY2FuIGxpa2UgdGhlIGxvY2FsIGdhdGUgc3RhZ2UgaW4gc2VtZ3JlcF9jaGVjay50cy5cbiAgdGVtcGxhdGU6IGBuYW1lOiBTZW1ncmVwXG5cbm9uOlxuICBwdWxsX3JlcXVlc3Q6XG4gICAgYnJhbmNoZXM6ICR7UFVMTF9SRVFVRVNUX0JSQU5DSEVTfVxuXG5wZXJtaXNzaW9uczpcbiAgY29udGVudHM6IHJlYWRcblxuJHtDT05DVVJSRU5DWV9CTE9DS31cblxuam9iczpcbiAgc2VtZ3JlcDpcbiAgICBydW5zLW9uOiB1YnVudHUtbGF0ZXN0XG4gICAgdGltZW91dC1taW51dGVzOiAke1NDQU5fVElNRU9VVF9NSU5VVEVTfVxuICAgIGNvbnRhaW5lcjpcbiAgICAgIGltYWdlOiAke1NFTUdSRVBfSU1BR0V9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAtIHJ1bjogc2VtZ3JlcCBjaSAtLWNvbmZpZyBwL2RlZmF1bHRcbmAsXG59O1xuXG4vLyBhY3Rpb25zL2RlcGVuZGVuY3ktcmV2aWV3LWFjdGlvbiBydW5zIGZyZWUgb24gcHVibGljIHJlcG9zIGJ1dCByZXF1aXJlc1xuLy8gR2l0SHViIEFkdmFuY2VkIFNlY3VyaXR5IChHSEFTKSBvbiBwcml2YXRlIHJlcG9zLiBNYXJraW5nIHRoaXMgc3BlY1xuLy8gYHZpc2liaWxpdHlTY29wZTogXCJwdWJsaWMtb25seVwiYCBrZWVwcyB3b3JrZmxvdy1zeW5jIGZyb20gcmFpc2luZyBpdFxuLy8gYWdhaW5zdCBwcml2YXRlIHJlcG9zIHdoZXJlIGl0IHdvdWxkIGJlIGEgcGVybWFuZW50bHkgZmFpbGluZyBjaGVjay5cbi8vIChJc3N1ZXMgIzE2NTYg4oCUIG9yaWdpbmFsIHJlbW92YWw7ICMxNzUzIOKAlCB2aXNpYmlsaXR5LWF3YXJlIGZpbHRlcjtcbi8vICAjMTc1NCDigJQgcmUtaW50cm9kdWN0aW9uIGFzIHB1YmxpYy1vbmx5LilcbmNvbnN0IGRlcGVuZGVuY3lSZXZpZXc6IFdvcmtmbG93U3BlYyA9IHtcbiAgaWQ6IFwiZGVwZW5kZW5jeS1yZXZpZXdcIixcbiAgbmFtZTogXCJEZXBlbmRlbmN5IFJldmlld1wiLFxuICBhcHBsaWVzVG86IFwidW5pdmVyc2FsXCIsXG4gIHZpc2liaWxpdHlTY29wZTogXCJwdWJsaWMtb25seVwiLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1xuICAgIFwiYWN0aW9ucy9kZXBlbmRlbmN5LXJldmlldy1hY3Rpb25cIixcbiAgICBcImRlcGVuZGVuY3ktcmV2aWV3LWFjdGlvblwiLFxuICBdXSxcbiAgY2FwYWJpbGl0aWVzOiBbXCJEZXBlbmRlbmN5IHZ1bG5lcmFiaWxpdHkgYW5kIGxpY2VuY2UgcmV2aWV3XCJdLFxuICBzdWdnZXN0ZWRGaWxlbmFtZTogXCJkZXBlbmRlbmN5LXJldmlldy55bWxcIixcbiAgY2F0ZWdvcnk6IFwic2VjdXJpdHlcIixcbiAgLy8gTWlycm9ycyB0aGUgY2Fub25pY2FsIHRlbXBsYXRlIGRvY3VtZW50ZWQgaW4gdGhlIGFyY2hpdmVkXG4gIC8vIHByLXN1bW1hcnktMTYzNCDigJQgdGhlIGRldGVjdGlvbiBwYXR0ZXJucyBhcmUgdW5jaGFuZ2VkLCBzbyB3b3JrZmxvd1xuICAvLyBmaWxlcyBjb3BpZWQgZnJvbSB0aGF0IFBSIGtlZXAgY2xhc3NpZnlpbmcgYXMgYHByZXNlbnRgIOKAlCB3aXRoIHRoZVxuICAvLyBhY3Rpb25zIHBpbm5lZCB0byBjb21taXQgU0hBcyAoSXNzdWUgIzM2NDUpLlxuICB0ZW1wbGF0ZTogYG5hbWU6IERlcGVuZGVuY3kgUmV2aWV3XG5cbm9uOlxuICBwdWxsX3JlcXVlc3Q6XG4gICAgYnJhbmNoZXM6ICR7UFVMTF9SRVFVRVNUX0JSQU5DSEVTfVxuXG5wZXJtaXNzaW9uczpcbiAgY29udGVudHM6IHJlYWRcblxuJHtDT05DVVJSRU5DWV9CTE9DS31cblxuam9iczpcbiAgZGVwZW5kZW5jeS1yZXZpZXc6XG4gICAgcnVucy1vbjogdWJ1bnR1LWxhdGVzdFxuICAgIHRpbWVvdXQtbWludXRlczogJHtTQ0FOX1RJTUVPVVRfTUlOVVRFU31cbiAgICBzdGVwczpcbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL2NoZWNrb3V0XCIpfVxuJHtDSEVDS09VVF9OT19DUkVERU5USUFMU31cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL2RlcGVuZGVuY3ktcmV2aWV3LWFjdGlvblwiKX1cbmAsXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFJ1c3Qgd29ya2Zsb3dzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgY2FyZ29BdWRpdDogV29ya2Zsb3dTcGVjID0ge1xuICBpZDogXCJjYXJnby1hdWRpdFwiLFxuICBuYW1lOiBcIkNhcmdvIFNlY3VyaXR5IEF1ZGl0XCIsXG4gIGFwcGxpZXNUbzogW1wiUnVzdFwiXSxcbiAgcm9vdFByb2plY3RNYXJrZXJzOiBbXCJDYXJnby50b21sXCJdLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCIsIFwic2NoZWR1bGVcIl0sXG4gIGRldGVjdGlvblBhdHRlcm5Hcm91cHM6IFtbXG4gICAgXCJjYXJnbyBhdWRpdFwiLFxuICAgIFwiY2FyZ28tYXVkaXRcIixcbiAgICBcInJ1c3RzZWMvYXVkaXQtY2hlY2tcIixcbiAgXV0sXG4gIGNhcGFiaWxpdGllczogW1wiQ2FyZ28gc2VjdXJpdHkgYXVkaXRcIl0sXG4gIHN1Z2dlc3RlZEZpbGVuYW1lOiBcImNhcmdvLWF1ZGl0LnltbFwiLFxuICBjYXRlZ29yeTogXCJzZWN1cml0eVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IENhcmdvIEF1ZGl0XG5cbm9uOlxuICBwdWxsX3JlcXVlc3Q6XG4gICAgYnJhbmNoZXM6ICR7UFVMTF9SRVFVRVNUX0JSQU5DSEVTfVxuICBzY2hlZHVsZTpcbiAgICAtIGNyb246IFwiMCA2ICogKiAxXCJcblxucGVybWlzc2lvbnM6XG4gIGNvbnRlbnRzOiByZWFkXG5cbiR7Q09OQ1VSUkVOQ1lfQkxPQ0t9XG5cbmpvYnM6XG4gIGF1ZGl0OlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6ICR7U0NBTl9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAjIFNIQS1waW5uZWQsIHNvIHRoZSB0b29sY2hhaW4gY2FuIG5vIGxvbmdlciBiZSByZWFkIGZyb20gdGhlIHJlZlxuICAgICAgIyBuYW1lIOKAlCBpdCBpcyBuYW1lZCBleHBsaWNpdGx5IGluc3RlYWQgKElzc3VlICMzNjQ1KS5cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJkdG9sbmF5L3J1c3QtdG9vbGNoYWluXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIHRvb2xjaGFpbjogc3RhYmxlXG4gICAgICAtIHJ1bjogY2FyZ28gaW5zdGFsbCAtLWxvY2tlZCBjYXJnby1hdWRpdCAtLXZlcnNpb24gJHtDQVJHT19BVURJVF9WRVJTSU9OfVxuICAgICAgLSBydW46IGNhcmdvIGF1ZGl0XG5gLFxufTtcblxuY29uc3QgY2FyZ29VcGdyYWRlOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcImNhcmdvLXVwZ3JhZGVcIixcbiAgbmFtZTogXCJDYXJnbyBEZXBlbmRlbmN5IFVwZGF0ZXNcIixcbiAgYXBwbGllc1RvOiBbXCJSdXN0XCJdLFxuICByb290UHJvamVjdE1hcmtlcnM6IFtcIkNhcmdvLnRvbWxcIl0sXG4gIHRyaWdnZXJzOiBbXCJzY2hlZHVsZVwiLCBcIndvcmtmbG93X2Rpc3BhdGNoXCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1wiY2FyZ28gdXBncmFkZVwiLCBcImNhcmdvLWVkaXRcIiwgXCJjYXJnbyB1cGRhdGVcIl1dLFxuICBjYXBhYmlsaXRpZXM6IFtcIkNhcmdvIGRlcGVuZGVuY3kgdXBkYXRlXCJdLFxuICBzdWdnZXN0ZWRGaWxlbmFtZTogXCJjYXJnby11cGdyYWRlLnltbFwiLFxuICBjYXRlZ29yeTogXCJkZXBlbmRlbmN5LXVwZGF0ZVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IENhcmdvIERlcGVuZGVuY3kgVXBkYXRlc1xuXG5vbjpcbiAgc2NoZWR1bGU6XG4gICAgLSBjcm9uOiBcIjAgNiAqICogMVwiXG4gIHdvcmtmbG93X2Rpc3BhdGNoOlxuXG5wZXJtaXNzaW9uczpcbiAgY29udGVudHM6IHdyaXRlXG4gIHB1bGwtcmVxdWVzdHM6IHdyaXRlXG5cbiR7Q09OQ1VSUkVOQ1lfQkxPQ0t9XG5cbmpvYnM6XG4gIHVwZ3JhZGU6XG4gICAgcnVucy1vbjogdWJ1bnR1LWxhdGVzdFxuICAgIHRpbWVvdXQtbWludXRlczogJHtERVBFTkRFTkNZX1VQREFURV9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAjIGNyZWF0ZS1wdWxsLXJlcXVlc3QgcHVzaGVzIHdpdGggaXRzIG93biBcXGB0b2tlblxcYCBpbnB1dCwgc28gdGhlIGNoZWNrb3V0XG4gICAgICAjIGNyZWRlbnRpYWwgaXMgbm90IG5lZWRlZCBhbmQgaXMgbm90IHBlcnNpc3RlZC5cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL2NoZWNrb3V0XCIpfVxuJHtDSEVDS09VVF9OT19DUkVERU5USUFMU31cbiAgICAgICMgU0hBLXBpbm5lZCwgc28gdGhlIHRvb2xjaGFpbiBjYW4gbm8gbG9uZ2VyIGJlIHJlYWQgZnJvbSB0aGUgcmVmXG4gICAgICAjIG5hbWUg4oCUIGl0IGlzIG5hbWVkIGV4cGxpY2l0bHkgaW5zdGVhZCAoSXNzdWUgIzM2NDUpLlxuICAgICAgLSB1c2VzOiAke3Bpbm5lZEFjdGlvbihcImR0b2xuYXkvcnVzdC10b29sY2hhaW5cIil9XG4gICAgICAgIHdpdGg6XG4gICAgICAgICAgdG9vbGNoYWluOiBzdGFibGVcbiAgICAgIC0gcnVuOiBjYXJnbyBpbnN0YWxsIC0tbG9ja2VkIGNhcmdvLWVkaXQgLS12ZXJzaW9uICR7Q0FSR09fRURJVF9WRVJTSU9OfVxuICAgICAgLSBydW46IGNhcmdvIHVwZ3JhZGVcbiAgICAgIC0gcnVuOiBjYXJnbyB1cGRhdGVcbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJwZXRlci1ldmFucy9jcmVhdGUtcHVsbC1yZXF1ZXN0XCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgICMgT3JnLWxldmVsIFBBVCAoSXNzdWUgIzE2MzYpOyBmYWxscyBiYWNrIHRvIEdJVEhVQl9UT0tFTiB3aGVuXG4gICAgICAgICAgIyB0aGUgc2VjcmV0IGlzIHVuc2V0LiBVc2luZyB0aGUgUEFUIGVuc3VyZXMgZG93bnN0cmVhbSBQUlxuICAgICAgICAgICMgd29ya2Zsb3dzIGZpcmUgb24gdGhlIHJlc3VsdGluZyBwdWxsIHJlcXVlc3QuXG4gICAgICAgICAgdG9rZW46IFxcJHt7IHNlY3JldHMuQUNUSU9OU19QVVNIIHx8IHNlY3JldHMuR0lUSFVCX1RPS0VOIH19XG4gICAgICAgICAgY29tbWl0LW1lc3NhZ2U6IFwiY2hvcmU6IHVwZGF0ZSBDYXJnbyBkZXBlbmRlbmNpZXNcIlxuICAgICAgICAgIHRpdGxlOiBcImNob3JlOiB1cGRhdGUgQ2FyZ28gZGVwZW5kZW5jaWVzXCJcbiAgICAgICAgICBicmFuY2g6IGNob3JlL2NhcmdvLXVwZ3JhZGVcbiAgICAgICAgICBib2R5OiBcIkF1dG9tYXRlZCBDYXJnbyBkZXBlbmRlbmN5IHVwZGF0ZSB2aWEgY2FyZ28tZWRpdC5cIlxuYCxcbn07XG5cbmNvbnN0IGNhcmdvUXVhbGl0eTogV29ya2Zsb3dTcGVjID0ge1xuICBpZDogXCJjYXJnby1xdWFsaXR5XCIsXG4gIG5hbWU6IFwiQ2FyZ28gRm9ybWF0IGFuZCBDbGlwcHlcIixcbiAgYXBwbGllc1RvOiBbXCJSdXN0XCJdLFxuICByb290UHJvamVjdE1hcmtlcnM6IFtcIkNhcmdvLnRvbWxcIl0sXG4gIHRyaWdnZXJzOiBbXCJwdWxsX3JlcXVlc3RcIl0sXG4gIGRldGVjdGlvblBhdHRlcm5Hcm91cHM6IFtcbiAgICBbXCJjYXJnbyBmbXRcIiwgXCJydXN0Zm10XCJdLFxuICAgIFtcImNhcmdvIGNsaXBweVwiLCBcImNsaXBweVwiXSxcbiAgXSxcbiAgY2FwYWJpbGl0aWVzOiBbXG4gICAgXCJGb3JtYXQgY2hlY2sgKGNhcmdvIGZtdCBvciBydXN0Zm10KVwiLFxuICAgIFwiTGludCBjaGVjayAoY2FyZ28gY2xpcHB5IG9yIGNsaXBweSlcIixcbiAgXSxcbiAgc3VnZ2VzdGVkRmlsZW5hbWU6IFwiY2FyZ28tcXVhbGl0eS55bWxcIixcbiAgY2F0ZWdvcnk6IFwicXVhbGl0eVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IENhcmdvIFF1YWxpdHlcblxub246XG4gIHB1bGxfcmVxdWVzdDpcbiAgICBicmFuY2hlczogJHtQVUxMX1JFUVVFU1RfQlJBTkNIRVN9XG5cbnBlcm1pc3Npb25zOlxuICBjb250ZW50czogcmVhZFxuXG4ke0NPTkNVUlJFTkNZX0JMT0NLfVxuXG5qb2JzOlxuICBxdWFsaXR5OlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6ICR7U0NBTl9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAjIFNIQS1waW5uZWQsIHNvIHRoZSB0b29sY2hhaW4gY2FuIG5vIGxvbmdlciBiZSByZWFkIGZyb20gdGhlIHJlZlxuICAgICAgIyBuYW1lIOKAlCBpdCBpcyBuYW1lZCBleHBsaWNpdGx5IGluc3RlYWQgKElzc3VlICMzNjQ1KS5cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJkdG9sbmF5L3J1c3QtdG9vbGNoYWluXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIHRvb2xjaGFpbjogc3RhYmxlXG4gICAgICAgICAgY29tcG9uZW50czogcnVzdGZtdCwgY2xpcHB5XG4gICAgICAtIHJ1bjogY2FyZ28gZm10IC0tY2hlY2tcbiAgICAgIC0gcnVuOiBjYXJnbyBjbGlwcHkgLS0gLUQgd2FybmluZ3NcbiAgICAgICMgUnVuIHRlc3RzIHdpdGggY292ZXJhZ2UgYW5kIHVwbG9hZCB0byBDb2RlY292IChJc3N1ZSAjMTYzNikuXG4gICAgICAjIFNIQS1waW5uZWQsIHNvIHRoZSB0b29sIGlzIG5hbWVkIGV4cGxpY2l0bHkgcmF0aGVyIHRoYW4gcmVhZCBmcm9tXG4gICAgICAjIHRoZSByZWYgbmFtZSAoSXNzdWUgIzM2NDUpLlxuICAgICAgLSB1c2VzOiAke3Bpbm5lZEFjdGlvbihcInRhaWtpLWUvaW5zdGFsbC1hY3Rpb25cIil9XG4gICAgICAgIHdpdGg6XG4gICAgICAgICAgdG9vbDogY2FyZ28tbGx2bS1jb3ZcbiAgICAgIC0gcnVuOiBjYXJnbyBsbHZtLWNvdiAtLWxjb3YgLS1vdXRwdXQtcGF0aCBsY292LmluZm9cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJjb2RlY292L2NvZGVjb3YtYWN0aW9uXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIGZpbGVzOiBsY292LmluZm9cbiAgICAgICAgICB0b2tlbjogXFwke3sgc2VjcmV0cy5DT0RFQ09WX1RPS0VOIH19XG4gICAgICAgICAgZmFpbF9jaV9pZl9lcnJvcjogZmFsc2VcbmAsXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIERlbm8gd29ya2Zsb3dzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgZGVub091dGRhdGVkOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcImRlbm8tb3V0ZGF0ZWRcIixcbiAgbmFtZTogXCJEZW5vIERlcGVuZGVuY3kgVXBkYXRlc1wiLFxuICBhcHBsaWVzVG86IFtcIkRlbm9cIl0sXG4gIHJvb3RQcm9qZWN0TWFya2VyczogW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSxcbiAgdHJpZ2dlcnM6IFtcInNjaGVkdWxlXCIsIFwid29ya2Zsb3dfZGlzcGF0Y2hcIl0sXG4gIGRldGVjdGlvblBhdHRlcm5Hcm91cHM6IFtbXCJkZW5vIG91dGRhdGVkXCIsIFwiZGVuby1vdXRkYXRlZFwiXV0sXG4gIGNhcGFiaWxpdGllczogW1wiRGVubyBvdXRkYXRlZCBkZXBlbmRlbmN5IGNoZWNrXCJdLFxuICBzdWdnZXN0ZWRGaWxlbmFtZTogXCJkZW5vLW91dGRhdGVkLnltbFwiLFxuICBjYXRlZ29yeTogXCJkZXBlbmRlbmN5LXVwZGF0ZVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IERlbm8gRGVwZW5kZW5jeSBVcGRhdGVzXG5cbm9uOlxuICBzY2hlZHVsZTpcbiAgICAtIGNyb246IFwiMCA2ICogKiAxXCJcbiAgd29ya2Zsb3dfZGlzcGF0Y2g6XG5cbnBlcm1pc3Npb25zOlxuICBjb250ZW50czogd3JpdGVcbiAgcHVsbC1yZXF1ZXN0czogd3JpdGVcblxuJHtDT05DVVJSRU5DWV9CTE9DS31cblxuam9iczpcbiAgb3V0ZGF0ZWQ6XG4gICAgcnVucy1vbjogdWJ1bnR1LWxhdGVzdFxuICAgIHRpbWVvdXQtbWludXRlczogJHtERVBFTkRFTkNZX1VQREFURV9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAjIGNyZWF0ZS1wdWxsLXJlcXVlc3QgcHVzaGVzIHdpdGggaXRzIG93biBcXGB0b2tlblxcYCBpbnB1dCwgc28gdGhlIGNoZWNrb3V0XG4gICAgICAjIGNyZWRlbnRpYWwgaXMgbm90IG5lZWRlZCBhbmQgaXMgbm90IHBlcnNpc3RlZC5cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL2NoZWNrb3V0XCIpfVxuJHtDSEVDS09VVF9OT19DUkVERU5USUFMU31cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJkZW5vbGFuZC9zZXR1cC1kZW5vXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIGRlbm8tdmVyc2lvbjogdjIueFxuICAgICAgIyBTdXBwbHktY2hhaW4gcXVhcmFudGluZSB2aWEgbmF0aXZlIERlbm8gdG9vbGluZyAoSXNzdWVzICMyNTQwLCAjMjUzOSk6XG4gICAgICAjIGV4dGVybmFsIERlbm8gZGVwcyBtdXN0IGJlIGF0IGxlYXN0IDI0aCBvbGQgKCR7Q0FOT05JQ0FMX01JTklNVU1fREVQRU5ERU5DWV9BR0V9IGZsb29yKS5cbiAgICAgICMgSW50ZXJuYWwgc3RTb2Z0d2FyZUFVIHNjb3BlcyAoJHtJTlRFUk5BTF9TQ09QRV9FWENMVURFUy5qb2luKFwiLCBcIil9KVxuICAgICAgIyB1cGRhdGUgaW1tZWRpYXRlbHkgKDBoKSDigJQgZXhlbXB0IHZpYSB0aGlzIHJlcG8ncyBkZW5vLmpzb25cbiAgICAgICMgbWluaW11bURlcGVuZGVuY3lBZ2UuZXhjbHVkZSBsaXN0LiBObyBjdXN0b20gcXVhcmFudGluZSBzY3JpcHQuXG4gICAgICAtIHJ1bjogZGVubyBvdXRkYXRlZCAtLXVwZGF0ZSAtLWxhdGVzdCAtLW1pbmltdW0tZGVwZW5kZW5jeS1hZ2U9JHtDQU5PTklDQUxfTUlOSU1VTV9ERVBFTkRFTkNZX0FHRX1cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJwZXRlci1ldmFucy9jcmVhdGUtcHVsbC1yZXF1ZXN0XCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgICMgT3JnLWxldmVsIFBBVCAoSXNzdWUgIzE2MzYpOyBmYWxscyBiYWNrIHRvIEdJVEhVQl9UT0tFTiB3aGVuXG4gICAgICAgICAgIyB0aGUgc2VjcmV0IGlzIHVuc2V0LiBVc2luZyB0aGUgUEFUIGVuc3VyZXMgZG93bnN0cmVhbSBQUlxuICAgICAgICAgICMgd29ya2Zsb3dzIGZpcmUgb24gdGhlIHJlc3VsdGluZyBwdWxsIHJlcXVlc3QuXG4gICAgICAgICAgdG9rZW46IFxcJHt7IHNlY3JldHMuQUNUSU9OU19QVVNIIHx8IHNlY3JldHMuR0lUSFVCX1RPS0VOIH19XG4gICAgICAgICAgY29tbWl0LW1lc3NhZ2U6IFwiY2hvcmU6IHVwZGF0ZSBEZW5vIGRlcGVuZGVuY2llc1wiXG4gICAgICAgICAgdGl0bGU6IFwiY2hvcmU6IHVwZGF0ZSBEZW5vIGRlcGVuZGVuY2llc1wiXG4gICAgICAgICAgYnJhbmNoOiBjaG9yZS9kZW5vLW91dGRhdGVkXG4gICAgICAgICAgYm9keTogXCJBdXRvbWF0ZWQgRGVubyBkZXBlbmRlbmN5IHVwZGF0ZSB2aWEgZGVubyBvdXRkYXRlZC5cIlxuYCxcbn07XG5cbmNvbnN0IGRlbm9RdWFsaXR5OiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcImRlbm8tcXVhbGl0eVwiLFxuICBuYW1lOiBcIkRlbm8gTGludCBhbmQgRm9ybWF0XCIsXG4gIGFwcGxpZXNUbzogW1wiRGVub1wiXSxcbiAgcm9vdFByb2plY3RNYXJrZXJzOiBbXCJkZW5vLmpzb25cIiwgXCJkZW5vLmpzb25jXCJdLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1wiZGVubyBsaW50XCJdLCBbXCJkZW5vIGZtdFwiXSwgW1wiZGVubyBjaGVja1wiXV0sXG4gIGNhcGFiaWxpdGllczogW1wiTGludGluZ1wiLCBcIkZvcm1hdHRpbmdcIiwgXCJUeXBlIGNoZWNraW5nXCJdLFxuICBzdWdnZXN0ZWRGaWxlbmFtZTogXCJkZW5vLXF1YWxpdHkueW1sXCIsXG4gIGNhdGVnb3J5OiBcInF1YWxpdHlcIixcbiAgdGVtcGxhdGU6IGBuYW1lOiBEZW5vIFF1YWxpdHlcblxub246XG4gIHB1bGxfcmVxdWVzdDpcbiAgICBicmFuY2hlczogJHtQVUxMX1JFUVVFU1RfQlJBTkNIRVN9XG5cbnBlcm1pc3Npb25zOlxuICBjb250ZW50czogcmVhZFxuXG4ke0NPTkNVUlJFTkNZX0JMT0NLfVxuXG5qb2JzOlxuICBxdWFsaXR5OlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6ICR7U0NBTl9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiZGVub2xhbmQvc2V0dXAtZGVub1wiKX1cbiAgICAgICAgd2l0aDpcbiAgICAgICAgICBkZW5vLXZlcnNpb246IHYyLnhcbiAgICAgIC0gcnVuOiBkZW5vIGxpbnRcbiAgICAgIC0gcnVuOiBkZW5vIGZtdCAtLWNoZWNrXG4gICAgICAtIHJ1bjogZGVubyBjaGVjayAuXG4gICAgICAjIFJ1biB0ZXN0cyB3aXRoIGNvdmVyYWdlIGFuZCB1cGxvYWQgdG8gQ29kZWNvdiAoSXNzdWUgIzE2MzYpLlxuICAgICAgIyBUaGUgY29kZWNvdi1hY3Rpb24gaXMgYSBuby1vcCB3aGVuIG5vIHRlc3QgZmlsZXMgYXJlIGZvdW5kLlxuICAgICAgLSBydW46IGRlbm8gdGVzdCAtLWFsbG93LXJlYWQgLS1hbGxvdy1lbnYgLS1jb3ZlcmFnZT1jb3ZfcHJvZmlsZVxuICAgICAgLSBydW46IGRlbm8gY292ZXJhZ2UgY292X3Byb2ZpbGUgLS1sY292IC0tb3V0cHV0PWNvdmVyYWdlLmxjb3ZcbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJjb2RlY292L2NvZGVjb3YtYWN0aW9uXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIGZpbGVzOiBjb3ZlcmFnZS5sY292XG4gICAgICAgICAgdG9rZW46IFxcJHt7IHNlY3JldHMuQ09ERUNPVl9UT0tFTiB9fVxuICAgICAgICAgIGZhaWxfY2lfaWZfZXJyb3I6IGZhbHNlXG5gLFxufTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBOb2RlIHdvcmtmbG93c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNvbnN0IG5wbUF1ZGl0OiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcIm5wbS1hdWRpdFwiLFxuICBuYW1lOiBcIk5QTSBTZWN1cml0eSBBdWRpdFwiLFxuICBhcHBsaWVzVG86IFtcIk5vZGVcIiwgXCJSZWFjdC9XZWJcIl0sXG4gIHJvb3RQcm9qZWN0TWFya2VyczogW1wicGFja2FnZS5qc29uXCJdLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCIsIFwic2NoZWR1bGVcIl0sXG4gIGRldGVjdGlvblBhdHRlcm5Hcm91cHM6IFtbXCJucG0gYXVkaXRcIiwgXCJucG0tYXVkaXRcIiwgXCJhdWRpdC1jaVwiXV0sXG4gIGNhcGFiaWxpdGllczogW1wiTlBNIHNlY3VyaXR5IGF1ZGl0XCJdLFxuICBzdWdnZXN0ZWRGaWxlbmFtZTogXCJucG0tYXVkaXQueW1sXCIsXG4gIGNhdGVnb3J5OiBcInNlY3VyaXR5XCIsXG4gIHRlbXBsYXRlOiBgbmFtZTogTlBNIEF1ZGl0XG5cbm9uOlxuICBwdWxsX3JlcXVlc3Q6XG4gICAgYnJhbmNoZXM6ICR7UFVMTF9SRVFVRVNUX0JSQU5DSEVTfVxuICBzY2hlZHVsZTpcbiAgICAtIGNyb246IFwiMCA2ICogKiAxXCJcblxucGVybWlzc2lvbnM6XG4gIGNvbnRlbnRzOiByZWFkXG5cbiR7Q09OQ1VSUkVOQ1lfQkxPQ0t9XG5cbmpvYnM6XG4gIGF1ZGl0OlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6ICR7U0NBTl9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9zZXR1cC1ub2RlXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIG5vZGUtdmVyc2lvbjogXCJsdHMvKlwiXG4gICAgICAtIHJ1bjogbnBtIGNpXG4gICAgICAtIHJ1bjogbnBtIGF1ZGl0IC0tYXVkaXQtbGV2ZWw9aGlnaFxuYCxcbn07XG5cbmNvbnN0IG5wbURlcGVuZGVuY3lVcGRhdGVzOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcIm5wbS1kZXBlbmRlbmN5LXVwZGF0ZXNcIixcbiAgbmFtZTogXCJOUE0gRGVwZW5kZW5jeSBVcGRhdGVzXCIsXG4gIGFwcGxpZXNUbzogW1wiTm9kZVwiLCBcIlJlYWN0L1dlYlwiXSxcbiAgcm9vdFByb2plY3RNYXJrZXJzOiBbXCJwYWNrYWdlLmpzb25cIl0sXG4gIHRyaWdnZXJzOiBbXCJzY2hlZHVsZVwiXSxcbiAgZGV0ZWN0aW9uUGF0dGVybkdyb3VwczogW1tcbiAgICBcImRlcGVuZGFib3RcIixcbiAgICBcInJlbm92YXRlXCIsXG4gICAgXCJucG0tY2hlY2stdXBkYXRlc1wiLFxuICAgIFwibmN1XCIsXG4gIF1dLFxuICBjYXBhYmlsaXRpZXM6IFtcIkF1dG9tYXRlZCBkZXBlbmRlbmN5IHVwZGF0ZXNcIl0sXG4gIHN1Z2dlc3RlZEZpbGVuYW1lOiBcImRlcGVuZGFib3QueW1sXCIsXG4gIGNhdGVnb3J5OiBcImRlcGVuZGVuY3ktdXBkYXRlXCIsXG4gIHRlbXBsYXRlOiBgIyBEZXBlbmRhYm90IGNvbmZpZ3VyYXRpb24gKHBsYWNlIGluIC5naXRodWIvZGVwZW5kYWJvdC55bWwpXG52ZXJzaW9uOiAyXG51cGRhdGVzOlxuICAtIHBhY2thZ2UtZWNvc3lzdGVtOiBucG1cbiAgICBkaXJlY3Rvcnk6IC9cbiAgICBzY2hlZHVsZTpcbiAgICAgIGludGVydmFsOiB3ZWVrbHlcbiAgICBvcGVuLXB1bGwtcmVxdWVzdHMtbGltaXQ6IDEwXG4gICAgbGFiZWxzOlxuICAgICAgLSBkZXBlbmRlbmNpZXNcbmAsXG59O1xuXG5jb25zdCBlc2xpbnRRdWFsaXR5OiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcImVzbGludC1xdWFsaXR5XCIsXG4gIG5hbWU6IFwiRVNMaW50IENvZGUgUXVhbGl0eVwiLFxuICBhcHBsaWVzVG86IFtcIk5vZGVcIiwgXCJSZWFjdC9XZWJcIl0sXG4gIHJvb3RQcm9qZWN0TWFya2VyczogW1wicGFja2FnZS5qc29uXCJdLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1wiZXNsaW50XCIsIFwibnB4IGVzbGludFwiLCBcIm5wbSBydW4gbGludFwiXV0sXG4gIGNhcGFiaWxpdGllczogW1wiRVNMaW50IGxpbnRpbmdcIl0sXG4gIHN1Z2dlc3RlZEZpbGVuYW1lOiBcImVzbGludC55bWxcIixcbiAgY2F0ZWdvcnk6IFwicXVhbGl0eVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IEVTTGludFxuXG5vbjpcbiAgcHVsbF9yZXF1ZXN0OlxuICAgIGJyYW5jaGVzOiAke1BVTExfUkVRVUVTVF9CUkFOQ0hFU31cblxucGVybWlzc2lvbnM6XG4gIGNvbnRlbnRzOiByZWFkXG5cbiR7Q09OQ1VSUkVOQ1lfQkxPQ0t9XG5cbmpvYnM6XG4gIGxpbnQ6XG4gICAgcnVucy1vbjogdWJ1bnR1LWxhdGVzdFxuICAgIHRpbWVvdXQtbWludXRlczogJHtTQ0FOX1RJTUVPVVRfTUlOVVRFU31cbiAgICBzdGVwczpcbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL2NoZWNrb3V0XCIpfVxuJHtDSEVDS09VVF9OT19DUkVERU5USUFMU31cbiAgICAgIC0gdXNlczogJHtwaW5uZWRBY3Rpb24oXCJhY3Rpb25zL3NldHVwLW5vZGVcIil9XG4gICAgICAgIHdpdGg6XG4gICAgICAgICAgbm9kZS12ZXJzaW9uOiBcImx0cy8qXCJcbiAgICAgIC0gcnVuOiBucG0gY2lcbiAgICAgIC0gcnVuOiBucHggZXNsaW50IC5cbmAsXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEphdmEgd29ya2Zsb3dzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgamF2YURlcGVuZGVuY3lDaGVjazogV29ya2Zsb3dTcGVjID0ge1xuICBpZDogXCJqYXZhLWRlcGVuZGVuY3ktY2hlY2tcIixcbiAgbmFtZTogXCJKYXZhIERlcGVuZGVuY3kgU2VjdXJpdHkgQ2hlY2tcIixcbiAgYXBwbGllc1RvOiBbXCJKYXZhXCJdLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCIsIFwic2NoZWR1bGVcIl0sXG4gIGRldGVjdGlvblBhdHRlcm5Hcm91cHM6IFtbXG4gICAgXCJvd2FzcFwiLFxuICAgIFwiZGVwZW5kZW5jeS1jaGVja1wiLFxuICAgIFwibXZuIGRlcGVuZGVuY3k6Y2hlY2tcIixcbiAgICBcIm9yZy5vd2FzcFwiLFxuICBdXSxcbiAgY2FwYWJpbGl0aWVzOiBbXCJEZXBlbmRlbmN5IHZ1bG5lcmFiaWxpdHkgc2NhblwiXSxcbiAgc3VnZ2VzdGVkRmlsZW5hbWU6IFwiamF2YS1kZXBlbmRlbmN5LWNoZWNrLnltbFwiLFxuICBjYXRlZ29yeTogXCJzZWN1cml0eVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IEphdmEgRGVwZW5kZW5jeSBDaGVja1xuXG5vbjpcbiAgcHVsbF9yZXF1ZXN0OlxuICAgIGJyYW5jaGVzOiAke1BVTExfUkVRVUVTVF9CUkFOQ0hFU31cbiAgc2NoZWR1bGU6XG4gICAgLSBjcm9uOiBcIjAgNiAqICogMVwiXG5cbnBlcm1pc3Npb25zOlxuICBjb250ZW50czogcmVhZFxuXG4ke0NPTkNVUlJFTkNZX0JMT0NLfVxuXG5qb2JzOlxuICBkZXBlbmRlbmN5LWNoZWNrOlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6ICR7U0NBTl9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9zZXR1cC1qYXZhXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIGRpc3RyaWJ1dGlvbjogdGVtdXJpblxuICAgICAgICAgIGphdmEtdmVyc2lvbjogXCIyMVwiXG4gICAgICAtIG5hbWU6IE9XQVNQIERlcGVuZGVuY3kgQ2hlY2tcbiAgICAgICAgdXNlczogJHtwaW5uZWRBY3Rpb24oXCJkZXBlbmRlbmN5LWNoZWNrL0RlcGVuZGVuY3ktQ2hlY2tfQWN0aW9uXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIHByb2plY3Q6IFxcJHt7IGdpdGh1Yi5yZXBvc2l0b3J5IH19XG4gICAgICAgICAgcGF0aDogLlxuICAgICAgICAgIGZvcm1hdDogSFRNTFxuICAgICAgLSB1c2VzOiAke3Bpbm5lZEFjdGlvbihcImFjdGlvbnMvdXBsb2FkLWFydGlmYWN0XCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIG5hbWU6IGRlcGVuZGVuY3ktY2hlY2stcmVwb3J0XG4gICAgICAgICAgcGF0aDogcmVwb3J0cy9cbmAsXG59O1xuXG4vLyBNYXZlbiBhbmQgR3JhZGxlIGFyZSBzcGxpdCBpbnRvIHNlcGFyYXRlIHNwZWNzIHNvIGVhY2ggb25lIGlzIGtleWVkIHRvIGl0c1xuLy8gb3duIHJvb3QgYnVpbGQgZmlsZSBhbmQgZGV0ZWN0cyBvbmx5IGl0cyBvd24gRGVwZW5kYWJvdCBlY29zeXN0ZW0gZW50cnkuIEFcbi8vIHJlcG8gd2l0aCBib3RoIGJ1aWxkIGZpbGVzIG5lZWRzIGJvdGggYHVwZGF0ZXNgIGVudHJpZXMgaW4gdGhlIG9uZVxuLy8gLmdpdGh1Yi9kZXBlbmRhYm90LnltbC5cbmNvbnN0IGphdmFEZXBlbmRlbmN5VXBkYXRlczogV29ya2Zsb3dTcGVjID0ge1xuICBpZDogXCJqYXZhLWRlcGVuZGVuY3ktdXBkYXRlc1wiLFxuICBuYW1lOiBcIkphdmEgTWF2ZW4gRGVwZW5kZW5jeSBVcGRhdGVzXCIsXG4gIGFwcGxpZXNUbzogW1wiSmF2YVwiXSxcbiAgcm9vdFByb2plY3RNYXJrZXJzOiBbXCJwb20ueG1sXCJdLFxuICB0cmlnZ2VyczogW1wic2NoZWR1bGVcIl0sXG4gIGRldGVjdGlvblBhdHRlcm5Hcm91cHM6IFtbXG4gICAgXCJwYWNrYWdlLWVjb3N5c3RlbTogbWF2ZW5cIixcbiAgICAncGFja2FnZS1lY29zeXN0ZW06IFwibWF2ZW5cIicsXG4gICAgXCJyZW5vdmF0ZVwiLFxuICAgIFwidmVyc2lvbnMtbWF2ZW4tcGx1Z2luXCIsXG4gIF1dLFxuICBjYXBhYmlsaXRpZXM6IFtcIkF1dG9tYXRlZCBkZXBlbmRlbmN5IHVwZGF0ZXNcIl0sXG4gIHN1Z2dlc3RlZEZpbGVuYW1lOiBcImphdmEtZGVwZW5kYWJvdC55bWxcIixcbiAgY2F0ZWdvcnk6IFwiZGVwZW5kZW5jeS11cGRhdGVcIixcbiAgdGVtcGxhdGU6XG4gICAgYCMgRGVwZW5kYWJvdCBjb25maWd1cmF0aW9uIGZvciBNYXZlbiAocGxhY2UgaW4gLmdpdGh1Yi9kZXBlbmRhYm90LnltbClcbnZlcnNpb246IDJcbnVwZGF0ZXM6XG4gIC0gcGFja2FnZS1lY29zeXN0ZW06IG1hdmVuXG4gICAgZGlyZWN0b3J5OiAvXG4gICAgc2NoZWR1bGU6XG4gICAgICBpbnRlcnZhbDogd2Vla2x5XG4gICAgb3Blbi1wdWxsLXJlcXVlc3RzLWxpbWl0OiAxMFxuICAgIGxhYmVsczpcbiAgICAgIC0gZGVwZW5kZW5jaWVzXG5gLFxufTtcblxuY29uc3QgamF2YUdyYWRsZURlcGVuZGVuY3lVcGRhdGVzOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcImphdmEtZ3JhZGxlLWRlcGVuZGVuY3ktdXBkYXRlc1wiLFxuICBuYW1lOiBcIkphdmEgR3JhZGxlIERlcGVuZGVuY3kgVXBkYXRlc1wiLFxuICBhcHBsaWVzVG86IFtcIkphdmFcIl0sXG4gIHJvb3RQcm9qZWN0TWFya2VyczogW1wiYnVpbGQuZ3JhZGxlXCIsIFwiYnVpbGQuZ3JhZGxlLmt0c1wiXSxcbiAgdHJpZ2dlcnM6IFtcInNjaGVkdWxlXCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1xuICAgIFwicGFja2FnZS1lY29zeXN0ZW06IGdyYWRsZVwiLFxuICAgICdwYWNrYWdlLWVjb3N5c3RlbTogXCJncmFkbGVcIicsXG4gICAgXCJyZW5vdmF0ZVwiLFxuICAgIFwiZ3JhZGxlLXZlcnNpb25zLXBsdWdpblwiLFxuICBdXSxcbiAgY2FwYWJpbGl0aWVzOiBbXCJBdXRvbWF0ZWQgZGVwZW5kZW5jeSB1cGRhdGVzXCJdLFxuICBzdWdnZXN0ZWRGaWxlbmFtZTogXCJqYXZhLWdyYWRsZS1kZXBlbmRhYm90LnltbFwiLFxuICBjYXRlZ29yeTogXCJkZXBlbmRlbmN5LXVwZGF0ZVwiLFxuICB0ZW1wbGF0ZTpcbiAgICBgIyBEZXBlbmRhYm90IGNvbmZpZ3VyYXRpb24gZm9yIEdyYWRsZSAocGxhY2UgaW4gLmdpdGh1Yi9kZXBlbmRhYm90LnltbClcbnZlcnNpb246IDJcbnVwZGF0ZXM6XG4gIC0gcGFja2FnZS1lY29zeXN0ZW06IGdyYWRsZVxuICAgIGRpcmVjdG9yeTogL1xuICAgIHNjaGVkdWxlOlxuICAgICAgaW50ZXJ2YWw6IHdlZWtseVxuICAgIG9wZW4tcHVsbC1yZXF1ZXN0cy1saW1pdDogMTBcbiAgICBsYWJlbHM6XG4gICAgICAtIGRlcGVuZGVuY2llc1xuYCxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVW5pdmVyc2FsIE1hcmtkb3duIHdvcmtmbG93c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNvbnN0IG1hcmtkb3duTGludDogV29ya2Zsb3dTcGVjID0ge1xuICBpZDogXCJtYXJrZG93bi1saW50XCIsXG4gIG5hbWU6IFwiTWFya2Rvd24gTGludFwiLFxuICBhcHBsaWVzVG86IFwidW5pdmVyc2FsXCIsXG4gIC8vIElzc3VlICMxNjM5IOKAlCBwdWxsLXJlcXVlc3Qgb25seS4gUmUtcnVubmluZyB0aGUgZ2F0ZSBvbiB0aGUgcG9zdC1tZXJnZVxuICAvLyBwdXNoIGR1cGxpY2F0ZXMgdGhlIFBSIHJ1biB3aXRoIG5vIGVuZm9yY2VtZW50IHZhbHVlLCBhbmQgdGhlIGF1ZGl0J3NcbiAgLy8gdHJpZ2dlciBwcmUtZmlsZXIgZmlsZXMgaXQgYXMgYSBmaW5kaW5nIGFnYWluc3QgdGhlIGZsZWV0J3Mgb3duIHRlbXBsYXRlLlxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1wibWFya2Rvd25saW50LWNsaTJcIiwgXCJtYXJrZG93bmxpbnRcIl1dLFxuICBjYXBhYmlsaXRpZXM6IFtcIk1hcmtkb3duIHN0cnVjdHVyYWwgbGludGluZ1wiXSxcbiAgc3VnZ2VzdGVkRmlsZW5hbWU6IFwibWFya2Rvd24tbGludC55bWxcIixcbiAgY2F0ZWdvcnk6IFwicXVhbGl0eVwiLFxuICAvLyBQaW5zIHRoaXJkLXBhcnR5IGFjdGlvbnMgdG8gY29tbWl0IFNIQXMgKElzc3VlICMxNjg2KSBzbyBhIGhpamFja2VkIHRhZ1xuICAvLyBjYW5ub3QgaW5qZWN0IGNvZGUgaW50byBDSSwgYW5kIGBtYXJrZG93bmxpbnQtY2xpMmAgdG8gYW4gZXhhY3QgdmVyc2lvblxuICAvLyAoSXNzdWUgIzE2MzkpIHNvIHRoZSBpbnN0YWxsIHNpdHMgaW5zaWRlIHRoZSBzdXBwbHktY2hhaW4gcXVhcmFudGluZS5cbiAgLy8gUmV1c2VzIHRoZSBzYW1lIGAubWFya2Rvd25saW50LWNsaTIuanNvbmNgIGNvbmZpZ3VyYXRpb24gdGhhdCBsb2NhbFxuICAvLyBgcXVhbGl0eS5zaGAgY29uc3VtZXMg4oCUIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGgsIG5vIGRyaWZ0LlxuICB0ZW1wbGF0ZTogYG5hbWU6IE1hcmtkb3duIExpbnRcblxub246XG4gIHB1bGxfcmVxdWVzdDpcbiAgICBicmFuY2hlczogJHtQVUxMX1JFUVVFU1RfQlJBTkNIRVN9XG5cbnBlcm1pc3Npb25zOlxuICBjb250ZW50czogcmVhZFxuXG4ke0NPTkNVUlJFTkNZX0JMT0NLfVxuXG5qb2JzOlxuICBtYXJrZG93bmxpbnQ6XG4gICAgcnVucy1vbjogdWJ1bnR1LWxhdGVzdFxuICAgIHRpbWVvdXQtbWludXRlczogJHtTQ0FOX1RJTUVPVVRfTUlOVVRFU31cbiAgICBzdGVwczpcbiAgICAgICMgY2hlY2tvdXQgYW5kIHNldHVwLW5vZGUgcnVuIG9uIHRoZSBOb2RlIDI0IHJ1bnRpbWUgKElzc3VlcyAjMjMxNixcbiAgICAgICMgIzIzMTcpOyB0aGUgdjQgbGluZSByYW4gb24gTm9kZSAyMCwgZGVwcmVjYXRlZCBmb3IgZm9yY2VkIHVwZ3JhZGVcbiAgICAgICMgMjAyNi0wNi0wMiBhbmQgZnVsbCByZW1vdmFsIDIwMjYtMDktMTYuXG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9zZXR1cC1ub2RlXCIpfVxuICAgICAgICB3aXRoOlxuICAgICAgICAgIG5vZGUtdmVyc2lvbjogXCJsdHMvKlwiXG4gICAgICAjIFBpbm5lZCB0byBhbiBleGFjdCB2ZXJzaW9uIHNvIHRoZSBpbnN0YWxsIHNpdHMgaW5zaWRlIHRoZSAyNGhcbiAgICAgICMgZGVwZW5kZW5jeSBxdWFyYW50aW5lIOKAlCBhIFxcYHJ1bjpcXGAgaW5zdGFsbCBpcyBub3QgYSBtYW5pZmVzdCwgc28gbm9cbiAgICAgICMgZGVwZW5kZW5jeSBtYW5hZ2VyIGdvdmVybnMgaXQuIFxcYC0taWdub3JlLXNjcmlwdHNcXGAga2VlcHNcbiAgICAgICMgaW5zdGFsbC10aW1lIGxpZmVjeWNsZSBzY3JpcHRzIGZyb20gdGhlIGRlcGVuZGVuY3kgdHJlZSBvZmYgdGhlXG4gICAgICAjIHJ1bm5lci5cbiAgICAgIC0gbmFtZTogSW5zdGFsbCBtYXJrZG93bmxpbnQtY2xpMlxuICAgICAgICBydW46IG5wbSBpbnN0YWxsIC1nIC0taWdub3JlLXNjcmlwdHMgbWFya2Rvd25saW50LWNsaTJAJHtNQVJLRE9XTkxJTlRfQ0xJMl9WRVJTSU9OfVxuICAgICAgLSBuYW1lOiBSdW4gbWFya2Rvd25saW50LWNsaTJcbiAgICAgICAgcnVuOiBtYXJrZG93bmxpbnQtY2xpMlxuYCxcbn07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQmFzaCB3b3JrZmxvd3Ncbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBzaGVsbGNoZWNrOiBXb3JrZmxvd1NwZWMgPSB7XG4gIGlkOiBcInNoZWxsY2hlY2tcIixcbiAgbmFtZTogXCJTaGVsbENoZWNrIExpbnRcIixcbiAgYXBwbGllc1RvOiBbXCJCYXNoXCJdLFxuICB0cmlnZ2VyczogW1wicHVsbF9yZXF1ZXN0XCJdLFxuICBkZXRlY3Rpb25QYXR0ZXJuR3JvdXBzOiBbW1xuICAgIFwic2hlbGxjaGVja1wiLFxuICAgIFwia29hbGFtYW4vc2hlbGxjaGVja1wiLFxuICAgIFwibHVkZWV1cy9hY3Rpb24tc2hlbGxjaGVja1wiLFxuICBdXSxcbiAgY2FwYWJpbGl0aWVzOiBbXCJTaGVsbCBzY3JpcHQgbGludGluZ1wiXSxcbiAgc3VnZ2VzdGVkRmlsZW5hbWU6IFwic2hlbGxjaGVjay55bWxcIixcbiAgY2F0ZWdvcnk6IFwicXVhbGl0eVwiLFxuICB0ZW1wbGF0ZTogYG5hbWU6IFNoZWxsQ2hlY2tcblxub246XG4gIHB1bGxfcmVxdWVzdDpcbiAgICBicmFuY2hlczogJHtQVUxMX1JFUVVFU1RfQlJBTkNIRVN9XG5cbnBlcm1pc3Npb25zOlxuICBjb250ZW50czogcmVhZFxuXG4ke0NPTkNVUlJFTkNZX0JMT0NLfVxuXG5qb2JzOlxuICBzaGVsbGNoZWNrOlxuICAgIHJ1bnMtb246IHVidW50dS1sYXRlc3RcbiAgICB0aW1lb3V0LW1pbnV0ZXM6ICR7U0NBTl9USU1FT1VUX01JTlVURVN9XG4gICAgc3RlcHM6XG4gICAgICAtIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwiYWN0aW9ucy9jaGVja291dFwiKX1cbiR7Q0hFQ0tPVVRfTk9fQ1JFREVOVElBTFN9XG4gICAgICAtIG5hbWU6IFJ1biBTaGVsbENoZWNrXG4gICAgICAgIHVzZXM6ICR7cGlubmVkQWN0aW9uKFwibHVkZWV1cy9hY3Rpb24tc2hlbGxjaGVja1wiKX1cbiAgICAgICAgd2l0aDpcbiAgICAgICAgICBzY2FuZGlyOiAuXG4gICAgICAgICAgc2V2ZXJpdHk6IHdhcm5pbmdcbmAsXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEV4cG9ydGVkIGNhdGFsb2d1ZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBDb21wbGV0ZSBjYXRhbG9ndWUgb2YgYWxsIHdvcmtmbG93IHNwZWNpZmljYXRpb25zLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktGTE9XX1NQRUNTOiBSZWFkb25seUFycmF5PFdvcmtmbG93U3BlYz4gPSBbXG4gIC8vIFVuaXZlcnNhbFxuICBnaXRsZWFrcyxcbiAgc2VtZ3JlcCxcbiAgZGVwZW5kZW5jeVJldmlldyxcbiAgbWFya2Rvd25MaW50LFxuICAvLyBSdXN0XG4gIGNhcmdvQXVkaXQsXG4gIGNhcmdvVXBncmFkZSxcbiAgY2FyZ29RdWFsaXR5LFxuICAvLyBEZW5vXG4gIGRlbm9PdXRkYXRlZCxcbiAgZGVub1F1YWxpdHksXG4gIC8vIE5vZGUgKGFsc28gY292ZXJzIFJlYWN0L1dlYilcbiAgbnBtQXVkaXQsXG4gIG5wbURlcGVuZGVuY3lVcGRhdGVzLFxuICBlc2xpbnRRdWFsaXR5LFxuICAvLyBKYXZhXG4gIGphdmFEZXBlbmRlbmN5Q2hlY2ssXG4gIGphdmFEZXBlbmRlbmN5VXBkYXRlcyxcbiAgamF2YUdyYWRsZURlcGVuZGVuY3lVcGRhdGVzLFxuICAvLyBCYXNoXG4gIHNoZWxsY2hlY2ssXG5dO1xuXG4vKipcbiAqIFJlc29sdmUgYSBodW1hbi1yZWFkYWJsZSBjYXBhYmlsaXR5IGxhYmVsIGZvciBhIGRldGVjdGlvbi1wYXR0ZXJuIGdyb3VwLlxuICpcbiAqIExvb2tzIHVwIHRoZSBtYXRjaGluZyBgY2FwYWJpbGl0aWVzW2ldYCBlbnRyeSBpbiB0aGUgc3BlYyB3aGVuIHRoZSBncm91cFxuICogYXBwZWFycyBpbiBgc3BlYy5kZXRlY3Rpb25QYXR0ZXJuR3JvdXBzYC4gRmFsbHMgYmFjayB0byB0aGUgZmlyc3QgcGF0dGVyblxuICogaW4gdGhlIGdyb3VwIHdoZW4gbm8gZXhwbGljaXQgbGFiZWwgaXMgY29uZmlndXJlZCwgc28gb2xkZXIgc3BlY3MgdGhhdFxuICogcHJlZGF0ZSB0aGUgYGNhcGFiaWxpdGllc2AgZmllbGQgc3RpbGwgcHJvZHVjZSBhIHJlYWRhYmxlIGJ1bGxldCByYXRoZXJcbiAqIHRoYW4gYW4gZW1wdHkgc3RyaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2FwYWJpbGl0eUxhYmVsRm9yR3JvdXAoXG4gIHNwZWM6IFdvcmtmbG93U3BlYyxcbiAgZ3JvdXA6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgaWR4ID0gc3BlYy5kZXRlY3Rpb25QYXR0ZXJuR3JvdXBzLmZpbmRJbmRleChcbiAgICAoZykgPT4gZy5sZW5ndGggPT09IGdyb3VwLmxlbmd0aCAmJiBnLmV2ZXJ5KChwLCBpKSA9PiBwID09PSBncm91cFtpXSksXG4gICk7XG4gIGlmIChpZHggPj0gMCAmJiBzcGVjLmNhcGFiaWxpdGllcyAmJiBzcGVjLmNhcGFiaWxpdGllc1tpZHhdKSB7XG4gICAgcmV0dXJuIHNwZWMuY2FwYWJpbGl0aWVzW2lkeF0hO1xuICB9XG4gIHJldHVybiBncm91cFswXSA/PyBcIkRldGVjdGlvbiBwYXR0ZXJuXCI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUXVlcnkgZnVuY3Rpb25zXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBSZXR1cm4gd29ya2Zsb3cgc3BlY3MgcmVsZXZhbnQgdG8gdGhlIGdpdmVuIGxhbmd1YWdlcy5cbiAqXG4gKiBBbHdheXMgaW5jbHVkZXMgdW5pdmVyc2FsIHNwZWNzLiBMYW5ndWFnZS1zcGVjaWZpYyBzcGVjcyBhcmUgaW5jbHVkZWRcbiAqIHdoZW4gYXQgbGVhc3Qgb25lIG9mIHRoZSBzcGVjJ3MgYGFwcGxpZXNUb2AgbGFuZ3VhZ2VzIG1hdGNoZXMgdGhlXG4gKiByZXF1ZXN0ZWQgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0V29ya2Zsb3dzRm9yTGFuZ3VhZ2VzKFxuICBsYW5ndWFnZXM6IHN0cmluZ1tdLFxuKTogV29ya2Zsb3dTcGVjW10ge1xuICBjb25zdCBsYW5nU2V0ID0gbmV3IFNldChsYW5ndWFnZXMpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHJlc3VsdDogV29ya2Zsb3dTcGVjW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHNwZWMgb2YgV09SS0ZMT1dfU1BFQ1MpIHtcbiAgICBpZiAoc2Vlbi5oYXMoc3BlYy5pZCkpIGNvbnRpbnVlO1xuXG4gICAgaWYgKHNwZWMuYXBwbGllc1RvID09PSBcInVuaXZlcnNhbFwiKSB7XG4gICAgICBzZWVuLmFkZChzcGVjLmlkKTtcbiAgICAgIHJlc3VsdC5wdXNoKHNwZWMpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gTGFuZ3VhZ2Utc3BlY2lmaWM6IGluY2x1ZGUgaWYgYW55IG9mIHRoZSBzcGVjJ3MgbGFuZ3VhZ2VzIG1hdGNoLlxuICAgIGNvbnN0IG1hdGNoZXMgPSBzcGVjLmFwcGxpZXNUby5zb21lKChsYW5nKSA9PiBsYW5nU2V0LmhhcyhsYW5nKSk7XG4gICAgaWYgKG1hdGNoZXMpIHtcbiAgICAgIHNlZW4uYWRkKHNwZWMuaWQpO1xuICAgICAgcmVzdWx0LnB1c2goc3BlYyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLyoqXG4gKiBSZXR1cm4gd29ya2Zsb3cgc3BlY3MgcmVsZXZhbnQgdG8gdGhlIGdpdmVuIGxhbmd1YWdlcywgZmlsdGVyZWQgYnlcbiAqIHJlcG9zaXRvcnkgdmlzaWJpbGl0eS5cbiAqXG4gKiBEZWxlZ2F0ZXMgdG8ge0BsaW5rIGdldFdvcmtmbG93c0Zvckxhbmd1YWdlc30gYW5kIHRoZW4gZHJvcHMgYW55IHNwZWNcbiAqIG1hcmtlZCBgdmlzaWJpbGl0eVNjb3BlOiBcInB1YmxpYy1vbmx5XCJgIHdoZW4gYHZpc2liaWxpdHkgPT09IFwicHJpdmF0ZVwiYC5cbiAqIFNwZWNzIHdpdGhvdXQgYW4gZXhwbGljaXQgYHZpc2liaWxpdHlTY29wZWAgYXJlIHRyZWF0ZWQgYXMgYFwiYW55XCJgIGFuZFxuICogYWx3YXlzIHBhc3MgdGhlIGZpbHRlci5cbiAqXG4gKiBJc3N1ZSAjMTc1My5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFdvcmtmbG93c0Zvckxhbmd1YWdlc0FuZFZpc2liaWxpdHkoXG4gIGxhbmd1YWdlczogc3RyaW5nW10sXG4gIHZpc2liaWxpdHk6IFJlcG9WaXNpYmlsaXR5LFxuKTogV29ya2Zsb3dTcGVjW10ge1xuICBjb25zdCBzcGVjcyA9IGdldFdvcmtmbG93c0Zvckxhbmd1YWdlcyhsYW5ndWFnZXMpO1xuICBpZiAodmlzaWJpbGl0eSA9PT0gXCJwdWJsaWNcIikge1xuICAgIHJldHVybiBzcGVjcztcbiAgfVxuICByZXR1cm4gc3BlY3MuZmlsdGVyKChzKSA9PiBzLnZpc2liaWxpdHlTY29wZSAhPT0gXCJwdWJsaWMtb25seVwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Q0FRQyxHQUdELFNBQ0UsZ0NBQWdDLEVBQ2hDLHVCQUF1QixRQUNsQixtQ0FBbUM7QUFDMUMsU0FBUyxZQUFZLEVBQUUsYUFBYSxRQUFRLHNCQUFz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
// denoCacheMetadata=2967368125053723771,14592483209384095735