# Bucket: `general`

This bucket reviews **repo-level hygiene only** — not language-specific
code quality. Language-specific concerns belong to their own bucket
(`rust`, `typescript`, `react`, `java`, `html`, `aws-cloudformation`,
`terraform`).

Canonical guides — link, do not restate:

- Open Source Guides — <https://opensource.guide/>
- Keep a Changelog — <https://keepachangelog.com/>
- SemVer — <https://semver.org/>
- SPDX licence identifiers — <https://spdx.org/licenses/>
- SLSA supply-chain levels — <https://slsa.dev/>

## Checks

1. **Docs floor.** Repo has a `README.md` that describes what the
   project does, how to install / run it, and where to look next.
   A non-trivial project also has `CONTRIBUTING.md`,
   `CHANGELOG.md`, and a `LICENSE` (or `LICENCE`) file. Flag
   missing or stub README; flag missing licence file on a public
   repo.
2. **Licence is declared and consistent.** The repo's licence file
   and the licence field in any manifest (`package.json`,
   `Cargo.toml`, `pom.xml`) agree, and the identifier uses an SPDX
   short code (`MIT`, `Apache-2.0`, `GPL-3.0-only`). Flag missing
   or inconsistent licence metadata.
3. **CI/CD hygiene.** A CI workflow exists and runs on every PR;
   required status checks are configured on the default branch via
   branch protection (or repository ruleset). Third-party actions
   are pinned to commit SHAs. Flag repos with no CI on PRs, or
   with `actions/*@vN` pins on third-party actions. (Per-workflow
   detail belongs to the separate github-actions-audit scan — this
   check is "is there CI at all".)
4. **Test coverage signal.** Repo has a tests directory or a test
   target in its build manifest, and CI runs them. Flag repos
   that ship code with no tests, and flag a CI workflow that
   builds but never runs the test target.
5. **Dependency hygiene at the repo level.** Renovate or
   Dependabot is configured for the repo's dominant ecosystem(s),
   with an external-dependency quarantine window (Renovate
   `minimumReleaseAge` ≥ 24h, or per-repo `bump-deps.sh` with an
   age gate). Internal `stSoftwareAU/*` dependencies are
   excluded from the quarantine so they update immediately. Flag
   repos with no auto-update tooling, or with a quarantine that
   gates internal dependencies.
6. **Error handling / logging / observability posture.** A library
   surfaces structured errors (no string-typed errors crossing
   public APIs); a service emits structured logs with a
   consistent format; long-running services expose health and
   readiness signals. Flag repos that `println` errors from
   library code or that have no health endpoint on a service.
7. **Repo structure and naming.** Top-level directories are
   self-describing (`src/`, `tests/`, `docs/`, `scripts/`, …); no
   "miscellaneous" dumping ground; binary artefacts and generated
   output are not committed; the repo name matches its purpose.
   Flag obvious structural smells (e.g. a `temp/` or `old/`
   directory at the root).
8. **SBOM and supply-chain pinning.** Lockfiles are committed
   (`package-lock.json`, `Cargo.lock` for binaries, `deno.lock`,
   `pnpm-lock.yaml`); release artefacts publish an SBOM
   (CycloneDX or SPDX JSON). Each build generates and diffs the
   SBOM against the previous release so a new transitive dep
   surfaces visibly (the Axios phantom-dep shape from May 2026).
   Flag missing lockfiles on reproducible builds and flag a release
   pipeline that does not emit an SBOM.
9. **Accessibility (UI repos only).** A repo that ships a UI has
   an automated a11y check (axe, pa11y, jest-axe) wired into CI,
   not just manual review. Flag UI repos with no automated a11y
   coverage.
10. **Licence headers / SPDX compliance.** Repos that require
    per-file SPDX headers (per their CONTRIBUTING) have them on
    every source file. Flag missing headers if the project policy
    requires them; do not flag missing headers in projects that
    don't require them.

## Runtime is unambiguous

11. **Runtime is unambiguous.** A repository should commit to a single
    JavaScript/TypeScript runtime, or clearly document a deliberate
    split. Flag a repo that mixes Deno and Node at the root.

    **Detect mixed runtime** by the simultaneous presence of:

    - At least one Deno marker: `deno.json`, `deno.jsonc`, or
      `deno.lock`; **and**
    - a root `package.json` whose `dependencies` field is present and
      non-empty. Dev-only Node tooling (only `devDependencies`, or an
      empty/absent `dependencies`) is treated as parity, not a
      regression — do not flag it.

    When both conditions hold, file **exactly one** `severity:medium`
    finding with this exact title:

    > Repo mixes Deno and Node — choose one runtime or document the split

    **Stable id.** Compute the id with the standard `BP-<12 hex>`
    recipe using the title slug
    `repo-mixes-deno-and-node-choose-one-runtime-or-document-the-split`
    and the primary file `package.json`. The same inputs yield the
    same id across runs, so the existing known-open and suppressed
    dedup lists keep the scan from re-filing.

    **Body content** must explain:

    - Which markers were found — name the discovered Deno marker file
      and the `package.json` path.
    - The default policy: treat the repo as Deno and do not grow the
      Node footprint further (link to the repo's coding guidelines /
      `AGENTS.md`).
    - Suggested fixes: (a) commit fully to Deno and remove the
      `package.json` runtime dependencies; or (b) split the Node
      portion into a sub-directory with its own clearly scoped
      `package.json`; or (c) explicitly document the dual-runtime
      layout in `README.md`.

    This finding counts against the six-issue cap like any other — it
    receives no special exemption, so if six higher-severity findings
    already survive, drop it per the standard priority rules.

    **Single-runtime repos are silent.** A Node-only repo (no Deno
    markers) or a Deno-only repo (no root `package.json` runtime
    dependencies) is not a mixed-runtime repo — file nothing.

## GitHub-native security scanning

12. **GitHub-native security scanning is enabled.** Complement the
    repo-level dependency *update* hygiene check (Renovate /
    Dependabot version-bump cadence and quarantine) with GitHub's
    "secure by default" *security* features. This check is
    **static-evidence only** — judge it from committed workflow and
    config file presence. Where a feature is a repo-level GitHub
    setting that is not statically visible (push protection, the
    secret-scanning toggle, Dependabot alerts), phrase the finding as
    a **recommendation**, not an assertion that the setting is off.

    Inspect, for a repo with a security-sensitive surface (any repo
    that ships code — libraries, services, infrastructure):

    - **Code scanning (CodeQL or equivalent SAST).** A
      `.github/workflows/codeql*.yml` (or the GitHub default-setup
      equivalent) that runs CodeQL on every PR, **or** an equivalent
      SAST step in CI (e.g. `semgrep`, `snyk code`). Statically
      detectable by workflow presence. Flag the absence of any code
      scanning and recommend enabling CodeQL (or an equivalent SAST
      in CI).
    - **Dependabot *security* updates.** Distinct from the version-bump
      cadence of the repo-level dependency-hygiene check — a `.github/dependabot.yml` that enables
      security updates, or reliance on Dependabot alerts. Recommend
      enabling Dependabot security updates where neither is present.
    - **Secret scanning + push protection.** A repo-level GitHub
      setting that is **not always statically visible**. The
      actionable static surface is a committed secret-scanning gate
      (`gitleaks` / `trufflehog` in CI) or a note recommending push
      protection. Recommend enabling secret scanning with push
      protection rather than asserting it is disabled.

    File **at most one** `severity:medium` finding for this check.
    Title it for the dominant gap (e.g. *"Enable GitHub code scanning
    (CodeQL) and Dependabot security updates"*) and list the missing
    features in the body, each with the recommended remediation. Use
    the standard `BP-<12 hex>` id recipe so re-runs deduplicate against
    the known-open and suppressed lists. The finding counts against the
    six-issue cap like any other.

    **Stay static.** Do not call the GitHub API to read repo settings
    and do not assert that a repo-level toggle is off — only file from
    committed-file evidence (a missing code-scanning workflow, a
    `dependabot.yml` without security updates) or as an explicit
    recommendation. A repo that already commits a CodeQL workflow and a
    secret-scanning gate is silent on this check.

## Branch protection and CODEOWNERS depth

13. **Branch protection and CODEOWNERS depth.** Extends the
    CI/CD-hygiene posture with deeper governance signals so a single
    compromised account (or a self-approving malicious PR) cannot
    quietly merge changes to `.github/workflows/` — which then run
    with secrets. This check is **static-evidence only**: read
    committed files (`CODEOWNERS`, `git log --show-signature`); do
    **not** call the GitHub API to inspect repo-level settings.
    Where a control is a repo-level setting that is not statically
    visible (required review, no force-push, linear history),
    phrase the finding as a **recommendation**, not an assertion
    that the setting is off.

    Inspect, for a repo with a meaningful surface (any repo with
    `.github/workflows/` or `.github/actions/`):

    - **CODEOWNERS covers `.github/workflows/`.** Read the three
      locations GitHub recognises: `CODEOWNERS`,
      `.github/CODEOWNERS`, and `docs/CODEOWNERS`. Flag the
      absence of any pattern covering `.github/workflows/` (and,
      where present, `.github/actions/`). Without a CODEOWNERS
      rule on workflows, a malicious PR can quietly edit a
      workflow that runs with secrets — promote to `severity:high`
      when the repo has **privileged workflows** (any workflow
      referencing `secrets.*` other than `GITHUB_TOKEN`,
      `id-token: write` on the job or workflow, a
      `pull_request_target` trigger, or a self-hosted
      `runs-on:`); otherwise `severity:medium`.
    - **Recent unsigned commits on the default branch.** A
      signal, not proof — `git log --show-signature -20
      origin/<default>` should show `gpg:` / `Good signature`
      markers on recent commits. Treat the absence of signatures
      on the last 20 commits as a recommendation to enable
      required signed commits, filed at `severity:medium`. Drop
      the candidate if the repo's `CONTRIBUTING.md` explicitly
      excuses unsigned commits, or if every recent commit was
      authored by a single bot account where signing is
      infeasible.
    - **Required review, no force-push, linear history.** These
      are repo-level branch-protection settings that are not
      always statically visible. Recommend at `severity:medium`
      enabling at least one required PR approval before merge to
      the default branch, blocking direct push and force-push to
      the default branch, and enabling linear history where the
      team uses a rebase / squash workflow. Phrase as a
      recommendation — do not assert the setting is off.

    File **at most one** finding for this check. Title it for the
    dominant gap (e.g. *"Add CODEOWNERS coverage for
    `.github/workflows/` and enable required-review branch
    protection"*) and list every missing control in the body, each
    with its recommended remediation. Severity is `severity:high`
    when the dominant gap is missing CODEOWNERS coverage of
    `.github/workflows/` on a repo with privileged workflows;
    otherwise `severity:medium`. Use the standard `BP-<12 hex>`
    id recipe so re-runs deduplicate against the known-open and
    suppressed lists. The finding counts against the six-issue cap
    like any other.

    **Stay static.** Do not call the GitHub API to read
    branch-protection settings — file only from committed-file
    evidence (a missing CODEOWNERS entry, unsigned commits in
    `git log --show-signature`) or as an explicit recommendation.
    A repo with CODEOWNERS covering `.github/workflows/`, signed
    recent commits, and a documented branch-protection policy is
    silent on this check.

## Vulnerability disclosure policy

14. **`SECURITY.md` declares a vulnerability disclosure policy.**
    `SECURITY.md` is the canonical, GitHub-recognised place for a
    repo's vulnerability **disclosure policy** — how to report a
    vulnerability privately, the expected response time, and which
    versions are supported. Without it, a reporter has no private
    channel and defaults to a public issue, which discloses the
    vulnerability before a fix exists. GitHub surfaces the file in
    the repo's Security tab as a community-health file. This check
    is **static-evidence only** (file presence) — do not call the
    GitHub API.

    Inspect the three locations GitHub recognises for community-health
    files: `SECURITY.md` at the repo root, `.github/SECURITY.md`, and
    `docs/SECURITY.md`. File a single finding when none of the three
    is present on a repo that ships code.

    **Severity tiers:**

    - `severity:low` — default. Governance / hygiene gap on an
      internal or single-consumer repo.
    - `severity:medium` — promote when the repo publishes a library
      or service consumed externally. Static signals: a `package.json`,
      `Cargo.toml`, `pom.xml`, or `pyproject.toml` whose manifest
      declares a public package name; a published-artefact CI workflow
      (`npm publish`, `cargo publish`, `mvn deploy`,
      `docker push`); or a `Dockerfile` plus a workflow that pushes
      an image. A repo that is clearly a service consumed externally
      (a public API, a hosted product) also earns the medium tier.

    **Title.** *"Add `SECURITY.md` with a vulnerability disclosure
    policy"*. Compute the stable id with the standard `BP-<12 hex>`
    recipe using the title slug
    `add-security-md-with-a-vulnerability-disclosure-policy` and the
    primary file `SECURITY.md` so the same inputs yield the same id
    across runs.

    **Body content** must:

    - State which of the three recognised locations were inspected
      and that none was found.
    - Suggest adding `SECURITY.md` (root or `.github/`) with: a
      private reporting route (GitHub private vulnerability reporting
      or a security email), the expected response time, and a
      supported-versions table.
    - Link to GitHub's documentation on adding a security policy as
      the canonical guide.

    The finding counts against the six-issue cap like any other — no
    special exemption. A repo that already commits `SECURITY.md` in
    any of the three locations is silent on this check.

## Hardcoded success in a production code path

15. **Hardcoded success or fixture data in a production code path.**
    A non-test, non-example function whose spec implies real work
    returns a canned success value or fixture data instead of doing
    the work. This is the **never fail silently — fail loud** rule
    seen from the other end: the body is fiction, the caller reads a
    green result, and the fault stays invisible for weeks. The
    check is **static-evidence only**, like the rest of this bucket:
    read the source, do not run the code. It is language-agnostic and
    applies to every repo in the fleet.

    **Shapes to flag** (cite the file and the line range for each):

    - A literal `{ ok: true }`, `{"status": "ok"}`, `return true`, or
      an equivalent success-shaped constant with no computation
      behind it.
    - A hardcoded sample record standing in for one that should be
      fetched, queried, or computed.
    - A stubbed return sitting under a `TODO`, `FIXME`, or "for now"
      comment.
    - A `catch` (or `except` / `rescue` / `if err != nil`) block that
      converts a failure into a success-shaped value instead of
      propagating it.
    - Reconciliation that treats the **absence of an explicit failure
      marker** as success — the other half of the same bug.

    **Do not flag** — these are canned data by design:

    - Test files, test fixtures, and `example/`, `demo/`, or `sample`
      directories.
    - Factory, builder, seed, and mock helpers whose declared purpose
      *is* to produce canned data.
    - A **documented default** — a contract that states "returns
      empty when absent". An *undocumented* default masking a failed
      fetch is a finding.
    - A genuinely constant answer (a version string, a feature-flag
      constant, a pure lookup table).

    **Severity.** `severity:high` when the function sits on a path
    whose result gates a decision — a health check, a verification
    step, a reconciliation, an authorisation check. `severity:medium`
    otherwise.

    **Suggested fix.** Implement the behaviour, or fail explicitly —
    throw, exit non-zero, or emit a failure marker — never to return a
    plausible success. Say which of the two the call site needs.

    Compute the id with the standard `BP-<12 hex>` recipe from the
    title slug and the primary file, so re-runs deduplicate against
    the known-open and suppressed lists. The finding counts against
    the six-issue cap like any other — no special exemption. A repo
    whose production paths do the work they claim is silent on this
    check.
