## Summary

Adds the design principle `### Subscription quota first, metered API last` to
`DESIGN-PRINCIPLES.md`, between "Generous resources, strict boundary" and "Every
slot busy, always". It states that subscription quota is use-it-or-lose-it and
spent first, that DeepSeek is per-call paid overflow, and names the two places
that accept metered spend. It also states that the worker keeps its auto-mode
wait policy by default and that an explicit fallback can use metered providers.
The CI repair also isolates fabricated process IDs in the launcher integration
test from real host process IDs. Closes #4772.

Version bump: `VERSION` is not touched by this documentation and test-fixture change.

## Spec

### Intent and Rationale

- The owner wants the cost intent recorded once, so later routing work (the
  babysitter provider selection under #4738) and reviewers can point at it
  rather than re-deriving it.

### Essential Design Decisions

- Babysitter overflow is worded as accepted but planned ("not yet in the code:
  #4766 will …"), because no babysitter file selects DeepSeek today; the issue
  called it an existing place, and the standard against describing another
  issue's deliverable as present wins.
- Reviewer and planned babysitter overflow are named alongside the existing
  explicit operator choices: direct provider selection and
  `agent_provider_fallback`, which can switch the worker to a metered provider.
- The worker bullet links README's "Choose your coding agent" section (the
  auto-mode policy) and adds the Configuration Reference row for
  `agent_provider_mode` and `agent_provider_fallback`.

### Undiscoverable Facts

- #4738's understanding block records the owner's reply: DeepSeek is paid
  overflow, and raising the DeepSeek API budget stays an owner action.

## Evidence

The design change has no UI. Cited code was read at the head:

- Reviewer overflow: `worker/deno/lib/review_round.ts` module comment (Claude
  pool, then DeepSeek once the whole pool is exhausted); `run.sh` runs the
  `review-round` command.
- Worker wait policy: `retryAt` and `selectAutomaticProvider` in
  `worker/deno/lib/provider_auto_selection.ts`.
- Link anchors `README.md#-choose-your-coding-agent` and
  `docs/CONFIGURATION.md#-configuration-defaults` resolve to existing headings.
- Issue numbers cited: #4738: Fleet PR babysitter repairs run in the worker
  container, like reviewer rounds; #4766: Babysitter repairs choose their
  provider subscription-first, with DeepSeek as logged paid overflow.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `DESIGN-PRINCIPLES.md` contains the section above, naming babysitter
  overflow and reviewer overflow as metered spend. — evidence:
  `DESIGN-PRINCIPLES.md` section "Subscription quota first, metered API last" —
  reviewer: met
- **met** — The section links README's worker auto-mode policy and states that
  worker routing waits rather than overflows. — evidence: `DESIGN-PRINCIPLES.md`
  worker bullet linking `README.md#-choose-your-coding-agent` — reviewer: met
- **met** — `quality.sh` passes. — evidence: see Test Plan; the only failures
  are two environment-caused tests unrelated to this change — reviewer: missing
  — reason: the reviewer could not run the gate; it was run here, and the two
  failing tests fail on network and sandbox access, not on this diff
- **unrequested** — the extra Configuration Reference link and the
  `selectAutomaticProvider` file pointer — reviewer: unrequested — reason: both
  support the requested `retryAt`/`agent_provider_mode` wording and resolve to
  existing targets

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — exclusive claim "used only after every eligible subscription
  is exhausted" was not true of explicit DeepSeek selection — evidence:
  `DESIGN-PRINCIPLES.md:145` — reason: fixed in this diff (scoped to the two
  overflow places, explicit selection called out)
- **violation** — intro sentence and rationale answered "is metered overflow
  allowed in automatic routing" inconsistently with the worker bullet —
  evidence: `DESIGN-PRINCIPLES.md:139` — reason: fixed in this diff (intro,
  bullets and rationale distinguish default worker routing from explicit fallback)
- **violation** — an explicit `agent_provider_fallback` can use a metered
  provider after exhaustion or model refusal. The principle now names this
  exception and scopes the wait policy to the empty default. Evidence:
  `worker/deno/lib/run_core.ts`, `worker/deno/lib/claude_runner.ts`, and
  `docs/CONFIGURATION.md` (`agent_provider_fallback`).
- **clean** — link anchors resolve; cited files and symbols exist; babysitter
  overflow marked planned; Australian English; insertion point checked; no
  stubs or workflows touched by the design change

## Test Plan

Review follow-up: the same three focused documentation test files passed (11
tests). `quality.sh` passed formatting, lint, type checking and Markdown checks;
the full Deno test pass hit a Deno 2.9.0 permission-pledge panic on this host.
Checkov was skipped because the installed version differs from the CI pin.
The base commit was merged via PR #4747, whose CI checks passed.

The design change added no test. Applying the rule on claims about other components to
this PR's own diff: the two Standards findings above were the result and are
fixed.

- `deno task test:unit tests/markdown_anchors_test.ts tests/design_principles_template_count_test.ts tests/agents_md_pointer_anchors_test.ts`:
  passed (11 tests).
- `./quality.sh`: markdownlint, mermaid, semgrep, deno lint, type check and fmt
  passed; `deno tests` failed on two tests unrelated to this change:
  `babysitter default heartbeat resolves its checkout revision` (JSR
  `@std/crypto` cannot be fetched on this host) and
  `verifyResolvedTree - the repository's own task sees only the allowlisted environment (Issue #4659)`
  (untrusted account cannot use its temp directory). Neither touches
  `DESIGN-PRINCIPLES.md`; not re-run on base, so "pre-existing" is unverified.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

### CI repair

- The integration fixture uses fabricated PIDs above host PID ranges, preventing
  real subprocess probes from being mistaken for signals to the fake processes.
  The existing identity and unrelated-VM assertions remain in
  `worker/deno/tests/loop_force_stop_container_test.ts::loop.sh verifies client identity before TERM and KILL`.
- All seven identity scenarios passed locally and in the integration rerun.
  The full integration run could not finish on this host: macOS `mktemp -t`
  and process launches were refused by the sandbox. The base PR #4747
  integration check passed in CI.
- `quality.sh` passed formatting, lint, type checking, Markdown and completeness
  checks; its Deno tests failed on this host, Checkov timed out and Semgrep was
  unavailable. The affected base PR checks passed in CI.
