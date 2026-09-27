/**
 * The final output of the GRQ#4871 `work-on` run (Issue #2687).
 *
 * The run finished with no commit, and this text — a described fix plus a
 * RED/GREEN regression test — was escalated as "Analysis-only issue — no PR
 * deliverable". It is a failed implementation, not analysis. A verbatim,
 * contiguous excerpt of the Partial Answer the worker posted (steps 6–12 and
 * the leading, already-truncated line elided), so the detector is tested
 * against what an agent really wrote rather than a sentence shaped to pass.
 */
export const GRQ_4871_OUTPUT =
  `2. **Regression test** (\`test/worker/IntelligentDesignHeapClampSkip.ts\`):
   - New Deno.test asserting that when ledger-ceiling is detected:
     - Stderr contains \`[heap-clamp] INELIGIBLE:\` marker
     - This marker appears in run 1 (not waiting for count ≥ 3)
     - Current code fails this test (RED)
     - Fix makes it pass (GREEN)

3. **Why this works:**
   - The \`[heap-clamp] INELIGIBLE:\` marker immediately signals structural impossibility (DoD b)
   - Marking critical removes rate-limiting, so escalations are unheld after threshold (DoD a)
   - Regression test verifies the distinct outcome is present (DoD c)
   - Config faults (Test 5 constraint) still exit 1 before reaching this code, so no skip marker is printed

This design satisfies the constraint that config faults must stay fail-loud (exit 1, no skip marker) because \`grq_heap_clamp_binding_term\` only returns \`ledger-ceiling:\` when the sizing math itself is valid; malformed config is rejected earlier.

## Next Steps (Text Summary)

1. **Write failing regression test** in \`test/worker/IntelligentDesignHeapClampSkip.ts\`:
   - Add new Deno.test using existing \`runIdSizing()\` harness
   - Create NO_FIT_HOST mock with ledger ceiling below floor
   - Assert stderr includes \`[heap-clamp] INELIGIBLE:\` marker
   - Run test to confirm it fails (RED)

2. **Implement fix** in \`worker/shared/heap_clamp_skip.sh\`:
   - Refactor terminal branch to detect \`ledger-ceiling:\` prefix
   - Add conditional: ledger-ceiling path vs. transient path
   - Print new INELIGIBLE marker
   - Call \`grq_capability_mark_critical\`
   - Run test to confirm it passes (GREEN)

3. **Update documentation**:
   - Add Mermaid flowchart to AGENTS.md showing structural vs. transient paths
   - Update OPERATIONS.md with ledger-ceiling outcome description

4. **Bump deno.json patch version**

5. **Run targeted tests**:
   - \`IntelligentDesignHeapClampSkip.ts\` (new regression test + existing Tests 3-7)
   - \`PortfolioHeapClampSkip.ts\`, \`LearnHeapClampSkip.ts\`, related tests

Ready to begin implementation on next context window.`;
