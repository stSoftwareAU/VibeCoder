# PR Summary — Unattended self-healing intent

Refs #3703.

## Summary

VibeCoder runs on unattended machines, but its containment proposal, incident-recovery instructions and milestone overview still required a person to supervise tests or approve routine progress. Record the owner's 19 October 2026 requirement that the fleet operates and self-heals without human intervention, and correct those conflicting instructions.

This is a documentation change. It does not claim to implement missing recovery paths or prove containment has passed an escape test. Issue #3703 was closed as not planned at the owner's direction.

## Spec

### Intent and Rationale

- Detect failures, preserve progress, repair within the worker's existing authority, verify and resume automatically.
- Persistent setup failures must lead to diagnosis and another supported recovery path, rather than endless identical retries or routine terminal human hand-offs.
- Keep required quality, review and security boundaries; an unavailable dependency produces an observable blocker and automatic recheck.

### Essential Design Decisions

- Put the canonical operating requirement near the start of DESIGN-PRINCIPLES.md and link the affected manuals to it.
- Reject the supervised-test proposal, retain honest coverage gaps and describe containment observations only as candidates for bounded automated checks.
- Replace the milestone manual's human-waiting model and the incident runbook's supervised restart with unattended verification and recovery requirements.

### Undiscoverable Facts

- During the issue audit, the owner explicitly said there is no human-supervised operation and that VibeCoder must self-heal without any human intervention.
- Existing source still has paths that require further automation. This PR records the required outcome without pretending those paths changed.

## Evidence

The changed intent, milestone, containment and incident-recovery sections were read together for conflicting instructions. New relative documentation links and the new intent anchor resolve locally.

Docs sweep — grep: "supervised", "human-run", "human review gate", "stops and waits"; updated DESIGN-PRINCIPLES.md, SECURITY.md, docs/workflows/milestones.md and docs/security/agent-containment-gap-analysis.md; section: Design Principles, One PR per work stream, Why milestones, G1 Sandbox, Recover and disclose; siblings: none — no runtime setting, provider or control was added.

Remaining supervised-test references in the containment analysis identify the external article's claim and the explicitly rejected recommendation; they are historical evidence, not instructions to run it. Existing trust-authorisation controls are not weakened by this documentation change.

## Test Plan

- markdownlint-cli2 0.23.2 with the repository configuration and changed paths: 231 files checked, zero issues.
- git diff --check: passed.
- New local links/anchor and removal of the replaced contradictory phrases: passed.
- ./quality.sh: attempted; stopped because Deno is not installed in this environment. The full quality gate is not claimed as passed.
- No runtime code changed; no new behavioural tests were added.

Branch outcomes: none added — documentation only.

## Merge verification

Required hosted CI and code review remain pending on this PR. No merge or bypass is requested.
