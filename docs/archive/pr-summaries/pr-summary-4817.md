## Summary

Adds two bullets to `prompts/security_scan/prompt.md` (about 120 words in total): a secret-bearing field gate in the feature-abuse design lens, and an AWS service-principal source-condition check in the cloud permission chains section. Closes #4817.

## Spec

### Intent and Rationale

- Fills two gaps from the #4653 gap analysis: a weaker right redirecting or reading a stored secret, and an AWS service-principal trust with no `aws:SourceArn` / `aws:SourceAccount` condition.

### Essential Design Decisions

- The feature-abuse bullet cross-links the A01 SSRF line and says not to double-file, matching the existing webhook bullet.
- The AWS bullet is a finding only when a privileged action is granted and nothing else in the file constrains the caller, to keep precision high.
- Wording is paraphrased; no upstream text is copied.

### Undiscoverable Facts

- None.

## Evidence

Prompt-only change. `deno task test:unit` on `security_scan_cloud_chains_prompt_4416_test.ts`, `security_scan_defensive_labels_test.ts` and `security_scan_house_vocabulary_test.ts` (run from `worker/deno`): 27 passed, 0 failed.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The two bullets are in the prompt and the added text is at most 150 words — evidence: `prompts/security_scan/prompt.md` — reviewer: met
- **met** — A prompt-drift test, if the repository has one for this prompt, still passes. No new human step, gate or `needs-human` path is added — evidence: `worker/deno/tests/security_scan_cloud_chains_prompt_4416_test.ts` passes — reviewer: met
- **met** — `prompts/security_scan/prompt.md` is not twinned with `CODING-STANDARDS.md`; no other file needs to change — evidence: only that file and this summary changed — reviewer: met

## Test Plan

- No tests added or edited. Ran the three security-scan prompt tests named under Evidence: passed.
- `./quality.sh` ran its checks through markdownlint, semgrep and the release-tag ruleset, all passed, then did not finish within 600s.

<!-- vibe-quality-gate-skipped reason="./quality.sh did not complete within the 600s bound after the release-tag ruleset check; earlier checks passed" -->
