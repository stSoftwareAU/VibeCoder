## Summary

Adds `docs/security/security-constitution-gap-analysis.md`, a 34-row verdict table
comparing KatTraxler/security-constitution (pinned at commit
`3f2d969a6e4905535bab85331fc5beb6587d1837`) with the coding guidelines, the scan
prompt's design lenses and `docs/THREAT-MODEL.md`, and indexes it in
`docs/security/README.md`. Verdicts: 3 ADOPT, 23 ALREADY COVERED, 8 SKIP. The three
ADOPTs are bundled into one follow-up, #4817, filed with `idle-task`. Closes #4653.

Version bump: no `VERSION` change in this diff; the merged commit records the final
version.

## Spec

### Intent and Rationale

- The owner asked for a critical check, not a port: cite the existing control where
  one exists, and file a change only for a gap worth its prompt cost.
- A gap analysis in `docs/security/` follows `agent-containment-gap-analysis.md`;
  the follow-up is filed in this run, as agreed in the issue.

### Essential Design Decisions

- ADOPT bar: a gap no control covers, a named file and change, at most 150 added
  words per prompt, no human step. Only three rows clear it, all on
  `prompts/security_scan/prompt.md`, so one follow-up is filed (cap is three).
- Upstream has no licence: every row paraphrases the idea and is attributed by id
  only. The PR edits no prompt, `CODING-STANDARDS.md` or `docs/THREAT-MODEL.md`.
- GCP, Azure and OCI shapes are mapped to AWS IaC (`passrole-compute`,
  `assume-role-escalation`, `ssm-send-command`) or SKIPped with a reason.

### Undiscoverable Facts

- #4705, #4731 and #4737 were open when the issue was written and are closed now;
  the document records them as closed.
- `CODING-STANDARDS.md` carries no copy of the Secure Coding Principles section,
  so the issue's twin note does not apply to any ADOPT here.

## Evidence

Docs-only change; no UI file is touched. Upstream was read through `gh api` at the
pinned commit (README, `security-constitution.md` and the three Phase-1 registers in
Markdown). The `SourceArn` / `SourceAccount` gap behind the L4 ADOPT was checked
with a grep of the prompts, the docs outside the archive and
`worker/deno/lib/cloud_permission_chains.ts`; the only hit outside tests is an
archived PR summary. Every `file:line` cited in the document was read at base
`5083cead`.

Follow-up issues cited (each looked up with `gh issue view` in this run or by the
executor): #4817: Security scan prompt: add secret-bearing field gate and AWS
service-principal source-condition checks.

Mermaid: the verdict flow in the document passes `check-mermaid` (1,393 blocks).

## Acceptance Criteria

The issue states no criteria heading, and nothing it asks is left undone, so no
`missing` entry is recorded.

## Test Plan

- Docs only; no code or test is added or edited.
- `tests/readme_docs_reachability_test.ts` (`worker/deno/tests/readme_docs_reachability_test.ts`):
  passed 3 of 3, including the check that the security index lists every
  `docs/security` report.
- markdownlint on the new files: 0 issues. `check-mermaid`: passed.
- Related existing rules checked: the Secure Coding Principles, Repository Isolation
  and capability-security entries; none is changed.
- `./quality.sh` on the docs commit `3200cbdb` (the summary file is the only later
  change): `Result: PASSED (with skipped checks)`. Every stage passed, including
  mermaid, markdownlint, semgrep, deno tests, lint, type check and fmt; `config
  integration` and `checkov` were skipped by the gate itself.

## Not done

- The JSON editions of the upstream registers were not read separately.
- The follow-up #4817 is filed but not implemented; it is a separate `idle-task` PR.
