# Grill-me disk deferrals and measured cache recovery

## Summary

Prevent host disk admission from turning a discussion into a failed grill-me
round. Let Claude continue with enforced read/research tools above the host
reserve when Rust build headroom is unavailable, and make host cache reclaim
stop against measured free space rather than deleted directory sizes.

Related incident: [GRQ-AutoTrader #5120](https://github.com/stSoftwareAU/GRQ-AutoTrader/issues/5120#issuecomment-6776958532).
That issue describes onboarding requirements and is not closed by this fix.

## Spec

### Intent and Rationale

- The reported host had 101.0 GiB free against a 92.6 GiB reserve plus 25 GiB
  build allowance. A discussion should not require a Rust build allowance.
- Infrastructure deferrals must not consume discussion failure attempts or
  create a false request for human intervention.
- Removing guest files and returning physical host blocks are different
  observations. Cleanup must report that distinction.

### Essential Design Decisions

- Keep the host reserve, running-process watcher and implementation admission
  gates. Restricted discussion uses a positive Claude tool list, fresh session,
  isolated settings, no MCP/delegation, and disabled non-managed hooks.
  Unsupported providers defer rather than run without these restrictions.
- The worker validates JSON output, preserves issue text outside the bounded
  understanding block, and confirms comment publication before advancing.
- Reuse the existing host-fault classifier for new and historical failures.
  Genuine questions and genuine task failures retain their existing handling.
- Launchers pass the filesystem used by their disk gate. Reclaim measures it
  after each deletion; a failed measurement stops further removals. Existing
  ownership, freshness, active-process and protected-path guards remain.

### Undiscoverable Facts

- The linked incident also reported an absent ephemeral cargo cache root and
  later zero bytes pruned. An absent root is now treated as empty; cache
  diagnostics distinguish own, recent sibling and idle sibling bytes.
- The live host was not accessible during implementation. This change does
  not claim its disk has already been recovered.
- Administrative managed hooks remain governed by the host's Claude policy.

## Evidence

- Reproduced the estimate-only reclaim bug with two stale 20 GiB caches:
  deletion of the first leaves measured free space at 101 GiB. The old code
  stopped; the corrected code removes the next eligible cache and observes
  120 GiB, while retaining the separate 141 GiB estimate.
- 387 focused regression tests passed across 16 suites, including runner
  admission, provider arguments, publication, disk deferrals and cache safety.
  They used local copies of the locked standard-library versions because
  Deno's registry manifest downloads failed in this environment.
- The same 55 completeness suites used by `check:manifests` also passed with
  local dependency mapping: 866 tests passed, with one existing ignored test.
- Repository-wide type checking passed with the same local dependency mapping.
- Repository-wide Deno lint/format, source targets, Mermaid validation and
  the shell syntax check passed. The full quality gate was attempted but
  cannot be reported green: its normal type/test/completeness commands could
  not download JSR manifests. Markdownlint, Semgrep, Checkov and authenticated
  ruleset checks were unavailable locally. Native PowerShell execution was
  not validated here; the Windows probe's command and parsing were tested.
- Read and updated the host-cache/ephemeral-budget sections of
  `docs/CONTAINER.md` and the recovery guidance in `docs/workflows/grill-me.md`.

## Test Plan

- `grill_me_processor_test.ts`: repeated and historical disk deferrals;
  restricted publication with REST metadata and legacy confirmation;
  preservation of human requirements; malformed response rejection.
- `agent_containment_limits_3701_test.ts`: start above the reserve without
  build headroom, enforce tools/settings, refuse unsupported providers and
  still refuse starts below the reserve.
- `heavy_build_gate_3178_test.ts` and
  `heavy_build_gate_in_flight_4413_test.ts`: absent roots and accurate cache
  inventory/reporting without weakening admission.
- `host_cache_reclaim_test.ts`: measured stop conditions, failed probes,
  Windows parsing, and separate command reports of removals and recovery.
- Existing provider, host-disk, claim-deferral and accelerator suites cover
  the surrounding paths.

## Merge verification

Required CI and independent code review have not yet completed. No live host
recovery or deployed fleet version is claimed.
