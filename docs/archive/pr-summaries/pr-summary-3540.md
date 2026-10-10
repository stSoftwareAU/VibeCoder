# PR Summary — Issue #3540

## Summary

`gh api --hostname <host> …` no longer has the host read as the endpoint.
`classifyGhApi` (`worker/deno/lib/audit_mutation_classifier.ts`) now consumes
the `--hostname` value in its own branch, recording the host and skipping the
value, so it is never read as the endpoint. `MutationInfo.target` is now the real endpoint again, which means:

- the reserved-label-definition denylist (Issue #2518) applies to this
  spelling again, including with an inactive guard context such as a
  PR-feedback run;
- the audit journal records the endpoint, not `github.com`;
- (PR #3556 review, Issue #1420) once the host is no longer read as the
  endpoint, `classifyGhApi` reads the host itself: the last `--hostname`
  value (either spelling, placed before or after the `api` root) other than
  `github.com`, or a `--hostname` with no value, derives no repo and gives `scope: "unknown"`, so the write-repo
  allowlist fails closed. This also covers the `repos/{owner}/{repo}` form
  (not cwd-scoped) and sanctioned GraphQL mutations.

Note: open milestone PR #3514 carries an equivalent one-line change, so the
two may conflict when the milestone syncs.

Closes #3540

## Spec

### Intent and Rationale

- A `gh` value flag must never be mistaken for the endpoint, or every
  endpoint-based refusal can be bypassed by prefixing it.

### Essential Design Decisions

- `--hostname` joins `GH_VALUE_FLAGS`, matching how `gh_argv.ts`
  `VALUE_TAKING_LONG_FLAGS` already treats it. `classifyGhApi` also parses
  `--hostname` in a dedicated branch (before the `GH_VALUE_FLAGS` lookup) that
  records the host, and fails closed on a foreign host (PR #3556 review).
- The issue's optional fail-closed rule for a mutating `gh api` endpoint that
  is not a path is not included, to keep this PR to the bug fix.

### Undiscoverable Facts

- The inline `--hostname=<host>` form was already skipped as a flag (the
  endpoint was read correctly), but the host was never checked: on main
  `--hostname=evil.example` with an allowed repo path was classified as an
  allowed on-repo write. Both spellings now take the host check above, in
  either placement: `classifyGhApi` seeds the host from the tokens before the
  `api` root (`hostnameBeforeRoot`), and tokens after it still win (pflag's
  last-occurrence rule). Verified in the PR #3556 review against gh 2.97.0:
  `gh --hostname=evil.invalid api --verbose user` requests
  `https://evil.invalid/api/v3/user`.

## Evidence

- `worker/deno/tests/gh_api_hostname_flag_3540_test.ts`:
  - classifier target, repo and verb with `--hostname github.com`;
  - a pin for the inline `--hostname=` form (now `--hostname=GitHub.com`
    resolves the real repo and is allowed under an active allowlist);
  - foreign host (`evil.example`) in the two-token, inline, repeated
    (last wins) and missing-value spellings: classifier gives no repo and
    `scope: "unknown"`, and `evaluateGhCommand` with an active allowlist
    (`allowedRepos: ["o/r"]`) refuses with `WRITE_TARGET_UNDETERMINABLE`;
  - `--hostname` before the `api` root (PR #3556 review): inline
    `--hostname=evil.invalid` and two-token `--hostname evil.invalid` give
    `scope: "unknown"` for an explicit-repo write, the `repos/{owner}/{repo}`
    form and a sanctioned GraphQL mutation, and the inline spelling is refused
    by `evaluateGhCommand` (`WRITE_TARGET_UNDETERMINABLE`); a
    `--hostname=github.com` control before `api` still resolves `o/r`; the
    last `--hostname` wins across the root;
  - foreign host on a `repos/{owner}/{repo}` endpoint and on a sanctioned
    GraphQL mutation is `scope: "unknown"`;
  - `evaluateGhCommand` with an inactive context refuses a reserved-label
    DELETE and a PATCH rename to a reserved name (`WORKER_LABEL_REFUSED`,
    `reserved_workflow_label_definition`);
  - a control: the same argv with a non-reserved label is allowed.

**Docs sweep** — grep: `GH_VALUE_FLAGS`, `--hostname`, "reserved-label denylist", "reserved workflow label"; section: `SECURITY.md#6a-agent-subprocess-gh-guard`; updated: `SECURITY.md` §6 host bullet (`--hostname` rule added)

- PR #3556 review: `SECURITY.md` §6 bullet "An absolute endpoint's HOST is
  checked" now also states the `--hostname` rule.
- The sweep covered `*.ts` and `*.md` (SECURITY.md, DESIGN-PRINCIPLES.md,
  CODING-STANDARDS.md, README.md, `docs/` excluding `docs/archive/`).
- Section read through: `SECURITY.md` §6a "Agent-Subprocess `gh` Guard"
  documents the agent `gh` guard this change touches. Its "Labels: denylist"
  bullet says agent mutations carrying a reserved workflow label are refused,
  and its "pflag spellings are normalised first" bullet covers attached and
  repeated flag spellings. Neither names `--hostname`. This fix makes the
  denylist sentence true again for `gh api --hostname <host> …`, so no
  sentence in §6a is now false. The §6 bullet "An absolute endpoint's HOST
  is checked" was updated in the PR #3556 review (see above) to state the
  `--hostname` rule as well as the absolute-endpoint-URL host rule, so it is
  true of the head.
- Updated: `SECURITY.md` §6 host bullet, the doc comments in
  `audit_mutation_classifier.ts`, and the inline comment on the new set
  member. Remaining hits:
  - `docs/GH-API-OPTIMISATION.md:465` — still true because it describes
    `gh_argv.ts` `VALUE_TAKING_LONG_FLAGS`, which already listed
    `--hostname`.
  - `worker/deno/lib/audit_mutation_classifier.ts:297` (`firstNonFlag` doc) — still true because
    `GH_VALUE_FLAGS` still holds none of the git globals.

## Test Plan

- `deno task test:unit tests/gh_api_hostname_flag_3540_test.ts
  tests/gh_pflag_spellings_test.ts tests/gh_mutation_fail_closed_test.ts
  tests/gh_api_body_classification_test.ts
  tests/security_gh_api_endpoint_host_1420_test.ts` — 141 passed, 0 failed.
- Red check (host rule): with `foreignHost` forced to `false`, 10 of the new
  tests went red (every foreign-host case); restored.
- Red check (first fix, before the dedicated `--hostname` branch): with
  `"--hostname"` removed from `GH_VALUE_FLAGS`, the classifier test, the
  reserved DELETE refusal and the reserved PATCH rename refusal went red. The
  inline-form pin and the control stayed green, as expected (both are expected
  green on base). At the head the dedicated branch consumes the value, so that
  removal is no longer a red check; the host-rule red check above and the
  branch outcomes below cover the head.
- Red check (before-root host, PR #3556 review): with the seed
  `hostnameBeforeRoot(args, start - 1)` replaced by `undefined`, 6 of the 25
  tests in `gh_api_hostname_flag_3540_test.ts` went red (the three inline and
  three two-token before-root cases); restored.
- `./quality.sh < /dev/null` — exit 0, `Result: PASSED (with skipped
  checks)`; the only skip is `config integration`, which needs a worker
  config.
- Branch outcomes:
  - `audit_mutation_classifier.ts:836` foreign host → `scope: "unknown"`, no
    repo: `#3540/#1420: classifier derives no repo for foreign host` (4
    spellings); flipped (`foreignHost` forced false) → red.
  - `:836` `github.com` / `GitHub.com` → real repo, allowed: `#3540/#1420:
    --hostname github.com still resolves the real repo`; the host check
    flipped to refuse all hosts → red.
  - `:841` GraphQL on a foreign host → unknown: `foreign host on a sanctioned
    graphql mutation fails closed`; flipped → red.
  - `:863` placeholder endpoint on a foreign host: `foreign host on a
    placeholder endpoint is not cwd-scoped`; flipped → red.
  - `:848` repo derivation skipped on foreign host: covered by the active
    allowlist refusal tests; flipped → red.
  - `audit_mutation_classifier.ts:729` host seeded from tokens before the
    `api` root: `#3556: inline --hostname=<foreign> before api is unknown` and
    `#3556: two-token --hostname <foreign> before api is unknown` (3 cases
    each); seed replaced by `undefined` → red.
  - `hostnameBeforeRoot` (`:686`) `github.com` before the root →
    `#3556: --hostname=github.com before api still resolves the repo`; last
    occurrence across the root → `#3556: last --hostname wins across the api
    root`.
  - Missing `--hostname` value (`hostname = ""`): `missing value` case;
    flipped to `undefined` → red.

## Evidence citations

- #3540: Agent gh guard reads the value of `gh api --hostname` as the
  endpoint, so endpoint-based refusals are skipped
