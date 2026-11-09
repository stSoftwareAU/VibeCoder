## Summary

Adds two bullets to `prompts/security_scan/prompt.md` (about 120 words in
total): a secret-bearing field gate in the feature-abuse design lens, and an AWS
service-principal source-condition check in the cloud permission chains section.

Closes #4817.

## Spec

### Intent and Rationale

- Fills two gaps from the #4653 gap analysis: a weaker right redirecting or
  reading a stored secret, and an AWS service-principal trust with no
  `aws:SourceArn` / `aws:SourceAccount` condition.

### Essential Design Decisions

- The feature-abuse bullet cross-links the A01 SSRF line and says not to
  double-file, matching the existing webhook bullet.
- The AWS bullet is a finding only when a privileged action is granted and
  nothing else in the file constrains the caller, to keep precision high.
- Wording is paraphrased; no upstream text is copied.

### Undiscoverable Facts

- None.

## Evidence

Prompt-only change. `deno task test:unit` on
`security_scan_cloud_chains_prompt_4416_test.ts`,
`security_scan_defensive_labels_test.ts` and
`security_scan_house_vocabulary_test.ts` (run from `worker/deno`): 27 passed, 0
failed.

## Test Plan

- No tests added or edited. Ran the three security-scan prompt tests named under
  Evidence: passed.
- `./quality.sh` ran its checks through markdownlint, semgrep and the
  release-tag ruleset, all passed, then did not finish within 600s.

<!-- vibe-quality-gate-skipped reason="./quality.sh did not complete within the 600s bound after the release-tag ruleset check; earlier checks passed" -->

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The two bullets are in the prompt and the added text is at most 150
  words. — evidence:
  `prompts/security scan/prompt.md:1213-1218 (secret-bearing field bullet) and :1255-1259 (service-principal bullet); the added lines total 120 words`
  — reviewer: met
- **met** — A prompt-drift test, if the repository has one for this prompt,
  still passes. No new human step, gate or needs-human path is added. —
  evidence:
  `worker/deno/tests: idle task template test.ts, security scan defensive labels test.ts, security scan house vocabulary test.ts, security scan secret redaction 3047 test.ts, fence coverage repair test.ts and references doc test.ts pass (64 passed, 0 failed); neither bullet adds a human step, gate or n`
  — reviewer: met
- **met** — prompts/security scan/prompt.md is not twinned with
  CODING-STANDARDS.md ; no other file needs to change. — evidence:
  `git diff main...HEAD touches only prompts/security scan/prompt.md and the PR summary docs/archive/pr-summaries/pr-summary-4817.md; CODING-STANDARDS.md is untouched`
  — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — The service-principal bullet restates and contradicts existing
  rules (Prompt Engineering Guidance: check the existing rules before adding
  one). The section scope line says 'IAM roles only', but the bullet covers a
  'trust or resource policy', so 'resource policy' falls outside that scope. The
  bullet — evidence: `prompts/security scan/prompt.md:1255-1259` — reason: NOT
  fixed: this turn permits no code changes, and these lines were added by this
  diff. Fix the bullet in this diff — scope it to 'role trust policy', name its
  exception to the lone-permission rule, and give its class, CWE and cap
  handling — or drop it. 'fixed in this diff' would be false, so the gat
- **clean** — Checked and found compliant: Australian English in the added text,
  the thin-pointer AGENTS.md rule (no standards added there), the secret-bearing
  field bullet (A01 cross-link, one rule, no duplicate), prompt-drift tests (64
  pass), no new gate or human step, and a minimal diff with no unrequested cha
