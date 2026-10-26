# Capability-security evaluation

Run a small matched comparison from `worker/deno`:

```sh
deno task capability-security-eval --live --model claude-haiku-5-5 \
  --effort low --samples 2 --runtime apple --image vibe-coder:343ff0df947e \
  --out ../../evals/capability_security/comparison-20261026.json
```

Use an installed worker image containing Deno, Rust and the containment tools.
The command uses the existing Claude subscription, proves that authentication
mode, disables tools, MCP, hooks and custom settings, and sends only the public
exercise and pinned guidance. It never installs a plugin or calls a paid API.
Generation happens in an empty directory without tools. Generated source runs
only after a disposable container passes the execution checks below.

There are three arms: current compact VibeCoder guidance, the common coding
baseline plus a short generic secure-coding instruction, and that baseline plus
the expanded selected CodeGuard-derived candidate. Each receives the same
provider, explicit model, effort, task contracts and time budget. Arm order
rotates between repeats. Two repeats mean 12 generations (TypeScript and Rust)
and six reviews of the same six base/head fixtures. `--samples` accepts 2–5;
`--timeout-ms` bounds each model invocation including its retry (default 60000,
maximum 300000). Generated execution has a separate fixed 60-second bound.

Model-facing review cases use opaque identifiers. Their order rotates by repeat,
identically across arms; expected classifications are stored only in the result
artefact's private scoring map. Each repeat's full prompt and hash are retained.

The artefact records exact prompts and hashes, source, fixture and scanner hashes,
actually served models, every attempt, outcome, elapsed time and existing
API-equivalent estimates. Unknown prices remain null. A different or unreported
served model makes the comparison partial. Costs describe estimated API usage,
not a subscription bill. Generation is one-shot: rework is zero by design,
without a claim about production repair cost. Counts and 99% Wilson intervals
are reported; two correlated tasks cannot establish general fleet performance.
The evaluator never changes production model allocation.

## Acceptance and isolation

The authoritative parent tests live in `accept/isolated/`. They are mounted
read-only with the adapters and implementation; the model cannot write or replace
them. Each child invocation returns a strict protocol response to the parent,
which owns assertions and the final test verdict. Extra output and forged test
verdicts fail. Joint success requires a complete, unique parent verdict and a
successful process exit, in addition to functional and security passes.

Only the fixture directory is mounted. There are no production credentials or
worker volumes. The guest has one CPU, 512 MB memory, a read-only root, disposable
temporary storage and a 60-second deadline. Docker/Podman use `--network none`,
zero capabilities and no-new-privileges. Apple uses a new Linux network namespace,
then drops to uid/gid 1000 with no capabilities before generated code runs.
The supervisor verifies identity, privilege restoration, routes, interfaces and
read-only mounts. The trusted parent also refuses access to its process memory.
Runtime and image inspection record the actual image digest; a changed image,
failed provisioning or failed cleanup cannot become a pass. There is no host
fallback for generated code. Only this run's exact container is cleaned up.

A transient model failure gets at most one retry within the original budget.
A failed provision gets one fresh container attempt. An executed failure is not
retried to improve the score. Permanent auth/quota errors remain concrete blockers.
The CLI writes partial evidence and exits 2 when a matched run cannot complete;
re-running the same bounded command performs a fresh health check. It never spins
or asks for routine approval.

## What the scanners measure

The canonical capability coverage scanner runs on secure, insecure and irrelevant
fixtures, with and without related tests. Its confusion counts measure missing
behavioural coverage, not exploit detection; static presence never claims that a
test ran. The production semantic fixture judge and model reviews assess secure,
insecure, deny-all, docs-only, unchanged pre-existing and newly exposed defects.
False-positive counts include incorrect pre-existing reports. Missing or malformed
review output is unknown, not zero findings. Semgrep is explicitly `not-run` in
this bounded comparison; no Semgrep detection result is inferred from it. The
repository's existing Semgrep quality gate remains separate and unchanged.

## Trusted fixture self-test

Without `--live`, the command runs checked-in trusted fixtures on the host and
writes `dry-run.json`. This mode is **not a generated-code sandbox**. A sanitised
environment, Deno permissions and Cargo offline mode are useful test constraints,
but neither Cargo offline nor a post-run hash check isolates native code.

| Fixture | Expected result |
| --- | --- |
| `empty`, `stub`, `unwired`, `unconditional` | Functional acceptance fails |
| `deny_all` | Functional acceptance fails; prohibited calls are rejected |
| `insecure` | Functional acceptance passes; security fails |
| `secure` | Both dimensions pass |

The deterministic self-tests exercise these negative controls. The strict runner
also has real-runtime checks for working TypeScript/Rust, forged verdicts, network
and write refusal, parent-memory refusal and deadlines. See the committed result
and [guidance adoption decision](../../docs/CAPABILITY-SECURITY-GUIDANCE.md).

## Recorded comparison, 26 October 2026

The committed `comparison-20261026.json` completed all 18 model calls using
`claude-haiku-5-5` at low effort, with no retries. Each arm passed all four
functional-and-security tasks; each arm's two reviews had zero false positives
and zero false negatives. The canonical coverage and semantic checks also had
zero fixture false positives/negatives. The 99% Wilson interval for each 4/4 task
count is approximately 37.6%–100%, so these results do not demonstrate superiority.

| Arm | Joint tasks | Estimated API-equivalent USD | Model-attempt plus execution time |
| --- | --- | --- | --- |
| `current-guidance` | 4/4 | 0.1227175 | 61.7 s |
| `generic-secure-coding` | 4/4 | 0.1230255 | 58.7 s |
| `codeguard-derived` | 4/4 | 0.1221426 | 56.1 s |

Timings exclude subscription authentication probes. Cache reuse and shared-host
load affect cost and time; this run is not a production cost/speed ranking. The
expanded prompt showed no functional or precision advantage in this sample.
Production generation therefore uses the compact selected advice, without the
expanded validation paragraphs and unselected-capability index. Existing review
and security gates are retained. The committed result uses the final hardened
execution boundary and opaque review identifiers; its source hashes match the
recorded files.
