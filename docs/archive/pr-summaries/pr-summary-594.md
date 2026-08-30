# Refresh the canonical gitleaks workflow template

## Summary

The `gitleaks` spec template in `worker/deno/lib/workflow_definitions.ts` is
pushed into every repository the fleet sets up, and it filtered pull requests
with `branches: ["*"]`. A GitHub branch-filter `*` never matches a `/`, so that
glob reads as "every branch" while silently skipping every `milestone/<slug>` PR
(Issue #1300) — the dominant merge path. Every repo set up from the template
therefore ran no secret detection on the PRs that matter most.

This change refreshes the template against this repository's own
`.github/workflows/gitleaks.yml`:

- `on.pull_request.branches` is now the explicit `[Develop, main, milestone/*]`.
- The `actions/checkout` step sets `persist-credentials: false` — nothing in the
  job pushes, so the job token must not be left in `.git/config` for a later
  step (or a compromised scanner download) to read.
- A `concurrency` group keyed on `github.workflow` + `github.ref` with
  `cancel-in-progress: true` stops rapid pushes spawning redundant parallel
  runs.
- The header comments now describe `gitleaks-action@v3` — the version
  `pinnedAction("gitleaks/gitleaks-action")` actually resolves to (`v3.0.0`, SHA
  `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`) — instead of the stale v2 prose an
  auditor would otherwise read.
- A template comment records the decision to **omit** the
  `environment: scanning-secrets` gate and the
  `GITLEAKS_CONFIG: .github/gitleaks.toml` path this repository's copy uses: a
  freshly set-up repo has neither, and the template must run unmodified on first
  push. The comment says what to add once each exists.

Both scan paths are untouched: the licensed `gitleaks-action` when
`GITLEAKS_LICENSE` is present, and the version-pinned, SHA-256-verified
open-source gitleaks CLI when it is not (Dependabot PRs never receive Actions
secrets, Issue #2981).

Closes #594.

## Evidence

Backend/CLI change — no web interface to screenshot. The evidence is the new
conformance test, which fails against the unfixed template and passes after the
fix.

Added
`worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - pull_request filter matches milestone branches`,
which reproduces the flaw: it fails against the unfixed template (the `["*"]`
filter never matches `milestone/example`) and passes after the fix. Run against
the **unfixed** template, 6 of the file's 8 tests fail:

```text
FAILURES

gitleaks template - pull_request filter matches milestone branches
gitleaks template - branch filter is not the bare star glob
gitleaks template - checkout disables credential persistence
gitleaks template - declares a cancelling concurrency group
gitleaks template - comments describe gitleaks-action v3, not v2
gitleaks template - records the environment/config omission decision

FAILED | 2 passed | 6 failed (18ms)
```

After the template refresh, the whole file plus the existing
`workflow_definitions_test.ts` pass:

```text
ok | 77 passed | 0 failed (64ms)
```

The branch-filter assertion reuses `anyBranchMatches` from
`worker/deno/lib/workflow_branch_glob.ts` — the same matcher the
milestone-branch-filter pre-filer runs — against the parsed YAML, rather than
string-matching the rendered template.

### Original trigger closed, no trivial bypass

The trigger is a `pull_request` branch filter that fails to match
`milestone/<slug>`. The filter is now `[Develop, main, milestone/*]`, and the
test asserts coverage by running the real glob matcher over the parsed YAML with
the sample branch `milestone/example` — so it is closed for the general case,
not for one literal string. A bypass would need a filter that matches
`milestone/example` yet still misses milestone PRs, which the matcher's
semantics (`*` spans one path segment, `**` spans `/`) do not permit; a
regression to `["*"]` fails both the coverage assertion and the dedicated
bare-star-glob assertion, and a tag-pinned action fails the 40-char-SHA
assertion.

```mermaid
flowchart LR
    A["PR → milestone/&lt;slug&gt;"] -->|old: branches ["*"]| B["no match<br/>❌ scan skipped"]
    A -->|new: [Develop, main, milestone/*]| C["match<br/>✅ gitleaks runs"]
    C --> D{GITLEAKS_LICENSE set?}
    D -->|yes| E["gitleaks-action@v3<br/>SHA-pinned"]
    D -->|no| F["open-source gitleaks CLI<br/>version + SHA-256 pinned"]
```

## Acceptance Criteria

- **met** — the `gitleaks` spec template triggers on `pull_request` for
  `Develop`, `main` and `milestone/*` — evidence:
  `worker/deno/lib/workflow_definitions.ts`
  (`branches: [Develop, main, milestone/*]`),
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - pull_request filter matches milestone branches`
- **met** — template comments describe gitleaks-action v3, not v2 — evidence:
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - comments describe gitleaks-action v3, not v2`
- **met** — the checkout step disables credential persistence and the workflow
  declares a cancelling `concurrency` group — evidence:
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - checkout disables credential persistence`
  and
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - declares a cancelling concurrency group`
- **met** — licensed-action and licence-less CLI paths both survive the refresh
  — evidence:
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - keeps both the licensed and licence-less scan paths`
- **met** — a new test asserts the four invariants and fails if the branch
  filter reverts to `["*"]` or an action is tag-pinned — evidence:
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - branch filter is not the bare star glob`
  and
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - every uses: is pinned to a 40-character SHA`
- **met** — the environment/config decision is recorded in a template comment —
  evidence:
  `worker/deno/tests/gitleaks_template_conformance_test.ts::gitleaks template - records the environment/config omission decision`
- **partial** — `./quality.sh` passes — evidence: fmt, type check, lint,
  markdownlint, mermaid and all other gates pass; the 15,514-test suite reports
  4 failures — reason: all four (`gh_spawn_test.ts` × 3,
  `service_account_env_test.ts` × 1) are pre-existing sandbox-environment
  failures, in files this diff does not touch. Confirmed by checking out the
  milestone base commit `9339950` in a scratch worktree and running those two
  files there: the same 4 fail (`FAILED | 31 passed | 4
  failed`). They assert
  on container gh-config paths this run's sandbox does not provide.
- **unrequested** — removed the unused `SCRATCH_TMPFS_MOUNTS` import from
  `worker/deno/tests/container_launch_test.ts` — reason: it was left behind by
  PR #602 on this milestone branch and failed `deno lint`, blocking the quality
  gate for every PR targeting the branch; a one-line deletion with no behaviour
  change.

## Test Plan

- Added `worker/deno/tests/gitleaks_template_conformance_test.ts` (8 tests) —
  parses the rendered template as YAML and asserts: milestone-branch coverage
  via `anyBranchMatches`, the filter is not `["*"]`, both scan paths present,
  every `uses:` pinned to a 40-character SHA, `persist-credentials: false` on
  checkout, a cancelling `concurrency` group, v3 (not v2) comments, and that no
  job carries the `scanning-secrets` environment or a `GITLEAKS_CONFIG` a fresh
  repo lacks. These fail against the unfixed template (6 of 8) and pass after
  the fix.
- Existing `worker/deno/tests/workflow_definitions_test.ts` re-run unchanged —
  it continues to guard the spec's shape, the base-branch fetch ordering, the
  CLI fallback and the SHA pinning.
- Ran the workflow/milestone/setup test surface (`tests/*workflow*.ts`,
  `tests/*milestone*.ts`, `tests/*setup*.ts`): 1,159 passed, 0 failed.
