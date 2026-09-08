# 🪤 Gate-Skip Drift Scan — Operator Manual

The gate-skip drift scan is the nineteenth registered
[idle-task](IDLE-TASK-FRAMEWORK.md) template. When the worker has no claimable
work it may pick this template, clone one monitored repository, and compare that
repository's **local quality gate** (`quality.sh`) with its **own CI**
(`.github/workflows/*`). It files **one issue per repository** naming every tool
the gate skips with a warning while CI installs and runs it. A repository whose
gate skips nothing CI enforces files nothing, and that is the expected outcome.

> **Terminology.** An _idle task_ is background work the worker performs only
> when no higher-priority work exists; see the
> [idle-task framework](IDLE-TASK-FRAMEWORK.md). A _gate skip_ is a
> `command -v <tool> … || echo "… not installed — skipping"` block: the gate
> notices the tool is absent, prints a warning, and continues.

## Design intent — the failure this prevents

The Vibe Coder runs each fleet repository's `quality.sh` inside its container
before it raises a pull request, so a quality failure should be caught and fixed
there rather than in the PR's CI. A gate that **skips** a missing tool breaks
that contract silently: the gate reports a pass it did not earn, and the tool's
findings meet the agent only after the PR is open.

That is exactly what happened to NEAT-AI-core PR 597. Its gate printed
`bats not installed — skipping shell helper tests` inside the container, while
the pull request's CI `apt-get install`ed the runner and ran all 394 BATS tests.
[Issue #1574](https://github.com/stSoftwareAU/VibeCoder/issues/1574) baked the
missing tools into the image; this scan makes the enumeration behind it
repeatable, so the next tool a gate skips is found before a PR fails in CI.

```mermaid
flowchart LR
    W["Idle-task wrapper<br/>Run a gate-skip drift audit"] --> G["Read quality.sh<br/>command -v … skipping"]
    G --> C["Read .github/workflows/*<br/>install-and-run of the same tool"]
    C --> M["Drop tools container/tools.json<br/>already pins for this repo"]
    M --> F["One gate-skip-drift issue<br/>naming each tool and both lines"]
    G -. no quality.sh .-> N["no findings"]
    C -. no workflow runs it .-> N
    G -. guard exits 1 .-> N
```

## What the scanner checks

[`gate_skip_drift_scanner.ts`](../worker/deno/lib/gate_skip_drift_scanner.ts) is
deterministic, network-free and executes nothing — the gate script and the
workflows are read as text.

| Input | Rule |
| --- | --- |
| `quality.sh` | A `command -v <tool>` guard followed by an `echo … skipping` is a **skip**. A guard that reaches `exit 1` first already enforces the tool, so it is never a finding. Both the `if … then … else` and the `\|\| echo` spellings are recognised. |
| `.github/workflows/*` | The tool is **enforced** when a `run:` step invokes it, or a `uses:` action runs it (`codespell-project/actions-codespell`). A bare `<tool> --version` probe and a `setup-*` action are installs, not enforcement. An install step (`apt-get install -y bats`, `pip install codespell`) is recorded as supporting evidence. |
| `container/tools.json` | A tool pinned as a toolchain whose `repos` list names this repository is **suppressed** — the image carries it, so the gate no longer skips. |

## Findings

One issue per repository, labelled `gate-skip-drift` plus `severity:high`, under
the fixed finding id `BP-GATE-SKIP-DRIFT` — so a repository never accumulates
two open drift issues. The body names each drifting tool with **both lines**:
the `quality.sh` line that announces the skip and the workflow line that
enforces it, plus the install line where the workflow has one.

The issue states the two fixes and leaves the choice to the repository:

1. **Bake the tool into the image** — add it to `container/tools.json` as a
   toolchain whose `repos` list names the repository, so the gate runs it; or
2. **Make the gate fail loud** — exit non-zero instead of printing a warning and
   continuing.

Repositories are **absolutely isolated**: the audit only reports the drift and
raises the issue; the fix rides a normal `work-on` pipeline pull request. The
scan is issue-only and never opens a PR.

## Fail-loud and fail-safe

- **Fail-loud.** A `quality.sh` that exists but cannot be read, or a
  `container/tools.json` that will not parse, returns `ok: false` and the
  wrapper issue records the scanner error. An audit that could not complete is
  never reconciled as "no findings".
- **Fail-safe.** A repository with no `quality.sh`, or with no workflows,
  produces no finding rather than a false one.

## Suppression

A drifting tool is waived by a governed marker on or immediately above the skip
line in `quality.sh`:

```bash
# best-practice-ignore: BP-GATE-SKIP-BATS — author=<github-login> expires=2027-06-30 CI-only suite
echo "⚠️  bats not installed — skipping shell helper tests"
```

All three fields are mandatory and the check fails closed: a marker missing
`author=`, `expires=` or reason text — or carrying a past expiry — does not
suppress, and the drift is reported as normal. See
[operator triage and suppression](IDLE-TASK-FRAMEWORK.md#operator-triage-and-suppression).

## Cadence

`cooldownHours: 168` caps the audit to once per repository per week, enforced by
`idle_task_cooldown_gate.ts`. The wrapper title dispatch matches on `Run a
gate-skip drift audit`, and `shouldFile` vetoes a fresh wrapper while one is
still open.

## Related documentation

- [Idle-task framework](IDLE-TASK-FRAMEWORK.md) — lifecycle, registry, cadence.
- [Container image](CONTAINER.md) — the toolchain manifest the suppression reads.
- [Bash syntax audit scan](BASH-SYNTAX-AUDIT-SCAN.md) — the sibling audit that
  checks a repository's CI blocks invalid scripts.
