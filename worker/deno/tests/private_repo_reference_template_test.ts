/**
 * Tests for the private-repo-reference-audit idle-task template
 * (Issue #3549, template #16).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("private-repo-reference-audit")` / `listTemplates()`
 *     find it
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "private-repo-reference",
 *     requiresStructuredOutput === true
 *   - title is the literal "Run a private-repo reference audit" (dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and the
 *     body fingerprint, and leaves no raw `{{...}}` placeholders
 *   - assemblePrivateRepoReferencePrompt substitutes placeholders / the
 *     `(none)` sentinel and the attribution footer
 *   - isPublicRepo gate: public → true; private → false; lookup error →
 *     false (fail closed)
 *   - shouldFile: vetoes on a private repo, vetoes when a wrapper is open,
 *     allows on a public repo with no open wrapper
 *   - runTask happy path (public): ensures the label, diffs snapshot
 *   - runTask public-only gate: a private repo short-circuits ok with a
 *     "skipped" summary and NEVER invokes the scan
 *   - runTask error path: runScanFn failure → ok:false summary
 *   - runTask edge case: empty before/after diff → "no findings"
 *   - claim handler dispatches a wrapper to runTask
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assemblePrivateRepoReferencePrompt,
  createPrivateRepoReferenceTemplate,
  isPublicRepo,
  PRIVATE_REPO_REFERENCE_BODY_FINGERPRINT,
  PRIVATE_REPO_REFERENCE_ISSUE_TITLE,
  PRIVATE_REPO_REFERENCE_LABEL,
  privateRepoReferenceTemplate,
  renderPrivateRepoReferenceSummary,
} from "../lib/idle_task_templates/private_repo_reference_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger } from "../types.ts";
import type { Result } from "../types.ts";
import type { RepoVisibility } from "../lib/repo_visibility.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Private-Repo Reference Audit — Public Repos Must Not Reference Private " +
  "Repos (v1)",
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

/** Visibility stub factory. */
const visibility = (
  v: RepoVisibility,
): (repo: string) => Promise<Result<RepoVisibility, string>> =>
() => Promise.resolve({ ok: true, value: v });

const visibilityError: (
  repo: string,
) => Promise<Result<RepoVisibility, string>> = () =>
  Promise.resolve({ ok: false, error: "network down" });

/** A fleet login, so a stubbed wrapper reads as one the fleet filed. */
const FLEET_DEDUP_AUTHOR = "vibe-bot";

/** The fleet the finding-id dedup verifies against (Issue #1243). */
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * gh stub. Distinguishes the two snapshot calls (`--json number`) from the
 * known-open lookup (`--json number,body,author`) and the open-wrapper veto
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

Deno.test("private-repo-reference-audit - registered at module load", () => {
  const t = getTemplate("private-repo-reference-audit");
  assert(t !== undefined, "expected private-repo-reference-audit registered");
  assertEquals(t, privateRepoReferenceTemplate);
  assert(
    listTemplates().some((x) => x.name === "private-repo-reference-audit"),
    "expected listTemplates() to include private-repo-reference-audit",
  );
});

Deno.test("private-repo-reference-audit - contract flags", () => {
  assertEquals(privateRepoReferenceTemplate.cooldownHours, 168);
  assertEquals(privateRepoReferenceTemplate.skipMilestone, true);
  assertEquals(
    privateRepoReferenceTemplate.outputLabel,
    PRIVATE_REPO_REFERENCE_LABEL,
  );
  assertEquals(privateRepoReferenceTemplate.requiresStructuredOutput, true);
  assertEquals(
    privateRepoReferenceTemplate.buildIssueTitle("acme/widget"),
    PRIVATE_REPO_REFERENCE_ISSUE_TITLE,
  );
});

Deno.test("private-repo-reference-audit - buildIssueBody matches title and fingerprint", async () => {
  const t = createPrivateRepoReferenceTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-10T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    PRIVATE_REPO_REFERENCE_ISSUE_TITLE,
  );
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(PRIVATE_REPO_REFERENCE_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `private-repo-reference-audit`",
  );
  assertStringIncludes(body, "Run id:");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assemblePrivateRepoReferencePrompt - empty lists render (none)", () => {
  const out = assemblePrivateRepoReferencePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assemblePrivateRepoReferencePrompt - attribution footer substituted", () => {
  const footer =
    "🏷️ Filed by idle-task template: `private-repo-reference-audit` · Run id: `vibe-test-id`";
  const out = assemblePrivateRepoReferencePrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
    attributionFooter: footer,
  });
  assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
  assertStringIncludes(out, footer);
});

Deno.test("assemblePrivateRepoReferencePrompt - populated lists are joined", () => {
  const out = assemblePrivateRepoReferencePrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("renderPrivateRepoReferenceSummary - wording", () => {
  assertEquals(renderPrivateRepoReferenceSummary([]), "no findings");
  assertEquals(
    renderPrivateRepoReferenceSummary([12, 3]),
    "Private-repo reference audit complete. Filed 2 issues: #3, #12",
  );
});

// ---------------------------------------------------------------------------
// Public-only gate — isPublicRepo
// ---------------------------------------------------------------------------

Deno.test("isPublicRepo - public → true", async () => {
  assertEquals(await isPublicRepo("acme/widget", visibility("public")), true);
});

Deno.test("isPublicRepo - private → false", async () => {
  assertEquals(await isPublicRepo("acme/widget", visibility("private")), false);
});

Deno.test("isPublicRepo - lookup error → false (fail closed)", async () => {
  assertEquals(await isPublicRepo("acme/widget", visibilityError), false);
});

// ---------------------------------------------------------------------------
// shouldFile
// ---------------------------------------------------------------------------

Deno.test("shouldFile - vetoes on a private repo", async () => {
  const { gh, calls } = makeGhStub({ openWrappers: [] });
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    getVisibilityFn: visibility("private"),
  });
  assertEquals(await t.shouldFile!({ repo: "acme/private" }), false);
  // The visibility gate short-circuits before any wrapper lookup.
  assertEquals(calls.length, 0);
});

Deno.test("shouldFile - vetoes when an open wrapper already exists", async () => {
  const { gh } = makeGhStub({
    openWrappers: [
      { number: 42, title: PRIVATE_REPO_REFERENCE_ISSUE_TITLE },
    ],
  });
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    // The wrapper veto now counts a title match only when the fleet
    // authored it, so the test states the fleet rather than writing
    // a config file.
    dedupAuthors: { fleetAuthors: [FLEET_DEDUP_AUTHOR] },
    ghCommandFn: gh,
    getVisibilityFn: visibility("public"),
  });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), false);
});

Deno.test("shouldFile - allows on a public repo with no open wrapper", async () => {
  const { gh } = makeGhStub({ openWrappers: [] });
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    getVisibilityFn: visibility("public"),
  });
  assertEquals(await t.shouldFile!({ repo: "acme/widget" }), true);
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("runTask - happy path (public) ensures label and diffs snapshot", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[1, 2], [1, 2, 7, 9]],
    knownOpen: [{ number: 2, body: "<!-- finding-id: BP-existing0001 -->" }],
  });
  const ensureCalls: string[] = [];
  const scanCalls: { knownOpenFindingIds: string[] }[] = [];
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("public"),
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
    "Private-repo reference audit complete. Filed 2 issues: #7, #9",
  );
  assertEquals(ensureCalls, ["acme/widget"]);
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(PRIVATE_REPO_REFERENCE_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - private repo short-circuits without scanning (public-only gate)", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  let scanInvoked = false;
  let labelEnsured = false;
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("private"),
    ensureLabelFn: () => {
      labelEnsured = true;
      return Promise.resolve({ ok: true, value: undefined });
    },
    runScanFn: () => {
      scanInvoked = true;
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/private",
    workDir: "/tmp/private",
    idleTaskIssueNumber: 100,
  });

  // Skipping is a success (nothing to do), not a failure.
  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "skipped");
  assertStringIncludes(result.summary, "acme/private");
  // The scan and the label-ensure never ran, and no gh call was made.
  assertEquals(scanInvoked, false);
  assertEquals(labelEnsured, false);
  assertEquals(calls.length, 0);
});

Deno.test("runTask - lookup error is treated as private (fail closed)", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  let scanInvoked = false;
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    getVisibilityFn: visibilityError,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () => {
      scanInvoked = true;
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "skipped");
  assertEquals(scanInvoked, false);
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("public"),
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
  assertStringIncludes(result.summary, "private-repo-reference-audit failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("public"),
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

Deno.test("claim handler - dispatches a private-repo-reference wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("public"),
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
      issueTitle: PRIVATE_REPO_REFERENCE_ISSUE_TITLE,
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
    "Private-repo reference audit complete. Filed 1 issues: #11",
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

Deno.test("assemblePrivateRepoReferencePrompt - open issue titles are substituted", () => {
  const out = assemblePrivateRepoReferencePrompt(
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

Deno.test("assemblePrivateRepoReferencePrompt - an empty open-issue list renders (none)", () => {
  const out = assemblePrivateRepoReferencePrompt(
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
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([
      { number: 37, title: "Add a CODEOWNERS file" },
    ]),
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("public"),
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
  const t = createPrivateRepoReferenceTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([], true),
    loadPromptFn: okPrompt,
    getVisibilityFn: visibility("public"),
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
