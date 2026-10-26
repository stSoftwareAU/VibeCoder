## Summary

Closes #4050

The threat model, the containment manual, the gap analysis and `SECURITY.md`
now say that general egress is default-deny on Docker and Podman, that C12
and C13 are GitHub-write controls only. The combined milestone includes
#4051's measured partial Apple containment, with host/LAN gaps and unknown
DNS/IPv6 coverage recorded per control. R9 and R11 stay open until the
agent can no longer read credentials (#3699). #4049 is cited as closed
not planned; the separate live Docker evidence comes from #4392's required CI.

This summary reconciles the original #4050 documentation change with the
later #4392 CI evidence and merged #4403 Apple implementation.

## Spec

### Intent and Rationale

- After #4047 and #4048, the documents that still said the container was on
  an open bridge, or that C12 and C13 controlled general egress, were false.
- The risks that remain are readable credentials, misuse of an allowed
  destination, DNS on the internal network, and Apple's measured host/LAN
  and unavailable-probe gaps.
- #4049 was closed as not planned. That proposal is not claimed as delivered.
  The launch-plan and self-check tests are supplemented by #4392's required
  live Docker job; no independent live Podman run is claimed.

### Essential Design Decisions

- New control C35. Threat-model gap G2 stays the C28 failure-comment gap.
  The gap-analysis item G2 (network) is marked delivered for Docker and
  Podman only.
- R9 and R11 stay `Open` and cite #3699. #3699 is closed on GitHub; the
  readable mounts are still in the tree, so the risks are not closed here.
- The enforced-paths table names the worker, the proxy, the allowlist,
  `container_egress_probe.ts` on the default network, image builds, and
  Apple's measured internal/advisory modes (#4051). Apple's coarse verdict
  stays `not_enforced` even when individual controls pass.
- `SECURITY.md` points at C35. It does not restate the design model.

### Undiscoverable Facts

- The sentence "Fine-grained outbound allowlisting is deliberately out of
  scope" was not in the milestone copy. The false claim there was that
  nothing enforced the allowlist until #4047. Both the allowlist section and
  the proxy section now say Docker and Podman route through the proxy, and
  the original #4050 text left Apple pending. #4051 subsequently added the
  measured partial Apple boundary described by the final documents.
- #4049's body proposed live CI denial on Docker and Podman. It was closed
  as not planned. The final #4392 CI nevertheless exercised the existing
  required Docker containment suite; its result is separately attributed.
- Gap-analysis line numbers that cited `networkMode: "bridge"` were stale
  after #4047 and are no longer cited.
- #4403 merged the #4051 implementation. Its live Apple evidence is partial,
  host-specific and unauthenticated; the documents do not claim universal
  network isolation or credential unreadability.

## Evidence

Manual section read: CODING-STANDARDS.md, "PR Summary and Evidence".

Doc files updated: `docs/THREAT-MODEL.md` (Boundary 3, C35, enforced network
paths, R6, R9, R11, R13), `docs/CONTAINMENT.md` (diagram, network boundary,
egress allowlist, egress proxy), `docs/security/agent-containment-gap-analysis.md`
(G2 delivered for Docker and Podman) and `SECURITY.md` (pointer only). No UI
change, so there is no screenshot.

The final [#4392 Quality run](https://github.com/stSoftwareAU/VibeCoder/actions/runs/40270317445)
passed on `1ec7ddaf5b97b237320c0de27a46d3e8ac6638eb`.
Its [Docker job](https://github.com/stSoftwareAU/VibeCoder/actions/runs/40270317445/job/121401723263)
built the image and passed 335 in-image checks plus 15 live containment
tests / 47 steps with `VIBE_CONTAINMENT_REQUIRED=1`. PR #4392 merged as
`c34848301822ea81bc21ff4eb3d3e312f8820685`.

The final [#4403 Quality run](https://github.com/stSoftwareAU/VibeCoder/actions/runs/40278858542)
passed on `a9f732656f11e8d7759a068df7087942ff8b3404`; #4403 merged as
`fffd5aab1c4b0ac10d375b9e603ff460e61f5da6`. The Apple observations, negative
controls and accepted gaps are recorded in [pr-summary-4051.md](pr-summary-4051.md).
Neither CI result is a claim that the complete local `./quality.sh` ran.

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
  allowlist, `container_egress_probe.ts`, image builds, and Apple's measured
  partial containment without whole-policy enforcement — evidence:
  `worker/deno/tests/threat_model_docs_test.ts::the enforced network paths table names every path, including Apple (Issue #4050)`
  — reviewer: met
- **met** — `docs/CONTAINMENT.md` no longer says the allowlist is unenforced
  or that outbound allowlisting is out of scope, and it describes Apple's
  measured partial boundary — evidence:
  `worker/deno/tests/containment_docs_test.ts::CONTAINMENT.md enforces the egress allowlist on Docker and Podman (Issue #4050)`
  — reviewer: met
- **met** — gap-analysis G2 is delivered for Docker and Podman, while
  `SECURITY.md` distinguishes partial Apple containment — evidence:
  `worker/deno/tests/threat_model_docs_test.ts::gap analysis G2 is delivered for Docker and Podman and not for Apple (Issue #4050)`
  (the retained test name predates #4051; its current assertions require
  the partial Apple wording) — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — the docs describe the code at this head: Docker and Podman are
  default-deny, Apple has measured partial containment, #4049 is not
  described as delivered, #4392's live Docker proof is separately recorded,
  and #3699 is not described as having removed the credential mounts
- **clean** — a docs test fails if `docs/THREAT-MODEL.md`,
  `docs/CONTAINMENT.md`, the gap analysis or `SECURITY.md` again claims that
  C12 or C13 control general egress

## Merge verification

- Implementation PRs #4392 and #4403 merged after their final required
  Quality runs above succeeded. The final milestone-to-main PR still needs
  its own review and required CI on the combined head.

## Test Plan

- `worker/deno/tests/threat_model_docs_test.ts` and
  `worker/deno/tests/containment_docs_test.ts` passed in the 144-test
  focused batch (`--allow-read --allow-env --allow-write --allow-run`).
- Final required CI: #4392 Quality run `40270317445` and #4403 Quality run
  `40278858542` passed on their respective final heads.
- Not run locally for this documentation reconciliation: `./quality.sh`.
