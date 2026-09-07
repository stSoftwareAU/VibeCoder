/**
 * Tests for the dead-code & unused-export idle-task template
 * (Issue #2912, parent #2903, Boy Scout check #1).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("dead-code")` / `listTemplates()` find it
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "dead-code", requiresStructuredOutput === true
 *   - title is the literal "Run a dead-code & unused-export scan" (used
 *     for dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and the
 *     body fingerprint, and leaves no raw `{{...}}` placeholders
 *   - assembleDeadCodePrompt substitutes placeholders / `(none)` sentinel
 *   - runTask happy path: ensures the `dead-code` label before the scan,
 *     and returns the before/after diff summary
 *   - runTask error path: runScanFn failure → ok:false summary
 *   - runTask edge case: empty before/after diff → "no findings"
 *   - claim handler dispatches a "Run a dead-code & unused-export scan"
 *     wrapper to runTask
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleDeadCodePrompt,
  createDeadCodeTemplate,
  DEAD_CODE_BODY_FINGERPRINT,
  DEAD_CODE_ISSUE_TITLE,
  DEAD_CODE_LABEL,
  deadCodeTemplate,
  renderDeadCodeSummary,
} from "../lib/idle_task_templates/dead_code_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger } from "../types.ts";
import type { Result } from "../types.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";

/**
 * The fleet identity the finding-id dedup verifies against (Issue #1243).
 *
 * The stubbed known-open issues are ones the fleet filed, so they carry a
 * fleet login and the template is handed the same fleet inline rather than
 * reading a config file.
 */
const FLEET_DEDUP_AUTHOR = "vibe-bot";
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Dead-Code & Unused-Export Scan (v1)",
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
 * known-open lookup (`--json number,body,author`). The before/after snapshots
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

Deno.test("dead-code - registered at module load", () => {
  const t = getTemplate("dead-code");
  assert(t !== undefined, "expected dead-code template to be registered");
  assertEquals(t, deadCodeTemplate);
  assert(
    listTemplates().some((x) => x.name === "dead-code"),
    "expected listTemplates() to include dead-code",
  );
});

Deno.test("dead-code - contract flags", () => {
  assertEquals(deadCodeTemplate.cooldownHours, 168);
  assertEquals(deadCodeTemplate.skipMilestone, true);
  assertEquals(deadCodeTemplate.outputLabel, DEAD_CODE_LABEL);
  assertEquals(deadCodeTemplate.requiresStructuredOutput, true);
  assertEquals(
    deadCodeTemplate.buildIssueTitle("acme/widget"),
    DEAD_CODE_ISSUE_TITLE,
  );
});

Deno.test("dead-code - buildIssueBody matches title and fingerprint", async () => {
  const t = createDeadCodeTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-06-18T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  // Title match (dispatch signal #2).
  assertEquals(t.buildIssueTitle("acme/widget"), DEAD_CODE_ISSUE_TITLE);
  // Body fingerprint (dispatch signal #3).
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(DEAD_CODE_BODY_FINGERPRINT.test(body));
  // No raw placeholders survive — they collapse to the (none) sentinel.
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  // Issue #2439 — attribution footer is substituted, names the template,
  // and survives intact in the wrapper body.
  assertStringIncludes(body, "🏷️ Filed by idle-task template: `dead-code`");
  assertStringIncludes(body, "Run id:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleDeadCodePrompt - empty lists render (none)", () => {
  const out = assembleDeadCodePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleDeadCodePrompt - attribution footer is substituted", () => {
  const footer =
    "🏷️ Filed by idle-task template: `dead-code` · Run id: `vibe-test-id`";
  const out = assembleDeadCodePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: footer,
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, footer);
});

Deno.test("assembleDeadCodePrompt - populated lists are joined", () => {
  const out = assembleDeadCodePrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("renderDeadCodeSummary - wording", () => {
  assertEquals(renderDeadCodeSummary([]), "no findings");
  assertEquals(
    renderDeadCodeSummary([12, 3]),
    "Dead-code scan complete. Filed 2 issues: #3, #12",
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
  const t = createDeadCodeTemplate({
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
    "Dead-code scan complete. Filed 2 issues: #7, #9",
  );
  // Label ensured before the scan.
  assertEquals(ensureCalls, ["acme/widget"]);
  // Known-open ids flow into the scan runner.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  // The label-scoped snapshot query was issued.
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(DEAD_CODE_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDeadCodeTemplate({
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
  assertStringIncludes(result.summary, "dead-code failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createDeadCodeTemplate({
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

Deno.test("runTask - threw path is caught and surfaced", async () => {
  // ensureLabelFn throws synchronously — runTask must catch and report.
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDeadCodeTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
  assertStringIncludes(result.summary, "dead-code threw");
  assertStringIncludes(result.summary, "kaboom");
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a dead-code wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createDeadCodeTemplate({
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
      issueTitle: DEAD_CODE_ISSUE_TITLE,
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
    "Dead-code scan complete. Filed 1 issues: #11",
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

Deno.test("assembleDeadCodePrompt - open issue titles are substituted", () => {
  const out = assembleDeadCodePrompt("Already open:\n{{OPEN_ISSUE_TITLES}}", {
    suppressedIds: [],
    knownOpenFindingIds: [],
    openIssueTitles: [
      { number: 37, title: "Add a CODEOWNERS file" },
      { number: 64, title: "Repo has no CODEOWNERS" },
    ],
  });
  assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
  assertStringIncludes(out, "#37 — Add a CODEOWNERS file");
  assertStringIncludes(out, "#64 — Repo has no CODEOWNERS");
});

Deno.test("assembleDeadCodePrompt - an empty open-issue list renders (none)", () => {
  const out = assembleDeadCodePrompt("Already open:\n{{OPEN_ISSUE_TITLES}}", {
    suppressedIds: [],
    knownOpenFindingIds: [],
    openIssueTitles: [],
  });
  assertEquals(out, "Already open:\n(none)");
});

Deno.test("runTask - repo-wide open issue titles reach the scan runner", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createDeadCodeTemplate({
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
  const t = createDeadCodeTemplate({
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
