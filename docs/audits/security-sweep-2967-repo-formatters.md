# Security sweep — repository formatters (`repo_formatters.ts`)

**Issue:** [#2967](https://github.com/stSoftwareAU/VibeCoder/issues/2967) (chunk
top-up-2967) · **Parent:** #2932

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/repo_formatters.ts` — added by #2967.

## `worker/deno/lib/repo_formatters.ts`

The module runs the repository's own formatters (`cargo fmt --all`, `deno fmt`)
over the files the branch changed, in their outermost tracked config
directories, and, if any tracked file differs afterwards, commits the result as
one `style: apply repository formatters` commit. A #2932 follow-up wired it
into the issue run, before each quality-gate attempt and before the completion
phase's pre-push gate; a #3806 follow-up added the PR-feedback and CI-fix
rounds, between `commitAndPushPending`'s commit and its Step 1b gate. It formats only the code files (never Markdown) that the
pre-push gate's `deno fmt --check` would check, and runs `cargo fmt --all` only
for a cargo root whose `.rs` files changed.

Shapes checked:

| Property                                         | Result                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commands are fixed argv                          | `["cargo", "fmt", "--all"]` and `["deno", "fmt", "--permit-no-files", ...paths]` are argv arrays run without a shell; the paths are the branch's changed files as git lists them, and a leading `-` gets a `./` prefix so no path is read as an option |
| spawned via the untrusted-quality-command runner | formatters run through `QualityGateDeps.runCommand` with `stdin: "null"`, the same chokepoint the quality gate itself uses for untrusted-repo commands                                                                    |
| cwd is derived from the repo's own tracked paths | `outermostConfigDirs` only considers directories `git ls-files` reports as containing `Cargo.toml`/`deno.json`/`deno.jsonc`; no path is taken from issue, PR or comment text                                              |
| output and git stderr are redacted               | a formatter's output excerpt and any git step's stderr are passed through `redactedTail(text, 500)` before being logged or returned, so a credential a failing tool echoes never reaches a log line or result             |
| commits are scoped to tracked files              | the commit stages with `git add -u -- :(literal)<path>…` over the formatted paths only, which re-stages already-tracked files only — a formatter cannot sweep a new or secret file, or an unrelated edit, into the commit |
| the commit carries a run-id trailer              | `appendRunIdTrailer` stamps the commit message with `Vibe-Coder-Run-Id`, the same traceability trailer other worker commits use                                                                                           |
| fail loud, nothing swallowed                     | the function never throws: a failed `ls-files`, snapshot, `add` or `commit` is logged at warn and reported via `gitError`; a snapshot that fails mid-loop stops the run immediately rather than being read as "no change" |

No findings. The module is covered by
`worker/deno/tests/repo_formatters_test.ts`.
