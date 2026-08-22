# Bucket: `rust`

Canonical guides — link, do not restate:

- The Rust Book — <https://doc.rust-lang.org/book/>
- Rust API Guidelines — <https://rust-lang.github.io/api-guidelines/>
- The Rustonomicon (for `unsafe`) — <https://doc.rust-lang.org/nomicon/>

Apply these checks to `*.rs` files, `Cargo.toml`, and `.cargo/config.toml`
(the build-profile checks below read the last one) only.

## Checks

1. **Error handling discipline.** Prefer `?` propagation and `Result`
   over `unwrap()` / `expect()` outside tests, examples, and clearly
   unreachable branches. Flag library code that panics on user input
   or external I/O.
2. **Ownership and lifetimes idioms.** Flag unnecessary `clone()` on
   hot paths, redundant `to_string()`/`String::from(...)` when a
   `&str` would suffice, and lifetime annotations that the compiler
   could elide. Suggest borrowing where ownership is not required.
3. **`unsafe` usage is justified.** Every `unsafe` block carries a
   `// SAFETY:` comment that names the invariants the caller must
   uphold. Flag bare `unsafe` blocks without a safety comment.
4. **`Cargo.toml` hygiene.** Workspace metadata is present
   (`description`, `license`, `repository`, `edition`); dependencies
   are pinned to compatible ranges (avoid `*` and bare git refs in
   release crates); `[features]` defaults are minimal; unused
   dependencies are removed.
5. **Doc comments on public API.** Every `pub` item exported from the
   crate root carries a `///` doc comment with at least a one-line
   summary; constructors and non-trivial functions show a `# Examples`
   block. Follow the Rust API Guidelines C-EXAMPLE / C-FAILURE rules.
6. **Lint posture.** The crate root has `#![deny(warnings)]` (or
   per-lint denies such as `unsafe_op_in_unsafe_fn`,
   `missing_docs` on libraries). Flag missing `#![deny(...)]` on
   library crates.
7. **Naming conventions.** Types use `UpperCamelCase`, functions and
   modules use `snake_case`, constants use `SCREAMING_SNAKE_CASE`.
   Flag deviations on `pub` items only.
8. **`Result` / `Option` ergonomics.** Use combinator chains
   (`.map`, `.and_then`, `.ok_or`) over verbose match-and-rewrap;
   prefer `?` to early returns. Custom error types use `thiserror`
   or hand-rolled `impl std::error::Error`; binaries may use
   `anyhow::Result` for ergonomics.

## Dead dependencies

A "dead dependency" is a crate declared in `Cargo.toml` that no
source file references via `use` or `extern crate`. Dead deps inflate
build time and supply-chain risk and should be removed.

**Hard constraint — static evidence only.** This check greps the
source tree for `use` and `extern crate` references. The scanner
**does not** invoke `cargo build`, `cargo check`, `cargo test`,
`cargo-udeps`, or any other build/test command. `cargo-udeps` is the
canonical production-grade tool for the same job — note it in the
suggested fix so the human can run it for confirmation, but the
bucket check itself is read-only.

9. **Declared crate with no `use` / `extern crate` reference.**
   Inspect every dependency table in `Cargo.toml`:
   - `[dependencies]`
   - `[dev-dependencies]` (search `tests/`, `benches/`, `examples/`
     and `#[cfg(test)]` modules under `src/`)
   - `[build-dependencies]` (search `build.rs`)
   - target-specific tables (`[target.<cfg>.dependencies]`, etc.)

   For each declared crate, grep `*.rs` under `src/`, `tests/`,
   `benches/`, `examples/`, and `build.rs` for a real reference:
   - `use <crate>::…`
   - `use <crate>;`
   - `extern crate <crate>;`
   - fully-qualified `::<crate>::…` paths
   - macro re-exports (`<crate>::some_macro!`)

   Honour the Cargo rename rule: a dep declared as
   `serde_renamed = { package = "serde", … }` is referenced in source
   as `serde_renamed`, not `serde` — match the alias name.

   Cite the offending `Cargo.toml` line range (e.g.
   `Cargo.toml:42-44`). Suggested fix: drop the entry from
   `Cargo.toml` and run `cargo update` to refresh `Cargo.lock`, then
   re-run `cargo-udeps` locally to confirm. File at `severity:low`
   (hygiene); bump to `severity:medium` only if the dead crate is
   itself known-vulnerable.

## Bug-class checks

The checks below are grouped into the bug-class clusters that recur
across the RustSec Advisory Database (~1,078 advisories: memory
corruption, unsound safe APIs, denial of service, thread safety).
They are restated here in our own words, adapted to this scan — no
external review plugin is vendored, installed, or invoked.

### How to apply them

**Gate first, then check.** Every cluster names the code pattern that
makes it applicable. Evaluate the gates once per run with a grep over
the crate, then apply only the clusters whose gate holds. A cluster
whose gate does not hold produces zero findings — never speculate
about code that is not in the tree.

| Gate | Holds when the crate contains |
|---|---|
| `has_unsafe` | `unsafe` blocks, `unsafe fn`, `unsafe impl` |
| `has_ffi` | `extern "C"`, `extern` blocks, `#[no_mangle]`, `libc::`, generated bindings |
| `has_concurrency` | `std::thread`, `Arc`, `Mutex`, `RwLock`, `atomic`, `rayon`, `crossbeam` |
| `has_async` | `async fn`, `.await`, `tokio`, `futures` |
| `has_packed_repr` | `#[repr(packed)]` |
| `has_fs_io` | `std::fs`, `Path`/`PathBuf` joins, `File::open` / `File::create` |
| `has_transparent_repr` | `#[repr(transparent)]` on a struct or newtype |

**FFI checks are boundary-scoped, never repo-wide.** Apply the FFI
cluster only to the functions that actually cross the boundary —
items inside an `extern` block, functions declared `extern "C"` (or
another foreign ABI), `#[no_mangle]` exports, and the Rust helpers
those items call directly. A safe internal function is not an FFI
function merely because the crate links a C library somewhere.

**Tooling assist.** Where this checkout builds offline, you MAY run
`cargo clippy` and `cargo check` read-only to corroborate a
candidate. They are corroboration, not evidence: every finding still
cites the file and line range that demonstrates the concern. When the
toolchain or the crate registry cache is unavailable the command will
fail — record that it could not run, fall back to grep/read static
evidence, and never treat a failed or skipped analyser run as a clean
result. Do not run `cargo run`, `cargo test`, `cargo build`, or any
command that executes repo logic. The dead-dependency check above is
deliberately stricter and stays static-evidence only.

**Severity guidance.** Memory-safety violations, data races, and
undefined behaviour reachable from untrusted input are
`severity:high`; the same defect reachable only from trusted,
in-process callers is `severity:medium`. Panic-, recursion-, and
resource-exhaustion denial of service is `severity:high` when the
triggering value is attacker-shaped, otherwise `severity:medium`.
Correctness and hygiene concerns with no reachable failure are
`severity:low`.

**File at the most specific class.** When one site matches several
clusters, file the narrowest class once — one finding per root cause,
listing the other call sites in the body — rather than one finding
per cluster.

### Checks

10. **Unsafe boundary.** Gate: `has_unsafe`, or the crate contains
    `transmute`, raw-pointer casts, or `#[repr(C)]` types. Review the
    safe API that *reaches* the `unsafe` code, not just the block:
    can a caller passing ordinary safe values violate the invariant?
    Also flag `mem::transmute` where a checked conversion exists,
    pointer casts through `as` that change alignment or provenance,
    raw-pointer arithmetic without a bound, `#[repr(C)]` types whose
    field layout must match a foreign definition, invalid enum
    discriminants produced by casting or transmuting, and safety
    invariants enforced only by `debug_assert!` (compiled out in
    release). Missing `// SAFETY:` comments belong to check 3 — do not
    file both.
11. **Memory safety inside `unsafe`.** Gate: `has_unsafe`. Look for
    reads of uninitialised memory (`MaybeUninit::assume_init` before
    every field is written), `Vec::set_len` beyond the initialised
    slots, use-after-free through a raw pointer that outlives its
    owner, double free via `ptr::read` on a value that is still
    dropped, invalid free from assigning over uninitialised memory,
    buffer overflow where a safe index or length flows unchecked into
    an unsafe copy, union fields read as the wrong variant, and
    containers left in a broken state when a user callback panics
    mid-way through an unsafe operation.
12. **Panic-driven denial of service.** Always applies. Flag
    `unwrap()` / `expect()` on values derived from untrusted input
    (network, files, environment, CLI), unbounded allocation driven by
    an attacker-supplied length or count, arithmetic that overflows in
    release builds, reachable `assert!` / `unreachable!` /
    `panic!`, slice indexing that can exceed the length, `&s[i..j]`
    string slicing that can land off a UTF-8 character boundary, and
    `RefCell` borrows that can collide at runtime. Check 1 covers the
    style rule; file here when a concrete untrusted input reaches the
    panic.
13. **Recursion and stack-overflow denial of service.** Always
    applies where a recursive type, a derived `Deserialize`, or a
    recursive `Display`/`Debug`/`Serialize` exists. A stack overflow
    aborts the process — it cannot be caught like a panic. Flag
    deserialisation of attacker-shaped nested input without a depth
    limit, recursive formatting or serialisation over user-shaped
    values, and implicit `Drop` of long linked structures
    (`Box<Self>` chains) with no iterative drop.
14. **Error-handling flow.** Always applies. Flag discarded results
    (`let _ = fallible()`), panics reachable inside an `impl Drop`,
    lossy numeric `as` / `From` / `Into` narrowing, lossy string
    conversions (`from_utf8_lossy`, `to_string_lossy`,
    `to_str().unwrap_or(...)`) that silently corrupt paths or OS
    strings, and a `BufWriter` dropped without an explicit `flush()`
    so write errors are swallowed.
15. **Logic correctness.** Always applies. Flag `Ord` / `PartialOrd` /
    `Eq` / `Hash` implementations that disagree with each other,
    NaN/infinity edge cases in float comparison and sorting,
    case-insensitive or prefix string comparison used as a security
    decision, `serialize_struct` field counts that disagree with the
    fields written, nondeterminism (hash-map iteration order, system
    time, RNG) in state that must be reproducible, and mutation of a
    key already inserted in a `HashMap` / `HashSet` / `BTreeMap`.
    Where `has_unsafe` also holds, add hostile generic trait
    implementations and user closures that can panic across unsafe
    scaffolding.
16. **Concurrency — locking.** Gate: `has_concurrency`. Flag a second
    lock of a `Mutex`/`RwLock` still held in the same lexical scope,
    two locks acquired in opposite orders on different paths (ABBA),
    a `Condvar` wait with no reachable notifier or without a
    predicate loop, unbounded channels or a receiver that can starve,
    reentrant `Once::call_once`, and reentrancy through signal
    handlers or callbacks.
17. **Concurrency — data races.** Gate: `has_concurrency`. Flag
    sequences of atomic operations that are individually atomic but
    not atomic as a group (load-then-store where
    `compare_exchange`/`fetch_update` is required), memory orderings
    weaker than the invariant needs, missing `Send`/`Sync` bounds on
    generic parameters shared across threads, and races on
    shared-memory or memory-mapped regions. Where `has_unsafe` also
    holds, add `unsafe impl Sync`/`Send` over interior mutability and
    unsynchronised access to `static mut`.
18. **Async-runtime hazards.** Gate: `has_async`. Flag blocking calls
    on an async executor (`std::fs`, `std::net`, `thread::sleep`,
    `std::sync::Mutex` held across `.await`, blocking `recv()`)
    without `spawn_blocking` / `block_in_place`, `.await` sequences
    that leave state inconsistent if the future is cancelled (a
    dropped `select!` branch or aborted task), and `tokio::select!`
    branch bias where one branch can starve another.
19. **FFI boundary.** Gate: `has_ffi`, applied only to the boundary
    items described above. Flag `CString::as_ptr` on a temporary that
    dangles before use, Rust signatures that disagree with the foreign
    declaration (types, ABI, nullability, variadics), `#[repr(C)]`
    padding bytes copied across the boundary and leaking uninitialised
    memory, opaque pointers whose ownership rules are undocumented or
    inconsistent, memory freed by an allocator other than the one that
    allocated it, Rust closures called from `extern "C"` code without
    `catch_unwind` (unwinding across the boundary is undefined
    behaviour), and `dyn Trait` fat pointers passed as a single
    pointer-width value.
20. **Type-layout safety.** Gate: `has_packed_repr`. Taking a
    reference to a field of a `#[repr(packed)]` struct — including the
    implicit borrows behind method calls, `format!` arguments, and
    `derive`d implementations — creates an unaligned reference, which
    is undefined behaviour. Suggest a copy into a local, or
    `addr_of!` / `read_unaligned`.
21. **Path and filesystem safety.** Gate: `has_fs_io`. Flag
    `Path::join` / `PathBuf::push` with an attacker-controlled
    component (an absolute component silently replaces the base; `..`
    escapes it) without canonicalisation and a prefix check, and
    time-of-check-to-time-of-use races where `exists()` / `metadata()`
    / `symlink_metadata()` is followed by an open or write on the same
    path.
22. **Resource and destructor handling.** Always applies. Flag raw
    file descriptors and handles that can be closed twice or leaked
    (`from_raw_fd` without ownership transfer, `into_raw_fd` with no
    later close), and destructors that perform security-relevant
    cleanup (zeroing secrets, closing connections, rolling back
    transactions) skipped via `mem::forget`, `ManuallyDrop`, or
    `process::exit`.
23. **Pointer and address exposure.** Always applies. Flag raw
    addresses reaching logs, error strings, API responses, or
    serialised output (`{:p}` formats, `ptr as usize`,
    `expose_provenance`) — a leaked address defeats ASLR for a
    subsequent memory-corruption attempt.
24. **Static hygiene beyond checks 4 and 6.** Always applies. Flag a
    declared `rust-version` (MSRV) that the code contradicts by using
    newer language or standard-library features, deprecated APIs still
    in use (`mem::uninitialized`, `mem::zeroed` for types with
    invalid zero states), and a missing `[lints]` table / `clippy.toml`
    where the crate relies on ad-hoc `#[allow(...)]` attributes
    instead. Do not re-file the lint-posture concern from check 6.

## Build profiles — fast dev builds, optimised release builds

Two build principles apply to every Rust repo: a **development**
build compiles as fast as possible (less-optimised output is fine),
and a **release** build produces the fastest possible artefact
however long it takes to compile.

**Where the settings live.** Cargo reads `[profile.*]` from the
**workspace root** manifest only — a `[profile.*]` table in a member
crate is ignored — and a library's own profile never reaches its
**consumers**, so the binary crate being built carries the settings.
File these findings against the workspace root `Cargo.toml`, or
against the single crate's own manifest when there is no workspace.

**Stable Rust only.** Never recommend a nightly toolchain: the
parallel compiler front-end (`-Zthreads`) and the Cranelift codegen
backend are nightly-only, so both are out of scope, and a finding
asking for either is not to be filed.

**Severity and grouping.** These are build-configuration concerns
with no reachable runtime failure — file at `severity:low`, one
finding per manifest listing every missing setting, never one
finding per key.

### Checks

25. **Dev profile is tuned for compile speed.** Flag a workspace
    root manifest with no `[profile.dev]` `debug = "line-tables-only"`.
    The default `debug = true` emits full debug info, which is the
    largest single cost in a dev rebuild; line tables still name the
    file and line that panicked, which is enough without a debugger
    session. Also flag settings that slow dev builds with no written
    justification — `opt-level` above `0`, any `lto`,
    `codegen-units = 1`, or `incremental = false` under
    `[profile.dev]`. The default `opt-level = 0` and incremental
    compilation stay. Where the repo documents that it needs full
    debug info (a debugger workflow in `CONTRIBUTING.md` or the agent
    instructions), Phase 0's convention rule wins — drop the
    candidate.
26. **Release profile is fully optimised.** Flag a workspace root
    `[profile.release]` missing any of `opt-level = 3`,
    `lto = "fat"`, or `codegen-units = 1`, citing the manifest line
    range. `lto = true` is fat LTO under another spelling and passes;
    `lto = "thin"` and the default `false` do not. `codegen-units`
    defaults to `16` in release, which caps cross-unit inlining —
    `1` is the setting that makes LTO worth its compile time. Do not
    extend this check to `panic = "abort"`, `strip`, or
    `debug = false`: they change behaviour or debuggability and are
    not part of this policy.
27. **`-C target-cpu=native` on same-host binaries.** Gate: the crate
    builds a binary (`[[bin]]` or `src/main.rs`) that runs on the
    machine that compiled it. Stable Cargo has no per-profile
    rustflags, so the flag belongs in a target-scoped
    `.cargo/config.toml`:

    ```toml
    [target.x86_64-unknown-linux-gnu]
    rustflags = ["-C", "target-cpu=native"]
    ```

    or in the build invocation's `RUSTFLAGS`. Say which one the fix
    uses — `RUSTFLAGS` **replaces** the config `rustflags` rather
    than appending to it, so a repo setting both silently loses the
    config entry. Never file this against a published crate, a
    library consumed elsewhere, a `wasm32` target, or any artefact
    copied to another machine: a binary built with `target-cpu=native`
    dies with an illegal-instruction fault on a CPU that lacks the
    instructions it was compiled for.

Profile-guided optimisation (`-Cprofile-generate` / `-Cprofile-use`)
is the next lever after these three, and is a per-repo opt-in — do
not file a missing-PGO finding.

## Toolchain 1.96–1.98 learnings

The fleet pins a concrete Rust channel and moves it in steps, so a
crate can meet three releases' worth of new lints at once. These
checks cover what changed across 1.96, 1.97 and 1.98 that alters what
a reviewer should *look for* — not release trivia.

Two of the three are about lints that are **deny-by-default or
warn-by-default**. Under a `-D warnings` gate those fail the build with
no code change, which is the whole reason a toolchain bump is a
reviewable event rather than a one-line diff.

**Static evidence only**, as everywhere in this bucket: each check
below names a grep-able pattern. Where confirming a candidate needs a
compiler, say so in the suggested fix and let the human confirm —
the same discipline the `## Dead dependencies` section uses for
`cargo-udeps`. Link to the
[Rust reference](https://doc.rust-lang.org/reference/) and the
[standard library docs](https://doc.rust-lang.org/std/) rather than
restating them.

### Checks

28. **Runtime symbol definitions.** Gate: `has_ffi`. Rust 1.98 made
    `invalid_runtime_symbol_definitions` **deny-by-default** and added
    `suspicious_runtime_symbol_definitions` and `c_void_returns` as
    warnings. Flag a `#[no_mangle]` / `#[unsafe(no_mangle)]` or
    `extern "C"` definition whose symbol name collides with a `core`
    runtime symbol — `memcpy`, `memmove`, `memset`, `memcmp`, `bcmp`,
    `strlen` — because the compiler now refuses it rather than
    quietly letting a crate replace the runtime out from under
    `core`. Flag separately a foreign-ABI function returning
    `core::ffi::c_void` (or `libc::c_void`) **by value**: `c_void` is
    not an inhabited value type, so the signature never described
    something callable. Both are boundary-scoped like every FFI check
    here — a safe internal helper is not in scope merely because the
    crate links a C library.
29. **`#[repr(transparent)]` after the 1.98 tightening.** Gate:
    `has_transparent_repr`. `repr(transparent)` requires at most one
    field with a non-trivial size or alignment; 1.98 narrowed what
    counts as trivial. A field whose type is `#[repr(C)]`, has
    private fields, or is `#[non_exhaustive]` is **no longer**
    disregarded. Flag a `#[repr(transparent)]` type carrying more
    than one field where any additional field is one of those three —
    it compiled before and does not now, and the fix is a decision
    (drop the field, drop the attribute, or make the wrapper genuinely
    single-field) rather than a rename. A zero-sized marker such as
    `PhantomData<T>` is still trivial and is not a finding. Confirming
    a private-field case can need the defining crate, so where the
    type comes from a dependency, say so in the suggested fix and let
    the human confirm.
30. **Standard-library supersessions (1.96–1.98).** Always applies.
    Flag a hand-rolled implementation of something these releases
    stabilised, citing the site and naming the replacement:
    offset arithmetic to locate a subslice within its parent, where
    `str::substr_range` / `[T]::subslice_range` now answer directly
    (1.98); a paired `strip_prefix` and `strip_suffix` doing one
    logical strip, now `strip_circumfix` (1.98); a manual UTF-16
    decode loop, now `String::from_utf16le` / `from_utf16be` and their
    lossy variants (1.98); bit-width or highest-set-bit computed from
    `leading_zeros`, now `bit_width`, `highest_one` and
    `isolate_highest_one` on the integer primitives and
    `NonZero<{integer}>` (1.97); and, in tests, a `match` whose only
    purpose is to panic on the non-matching arm, now `assert_matches!`
    (1.96). Also flag use of the `std::char` free functions and
    constants deprecated in 1.97 — the associated items on `char`
    replace them. These are `severity:low` hygiene findings: the old
    code is correct, it is simply no longer the shortest correct
    thing. Do not file one per call site — one finding per file,
    listing the sites.

`pin!` no longer permits deref coercions (1.97) and symbol mangling
defaults to the v0 scheme (1.97). Neither is a review check: the first
is a soundness fix the compiler enforces, and the second affects
debuggers and profilers rather than source. They are noted here so a
future reader does not re-derive them as candidates.
