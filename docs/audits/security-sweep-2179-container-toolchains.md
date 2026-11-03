# 🔎 Security sweep — the container toolchain installer chain

**Issue:** [#2179](https://github.com/stSoftwareAU/VibeCoder/issues/2179)
(chunk 1) · **Parent:** #2170 `security-scan-overflow: 2 chunks not reached`

This record exists so a later run can tell a **swept** path from an unswept one.
No record under `docs/audits/` covered these files before this one; only
[`security-sweep-1956-toolchain-selfcheck.md`](security-sweep-1956-toolchain-selfcheck.md)
mentioned `pyyaml.sh`, and only in passing. This slice read the whole chain end
to end.

Siblings on the same parent:
[`security-sweep-2070-toolchain-selfcheck-command.md`](security-sweep-2070-toolchain-selfcheck-command.md),
[`security-sweep-2107-host-failure-hook.md`](security-sweep-2107-host-failure-hook.md).
The nearest method sibling — shellcheck first, then a semantic read — is
[`security-sweep-1221-shell-entry-points.md`](security-sweep-1221-shell-entry-points.md),
whose shape this record follows.

> **This is not an empty result.** Three root causes survived triage, all three
> in `container/install-tools.sh`, and all three are fixed in this change with
> regression tests (below). **No `security` issue was filed**, because no
> finding survived unfixed — an outcome stated here rather than implied. Several
> categories the issue named _were_ empty, and each is stated as such.

## The file-set correction

The issue lists **ten** `container/toolchains/*.sh` fragments and calls the
scope twelve files. On the branch this sweep reads there are **nine**: the tenth
fragment, `codegraph.sh`, landed on the unmerged milestone branch
`milestone/2145-trial-codegraph-as-a-second-repo-context-cand` (`3328d9f5`, PR
#2171) and is not reachable from the default branch. So the committed scope is
**eleven** files, not twelve, and `codegraph.sh` was read at that branch's tip
as an eleventh-and-a-half — recorded below as an observation rather than swept,
because it is not the code this PR's base carries.

| File                                 | Lines (as read) |
| ------------------------------------ | --------------- |
| `container/install-tools.sh`         | 234             |
| `container/install-toolchains.sh`    | 134             |
| `container/toolchains/actionlint.sh` | 69              |
| `container/toolchains/bats-core.sh`  | 69              |
| `container/toolchains/cargo-deny.sh` | 71              |
| `container/toolchains/codespell.sh`  | 93              |
| `container/toolchains/gitleaks.sh`   | 72              |
| `container/toolchains/pwsh.sh`       | 89              |
| `container/toolchains/pyyaml.sh`     | 160             |
| `container/toolchains/rust.sh`       | 112             |
| `container/toolchains/shellcheck.sh` | 74              |
| **Total**                            | **1,177**       |

Counted at the base of this change, before the lines it adds to
`install-tools.sh`.

## Scope and method

The eleven files above, read end to end, against `container/tools.json` (the pin
manifest they read with `jq`) and the `container/Containerfile` lines that
invoke them:

| Containerfile line | What it does                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `:164`             | `COPY toolchains/*.sh /tmp/toolchains/` — glob, not a bare directory                                                          |
| `:165`             | `COPY install-toolchains.sh /tmp/install-toolchains.sh`                                                                       |
| `:166`             | `COPY tools.json /tmp/toolchain-manifest.json`                                                                                |
| `:193-195`         | `bash /tmp/install-toolchains.sh shellcheck,actionlint,cargo-deny,gitleaks,pwsh,bats-core,codespell,pyyaml`                   |
| `:217-220`         | `bash /tmp/install-toolchains.sh rust`, then `rm -rf` of the fragments, the script and the manifest                           |
| `:399`             | `ARG VIBE_CONTAINER_TOOLS=""`                                                                                                 |
| `:401`             | `COPY install-tools.sh /tmp/install-tools.sh`                                                                                 |
| `:403-407`         | `printf '%s' "${VIBE_CONTAINER_TOOLS}" > "${spec}"`, then `bash /tmp/install-tools.sh "${spec}"` when non-empty, then `rm -f` |

Two passes, as #1221 did:

1. **`shellcheck` first**, so the read was not spent on findings a linter
   already has (below).
2. **A semantic read** against the five cases the issue names, tracing each
   interpolated value to a constant, a validated value, or a named source.

Every claim about a tool's behaviour below was **executed**, not recalled: the
GNU tar 1.35 and UnZip 6.00 traversal results, the environment-file line
injection, and the masked `jq` failure were each reproduced against the real
script before being written down.

### The trust boundary this sweep assumes

Two inputs are **operator-controlled and trusted**, and saying so is what makes
the residuals below residuals rather than findings:

- **`container/tools.json`** is a committed file. Its `version` values reach a
  download URL and an archive path in every fragment. Changing one is a PR
  against this repository, gated by review and by
  `worker/deno/lib/container_manifest.ts`.
- **`.config.json`'s `container_tools` array** is written by the deployer on the
  host, and is validated before it reaches the build by
  `worker/deno/lib/container_tools_config.ts`, which the module's own header
  calls "the trust boundary". Anyone who can write that file can already run
  code as the account that builds the image.

Neither is agent-reachable: `/workspace` is mounted read-only in the container,
and the config lives on the host. So "a malicious manifest" and "a malicious
spec" are **the operator attacking their own build**, and a finding only
survives here when it breaks an invariant the code itself claims — which is
exactly what the three below do.

## `shellcheck` triage — and what it did _not_ find

At the level CI enforces, all eleven files are clean:

```console
$ shellcheck container/install-tools.sh container/install-toolchains.sh container/toolchains/*.sh
$ echo $?
0
```

That gate already covers these files: `.github/workflows/validate-scripts.yml`
runs a pinned, SHA-256-verified `shellcheck` 0.11.0 over `find . -name "*.sh"`
in the required `validate` job. No new gate was needed and none was added.

Turning on every optional check surfaces 21 notes and nothing else (11 × SC2154,
5 × SC2250, 2 × SC2310, 3 × SC2312):

| Check                                              | Where                                                    | Triage                                                                                                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC2154 (referenced but not assigned)               | `${CURL_RETRY}` in nine fragments, `${PIP_RETRY}` in two | Correct by design: both are Containerfile `ARG`s inherited through the build environment. Under `set -u` an unset one **aborts** the fragment rather than fetching without a retry policy, so the "unassigned" state fails loud. Case 3 below. |
| SC2250 (braces around every variable)              | `install-tools.sh:186-190`                               | Style. Five `${ids[$i]}`-family subscripts in the install loop; the rest of the file uses `${var}`. Not a defect.                                                                                                                              |
| SC2310 (function in a condition disables `set -e`) | `install-tools.sh:210-211`                               | Deliberate: `extract_zip` in a `case` arm whose `\|\| { … fail … }` guard is the whole point — the helper's non-zero status is converted into a named abort, not swallowed.                                                                    |
| SC2312 (masked return value)                       | `install-tools.sh:223`, `:228`, `pyyaml.sh:60`           | The two in `install-tools.sh` are **finding 3** below — the linter saw the shape, not the consequence. `pyyaml.sh:60` is `uname -m` inside an error message on the already-unsupported-architecture arm.                                       |

**Two of the three findings did not come from `shellcheck`**, and the third
(SC2312) is reported by it only as a style note on a line it cannot judge. The
defects are semantic: a line-oriented file format, a symlink that is not a
directory level, and a status nothing reads.

## Findings

| # | Where                            | Class                                                 | Severity | Status                                   |
| - | -------------------------------- | ----------------------------------------------------- | -------- | ---------------------------------------- |
| 1 | `install-tools.sh` env hand-off  | line injection into a `KEY=value` file (CWE-74)       | low      | **Fixed here** (both halves of the line) |
| 2 | `install-tools.sh` `extract_zip` | strip level descends a symlink (CWE-59)               | low      | **Fixed here**                           |
| 3 | `install-tools.sh:221-229`       | `jq` failure masked as a successful install (CWE-755) | low      | **Fixed here**                           |

### 1 — a newline in a `bin` entry, an `env` name or an `env` value writes a second line

`/opt/vibe-tools/environment` is **one `KEY=value` per line**, and
`container/entrypoint.sh:510-534` reads it that way: a `PATH=` line is prepended
to `PATH`, every other line is exported. `install-tools.sh` wrote each line with
`echo`, from a value it had not checked for a newline — so a value carrying one
produced **two** lines, the second indistinguishable from a real one.

Reproduced against the unfixed script with
`env: { "DEMO_HOME": "x\nPATH=/tmp/evil" }`:

```console
$ cat -A prefix/environment
PATH=/tmp/ttest/prefix/demo/bin$
DEMO_HOME=/tmp/ttest/prefix/demo/x$
PATH=/tmp/evil$
```

The third line is outside the install prefix, and the entrypoint prepends it to
`PATH` for the worker and every agent it spawns. That contradicts three places
that state the opposite invariant: `install-tools.sh:41-42` ("no spec can point
PATH or an env var at an arbitrary host path"),
`container_tools_config.ts:26-32` ("the confinement is enforced here"), and
`docs/CONTAINER.md`.

The upstream validator accepted it too — `isConfinedRelativePath` split the
value on `/`, saw `["x\nPATH=", "evil"]`, and returned `true`. Both layers are
fixed: the predicate rejects `\r`/`\n`, and `install-tools.sh` refuses the whole
set before anything downloads.

**Both halves of the line, not just the value.** An `env` **name** is the left
half of the very same line, so a newline there injects a line exactly as a value
does — `{"A\nPATH=/tmp/evil:x": ""}` writes a well-formed `PATH=` line the
entrypoint accepts. The Deno boundary refuses that name already
(`ENV_NAME_PATTERN`, and JavaScript's `$` is end-of-input, so a trailing newline
does not slip past it), but the installer must not depend on the boundary having
run: the check covers `bin` entries, `env` names and `env` values alike.

**Regression tests.**
`install_tools_test.ts::install-tools - a newline in an env value is refused before any download`,
`::install-tools - a newline in a bin entry is refused before any download`,
`::install-tools - a newline in an env NAME is refused before any download` and
`host_path_style_test.ts::isConfinedRelativePath - a newline-bearing value is refused`.
The first three were each observed failing against the code they fix.

### 2 — a zip whose strip level is a symlink copies the link target in

`extract_zip` has no `--strip-components` (unzip offers none), so it descends
one directory level per `stripComponents`, guarded by `[[ -d "${src}" ]]`. That
test **follows** a symlink, and `cp -a "${src}/." "${dest}/"` then copies the
link _target's_ tree rather than the archive's.

Reproduced with a one-entry zip whose single top-level name is a symlink at a
directory outside the archive and `stripComponents: 1`: the outside directory's
contents landed in `<prefix>/<id>` and the installer exited 0. It is a read
escape, not a write escape — `cp` still writes only into `dest` — but it bakes
whatever the build host had at that path into an image layer, and
`tar --strip-components` (the other half of the same feature) never does it.

**Fix.** `[[ -d "${src}" && ! -L "${src}" ]]` — a strip level must be a real
directory. **Regression test.**
`install_tools_test.ts::install-tools - a zip whose strip level is a symlink does not copy the link target in`,
observed failing against the unfixed script (it exited 0 and copied the target
in).

### 3 — a `jq` failure in the environment-recording loops was reported as a success

The two `while IFS= read -r … done < <(jq …)` loops that record the `PATH=` and
`KEY=value` lines observe nothing about `jq`'s status. A `bin` block `jq` cannot
walk — a string where an array belongs — made `jq` exit 5, left the loop with an
empty stream, and the script went on to print `installed demo` and exit **0**:

```console
$ bash install-tools.sh spec2.json ; echo "exit=$?"
jq: error (at spec2.json:1): Cannot iterate over string ("bin")
install-tools: installing 1 tool(s) for amd64: demo
jq: error (at spec2.json:1): Cannot iterate over string ("bin")
install-tools: installed demo -> /tmp/ttest/prefix2/demo
install-tools: installed 1 tool(s): demo
exit=0
$ cat prefix2/environment   # empty — the tool is installed and invisible
```

The image carries a tool nobody can run, and the build is green: the "absence of
a failure marker is not success" shape the coding standards name.

**Fix.** The new whole-set check in finding 1 reads the same `bin`/`env` blocks
through a **command substitution assignment**, so a `jq` that cannot walk them
aborts the build under `set -e` instead of reading as "found no newline" — and
it does so before any download, keeping the no-half-installed-image discipline.
Past that pass, every value the recording loops read is a validated newline-free
string. **Regression test.**
`install_tools_test.ts::install-tools - a bin block jq cannot walk aborts rather than installing a PATH-less tool`.

## The five cases the issue named

| # | Case                                                                                          | Verdict                                                                                                                            |
| - | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Every fetch verifies a manifest SHA-256 before use; a mismatch aborts                         | **Refuted** (no defect) — see below                                                                                                |
| 2 | The `container_tools` spec cannot escape `/opt/vibe-tools/<id>`                               | **Confirmed**, three ways — findings 1, 2 and 3. No issue number: all three are fixed in this change, so none survived to be filed |
| 3 | `TOOLCHAIN_DIR` / `TOOLCHAIN_MANIFEST` / `VIBE_TOOLS_PREFIX` and the unquoted `${CURL_RETRY}` | **Refuted** — see below                                                                                                            |
| 4 | The `python3 -c` bodies in `codespell.sh` / `pyyaml.sh`                                       | **Refuted** — see below                                                                                                            |
| 5 | The toolchain `id` allowlist before `bash "${TOOLCHAIN_DIR}/${id}.sh"`                        | **Refuted** — see below                                                                                                            |

### Case 1 — every fetch is verified, and a mismatch aborts

Twelve `curl` invocations exist across the eleven files — fourteen _fetches_,
because `rust.sh` calls its one `install_rust_pkg` three times, once per
component package. **Every one** is followed, before the bytes are used, by
`echo "${checksum}  ${archive}" | sha256sum -c -` against a pin the fragment
read from `container/tools.json` with `jq -er`, or — in `install-tools.sh` — by
`echo "${sha}  ${archive}" | sha256sum -c -` against the spec's digest, whose
mismatch path names the tool and aborts. There is no unverified fetch and no
`|| true` on any verification.

Two consequences of `jq -er` are load-bearing and hold: `-e` makes a **missing**
pin exit non-zero, and every checksum is read in **assignment** position, where
`set -e` catches it. `rust.sh:85-92` resolves all three component digests as
standalone assignments precisely because a command substitution in _argument_
position would not, and says so in a comment. The two scripts that `bash` an
installer out of an archive (`bats-core.sh:57`, `rust.sh:81`) run it only after
that archive has been verified.

### Case 2 — the extraction paths

The `environment` half is findings 1 and 3. The extraction half:

- **`tar` is not a traversal sink.** GNU tar 1.35 refuses a `..` member
  (`Member name contains '..'`, exit 2) and refuses to write through a symlinked
  parent (`Cannot open: Not a directory`, exit 2). Both were executed. The
  non-zero status reaches `install-tools.sh`'s `|| { rm -rf "${tmp}"; fail … }`,
  so a hostile archive aborts the build rather than escaping. `--no-same-owner`
  is passed on both tar paths.
- **`unzip` is not a traversal sink either.** UnZip 6.00 strips a leading `/`
  and flattens `../`, so both land _inside_ the destination — and the strip
  warning it emits exits 1, which `extract_zip` turns into `extraction failed`.
  Executed.
- **`stripComponents` cannot be used as a path.** It is validated `^[0-9]+$`
  before use and is only ever a loop bound or a `--strip-components` value.
- **The `id` cannot escape.** `^[a-z][a-z0-9-]*$` admits no `/` and no `.`, so
  `${TOOLS_PREFIX}/${id}` is always one level under the prefix.
- **An `=` inside a value is not a second vector — empty.**
  `container/entrypoint.sh:517-521` splits each line at the **first** `=`, so
  `KEY=<prefix>/a=b` yields the key `KEY` and the value `<prefix>/a=b`: the
  extra `=` stays inside the value and the path stays inside the prefix. A `bin`
  entry behaves the same way, because its line is `PATH=` plus a path. The issue
  named this vector alongside the newline; it is stated here rather than left to
  be inferred from the newline finding.
- **What survived was the symlinked strip level** — finding 2.

**Accepted residual: extraction preserves the archive's file modes.** The build
runs as root, so `tar -xzf` restores setuid and setgid bits from a
deployer-supplied archive, where the fragments all use an explicit
`install -m 0755`. It is not a privilege boundary: the same operator supplies
the archive, its digest and the Containerfile, and can put anything in the image
directly. Recorded so a future reader does not have to re-derive it.

### Case 3 — the environment overrides and the unquoted `${CURL_RETRY}`

- `TOOLCHAIN_DIR` and `TOOLCHAIN_MANIFEST` default to `/tmp/toolchains` and
  `/tmp/tools.json`, and the Containerfile sets `TOOLCHAIN_MANIFEST` to a fixed
  path on the same command line as the script it runs. `VIBE_TOOLS_PREFIX` and
  `VIBE_BUILD_ARCH` exist for the tests, which is why the suite can drive the
  real script against local fixtures. All four are build-time environment: an
  attacker who can set them already controls the build.
- **`${CURL_RETRY}` is never operator-supplied.** It is a Containerfile `ARG`
  with a literal default, and `worker/deno/lib/container_launch.ts:1270-1300`
  passes exactly two `--build-arg`s — `VIBE_CONTAINER_TOOLS` and
  `AGENT_PROVIDERS` — never this one. `container_manifest.ts:1491-1505` fails
  the gate if the `ARG` goes missing or loses its `--retry`. The deliberate lack
  of quotes word-splits a fixed flag list; under `set -u` an unset value aborts
  the fragment.
- **`VIBE_CONTAINER_TOOLS` is not re-parsed as code.** The launcher passes it as
  one `--build-arg` argv element (no shell), and the Containerfile writes it
  with `printf '%s' "${VIBE_CONTAINER_TOOLS}" > "${spec}"` — quoted, one
  expansion, straight to a file that is then read by `jq`.

### Case 4 — the `python3 -c` bodies

- **`codespell.sh` interpolates nothing into `python3`.** Its two `python3`
  invocations are `-m venv` and the pinned wheel's own `pip` entry point; there
  is no `python3 -c` carrying a manifest field at all. The premise is refuted,
  not just the risk.
- **`pyyaml.sh` does interpolate, and validates first.** `.modules[]` and
  `.versionModule` reach `python3 -c "import ${module}"` and
  `"import ${m}; print(${m}.__version__)"` — and `:91-96` rejects any name not
  matching `^[A-Za-z_][A-Za-z0-9_]*$`, the version module included, before the
  first use. A name with a quote, a semicolon, a newline or a dot cannot reach
  the interpreter. The other two interpolations (`tag`, `site`) come from the
  running interpreter, never from the manifest.

### Case 5 — the toolchain id allowlist

`install-toolchains.sh:96-116` validates the **whole set** before running
anything: the id matches `^[a-z][a-z0-9-]*$` (no `/`, no `.`, so
`${TOOLCHAIN_DIR}/${id}.sh` cannot leave the directory), duplicates are refused,
`-f "${TOOLCHAIN_DIR}/${id}.sh"` must exist, and the manifest must pin the id
_with a fragment_ — the last of which is why an id that is a real file but an
unpinned one still aborts. Only then does `:125-131` run each fragment, and a
fragment's non-zero status is named and re-raised rather than swallowed. The
comma split (`IFS=',' read -r -a ids`) keeps empty entries so `a,,b` is rejected
rather than silently collapsed, and the one `|| true` on that `read` is
documented and backed by the empty-set check two lines below.

## Categories the issue named that came back empty

Each was looked for and not found. Stated explicitly, because an unstated empty
category is indistinguishable from one that was skipped.

- **`eval`, `source` of a computed path, and dynamic dispatch — empty.** There
  is no `eval`, no `.`/`source`, and no indirect expansion (`${!var}`,
  `printf -v`) anywhere in the eleven files. The only dynamic dispatch is
  `bash "${TOOLCHAIN_DIR}/${id}.sh"`, case 5 above.
- **`curl | sh` — empty.** No fetch is piped to an interpreter. Every download
  lands in a `mktemp -d` file, is verified, and only then is read.
- **Secrets on command lines or in the environment — empty.** No token, key or
  credential is read, written or passed by any of the eleven files. The only
  environment values they touch are the retry policies, the manifest path, the
  prefix and the build architecture.
- **Word splitting and globbing — empty except where it is the design.** Every
  path, id, version, URL, checksum and prefix is quoted at every expansion. The
  two deliberate unquoted expansions are `${CURL_RETRY}` / `${PIP_RETRY}` (case
  3), each carrying a `# shellcheck disable=SC2086` naming the reason.
  `install-toolchains.sh:91` uses the bash-3.2 empty-array idiom
  `${ids[@]+"${ids[@]}"}`, whose alternate value is itself quoted.
- **`set -euo pipefail` — present on all eleven, none relaxed.** Line 39 of
  `install-tools.sh`, line 26 of `install-toolchains.sh`, and an early line of
  every fragment. There is no `set +e` window and no `|| true` other than the
  documented one in case 5.
- **Destructive `rm` — no unguarded recursive removal.** Every `rm -rf` in the
  eleven files removes either a `mktemp -d` the script created in the same
  function or a constant path. `rust.sh:82` is the one composed removal, and it
  spells the base `${workdir:?}` so an empty value aborts instead of widening.
  The fragments' `trap 'rm -rf "${workdir}"' EXIT` handlers each remove a
  variable assigned on the line above the trap.
- **Verification that can be skipped — empty.** Every `sha256sum -c -` is a
  standalone command under `set -e`, none is `|| true`-ed, and none is inside a
  condition that would disable `set -e`.
- **Half-installed image on a bad set — empty.** Both drivers validate the whole
  set before installing anything, and the tests assert the prefix is untouched
  after a rejection.

## Observations that are not findings

- **`codegraph.sh` is not in this sweep's tree.** Read at
  `origin/milestone/2145-…` tip: it follows the same fetch–verify–extract shape
  as its siblings (pinned version and per-architecture digest from the manifest,
  `sha256sum -c -` before use, a version assertion after), and its one
  `rm -rf "${BUNDLE}"` targets a constant `/opt/codegraph`, not an interpolated
  path. Nothing in it needs a finding, but it is **not swept** by this record:
  when #2145 merges, the fragment lands on the default branch and should be read
  there.
- **`bats-core.sh` pins a GitHub auto-generated source tarball.** Those are not
  byte-stable by contract — GitHub has changed their compression before. The
  consequence here is a **loud** build failure at `sha256sum -c -`, never an
  unverified install, so it is a reproducibility risk rather than a security
  one.
- **`pip` is not passed `--no-index`** in `codespell.sh` or `pyyaml.sh`. Both
  install a local, digest-verified wheel with `--no-deps --only-binary=:all:`,
  so no index is consulted and nothing unpinned can enter; the flag would
  restate that rather than change it.
- **`install-tools.sh` still does not validate the _shape_ of an `env` name.**
  Its newline is refused (finding 1), but a name that is newline-free and not a
  POSIX identifier — `1TOOL`, say — reaches the hand-off file and is refused by
  `container/entrypoint.sh:522-525`, which aborts the container loudly. The
  shape is validated at the Deno trust boundary (`ENV_NAME_PATTERN`) on the
  fleet path, so the remaining window is a hand-run script producing an image
  that fails at first start rather than at build — loud in both places, just
  later than ideal.
- **The build-arg value is recorded in image history.** `VIBE_CONTAINER_TOOLS`
  carries ids, URLs and digests — no credential — so this is a visibility note,
  not an exposure.
- **The fragments are removed only by the Rust layer.** `Containerfile:220`
  removes `/tmp/toolchains`, the driver and the manifest after the `rust` run;
  between the two toolchain layers they sit in `/tmp` inside intermediate
  layers. They are committed repository files, so nothing is disclosed.
