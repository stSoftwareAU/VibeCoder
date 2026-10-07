/**
 * Production wiring for native sub-issue blocking (Issue #3314).
 *
 * The census and audit classifiers gained a `subIssuesSummary` gate in
 * `idle_detect_diagnostics.ts`/`issue_query.ts`'s `hasOpenSubIssues`, but
 * that gate only fires when the field actually reaches the classifier. Two
 * production lines carry the whole wiring:
 *
 *   - `issue_query.ts`'s `fetchAllIssues` requesting `subIssuesSummary` in
 *     its `--json` field list.
 *   - `run_core_production_deps.ts` mapping `i.subIssuesSummary` into the
 *     census's per-issue input.
 *
 * Neither line was covered: every existing test drove the pure
 * `classifyIssues`/`buildIdleDecisionCensus` functions with hand-built
 * input that already carried the field. This test drives the real
 * `createProductionRunCoreDeps`, exactly as
 * `idle_census_backed_off_wiring_2085_test.ts` does for Issue #2085, with a
 * stub `gh` that mirrors the real CLI's own contract — it returns only the
 * fields named in `--json` (CODING-STANDARDS.md "A stub mirrors the real
 * callee's contract") — so dropping `subIssuesSummary` from either
 * production line reproduces exactly what the real `gh` call would hand
 * back, rather than throwing on a self-check that masks the real failure.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "org/sub-issue-fixture";
const WORKER_USER = "worker-bot";

/** Every field the fixture's one issue could carry, keyed by gh field name. */
const FIXTURE_FIELDS: Record<string, unknown> = {
  number: 2503,
  title: "Parent with open sub-issues",
  labels: [{ name: "work-on" }],
  assignees: [],
  milestone: null,
  body: "",
  subIssuesSummary: { total: 4, completed: 0 },
};

/** Every `gh issue list` call this run made, for request-shape assertions. */
const calls: string[][] = [];

/**
 * Mirrors real `gh issue list --json <fields>`: the response row carries
 * only the fields named in `--json`, nothing else. A production line that
 * stops requesting `subIssuesSummary` therefore makes this stub stop
 * returning it too — the same failure a live `gh` call would produce.
 */
function stubGh(args: string[]): Promise<string> {
  calls.push(args);
  if (args[0] === "issue" && args[1] === "list") {
    const requested = new Set(
      (args[args.indexOf("--json") + 1] ?? "").split(","),
    );
    const row: Record<string, unknown> = {};
    for (const field of Object.keys(FIXTURE_FIELDS)) {
      if (requested.has(field)) row[field] = FIXTURE_FIELDS[field];
    }
    return Promise.resolve(JSON.stringify([row]));
  }
  return Promise.resolve("[]");
}

/**
 * Run both idle instruments for one cycle and return every logged line —
 * same production ordering as the #2085 wiring test: the audit runs first
 * so its stubbed probes warm the shared issue/PR caches the census reads.
 */
async function idleLines(): Promise<string[]> {
  const workDir = await Deno.makeTempDir({ prefix: "idle-subissue-wiring-" });
  try {
    const lines: string[] = [];
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: [REPO], workDir },
      idleDetectGhCommandFn: stubGh,
    });
    await deps.runIdleDetectAudit!({
      tick: 1,
      scanFoundClaimable: false,
      scanExcludedRepos: [],
    });
    await deps.runIdleDecisionCensus!({
      decisionPoint: "filing",
      claimScanCompleted: true,
      claimedRepos: [],
      scanExcludedRepos: [],
    });
    return lines;
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "production deps - fetchAllIssues requests subIssuesSummary in --json (Issue #3314)",
  async () => {
    calls.length = 0;
    await idleLines();
    const listCalls = calls.filter((a) => a[0] === "issue" && a[1] === "list");
    assert(listCalls.length > 0, "no gh issue list call was made");
    for (const call of listCalls) {
      const fields = call[call.indexOf("--json") + 1] ?? "";
      assert(
        fields.includes("subIssuesSummary"),
        `gh issue list --json did not request subIssuesSummary: ${fields}`,
      );
    }
  },
);

Deno.test(
  "production deps - the audit does not count an open-sub-issue parent as claimable (Issue #3314)",
  async () => {
    const lines = await idleLines();
    const detectLine = lines.find((l) =>
      l.includes("[idle-detect]") && l.includes(`repo=${REPO}`)
    );
    assert(detectLine !== undefined, "the audit logged no line for the repo");
    assert(detectLine.includes("claimable=0"), detectLine);
  },
);

Deno.test(
  "production deps - the census counts the open-sub-issue parent as dependency_blocked (Issue #3314)",
  async () => {
    const lines = await idleLines();
    const repoLine = lines.find((l) =>
      l.includes("[idle-census]") && l.includes(`repo=${REPO}`)
    );
    assert(repoLine !== undefined, "the census logged no line for the repo");
    assert(repoLine.includes("dependency_blocked=1"), repoLine);
    assert(repoLine.includes("work_on=0"), repoLine);
    // The audit and census agree, so no false inversion/mis_classification.
    assertEquals(
      lines.filter((l) => l.includes("ALERT mis_classification")),
      [],
      "audit and census must agree the parent is blocked, not claimable",
    );
  },
);
