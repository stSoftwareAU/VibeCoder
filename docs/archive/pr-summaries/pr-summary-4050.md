## Summary

Closes #4050

The threat model, the containment manual, the gap analysis and `SECURITY.md`
now say that general egress is default-deny on Docker and Podman, that C12
and C13 are GitHub-write controls only, and that Apple container is not
enforced yet. R9 and R11 stay open until the agent can no longer read
credentials (#3699). #4049 is cited as closed, not as a live denial run.

No version file is changed. #4051 is not implemented.

## Spec

### Intent and Rationale

- After #4047 and #4048, the documents that still said the container was on
  an open bridge, or that C12 and C13 controlled general egress, were false.
- The risks that remain are the readable credentials, misuse of an allowed
  destination, DNS on the internal network, and Apple container.
- #4049 was closed as not planned. The control's enforcing tests are the
  launch-plan and self-check unit tests, not a Docker or Podman row in the
  containment suite.

### Essential Design Decisions

- New control C35. Threat-model gap G2 stays the C28 failure-comment gap.
  The gap-analysis item G2 (network) is marked delivered for Docker and
  Podman only.
- R9 and R11 stay `Open` and cite #3699. #3699 is closed on GitHub; the
  readable mounts are still in the tree, so the risks are not closed here.
- The enforced-paths table names the worker, the proxy, the allowlist,
  `container_egress_probe.ts` on the default network, image builds, and
  Apple container as not yet enforced (#4051).
- `SECURITY.md` points at C35. It does not restate the design model.

### Undiscoverable Facts

- The sentence "Fine-grained outbound allowlisting is deliberately out of
  scope" was not in the milestone copy. The false claim there was that
  nothing enforced the allowlist until #4047. Both the allowlist section and
  the proxy section now say Docker and Podman route through the proxy, and
  that Apple does not yet.
- #4049's body asked for containment-suite denial rows. Those rows are not
  in the tree. The control row says the issue was closed as not planned.
- Gap-analysis line numbers that cited `networkMode: "bridge"` were stale
  after #4047 and are no longer cited.
- #4051 is open. Nothing in these documents says Apple container is
  contained.

## Evidence

Manual section read: CODING-STANDARDS.md, "PR Summary and Evidence".

Doc files updated: `docs/THREAT-MODEL.md` (Boundary 3, C35, enforced network
paths, R6, R9, R11, R13), `docs/CONTAINMENT.md` (diagram, network boundary,
egress allowlist, egress proxy), `docs/security/agent-containment-gap-analysis.md`
(G2 delivered for Docker and Podman) and `SECURITY.md` (pointer only). No UI
change, so there is no screenshot.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — a control row cites the allowlist (#4045), the proxy (#4046),
  the launch plan (#4047), the self-check (#4048) and the CI-evidence issue
  (#4049) — evidence: C35 in `docs/THREAT-MODEL.md`, pinned by
  `worker/deno/tests/threat_model_docs_test.ts` (the traceability test
  requires the cited paths to exist) — reviewer: met
- **met** — Boundary 3, R6 and R13 treat C12 and C13 as gh-write controls
  only — evidence:
  `worker/deno/tests/threat_model_docs_test.ts::C12 and C13 are not described as controlling general egress (Issue #4050)`
  — reviewer: met
- **met** — R9 and R11 stay Open, record default-deny on Docker and Podman,
  and cite #3699 — evidence:
  `worker/deno/tests/threat_model_docs_test.ts::R9 and R11 stay open and cite #3699 (Issue #4050)`
  — reviewer: met
- **met** — the enforced-paths table names the worker, the proxy, the
  allowlist, `container_egress_probe.ts`, image builds, and Apple as not yet
  enforced — evidence:
  `worker/deno/tests/threat_model_docs_test.ts::the enforced network paths table names every path, including Apple (Issue #4050)`
  — reviewer: met
- **met** — `docs/CONTAINMENT.md` no longer says the allowlist is unenforced
  or that outbound allowlisting is out of scope, and it says Apple is not
  yet enforced — evidence:
  `worker/deno/tests/containment_docs_test.ts::CONTAINMENT.md enforces the egress allowlist on Docker and Podman (Issue #4050)`
  — reviewer: met
- **met** — gap-analysis G2 is delivered for Docker and Podman, and
  `SECURITY.md` does not claim Apple containment — evidence:
  `worker/deno/tests/threat_model_docs_test.ts::gap analysis G2 is delivered for Docker and Podman and not for Apple (Issue #4050)`
  — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — the docs describe the code at this head: Docker and Podman are
  default-deny, Apple is not enforced, #4049 is not described as a passing
  live denial, and #3699 is not described as having removed the credential
  mounts
- **clean** — a docs test fails if `docs/THREAT-MODEL.md`,
  `docs/CONTAINMENT.md`, the gap analysis or `SECURITY.md` again claims that
  C12 or C13 control general egress

## Merge verification

- Required CI and the routine code review are pending until observed.

## Test Plan

- `worker/deno/tests/threat_model_docs_test.ts` and
  `worker/deno/tests/containment_docs_test.ts` passed in the 144-test
  focused batch (`--allow-read --allow-env --allow-write --allow-run`).
- Not run: `./quality.sh`.
