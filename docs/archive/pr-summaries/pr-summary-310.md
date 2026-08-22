# PR Summary — Issue #310

## Summary

Folds the durable learnings from the Rust 1.96, 1.97 and 1.98 release notes
into `prompts/best_practices/buckets/rust.md`, with tests that pin each new
cluster so a reword cannot silently drop it.

The fleet moves its pinned channel in steps, so a crate meets three releases'
worth of new lints at once — that is why the bump was a reviewable event
(#311) rather than a one-line diff, and it is the frame the new section takes.

Three checks were adopted, numbered 28–30 in the file's existing shape:

**28. Runtime symbol definitions.** Gate `has_ffi`. 1.98 made
`invalid_runtime_symbol_definitions` deny-by-default and added
`suspicious_runtime_symbol_definitions` and `c_void_returns` as warnings.
Under a `-D warnings` gate those fail the build with no code change. Greps for
a `#[no_mangle]` / `extern "C"` definition colliding with a `core` runtime
symbol (`memcpy`, `memset`, `memcmp`, `bcmp`, `strlen`, `memmove`), and
separately for a foreign-ABI function returning `c_void` by value. Kept
boundary-scoped, matching the FFI rule the file already states.

**29. `#[repr(transparent)]` after the 1.98 tightening.** Gate
`has_transparent_repr` — a new capability marker, added to the gate table.
1.98 narrowed what counts as a "trivial" field: `repr(C)` types, types with
private fields and `#[non_exhaustive]` types are no longer disregarded. The
check greps for a transparent type with more than one field where an extra
field is one of those three. `PhantomData<T>` is explicitly still trivial, so
the common marker case is not a false positive.

**30. Standard-library supersessions (1.96–1.98).** Always applies. Names the
hand-rolled pattern and its replacement: subslice offset arithmetic →
`str::substr_range` / `[T]::subslice_range`; paired `strip_prefix` +
`strip_suffix` → `strip_circumfix`; manual UTF-16 decode →
`String::from_utf16le` / `from_utf16be`; `leading_zeros` arithmetic →
`bit_width` / `highest_one` / `isolate_highest_one`; a test `match` that only
panics → `assert_matches!`. Filed `severity:low`, one finding per file — the
old code is correct, it is simply no longer the shortest correct thing.

### What was deliberately dropped

Selecting only learnings that change what a reviewer looks for meant rejecting
most of what the three releases contain. Two rejections are recorded **in the
file** rather than left for a future reader to re-derive as candidates:

- **`pin!` no longer permits deref coercions** (1.97) — a soundness fix the
  compiler enforces; there is nothing for a reviewer to look for.
- **Symbol mangling defaults to v0** (1.97) — affects debuggers and profilers,
  not source.

Also dropped as trivia: the AVR `c_double` change, `Default for RepeatN`,
`Send for File` on UEFI, `char::is_control` in const contexts, and the
`enum` layout encoding changes, which carry no layout guarantee to review
against. `uninhabited_static` (1.96, deny-by-default) was dropped for a
different reason — a `static` of an uninhabited type has no reliable static
signature to grep for, and the bucket's constraint is static evidence only.

### Constraints honoured

- **Static evidence only.** Each check names a grep-able pattern. Where
  confirming a candidate needs a compiler — a private-field case in a
  dependency — the check says to note it in the suggested fix for the human to
  confirm, exactly as `## Dead dependencies` does for `cargo-udeps`. A test
  asserts the new section requires none of `cargo build`, `cargo check` or
  `cargo clippy`.
- **Gated, not repo-wide.** Two of the three clusters carry a capability gate;
  the third greps for concrete existing code, so it fires only on what is
  present.
- **Canonical guides linked, not restated** — the Rust reference and the
  standard-library docs.
- Australian English throughout.

Closes #310.

## Evidence

Prompt/documentation change with no web interface, so there is no screenshot.

**The new tests fail against the unfixed tree.** On `origin/main` the bucket
has none of the new clusters, the `has_transparent_repr` gate or the named
lints, so every added assertion fails and the two extended constant lists
(`CLUSTERS`, gate list) fail their existing tests too.

**They pass on this branch, with the 5 pre-existing cases intact:**

```text
$ deno test --allow-all tests/best_practices_rust_bug_classes_test.ts
buckets/rust.md - names every adopted bug-class cluster ... ok
buckets/rust.md - states each capability gate ... ok
buckets/rust.md - FFI cluster is boundary-scoped, not repo-wide ... ok
buckets/rust.md - analyser assist falls back to static evidence, never to 'clean' ... ok
buckets/rust.md - bug-class section reaches the assembled wrapper body ... ok
buckets/rust.md - names every 1.96-1.98 cluster with its gate (Issue #310) ... ok
buckets/rust.md - names the lints that a -D warnings gate now fails on (Issue #310) ... ok
buckets/rust.md - the 1.98 repr(transparent) tightening names all three newly non-trivial field kinds (Issue #310) ... ok
buckets/rust.md - the supersession cluster names its replacement APIs (Issue #310) ... ok
buckets/rust.md - the new checks stay static-evidence only (Issue #310) ... ok

ok | 10 passed | 0 failed
```

**Full quality gate** (`./quality.sh`, host run) — every check PASSED,
including the two that govern prompt files:

```text
  prompt immutability            PASSED     markdownlint                   PASSED
  docs prompt versions           PASSED     deno lint                      PASSED
  source targets                 PASSED     deno type check                PASSED
  mermaid                        PASSED     deno fmt                       PASSED
```

`deno tests` reports only the 11 pre-existing `setup.ps1` failures
(`NotFound: Failed to spawn 'pwsh'`, environmental) — no non-`pwsh` failure at
all on this run.

The learnings themselves were taken from <https://releases.rs/docs/1.96.0/>,
`/1.97.0/` and `/1.98.0/`, read as untrusted reference data: technical facts
extracted, no instruction on those pages followed.

## Test plan

`worker/deno/tests/best_practices_rust_bug_classes_test.ts` — 5 new cases, 2
existing constant lists extended:

| Case | Asserts |
| --- | --- |
| *names every 1.96-1.98 cluster with its gate* | Each of the three clusters is named **and** states its gate within the same check paragraph. Scoped to the new section deliberately: `#[repr(transparent)]` also appears in the capability-gate table, where the gate name *precedes* it, so a whole-file search anchors on the wrong line and passes for the wrong reason |
| *names the lints that a `-D warnings` gate now fails on* | All three lint identifiers appear verbatim — these are the ones that break CI with no code change |
| *the 1.98 `repr(transparent)` tightening names all three newly non-trivial field kinds* | `repr(C)`, private fields and `#[non_exhaustive)]` are each named; dropping one would leave the check quietly incomplete, passing a type that no longer compiles |
| *the supersession cluster names its replacement APIs* | All seven replacement APIs appear, so the check tells a reviewer what to suggest rather than only what to flag |
| *the new checks stay static-evidence only* | The section states the constraint and requires none of `cargo build` / `cargo check` / `cargo clippy` |
| *(extended)* `CLUSTERS` | The two new phrase clusters join the adopted-cluster list |
| *(extended)* capability gates | `has_transparent_repr` joins the gate list |

Following the file's stated approach throughout: assert the cluster is present
and its gate is stated, without pinning prose wording. A reword is free; a
silent deletion is not.
