/**
 * Tests for the orphan-dependency idle-task template
 * (Issue #2904, template #6).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("orphan-deps")` / `listTemplates()` find it (the draw
 *     becomes uniform 1/6).
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "orphan-deps", requiresStructuredOutput === true.
 *   - title is the literal "Run an orphan-dependency scan" (used for
 *     dispatch).
 *   - buildIssueBody output is recognised by BOTH the title match and
 *     the body fingerprint, leaves no raw `{{...}}` placeholders, and
 *     carries the attribution footer.
 *   - assembleOrphanDepsPrompt substitutes placeholders / `(none)`
 *     sentinel and the attribution footer.
 *   - runTask happy path: ensures the `orphan-deps` label before the
 *     scan, and returns the before/after diff summary.
 *   - runTask error path: runScanFn failure → ok:false summary.
 *   - runTask edge case: empty before/after diff → "no findings".
 *   - runTask passes known-open finding ids to the scan runner so Claude
 *     does not re-emit them (suppression-on-re-run path).
 *   - shouldFile vetoes while an open wrapper exists.
 *   - claim handler dispatches a "Run an orphan-dependency scan" wrapper
 *     to runTask.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleOrphanDepsPrompt,
  createOrphanDepsTemplate,
  ORPHAN_DEPS_BODY_FINGERPRINT,
  ORPHAN_DEPS_ISSUE_TITLE,
  ORPHAN_DEPS_LABEL,
  orphanDepsTemplate,
  renderOrphanDepsSummary,
} from "../lib/idle_task_templates/orphan_deps_template.ts";
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
  "# Orphan-Dependency Scan — Unmaintained / Abandoned Dependency Audit (v1)",
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

/** A fleet login, so a stubbed wrapper reads as one the fleet filed. */
const FLEET_DEDUP_AUTHOR = "vibe-bot";

/** The fleet the finding-id dedup verifies against (Issue #1243). */
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * gh stub. Distinguishes the snapshot calls (`--json number`), the
 * known-open lookup (`--json number,body,author`), and the wrapper-veto title
 * search (`--json number,title`). Snapshot calls return the
 * first/second entry of `snapshots`.
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
      const titles = scenario.openWrapperTitles ?? [];
      return Promise.resolve(
        JSON.stringify(
          titles.map((title, i) => ({
            number: i + 1,
            title,
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

Deno.test("orphan-deps - registered at module load", () => {
  const t = getTemplate("orphan-deps");
  assert(t !== undefined, "expected orphan-deps template to be registered");
  assertEquals(t, orphanDepsTemplate);
  assert(
    listTemplates().some((x) => x.name === "orphan-deps"),
    "expected listTemplates() to include orphan-deps",
  );
});

Deno.test("orphan-deps - contract flags", () => {
  assertEquals(orphanDepsTemplate.cooldownHours, 168);
  assertEquals(orphanDepsTemplate.skipMilestone, true);
  assertEquals(orphanDepsTemplate.outputLabel, ORPHAN_DEPS_LABEL);
  assertEquals(orphanDepsTemplate.requiresStructuredOutput, true);
  assertEquals(
    orphanDepsTemplate.buildIssueTitle("acme/widget"),
    ORPHAN_DEPS_ISSUE_TITLE,
  );
});

Deno.test("orphan-deps - buildIssueBody matches title and fingerprint", async () => {
  const t = createOrphanDepsTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-05-25T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  // Title match (dispatch signal #2).
  assertEquals(t.buildIssueTitle("acme/widget"), ORPHAN_DEPS_ISSUE_TITLE);
  // Body fingerprint (dispatch signal #3).
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(ORPHAN_DEPS_BODY_FINGERPRINT.test(body));
  // No raw placeholders survive — they collapse to the (none) sentinel.
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  // Attribution footer is present.
  assertStringIncludes(body, "Filed by idle-task template:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleOrphanDepsPrompt - empty lists render (none)", () => {
  const out = assembleOrphanDepsPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleOrphanDepsPrompt - populated lists and footer are substituted", () => {
  const out = assembleOrphanDepsPrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
    attributionFooter: "FOOTER-LINE",
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
  assertStringIncludes(out, "FOOTER-LINE");
});

Deno.test("renderOrphanDepsSummary - wording", () => {
  assertEquals(renderOrphanDepsSummary([]), "no findings");
  assertEquals(
    renderOrphanDepsSummary([12, 3]),
    "Orphan-dependency scan complete. Filed 2 issues: #3, #12",
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
  const t = createOrphanDepsTemplate({
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
    "Orphan-dependency scan complete. Filed 2 issues: #7, #9",
  );
  // Label ensured before the scan.
  assertEquals(ensureCalls, ["acme/widget"]);
  // Known-open ids flow into the scan runner so the dedup rule drops them.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  // The label-scoped snapshot query was issued.
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(ORPHAN_DEPS_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - in-source suppressed ids flow into the scan", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const scanCalls: { suppressedIds: string[] }[] = [];
  const collectCalls: string[] = [];
  const t = createOrphanDepsTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    collectSuppressedIdsFn: (workDir) => {
      collectCalls.push(workDir);
      return Promise.resolve(["BP-suppressed01"]);
    },
    runScanFn: (opts) => {
      scanCalls.push({ suppressedIds: opts.suppressedIds });
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  // Issue #3292: the collector is handed the repo's own checkout
  // (`${workDir}/${repoName}`), not the parent work dir that holds every
  // clone — the manifest allow-list lives under the repo root.
  assertEquals(collectCalls, ["/tmp/widget/widget"]);
  // The suppressed ids reach the scan runner so the finding is dropped.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.suppressedIds, ["BP-suppressed01"]);
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createOrphanDepsTemplate({
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
  assertStringIncludes(result.summary, "orphan-deps failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createOrphanDepsTemplate({
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

Deno.test("shouldFile - vetoes while an open wrapper exists", async () => {
  const { gh } = makeGhStub({
    openWrapperTitles: [ORPHAN_DEPS_ISSUE_TITLE],
  });
  const t = createOrphanDepsTemplate({
    // The wrapper veto now counts a title match only when the fleet
    // authored it, so the test states the fleet rather than writing
    // a config file.
    dedupAuthors: { fleetAuthors: [FLEET_DEDUP_AUTHOR] },
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
  });
  const allowed = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(allowed, false);
});

Deno.test("shouldFile - allows filing when no open wrapper exists", async () => {
  const { gh } = makeGhStub({ openWrapperTitles: [] });
  const t = createOrphanDepsTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
  });
  const allowed = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(allowed, true);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches an orphan-deps wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createOrphanDepsTemplate({
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
      issueTitle: ORPHAN_DEPS_ISSUE_TITLE,
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
    "Orphan-dependency scan complete. Filed 1 issues: #11",
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

Deno.test("assembleOrphanDepsPrompt - open issue titles are substituted", () => {
  const out = assembleOrphanDepsPrompt("Already open:\n{{OPEN_ISSUE_TITLES}}", {
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

Deno.test("assembleOrphanDepsPrompt - an empty open-issue list renders (none)", () => {
  const out = assembleOrphanDepsPrompt("Already open:\n{{OPEN_ISSUE_TITLES}}", {
    suppressedIds: [],
    knownOpenFindingIds: [],
    openIssueTitles: [],
  });
  assertEquals(out, "Already open:\n(none)");
});

Deno.test("runTask - repo-wide open issue titles reach the scan runner", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createOrphanDepsTemplate({
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
  const t = createOrphanDepsTemplate({
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
