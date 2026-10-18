# Milestone 121 validation

This record covers issues #3700, #3701 and #3702. The implementation is based on
main `75f71756a281bb160b0386902ad0b7df0220f2e1` and includes the independently
reviewed GitHub connection-failure classifier fix needed by the quality gate.
It also includes the shared quality-gate test fixture repair that supplies its
own Markdown runner instead of relying on a host-installed executable.

## Observed CLI behaviour and limits

The installed executable reported Claude Code **2.1.302**. Its actual
`claude --help` output did not list `--max-turns`. A credential-free probe with
an isolated configuration directory accepted
`-p --max-turns 0 --output-format stream-json --verbose` and exited with the
not-logged-in error. This confirms parser acceptance, not a model reaching the
turn cap. No authenticated live cap-exhaustion result was observed.

The official [CLI reference](https://code.claude.com/docs/en/cli-reference)
documents `--max-turns` for print mode and a non-zero exit on exhaustion. The
[agent loop documentation](https://code.claude.com/docs/en/agent-sdk/agent-loop)
documents the `error_max_turns` result subtype. Tests use that documented schema
and deliberately generated stub output; neither is labelled a live capture.

Native provider scanner fixtures follow the
[Codex item schema](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/items.ts)
and [Gemini output schema](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/output/types.ts).
These fixtures establish supported parsing behaviour, not observed production
incidents. The scan does not execute transcript content.

## Validation scope

The focused tests cover retention boundaries, separate caps, seeded and clean
transcripts, native provider records, malformed and oversized evidence,
compression, scheduling persistence and production idle-hook wiring. Turn-limit
tests cover argv, validated defaults, both bootstraps, distinct logs and the
shared typed terminal error contract. Explicit helper retries preserve that
terminal cause before further agent invocations or publication.

A total of 108 targeted guard, operand and call-site mutation probes were applied
independently and restored. The companion
[transcript facts](../archive/pr-summaries/pr-summary-3700.facts.json) and
[turn-limit facts](../archive/pr-summaries/pr-summary-3701.facts.json) name the
specific failed test and mutation. This is targeted mutation evidence, not a
claim of an exhaustive generated mutation run. Two filesystem-only limitations
are explicitly recorded as untestable with the harness search and reason.

First-red behavioural checks reproduced missing retention, cap arguments,
terminal classification, native-provider scanner coverage, compressed-file
coverage loss, scan size limits, stale standalone/shell cap transport and
partial-work publication. The later verifier regression also returned
`ok: true` before terminal propagation was added. Import-resolution or type
errors encountered while building fixtures are not counted as behavioural red
results.

No completed local `./quality.sh` result is claimed. The final immutable source
is intended for the same unchanged quality script in hosted Linux before PR
publication. Human review of the finished SECURITY.md runbook remains required
before merge, independently of technical validation.

## Completed focused checks

- Sixteen combined behavioural test files: 454 passed, 0 failed. This includes
  the six planning stages and terminal quality-remediation regressions.
- Repository manifest checks: 687 passed, 0 failed, 1 ignored by the existing
  harness.
- The shared quality-gate fixture suite: 39 passed, 0 failed.
- Configured Deno formatting and lint checks passed; Markdown lint passed.
- Both archived summary checks report zero blocked gates. Their model-dependent
  summary claim checks are explicitly not checked, not represented as passes.
- The complete unchanged quality gate remains a separate publication condition.

## First hosted run and follow-up

The [first immutable-source run](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39089145423)
checked source `9a2fcdc227a08800153cccb7b8a7261fc4df9f9a`. Its parallel unit pass
reported 28,666 passed, 4 failed and 4 ignored; the serial pass did not run.
All other required quality stages passed; configuration integration was
reported skipped by the existing gate. This is a failed full gate, not a
completed validation pass.

Three failures were existing DeepSeek/routing argv expectations that omitted
the new cap. The expectations now retain all prior arguments and add only the
cap. An isolated mutation removing the production cap argument makes all five
edited argv tests fail, including the two earlier Claude descriptor assertions.
The exact replacements and issue requirement are recorded in the turn-limit
archive's Test Plan.

The fourth failure came from the standalone test changing HOME while passing
an empty DENO_DIR on CI, selecting a fresh child cache. Reproducing DENO_DIR
unset with an isolated parent default-cache HOME failed the existing test.
Resolving the actual cache with `deno info --json` before changing HOME fixes
that case and keeps `--cached-only`, with an explicit frozen lockfile. All
three affected test files then passed together: 37 passed, 0 failed.

The follow-up needs a new unchanged full-gate run against its immutable source.
Human runbook review remains pending.

## Second hosted gate and standalone test classification

[The second unchanged full gate](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39090393190)
ran against source `c081a90d81800fea2b9a9a02c103efc135c4e27f`. Both complete
Deno passes passed: parallel in 9m12s and serial in 2m32s. The required stages
also passed, apart from the unit-test time budget; config integration retained
its existing `SKIPPED` result. The sole budget failure was the standalone turn
limit test, which bundled three independent CLI bootstraps into one 1.55s test.

The follow-up gives each existing scenario its own named test: configured cap,
default cap over stale ambient transport, and terminal cap exit/logging. All
previous assertions and real `mod.ts` subprocess launches remain. Each process
was already independent; no stateful sequence was split. No time threshold,
manifest exemption or skip changed. The actual `deno task test:unit` runner
passes all three and its unchanged time budget. A default-cache run with
`DENO_DIR` unset also passed, with JUnit times of 0.322s, 0.326s and 0.305s before
the final helper extraction (times are observations, not timing assertions).

Isolated mutations independently break each scenario: replace the configured
cap with the default (configured scenario fails); suppress default-cap
propagation (default scenario fails); remove the fallback logger (terminal
scenario fails). These were assertion failures with the other cases left intact,
and production source was restored after every probe. Logs are
`m121-standalone-split-{configured,default,terminal-log}-red.log` and
`m121-standalone-split-budget-green.log` in the task's temporary evidence folder.

Main `f498bf3bf86d2d78b828ae920a01a7e3117b7ba7` was merged cleanly before this
follow-up. Its security-fix retry changes retain the existing agent failure
stop path. This new tree still requires a full unchanged hosted gate; human
runbook review remains pending.

## Documentation sweep

Updated `docs/CONFIGURATION.md` Operational Defaults, Agent transcripts and
Scheduled security scan, plus `SECURITY.md` Agent-incident runbook. Checked
`claude_timeout` as the existing operational-limit sibling. Existing timeout
references describe wall-clock controls and remain correct alongside the new
per-invocation turn cap.

`docs/security/agent-containment-gap-analysis.md` explicitly identifies itself
as a point-in-time analysis at base `f108cad7`. Its lines 44, 45, 139, 143 and
150 intentionally retain the earlier 3-day/200-file/no-scan/no-runbook gaps;
lines 180 and 182 identify these follow-up issues. They are historical evidence,
not current operator instructions.

Runbook links were checked against the local Configuration, Deployment,
Agent Accountability and Threat Model manuals and their headings. The Docker
preservation route uses a separately verified local reader image, disables
networking and mounts the evidence volume read-only. The Apple route explicitly
retains a stopped named volume untouched until a supported backup is confirmed.
No containment/credential-rotation command in the runbook was executed against
a live worker during this task.

### Retained current-document hits

The final grep also found these current references. Each remains true: they
explain existing wall-clock timeout or scheduling behaviour rather than a claim
that wall-clock time is the only execution bound.

- `docs/CONFIGURATION.md:43` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:1797` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:1823` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:1824` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:1861` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2170` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2179` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2191` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2413` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2436` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2471` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2484` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2500` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2501` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2503` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2504` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2509` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2543` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2549` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2716` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2816` — still describes the wall-clock timeout or its existing consumer.
- `docs/CONFIGURATION.md:2966` — still describes the wall-clock timeout or its existing consumer.
- `docs/MODEL-AND-CACHING.md:778` — still describes the wall-clock timeout or its existing consumer.
- `docs/MODEL-AND-CACHING.md:3641` — still describes the wall-clock timeout or its existing consumer.
- `docs/MODEL-AND-CACHING.md:3651` — still describes the wall-clock timeout or its existing consumer.
- `docs/TROUBLESHOOTING.md:842` — still describes the wall-clock timeout or its existing consumer.
- `docs/TROUBLESHOOTING.md:1079` — still describes the wall-clock timeout or its existing consumer.
- `docs/TROUBLESHOOTING.md:1212` — still describes the wall-clock timeout or its existing consumer.
- `docs/SETUP.md:1659` — still describes the wall-clock timeout or its existing consumer.
- `docs/SETUP.md:1688` — still describes the wall-clock timeout or its existing consumer.
- `docs/USAGE.md:411` — still describes the wall-clock timeout or its existing consumer.
- `docs/workflows/ci-fix.md:181` — still describes the wall-clock timeout or its existing consumer.
- `docs/workflows/issue-processing.md:1192` — still describes the wall-clock timeout or its existing consumer.
