/**
 * Tests for the deprecated-API usage idle-task template
 * (Issue #2914, parent #2903, Boy Scout check #4).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("deprecated-api")` / `listTemplates()` find it
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "deprecated-api", requiresStructuredOutput === true
 *   - title is the literal "Run a deprecated-API usage scan" (used for
 *     dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and the
 *     body fingerprint, and leaves no raw `{{...}}` placeholders
 *   - assembleDeprecatedApiPrompt substitutes placeholders / `(none)`
 *     sentinel
 *   - runTask happy path: ensures the `deprecated-api` label before the
 *     scan, and returns the before/after diff summary
 *   - runTask error path: runScanFn failure → ok:false summary
 *   - runTask edge case: empty before/after diff → "no findings"
 *   - claim handler dispatches a "Run a deprecated-API usage scan" wrapper
 *     to runTask
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleDeprecatedApiPrompt,
  createDeprecatedApiTemplate,
  DEPRECATED_API_BODY_FINGERPRINT,
  DEPRECATED_API_ISSUE_TITLE,
  DEPRECATED_API_LABEL,
  deprecatedApiTemplate,
  renderDeprecatedApiSummary,
} from "../lib/idle_task_templates/deprecated_api_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger } from "../types.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Deprecated-API Usage Scan (v1)",
  "",
  "Suppressed ids:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open finding ids:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
  "",
  "Attribution footer line every filed body MUST end with:",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

/**
 * gh stub. Distinguishes the two snapshot calls (`--json number`) from the
 * known-open lookup (`--json number,body`). The before/after snapshots
 * return the first/second entry of `snapshots`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  knownOpen?: Array<{ number: number; body: string }>;
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

Deno.test("deprecated-api - registered at module load", () => {
  const t = getTemplate("deprecated-api");
  assert(t !== undefined, "expected deprecated-api template to be registered");
  assertEquals(t, deprecatedApiTemplate);
  assert(
    listTemplates().some((x) => x.name === "deprecated-api"),
    "expected listTemplates() to include deprecated-api",
  );
});

Deno.test("deprecated-api - contract flags", () => {
  assertEquals(deprecatedApiTemplate.cooldownHours, 168);
  assertEquals(deprecatedApiTemplate.skipMilestone, true);
  assertEquals(deprecatedApiTemplate.outputLabel, DEPRECATED_API_LABEL);
  assertEquals(deprecatedApiTemplate.requiresStructuredOutput, true);
  assertEquals(
    deprecatedApiTemplate.buildIssueTitle("acme/widget"),
    DEPRECATED_API_ISSUE_TITLE,
  );
});

Deno.test("deprecated-api - buildIssueBody matches title and fingerprint", async () => {
  const t = createDeprecatedApiTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-06-18T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  // Title match (dispatch signal #2).
  assertEquals(t.buildIssueTitle("acme/widget"), DEPRECATED_API_ISSUE_TITLE);
  // Body fingerprint (dispatch signal #3).
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(DEPRECATED_API_BODY_FINGERPRINT.test(body));
  // No raw placeholders survive — they collapse to the (none) sentinel.
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  // Issue #2439 — attribution footer is substituted, names the template,
  // and survives intact in the wrapper body.
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `deprecated-api`",
  );
  assertStringIncludes(body, "Run id:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleDeprecatedApiPrompt - empty lists render (none)", () => {
  const out = assembleDeprecatedApiPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleDeprecatedApiPrompt - attribution footer is substituted", () => {
  const footer =
    "🏷️ Filed by idle-task template: `deprecated-api` · Run id: `vibe-test-id`";
  const out = assembleDeprecatedApiPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: footer,
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, footer);
});

Deno.test("assembleDeprecatedApiPrompt - populated lists are joined", () => {
  const out = assembleDeprecatedApiPrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("renderDeprecatedApiSummary - wording", () => {
  assertEquals(renderDeprecatedApiSummary([]), "no findings");
  assertEquals(
    renderDeprecatedApiSummary([12, 3]),
    "Deprecated-API scan complete. Filed 2 issues: #3, #12",
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
  const t = createDeprecatedApiTemplate({
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
    "Deprecated-API scan complete. Filed 2 issues: #7, #9",
  );
  // Label ensured before the scan.
  assertEquals(ensureCalls, ["acme/widget"]);
  // Known-open ids flow into the scan runner.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  // The label-scoped snapshot query was issued.
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(DEPRECATED_API_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDeprecatedApiTemplate({
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
  assertStringIncludes(result.summary, "deprecated-api failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createDeprecatedApiTemplate({
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

Deno.test("runTask - threw path is caught and surfaced", async () => {
  // ensureLabelFn throws synchronously — runTask must catch and report.
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDeprecatedApiTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => {
      throw new Error("kaboom");
    },
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "deprecated-api threw");
  assertStringIncludes(result.summary, "kaboom");
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a deprecated-api wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createDeprecatedApiTemplate({
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
      issueTitle: DEPRECATED_API_ISSUE_TITLE,
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
    "Deprecated-API scan complete. Filed 1 issues: #11",
  );
});
