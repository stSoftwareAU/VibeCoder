# Capability-scoped security guidance

A small, version-controlled bundle that implementation and review share.
It is selected from the task, the entry points, the imports, the callers
and the sinks. A file extension does not select it. It is not pasted into
the always-loaded coding guidelines.

The bundle is [`prompts/coding_guidelines/capability-security.json`](../prompts/coding_guidelines/capability-security.json).
Each entry has a stable id, the evidence that makes it applicable, concrete
advice, and a validation the change can actually meet. The first five are
CodeGuard-derived: resource and tenant authorisation with a writable-field
allowlist, safe process and query execution, outbound URL and TLS, file
boundaries and resource limits, and secret-safe logging. They name the
platform's existing controls. They do not add a placeholder handler, a
deny-everything substitute, or a wrapper nothing calls.

The sixth, `capsec-recovery-boundary` (Recovery stays within configured
authority), is VibeCoder's own adaptation of a lesson in Wiz CIRT's article
(Issue #4417). It is not CodeGuard material. When a failure triggers a retry,
restart, credential refresh, provider switch or fallback, the replacement
launch or request is built from the same configured authority: repositories
and operations, credential scope, mounted paths, network guarantee and
execution identity. It is never built from the failure. A refreshed token
inside the configured scope, rotation inside the configured pool, and a
supported provider switch inside the configured set remain legitimate. A
degraded or partial mode stays an explicitly chosen mode whose residual gap is
reported. The entry adds no scheduler, blanket quota or approval step.

## Where it is applied

- Issue runs render compact selected advice through `buildIssuePrompt` into
  `prompts/issue/prompt.md`. Every supported provider uses that path. The
  run log records the revision and the signal ids that selected each
  section. It does not copy the issue body. Guidance that cannot be read
  is logged as not applied.
- Fleet review and the pre-PR verifier render the same checks inside the
  shared brief, through the existing checklist verdicts. See
  [Review checklists](review-checklists.md).
- The best-practices scan uses the same guidance for a narrow
  behavioural-coverage check. From Issue #4417 that check also recognises
  retry and restart paths that alter credentials, mounts or execution
  identity. See [Best-practices scan](BEST-PRACTICES-SCAN.md).

The worker's own copy is the trusted revision. A repository that does not
already carry the bundle is reviewed against that copy. A pull request that
edits the bundle is reviewed against the base revision, so it cannot weaken
the rules used to review it. A broken copy is a blocking finding on the
bundle. A fetch failure is retried and is not charged to the issue.

## Evaluation and adoption

Issue #4368 adds a bounded subscription comparison, executable TypeScript/Rust
acceptance, and review/coverage confusion counts. The command, isolation contract
and result interpretation are in [the evaluation manual](../evals/capability_security/README.md).
The expanded candidate remains reproducible through the evaluator; it is not the
production generation prompt.

Generation guidance is simplified to the selected advice and the scope-change
reminder. The repeated validation paragraphs and the index of unselected
capabilities have been removed from that path. This preserves the applicable
platform controls and the existing authorisation behaviour contract without
claiming that the longer candidate improves outcomes. Selection, attribution,
review checklists, semantic checks, coverage checks and quality gates remain.
The small comparison does not establish a general winner or justify changing
production model allocation.

## Attribution

The five CodeGuard-derived capabilities were adapted from CoSAI / OASIS
Project CodeGuard v1.5.0, reviewed on 26 October 2026 at commit
`41160d54980bab0618165485ade3cfd2ade93288`. The upstream licence is CC-BY-4.0.
VibeCoder rewrote the selected ideas in its own words and limited them to the
five capabilities above. This is not an upstream plugin, nothing is downloaded
at run time, and a later upstream revision is not adopted automatically.

The sixth entry, `capsec-recovery-boundary`, is not CodeGuard material and is
not credited to CodeGuard. It is VibeCoder's own adaptation of a lesson in Wiz
CIRT's article (Issue #4417), and it is not a control claimed by Wiz. The
credit rows are in [References](REFERENCES.md).

Changing the bundle means changing its `revision` and the advice together,
then re-running the guidance, review, coverage and evaluation tests.
