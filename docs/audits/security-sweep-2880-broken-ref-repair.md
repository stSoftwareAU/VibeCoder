# Security sweep — broken loose ref repair (`broken_ref_repair.ts`)

**Issue:** [#2880](https://github.com/stSoftwareAU/VibeCoder/issues/2880) (chunk
top-up-2880) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/broken_ref_repair.ts` — added by #2880.

## `worker/deno/lib/broken_ref_repair.ts`

The module repairs a shared clone whose loose ref file names an object the
object store no longer has, by deleting the broken ref so the next fetch
recreates it from the remote. Two exported functions, both called from
`worker/deno/lib/git_branch.ts`: `brokenRefsIn` (pure, parses git's own stderr
for the ref name git blames) and `removeBrokenRef` (runs `git
update-ref -d`,
and on failure falls back to resolving and deleting the loose ref file
directly). This is a subprocess/argv (12a) and filesystem (12b) module.

Shapes checked:

| Property                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ref names are never taken from raw text                           | `brokenRefsIn` extracts candidates with a fixed pattern set, then every candidate is passed through `assertSafeRefComponent` before it is returned. A name carrying `..`, whitespace or any character git refuses in a ref (`~^:?*[\`), or beginning with `-`, is dropped, not returned                                                                                                                                                                                                                              |
| a namespace allowlist runs before validation                      | `isRepairableNamespace` restricts both functions to `refs/heads/` and `refs/remotes/`; `refs/tags/`, `refs/notes/` and anything else is never a candidate, so a crafted stash or notes ref cannot be targeted                                                                                                                                                                                                                                                                                                        |
| `removeBrokenRef` re-validates its input                          | it does not trust a ref handed to it by a caller other than `brokenRefsIn`: it repeats the namespace check and `assertSafeRefComponent` itself before running any git command                                                                                                                                                                                                                                                                                                                                        |
| every git argv uses `--end-of-options`                            | `update-ref -d --end-of-options <ref>` stops the validated ref being reinterpreted as a flag even if validation were ever bypassed upstream                                                                                                                                                                                                                                                                                                                                                                          |
| the filesystem fallback deletes nothing outside the git directory | the loose-ref path comes from `git rev-parse --git-path <ref>`, which does **not** validate the ref name, so the path is not trusted on its own. Before `Deno.remove`, the path's parent is resolved with `realPath` and the result must lie inside the real `git rev-parse --git-common-dir`; anything else is refused with an error naming the path. The earlier revision of this row said the git-resolved path was safe by itself, which was wrong: a `..`-bearing ref resolved outside `.git` (PR #2881 review) |
| a missing loose ref file is not an error                          | `Deno.remove` catching `Deno.errors.NotFound` treats "already gone" as success, so a repair does not fail merely because git's own `update-ref -d` had already removed the file                                                                                                                                                                                                                                                                                                                                      |
| no error is swallowed                                             | every failure path (`update-ref` fails, `rev-parse --git-path` or `--git-common-dir` fails, the path is outside the git directory, `Deno.remove` fails for a reason other than not-found, the retry fails) returns `ok: false` with git's own stderr/stdout attached; nothing degrades to a silent no-op                                                                                                                                                                                                             |
| no untrusted GitHub API data                                      | the only inputs are the caller's own git command's stderr text and a `cwd`; there is no `gh` call. That stderr is **not** purely the worker's own text: for a fetch it includes server-relayed `remote:` lines, which is why the two controls above exist                                                                                                                                                                                                                                                            |

One finding, fixed in PR #2881: `..` was not rejected, so a ref named in a
`remote:` line of a fetch's stderr could steer the filesystem fallback into
deleting a file outside the clone. Candidates are now validated with
`assertSafeRefComponent`, and the fallback confirms the resolved path is inside
the git common directory before deleting it. Both controls have unit tests in
`worker/deno/tests/broken_ref_repair_test.ts`.
