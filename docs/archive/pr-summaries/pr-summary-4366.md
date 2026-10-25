# PR summary — #4366

Fleet review and the pre-PR verifier both render the capability checks inside the existing `{{REVIEW_CHECKLISTS}}` contract. The trusted base copy governs, so a pull request cannot replace a check with a weaker one. A bundle that cannot be read is `capability-unreadable` on the gate and not-checked on the verifier. A change that breaks the bundle is a finding on `prompts/coding_guidelines/capability-security.json`. Docs-only changes get no capability section. The canonical notes are in `docs/review-checklists.md`, `docs/CAPABILITY-SECURITY-GUIDANCE.md` and `.claude/skills/review-fleet-prs/SKILL.md`. Attribution is in `docs/REFERENCES.md`.

Closes #4366

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Both fleet review and pre-PR verification render the same applicable checks and enforce missing verdicts consistently; real consumer tests fail if either route omits them. — evidence: `worker/deno/tests/capability_security_review_4366_test.ts` — reviewer: met
- **met** — A missing/unreadable applicable bundle cannot produce a clean review; use existing not-checked/retry versus substantive-finding semantics instead of charging infrastructure failures to the issue. — evidence: `worker/deno/tests/capability_security_review_4366_test.ts` — reviewer: met
- **met** — Paired fixtures cover secure working code, an insecure working variant, a deny-all/stub variant, an irrelevant docs change, a pre-existing flaw, and a flaw newly exposed by the change. — evidence: `evals/capability_security/impls/ts/secure.ts` — reviewer: met
- **met** — Findings retain concrete file/line evidence and failure scenarios. Existing pre-existing-problem routing, dedup, test-change policy and JSON parsing remain compatible. — evidence: `worker/deno/lib/review_checklists.ts` — reviewer: met
- **met** — No blanket findings for missing enterprise infrastructure, deliberate negative-test certificates, or unrelated capabilities. Do not classify every security topic as applicable. — evidence: `prompts/coding_guidelines/capability-security.json` — reviewer: met
- **met** — Update the canonical review documentation and attribution; run existing shared-brief/checklist/verifier tests plus relevant quality checks. — evidence: `docs/review-checklists.md` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The checks use the existing checklist verdict contract. No second review agent and no forked skill.
