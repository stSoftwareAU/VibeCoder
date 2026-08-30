/**
 * Framework-wide conformance test: every registered idle-task scan template
 * dedups against ALL open issues (Issue #540, parent #523).
 *
 * `{{KNOWN_OPEN_FINDING_IDS}}` only ever sees findings already open under the
 * scanning task's *own* label, which is how `github-actions-audit` re-filed a
 * CODEOWNERS finding that had sat open for days under another label with no
 * `finding-id` marker. Issue #537 wired a repo-wide open-issue title lookup
 * into each scan template, and #538 added the matching prompt block — but
 * wiring seventeen templates up once does nothing to stop the eighteenth being
 * written against the old pattern.
 *
 * So this file drives `runTask` on every scan template through recording
 * stubs and asserts, per template:
 *
 *   1. the repo-wide open-issue lookup actually happened — `gh issue list`
 *      with neither `--label` nor `--search` scoping it;
 *   2. its result reached the scan runner and, through the template's own
 *      prompt assembler, the prompt text handed to the model;
 *   3. the negative — the dedup list is NOT sourced from a label-scoped
 *      query. The gh stub serves the fixture titles only to the repo-wide
 *      call, so a label-scoped template captures nothing.
 *
 * Coverage is driven from the LIVE registry (`listTemplates()` after the same
 * side-effect imports `idle_task_claim_handler.ts` performs), not from a
 * hand-maintained list: a newly registered template that is neither wired into
 * {@link HARNESSES} nor named in {@link NON_PARTICIPATING} fails
 * `every registered template is covered or allow-listed`. An implicit skip is
 * what let this class of bug through in the first place, so the allow-list
 * carries a stated reason per entry and is itself checked for staleness.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

// Same side-effect imports the production claim handler performs — importing
// the handler itself keeps the registered set here identical to the one the
// worker dispatches against, with no second list to drift.
import "../lib/idle_task_claim_handler.ts";
import {
  type IdleTaskTemplate,
  listTemplates,
} from "../lib/idle_task_template.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";
import type { Logger, Result } from "../types.ts";
import type { LinterCheckResult } from "../lib/linter_in_ci_check.ts";
import type { RepoVisibility } from "../lib/repo_visibility.ts";

import {
  assembleBestPracticesPrompt,
  createBestPracticesTemplate,
} from "../lib/idle_task_templates/best_practices_template.ts";
import {
  assembleDeadCodePrompt,
  createDeadCodeTemplate,
} from "../lib/idle_task_templates/dead_code_template.ts";
import {
  assembleDeprecatedApiPrompt,
  createDeprecatedApiTemplate,
} from "../lib/idle_task_templates/deprecated_api_template.ts";
import {
  assembleDocCoveragePrompt,
  createDocCoverageTemplate,
} from "../lib/idle_task_templates/doc_coverage_template.ts";
import {
  assembleDocumentationAuditPrompt,
  createDocumentationAuditTemplate,
} from "../lib/idle_task_templates/documentation_audit_template.ts";
import {
  assembleDuplicatedKnowledgePrompt,
  createDuplicatedKnowledgeTemplate,
} from "../lib/idle_task_templates/duplicated_knowledge_template.ts";
import {
  assembleFormatDriftPrompt,
  createFormatDriftTemplate,
} from "../lib/idle_task_templates/format_drift_template.ts";
import {
  assembleGitHubActionsAuditPrompt,
  createGitHubActionsAuditTemplate,
} from "../lib/idle_task_templates/github_actions_audit_template.ts";
import {
  assembleOrphanDepsPrompt,
  createOrphanDepsTemplate,
} from "../lib/idle_task_templates/orphan_deps_template.ts";
import {
  assemblePrivateRepoReferencePrompt,
  createPrivateRepoReferenceTemplate,
} from "../lib/idle_task_templates/private_repo_reference_template.ts";
import { createSecurityScanTemplate } from "../lib/idle_task_templates/security_scan_template.ts";
import { buildSecurityScanPrompt } from "../lib/security_scanner.ts";
import {
  assembleSupplyChainReadinessPrompt,
  createSupplyChainReadinessTemplate,
} from "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import {
  assembleTestAuditPrompt,
  createTestAuditTemplate,
} from "../lib/idle_task_templates/test_audit_template.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "acme/widget";
const WORK_DIR = "/tmp/vibe-conformance-does-not-exist";
const WRAPPER_ISSUE_NUMBER = 100;

/**
 * The reported scenario, reduced to one row: an issue open under an unrelated
 * label, carrying no `finding-id` marker, whose title describes the finding a
 * scan is about to re-file.
 */
const CROSS_LABEL_ISSUE: OpenIssueTitle = {
  number: 37,
  title: "Add a CODEOWNERS file",
};

/** How {@link renderOpenIssueTitles} renders {@link CROSS_LABEL_ISSUE}. */
const RENDERED_CROSS_LABEL_ISSUE = "#37 — Add a CODEOWNERS file";

/**
 * Minimal prompt template carrying only the placeholder under test, so an
 * assembler's output is unambiguous regardless of which real prompt version
 * ships.
 */
const PROMPT_TEMPLATE = "Already open in this repository:\n" +
  "{{OPEN_ISSUE_TITLES}}\n";

/** Silent logger — the templates that take one must not spam the test output. */
function silentLogger(): Logger {
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
// gh stub
// ---------------------------------------------------------------------------

/** True for a repo-wide `gh issue list … --json number,title` call. */
function isRepoWideTitleLookup(args: readonly string[]): boolean {
  return isTitleListCall(args) && !args.includes("--label") &&
    !args.includes("--search");
}

/** True for any `gh issue list … --json number,title` call. */
function isTitleListCall(args: readonly string[]): boolean {
  const jsonIdx = args.indexOf("--json");
  return args[0] === "issue" && args[1] === "list" && jsonIdx >= 0 &&
    args[jsonIdx + 1] === "number,title";
}

/** Where the stub is willing to serve the open-issue title fixture. */
type TitleServing = "repo-wide" | "label-scoped";

interface GhStub {
  /** The stub itself, for injection as `ghCommandFn`. */
  gh: (args: string[]) => Promise<string>;
  /** Every invocation, in order, for post-hoc assertions. */
  calls: string[][];
}

/**
 * Recording gh stub shared by every template harness.
 *
 * `serve` decides which query the open-issue titles answer to:
 *   - `"repo-wide"` — the correct lookup (no `--label`, no `--search`);
 *   - `"label-scoped"` — the blind-spot lookup this whole issue exists to
 *     rule out. A template that sources its dedup list this way captures the
 *     fixture; a conformant one captures nothing.
 *
 * Everything else answers with an empty list, so no snapshot diff, no
 * finding-id skip-list, and no wrapper veto interferes with what is under
 * test. `issue view` returns a body declaring a bucket, which `best-practices`
 * needs before it will run at all.
 */
function makeGhStub(
  titles: readonly OpenIssueTitle[],
  opts: { serve?: TitleServing; failTitleLookup?: boolean } = {},
): GhStub {
  const serve = opts.serve ?? "repo-wide";
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve(`https://github.com/${REPO}/issues/999`);
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({
          body: "**Bucket:** `typescript`\n\n# Best-Practices Review",
        }),
      );
    }
    if (isTitleListCall(args)) {
      const wanted = serve === "repo-wide"
        ? isRepoWideTitleLookup(args)
        : args.includes("--label");
      if (wanted) {
        return opts.failTitleLookup
          ? Promise.reject(new Error("gh: rate limited"))
          : Promise.resolve(JSON.stringify(titles));
      }
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The scan-runner options every participating template hands its runner. */
interface CapturedScan {
  knownOpenFindingIds: string[];
  openIssueTitles: OpenIssueTitle[];
}

/** Stubs a harness must wire into the template it builds. */
interface HarnessStubs {
  gh: (args: string[]) => Promise<string>;
  /** Record the scan-runner options instead of invoking Claude. */
  capture: (scan: CapturedScan) => void;
}

/**
 * One scan template, wired for conformance testing.
 *
 * `create` must use the same factory the module-load registration uses, so the
 * instance under test is the production one with its externals stubbed;
 * `assemble` must be the template's own exported prompt assembler, called the
 * way its default scan runner calls it — that is what makes "the titles
 * reached the prompt" a claim about production code rather than about the
 * test.
 */
interface ScanHarness {
  /** Registry slug — must match a template returned by `listTemplates()`. */
  name: string;
  create(stubs: HarnessStubs): IdleTaskTemplate;
  assemble(template: string, scan: CapturedScan): string;
}

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: PROMPT_TEMPLATE });
const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });
const scanOk = <E>(): Promise<Result<true, E>> =>
  Promise.resolve({ ok: true, value: true });
const linterOk = (): Promise<LinterCheckResult> =>
  Promise.resolve({
    configured: true,
    linter: "actionlint",
    details: "actionlint configured.",
  });
const publicRepo = (): Promise<Result<RepoVisibility, string>> =>
  Promise.resolve({ ok: true, value: "public" });

/** The ids every assembler renders beside the open-issue titles. */
const NO_IDS = { suppressedIds: [], knownOpenFindingIds: [] };

/**
 * Every scan template that runs a scan and files judgement-bearing findings.
 *
 * The list is NOT the coverage source of truth — `listTemplates()` is. A
 * registered template missing from here fails the coverage test below unless
 * it is allow-listed with a reason.
 */
const HARNESSES: ScanHarness[] = [
  {
    name: "best-practices",
    create: ({ gh, capture }) =>
      createBestPracticesTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        checkLinterInCIFn: linterOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleBestPracticesPrompt(template, "(guide)", {
        ...NO_IDS,
        bucket: "typescript",
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "dead-code",
    create: ({ gh, capture }) =>
      createDeadCodeTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleDeadCodePrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "deprecated-api",
    create: ({ gh, capture }) =>
      createDeprecatedApiTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleDeprecatedApiPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "doc-coverage",
    create: ({ gh, capture }) =>
      createDocCoverageTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleDocCoveragePrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "documentation-audit",
    create: ({ gh, capture }) =>
      createDocumentationAuditTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleDocumentationAuditPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "duplicated-knowledge",
    create: ({ gh, capture }) =>
      createDuplicatedKnowledgeTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleDuplicatedKnowledgePrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "format-drift",
    create: ({ gh, capture }) =>
      createFormatDriftTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleFormatDriftPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "github-actions-audit",
    create: ({ gh, capture }) =>
      createGitHubActionsAuditTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        checkLinterInCIFn: linterOk,
        scanRunnerDeprecationsFn: () => Promise.resolve([]),
        readWorkflowFilesFn: () => Promise.resolve([]),
        scanActionAdvisoriesFn: () => Promise.resolve([]),
        scanRepoSettingsFn: () => Promise.resolve([]),
        requiredActionPatternsFn: () => Promise.resolve([]),
        // The settings pre-filer is not under test here; refusing the
        // default-branch lookup keeps it off the network entirely.
        getDefaultBranchFn: () =>
          Promise.resolve({ ok: false, error: new Error("stubbed out") }),
        logger: silentLogger(),
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleGitHubActionsAuditPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "orphan-deps",
    create: ({ gh, capture }) =>
      createOrphanDepsTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        collectSuppressedIdsFn: () => Promise.resolve([]),
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleOrphanDepsPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "private-repo-reference-audit",
    create: ({ gh, capture }) =>
      createPrivateRepoReferenceTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        getVisibilityFn: publicRepo,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assemblePrivateRepoReferencePrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "security-scan",
    create: ({ gh, capture }) =>
      createSecurityScanTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        emitSarifFn: () =>
          Promise.resolve({ summary: "SARIF skipped.", upload: null }),
        runSecurityScanFn: (opts) => {
          capture(opts);
          return Promise.resolve({ ok: true, value: { ok: true } });
        },
      }),
    assemble: (template, scan) =>
      buildSecurityScanPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "supply-chain-readiness",
    create: ({ gh, capture }) =>
      createSupplyChainReadinessTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleSupplyChainReadinessPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
  {
    name: "test-audit",
    create: ({ gh, capture }) =>
      createTestAuditTemplate({
        ghCommandFn: gh,
        loadPromptFn: okPrompt,
        ensureLabelFn: labelOk,
        runScanFn: (opts) => {
          capture(opts);
          return scanOk();
        },
      }),
    assemble: (template, scan) =>
      assembleTestAuditPrompt(template, {
        ...NO_IDS,
        openIssueTitles: scan.openIssueTitles,
      }),
  },
];

/**
 * Registered templates that legitimately do not participate, each with the
 * reason it is exempt. Adding a name here is a deliberate, reviewable act —
 * an implicit skip is what let the cross-label blind spot ship.
 *
 * All four are native scanners: they invoke no LLM, assemble no prompt, and
 * file only fixed-id findings that the repo-wide `finding-id` look-up
 * (Issue #539) already dedups. There is no semantic-duplicate surface for an
 * open-issue title list to guard.
 */
const NON_PARTICIPATING = new Map<string, string>([
  [
    "alert-feed",
    "Native: mirrors Dependabot/code-scanning alerts one-for-one under a " +
    "fixed alert id. No LLM, no prompt, no semantic duplicates.",
  ],
  [
    "bash-script-refs",
    "Native: reports broken script references found by a deterministic " +
    "parse, keyed on the referenced path. No LLM, no prompt.",
  ],
  [
    "bash-syntax-audit",
    "Native: reports `bash -n` parse failures, keyed on file and line. " +
    "No LLM, no prompt.",
  ],
  [
    "workflow-annotation-scan",
    "Native: reports GitHub Actions annotations verbatim, keyed on the " +
    "annotation. No LLM, no prompt.",
  ],
]);

const harnessNames = new Set(HARNESSES.map((h) => h.name));

/** Run a template's `runTask` through the stubs, returning what was seen. */
async function driveRunTask(
  harness: ScanHarness,
  ghStub: GhStub,
): Promise<
  { result: { ok: boolean; summary: string }; scans: CapturedScan[] }
> {
  const scans: CapturedScan[] = [];
  const template = harness.create({
    gh: ghStub.gh,
    capture: (scan) =>
      scans.push({
        knownOpenFindingIds: [...scan.knownOpenFindingIds],
        openIssueTitles: [...scan.openIssueTitles],
      }),
  });
  const result = await template.runTask({
    repo: REPO,
    workDir: WORK_DIR,
    idleTaskIssueNumber: WRAPPER_ISSUE_NUMBER,
  });
  return { result, scans };
}

// ---------------------------------------------------------------------------
// Registry coverage — the part that catches the eighteenth template
// ---------------------------------------------------------------------------

Deno.test("conformance - every registered template is covered or allow-listed", () => {
  const uncovered = listTemplates()
    .map((t) => t.name)
    .filter((name) => !harnessNames.has(name) && !NON_PARTICIPATING.has(name));
  assertEquals(
    uncovered,
    [],
    `idle-task templates ${uncovered.join(", ")} are registered but not ` +
      `covered by this conformance test. Wire each into HARNESSES so its ` +
      `repo-wide open-issue dedup is asserted, or add it to ` +
      `NON_PARTICIPATING with a stated reason.`,
  );
});

Deno.test("conformance - every harness names a registered template", () => {
  const registered = new Set(listTemplates().map((t) => t.name));
  const stale = HARNESSES.map((h) => h.name).filter((n) => !registered.has(n));
  assertEquals(
    stale,
    [],
    `HARNESSES entries ${stale.join(", ")} name no registered template — ` +
      `the harness has drifted from the registry.`,
  );
});

Deno.test("conformance - every allow-list entry names a registered template", () => {
  const registered = new Set(listTemplates().map((t) => t.name));
  const stale = [...NON_PARTICIPATING.keys()].filter((n) => !registered.has(n));
  assertEquals(
    stale,
    [],
    `NON_PARTICIPATING entries ${stale.join(", ")} name no registered ` +
      `template — remove them so the allow-list cannot hide a live gap.`,
  );
});

Deno.test("conformance - every allow-list entry states a reason", () => {
  for (const [name, reason] of NON_PARTICIPATING) {
    assert(
      reason.trim().length >= 40,
      `${name}: allow-list entry needs a stated reason, not "${reason}"`,
    );
  }
});

Deno.test("conformance - no template is both covered and allow-listed", () => {
  const both = [...NON_PARTICIPATING.keys()].filter((n) => harnessNames.has(n));
  assertEquals(both, [], `templates ${both.join(", ")} are in both lists`);
});

// ---------------------------------------------------------------------------
// Per-template conformance
// ---------------------------------------------------------------------------

for (const harness of HARNESSES) {
  Deno.test(`${harness.name} - harness builds the registered template`, () => {
    const built = harness.create({
      gh: () => Promise.resolve("[]"),
      capture: () => {},
    });
    const registered = listTemplates().find((t) => t.name === harness.name);
    assert(registered !== undefined, `${harness.name} is not registered`);
    assertEquals(built.name, registered.name);
    assertEquals(built.buildIssueTitle(REPO), registered.buildIssueTitle(REPO));
  });

  Deno.test(`${harness.name} - runTask looks up open issues repo-wide`, async () => {
    const ghStub = makeGhStub([CROSS_LABEL_ISSUE]);
    const { result } = await driveRunTask(harness, ghStub);

    assertEquals(result.ok, true, `runTask failed: ${result.summary}`);
    const repoWide = ghStub.calls.filter(isRepoWideTitleLookup);
    assert(
      repoWide.length > 0,
      `${harness.name}: runTask never issued a repo-wide open-issue lookup ` +
        `— the cross-label dedup list is empty by construction. Calls made: ` +
        JSON.stringify(ghStub.calls),
    );
    for (const call of repoWide) {
      assertEquals(call[0], "issue");
      assertEquals(call[1], "list");
      assert(call.includes("--state"));
      assertEquals(call[call.indexOf("--state") + 1], "open");
    }
  });

  Deno.test(`${harness.name} - the open issues reach the scan prompt`, async () => {
    const ghStub = makeGhStub([CROSS_LABEL_ISSUE]);
    const { result, scans } = await driveRunTask(harness, ghStub);

    assertEquals(result.ok, true, `runTask failed: ${result.summary}`);
    assertEquals(
      scans.length,
      1,
      `${harness.name}: expected exactly one scan invocation`,
    );
    assertEquals(
      scans[0]?.openIssueTitles,
      [CROSS_LABEL_ISSUE],
      `${harness.name}: the repo-wide open issues never reached the scan runner`,
    );

    const prompt = harness.assemble(PROMPT_TEMPLATE, scans[0]!);
    assert(
      !prompt.includes("{{OPEN_ISSUE_TITLES}}"),
      `${harness.name}: {{OPEN_ISSUE_TITLES}} was left unsubstituted`,
    );
    assertStringIncludes(prompt, RENDERED_CROSS_LABEL_ISSUE);
  });

  Deno.test(`${harness.name} - the dedup list is not label-scoped`, async () => {
    // The stub serves the fixture ONLY to a `--label`-scoped title query, so
    // a template that scopes its dedup lookup by label captures the issue and
    // this assertion fails.
    const ghStub = makeGhStub([CROSS_LABEL_ISSUE], { serve: "label-scoped" });
    const { result, scans } = await driveRunTask(harness, ghStub);

    assertEquals(result.ok, true, `runTask failed: ${result.summary}`);
    assertEquals(
      scans[0]?.openIssueTitles,
      [],
      `${harness.name}: the dedup list came from a label-scoped query — a ` +
        `finding already open under another label stays invisible`,
    );
    for (const call of ghStub.calls) {
      if (!isTitleListCall(call) || call.includes("--search")) continue;
      assert(
        !call.includes("--label"),
        `${harness.name}: open-issue title lookup is label-scoped: ` +
          JSON.stringify(call),
      );
    }
  });

  Deno.test(`${harness.name} - a failed lookup degrades to an empty list`, async () => {
    const ghStub = makeGhStub([CROSS_LABEL_ISSUE], { failTitleLookup: true });
    const { result, scans } = await driveRunTask(harness, ghStub);

    // A transient gh failure must not abort the scan — it renders `(none)`.
    assertEquals(result.ok, true, `runTask failed: ${result.summary}`);
    assertEquals(scans[0]?.openIssueTitles, []);
  });
}

// ---------------------------------------------------------------------------
// Reported scenario (parent #523) — end-to-end at the template level
// ---------------------------------------------------------------------------

Deno.test(
  "github-actions-audit - a same-finding issue open under another label reaches the prompt",
  async () => {
    const harness = HARNESSES.find((h) => h.name === "github-actions-audit")!;
    // The reported issue: #37 "Add a CODEOWNERS file" was open for days under
    // `needs-human` alone — no `github-actions-audit` label, and no
    // `<!-- finding-id: … -->` marker, so BOTH label-scoped dedup lines were
    // blind to it and the scan re-filed the finding.
    const ghStub = makeGhStub([CROSS_LABEL_ISSUE]);
    const { result, scans } = await driveRunTask(harness, ghStub);

    assertEquals(result.ok, true, `runTask failed: ${result.summary}`);
    // The finding-id dedup line stays blind — that is the premise, not a bug.
    assertEquals(scans[0]?.knownOpenFindingIds, []);
    // The title list is what closes the gap, and it must reach the prompt.
    const prompt = harness.assemble(PROMPT_TEMPLATE, scans[0]!);
    assertStringIncludes(prompt, RENDERED_CROSS_LABEL_ISSUE);
  },
);
