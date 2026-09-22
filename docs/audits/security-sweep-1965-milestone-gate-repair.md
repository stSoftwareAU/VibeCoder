# Security sweep — the milestone sync's gate repair (`milestone_gate_repair.ts`)

**Issue:** [#1965](https://github.com/stSoftwareAU/VibeCoder/issues/1965) (chunk
top-up-1965) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #1965:

- `worker/deno/lib/milestone_gate_repair.ts` — added by #1965.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-1965**, and this file is the reading of it.

## `worker/deno/lib/milestone_gate_repair.ts`

The rung between the milestone sync's verification gate and a human. When the
gate refuses a resolution, it offers the failure back to the resolution agent —
at most twice a cycle, in the clone the merge is already in — folds whatever the
agent staged or committed into the merge commit, and re-runs the gate. Every git
call goes through `runGitCommand` (`git_timeout.ts`), the timeout- and
audit-guarded chokepoint; the module never spawns anything itself, and the agent
run reaches it as an injected function it does not construct.

Untrusted inputs, and where each goes:

| Input                        | Source                                                                                                              | How it is handled                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| gate `detail` / `output`     | the repository's own `deno task`/compiler output                                                                    | carried into the agent prompt only, where `prompt_builder.ts` fences it in the run's untrusted boundary; never interpolated into an argv |
| merged commit subjects       | commit messages from the default branch                                                                             | read with `log --format=%s`, fenced in the prompt exactly as above                                                                       |
| `preMergeSha` / `defaultRef` | the caller's own validated refs (`assertSafeGitRef` / `assertSafeRefComponent` ran before any git in `git_pull.ts`) | positional in `log <a>..<b>`; a log git refuses degrades to an empty subject list                                                        |
| `mergeSha`                   | `git rev-parse HEAD` in the clone                                                                                   | 40-hex from git itself; used as the `reset --soft` target                                                                                |
| repaired paths               | `git diff --cached --name-only`                                                                                     | reported only; never re-fed to git as arguments                                                                                          |

| Property                         | Result                                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no spawn, no argv                | every process is `runGitCommand`; no `Deno.Command` here                                                                                                                                                                                                         |
| argument injection               | no caller-chosen string reaches an argv position; the only refs used are the caller's already-validated SHAs                                                                                                                                                     |
| side effects on the shared clone | `reset --soft <mergeSha>` and the ladder's own staging path (`add -A`, worker state files unstaged, `assertSafeToCommit`); nothing is committed or pushed here                                                                                                   |
| commit safety                    | staging is `stageAgentResolution` from the ladder, so the pre-commit safety gate refuses a hidden or secret-bearing path exactly as on every other commit path                                                                                                   |
| resource bounds                  | at most two agent runs per cycle (`MAX_GATE_REPAIR_ROUNDS`), each refused unless `MIN_GATE_REPAIR_SECONDS` of the cycle's single grant remains; one bounded `log --max-count=20`                                                                                 |
| secrets                          | nothing here reads or logs credentials; the gate output it carries is the repository's own build output, fenced as untrusted data in the prompt                                                                                                                  |
| fail direction                   | every failure — a run the worker ended, a repair that changed nothing, a fold git refused, a grant too small — stops the loop and is reported as an unrepaired tree; the caller then resets the branch to its pre-merge SHA and escalates with both gate outputs |

No finding. The one deliberate trust decision is that the gate's own output is
shown to the agent: it is repository-produced text, so it is fenced as untrusted
data rather than spliced into the worker's prose, and the run that reads it can
only edit the clone the merge is already in.
