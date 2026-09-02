# 🔐 Security analyses & assessments

Point-in-time security **analyses** — gap analyses, threat models, and
assessments — kept as durable rationale for the security work they drove. They
are reference reports, not operator manuals: the living instructions live in
[SECURITY.md](../../SECURITY.md) (threat model and architecture) and
[Security Scans](../SECURITY-SCAN.md) (the scanner operator manual).

Each report states the issue it belongs to and its status in its own header.
Read them for *why* a control exists; read the manuals for *how* it behaves
today.

| Report | What it covers |
| ------ | -------------- |
| **[Idle-task scans vs Anthropic & Visa harnesses](idle-task-scans-vs-anthropic-visa-harnesses-gap-analysis.md)** | Gap analysis of the scan pipeline against the Anthropic and Visa agentic security harnesses — the G1–G4 gaps that drove the – scan upgrades |
| **[Cloudflare `security-audit-skill` coverage gap analysis](cloudflare-security-audit-gap-analysis.md)** | Detection-class comparison mapping every Cloudflare `security-audit-skill` class to its owning VibeCoder idle task |
| **[GhostCommit — image prompt-injection threat model](ghostcommit-image-injection-assessment.md)** | The repo's threat model for image-based prompt injection: attack surface, detect-and-flag posture, and the mitigation sub-issues it scoped |
| **[GhostCommit canary regression tests](ghostcommit-canary-tests.md)** | The empirical half of the same work: canary tests that prove the posture at runtime and guard against regressions |

Related index entries outside this directory:

- [Threat Model](../THREAT-MODEL.md) — the living, design-level model these
  point-in-time reports feed: assets, attacker capabilities per GitHub surface,
  attack paths, control→code→test traceability, gaps and residual risks.
- Public Export — the boundary control for the
  clean-publish plan: the allowlist manifest and hard-deny gate
 , the export-time branding transform and the mandatory,
  comment-required-allowlist, no-bypass scrub gate that blocks operator
  identifiers, e-mails, key shapes, home paths and private-repo references
  from leaving the machine.
- [OWASP Top 10 2025 coverage matrix](../OWASP-TOP-10-2025-COVERAGE-MATRIX.md)
  — which idle-task template covers which OWASP category.
- [Whole-tree security sweep](../SECURITY-TREE-SWEEP.md) — the one-shot
  worker-scan + semgrep + CodeQL sweep over the entire checkout, its baseline
  and its committed report under `../audits/`.
- [Security remediation batching](../SECURITY-REMEDIATION-BATCHING.md) and
  [Supply-chain triage](../SUPPLY-CHAIN-TRIAGE.md) — what happens to findings
  after a scan files them.
- [Supply-chain gate](../SUPPLY-CHAIN-GATE.md) — the CI job and command
  that fail on an unpinned `uses:`, an unfrozen `deno` invocation, a
  tag-referenced or short-named container base, a permissive Renovate
  auto-merge policy or a stale dependency inventory.
