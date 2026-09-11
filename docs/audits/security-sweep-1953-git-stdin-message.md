# Security sweep — bounded `git` stdin messages (`git_stdin_message.ts`)

**Issue:** [#1953](https://github.com/stSoftwareAU/VibeCoder/issues/1953)
(chunk 12ag) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with #1953:

- `worker/deno/lib/git_stdin_message.ts` — added by #1953.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12ag**, and this file is the reading of it.

## `worker/deno/lib/git_stdin_message.ts`

The module reads the message `git commit -F -` would have taken from stdin, so
the guard can scan it before it becomes permanent history. The bytes are
**attacker-influenceable**: the agent composes the message, and an injected
instruction in an issue body can steer what it writes there — which is the
whole reason the message is masked rather than trusted. The relevant shapes are
12c's untrusted-ingestion ones; the module spawns nothing and touches no
filesystem.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; the reader is a pure function over the chunk reader it is given |
| no filesystem, no network, no `gh` | nothing is opened. Stdin is already open when the process starts, so the guard child keeps its `--allow-read`-only footprint and needs no write grant |
| no environment or secret sinks | no `Deno.env`; the message is returned to the caller and never logged. The refusal messages name the bound and the remedy, never a byte of the message |
| the message is masked before it can reach history | the reader only reads. `redactGitMessageArgs` masks the text through `redactSecrets` and hands it to `git` as `-m <masked>`, the same path a `-F <path>` message already took, so a token piped on stdin is masked exactly as one typed in argv |
| a stream that never ends is refused on a deadline | `isTerminal` does not see a pipe held open by a writer that never writes (`mkfifo f; sleep 1000 > f`), which blocks exactly as a tty does. `STDIN_MESSAGE_DEADLINE_MS` (60s) bounds the whole read, so the worst case is a refusal naming `-F <path>` rather than a `git` command that never returns |
| a NUL byte is refused naming itself | the verdict is framed back to the wrapper as NUL-terminated fields, so a NUL inside the message would split into an extra field and be refused as an argument-count mismatch — fail-closed, but for the wrong stated reason. It is refused at the read instead |
| `-F - -F -` is refused, not replayed | the guard records that stdin was consumed and will not hand the same text over twice, where the real `git` sees the message once and then an empty stream |
| a terminal is refused, never read | an unattended worker that blocked on a tty read would hang until its watchdog fired. `isTerminal` is checked before the first read and refuses with `UnredactableMessageError` |
| the read is bounded, and the bound refuses rather than truncates | `MAX_STDIN_MESSAGE_BYTES` (64 KiB) caps the buffer. A larger message is refused naming `-F <path>`, which has no bound — a truncated commit message would be a silent corruption of the record |
| no unbounded work on attacker input | one pass over the chunks, then one decode; no regex, so no backtracking surface, and no recursion, so no depth to exhaust |
| a quiet stream cannot spin | a zero-length read ends the message exactly as `null` does, so a reader that stops yielding bytes can never loop forever |
| multi-byte characters survive chunking | the chunks are concatenated and decoded once, so a character split across a chunk boundary is not corrupted into replacement characters |
| the stream is read exactly once, by one reader | the guard consumes stdin once and signals that with its own allow marker, `VIBE_GIT_GUARD_ALLOW_STDIN`; the wrapper then runs the real `git` with `</dev/null`, so no second reader can see an empty or partial message |
| fail-loud, never fail-open | every refusal is an `UnredactableMessageError`, which `git_guard_cli.ts` turns into `[SECURITY] [GIT_MESSAGE_UNREDACTABLE]` and a refuse marker. The wrapper proceeds on a positive allow marker only, so a guard that crashed mid-read refuses the commit |
| the worker's own chokepoint is unchanged | `runGitCommand` supplies no stdin source, so `-F -` there still fails closed rather than silently gaining a new input |

## Residual risk

Unchanged from #1284 and stated again here: the shim is a containment boundary
against a single injected command, not a sandbox. An agent that invokes the real
`git` by absolute path, or edits `PATH`, bypasses the guard — and with it this
reader.

Regression coverage: `worker/deno/tests/git_stdin_message_test.ts` (the bound,
the terminal refusal, chunk decoding), `worker/deno/tests/git_guard_cli_test.ts`
(the markers and the masked argv) and `worker/deno/tests/git_guard_shim_test.ts`
(a real `git commit -F -` against a real repository).
