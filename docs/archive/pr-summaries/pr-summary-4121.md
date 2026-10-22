## Summary

Closes #4121.

Codex runs now receive RTK's worker-authored `PreToolUse` hook through per-spawn
TOML overrides. RTK support is declared by the provider descriptor rather than
by a Claude-only comparison. Enabled Codex runs use the existing preflight,
prompt notice and saved-token accounting; disabled runs emit no hook flags.

## Spec

### Intent and Rationale

- Apply the same deterministic output filtering to Codex that Claude already
  receives, without relying on instructions in AGENTS.md.

### Essential Design Decisions

- Reuse `rtk hook claude`: Codex normalises shell calls to `Bash` with a string
  `tool_input.command`, so a payload shim is unnecessary.
- Translate the worker's matcher/command entries into `hooks.PreToolUse` TOML.
  Enable hooks and the invocation-scoped trust bypass only when entries exist.
- Declare `supportsPreToolUseHooks` on Claude and Codex. An absent capability
  remains unsupported, including Gemini, DeepSeek and an unknown provider.
- No operator home or shared configuration is written. Existing phase callers
  already pass their prepared hook settings through the provider seam.

### Undiscoverable Facts

- The issue names Codex 0.147.0, but the current tools manifest pins 0.163.0.
  The recorded runtime spike below used 0.147.0, the issue's explicit target.
- This workspace's nested Codex sandbox cannot execute a shell tool: its proxy
  routing bridge fails before the command starts. This limits the runtime
  evidence; it is not evidence of a successful complete Codex/RTK execution.

## Evidence

### Codex hook spike

Ran one real `codex exec` turn using Codex 0.147.0 and the checksum-verified
RTK 0.49.0 binary in an isolated home and temporary Git repository. A local
scripted Responses endpoint supplied one `exec_command` call, then a final
response; no account credentials or paid model call were used. The hook wrapper
captured stdin/stdout and forwarded the payload unchanged to `rtk hook claude`.
The invocation supplied this override and enabled hook trust for that spawn:

```text
-c features.hooks=true
-c hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="python3 <capture-hook>"}]}]
--dangerously-bypass-hook-trust
```

The model-side tool input was `{"cmd":"git status", "login":false}` (with the
isolated repository supplied as `workdir`). The observed hook input included:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {"command": "git status"},
  "tool_use_id": "call1"
}
```

`command` is a string, not an argv array. RTK returned:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecisionReason": "RTK auto-rewrite",
    "updatedInput": {"command": "rtk git status"}
  }
}
```

**Did the rewritten command run inside Codex? No.** The tool returned exit 101:
`failed to prepare host proxy routing bridge: failed to fill whole buffer`.
The hook itself ran and produced the expected rewrite, but the nested sandbox
failed before command execution. Replaying `rtk git status` directly in the
same temporary repository succeeded; the isolated gain store recorded one
command, 52 input tokens, 11 output tokens and 41 saved tokens. Those numbers
validate the local filtering path only; they are not a fleet performance claim.
The current 0.163.0 binary accepted the hook configuration but stalled during
nested sandbox filesystem initialisation, so its full execution remains
unverified locally. Its upstream hook tests cover the same normalised payload
and `updatedInput` rewrite contract.

### Automated checks

- 121 focused tests passed across RTK, provider invocation, both implementation
  phase paths and the RTK documentation checks.
- `deno task check:manifests`: 805 passed, 1 existing ignored test.
- Changed TypeScript files passed lint and formatting; `git diff --check` passed.
- The full `./quality.sh --sequential` run passed its initial structural
  checks, then stalled in the repository-wide unit pass with process-supervision
  test stubs still running. It was interrupted rather than reported as passed.
  The complete suite and missing local scanners remain for GitHub CI.
  Markdownlint, Semgrep, Checkov and release-tag reconciliation were locally
  reported as skipped because their tooling was unavailable.
- Deno's direct registry fetch was unavailable here. Exact locked JSR sources
  were downloaded and their published checksums verified. The final 121-test
  run passed with the original registry URLs pre-cached, `--cached-only`,
  `--frozen` and the unchanged repository compiler options.
- Provenance checked: #4121, “Give Codex runs RTK through Codex's PreToolUse
  hook (the image's Codex 0.147 supports updatedInput), instead of reporting
  unsupported”.

**Docs sweep** — grep: `rtk_output.enabled`, `PreToolUse`, `settingsJson`,
"Only Claude Code takes"; section: `docs/RTK-OUTPUT-TRIAL.md#1-the-candidate-and-how-it-is-wired`
and the RTK row in `docs/CONFIGURATION.md`; siblings: `Claude`, `Gemini`,
`DeepSeek`; updated: those two manuals and affected provider/runner/RTK comments.
The trial's Claude-specific historical population and unmeasured performance
bar remain historical. `docs/PROVIDER-FEASIBILITY.md:168` still describes the
Claude-only advisor edit guard, which this change does not extend to Codex.
`docs/CALLBACKS.md:516` still defines unsupported as a provider without hooks.

## Test Plan

- Added enabled/disabled Codex preparation tests, including generated argv and
  the saved-token delta, plus a capability-driven support test.
- Added command-hook translation, resume/stdin, empty configuration, quoting,
  multiple-entry and malformed-input tests.
- Before implementation, the enabled Codex test failed with `unsupported`
  versus `ok`, and the invocation test failed because hook flags were absent.
- No assertions were removed. Codex was removed from the unsupported-provider
  fixture because the issue requires “A Codex run reports `ok`, not
  `unsupported`”; Gemini and DeepSeek retain the original assertions.
- Twinned rules: no duplicated RTK support gate was found. Existing phase
  callers already use `prepareRtkRun`, `hookSettings` and `settingsJsonOption`;
  only the Codex descriptor needed additional argument wiring.
- In a separate checkout, all ten deliberate mutations went red: restore the
  Claude-only gate; remove the Codex capability; remove descriptor wiring;
  remove each of the three validation guards; remove the empty-entry guard;
  remove invocation wiring; remove hook trust; disable the hooks feature.

**Branch outcomes:**
- `worker/deno/lib/rtk_output.ts:235` — supported and unsupported capability — `worker/deno/tests/rtk_output_test.ts::prepareRtkRun - support follows the provider capability` and `worker/deno/tests/rtk_output_test.ts::prepareRtkRun - Codex installs RTK per spawn and records saved tokens` — restored the Claude-only gate, tests went red.
- `worker/deno/lib/codex_executor.ts:344` — invalid/missing groups and valid groups — `worker/deno/tests/agent_provider_settings_2383_test.ts::codex invocation - malformed hook settings fail with the violated contract` and `worker/deno/tests/agent_provider_settings_2383_test.ts::codex invocation - translates command hooks for fresh runs` — removed validation, test went red.
- `worker/deno/lib/codex_executor.ts:348` — missing/invalid matcher or hooks array and valid group — `worker/deno/tests/agent_provider_settings_2383_test.ts::codex invocation - malformed hook settings fail with the violated contract` — removed validation, test went red; positive counterpart is the fresh-run test.
- `worker/deno/lib/codex_executor.ts:353` — invalid hook type/command and valid command — `worker/deno/tests/agent_provider_settings_2383_test.ts::codex invocation - malformed hook settings fail with the violated contract` — removed validation, test went red; positive counterpart is the fresh-run test.
- `worker/deno/lib/codex_executor.ts:363` — empty/non-empty entries — `worker/deno/tests/agent_provider_settings_2383_test.ts::codex invocation - empty hook settings do not grant hook trust` — removed the empty guard, test went red; fresh and multiple-hook tests cover non-empty entries.
- `worker/deno/lib/codex_executor.ts:414` — settings present/absent/empty — `worker/deno/tests/agent_provider_settings_2383_test.ts::codex invocation - translates command hooks for fresh runs` and `worker/deno/tests/rtk_output_test.ts::prepareRtkRun - disabled Codex RTK leaves invocation unchanged` — removed invocation wiring, enabled test went red; empty-settings test covers an empty string.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Spike recorded with actual Codex hook input, RTK output and whether
  the rewritten command ran — evidence: Codex hook spike above — reviewer: met.
  Complete execution inside the fleet container remains unverified locally.
- **met** — Per-spawn Codex configuration and saved-token accounting — evidence:
  enabled/disabled Codex preparation tests — reviewer: met.
- **met** — Provider capability replaces the Claude-only gate — evidence:
  `prepareRtkRun - support follows the provider capability` — reviewer: met.
- **met** — Codex argv, disabled behaviour and `ok` status tests, including
  observed pre-fix failures — evidence: Automated checks and Test Plan — reviewer: met.
- **met** — Manuals list Codex support — evidence: RTK trial and configuration
  documentation changes — reviewer: met.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Self-review checked the provider boundary, existing call sites,
  per-spawn isolation, failure messages, changed comments, documentation and
  preservation of the unsupported-provider assertions. No dependency was added.
- **clean** — The implementation reuses the existing RTK hook and accounting;
  it introduces no instruction-based routing, payload shim or separate store.

## Merge verification

- Required CI: pending PR creation.
- Automated code review: pending PR creation.
- Full Codex command execution in the fleet container: not verified in this
  workspace; see the exact nested-sandbox failure above.
