# PR summary — #4368

`deno task capability-security-eval` (from `worker/deno`) scores the TypeScript and Rust resource-update fixtures with acceptance tests that stay outside the implementation directory. Functionality and security are separate. Empty output, a TODO stub, unconditional success, deny-all and an unwired helper fail functional acceptance. A working insecure implementation fails security. A secure implementation passes both. The recorded dry run is `evals/capability_security/dry-run.json`. Live model arms are skipped. Cost status is unknown. There is no winner and no invented benchmark number.

Part of #4368

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — One documented non-interactive command runs a bounded fixture suite and produces a reproducible result artefact identifying each task, arm, revisions, outcomes, skips and costs. — evidence: `evals/capability_security/dry-run.json` — reviewer: met
- **met** — Deterministic harness self-tests prove empty/stub/deny-all/unwired implementations fail, a working insecure implementation fails security, and a secure working implementation passes both. — evidence: `worker/deno/tests/capability_security_eval_4368_test.ts` — reviewer: met
- **met** — Hold-out acceptance tests cannot be edited or substituted by generated code; failure to provision isolation prevents execution and is recorded. — evidence: `worker/deno/lib/capability_security_eval.ts` — reviewer: met
- **partial** — At least one completed matched comparison is recorded if supported execution is available; otherwise record the concrete blocker and automatic retry path, without claiming improvement. — evidence: `evals/capability_security/dry-run.json` — reviewer: partial — reason: no live model run is configured, so the comparison stays partial and claims no improvement
- **missing** — Added guidance is retained only with demonstrated benefit without unacceptable functionality/precision/cost regression; otherwise simplify/remove it. Keep results in Git, not permanent dead experiment branches. — reviewer: missing — reason: no matched comparison exists, so benefit is not demonstrated; the bundle stays because #4365 requires it and this evaluation does not claim a benefit
- **met** — Existing quality and security gates remain in place. The evaluation itself is unattended and recovers from transient infrastructure failures. — evidence: `worker/deno/tests/capability_security_eval_4368_test.ts` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The harness is a local command. It does not add a fleet scheduler, import SecurityEval, or record a cost of zero.

## Review follow-up

A fixture command receives the untrusted-command allowlist under `clearEnv`, with a 60-second bound, a 512 MB V8 heap, `CARGO_BUILD_JOBS=1`, `deno --deny-net` and `cargo --offline`. The worker's credentials are not copied into the child. When the lease cannot be provisioned, every arm is recorded as blocked and the fixture is not started. The acceptance-test hash check remains; it is a tamper check. Live model comparison stays partial: there is no matched comparison, no winner and no cost. The issue does not require the separate `agent` account, and this harness does not demand it, because that account is absent on hosts that already score these fixtures.

## CI repair

Evaluation subprocesses now use the shared timeout helper with a 60-second per-command bound. The empty TypeScript fixture contains only a comment and still fails functional and security acceptance. The evaluation and timeout regression tests pass.
