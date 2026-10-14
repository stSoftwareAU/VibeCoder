# PR Summary — Issue #3652

## Summary

This PR adds a gap analysis that measures VibeCoder against Anthropic's "Agent
containment best practices" article. The report is at
`docs/security/agent-containment-gap-analysis.md` and covers seven areas:
sandbox, network, credentials, permissions, run limits, monitoring and
incidents. Six areas are ADOPT and each has one follow-up issue (#3698–#3703).
Permissions is SKIP. The PR also rewrites THREAT-MODEL R9 and R11 as open until
#3698 lands. Both rows claimed that egress control (C12, C13) stops a stolen
credential leaving the container, which is false: C12 and C13 cover `gh` writes
only, and the container runs on a bridge network with open egress. Closes #3652.

- [x] Gap report with seven area sections, a Skipped list and a Summary
- [x] Row in `docs/security/README.md`
- [x] THREAT-MODEL R9 and R11 rewritten as open until #3698; R6 pointer added
- [x] `docs/SETUP.md` "Several Claude tokens" no longer restates R9's old
      acceptance
- [x] One follow-up per ADOPT (#3698–#3703); the human-run escape test plan
      itself (seven checks against the C22 properties, per runtime) is in G1
- [x] Anthropic-account items recorded as SKIP
- [x] Comment-only updates in `claude_env.ts` and the isolation test header

## Spec

### Intent and Rationale

R9 and R11 accepted two credential exposures because egress control was said to
stop exfiltration. No such control exists, so the risks are recorded as open
with a linked fix. The article gives a concrete checklist; comparing it against
the code, with `file:line` for each claim, turns a vague "we are contained" into
a list of specific gaps and owners.

### Essential Design Decisions

- Docs only. No worker code logic changes; the two code edits are comments that
  repeated the old R9 wording.
- Exactly one follow-up per ADOPT, linked from its section.
- The supervised sandbox-escape test (G1) is ADOPT, but its follow-up (#3703) is
  a plan for a human to run. No escape attempt is made by the agent.
- Anthropic-account items (escape-classifier score, notifying the account team)
  are SKIP: the fleet runs the Claude Code CLI, where the score is not
  available.
- R6 and R11 refer to R9 as plain "see R9", not bold, because
  `claude_token_isolation_test.ts` finds the R9 row with
  `find((line) => line.includes("**R9**"))`; in `docs/THREAT-MODEL.md`, `**R9**`
  now appears only in the R9 row itself (`docs/THREAT-MODEL.md:242`).

### Undiscoverable Facts

- `networkMode: "bridge"` (`worker/deno/lib/container_runtime.ts:346`) means
  outbound traffic is unrestricted; there is no allowlist anywhere.
- C12 (write-repo allowlist) and C13 (`gh` guard shim) only govern `gh` write
  calls. A raw `curl` from the agent passes neither.

## Evidence

Documentation and comment change only, with no runtime code.

**Docs sweep** — grep: "R9", "R11", "C12", "C13", "egress"; section:
`docs/THREAT-MODEL.md` residual risks; siblings: "R10", "R12"; updated:
THREAT-MODEL residual-risks intro (rows whose third column begins "Open."), R6,
R9, R11 and the closing line, `worker/deno/lib/claude_env.ts:33`, the header of
`worker/deno/tests/claude_token_isolation_test.ts`; `docs/SETUP.md:981-987` —
rewritten: it restated R9's old acceptance ("same exposure … count, not its
kind", "blast radius is the container"), and now says R9 is an open gap because
egress is open until #3698; `docs/SETUP.md:1299-1305` — still true because it
only says R9 records the part of the mount boundary that is not closed;
`docs/security/agent-containment-gap-analysis.md` G7 — no longer lists
`SECURITY.md` sections; it names the nearest two (Responsible Disclosure Policy
`:2072`, the advisory-triage runbook link `:286`) and says neither covers a
compromised agent run; `docs/THREAT-MODEL.md` R13 — still true because it claims
only that RTK adds no exposure relative to existing controls.

Related existing rules checked for agreement:

- `CODING-STANDARDS.md` commit safety and secret handling
- `SECURITY.md` credential handling and container hardening sections
- `docs/THREAT-MODEL.md` C21 (credential mount) and C22 (containment)

None of them conflicts.

Applied the new rule to this PR's own diff. The PR adds no new rule to a prompt
or standard, so there was nothing to apply. Nothing found.

Provenance numbers the diff adds: #3652 — this issue; #3698 — egress (G2); #3699
— credentials (G3); #3700 — monitoring (G6); #3701 — run limits (G5); #3702 —
incidents (G7); #3703 — escape-test plan (G1). All were returned by
`gh issue create` in this run and are open.

Review: the spec review found every acceptance criterion met. The standards
review found two issues (a wrong `worker_log_cleanup.ts` line citation and a
bold R9 reference that broke the isolation test's row lookup); both are fixed.

Security self-check: no secrets or hidden files staged; no new input, shell,
SQL, filesystem or HTTP surface; no new dependency; no endpoint or privilege
change.

## Test Plan

- The test edit is comment-only; no assertion changed.
- `deno task test:unit tests/claude_token_isolation_test.ts` (from
  `worker/deno`): `ok | 9 passed | 0 failed` for
  `worker/deno/tests/claude_token_isolation_test.ts`.
- Every test under `worker/deno/tests` that names `SETUP.md` or `THREAT-MODEL`
  (`deno test --allow-all`): `ok | 150 passed | 0 failed`.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)`; only
  config integration was skipped.
- `deno fmt --check` on `docs/THREAT-MODEL.md` and `docs/SETUP.md` reports the
  same existing table-alignment differences on `main`; the gate's own fmt stage
  passed.

Branch outcomes: none added
