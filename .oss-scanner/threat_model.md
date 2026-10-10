# Threat model

The full design-level threat model is
[docs/THREAT-MODEL.md](../docs/THREAT-MODEL.md) (assets A1 to A6, trust
boundaries, attack paths and their controls). Operator controls are in
[SECURITY.md](../SECURITY.md). This file is the short brief for the scanner.

## What this project does and where untrusted input enters

Vibe Coder is a Deno/TypeScript worker that polls GitHub for issues, builds a
prompt from their text, and runs an agent CLI (Claude Code or another provider)
with unrestricted shell access inside a container to edit a clone and open a
pull request. Treat as untrusted:

- issue titles, bodies, comments, labels and PR review text fetched from GitHub;
- the contents of any cloned target repository (CLAUDE.md, quality scripts,
  tests, workflows);
- agent CLI output parsed by the worker (summaries, JSON, exit status);
- callback and webhook payloads.

## Components that matter most / least

Most important:

- trust and authorization checks that decide whose issue text reaches a prompt
  (`worker/deno/lib/`), and prompt assembly from `prompts/`;
- the container launch, credential mounts and the `gh` guard shim
  (`run.sh`, `run.ps1`, `container/`);
- the content-approval snapshot store and the audit journal (asset A6);
- anything that writes secrets to logs, PR bodies or comments (asset A5).

Lower priority: report generators and documentation scans under
`worker/deno/commands/` that only read local state. `docs/` and `infra/` are
documentation and deployment examples.

## How to exercise it

From `/src/worker/deno`: `deno task test` runs the whole suite (about 1,900 test
files under `tests/`); pass individual files to run a subset. `deno task check`
type-checks everything. `mod.ts` is the CLI entry point for every subcommand.

## How you rate severity

- Critical: issue or comment text from a non-trusted GitHub user reaches the
  agent prompt or a shell, or any path that leaks a GitHub token, App key or
  provider API key (A1).
- High: escaping the container to the host (A2), pushing to a repository or
  branch outside the configured fleet (A3), exfiltrating private repository
  contents to a public sink (A4), or turning a blocking integrity control into
  a passing one (A6).
- Medium: secrets or sensitive data written to logs or telemetry without
  leaving the host, and denial of service of the worker loop.
- Low: issues that need the operator's own configuration to be hostile.

## Anything to leave alone

- The agent running with `--dangerously-skip-permissions` inside the container
  is by design; report ways out of the container or around the guards, not the
  flag itself.
- The operator's own config and host are trusted.
