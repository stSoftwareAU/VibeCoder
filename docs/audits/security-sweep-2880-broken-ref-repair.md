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

| Property                                                                    | Result                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ref names are never taken from raw text                                     | `brokenRefsIn` extracts candidates with a fixed pattern set, then every candidate is passed through `assertSafeGitRef` before it is returned — a name that fails validation (e.g. a leading `-` in any `/`-separated component) is dropped, not returned |
| a namespace allowlist runs before validation                                | `isRepairableNamespace` restricts both functions to `refs/heads/` and `refs/remotes/`; `refs/tags/`, `refs/notes/` and anything else is never a candidate, so a crafted stash or notes ref cannot be targeted                                            |
| `removeBrokenRef` re-validates its input                                    | it does not trust a ref handed to it by a caller other than `brokenRefsIn` — it repeats the namespace check and `assertSafeGitRef` itself before building any argv                                                                                       |
| every git argv uses `--end-of-options`                                      | `update-ref -d --end-of-options <ref>` stops the validated ref being reinterpreted as a flag even if validation were ever bypassed upstream                                                                                                              |
| the filesystem fallback path is git-resolved, not string-built from the ref | the loose-ref path comes from `git rev-parse --git-path <ref>` (git's own resolution of the already-validated ref), not from concatenating the ref into a path; a relative result is joined under `options.cwd ?? Deno.cwd()`                            |
| a missing loose ref file is not an error                                    | `Deno.remove` catching `Deno.errors.NotFound` treats "already gone" as success, so a repair does not fail merely because git's own `update-ref -d` had already removed the file                                                                          |
| no error is swallowed                                                       | every failure path (`update-ref` fails, `rev-parse --git-path` fails, `Deno.remove` fails for a reason other than not-found, the retry fails) returns `ok: false` with git's own stderr/stdout attached; nothing degrades to a silent no-op              |
| no network, no untrusted GitHub data                                        | the only inputs are the caller's own git command's stderr text and a `cwd`; there is no `gh` call and no parsing of API responses                                                                                                                        |

No findings. `brokenRefsIn`'s input is this process's own `git` stderr, not
attacker-controlled text, and every ref it extracts is re-validated before
`removeBrokenRef` accepts it — so the namespace and argv-injection controls
above are defence in depth, not the only guard.
