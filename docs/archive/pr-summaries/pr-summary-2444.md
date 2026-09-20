# PR Summary — Issue #2444

A run record cannot say which worker code produced it — add the worker version and commit to the callback context.

## Summary

Added worker build metadata (`workerVersion` and `workerCommit`) to the callback context, enabling audit trails that name the worker version and source code responsible for each run's outcome. These are **additive** scalars following the precedent of earlier callback schema enhancements (graft, codegraph, rtk).

The implementation adds:

- **New file**: `worker/deno/lib/worker_build_info.ts` — reads worker version and commit SHA from the build environment at startup.
- **Schema extension**: `workerVersion` and `workerCommit` fields in the callback context JSON document and exported as `VIBECODER_WORKER_VERSION` and `VIBECODER_WORKER_COMMIT` environment scalars.
- **Integration points**: `host_failure_hook.ts` and `run_callback_context.ts` import and apply worker build facts to both host-level and issue-run callback contexts.
- **Test coverage**: 
  - New test file `worker_build_callback_2444_test.ts` exercises the full path end-to-end, including context assembly and fixture validation.
  - Three new test blocks in `callback_schema_compat_test.ts` pin the `WORKER_BUILD_ENV` constant (matching patterns used for graft, codegraph, and rtk fields) to prevent regressions.
- **Documentation**: `docs/CALLBACKS.md` updated with:
  - Explanatory section (lines 614–630) following the graft/codegraph/rtk precedent.
  - Two new rows in the callback scalar table (lines 516–517).
  - Example JSON document updated to include the new fields.

## Schema versioning

`schemaVersion` remains at 2; the change is purely additive. Optional fields (`workerVersion` and `workerCommit`) are **omitted** from the document and environment (not exported as blank) when the worker's build metadata cannot be read at invocation time.

## Test plan

- [x] All unit tests pass (deno test).
- [x] All type checks pass (deno check).
- [x] All linting passes (deno lint).
- [x] All formatters pass (deno fmt).
- [x] Full quality gate passes (./quality.sh).
- [x] New callback schema compat test blocks pass and follow established patterns.
- [x] End-to-end test covers fixture assembly and context validation.
- [x] Documentation is complete, consistent with schema versioning precedent, and validated by markdownlint.

## Schema compatibility

| Aspect | Details |
|--------|---------|
| **Version bump** | None — `schemaVersion` stays at 2 |
| **Backwards compatible** | Yes — optional fields omitted when unavailable; hooks written before these fields existed are unaffected |
| **Precedent** | Matches additive extensions: graft (Issue #2104), codegraph (Issue #2162), rtk (Issue #2386) |
| **Test pinning** | Constant array `WORKER_BUILD_ENV` pinned in regression test to prevent accidental removal |

## References

- Issue: #2444
- Related: #2327 (worker version context), #2043 (callback context schema), #2104 (graft additive), #2162 (codegraph additive), #2386 (rtk additive)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
