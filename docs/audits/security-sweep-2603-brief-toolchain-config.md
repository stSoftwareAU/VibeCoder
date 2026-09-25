# 🔎 Security sweep — brief toolchain switch (`brief_toolchain_config.ts`)

**Issue:** [#2603](https://github.com/stSoftwareAU/VibeCoder/issues/2603) (chunk
top-up-2603) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2603:

- `worker/deno/lib/brief_toolchain_config.ts`

## `worker/deno/lib/brief_toolchain_config.ts`

`parseBriefToolchain` turns the operator-written `brief_toolchain` block of
`.config.json` into the `{ enabled: boolean }` switch. It runs no subprocess,
reads no file and writes nothing.

| Input                   | Source                         | Handling                                                                                                                                                                                    |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brief_toolchain` block | host `.config.json` (operator) | absent → off; a non-object, `null`, any key other than `enabled` or a non-boolean `enabled` is returned as a fault naming `brief_toolchain`, and `loadConfig` throws it — never read as off |

The switch only decides whether `execute_claude_phase.ts` passes the
already-swept brief runner (top-up-2602) to the codebase map. The outcome it
reports reaches two sinks: the run-stats comment and the callback document.

- **Run-stats comment.** A failure reason is rendered inside a code span with
  backticks and line breaks removed, and the comment is redacted at the
  `spawnGh` chokepoint.
- **Callback document.** The `brief.reason` is passed through `redactSecrets()`
  before a hook sees it.
