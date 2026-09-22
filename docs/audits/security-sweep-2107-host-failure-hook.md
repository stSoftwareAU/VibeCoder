# Security sweep — the host-failure hook (`host_failure_hook.ts`)

**Issue:** [#2107](https://github.com/stSoftwareAU/VibeCoder/issues/2107) (chunk
top-up-2107) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2107:

- `worker/deno/lib/host_failure_hook.ts` — added by #2107.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2107**, and this file is the reading of it.

## `worker/deno/lib/host_failure_hook.ts`

A targeted `.config.json` read, a payload builder pair, and a thin invoker over
the post-run callback runner's own spawn (`invokeCallback` in
`run_callbacks.ts`, swept under chunk 12b). It owns no credential, builds no
argv beyond the configured executable itself, and reads exactly one file.

Untrusted inputs, and how each reaches the output:

| Input                                | Source                                                                             | How it is handled                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configPath`                         | the host's resolved `.config.json` (`host_config_path.ts`), worker-controlled      | passed to `Deno.readTextFile` only; never interpolated into an argv or a shell string. It is echoed into an `invalid` message, which is operator-facing text, not a command                                                                                                                                               |
| the config file's contents           | operator-supplied JSON on the host                                                 | `JSON.parse` inside a `try`; a non-object root, a non-object `callbacks` and a malformed `host_failure` are each reported as `invalid`. The hook path is validated by the **production** parser (`parseHostFailureCallback`) — absolute, non-empty, no NUL — so the host cannot accept a path `.config.json` would reject |
| the hook path                        | the same config file                                                               | spawned **directly** with an empty argv (`invokeCallback` → `runWithTimeout(path, [], …)`): no shell, no `sh -c`, so nothing in it is parsed as a command                                                                                                                                                                 |
| `payload.logTail` / `payload.detail` | the failing attempt's own output, potentially attacker-influenced via a repository | placed in the JSON document only, `JSON.stringify`-encoded by the runner's context writer. Deliberately kept out of the environment, where a multi-line or oversized value is a spawn hazard rather than a fact                                                                                                           |
| the hook's stdout/stderr             | the operator's own executable                                                      | captured by `invokeCallback`, which redacts before it truncates (`redactSecrets` then the 4,000-character bound)                                                                                                                                                                                                          |

| Property                       | Result                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no shell, no argv construction | one direct exec of the configured path with `args: []`; no value from the payload or the config reaches an argv                                                                                                                                                                                                                                                          |
| environment                    | `clearEnv: true` plus `INHERITED_ENV_VARS` (`PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`) and the documented `VIBECODER_*` scalars. A test asserts the child environment contains nothing else, so a credential cannot reach the hook by inheritance                                                                                                                           |
| filesystem                     | one read of the configured config path; the 0600 context file is written and removed by the runner, which holds that boundary                                                                                                                                                                                                                                            |
| network                        | none                                                                                                                                                                                                                                                                                                                                                                     |
| regex safety                   | none used                                                                                                                                                                                                                                                                                                                                                                |
| secret surface                 | no credential is read or exported; captured output passes the shared redaction                                                                                                                                                                                                                                                                                           |
| resource bounds                | wall-clock bounded by `timeout_seconds` (1…3600, validated); captured streams truncated per stream. The config read is `readTextFile` on the operator's own file — unbounded in this module, as it is in `config.ts` which reads the same file wholesale                                                                                                                 |
| fail direction                 | fail-loud in the direction that matters: a missing file or absent key is `none` (not a fault), but an unreadable file, invalid JSON, a non-object `callbacks` and a rejected path are each `invalid` **with the message**, never silently answered as "no hook configured". Nothing here throws, so the host failure being escalated is not compounded by the escalation |

No finding. The one deliberate trust decision is the **targeted** read: the host
validates `host_failure` and `timeout_seconds` alone and ignores the
container-only keys beside them. That is narrower than the container's
whole-block load by design — a `success` hook naming a path only the container
can see is correct configuration, and failing the host on it would silence the
host's only escalation channel over a fault that is not its own. The keys the
host actually uses are validated by the same production parser, at the same
strictness, so nothing is relaxed.
