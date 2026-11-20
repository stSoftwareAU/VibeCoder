# 🧪 Claude Code Code Mode experiment

| | |
| - | - |
| **Candidate** | Claude Code's [Code Mode](https://code.claude.com/docs/en/code-mode): the model writes one JavaScript script that issues many tool calls, instead of one tool call per turn |
| **Switch** | `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` in the Claude CLI's environment — **not wired**: no worker, container or configuration file sets it |
| **Bar** | ≥ 10% lower mean cost per completed Claude implementation run, success and PR merge rates no worse (§4) |
| **Trial host** | not chosen (§4) |
| **Status** | ⛔ blocked — the CLI refuses Code Mode in a `claude -p` session (§2) |

Status: blocked

This page records why the fleet cannot try Code Mode yet, and what must change
before it can (Issue [#5240](https://github.com/stSoftwareAU/VibeCoder/issues/5240)).
The experiment observes first: it records a status of `blocked` or `feasible`
here, and the switch is wired only once the status is `feasible`. Codex runs its
own code-mode host (`container/providers/codex.sh`) and is out of scope; this
page is about Claude Code on fleet worker runs.

## 1. 🧩 What Code Mode would change

In Code Mode the model writes one JavaScript script that issues many tool calls,
rather than spending a model turn on each call. The wager is that a run with many
small reads and searches costs less when those calls are batched into scripts.
The switch is the environment variable `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`.

## 2. ⛔ Why it is blocked

### 2.1 Observed: the CLI refuses Code Mode under `-p`

The worker spawns every Claude run as `claude -p --output-format stream-json`
(`buildClaudeCliArgs` in `worker/deno/lib/agent_provider.ts`). With the switch set, the
fleet image's CLI prints this before it starts:

```text
Warning: Code Mode (experimental) isn't available: for now it only works in the interactive terminal. Starting with the ordinary tools.
```

Observed on **18 November 2026** on the fleet image, Claude CLI **2.1.322**,
from a worker session. Observed again on 20 November 2026, same version, from
the #5240 implementation run. The session then carries on with the ordinary
tools, so the switch costs nothing and changes nothing in a `-p` run.

### 2.2 Read from the binary, not observed: two more refusals the fleet meets

The 2.1.322 binary carries a table of reasons Code Mode can be refused. Two of
them match the fleet's configuration. Both are **read from the binary, not
observed**: the `-p` refusal above fires first, so a worker run never reaches
them.

- **`DO_NOT_TRACK=1`.** The binary's reason text: "it needs settings that Claude
  Code downloads from Anthropic, and this session doesn't download them
  (DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or
  CLAUDE_CODE_DISABLE_FEATURE_FLAGS turns that off)". The image sets
  `ENV DO_NOT_TRACK="1"` image-wide at `container/Containerfile` line 269 (added
  for Graft's telemetry, it reaches every process in the container).
- **Model.** The binary's reason text: "for now it only works with Opus 5.5 and
  Sonnet 5.5". The planning-shaped phases (`planning`, `grill_me`, `refinement`,
  `revision`, `question`, `clarification`, `quorum`, `quorum_judge`) default to
  the `fable` alias, Fable 5.2 on CLI 2.1.322 (`PHASE_MODEL_TIERS` in
  `worker/deno/lib/phase_routing.ts`), and the fleet PR reviewer
  (`.claude/skills/review-fleet-prs/`) runs on Fable 5.2. Code Mode would exclude
  those review and planning runs. The fast-tier phases on `haiku` are excluded
  too.

The same table lists further reasons (background jobs, `CI` or `IS_DEMO` set,
tool restrictions, agent teams, an API key helper or custom auth, a provider
other than the Anthropic API, an account gate, and mods that check tool calls).
This page does not assess them; the experiment that restarts it does.

### 2.3 Version

The Code Mode documentation states a minimum CLI version of **2.1.323**. On the
observation date the Claude pin in `container/tools.json` was **2.1.322**, and
that binary already ships the Code Mode check and the warning above. This page
does not raise the pin.

## 3. 🔁 Reproducing the refusal

```bash
CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude -p "Reply OK" --no-session-persistence
```

The warning is printed before the CLI checks its login, so the command needs no
credential. From inside a worker run, which is not logged in, the output on
2.1.322 is the warning followed by `Not logged in · Please run /login`, with exit
code 1. A worker run can therefore observe the start-up warning and nothing
after it.

## 4. 🎯 The bar, once the status is `feasible`

An experiment keeps Code Mode only if it shows **at least 10% lower mean cost
per completed Claude implementation run**, with **success and PR merge rates no
worse** than runs without Code Mode. This is the bar the trial of Issue
[#4959](https://github.com/stSoftwareAU/VibeCoder/issues/4959) uses.

No host or window is chosen while the status is `blocked`. The issue that
restarts the experiment chooses them, and does not share a host and window with
another running trial: the #4959 trial's protocol names GRQ-25 as its trial
host, and a Code Mode window on the same host would confound both results.

## 5. ▶️ How the experiment restarts

The fleet has no automation that detects `-p` support arriving: no build step or
scheduled task runs the reproducing command. A person runs the command in §3 on
the current fleet image. Once the warning is absent, a new issue restarts the
experiment: it checks the refusals in §2.2, records `Status: feasible` here or
the next blocker, chooses the host and window, and only then wires the switch.

## 6. 🚫 Not chosen

- **Running fleet Claude sessions under a pseudo-terminal.** Offered in grill-me
  Round 1 on #5240 and not chosen: it would replace the stream-json output path
  every phase relies on. Whether the `DO_NOT_TRACK` and model refusals fire under
  a pseudo-terminal has not been observed.

## 7. 📚 Sources

- [Code Mode](https://code.claude.com/docs/en/code-mode) and
  [environment variables](https://code.claude.com/docs/en/env-vars) — the pages
  would not open from the worker sandbox; the minimum version and the
  description in §1 come from search summaries of them, which agree with the
  observed warning.
- The warning in §2.1, observed by running the command in §3.
- The reason texts in §2.2, read from the 2.1.322 binary at
  `/usr/local/bin/claude`.
