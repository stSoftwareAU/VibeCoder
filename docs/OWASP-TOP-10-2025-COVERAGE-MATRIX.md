# 🗂️ OWASP Top 10 2025 — Idle-Task Coverage Matrix

This document maps the **OWASP Top 10 2025** web/application security-risk
categories (https://owasp.org/Top10/2025/) against the idle-task audit
templates, recording for each cell whether the category is **covered**,
**partially covered** (the class is named but the detection guidance is weak or
incidental), or a **gap**. It is the tracked artefact for (part of
the OWASP-2025 alignment milestone).

> **Point-in-time snapshot.** The scored matrix below is the artefact of Issue
> and covers the **ten** templates registered at that time. The registry
> has grown since; templates registered after the snapshot are listed under
> [Templates registered since the snapshot](#templates-registered-since-the-snapshot)
> and are **not** scored here. Read the matrix as "coverage as assessed for
> ", not as a live inventory.

Scope note: this matrix is the **web/application** Top 10 only. The OWASP
GenAI/LLM Top 10 (2025) is a separate taxonomy carried by `security_scan` for
LLM-using repos and is out of scope here (sibling issues under).

## The ten scored templates (as at)

| Abbrev. | Template | Prompt directory | Security focus |
| --- | --- | --- | --- |
| SEC | `security_scan` | `prompts/security_scan/` | Primary — full web + LLM Top 10 |
| SCR | `supply_chain_readiness` | `prompts/supply_chain_readiness/` | Supply-chain posture |
| GHA | `github_actions_audit` | `prompts/github_actions_audit/` | Workflow hardening |
| ORP | `orphan_deps` | `prompts/orphan_deps/` | Abandoned dependencies |
| BP | `best_practices` | `prompts/best_practices/` | Per-language + IaC buckets |
| TST | `test_audit` | `prompts/test_audit/` | Test-suite maintainability & coverage-gap audit (WHAT/HOW heuristic) |
| DC | `dead_code` | `prompts/dead_code/` | Dead-code hygiene |
| DEP | `deprecated_api` | `prompts/deprecated_api/` | Deprecated API usage |
| DOC | `doc_coverage` | `prompts/doc_coverage/` | Documentation coverage |
| FMT | `format_drift` | `prompts/format_drift/` | Formatting hygiene |

## Templates registered since the snapshot

These templates joined the registry after the assessment and are **not**
scored in the matrix below. Each is listed with its security relevance so the
inventory is complete even though the scoring is not; scoring them is separate
work (see [Maintenance](#maintenance)).

| Template | Prompt directory | Security relevance |
| --- | --- | --- |
| `alert_feed` | `prompts/alert_feed/` | Files one issue per new high/critical Dependabot / code-scanning alert — A03 supply chain, A02 misconfiguration |
| `bash_script_refs` | `prompts/bash_script_refs/` | Native scan for referenced-but-missing shell scripts — hygiene, not a security class |
| `bash_syntax_audit` | `prompts/bash_syntax_audit/` | Verifies per-repo `bash -n` + ShellCheck CI gates (weakly A05: ShellCheck flags injection-prone quoting) |
| `documentation_audit` | `prompts/documentation_audit/` | Prose-documentation hygiene — not a security audit |
| `duplicated_knowledge` | `prompts/duplicated_knowledge/` | Copy-pasted blocks encoding one rule — a diverged copy is a fix applied in one place only, weakly A02/A05 when the rule is a guard |
| `private_repo_reference_audit` | `prompts/private_repo_reference_audit/` | Detects references to private `stSoftwareAU` repos from public ones — information disclosure |
| `retro` | `prompts/retro/` | Retrospects a finished run and proposes environment and prompt improvements — process hygiene, not a security audit |
| `workflow_annotation_scan` | `prompts/workflow_annotation_scan/` | Files annotations attached to *passing* workflow runs (e.g. deprecated runtimes) — overlaps GHA workflow hardening |

## Legend

- **✓** — covered: concrete detection guidance for the category.
- **~** — partial: the category (or an aspect of it) is named, but the guidance
  is weak or incidental to the template's main purpose.
- **·** — none: the template does not address the category (expected for the
  non-security hygiene templates).

## Matrix

| Category | SEC | SCR | GHA | ORP | BP | TST | DC | DEP | DOC | FMT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01 Broken Access Control (incl SSRF) | ✓ | · | ✓ | · | ~ | · | · | · | · | · |
| A02 Security Misconfiguration | ✓ | ~ | ✓ | · | ✓ | · | · | · | · | · |
| A03 Software Supply Chain Failures | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | ~ | · | · |
| A04 Cryptographic Failures | ✓ | ~ | ~ | · | ✓ | · | · | · | · | · |
| A05 Injection | ✓ | · | ✓ | · | ~ | · | · | · | · | · |
| A06 Insecure Design | ✓ | ~ | ~ | · | ~ | ~ | · | · | ~ | · |
| A07 Authentication Failures | ✓ | · | ✓ | · | ~ | · | · | · | · | · |
| A08 Software or Data Integrity Failures | ✓ | ✓ | ✓ | · | ✓ | ~ | · | · | · | · |
| A09 Security Logging and Alerting Failures | ✓ | ✓ | ✓ | · | ~ | · | · | · | · | · |
| A10 Mishandling of Exceptional Conditions | ✓ | · | ~ | · | ✓ | · | · | · | · | · |

Every column for the five non-security hygiene templates (TST, DC, DEP, DOC,
FMT) is mostly `·` by design — they audit code quality, documentation, and
maintenance, not security. The handful of `~` cells there are incidental
(e.g. `test_audit`'s WHAT-tests document a contract boundary, which weakly
supports A06).

## Per-category detail and citations

Citations refer to prompt directories and the section headings within the
latest version on disk (the worker always loads the latest version), per the
documentation convention in `AGENTS.md`.

### A01:2025 — Broken Access Control (incl SSRF)

- **SEC ✓** — `prompts/security_scan/` § "A01:2025 — Broken Access Control"
  covers authorisation gaps (IDOR, function-level, tenant leakage), SSRF
  (merged into A01 in the 2025 edition), path traversal / Zip Slip, open
  redirect, and CSRF.
- **GHA ✓** — `prompts/github_actions_audit/` covers `permissions:`
  minimisation, `id-token: write` scoping, org-wide-secret exposure in PR
  workflows, and self-hosted-runner exposure to untrusted triggers.
- **BP ~** — `prompts/best_practices/buckets/aws-cloudformation.md`
  ("Least-privilege IAM", "No public exposure by default") covers IaC access
  control, but the `terraform.md` bucket has **no** equivalent least-privilege
  IAM / public-exposure check — see the **Gaps** section.

### A02:2025 — Security Misconfiguration

- **SEC ✓** — § "A02:2025 — Security Misconfiguration": dangerous defaults,
  permissive CORS/CSP, XXE.
- **GHA ✓** — `permissions:` blocks, timeout enforcement, stale/deprecated
  actions, EOL runtimes.
- **BP ✓** — IaC encryption/exposure defaults (cloudformation, terraform) plus
  the cross-bucket "deprecated config on framework bump" class.
- **SCR ~** — readiness-config checks (lockfile, auto-update, install scripts)
  touch misconfiguration posture rather than runtime config.
- **Container misconfiguration** (Dockerfile image hardening) is a known gap
  already filed as **** — recorded here as covered-by-sibling.

### A03:2025 — Software Supply Chain Failures

The most strongly-covered category — four templates overlap by design.

- **SEC ✓** — § "A03:2025 — Software Supply Chain Failures" + the 2025–2026
  attack-pattern checklist (install-time scripts, phantom transitive deps,
  dormant republish, typosquats, dependency confusion, provenance-is-not-
  sufficient) and the dependency-update quarantine audit.
- **SCR ✓** — the template's entire mandate: lockfile, vuln-scan, auto-update,
  provenance, dependency-review readiness checks.
- **GHA ✓** — third-party-action SHA pinning, OIDC, reusable-workflow pins,
  provenance verification.
- **ORP ✓** — orphaned / abandoned / deprecated / EOL dependency signals.
- **BP ✓** — cross-bucket "supply-chain hardening" and "dead dependencies"
  classes across the typescript/rust/java buckets and the general bucket's
  SBOM/lockfile checks.
- **DEP ~** — flagging deprecated APIs can incidentally surface unmaintained
  libraries.

### A04:2025 — Cryptographic Failures

- **SEC ✓** — § "A04:2025 — Cryptographic Failures": weak primitives
  (MD5/SHA-1/DES/RC4/ECB), IV/nonce reuse, predictable randomness,
  non-constant-time comparisons, and committed secrets.
- **BP ✓** — IaC encryption at rest / in transit
  (`aws-cloudformation.md`, `terraform.md` remote-state encryption + sensitive
  outputs).
- **SCR ~ / GHA ~** — provenance signing / Sigstore attestation touch crypto
  verification but are not algorithm-strength checks.

### A05:2025 — Injection

- **SEC ✓** — § "A05:2025 — Injection": SQL/command/LDAP/XPath/CRLF/log
  injection, SSTI, and reflected/stored/DOM XSS.
- **GHA ✓** — script injection via untrusted `github.*` interpolated into
  `run:` steps.
- **BP ~** — `react.md` flags unsanitised `dangerouslySetInnerHTML` (XSS); no
  general-purpose SQL/command-injection check outside SEC.

### A06:2025 — Insecure Design

Inherently the most judgement-heavy / least-automatable category.

- **SEC ✓** — § "A06:2025 — Insecure Design": business-logic flaws, missing
  controls the threat model requires, and memory-safety classes folded in.
- **BP ~ / TST ~ / DOC ~ / SCR ~ / GHA ~** — incidental support only
  (observability posture, WHAT-tests documenting contracts, public-surface
  docs, runbook/quarantine-override design, privileged-trigger justification).

### A07:2025 — Authentication Failures

- **SEC ✓** — § "A07:2025 — Authentication Failures": missing/skipped auth on
  privileged endpoints, broken password reset, session fixation, missing MFA,
  and missing rate limiting on auth paths.
- **GHA ✓** — OIDC trusted publishing vs long-lived secrets.
- **BP ~** — signed-commit enforcement and no-hardcoded-credentials checks
  support secure credential handling but are not auth-logic checks.

### A08:2025 — Software or Data Integrity Failures

- **SEC ✓** — § "A08:2025 — Software or Data Integrity Failures": unsafe
  deserialisation / parser confusion, mass assignment.
- **SCR ✓** — lockfile integrity, provenance/attestation verification.
- **GHA ✓** — action SHA pinning, container-image digest pinning, cache
  poisoning, the PWN-request integrity chain.
- **BP ✓** — supply-chain pinning + SBOM/lockfile-diff checks.
- **TST ~** — untested public functions weakly raise integrity risk.

### A09:2025 — Security Logging and Alerting Failures

- **SEC ✓** — § "A09:2025 — Security Logging and Alerting Failures": missing /
  context-poor security logging, secrets in logs, integrity-unprotected log
  sinks. Strengthening of this class is already filed as ****
  (covered-by-sibling).
- **GHA ✓** — secret exfiltration via workflow logs/artefacts.
- **SCR ✓** — `prompts/supply_chain_readiness/` § `SCR-SEC-ALERTING`
  audits the **alerting / monitoring readiness posture** half of A09
 : an alerting path for security-relevant signals
  (advisory / Dependabot-alert notifications, alerting on
  security-relevant CI failures, a documented escalation /
  incident-response path). It is **posture only** and cross-references
  `security_scan`'s code-level A09 detection rather than re-filing it.
- **BP ~** — structured-logging / observability posture in the general bucket.

### A10:2025 — Mishandling of Exceptional Conditions

New in the 2025 edition.

- **SEC ✓** — § "A10:2025 — Mishandling of Exceptional Conditions": fail-open
  auth/authorisation on exception, broad catch-all blocks, unchecked error
  returns bypassing a control, stack-trace/info leakage.
- **BP ✓** — per-language error-handling buckets (`typescript.md` async/await
  + no-floating-promises, `rust.md` error-handling discipline, `java.md`
  exception discipline + try-with-resources).
- **GHA ~** — timeout enforcement implies exception control but is not framed
  as such.

## Gaps

After the `security_scan` OWASP-2025 re-map and the three already-filed
sibling gaps (container misconfiguration → A02; security_scan
logging/alerting → A09; supply_chain_readiness alerting readiness → A09),
**every OWASP Top 10 2025 category has concrete coverage by at least one
template.** One genuine **depth gap** remains and is filed by this issue:

| Gap | Category | Owning template | Filed issue |
| --- | --- | --- | --- |
| Terraform bucket lacks least-privilege IAM / no-public-exposure checks (the `aws-cloudformation` bucket has them; the `terraform` bucket does not) | A01:2025 (and A02:2025 for public exposure) | `best_practices` → `terraform` bucket | |

Covered-by-sibling (recorded, **not** re-filed to avoid double-filing):

- **A02 container/Dockerfile hardening** →
- **A09 security_scan logging/alerting strengthening** →

Landed since the matrix was first written:

- **A09 supply_chain_readiness alerting/monitoring readiness** →
  (the `SCR-SEC-ALERTING` check, now in `prompts/supply_chain_readiness/`).

Categories with only judgement-heavy / incidental partial coverage outside
`security_scan` (A06 Insecure Design in particular) are **not** filed as gaps:
`security_scan` already provides concrete detection for each, and no
additional automatable check is proposable without vague acceptance criteria.

## Maintenance

When a new idle-task template is added, add it to
[Templates registered since the snapshot](#templates-registered-since-the-snapshot)
(or score it into the matrix if you assess its OWASP coverage); when a
template's prompt gains/loses an OWASP-relevant check, update the matrix table
and the affected per-category section. Cite prompt **directories** and section
headings (not version filenames) so the matrix stays fresh as prompt versions
advance.

`worker/deno/tests/readme_docs_reachability_test.ts` asserts that **every**
registered template appears in this document — scored or listed — so the
inventory cannot silently go stale again.
