# Capability-security evaluation

A local harness for one resource-update task, in TypeScript and Rust.
Functionality and security are scored separately. The acceptance tests live
under `accept/` and are copied outside the implementation directory before
they run. Generated code cannot edit them; a hash change stops the arm and
is recorded as an error.

Implementations under `impls/` are fixtures, not model output:

| Arm | What it does |
| --- | --- |
| `empty` | No implementation |
| `stub` | Throws or panics with a TODO |
| `deny_all` | Rejects every call |
| `unwired` | An authorisation helper nothing calls |
| `unconditional` | Returns success and ignores the patch |
| `insecure` | Applies the patch for every caller |
| `secure` | Authorises the tenant and allowlists the writable field |

From `worker/deno`:

```sh
deno task capability-security-eval
```

The command writes `dry-run.json`. It does not call a model. Live comparison
is `partial`. Cost status is `unknown`, never zero. There is no winner.
The three model arms (`current-guidance`, `generic-secure-coding`,
`codeguard-derived`) are skipped, with the retry path recorded in the
artefact. Re-run the same command when a subscription-backed provider is
available. Do not record a winner until a matched comparison finishes.

This is not a fleet scheduler and it does not import SecurityEval.
