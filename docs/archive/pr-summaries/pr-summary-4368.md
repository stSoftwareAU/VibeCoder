# PR Summary — Issue #4368

## Summary

Closes #4368. The existing trusted-fixture self-test now has an explicit live
comparison path backed by the existing Claude subscription. It runs two repeated
TypeScript/Rust tasks across three matched guidance arms, executes generated code
only in verified disposable containers, and measures the production review and
coverage checks on positive and negative fixtures. Exact prompts, hashes, source,
served models, attempts, outcomes, uncertainty and API-equivalent estimates are
recorded in `evals/capability_security/comparison-20261026.json`.

Generation advice is simplified to the selected advice and scope-change reminder;
the unproven expanded validation/index prose remains only as an evaluation
candidate. Review, coverage, authorisation and quality gates remain unchanged.

## Spec

### Intent and Rationale

Fewer scanner findings do not establish useful working code. An authorised update
must still work while cross-tenant and privileged writes fail. A fair comparison
also counts false accusations against secure, irrelevant and unchanged code.

### Essential Design Decisions

- Same explicit model, effort, task contracts and budgets, with rotated arm order
  and repeated samples. Shared coding guidance is included in every arm; the
  current arm includes the production compact capability section.
  Review cases have opaque IDs and matched rotated order; expected labels stay
  outside model prompts, with a separate prompt hash for every review repeat.
- Positive subscription proof, no provider tools/MCP/hooks/settings, an empty
  generation directory, and no paid-API fallback. Existing adapters and cost
  telemetry preserve failed attempts and unknown prices.
- One CPU, 512 MB, 60 seconds, read-only input/root, no production mounts or
  credentials, and a verified empty guest network namespace. Authoritative
  parent tests cannot be replaced by child-reported test verdicts.
- Unknown execution/review evidence cannot become zero findings or a pass.
  Provisioning gets one bounded retry; executed failing code does not.
- Existing Wilson interval reporting is reused. This small correlated sample
  never changes production model allocation or claims a general winner.

### Undiscoverable Facts

Apple container 1.2.2 on macOS 27.0.1 supports the verified guest network-namespace
path with the installed image. Its CLI does not resolve the locally installed
image by digest; the runner records and verifies the actual inspected digest
around execution. Generated code receives no host subscription credentials.
The dry-run host harness is for checked-in trusted fixtures only; Cargo offline
mode and post-run file hashing are not described as native-code isolation.

## Evidence

- Negative controls cover empty, stub, deny-all, unwired, unconditional, working
  insecure and working secure TypeScript/Rust implementations.
- Regression tests failed before fixes for incomplete/contradictory parent
  verdicts, incorrect pre-existing review reports and answer-revealing fixture
  identifiers, then passed. Independent opaque-ID review and all nine focused
  comparison tests passed.
- Actual disposable probes cover secure TypeScript/Rust, forged verdict refusal,
  network/write refusal, parent-memory refusal and bounded timeout cleanup.
- The canonical coverage scanner and semantic judge run on secure, insecure and
  irrelevant fixtures. Semgrep is explicitly not run by this comparison; the
  normal repository Semgrep gate remains separate.
- Completed matched run: all three arms passed 4/4 joint tasks, with zero review
  false positives/negatives; canonical coverage/semantic confusion counts were
  also zero. All 18 calls served `claude-haiku-5-5`; no retries. The per-arm 99%
  interval is 37.6%–100%, so no superiority is inferred. API-equivalent estimates
  are 0.1227175/0.1230255/0.1221426 USD; cache and host effects preclude a ranking.
  The final hardened runner's file/prompt hashes and all 12 execution proofs were
  verified against the committed artefact.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — One documented non-interactive command runs a bounded fixture suite and produces a reproducible result artefact identifying each task, arm, revisions, outcomes, skips and costs. — evidence: `evals/capability_security/README.md`, `comparison-20261026.json` — reviewer: met
- **met** — Deterministic harness self-tests prove empty/stub/deny-all/unwired implementations fail, a working insecure implementation fails security, and a secure working implementation passes both. — evidence: `capability_security_eval_4368_test.ts` — reviewer: met
- **met** — Hold-out acceptance tests cannot be edited or substituted by generated code; failure to provision isolation prevents execution and is recorded. — evidence: `capability_security_eval_container_test.ts`, read-only mounts and trusted parent protocol — reviewer: met
- **met** — At least one completed matched comparison is recorded if supported execution is available; otherwise record the concrete blocker and automatic retry path, without claiming improvement. — evidence: committed completed comparison and bounded recovery tests — reviewer: met
- **met** — Added guidance is retained only with demonstrated benefit without unacceptable functionality/precision/cost regression; otherwise simplify/remove it. Keep results in Git, not permanent dead experiment branches. — evidence: compact production generation rendering; expanded candidate retained only for reproducibility; no winner claimed — reviewer: met
- **met** — Existing quality and security gates remain in place. The evaluation itself is unattended and recovers from transient infrastructure failures. — evidence: provider transient retry, lease recovery and executed-failure refusal regressions — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Reuses provider adapters, cost telemetry, runtime/image selection,
  bounded subprocess helpers, the canonical semantic/coverage checks and Wilson
  intervals. New modules are registered in the security-sweep ledger. Attribution
  and adoption status remain in the canonical references and guidance manual.

## Test Plan

- [x] Focused capability, review, coverage, evaluation and reporting suites.
- [x] Formatting, lint and type checks for the changed code.
- [x] Manifest completeness checks.
- [x] Real disposable Apple container probes and matched subscription execution.

## Merge verification

The full local gate passed 30,207 parallel tests and all static/type/lint checks,
then reported four existing clock/network-sensitive failures during a run whose
wall time exceeded its test time substantially. All 76 tests in those unchanged
files then passed in isolation. The separate serial suite passed 780 tests with
zero failures and one existing ignore; required CI remains authoritative.
Local Checkov is unavailable, and local Semgrep differs from the CI pin. No policy
or test is relaxed to obtain a passing check.
