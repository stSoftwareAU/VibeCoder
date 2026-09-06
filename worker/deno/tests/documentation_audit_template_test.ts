/**
 * Tests for the documentation-audit idle-task template (Issue #3319,
 * template #13).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("documentation-audit")` / `listTemplates()` find it
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "documentation-audit",
 *     requiresStructuredOutput === true
 *   - title is the literal "Run a documentation audit" (used for dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and
 *     the body fingerprint, and leaves no raw `{{...}}` placeholders
 *   - assembleDocumentationAuditPrompt substitutes placeholders / `(none)`
 *     sentinel and the attribution footer
 *   - runTask happy path: ensures the label before the scan, and returns
 *     the before/after diff summary
 *   - runTask error path: runScanFn failure → ok:false summary
 *   - runTask edge case: empty before/after diff → "no findings"
 *   - shouldFile vetoes when an open wrapper already exists
 *   - claim handler dispatches a "Run a documentation audit" wrapper to
 *     runTask
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleDocumentationAuditPrompt,
  createDocumentationAuditTemplate,
  DOCUMENTATION_AUDIT_BODY_FINGERPRINT,
  DOCUMENTATION_AUDIT_ISSUE_TITLE,
  DOCUMENTATION_AUDIT_LABEL,
  documentationAuditTemplate,
  renderDocumentationAuditSummary,
} from "../lib/idle_task_templates/documentation_audit_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger } from "../types.ts";
import type { Result } from "../types.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Documentation Audit — Unify Learnings, Prune Stale Docs (v1)",
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

/** A fleet login, so a stubbed wrapper reads as one the fleet filed. */
const FLEET_DEDUP_AUTHOR = "vibe-bot";

/** The fleet the finding-id dedup verifies against (Issue #1243). */
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * gh stub. Distinguishes the two snapshot calls (`--json number`) from
 * the known-open lookup (`--json number,body,author`) and the open-wrapper veto
 * (`--json number,title`). The before/after snapshots return the
 * first/second entry of `snapshots`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  knownOpen?: Array<{ number: number; body: string }>;
  openWrappers?: Array<{ number: number; title: string }>;
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
    if (jsonField === "number,body,author") {
      // Author-verified dedup (Issue #1243): only a fleet-authored
      // finding-id marker counts as an already-filed finding.
      return Promise.resolve(
        JSON.stringify(
          (scenario.knownOpen ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    // The wrapper-veto search now also asks for `author`, because a
    // title alone is text anybody may write and only the author is
    // authenticated. The stub answers as a fleet account so the veto
    // under test is a genuine fleet-filed wrapper.
    if (jsonField === "number,title" || (jsonField ?? "").includes("author")) {
      return Promise.resolve(
        JSON.stringify(
          (scenario.openWrappers ?? []).map((w) => ({
            ...w,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
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

Deno.test("documentation-audit - registered at module load", () => {
  const t = getTemplate("documentation-audit");
  assert(t !== undefined, "expected documentation-audit template registered");
  assertEquals(t, documentationAuditTemplate);
  assert(
    listTemplates().some((x) => x.name === "documentation-audit"),
    "expected listTemplates() to include documentation-audit",
  );
});

Deno.test("documentation-audit - contract flags", () => {
  assertEquals(documentationAuditTemplate.cooldownHours, 168);
  assertEquals(documentationAuditTemplate.skipMilestone, true);
  assertEquals(
    documentationAuditTemplate.outputLabel,
    DOCUMENTATION_AUDIT_LABEL,
  );
  assertEquals(documentationAuditTemplate.requiresStructuredOutput, true);
  assertEquals(
    documentationAuditTemplate.buildIssueTitle("acme/widget"),
    DOCUMENTATION_AUDIT_ISSUE_TITLE,
  );
});

Deno.test("documentation-audit - buildIssueBody matches title and fingerprint", async () => {
  const t = createDocumentationAuditTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-10T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  // Title match (dispatch signal #2).
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    DOCUMENTATION_AUDIT_ISSUE_TITLE,
  );
  // Body fingerprint (dispatch signal #3).
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(DOCUMENTATION_AUDIT_BODY_FINGERPRINT.test(body));
  // No raw placeholders survive — they collapse to the (none) sentinel.
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  // Issue #2439 — attribution footer is substituted, names the template.
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `documentation-audit`",
  );
  assertStringIncludes(body, "Run id:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleDocumentationAuditPrompt - empty lists render (none)", () => {
  const out = assembleDocumentationAuditPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleDocumentationAuditPrompt - attribution footer substituted", () => {
  const footer =
    "🏷️ Filed by idle-task template: `documentation-audit` · Run id: `vibe-test-id`";
  const out = assembleDocumentationAuditPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: footer,
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, footer);
});

Deno.test("assembleDocumentationAuditPrompt - populated lists are joined", () => {
  const out = assembleDocumentationAuditPrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("renderDocumentationAuditSummary - wording", () => {
  assertEquals(renderDocumentationAuditSummary([]), "no findings");
  assertEquals(
    renderDocumentationAuditSummary([12, 3]),
    "Documentation audit complete. Filed 2 issues: #3, #12",
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
  const t = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
    "Documentation audit complete. Filed 2 issues: #7, #9",
  );
  // Label ensured before the scan.
  assertEquals(ensureCalls, ["acme/widget"]);
  // Known-open ids flow into the scan runner.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  // The label-scoped snapshot query was issued.
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(DOCUMENTATION_AUDIT_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
  assertStringIncludes(result.summary, "documentation-audit failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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

Deno.test("shouldFile - vetoes when an open wrapper already exists", async () => {
  const { gh } = makeGhStub({
    openWrappers: [
      { number: 42, title: DOCUMENTATION_AUDIT_ISSUE_TITLE },
    ],
  });
  const t = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    // The wrapper veto now counts a title match only when the fleet
    // authored it, so the test states the fleet rather than writing
    // a config file.
    dedupAuthors: { fleetAuthors: [FLEET_DEDUP_AUTHOR] },
    ghCommandFn: gh,
  });
  const decision = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(decision, false);
});

Deno.test("shouldFile - allows filing when no open wrapper exists", async () => {
  const { gh } = makeGhStub({ openWrappers: [] });
  const t = createDocumentationAuditTemplate({ ghCommandFn: gh });
  const decision = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(decision, true);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a documentation-audit wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
      issueTitle: DOCUMENTATION_AUDIT_ISSUE_TITLE,
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
    "Documentation audit complete. Filed 1 issues: #11",
  );
});

// ---------------------------------------------------------------------------
// Repo-wide open-issue titles (Issue #537)
// ---------------------------------------------------------------------------

/**
 * gh stub for the repo-wide open-issue title lookup — `issue list --json
 * number,title` with neither `--label` nor `--search`. Every other call
 * returns an empty list, so the snapshot diff stays empty and the only
 * behaviour under test is what reaches the scan runner. `fail` makes the
 * title lookup (and only that lookup) throw.
 */
function makeTitleGhStub(
  titles: Array<{ number: number; title: string }>,
  fail = false,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (
      jsonField === "number,title" && !args.includes("--label") &&
      !args.includes("--search")
    ) {
      return fail
        ? Promise.reject(new Error("gh: rate limited"))
        : Promise.resolve(JSON.stringify(titles));
    }
    return Promise.resolve("[]");
  };
}

Deno.test("assembleDocumentationAuditPrompt - open issue titles are substituted", () => {
  const out = assembleDocumentationAuditPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    {
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [
        { number: 37, title: "Add a CODEOWNERS file" },
        { number: 64, title: "Repo has no CODEOWNERS" },
      ],
    },
  );
  assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
  assertStringIncludes(out, "#37 — Add a CODEOWNERS file");
  assertStringIncludes(out, "#64 — Repo has no CODEOWNERS");
});

Deno.test("assembleDocumentationAuditPrompt - an empty open-issue list renders (none)", () => {
  const out = assembleDocumentationAuditPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    {
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [],
    },
  );
  assertEquals(out, "Already open:\n(none)");
});

Deno.test("runTask - repo-wide open issue titles reach the scan runner", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([
      { number: 37, title: "Add a CODEOWNERS file" },
    ]),
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: (opts) => {
      seen.push(opts.openIssueTitles);
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(seen, [[{ number: 37, title: "Add a CODEOWNERS file" }]]);
});

Deno.test("runTask - a gh failure listing titles degrades to an empty list", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createDocumentationAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([], true),
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: (opts) => {
      seen.push(opts.openIssueTitles);
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  // The scan still ran, with the `(none)` sentinel's empty list.
  assertEquals(result.ok, true);
  assertEquals(seen, [[]]);
});
