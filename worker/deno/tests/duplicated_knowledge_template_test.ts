/**
 * Tests for the duplicated-knowledge idle-task template
 * (stSoftwareAU/VibeCoder#3609, template #17).
 *
 * Coverage:
 *   - registration: registered at module load and found by
 *     `getTemplate("duplicated-knowledge")` / `listTemplates()`
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "duplicated-knowledge",
 *     requiresStructuredOutput === true
 *   - title is the literal "Run a duplicated-knowledge scan" (dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and the
 *     body fingerprint, and leaves no raw `{{...}}` placeholders
 *   - assembleDuplicatedKnowledgePrompt substitutes both dedup lists, the
 *     pre-pass block list, and the attribution footer, with the `(none)`
 *     sentinel for every empty input
 *   - shouldFile vetoes while a wrapper is still open, allows otherwise
 *   - runTask happy path (label ensured, snapshot diffed, known-open ids
 *     handed to the scan), error path (scan failure → ok:false), and edge
 *     cases (empty diff → "no findings"; a thrown gh error → ok:false)
 *   - claim handler dispatches a wrapper to runTask
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleDuplicatedKnowledgePrompt,
  createDuplicatedKnowledgeTemplate,
  DUPLICATED_KNOWLEDGE_BODY_FINGERPRINT,
  DUPLICATED_KNOWLEDGE_ISSUE_TITLE,
  DUPLICATED_KNOWLEDGE_LABEL,
  duplicatedKnowledgeTemplate,
  renderDuplicatedKnowledgeSummary,
} from "../lib/idle_task_templates/duplicated_knowledge_template.ts";
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
  "# Duplicated-Knowledge — Copy-Paste Blocks That Should Call a Helper (v1)",
  "",
  "Suppressed ids:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open finding ids:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
  "",
  "Candidate duplicate blocks:",
  "{{DUPLICATE_BLOCKS}}",
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
 * gh stub. Distinguishes the two snapshot calls (`--json number`) from the
 * known-open lookup (`--json number,body,author`) and the open-wrapper veto
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

Deno.test("duplicated-knowledge - registered at module load", () => {
  const t = getTemplate("duplicated-knowledge");
  assert(t !== undefined, "expected duplicated-knowledge registered");
  assertEquals(t, duplicatedKnowledgeTemplate);
  assert(
    listTemplates().some((x) => x.name === "duplicated-knowledge"),
    "expected listTemplates() to include duplicated-knowledge",
  );
});

Deno.test("duplicated-knowledge - contract flags", () => {
  assertEquals(duplicatedKnowledgeTemplate.cooldownHours, 168);
  assertEquals(duplicatedKnowledgeTemplate.skipMilestone, true);
  assertEquals(
    duplicatedKnowledgeTemplate.outputLabel,
    DUPLICATED_KNOWLEDGE_LABEL,
  );
  assertEquals(duplicatedKnowledgeTemplate.requiresStructuredOutput, true);
  assertEquals(
    duplicatedKnowledgeTemplate.buildIssueTitle("acme/widget"),
    DUPLICATED_KNOWLEDGE_ISSUE_TITLE,
  );
});

Deno.test("duplicated-knowledge - buildIssueBody matches title and fingerprint", async () => {
  const t = createDuplicatedKnowledgeTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-31T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    DUPLICATED_KNOWLEDGE_ISSUE_TITLE,
  );
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(DUPLICATED_KNOWLEDGE_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `duplicated-knowledge`",
  );
  assertStringIncludes(body, "Run id:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleDuplicatedKnowledgePrompt - empty inputs render (none)", () => {
  const out = assembleDuplicatedKnowledgePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assert(!out.includes("{{DUPLICATE_BLOCKS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleDuplicatedKnowledgePrompt - populated lists are joined", () => {
  const out = assembleDuplicatedKnowledgePrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
    duplicateBlocks: "- 6 lines × 2 sites: lib/a.ts:1-6, lib/b.ts:9-14",
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
  assertStringIncludes(out, "lib/a.ts:1-6, lib/b.ts:9-14");
});

Deno.test("assembleDuplicatedKnowledgePrompt - attribution footer substituted", () => {
  const footer =
    "🏷️ Filed by idle-task template: `duplicated-knowledge` · Run id: `vibe-test-id`";
  const out = assembleDuplicatedKnowledgePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: footer,
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, footer);
});

Deno.test("renderDuplicatedKnowledgeSummary - wording", () => {
  assertEquals(renderDuplicatedKnowledgeSummary([]), "no findings");
  assertEquals(
    renderDuplicatedKnowledgeSummary([12, 3]),
    "Duplicated-knowledge scan complete. Filed 2 issues: #3, #12",
  );
});

// ---------------------------------------------------------------------------
// shouldFile
// ---------------------------------------------------------------------------

Deno.test("shouldFile - vetoes when an open wrapper already exists", async () => {
  const { gh } = makeGhStub({
    openWrappers: [{ number: 42, title: DUPLICATED_KNOWLEDGE_ISSUE_TITLE }],
  });
  const t = createDuplicatedKnowledgeTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    // The wrapper veto now counts a title match only when the fleet
    // authored it, so the test states the fleet rather than writing
    // a config file.
    dedupAuthors: { fleetAuthors: [FLEET_DEDUP_AUTHOR] },
    ghCommandFn: gh,
  });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), false);
});

Deno.test("shouldFile - allows when no wrapper is open", async () => {
  const { gh } = makeGhStub({ openWrappers: [] });
  const t = createDuplicatedKnowledgeTemplate({ ghCommandFn: gh });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), true);
});

Deno.test("shouldFile - a gh failure does not stall the scan", async () => {
  const t = createDuplicatedKnowledgeTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
  });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), true);
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("runTask - happy path ensures the label and diffs the snapshot", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[1, 2], [1, 2, 7, 9]],
    knownOpen: [{ number: 2, body: "<!-- finding-id: BP-existing0001 -->" }],
  });
  const ensureCalls: string[] = [];
  const scanCalls: { knownOpenFindingIds: string[]; workDir: string }[] = [];
  const t = createDuplicatedKnowledgeTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
  assertEquals(
    result.summary,
    "Duplicated-knowledge scan complete. Filed 2 issues: #7, #9",
  );
  assertEquals(ensureCalls, ["acme/widget"]);
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  assertEquals(scanCalls[0]!.workDir, "/tmp/widget");
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(DUPLICATED_KNOWLEDGE_LABEL)
    ),
    "expected the snapshot to filter on the duplicated-knowledge label",
  );
});

Deno.test("runTask - scan failure surfaces ok:false with the failure kind", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDuplicatedKnowledgeTemplate({
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
  assertStringIncludes(result.summary, "duplicated-knowledge failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - an unexpected throw fails loud rather than reporting success", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createDuplicatedKnowledgeTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
  assertStringIncludes(result.summary, "duplicated-knowledge threw");
  assertStringIncludes(result.summary, "network down");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createDuplicatedKnowledgeTemplate({
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
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a duplicated-knowledge wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createDuplicatedKnowledgeTemplate({
    dedupAuthors: DEDUP_AUTHORS,
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
      issueTitle: DUPLICATED_KNOWLEDGE_ISSUE_TITLE,
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
    "Duplicated-knowledge scan complete. Filed 1 issues: #11",
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

Deno.test("assembleDuplicatedKnowledgePrompt - open issue titles are substituted", () => {
  const out = assembleDuplicatedKnowledgePrompt(
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

Deno.test("assembleDuplicatedKnowledgePrompt - an empty open-issue list renders (none)", () => {
  const out = assembleDuplicatedKnowledgePrompt(
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
  const t = createDuplicatedKnowledgeTemplate({
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
  const t = createDuplicatedKnowledgeTemplate({
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
