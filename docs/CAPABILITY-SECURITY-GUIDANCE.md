# Capability-scoped security guidance

A small, version-controlled bundle that implementation and review share.
It is selected from the task, the entry points, the imports, the callers
and the sinks. A file extension does not select it. It is not pasted into
the always-loaded coding guidelines.

The bundle is [`prompts/coding_guidelines/capability-security.json`](../prompts/coding_guidelines/capability-security.json).
Each entry has a stable id, the evidence that makes it applicable, concrete
advice, and a validation the change can actually meet. The first five are
resource and tenant authorisation with a writable-field allowlist, safe
process and query execution, outbound URL and TLS, file boundaries and
resource limits, and secret-safe logging. They name the platform's existing
controls. They do not add a placeholder handler, a deny-everything
substitute, or a wrapper nothing calls.

## Where it is applied

- Issue runs render the selected sections through `buildIssuePrompt` into
  `prompts/issue/prompt.md`. Every supported provider uses that path. The
  run log records the revision and the signal ids that selected each
  section. It does not copy the issue body. Guidance that cannot be read
  is logged as not applied.
- Fleet review and the pre-PR verifier render the same checks inside the
  shared brief, through the existing checklist verdicts. See
  [Review checklists](review-checklists.md).
- The best-practices scan uses the same guidance for a narrow
  behavioural-coverage check. See
  [Best-practices scan](BEST-PRACTICES-SCAN.md).

The worker's own copy is the trusted revision. A repository that does not
already carry the bundle is reviewed against that copy. A pull request that
edits the bundle is reviewed against the base revision, so it cannot weaken
the rules used to review it. A broken copy is a blocking finding on the
bundle. A fetch failure is retried and is not charged to the issue.

## Attribution

The ideas were adapted from CoSAI / OASIS Project CodeGuard v1.5.0, reviewed
on 26 October 2026 at commit `41160d54980bab0618165485ade3cfd2ade93288`.
The upstream licence is CC-BY-4.0. VibeCoder rewrote the selected ideas in
its own words and limited them to the five capabilities above. This is not
an upstream plugin, nothing is downloaded at run time, and a later upstream
revision is not adopted automatically. The credit row is in
[References](REFERENCES.md).

Changing the bundle means changing its `revision` and the advice together,
then re-running the guidance, review, coverage and evaluation tests.
