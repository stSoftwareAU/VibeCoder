# 🔎 Security sweep — brief toolchain runner (`brief_toolchain.ts`)

**Issue:** [#2602](https://github.com/stSoftwareAU/VibeCoder/issues/2602)
(chunk top-up-2602) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2602:

- `worker/deno/lib/brief_toolchain.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2602**, and this file is the reading of it.

## `worker/deno/lib/brief_toolchain.ts`

`createBriefRunner` spawns the external `brief` binary (git-pkgs/brief) once
per map generation; `extractCargoCommands` and `sanitiseCargoCommands` reduce
its JSON report to the Cargo commands the codebase map injects into the
agent's prompt. Nothing calls it yet — the per-host switch lands in the next
sub-issue of #2581.

| Input | Source | Handling |
| ----- | ------ | -------- |
| `repoDir` | worker — the checkout path | one argv element after `--json`; refused unless absolute and free of control/format characters, so brief can never read it as a URL, a `crate:`-style registry shorthand or a flag — the forms that reach the network |
| argv | fixed in code | `brief --json <repoDir>` via `runWithTimeout` (no shell, `stdin: null`, bounded by `DEFAULT_SUBPROCESS_TIMEOUT_MS`); `enrich`, `outline`, `diff`, `--cache` and `--dir` are never built |
| brief stdout | repository-derived — brief reads repo files such as the Makefile | `JSON.parse` inside a `try`; a non-object is `failed`. Only `command.run`, `command.alternatives` and `scripts[].run` strings are read, then allowlisted: `cargo ` prefix, no `\p{Cc}`/`\p{Cf}`/`\p{Zl}`/`\p{Zp}`/`\p{Co}` characters (control, bidi, zero-width, tag, soft hyphen), no backtick, ≤200 characters, ≤20 commands |
| brief stderr | brief | first line only, whitespace-collapsed and capped at 200 characters in the `failed` reason; the caller logs it through `createLogger`, which redacts secrets |

The allowlist is re-applied by `renderCodebaseMap`, and the map is fenced as
untrusted repo-derived data (`formatCodebaseMapSection`), so a hostile report
reaches the prompt only as inert Markdown list items. The `cargo ` prefix does
not strip shell metacharacters (`cargo test; …` survives) — the agent reads
these as documentation exactly as it reads the existing `deno task` and npm
script lines, and the worker never executes them.

Failure is reported, not thrown: a missing binary, a non-zero exit, a timeout
or unparseable output is `{status:"failed", reason}`, which the map cache logs
as a warning and never caches. No secret is read, no environment is passed
beyond the worker's own, and no file is written.
