# PR summary — #4367

The best-practices scan now runs a static coverage check for three contracts: resource or tenant authorisation, a sensitive-field update, and redaction at a log or outbound sink. A gap is a low-severity `BP-` finding that cites the production path, the tests inspected, and the uncovered contract. It is not an exploit finding. A file named security is not what the check looks for. A public-by-design update is not a finding. A test that was not executed is not a pass. A missing checkout is an error. An open security issue for the same path is not filed again. The usual cap and `best-practice-ignore:` marker apply. `docs/BEST-PRACTICES-SCAN.md` describes it. The security scan still owns exploit findings.

Closes #4367

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A route with a concrete missing cross-tenant or sensitive-field test yields one bounded finding with production/test evidence and a useful implementation/test request. — evidence: `worker/deno/tests/capability_coverage_scan_4367_test.ts` — reviewer: met
- **met** — A fully covered route, an equivalent framework/integration suite, a public unauthenticated feature by design, and a repository without the capability produce no spurious findings. — evidence: `worker/deno/lib/capability_coverage_scan.ts` — reviewer: met
- **met** — Read failures/incomplete inspection are reported as unknown/not checked, never proof of absence or a clean scan. — evidence: `worker/deno/tests/capability_coverage_scan_4367_test.ts` — reviewer: met
- **met** — Stable finding identities, existing cap/severity/suppression policy and cross-scan dedup are retained; no new idle-task scheduler. — evidence: `worker/deno/lib/capability_coverage_scan.ts` — reviewer: met
- **met** — Behavioural evaluation fixtures cover vulnerable, secure, untested and irrelevant examples; deterministic filing tests verify zero/one/dedup/error outcomes. Prompt-string tests alone do not demonstrate scan accuracy. — evidence: `worker/deno/tests/capability_coverage_scan_4367_test.ts` — reviewer: met
- **met** — Update `docs/BEST-PRACTICES-SCAN.md` and reference attribution. Preserve existing security-scan ownership of exploit findings. — evidence: `docs/BEST-PRACTICES-SCAN.md` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The scan is static, reuses the best-practices filer, and does not add a scheduler.
