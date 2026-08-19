<p align="center">
  <img src="../../docs/social/vibe-coder-avatar.png"
       alt="Vibe Coder mascot — a smiling purple robot"
       width="160">
</p>

# @vibe-coder/worker

The Deno TypeScript worker at the heart of the Vibe Coder. It bundles all of the
project's business logic — issue assessment, PR maintenance, security and
best-practice scans, merge enforcement, and the dozens of supporting commands —
behind a single command-dispatch entry point (`mod.ts`).

This directory is a self-contained Deno package (`@vibe-coder/worker`,
Apache-2.0) whose public entry point is `./mod.ts`. The repository-root
[`README.md`](../../README.md) documents the project as a whole; this file
documents the package itself.

## Usage

`mod.ts` is the command registry and entry point. Invoke it with a command name
and optional `--flag value` arguments:

```bash
# Print version information
deno run --allow-env mod.ts version

# List every registered command
deno run --allow-env mod.ts help

# Assess the clarity of an issue
deno run --allow-env mod.ts assess-clarity --title "Fix bug" --body "Description"
```

Each command implements the `Command` interface from [`types.ts`](types.ts) and
is registered in `createDefaultRegistry()` in `mod.ts`. Run `help` for the
authoritative, always-current list — new commands appear there automatically.

For the generated listing of the package's public symbols, prefer the
Deno-native:

```bash
deno doc ./mod.ts
```

### Development tasks

The `deno.json` task entries wrap the common workflows:

```bash
deno task test     # run the test suite (worker/deno/tests/)
deno task check    # type-check every *.ts module
deno task lint     # lint
deno task fmt      # format
deno task quality  # run the full quality gate (quality.ts)
```

From the repository root, `./quality.sh` runs the same gate plus the
shell/Markdown checks.

## Layout

- **`mod.ts`** — command registry and CLI entry point (the package `exports`).
- **`commands/`** — one module per worker command; each implements `Command`.
- **`lib/`** — the supporting library modules the commands build on.
- **`setup/`** — the setup CLI (`setup/setup_cli.ts`) and its helpers.
- **`quality.ts`** — the quality-gate entry point invoked by
  `deno task quality`.
- **`types.ts`** — shared interfaces (`WorkerConfig`, `Command`,
  `CommandResult`, `Result`).
- **`tests/`** — the `deno test` suite; each module has a matching `*_test.ts`.

See [`AGENTS.md`](../../AGENTS.md) for the full coding conventions and the
command-authoring guide.
