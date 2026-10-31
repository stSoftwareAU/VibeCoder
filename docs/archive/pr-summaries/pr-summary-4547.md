## Summary

The four checks the tracker names (`gh spawn chokepoint`, `git spawn chokepoint`, `spawn timeout`, `git ref chokepoint`) pass on the current default branch, so the tracker is stale for them. The default-branch gate was still red for a different reason: two Rust formatter tests failed on hosts where `cargo` and `rustfmt` exist but `cargo fmt` is not runnable. This change makes those tests skip on such hosts. Closes #4547.

## Spec

### Intent and Rationale

- `hasCargo()` probed `cargo --version` and `rustfmt --version`, but the production formatter runs `cargo fmt`. With a rustup proxy and no default toolchain, `cargo fmt` fails ("rustup could not choose a version of cargo-fmt to run"), so the tests ran and failed rather than skipping.
- The probe now runs the command the code under test runs.

### Essential Design Decisions

- Only the test guard changed; production formatter behaviour is untouched.

### Undiscoverable Facts

- The failure is host-specific: this host's rustup has no default toolchain configured.

## Evidence

- Before the change, `./quality.sh` on the untouched default branch showed the four named checks PASSED (1276–1309 files scanned) and `deno tests` FAILED with exactly two failures: `completion - an unformatted Rust change is formatted and committed, then passes the gate` and `completion - cargo fmt stages only the branch's .rs files, not an unrelated uncommitted edit`, both with `formatter should commit the Rust fix`.
- `cargo --version` exits 0, `rustfmt --version` exits 0, `cargo fmt --version` exits 1 on this host.

## Test Plan

- `cd worker/deno && deno task test:unit tests/completion_phase_repo_formatters_test.ts < /dev/null`: passed (8 passed, 0 failed); the two Rust tests take the skip branch on this host.
- `deno fmt --check` on the edited file: passed.
- No assertions were removed or changed. The guard is a skip condition, so the Rust tests still run fully on hosts where `cargo fmt` works.
- Two further full `./quality.sh` runs after the change hit the 10-minute tool cap during the deno tests stage; every stage before it passed. The first full run before the change showed only the two failures above.

<!-- vibe-quality-gate-skipped reason="full ./quality.sh exceeded the 10-minute command cap twice after the change (all stages before deno tests passed); the pre-change run showed only the two Rust tests failing, which the targeted test file now passes" -->
