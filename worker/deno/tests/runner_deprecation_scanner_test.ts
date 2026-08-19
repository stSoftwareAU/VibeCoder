/**
 * Tests for `worker/deno/lib/runner_deprecation_scanner.ts` (Issue #2220).
 *
 * Verifies the deterministic parser that reads recent workflow run logs
 * via injected `ghCommandFn` and extracts GitHub Actions runner
 * deprecation warnings as structured findings.
 *
 * Australian English throughout (behaviour, organisation, recognised).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DeprecationFinding,
  type GhCommandFn,
  scanRecentRunsForDeprecations,
} from "../lib/runner_deprecation_scanner.ts";

/** Helper: build a JSON payload mimicking `gh run list --json …`. */
function runListJson(
  runs: Array<{
    databaseId: number;
    url?: string;
    workflowName?: string;
    conclusion?: string;
    headBranch?: string;
    createdAt?: string;
  }>,
): string {
  return JSON.stringify(
    runs.map((r) => ({
      databaseId: r.databaseId,
      url: r.url ??
        `https://github.com/owner/repo/actions/runs/${r.databaseId}`,
      workflowName: r.workflowName ?? "ci",
      conclusion: r.conclusion ?? "success",
      headBranch: r.headBranch ?? "main",
      createdAt: r.createdAt ?? new Date().toISOString(),
    })),
  );
}

/**
 * Build a `GhCommandFn` mock that returns the queued response keyed by
 * subcommand: `run list` returns `listJson`, and each `run view <id>`
 * returns the matching entry from `logsById`.
 */
function makeMockGh(opts: {
  listJson: string;
  logsById: Record<number, string>;
}): { fn: GhCommandFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: GhCommandFn = (args) => {
    calls.push([...args]);
    if (args[0] === "run" && args[1] === "list") {
      return Promise.resolve(opts.listJson);
    }
    if (args[0] === "run" && args[1] === "view") {
      const id = Number(args[2]);
      const log = opts.logsById[id];
      return Promise.resolve(log ?? "");
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

// Realistic Node.js 20 deprecation warning, taken from the parent issue #2205.
const NODE20_LINE =
  "Node.js 20 actions are deprecated. The following actions are running on Node.js 20 and may not work as expected: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5, actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020. Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026.";

Deno.test(
  "scanRecentRunsForDeprecations - parses Node 20 warning into structured findings",
  async () => {
    const mock = makeMockGh({
      listJson: runListJson([{ databaseId: 111 }]),
      logsById: {
        111:
          `Run actions/checkout@v4\nSome other log line\n${NODE20_LINE}\nEnd of log\n`,
      },
    });

    const findings = await scanRecentRunsForDeprecations(
      "owner/repo",
      mock.fn,
    );

    // Both actions named in the warning are extracted as separate findings.
    assertEquals(findings.length, 2);

    const checkout = findings.find((f) => f.action === "actions/checkout");
    if (!checkout) throw new Error("expected actions/checkout finding");
    assertEquals(checkout.stableId, "BP-RUNNER-actions-checkout-node20");
    assertEquals(checkout.reason, "node20");
    assertEquals(
      checkout.pinnedRef,
      "34e114876b0b11c390a56381ad16ebd13914f8d5",
    );
    assertStringIncludes(checkout.runUrl, "/actions/runs/111");
    assertStringIncludes(checkout.evidence, "Node.js 20");

    const setupNode = findings.find((f) => f.action === "actions/setup-node");
    if (!setupNode) throw new Error("expected actions/setup-node finding");
    assertEquals(setupNode.stableId, "BP-RUNNER-actions-setup-node-node20");
    assertEquals(setupNode.reason, "node20");
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - clean log produces zero findings",
  async () => {
    const mock = makeMockGh({
      listJson: runListJson([{ databaseId: 222 }]),
      logsById: {
        222:
          "Run actions/checkout@v4\nAll good here\nNothing to see\nBuild succeeded\n",
      },
    });

    const findings = await scanRecentRunsForDeprecations(
      "owner/repo",
      mock.fn,
    );
    assertEquals(findings, []);
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - duplicate warnings collapse into one finding",
  async () => {
    // Two completed runs, each emitting the same Node 20 warning for
    // `actions/checkout`. Expect a single collapsed finding with that
    // action's stable id.
    const dupLine =
      "Node.js 20 actions are deprecated. The following actions are running on Node.js 20: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.";
    const mock = makeMockGh({
      listJson: runListJson([
        { databaseId: 301, url: "https://gh/url/301" },
        { databaseId: 302, url: "https://gh/url/302" },
      ]),
      logsById: {
        301: `Run actions/checkout@v4\n${dupLine}\n`,
        302: `Run actions/checkout@v4\n${dupLine}\n`,
      },
    });

    const findings = await scanRecentRunsForDeprecations(
      "owner/repo",
      mock.fn,
    );

    const checkout = findings.filter((f) => f.action === "actions/checkout");
    assertEquals(checkout.length, 1);
    assertEquals(checkout[0]?.stableId, "BP-RUNNER-actions-checkout-node20");
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - gh failure returns empty array without throwing",
  async () => {
    const fn: GhCommandFn = () => {
      throw new Error("gh: not authenticated");
    };
    const findings = await scanRecentRunsForDeprecations("owner/repo", fn);
    assertEquals(findings, []);
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - recognises set-output and save-state warnings",
  async () => {
    const log = [
      "Run actions/setup-node@abcdef1234567890abcdef1234567890abcdef12",
      "Warning: The `set-output` command is deprecated and will be disabled soon. Please upgrade to using Environment Files.",
      "Warning: The `save-state` command is deprecated and will be disabled soon. Please upgrade to using Environment Files.",
    ].join("\n");

    const mock = makeMockGh({
      listJson: runListJson([{ databaseId: 401 }]),
      logsById: { 401: log },
    });

    const findings = await scanRecentRunsForDeprecations(
      "owner/repo",
      mock.fn,
    );

    const setOutput = findings.find((f) => f.reason === "set-output");
    if (!setOutput) throw new Error("expected set-output finding");
    assertEquals(setOutput.action, "actions/setup-node");
    assertEquals(
      setOutput.stableId,
      "BP-RUNNER-actions-setup-node-set-output",
    );

    const saveState = findings.find((f) => f.reason === "save-state");
    if (!saveState) throw new Error("expected save-state finding");
    assertEquals(saveState.action, "actions/setup-node");
    assertEquals(
      saveState.stableId,
      "BP-RUNNER-actions-setup-node-save-state",
    );
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - recognises legacy node12 / node16 warnings",
  async () => {
    const log = [
      "Node.js 16 actions are deprecated. Please update the following actions to use Node.js 20: actions/foo@v1.",
      "Node.js 12 actions are deprecated. Please update the following actions to use Node.js 16: actions/bar@v0.",
    ].join("\n");

    const mock = makeMockGh({
      listJson: runListJson([{ databaseId: 501 }]),
      logsById: { 501: log },
    });

    const findings = await scanRecentRunsForDeprecations(
      "owner/repo",
      mock.fn,
    );

    const foo = findings.find((f) => f.action === "actions/foo");
    if (!foo) throw new Error("expected actions/foo finding");
    assertEquals(foo.reason, "node16");
    assertEquals(foo.stableId, "BP-RUNNER-actions-foo-node16");

    const bar = findings.find((f) => f.action === "actions/bar");
    if (!bar) throw new Error("expected actions/bar finding");
    assertEquals(bar.reason, "node12");
    assertEquals(bar.stableId, "BP-RUNNER-actions-bar-node12");
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - respects runLimit cap",
  async () => {
    const runs = Array.from({ length: 20 }, (_, i) => ({ databaseId: i + 1 }));
    const logsById: Record<number, string> = {};
    for (const r of runs) {
      logsById[r.databaseId] = "no warnings here\n";
    }
    const mock = makeMockGh({
      listJson: runListJson(runs),
      logsById,
    });

    await scanRecentRunsForDeprecations("owner/repo", mock.fn, {
      runLimit: 3,
    });

    // The first call is `run list` with `--limit 3`; the helper must pass
    // that through to `gh` and only inspect three runs.
    const listCall = mock.calls.find(
      (a) => a[0] === "run" && a[1] === "list",
    );
    if (!listCall) throw new Error("expected a `gh run list` call");
    const limitIdx = listCall.indexOf("--limit");
    assertEquals(listCall[limitIdx + 1], "3");

    const viewCalls = mock.calls.filter(
      (a) => a[0] === "run" && a[1] === "view",
    );
    assertEquals(viewCalls.length, 3);
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - respects logByteCap to bound work",
  async () => {
    // Each log is 600 bytes; with a 1000-byte cap the scanner should
    // stop after inspecting two runs (the second exhausts the budget).
    const giantLog = "x".repeat(600);
    const runs = [
      { databaseId: 1001 },
      { databaseId: 1002 },
      { databaseId: 1003 },
      { databaseId: 1004 },
    ];
    const mock = makeMockGh({
      listJson: runListJson(runs),
      logsById: {
        1001: giantLog,
        1002: giantLog,
        1003: giantLog,
        1004: giantLog,
      },
    });

    await scanRecentRunsForDeprecations("owner/repo", mock.fn, {
      logByteCap: 1000,
    });

    const viewCalls = mock.calls.filter(
      (a) => a[0] === "run" && a[1] === "view",
    );
    // Two runs fit (one fully, one partially) before the cap is reached.
    assertEquals(viewCalls.length, 2);
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - skips runs older than the `sinceDays` window",
  async () => {
    const now = new Date("2026-05-24T00:00:00Z");
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
      .toISOString();
    const stale = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString();

    const mock = makeMockGh({
      listJson: runListJson([
        { databaseId: 701, createdAt: recent },
        { databaseId: 702, createdAt: stale },
      ]),
      logsById: { 701: "clean\n", 702: "clean\n" },
    });

    await scanRecentRunsForDeprecations("owner/repo", mock.fn, {
      sinceDays: 14,
      now,
    });

    const viewedIds = mock.calls
      .filter((a) => a[0] === "run" && a[1] === "view")
      .map((a) => a[2]);
    assertEquals(viewedIds, ["701"]);
  },
);

Deno.test(
  "scanRecentRunsForDeprecations - DeprecationFinding shape is stable",
  () => {
    // Compile-time shape check. If the public interface changes
    // shape this test will fail to type-check.
    const _example: DeprecationFinding = {
      stableId: "BP-RUNNER-actions-checkout-node20",
      action: "actions/checkout",
      pinnedRef: "v4",
      reason: "node20",
      runUrl: "https://gh/url/1",
      evidence: "evidence",
    };
    assertEquals(_example.stableId, "BP-RUNNER-actions-checkout-node20");
  },
);
