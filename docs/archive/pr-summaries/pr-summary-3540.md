# PR Summary — Issue #3540

## Summary

`gh api --hostname <host> …` no longer has the host read as the endpoint.
`--hostname` is now in `GH_VALUE_FLAGS`
(`worker/deno/lib/audit_mutation_classifier.ts`), so `classifyGhApi` skips
its value. `MutationInfo.target` is now the real endpoint again, which means:

- the reserved-label-definition denylist (Issue #2518) applies to this
  spelling again, including with an inactive guard context such as a
  PR-feedback run;
- the audit journal records the endpoint, not `github.com`;
- (PR #3556 review, Issue #1420) once the host is no longer read as the
  endpoint, `classifyGhApi` reads the host itself: the last `--hostname`
  value (either spelling) other than `github.com`, or a `--hostname` with no
  value, derives no repo and gives `scope: "unknown"`, so the write-repo
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

- One set-member addition, matching how `gh_argv.ts` `VALUE_TAKING_LONG_FLAGS`
  already treats `--hostname`.
- The issue's optional fail-closed rule for a mutating `gh api` endpoint that
  is not a path is not included, to keep this PR to the bug fix.

### Undiscoverable Facts

- The inline `--hostname=<host>` form was already skipped as a flag (the
  endpoint was read correctly), but the host was never checked: on main
  `--hostname=evil.example` with an allowed repo path was classified as an
  allowed on-repo write. Both spellings now take the host check above.

## Evidence

- `worker/deno/tests/gh_api_hostname_flag_3540_test.ts`:
  - classifier target, repo and verb with `--hostname github.com`;
  - a pin for the inline `--hostname=` form (now `--hostname=GitHub.com`
    resolves the real repo and is allowed under an active allowlist);
  - foreign host (`evil.example`) in the two-token, inline, repeated
    (last wins) and missing-value spellings: classifier gives no repo and
    `scope: "unknown"`, and `evaluateGhCommand` with an active allowlist
    (`allowedRepos: ["o/r"]`) refuses with `WRITE_TARGET_UNDETERMINABLE`;
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
  is checked" is about the host inside an absolute endpoint URL, not the
  `--hostname` flag, so it is still true.
- Updated: none; the only doc change is the inline comment on the new set
  member. Remaining hits:
  - `docs/GH-API-OPTIMISATION.md:465` — still true because it describes
    `gh_argv.ts` `VALUE_TAKING_LONG_FLAGS`, which already listed
    `--hostname`.
  - `worker/deno/lib/audit_mutation_classifier.ts:760` — still true because
    `GH_VALUE_FLAGS` still holds none of the git globals.

## Test Plan

- `deno task test:unit tests/gh_api_hostname_flag_3540_test.ts
  tests/gh_pflag_spellings_test.ts tests/gh_mutation_fail_closed_test.ts
  tests/gh_api_body_classification_test.ts
  tests/security_gh_api_endpoint_host_1420_test.ts` — 107 passed, 0 failed.
- Red check (host rule): with `foreignHost` forced to `false`, 10 of the new
  tests went red (every foreign-host case); restored.
- Red check: with `"--hostname"` removed from `GH_VALUE_FLAGS`, the
  classifier test, the reserved DELETE refusal and the reserved PATCH rename
  refusal went red. The inline-form pin and the control stayed green, as
  expected (both are expected green on base).
- `./quality.sh < /dev/null` — exit 0, `Result: PASSED (with skipped
  checks)`; the only skip is `config integration`, which needs a worker
  config.
- Branch outcomes:
  - `audit_mutation_classifier.ts:661` foreign host → `scope: "unknown"`, no
    repo: `#3540/#1420: classifier derives no repo for foreign host` (4
    spellings); flipped (`foreignHost` forced false) → red.
  - `:661` `github.com` / `GitHub.com` → real repo, allowed: `#3540/#1420:
    --hostname github.com still resolves the real repo`; the host check
    flipped to refuse all hosts → red.
  - `:666` GraphQL on a foreign host → unknown: `foreign host on a sanctioned
    graphql mutation fails closed`; flipped → red.
  - `:688` placeholder endpoint on a foreign host: `foreign host on a
    placeholder endpoint is not cwd-scoped`; flipped → red.
  - `:673` repo derivation skipped on foreign host: covered by the active
    allowlist refusal tests; flipped → red.
  - Missing `--hostname` value (`hostname = ""`): `missing value` case;
    flipped to `undefined` → red.

## Evidence citations

- #3540: Agent gh guard reads the value of `gh api --hostname` as the
  endpoint, so endpoint-based refusals are skipped
