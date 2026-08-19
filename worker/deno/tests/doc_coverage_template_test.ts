/**
 * Tests for the module-doc & README coverage idle-task template
 * (Issue #2913, template #6, one of the #2903 "Boy Scout" checks).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("doc-coverage")` / `listTemplates()` find it.
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "doc-coverage", requiresStructuredOutput === true.
 *   - title is the literal "Run a module-doc & README coverage scan"
 *     (used for dispatch).
 *   - buildIssueBody output is recognised by BOTH the title match and
 *     the body fingerprint, and leaves no raw `{{...}}` placeholders.
 *   - assembleDocCoveragePrompt substitutes placeholders / `(none)`
 *     sentinel / attribution footer.
 *   - runTask happy path: ensures the `doc-coverage` label before the
 *     scan, and returns the before/after diff summary.
 *   - runTask error path: runScanFn failure → ok:false summary.
 *   - runTask edge case: empty before/after diff → "no findings".
 *   - runTask passes known-open finding ids to the scan runner so
 *     Claude does not re-emit them (suppression-on-re-run path).
 *   - shouldFile vetoes while an open wrapper exists / allows otherwise.
 *   - claim handler dispatches a "Run a module-doc & README coverage
 *     scan" wrapper to runTask.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleDocCoveragePrompt,
  createDocCoverageTemplate,
  DOC_COVERAGE_BODY_FINGERPRINT,
  DOC_COVERAGE_ISSUE_TITLE,
  DOC_COVERAGE_LABEL,
  docCoverageTemplate,
  renderDocCoverageSummary,
} from "../lib/idle_task_templates/doc_coverage_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Module-doc & README coverage — Documentation Posture Audit (v1)",
  "",
  "Suppressed ids:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open finding ids:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
  "",
  "Footer:",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

/**
 * gh stub. Distinguishes the snapshot calls (`--json number`), the
 * known-open lookup (`--json number,body` scoped to the label), and
 * the wrapper-veto title search (`--json number,title`). Snapshot
 * calls return the first/second entry of `snapshots`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  knownOpen?: Array<{ number: number; body: string }>;
  /** Open wrapper titles returned by the `--json number,title` query. */
  openWrapperTitles?: string[];
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  let snapshotCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (jsonField === "number") {
      const snap = scenario.snapshots ?? [[], []];
      const result = snapshotCount === 0 ? snap[0] : snap[1];
      snapshotCount += 1;
      return Promise.resolve(
        JSON.stringify(result.map((n) => ({ number: n }))),
      );
    }
    if (jsonField === "number,body") {
      return Promise.resolve(JSON.stringify(scenario.knownOpen ?? []));
    }
    if (jsonField === "number,title") {
      const titles = scenario.openWrapperTitles ?? [];
      return Promise.resolve(
        JSON.stringify(titles.map((title, i) => ({ number: i + 1, title }))),
      );
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function makeLogger(): { logger: Logger; records: string[] } {
  const records: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: (m) => records.push(`info:${m}`),
    warn: (m) => records.push(`warn:${m}`),
    error: (m) => records.push(`error:${m}`),
    debug: (m) => records.push(`debug:${m}`),
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, records };
}

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("doc-coverage - registered at module load", () => {
  const t = getTemplate("doc-coverage");
  assert(t !== undefined, "expected doc-coverage template to be registered");
  assertEquals(t, docCoverageTemplate);
  assert(
    listTemplates().some((x) => x.name === "doc-coverage"),
    "expected listTemplates() to include doc-coverage",
  );
});

Deno.test("doc-coverage - contract flags", () => {
  assertEquals(docCoverageTemplate.cooldownHours, 168);
  assertEquals(docCoverageTemplate.skipMilestone, true);
  assertEquals(docCoverageTemplate.outputLabel, DOC_COVERAGE_LABEL);
  assertEquals(docCoverageTemplate.requiresStructuredOutput, true);
  assertEquals(
    docCoverageTemplate.buildIssueTitle("acme/widget"),
    DOC_COVERAGE_ISSUE_TITLE,
  );
});

Deno.test("doc-coverage - buildIssueBody matches title and fingerprint", async () => {
  const t = createDocCoverageTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-06-07T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  // Title match (dispatch signal #2).
  assertEquals(t.buildIssueTitle("acme/widget"), DOC_COVERAGE_ISSUE_TITLE);
  // Body fingerprint (dispatch signal #3).
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(DOC_COVERAGE_BODY_FINGERPRINT.test(body));
  // No raw placeholders survive — they collapse to the (none) sentinel.
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleDocCoveragePrompt - empty lists render (none)", () => {
  const out = assembleDocCoveragePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleDocCoveragePrompt - populated lists are joined", () => {
  const out = assembleDocCoveragePrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("assembleDocCoveragePrompt - attribution footer substituted", () => {
  const out = assembleDocCoveragePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: "🏷️ Filed by idle-task template: `doc-coverage`",
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, "🏷️ Filed by idle-task template: `doc-coverage`");
});

Deno.test("renderDocCoverageSummary - wording", () => {
  assertEquals(renderDocCoverageSummary([]), "no findings");
  assertEquals(
    renderDocCoverageSummary([12, 3]),
    "Doc-coverage scan complete. Filed 2 issues: #3, #12",
  );
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("runTask - happy path ensures label and diffs snapshot", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[1, 2], [1, 2, 7, 9]],
    knownOpen: [{ number: 2, body: "<!-- finding-id: BP-existing0001 -->" }],
  });
  const ensureCalls: string[] = [];
  const scanCalls: { knownOpenFindingIds: string[] }[] = [];
  const t = createDocCoverageTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: (repo) => {
      ensureCalls.push(repo);
      return Promise.resolve({ ok: true, value: undefined });
    },
    runScanFn: (opts) => {
      scanCalls.push({ knownOpenFindingIds: opts.knownOpenFindingIds });
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(
    result.summary,
    "Doc-coverage scan complete. Filed 2 issues: #7, #9",
  );
  // Label ensured before the scan.
  assertEquals(ensureCalls, ["acme/widget"]);
  // Known-open ids flow into the scan runner — drives the
  // "suppression drops a finding on re-run" expectation.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  // The label-scoped snapshot query was issued.
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(DOC_COVERAGE_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDocCoverageTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () =>
      Promise.resolve({
        ok: false,
        error: { kind: "claude", message: "boom" },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "doc-coverage failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createDocCoverageTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
});

// ---------------------------------------------------------------------------
// shouldFile veto
// ---------------------------------------------------------------------------

Deno.test("shouldFile - vetoes while an open wrapper exists", async () => {
  const { gh } = makeGhStub({
    openWrapperTitles: [DOC_COVERAGE_ISSUE_TITLE],
  });
  const t = createDocCoverageTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
  });
  const allowed = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(allowed, false);
});

Deno.test("shouldFile - allows filing when no open wrapper exists", async () => {
  const { gh } = makeGhStub({ openWrapperTitles: [] });
  const t = createDocCoverageTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
  });
  const allowed = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(allowed, true);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a doc-coverage wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createDocCoverageTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });
  const { logger } = makeLogger();
  const deps: HandleIdleTaskIssueDeps = {
    logger,
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 100,
      issueTitle: DOC_COVERAGE_ISSUE_TITLE,
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "irrelevant",
      workDir: "/tmp/widget",
    },
    deps,
  );

  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertEquals(
    result.summary,
    "Doc-coverage scan complete. Filed 1 issues: #11",
  );
});
