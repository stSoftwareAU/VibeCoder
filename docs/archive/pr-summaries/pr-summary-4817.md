## Summary

Adds a secret-bearing field gate to the feature-abuse design lens and an AWS
service-principal source-condition check to the cloud permission chains
section of `prompts/security_scan/prompt.md` (the two bullets total 149
words), and updates the operator manual's restatements in
`docs/SECURITY-SCAN.md` so they give the same answer.

Closes #4817.

## Spec

### Intent and Rationale

- Fills two gaps from the #4653 gap analysis: a weaker right redirecting or
  reading a stored secret, and an AWS service-principal trust with no
  `aws:SourceArn` / `aws:SourceAccount` condition.

### Essential Design Decisions

- The feature-abuse bullet cross-links the A01 SSRF line and says not to
  double-file, matching the existing webhook bullet.
- The AWS bullet is a finding only when a privileged action is exposed and
  nothing else in the file constrains the caller, to keep precision high.
- The AWS bullet is filed standalone as a `confused-deputy` finding
  (CWE-441), not an exploit-chain; for a role trust policy the privileged
  action is the role's own permission grants, which is the exception to the
  lone-permission rule.
- The section scope line is widened so the service-principal bullet covers a
  trust or resource policy naming an AWS service principal, while the three
  chain rules keep their IAM-roles-only scope. The operator manual's scope,
  lone-permission and finding-list restatements are updated to say the same
  thing.
- Wording is paraphrased; no upstream text is copied.

### Undiscoverable Facts

- None.

## Evidence

Prompt and operator-manual change. `deno test` (run from `worker/deno`) on
`security_scan_cloud_chains_prompt_4416_test.ts`,
`security_scan_defensive_labels_test.ts`,
`security_scan_house_vocabulary_test.ts`,
`security_scan_secret_redaction_3047_test.ts`, `fence_coverage_repair_test.ts`,
`references_doc_test.ts` and `idle_task_template_test.ts`: 72 passed, 0
failed. `markdownlint-cli2` over the published Markdown set: 0 issues.

## Test Plan

- No tests added or edited. Ran the seven prompt-drift / docs tests named
  under Evidence: 72 passed, 0 failed.
- The gate's checks that cover this markdown-only diff were run directly and
  pass: `deno fmt --check` (3736 files), `deno lint` (3714 files),
  `deno check` and `markdownlint-cli2` (0 issues).
- The full `./quality.sh` was not run to completion in this container; CI runs
  it on the pushed head.

<!-- vibe-quality-gate-skipped reason="the full ./quality.sh was not run to completion in this container; deno fmt, deno lint, deno check, markdownlint and the affected tests pass; CI runs the full gate" -->

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The two bullets are in the prompt and the added text is at most 150
  words. — evidence:
  `prompts/security_scan/prompt.md:1213-1218 (secret-bearing field bullet) and :1257-1264 (service-principal bullet); the two bullets total 149 words`
  — reviewer: met
- **met** — A prompt-drift test, if the repository has one for this prompt,
  still passes. No new human step, gate or needs-human path is added. —
  evidence:
  `worker/deno/tests: idle_task_template_test.ts, security_scan_defensive_labels_test.ts, security_scan_house_vocabulary_test.ts, security_scan_secret_redaction_3047_test.ts, fence_coverage_repair_test.ts, references_doc_test.ts and security_scan_cloud_chains_prompt_4416_test.ts pass (72 passed, 0 failed); neither bullet adds a human step, gate or needs-human path`
  — reviewer: met
- **met** — `prompts/security_scan/prompt.md` is not twinned with
  `CODING-STANDARDS.md`; no other file needs to change. — evidence:
  `git diff main...HEAD touches prompts/security_scan/prompt.md and docs/SECURITY-SCAN.md (the operator manual's restatements of this section, updated so the manual stays accurate), plus the PR summary; CODING-STANDARDS.md is untouched`
  — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — The service-principal bullet initially restated and
  contradicted existing rules (Prompt Engineering Guidance: check the existing
  rules before adding one): the section scope said 'IAM roles only' while the
  bullet covered a 'trust or resource policy', the lone-permission rule names
  `sts:AssumeRole`, and the chain-only filing rules left the bullet with no
  class, CWE or cap handling. — evidence: `prompts/security_scan/prompt.md:1257-1264` — reason: fixed in this diff (scope widened to a trust or resource policy naming an AWS service principal; the bullet names its lone-permission exception, files standalone as `confused-deputy`/CWE-441 against the cap; `docs/SECURITY-SCAN.md` restatements updated to match).
- **clean** — Checked and found compliant: Australian English in the added
  text, the thin-pointer AGENTS.md rule (no standards added there), the
  secret-bearing field bullet (A01 cross-link, one rule, no duplicate),
  prompt-drift tests (72 pass), no new gate or human step, and a minimal diff
  with no unrequested changes.
