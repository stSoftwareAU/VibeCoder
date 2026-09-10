# Agent output fixtures (Issue #1695)

Inputs for the provider-neutral output adapters
(`worker/deno/lib/agent_output.ts`, `claude_output_adapter.ts`,
`codex_output_adapter.ts`). Every fixture states its provenance below —
**recorded** means it came out of the pinned CLI on this machine, **derived**
means it was written to the CLI's documented event shape because that CLI could
not be run here. Nothing is presented as a recording that is not one.

No fixture carries a credential: the recordings were made with no provider
credential present, which is exactly why several of them are authentication
failures.

## Recorded — Claude Code 2.1.261 (the `container/tools.json` pin)

Captured with the installed CLI, which reports `2.1.261 (Claude Code)`:

```bash
claude -p "<prompt>" --model haiku --output-format stream-json --verbose \
  --dangerously-skip-permissions < /dev/null > <name>.jsonl 2> <name>.stderr
```

| Fixture                                               | Invocation                      | What it shows                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-2.1.261-auth-failure.jsonl`                   | `-p "Respond with exactly: OK"` | `subtype: "success"` on a `result` line that is `is_error: true` — the envelope must never be read as success. The `assistant` line carries `error: "authentication_failed"`, the structured evidence the adapter prefers. Exit 1. |
| `claude-2.1.261-invalid-session.jsonl` / `.stderr`    | `--resume not-a-uuid`           | A start-up refusal of the session flags: one `result` line with `subtype: "error_during_execution"` and the CLI's own wording on stderr. Exit 1.                                                                                   |
| `claude-2.1.261-unrecognised-model.jsonl` / `.stderr` | `--model no-such-model-9x`      | stderr carries `[claude-code:unrecognized_model]` while stdout carries the authentication failure — both are preserved, and authentication wins because it is the CLI's own structured verdict. Exit 1.                            |

Sanitisation applied to the recordings, and nothing else: `session_id` values
replaced with `00000000-0000-4000-8000-000000000001`, host paths rewritten to
`/workspace`, the host-specific `tools` / `skills` / `slash_commands` /
`plugins` / `agents` / `memory_paths` / `messaging_socket_path` / `mcp_servers`
/ `capabilities` / `terminal_slash_commands` keys of the `init` line dropped,
and the shell's `Shell cwd was reset …` epilogue removed from stderr.

## Derived — Claude Code 2.1.261 envelope shapes

No credential was available here, so a _successful_ run could not be recorded.
These reuse the recorded envelope shapes above with the message content changed:

| Fixture                                          | What it shows                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-2.1.261-success-quoted-rate-limit.jsonl` | Exit 0, `is_error: false`, and prose that quotes "429 Too Many Requests" and "Claude AI usage limit reached". A success, never a refusal. |
| `claude-2.1.261-usage-limit.stderr`              | A stderr-only usage-limit refusal carrying the CLI's machine-readable pipe-and-epoch-seconds reset suffix.                                |

## Derived — Codex CLI 0.147.0 (`codex exec --json`)

The Codex CLI is not installed in this environment (the default image installs
Claude alone — `installedProviders` in `container/tools.json`), so these are
written to the documented JSONL event shapes rather than recorded. The adapter
accepts **both** envelope generations, which is why one fixture is the legacy
`{"id":…,"msg":{…}}` protocol shape.

| Fixture                                 | What it shows                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-0.147.0-success.jsonl`           | `thread.started` → `item.completed` (agent message) → `turn.completed` with usage. The final message quotes "429 Too Many Requests"; it is still a success. |
| `codex-0.147.0-usage-limit.jsonl`       | `turn.failed` with `usage_limit_reached`, a weekly scope and `resets_in_seconds`.                                                                           |
| `codex-0.147.0-rate-limit-429.jsonl`    | `turn.failed` with HTTP 429 and `retry_after_seconds` — transient, **not** an exhausted subscription.                                                       |
| `codex-0.147.0-auth-401.jsonl`          | An `error` event with HTTP 401 — authentication, **not** model-unavailable.                                                                                 |
| `codex-0.147.0-not-logged-in.stderr`    | A stderr-only failure with no stdout events at all.                                                                                                         |
| `codex-0.147.0-model-unavailable.jsonl` | `model_not_found` with HTTP 404.                                                                                                                            |
| `codex-0.147.0-malformed.jsonl`         | A non-JSON log line and a truncated final line: the agent message is still recovered and the malformed lines are counted, never thrown on.                  |
| `codex-0.147.0-legacy-envelope.jsonl`   | The `{"id":…,"msg":{…}}` protocol shape with `agent_message`, `token_count` and `task_complete`.                                                            |

When a Codex CLI becomes runnable here, replace the derived files with
recordings and move their rows into a "Recorded" table above — the tests read
the files, so nothing else changes.
