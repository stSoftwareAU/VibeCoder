/**
 * Tests for the retro idle-task template
 * (stSoftwareAU/VibeCoder#664, template #18).
 *
 * Coverage:
 *   - registration: registered at module load and found by
 *     `getTemplate("retro")` / `listTemplates()`
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "retro", requiresStructuredOutput === true
 *   - title is the literal "Run a retro on a finished run" (dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and the
 *     body fingerprint, and leaves no raw `{{...}}` placeholders
 *   - assembleRetroPrompt substitutes both dedup lists and the attribution
 *     footer, with the `(none)` sentinel for every empty input
 *   - shouldFile vetoes while a wrapper is still open, allows otherwise
 *   - runTask happy path (label ensured, snapshot diffed, known-open ids and
 *     repo-wide titles handed to the scan), error path (scan failure →
 *     ok:false), and edge cases (empty diff → "no candidates"; a thrown gh
 *     error → ok:false)
 *   - claim handler dispatches a wrapper to runTask
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleRetroPrompt,
  createRetroTemplate,
  renderRetroSummary,
  RETRO_BODY_FINGERPRINT,
  RETRO_ISSUE_TITLE,
  RETRO_LABEL,
  retroTemplate,
} from "../lib/idle_task_templates/retro_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger, Result } from "../types.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Retro — Environment Improvements From a Finished Run (v1)",
  "",
  "Suppressed ids:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open finding ids:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
  "",
  "Open issues:",
  "{{OPEN_ISSUE_TITLES}}",
  "",
  "Attribution footer line every filed body MUST end with:",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

/**
 * gh stub. Distinguishes the two snapshot calls (`--json number`) from the
 * known-open lookup (`--json number,body`) and the open-wrapper veto
 * (`--json number,title`).
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
        JSON.stringify((result ?? []).map((n) => ({ number: n }))),
      );
    }
    if (jsonField === "number,body") {
      return Promise.resolve(JSON.stringify(scenario.knownOpen ?? []));
    }
    if (jsonField === "number,title") {
      return Promise.resolve(JSON.stringify(scenario.openWrappers ?? []));
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function makeLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("retro - registered at module load", () => {
  const t = getTemplate("retro");
  assert(t !== undefined, "expected retro registered");
  assertEquals(t, retroTemplate);
  assert(
    listTemplates().some((x) => x.name === "retro"),
    "expected listTemplates() to include retro",
  );
});

Deno.test("retro - contract flags", () => {
  assertEquals(retroTemplate.cooldownHours, 168);
  assertEquals(retroTemplate.skipMilestone, true);
  assertEquals(retroTemplate.outputLabel, RETRO_LABEL);
  assertEquals(retroTemplate.requiresStructuredOutput, true);
  assertEquals(retroTemplate.buildIssueTitle("acme/widget"), RETRO_ISSUE_TITLE);
});

Deno.test("retro - buildIssueBody matches title and fingerprint", async () => {
  const t = createRetroTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-08-31T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(t.buildIssueTitle("acme/widget"), RETRO_ISSUE_TITLE);
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(RETRO_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  assertStringIncludes(body, "🏷️ Filed by idle-task template: `retro`");
  assertStringIncludes(body, "Run id:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleRetroPrompt - empty inputs render (none)", () => {
  const out = assembleRetroPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleRetroPrompt - populated lists are joined", () => {
  const out = assembleRetroPrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("assembleRetroPrompt - open issue titles are substituted", () => {
  const out = assembleRetroPrompt("Already open:\n{{OPEN_ISSUE_TITLES}}", {
    suppressedIds: [],
    knownOpenFindingIds: [],
    openIssueTitles: [
      { number: 37, title: "AGENTS.md is too large" },
      { number: 64, title: "Steering file should point at the README" },
    ],
  });
  assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
  assertStringIncludes(out, "#37 — AGENTS.md is too large");
  assertStringIncludes(out, "#64 — Steering file should point at the README");
});

Deno.test("assembleRetroPrompt - an empty open-issue list renders (none)", () => {
  const out = assembleRetroPrompt("Already open:\n{{OPEN_ISSUE_TITLES}}", {
    suppressedIds: [],
    knownOpenFindingIds: [],
    openIssueTitles: [],
  });
  assertEquals(out, "Already open:\n(none)");
});

Deno.test("assembleRetroPrompt - attribution footer substituted", () => {
  const footer =
    "🏷️ Filed by idle-task template: `retro` · Run id: `vibe-test-id`";
  const out = assembleRetroPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: footer,
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, footer);
});

Deno.test("renderRetroSummary - wording", () => {
  assertEquals(renderRetroSummary([]), "no candidates");
  assertEquals(renderRetroSummary([7]), "Retro complete. Filed 1 issue: #7");
  assertEquals(
    renderRetroSummary([12, 3]),
    "Retro complete. Filed 2 issues: #3, #12",
  );
});

// ---------------------------------------------------------------------------
// shouldFile
// ---------------------------------------------------------------------------

Deno.test("retro shouldFile - vetoes when an open wrapper already exists", async () => {
  const { gh } = makeGhStub({
    openWrappers: [{ number: 42, title: RETRO_ISSUE_TITLE }],
  });
  const t = createRetroTemplate({ ghCommandFn: gh });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), false);
});

Deno.test("retro shouldFile - allows when no wrapper is open", async () => {
  const { gh } = makeGhStub({ openWrappers: [] });
  const t = createRetroTemplate({ ghCommandFn: gh });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), true);
});

Deno.test("retro shouldFile - a gh failure does not stall the scan", async () => {
  const t = createRetroTemplate({
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
  });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), true);
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("retro runTask - happy path ensures the label and diffs the snapshot", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[1, 2], [1, 2, 7]],
    knownOpen: [{ number: 2, body: "<!-- finding-id: BP-existing0001 -->" }],
  });
  const ensureCalls: string[] = [];
  const scanCalls: { knownOpenFindingIds: string[]; workDir: string }[] = [];
  const t = createRetroTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: (repo) => {
      ensureCalls.push(repo);
      return Promise.resolve({ ok: true, value: undefined });
    },
    runScanFn: (opts) => {
      scanCalls.push({
        knownOpenFindingIds: opts.knownOpenFindingIds,
        workDir: opts.workDir,
      });
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "Retro complete. Filed 1 issue: #7");
  assertEquals(ensureCalls, ["acme/widget"]);
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  assertEquals(scanCalls[0]!.workDir, "/tmp/widget");
  assert(
    calls.some((c) => c.includes("--label") && c.includes(RETRO_LABEL)),
    "expected the snapshot to filter on the retro label",
  );
});

Deno.test("retro runTask - scan failure surfaces ok:false with the failure kind", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createRetroTemplate({
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
  assertStringIncludes(result.summary, "retro failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("retro runTask - an unexpected throw fails loud rather than reporting success", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createRetroTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.reject(new Error("network down")),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "retro threw");
  assertStringIncludes(result.summary, "network down");
});

Deno.test("retro runTask - empty diff reports no candidates", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createRetroTemplate({
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
  assertEquals(result.summary, "no candidates");
});

/**
 * gh stub for the repo-wide open-issue title lookup — `issue list --json
 * number,title` with neither `--label` nor `--search`. Every other call
 * returns an empty list. `fail` makes the title lookup (and only that
 * lookup) throw.
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

Deno.test("retro runTask - repo-wide open issue titles reach the scan runner", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createRetroTemplate({
    ghCommandFn: makeTitleGhStub([
      { number: 37, title: "AGENTS.md is too large" },
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
  assertEquals(seen, [[{ number: 37, title: "AGENTS.md is too large" }]]);
});

Deno.test("retro runTask - a gh failure listing titles degrades to an empty list", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createRetroTemplate({
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

  assertEquals(result.ok, true);
  assertEquals(seen, [[]]);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a retro wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createRetroTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });
  const deps: HandleIdleTaskIssueDeps = {
    logger: makeLogger(),
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 100,
      issueTitle: RETRO_ISSUE_TITLE,
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "irrelevant",
      workDir: "/tmp/widget",
    },
    deps,
  );

  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertEquals(result.summary, "Retro complete. Filed 1 issue: #11");
});
