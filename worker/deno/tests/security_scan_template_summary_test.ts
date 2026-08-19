/**
 * Tests for the `security-scan` template's `runTask` summary builder
 * under the outcome-only contract (Issue #2097).
 *
 * The wrapper idle-task issue is closed with `result.summary` as the
 * close comment. Under the v5 contract `runTask`:
 *   1. Snapshots open `security`-labelled issue numbers before the scan.
 *   2. Calls `runSecurityScanFn` (which runs Claude — Claude itself
 *      files findings via `gh issue create`).
 *   3. Snapshots again afterwards and computes the newly-filed set.
 *   4. Returns `"0 findings."` when nothing was newly filed, or
 *      `"Security scan complete. Filed N issues: #A, #B, …"` otherwise.
 *
 * A scanner failure surfaces as `ok: false` with a `"security-scan
 * failed: <kind> — <message>"` summary.
 *
 * Issue #3538 (business-logic change): on a successful run `runTask` now
 * appends the additive SARIF-emission status to the summary (findings are
 * uploaded to GitHub code scanning). These tests inject a deterministic
 * `emitSarifFn` stub and assert the summary carries both the findings line and
 * the SARIF suffix. The failure/throw paths return before emission, so their
 * summaries are unchanged.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  createSecurityScanTemplate,
  renderRunSummary,
} from "../lib/idle_task_templates/security_scan_template.ts";
import type { ScanError, ScanOk } from "../lib/security_scanner.ts";
import type { Result } from "../types.ts";

/**
 * Build a gh stub for `runTask` that returns a fixed before/after pair
 * for the snapshot calls.
 *
 * Both snapshot calls use `gh issue list --repo <repo> --state open
 * --label security --json number`. The stub returns `beforeNumbers` on
 * the first matching call and `afterNumbers` on every subsequent
 * matching call. Any other gh call (e.g. `shouldFile` queries) returns
 * `"[]"`.
 */
function makeSnapshotGhStub(
  beforeNumbers: number[],
  afterNumbers: number[],
): (args: string[]) => Promise<string> {
  let snapshotCalls = 0;
  return (args: string[]) => {
    const isSnapshot = args[0] === "issue" &&
      args[1] === "list" &&
      args.indexOf("--label") !== -1 &&
      args[args.indexOf("--label") + 1] === "security" &&
      args.indexOf("--search") === -1;
    if (!isSnapshot) return Promise.resolve("[]");
    snapshotCalls += 1;
    const nums = snapshotCalls === 1 ? beforeNumbers : afterNumbers;
    return Promise.resolve(JSON.stringify(nums.map((n) => ({ number: n }))));
  };
}

const okScan = (): Promise<Result<ScanOk, ScanError>> =>
  Promise.resolve({ ok: true, value: { ok: true } });

/**
 * Deterministic SARIF emitter stub (Issue #3538). `runTask` appends the
 * emitter's summary line to the findings summary; injecting a stub keeps these
 * tests hermetic (no git, no `gh api`) and pins the additive suffix.
 */
const STUB_SARIF_SUFFIX = "SARIF: stub.";
const stubEmitSarif = () =>
  Promise.resolve({ summary: STUB_SARIF_SUFFIX, upload: null });

const runOpts = {
  repo: "org/repo",
  workDir: "/tmp/work",
  idleTaskIssueNumber: 99,
};

// ---------------------------------------------------------------------------
// renderRunSummary — pure summary builder
// ---------------------------------------------------------------------------

Deno.test("renderRunSummary - zero newly-filed issues returns '0 findings.'", () => {
  assertEquals(renderRunSummary([]), "0 findings.");
});

Deno.test("renderRunSummary - one newly-filed issue", () => {
  assertEquals(
    renderRunSummary([42]),
    "Security scan complete. Filed 1 issues: #42",
  );
});

Deno.test("renderRunSummary - lists multiple issues sorted ascending", () => {
  assertEquals(
    renderRunSummary([102, 100, 101]),
    "Security scan complete. Filed 3 issues: #100, #101, #102",
  );
});

// ---------------------------------------------------------------------------
// runTask — before/after snapshot diff
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - clean scan (no newly-filed issues) returns '0 findings.'",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: okScan,
      ghCommandFn: makeSnapshotGhStub([10, 11], [10, 11]),
      emitSarifFn: stubEmitSarif,
    });
    const result = await tpl.runTask(runOpts);
    assert(result.ok, "expected a successful run");
    assertEquals(result.summary, `0 findings. ${STUB_SARIF_SUFFIX}`);
  },
);

Deno.test(
  "runTask - newly-filed issues are listed in the summary",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: okScan,
      ghCommandFn: makeSnapshotGhStub([10, 11], [10, 11, 50, 51]),
      emitSarifFn: stubEmitSarif,
    });
    const result = await tpl.runTask(runOpts);
    assert(result.ok);
    assertEquals(
      result.summary,
      `Security scan complete. Filed 2 issues: #50, #51 ${STUB_SARIF_SUFFIX}`,
    );
  },
);

Deno.test(
  "runTask - issues that disappear between snapshots do not count as newly-filed",
  async () => {
    // Before: {10, 11}. After: {11, 12}. The diff (after \ before) is
    // {12} — 10 closed, 12 newly filed. Only newly-filed issues count.
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: okScan,
      ghCommandFn: makeSnapshotGhStub([10, 11], [11, 12]),
      emitSarifFn: stubEmitSarif,
    });
    const result = await tpl.runTask(runOpts);
    assert(result.ok);
    assertEquals(
      result.summary,
      `Security scan complete. Filed 1 issues: #12 ${STUB_SARIF_SUFFIX}`,
    );
  },
);

Deno.test(
  "runTask - scanner failure surfaces a 'security-scan failed' summary",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.resolve({
          ok: false,
          error: { kind: "timeout", message: "wall clock exceeded" },
        }),
      ghCommandFn: makeSnapshotGhStub([10], [10]),
    });
    const result = await tpl.runTask(runOpts);
    assert(!result.ok, "scanner failure must surface ok: false");
    assertStringIncludes(result.summary, "security-scan failed");
    assertStringIncludes(result.summary, "timeout");
    assertStringIncludes(result.summary, "wall clock exceeded");
  },
);

Deno.test(
  "runTask - thrown error surfaces a 'security-scan threw' summary",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () => Promise.reject(new Error("boom")),
      ghCommandFn: makeSnapshotGhStub([10], [10]),
    });
    const result = await tpl.runTask(runOpts);
    assert(!result.ok);
    assertStringIncludes(result.summary, "security-scan threw");
    assertStringIncludes(result.summary, "boom");
  },
);

Deno.test(
  "runTask - malformed gh JSON in snapshots degrades to '0 findings.'",
  async () => {
    // If the before snapshot cannot be parsed it is treated as empty,
    // and likewise for the after snapshot. With both empty the diff is
    // empty — the worst-case summary is "0 findings." rather than a
    // crash that would block the worker.
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: okScan,
      ghCommandFn: () => Promise.resolve("not json"),
      emitSarifFn: stubEmitSarif,
    });
    const result = await tpl.runTask(runOpts);
    assert(result.ok);
    assertEquals(result.summary, `0 findings. ${STUB_SARIF_SUFFIX}`);
  },
);

// ---------------------------------------------------------------------------
// Model tier threading (Issue #4010)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - a stamped modelTier reaches the scanner as `model`",
  async () => {
    const captured: Array<{ model?: string }> = [];
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: (opts) => {
        captured.push({
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        });
        return Promise.resolve({ ok: true, value: { ok: true } });
      },
      ghCommandFn: makeSnapshotGhStub([], []),
      emitSarifFn: stubEmitSarif,
    });

    await tpl.runTask({ ...runOpts, modelTier: "sonnet" });
    assertEquals(captured, [{ model: "sonnet" }]);
  },
);

Deno.test(
  "runTask - an unstamped wrapper passes no `model` to the scanner",
  async () => {
    const captured: Array<Record<string, unknown>> = [];
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true, value: { ok: true } });
      },
      ghCommandFn: makeSnapshotGhStub([], []),
      emitSarifFn: stubEmitSarif,
    });

    await tpl.runTask(runOpts);
    assertEquals(captured.length, 1);
    assert(
      !Object.hasOwn(captured[0]!, "model"),
      "expected no model key on the scan options",
    );
  },
);
