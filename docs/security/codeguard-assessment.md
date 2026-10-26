# CodeGuard assessment: useful, secure and unattended code

Reviewed on 26 October 2026. The five-capability bundle has since shipped,
rewritten under CC-BY-4.0, and it is not an upstream plugin. The matched
live model comparison in #4368 has not been run.

## Sources and attribution

The secure-coding guidance comes from **CoSAI / OASIS Project CodeGuard**,
not VibeCoder. We assessed CodeGuard v1.5.0 at commit
`41160d54980bab0618165485ade3cfd2ade93288`:

- [Rule catalogue](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules)
- [Selection and implementation workflow](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/SKILL.md)
- [Guidance, host orchestration and scanner ownership](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/docs/adr/0001-separate-guidance-from-runtime-and-scanning.md)
- [Evaluation design and limitations](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/evaluations/codeguard-inspect/README.md)
- [Upstream content licence: CC-BY-4.0](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/LICENSE.md)

This document summarises and evaluates those ideas in our own words. Any
adapted upstream material must retain attribution, its licence reference and
a description of changes. No upstream code, plugin or rule bundle is vendored
by this documentation change.

VibeCoder was inspected at `314e797556d9927ab7e8830d61f822f501d70204`.
The live repository API identifies `main` as its default branch; the
`Develop` instruction in CONTRIBUTING was stale at assessment time.

## Decision

Adopt selected ideas through the existing implementation, review and scan
paths. Keep the guidance local, capability-scoped and model-independent.
Measure whether it produces working, secure features.

The useful contribution is not a new vulnerability taxonomy. VibeCoder already
has extensive OWASP-based security discovery, supply-chain checks, shared
review machinery and behavioural test standards. CodeGuard offers a useful
way to connect relevant security context to implementation advice, review
checklists and validation before a defect reaches a retrospective scan.

### Intent constraints

[Design Principles](../../DESIGN-PRINCIPLES.md) requires fully unattended
operation and self-healing. These proposals must preserve that:

- No new routine confirmation prompt, human sign-off, supervised validation
  or `needs-human` gate. Enforce existing authority through deterministic
  permissions and controls.
- Recover automatically from transient failures with bounded attempts,
  retained state and rechecks. Continue independent eligible work.
  Unavailable validation stays not checked; never bypass a control or retry
  forever without progress.
- Deliver the requested functionality through real production entry points.
  A stub, unused validator, unconditional success or deny-all handler fails
  acceptance even if a scanner reports no findings.
- Reuse framework controls and existing VibeCoder consumers. Avoid another
  scanner, scheduler, reviewer agent or large always-loaded checklist.
- External sources remain reference material. No runtime fetching or
  automatic import of upstream changes; later revisions need assessment.
- Tests and containment checks run non-interactively in authorised,
  disposable environments. Security does not depend on an LLM claiming that
  an action is safe.

## Gap assessment

The table distinguishes existing coverage from additions worth implementing.
It is not a certification of every rule or every fleet repository.

| Area | Existing VibeCoder coverage | Useful addition |
| --- | --- | --- |
| Context selection | Language-scoped best-practices buckets; capability gates in the security scan | Select compact security guidance during implementation and review, from actual capabilities rather than extension alone |
| Injection, files and secrets | Security scan covers injection, traversal, secret leakage and unsafe sinks; coding standards include path confinement and redaction | Reuse those controls proactively; do not create duplicate vulnerability checks |
| Authorisation and mass assignment | Security scan covers object/function access and unsafe field binding | Connect real resource/role/tenant cases to allow-and-deny integration tests |
| Review | Fleet reviewer and pre-PR verifier share one brief; repo checklists use the base version | Feed applicable security checks through both existing consumers with explicit evidence |
| Logging | Security scan already distinguishes missing events, injection and leaked secrets | Check meaningful redaction tests where sensitive production output exists |
| Supply chain, CI and IaC | Existing best-practices, workflow audit and dedicated scanner gates | Preserve ownership; no second CodeGuard scanner or generic duplicate hardening campaign |
| Evaluation | Existing behavioural standards and lifecycle/cost reporting | Compare guidance on functional completion and security jointly, including false positives and cost |

Evidence inspected includes
[the implementation prompt](../../prompts/issue/prompt.md),
[the shared review brief](../../prompts/pr_review_brief/prompt.md),
[the fleet review skill](../../.claude/skills/review-fleet-prs/SKILL.md),
[repo checklists](../review-checklists.md),
[the security scan](../../prompts/security_scan/prompt.md),
[best-practices guidance](../BEST-PRACTICES-SCAN.md), and
[coding standards](../../CODING-STANDARDS.md).

## Implementation issues

| Issue | Scope | Dependency | Priority |
| --- | --- | --- | --- |
| [#4365](https://github.com/stSoftwareAU/VibeCoder/issues/4365) | Local capability-scoped secure implementation guidance, wired into ordinary issue work | Existing prompt assembly and controls | top-priority |
| [#4366](https://github.com/stSoftwareAU/VibeCoder/issues/4366) | The same applicable checks in fleet review and pre-PR verification | #4365; reuse existing checklist consumers | top-priority |
| [#4367](https://github.com/stSoftwareAU/VibeCoder/issues/4367) | Static best-practices checks for specific missing behavioural security coverage | #4365; retain cross-scan dedup | work-on |
| [#4368](https://github.com/stSoftwareAU/VibeCoder/issues/4368) | Bounded functional-and-security comparison with reproducible fixtures | Harness independent; candidate comparisons follow #4365–#4367 | work-on |

#4365, #4366 and #4367 have landed as the local bundle, the shared review
checks and the coverage scan. #4368 has a local fixture harness; its live
model comparison has not been run. Record a declined idea honestly.

Existing work was checked before filing. Path confinement (#2885), sibling
trust-boundary guards (#3679), prompt fencing (#3896), independent
security-fix verification (#3657), security-test discrimination (#3659), the
shared brief (#3395) and repo checklists (#3594) are dependencies or existing
mechanisms, not new discoveries. The broad fleet experiment issue #3645 is
closed not-planned; #4368 does not reopen its wider allocation programme.

## Specific lessons to adapt

### Authorisation tests must prove both allowed and denied behaviour

CodeGuard's
[authorisation rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-0-authorization-access-control.md)
proposes an endpoint/resource/role matrix and integration tests, including
swapped identifiers and insufficient permissions.

Adapt this to existing fixtures or table-driven tests. A separate matrix file
is optional. Test the real boundary and preserve legitimate behaviour;
rejecting every request is not successful authorisation. The
[API rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-0-api-web-services.md)
adds contract tests, and the
[logging rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-0-logging.md)
adds redaction validation. Missing tests are a coverage concern, not automatic
proof of an exploitable vulnerability.

### Select capabilities, not only languages

CodeGuard routes always-on, tag-based and language-based guidance. Its pinned
language table gives Rust only the MCP rule. That is not a sufficient selector
for Rust HTTP, database or filesystem code. Our adaptation must use inspected
entry points, dependencies, configuration and callers, and reconsider scope as
the implementation evolves.

### Guidance is not enforcement

CodeGuard's architecture decision deliberately leaves orchestration and
trusted state with the host, and comprehensive detection with specialist
scanners. Retain that separation. Prompt advice cannot replace deterministic
permissions, isolation, result validation or existing scanner gates.

### A clean static scan does not prove useful code

The pinned upstream evaluation checks changed, parse-valid Python and retained
Semgrep findings. It explicitly does not execute generated code or establish
functional correctness. Zero findings is only a scanner result.

The proposed VibeCoder adaptation adds task-specific executable acceptance
tests, held outside agent write access, and reports functionality, security,
their joint success, review precision and cost separately. Include deliberate
stub, deny-all and unwired-helper controls so the benchmark cannot reward
doing nothing. No improvement claim is justified until a matched comparison
has actually run.

## Rules not to import wholesale

- The [MCP rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-0-mcp-security.md)
  prescribes human confirmations and broad identity/attestation infrastructure.
  Routine human prompts conflict with our unattended intent. Infrastructure
  choices require an actual deployment need; they are not universal defaults.
- The [cryptography rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-1-crypto-algorithms.md)
  mandates TLS 1.3 only, while
  [additional cryptography guidance](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-0-additional-cryptography.md)
  includes TLS 1.2. Do not turn inconsistent upstream wording into fleet-wide
  compatibility changes. Use supported platform guidance and project context.
  The cryptography file also contains Broccoli-specific requirements; these
  are not VibeCoder requirements.
- The cryptography file's AES-GCM example is not a complete application
  encryption format or round-trip implementation. Do not copy snippets as
  production solutions; prefer established library APIs and behavioural tests.
- The [IaC rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-0-iac-security.md)
  includes blanket bans on IAM wildcards and blanket multi-region backup
  requirements. Assess real service constraints, recovery needs and cost;
  do not generate findings solely because a literal wildcard exists.
- The [certificate rule](https://github.com/cosai-oasis/project-codeguard/blob/41160d54980bab0618165485ade3cfd2ade93288/skills/codeguard/rules/codeguard-1-digital-certificates.md)
  gives expired certificates a blanket critical rating. Deliberately expired
  test fixtures and public certificates are not automatically vulnerabilities
  or secret leaks. Establish production reachability and consequence.
- C/C++, mobile, Kubernetes and framework-specific recommendations are
  conditional on those capabilities actually existing. Do not add unrelated
  frameworks or services merely to satisfy a catalogue.

## Rechecking upstream

The canonical source is registered in [References](../REFERENCES.md), pointing
to this assessment so the existing maintenance sweep can rediscover changes:

```sh
cd worker/deno
deno task references-refresh --source cosai-oasis/project-codeguard
```

This is the existing report-only maintenance command, not a new schedule.
Compare later upstream revisions with the pinned commit above, recheck the
linked rule files and evaluation limitations, and update adoption status and
issues. Future suggestions are not automatically approved for runtime use.
