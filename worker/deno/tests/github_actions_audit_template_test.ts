/**
 * Tests for the github-actions-audit idle-task template (Issue #2256,
 * template #4).
 *
 * Coverage:
 *   - registration: the template registers at module load and
 *     `getTemplate("github-actions-audit")` / `listTemplates()` find it
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "github-actions-audit", requiresStructuredOutput
 *     === true
 *   - title is the literal "Run a GitHub Actions audit" (used for dispatch)
 *   - buildIssueBody output is recognised by BOTH the title match and the
 *     body fingerprint, with all placeholders substituted at file time
 *   - assembleGitHubActionsAuditPrompt substitutes placeholders /
 *     `(none)` sentinel, renders the catalogue tables
 *   - runTask happy path: ensures the label, runs the actionlint
 *     pre-check, runs the runner-deprecation pre-filer, and returns the
 *     before/after diff summary
 *   - runTask error path: runScanFn failure → ok:false summary
 *   - runTask edge cases: empty diff → "no findings"; actionlint missing
 *     → pre-file recorded; runner-deprecation scanner throws → captured
 *     in summary
 *   - claim handler dispatches a "Run a GitHub Actions audit" wrapper to
 *     runTask
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  ACTIONS_POLICY_PERMISSION,
  assembleGitHubActionsAuditPrompt,
  createGitHubActionsAuditTemplate,
  GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT,
  GITHUB_ACTIONS_AUDIT_ISSUE_TITLE,
  GITHUB_ACTIONS_AUDIT_LABEL,
  githubActionsAuditTemplate,
  type GitHubActionsAuditTemplateDeps,
  isNotPermittedLookup,
  renderGitHubActionsAuditSummary,
  runGitHubActionsAuditScan,
} from "../lib/idle_task_templates/github_actions_audit_template.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  listTemplates,
} from "../lib/idle_task_template.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger } from "../types.ts";
import type { Result } from "../types.ts";
import type { DeprecationFinding } from "../lib/runner_deprecation_scanner.ts";
import type { LinterCheckResult } from "../lib/linter_in_ci_check.ts";
import { PINNED_ACTIONS } from "../lib/pinned_actions.ts";
import { setCachedDefaultBranch } from "../lib/default_branch_cache.ts";
import { clearDefaultBranchMemoryCache } from "../lib/shell_helpers.ts";

/**
 * The fleet identity the finding-id dedup verifies against (Issue #1243).
 *
 * The stubbed known-open issues are ones the fleet filed, so they are
 * attributed to a fleet login and the templates are handed the same list.
 */
const FLEET_DEDUP_AUTHOR = "vibe-bot";
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * A throwaway persistent default-branch cache for this suite.
 *
 * The trigger pre-filer's default resolver (Issue #2587) reads and writes
 * the cache, and must not touch the developer's real one. Issue #964: the
 * path is handed to every template through `defaultBranchCachePath` rather
 * than exported into the process environment — writing the process
 * environment races every other worker under `deno test --parallel`, which
 * is what kept this suite in the gate's serial second pass.
 */
const THROWAWAY_BRANCH_CACHE =
  `${Deno.makeTempDirSync()}/default-branch-cache.json`;

/**
 * Build the template with the throwaway cache path already wired.
 *
 * Every test in this file goes through here, so no call can reach the real
 * cache by forgetting the seam. A test that names its own path still wins.
 */
function makeAuditTemplate(
  deps: GitHubActionsAuditTemplateDeps = {},
): IdleTaskTemplate {
  return createGitHubActionsAuditTemplate({
    defaultBranchCachePath: THROWAWAY_BRANCH_CACHE,
    // Author-verified finding-id dedup (Issue #1243): the stubbed known-open
    // issues are fleet-authored, so the fleet is stated here rather than read
    // from a config file.
    dedupAuthors: DEDUP_AUTHORS,
    ...deps,
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# GitHub Actions Audit — Workflow-Focused Review (v7)",
  "",
  "Suppressed:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
  "",
  "Catalogue:",
  "{{ACTIONS_CATALOGUE_TABLE}}",
  "",
  "EOL:",
  "{{EOL_RUNTIMES_TABLE}}",
  "",
  "Attribution footer line every filed body MUST end with:",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

/** Linter check stub that reports the gate as configured. */
const linterOk = (): Promise<LinterCheckResult> =>
  Promise.resolve({
    configured: true,
    linter: "actionlint",
    details: "actionlint configured.",
  });

/** Linter check stub that reports the gate as missing. */
const linterMissing = (): Promise<LinterCheckResult> =>
  Promise.resolve({
    configured: false,
    linter: "actionlint",
    details: "actionlint not invoked from any workflow.",
  });

/**
 * Linter check stub for the fail-safe case (Issue #2881): zero workflow
 * files loaded. `workflowsLoaded: false` flags the result as a likely scan
 * glitch, so the consumer must not file the severity:high BP-LINTER finding.
 */
const linterZeroWorkflows = (): Promise<LinterCheckResult> =>
  Promise.resolve({
    configured: false,
    linter: "actionlint",
    details:
      "No GitHub Actions workflows were found under `.github/workflows/`.",
    workflowsLoaded: false,
  });

interface CreateRecord {
  title: string;
  body: string;
  labels: string[];
}

/**
 * gh stub that distinguishes the snapshot/known-open queries from the
 * wrapper-search and `issue create` calls. Returns sequential numbers
 * for successive `issue create` calls.
 */
function makeGhStub(scenario: {
  beforeSnapshot?: number[];
  afterSnapshot?: number[];
  knownOpen?: Array<{ number: number; body: string }>;
  issueCreateNumbers?: number[];
}): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
  creates: CreateRecord[];
} {
  const calls: string[][] = [];
  const creates: CreateRecord[] = [];
  const createNumbers = [...(scenario.issueCreateNumbers ?? [])];
  let snapshotCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    const labelIdx = args.indexOf("--label");
    const labelArg = labelIdx >= 0 ? args[labelIdx + 1] : "";
    // Wrapper-title search — `number,title` for the repo-wide open-issue
    // list, and the author-bearing field list for the veto (a title alone is
    // text anybody may write, so the veto verifies the author).
    if (
      jsonField !== "number,body,author" &&
      (jsonField === "number,title" || (jsonField ?? "").includes("author"))
    ) {
      return Promise.resolve("[]");
    }
    // Repository-settings pre-filer (Issues #4397/#4398/#4401) and the GHSA
    // cross-check (Issue #4405): answer "hardened" / "no advisories" so the
    // scenarios below stay about the workflow-file pre-filers. Dedicated
    // tests inject scanRepoSettingsFn / scanActionAdvisoriesFn instead.
    if (args[0] === "api" && typeof args[1] === "string") {
      const endpoint = args[1];
      if (endpoint.startsWith("/advisories?")) return Promise.resolve("[]");
      if (endpoint.endsWith("/actions/permissions/workflow")) {
        return Promise.resolve(JSON.stringify({
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
        }));
      }
      if (endpoint.endsWith("/actions/permissions")) {
        return Promise.resolve(JSON.stringify({
          enabled: true,
          allowed_actions: "selected",
          sha_pinning_required: true,
        }));
      }
      // Issue #4424: the allow-list covers every third-party owner the
      // fixtures use, and no fixture action is a composite (no manifest).
      if (endpoint.endsWith("/actions/permissions/selected-actions")) {
        return Promise.resolve(JSON.stringify({
          github_owned_allowed: true,
          verified_allowed: false,
          patterns_allowed: ["*/*@*"],
        }));
      }
      if (/\/contents\/action\.ya?ml/.test(endpoint)) {
        return Promise.reject(new Error("HTTP 404: Not Found"));
      }
      if (endpoint.includes("/rules/branches/")) {
        return Promise.resolve(JSON.stringify([{
          type: "pull_request",
          parameters: {
            require_code_owner_review: true,
            required_approving_review_count: 1,
          },
        }]));
      }
      if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
        return Promise.resolve(JSON.stringify({
          // Issue #599: the same payload carries the worker token's own
          // permissions. `push` without `admin`/`maintain` is the correctly
          // scoped token, so the privilege scanner stays silent here.
          permissions: {
            admin: false,
            maintain: false,
            push: true,
            pull: true,
          },
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "enabled" },
          },
        }));
      }
    }
    // Snapshot (number-only, label-scoped to audit).
    if (
      jsonField === "number" && args[0] === "issue" && args[1] === "list" &&
      labelArg === GITHUB_ACTIONS_AUDIT_LABEL
    ) {
      snapshotCount += 1;
      const nums = snapshotCount === 1
        ? scenario.beforeSnapshot ?? []
        : scenario.afterSnapshot ?? scenario.beforeSnapshot ?? [];
      return Promise.resolve(JSON.stringify(nums.map((n) => ({ number: n }))));
    }
    // Known-open lookup (number,body,author). Author-bearing since Issue
    // #1243: a finding-id marker anybody may write is not evidence the fleet
    // filed the finding, so the stub answers as a fleet account.
    if (
      jsonField === "number,body,author" && args[0] === "issue" &&
      args[1] === "list"
    ) {
      return Promise.resolve(
        JSON.stringify(
          (scenario.knownOpen ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    // gh issue create — capture and return a fresh URL.
    if (args[0] === "issue" && args[1] === "create") {
      const titleIdx = args.indexOf("--title");
      const bodyIdx = args.indexOf("--body");
      const labels: string[] = [];
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "--label") labels.push(args[i + 1] ?? "");
      }
      creates.push({
        title: args[titleIdx + 1] ?? "",
        body: args[bodyIdx + 1] ?? "",
        labels,
      });
      const n = createNumbers.shift();
      if (n === undefined) {
        throw new Error("no more issue-create numbers queued");
      }
      return Promise.resolve(`https://github.com/org/repo/issues/${n}\n`);
    }
    return Promise.resolve("[]");
  };
  return { gh, calls, creates };
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

Deno.test("github-actions-audit - registered at module load", () => {
  const t = getTemplate("github-actions-audit");
  assert(
    t !== undefined,
    "expected github-actions-audit template to be registered",
  );
  assertEquals(t, githubActionsAuditTemplate);
  assert(
    listTemplates().some((x) => x.name === "github-actions-audit"),
    "expected listTemplates() to include github-actions-audit",
  );
});

Deno.test("github-actions-audit - contract flags", () => {
  assertEquals(githubActionsAuditTemplate.cooldownHours, 168);
  assertEquals(githubActionsAuditTemplate.skipMilestone, true);
  assertEquals(
    githubActionsAuditTemplate.outputLabel,
    GITHUB_ACTIONS_AUDIT_LABEL,
  );
  assertEquals(githubActionsAuditTemplate.requiresStructuredOutput, true);
  assertEquals(
    githubActionsAuditTemplate.buildIssueTitle("acme/widget"),
    GITHUB_ACTIONS_AUDIT_ISSUE_TITLE,
  );
});

Deno.test(
  "github-actions-audit - buildIssueBody matches title and fingerprint",
  async () => {
    const t = makeAuditTemplate({ loadPromptFn: okPrompt });
    const body = await Promise.resolve(
      t.buildIssueBody({
        repo: "acme/widget",
        pickedAt: "2026-05-25T00:00:00Z",
        workerUser: "vibe",
      }),
    );
    // Title dispatch signal.
    assertEquals(
      t.buildIssueTitle("acme/widget"),
      GITHUB_ACTIONS_AUDIT_ISSUE_TITLE,
    );
    // Body fingerprint dispatch signal.
    assert(
      t.matchesIdleTaskBody?.(body) === true,
      "expected buildIssueBody output to match the body fingerprint",
    );
    assert(GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT.test(body));
    // No raw placeholders survive — they collapse to the (none) sentinel
    // or the rendered catalogue tables.
    assert(!body.includes("{{"), "expected no raw placeholders in body");
    assertStringIncludes(body, "(none)");
    // Issue #2439 — attribution footer is substituted, names the
    // template, and survives intact in the wrapper body.
    assertStringIncludes(
      body,
      "🏷️ Filed by idle-task template: `github-actions-audit`",
    );
    assertStringIncludes(body, "Run id:");
  },
);

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleGitHubActionsAuditPrompt - empty lists render (none)", () => {
  const out = assembleGitHubActionsAuditPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assert(!out.includes("{{ACTIONS_CATALOGUE_TABLE}}"));
  assert(!out.includes("{{EOL_RUNTIMES_TABLE}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleGitHubActionsAuditPrompt - populated lists are joined", () => {
  const out = assembleGitHubActionsAuditPrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test(
  "assembleGitHubActionsAuditPrompt - attribution footer is substituted",
  () => {
    const footer =
      "🏷️ Filed by idle-task template: `github-actions-audit` · Run id: `vibe-gha-test`";
    const out = assembleGitHubActionsAuditPrompt(STUB_PROMPT, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter: footer,
    });
    assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
    assertStringIncludes(out, footer);
  },
);

Deno.test("renderGitHubActionsAuditSummary - wording", () => {
  assertEquals(renderGitHubActionsAuditSummary([]), "no findings");
  assertEquals(
    renderGitHubActionsAuditSummary([12, 3]),
    "GitHub Actions audit complete. Filed 2 issues: #3, #12",
  );
});

Deno.test(
  "renderGitHubActionsAuditSummary - mentions runner pre-files and errors",
  () => {
    const out = renderGitHubActionsAuditSummary([9], {
      preFiledRunner: [11, 10],
      runnerScanError: "rate limited",
    });
    assertStringIncludes(out, "Filed 1 issues: #9");
    assertStringIncludes(out, "Runner-deprecation pre-files: #10, #11.");
    assertStringIncludes(out, "Runner-deprecation scan failed: rate limited.");
  },
);

// ---------------------------------------------------------------------------
// runTask — happy path
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - happy path ensures label and diffs snapshot",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [1, 2],
      afterSnapshot: [1, 2, 7, 9],
      knownOpen: [{ number: 2, body: "<!-- finding-id: BP-existing01 -->" }],
    });
    const ensureCalls: string[] = [];
    const scanCalls: { knownOpenFindingIds: string[] }[] = [];
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: (repo) => {
        ensureCalls.push(repo);
        return Promise.resolve({ ok: true, value: undefined });
      },
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
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
      "GitHub Actions audit complete. Filed 2 issues: #7, #9",
    );
    // Label ensured before the scan.
    assertEquals(ensureCalls, ["acme/widget"]);
    // Known-open ids flow into the scan runner.
    assertEquals(scanCalls.length, 1);
    assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing01"]);
    // No issues created when actionlint is OK and no runner findings.
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - actionlint missing → BP-LINTER finding pre-filed",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [200],
      knownOpen: [],
      issueCreateNumbers: [200],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterMissing,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget",
      idleTaskIssueNumber: 100,
    });

    assertEquals(result.ok, true);
    // One pre-file created: the BP-LINTER finding.
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-LINTER-github-actions -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:high"));
    // No `lang:*` label on audit-template findings.
    assert(
      !c.labels.some((l) => l.startsWith("lang:")),
      "audit template must not attach lang:* labels",
    );
    // The pre-filed id is in Claude's known-open list.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-LINTER-github-actions"]);
  },
);

Deno.test(
  "runTask - actionlint pre-filer skips when an OPEN BP-LINTER issue exists (Issue #2882)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [77],
      afterSnapshot: [77],
      // An open audit issue already carries the actionlint finding-id.
      knownOpen: [
        { number: 77, body: "<!-- finding-id: BP-LINTER-github-actions -->" },
      ],
      // No issueCreateNumbers queued: a create attempt would throw, proving
      // the pre-filer never reaches `gh issue create`.
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterMissing,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget",
      idleTaskIssueNumber: 100,
    });

    assertEquals(result.ok, true);
    // No second issue created — the open duplicate suppresses it.
    assertEquals(creates.length, 0);
    // The id still flows into Claude's known-open list.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-LINTER-github-actions"]);
  },
);

Deno.test(
  "runTask - zero workflows loaded → no BP-LINTER finding pre-filed (Issue #2881)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      // No issueCreateNumbers: any `issue create` would throw, proving the
      // fail-safe path never attempts to file the actionlint finding.
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterZeroWorkflows,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget-2881-nonexistent",
      idleTaskIssueNumber: 100,
    });

    assertEquals(result.ok, true);
    // No actionlint BP-LINTER finding filed despite `configured: false`.
    assertEquals(creates.length, 0);
    // The scan still runs with no pre-filed actionlint id.
    assert(scanReceived !== undefined);
    assert(!scanReceived!.knownOpen.includes("BP-LINTER-github-actions"));
  },
);

Deno.test(
  "runTask - runner-deprecation findings pre-filed with audit label only",
  async () => {
    const finding1: DeprecationFinding = {
      stableId: "BP-RUNNER-actions-checkout-node20",
      action: "actions/checkout",
      pinnedRef: "v3",
      reason: "node20",
      runUrl: "https://github.com/org/repo/actions/runs/1",
      evidence: "ci (https://…/1): Node.js 20 actions are deprecated.",
    };
    const finding2: DeprecationFinding = {
      stableId: "BP-RUNNER-actions-setup-node-set-output",
      action: "actions/setup-node",
      pinnedRef: "v2",
      reason: "set-output",
      runUrl: "https://github.com/org/repo/actions/runs/2",
      evidence: "ci (https://…/2): `set-output` command is deprecated.",
    };
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [800, 801],
      knownOpen: [],
      issueCreateNumbers: [800, 801],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([finding1, finding2]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 2);
    assert(scanReceived !== undefined);
    assertEquals(
      [...scanReceived!.knownOpen].sort(),
      [finding1.stableId, finding2.stableId].sort(),
    );

    // Each filed runner finding carries the audit label + severity:* but
    // NOT `best-practices` or `lang:github-actions` (single-template
    // scope).
    for (const c of creates) {
      assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
      assert(!c.labels.includes("best-practices"));
      assert(!c.labels.includes("lang:github-actions"));
      assert(c.labels.some((l) => l.startsWith("severity:")));
    }

    // Summary mentions both pre-filed runner issues.
    assertStringIncludes(result.summary, "Runner-deprecation pre-files:");
    assertStringIncludes(result.summary, "#800");
    assertStringIncludes(result.summary, "#801");
  },
);

Deno.test(
  "runTask - native SHA-pin pre-filer files an unpinned action and adds its id to known-open",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [900],
      knownOpen: [],
      issueCreateNumbers: [900],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const ciYml = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: null,
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Exactly one SHA-pin finding filed.
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-SHA-PIN-actions-checkout -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:high"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so it is not
    // double-filed by the LLM #1 check.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-SHA-PIN-actions-checkout"));
  },
);

Deno.test(
  "runTask - native permissions pre-filer files a missing-block job and adds its id to known-open",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [910],
      knownOpen: [],
      issueCreateNumbers: [910],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // No `permissions:` anywhere → the `build` job inherits the broad
    // default. `parsed` is the structural form the scanner inspects.
    const ciYml = [
      "name: CI",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "push",
              jobs: { build: { "runs-on": "ubuntu-latest", steps: [] } },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-PERMISSIONS-ci-build -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:medium"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM #2
    // check does not double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-PERMISSIONS-ci-build"));
  },
);

Deno.test(
  "runTask - native script-injection pre-filer files a run: step and adds its id to known-open",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [920],
      knownOpen: [],
      issueCreateNumbers: [920],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const runScript = 'echo "${{ github.event.pull_request.title }}"';
    // A scoped top-level `permissions:` block keeps the permissions
    // pre-filer quiet so this test isolates the injection finding.
    const ciYml = [
      "name: CI",
      "on: pull_request_target",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - run: ${runScript}`,
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "pull_request_target",
              permissions: { contents: "read" },
              jobs: {
                build: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: runScript }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-INJECTION-ci-build-0 -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:high"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM #22
    // check does not double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-INJECTION-ci-build-0"));
  },
);

Deno.test(
  "runTask - native pre-filer files an AI-action prompt-injection finding (Issue #3313)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [921],
      knownOpen: [],
      issueCreateNumbers: [921],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // A scoped top-level `permissions:` block keeps the permissions
    // pre-filer quiet so this test isolates the AI-injection finding.
    const agentYml = [
      "name: Agent",
      "on: issues",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  triage:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: anthropics/claude-code-action@1234567890123456789012345678901234567890",
      "        with:",
      "          prompt: ${{ github.event.issue.body }}",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/agent.yml",
            rawText: agentYml,
            parsed: {
              name: "Agent",
              on: "issues",
              permissions: { contents: "read" },
              jobs: {
                triage: {
                  "runs-on": "ubuntu-latest",
                  steps: [
                    {
                      uses:
                        "anthropics/claude-code-action@1234567890123456789012345678901234567890",
                      with: { prompt: "${{ github.event.issue.body }}" },
                    },
                  ],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 51,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-AI-INJECTION-agent-triage-0 -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:high"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM #31
    // check does not double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-AI-INJECTION-agent-triage-0"));
  },
);

// ---------------------------------------------------------------------------
// Native workflow-trigger pre-filer (Issue #2587)
// ---------------------------------------------------------------------------

/** A scoped top-level `permissions:` block keeps the permissions pre-filer
 * quiet so trigger-pre-filer tests isolate the trigger finding. */
const branchMain = () => Promise.resolve({ ok: true as const, value: "main" });

Deno.test(
  "runTask - the default branch resolver reads the cache path the deps name (Issue #964)",
  async () => {
    // Seed a throwaway cache with a branch name that exists nowhere else,
    // and make the gh fallback fail. The pre-filer only runs when the
    // default branch resolves, so a resolver that ignored
    // `defaultBranchCachePath` would ask gh, get an error, and file nothing.
    const dir = await Deno.makeTempDir({ prefix: "gha-audit-964-" });
    const cachePath = `${dir}/default-branch-cache.json`;
    clearDefaultBranchMemoryCache();
    await setCachedDefaultBranch(
      "org/seam964",
      "sentinel-964-trunk",
      cachePath,
    );

    try {
      const { gh, creates } = makeGhStub({
        beforeSnapshot: [],
        afterSnapshot: [931],
        knownOpen: [],
        issueCreateNumbers: [931],
      });
      const ghNoBranch = (args: string[]): Promise<string> =>
        args.includes(".default_branch")
          ? Promise.reject(new Error("no default-branch lookup allowed here"))
          : gh(args);

      const ciYml = [
        "name: CI",
        "on: push",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno test",
      ].join("\n");

      const t = createGitHubActionsAuditTemplate({
        defaultBranchCachePath: cachePath,
        ghCommandFn: ghNoBranch,
        loadPromptFn: okPrompt,
        ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
        checkLinterInCIFn: linterOk,
        scanRunnerDeprecationsFn: () => Promise.resolve([]),
        readWorkflowFilesFn: () =>
          Promise.resolve([
            {
              path: ".github/workflows/ci.yml",
              rawText: ciYml,
              parsed: {
                name: "CI",
                on: "push",
                permissions: { contents: "read" },
                jobs: {
                  test: {
                    "runs-on": "ubuntu-latest",
                    steps: [{ run: "deno test" }],
                  },
                },
              },
              kind: "workflow" as const,
            },
          ]),
        runScanFn: () => Promise.resolve({ ok: true, value: true }),
      });

      const result = await t.runTask({
        repo: "org/seam964",
        workDir: "/tmp/repo",
        idleTaskIssueNumber: 51,
      });

      assert(result.ok);
      assertEquals(creates.length, 1);
      assertStringIncludes(
        creates[0]!.body,
        "<!-- finding-id: BP-TRIGGER-ci -->",
      );
    } finally {
      clearDefaultBranchMemoryCache();
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test(
  "runTask - trigger pre-filer files a test/lint workflow on push-to-default",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [930],
      knownOpen: [],
      issueCreateNumbers: [930],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const ciYml = [
      "name: CI",
      "on: push",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "push",
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(c.body, "<!-- finding-id: BP-TRIGGER-ci -->");
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:low"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-TRIGGER-ci"));
  },
);

Deno.test(
  "runTask - trigger pre-filer leaves a deploy workflow on push untouched",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called for a deploy workflow
    });
    const releaseYml = [
      "name: Release",
      "on: push",
      "permissions:",
      "  contents: write",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/release.yml",
            rawText: releaseYml,
            parsed: {
              name: "Release",
              on: "push",
              permissions: { contents: "write" },
              jobs: {
                publish: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "npm publish" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Deploy/publish workflows keep running on push — no trigger finding.
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - trigger pre-filer leaves an ambiguous workflow untouched",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called for an ambiguous workflow
    });
    const mixedYml = [
      "name: Mixed",
      "on: push",
      "permissions:",
      "  contents: write",
      "jobs:",
      "  ci:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
      "      - run: npm publish",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/mixed.yml",
            rawText: mixedYml,
            parsed: {
              name: "Mixed",
              on: "push",
              permissions: { contents: "write" },
              jobs: {
                ci: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }, { run: "npm publish" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Mixed (test + deploy) classifies ambiguous — left untouched.
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - trigger pre-filer skips when the default branch cannot be resolved",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called — resolution failed
    });
    const ciYml = [
      "name: CI",
      "on: push",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: () =>
        Promise.resolve({ ok: false, error: new Error("no branch") }),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "push",
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Default branch unresolved → trigger pre-filer skipped, no finding.
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - native trigger pre-filer files a test/lint workflow with push to default",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [930],
      knownOpen: [],
      issueCreateNumbers: [930],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // Top-level `permissions:` keeps the permissions pre-filer quiet so
    // this test isolates the trigger pre-filer.
    const ciYml = [
      "name: CI",
      "on: push",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "main" }),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "push",
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(c.body, "<!-- finding-id: BP-TRIGGER-ci -->");
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:low"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-TRIGGER-ci"));
  },
);

Deno.test(
  "runTask - native trigger pre-filer skips a deploy workflow with push to default",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const publishYml = [
      "name: Publish",
      "on: push",
      "permissions:",
      "  contents: write",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "main" }),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/publish.yml",
            rawText: publishYml,
            parsed: {
              name: "Publish",
              on: "push",
              permissions: { contents: "write" },
              jobs: {
                publish: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "npm publish" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Deploy workflow → no trigger finding (and no other pre-filer fires).
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - native trigger pre-filer is skipped when the default branch cannot be resolved",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const ciYml = [
      "name: CI",
      "on: push",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: () =>
        Promise.resolve({ ok: false, error: new Error("no branch") }),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "push",
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // No default branch → pre-filer skipped → no finding.
    assertEquals(creates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Native checkout-persist-credentials pre-filer (Issue #2845)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - persist-credentials pre-filer files a checkout lacking the flag",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [940],
      knownOpen: [],
      issueCreateNumbers: [940],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // SHA-pinned checkout keeps the SHA-pin pre-filer quiet; scoped
    // top-level permissions keep the permissions pre-filer quiet;
    // `on: pull_request` keeps the trigger pre-filer quiet — so this test
    // isolates the persist-credentials finding.
    const sha = "a".repeat(40);
    const ciYml = [
      "name: CI",
      "on: pull_request",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "pull_request",
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [
                    { uses: `actions/checkout@${sha}` },
                    { run: "deno test" },
                  ],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-PERSIST-CREDS-ci-test-0 -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:medium"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-PERSIST-CREDS-ci-test-0"));
  },
);

Deno.test(
  "runTask - persist-credentials pre-filer leaves a pushing job untouched",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const sha = "b".repeat(40);
    const releaseYml = [
      "name: Release",
      "on: pull_request",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "      - run: git push origin main",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/release.yml",
            rawText: releaseYml,
            parsed: {
              name: "Release",
              on: "pull_request",
              permissions: { contents: "read" },
              jobs: {
                publish: {
                  "runs-on": "ubuntu-latest",
                  steps: [
                    { uses: `actions/checkout@${sha}` },
                    { run: "git push origin main" },
                  ],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Job pushes → needs the credential → no persist-credentials finding.
    assertEquals(creates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Native broad-artefact-upload pre-filer (Issue #2846)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - artefact-upload pre-filer files a `path: .` upload",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [950],
      knownOpen: [],
      issueCreateNumbers: [950],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // SHA-pinned checkout-free workflow with scoped top-level permissions
    // and `on: pull_request` keeps the other pre-filers quiet, isolating
    // the artefact-upload finding.
    const sha = "a".repeat(40);
    const ciYml = [
      "name: CI",
      "on: pull_request",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/upload-artifact@${sha}`,
      "        with:",
      "          path: .",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "pull_request",
              permissions: { contents: "read" },
              jobs: {
                build: {
                  "runs-on": "ubuntu-latest",
                  steps: [
                    {
                      uses: `actions/upload-artifact@${sha}`,
                      with: { path: "." },
                    },
                  ],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-ARTIFACT-UPLOAD-ci-build-0 -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    // `on: pull_request` (not privileged) and no secrets → low severity.
    assert(c.labels.includes("severity:low"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-ARTIFACT-UPLOAD-ci-build-0"));
  },
);

// ---------------------------------------------------------------------------
// Native milestone-branch-filter pre-filer (Issue #3360)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - milestone pre-filer files a CI workflow missing milestone/*",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [960],
      knownOpen: [],
      issueCreateNumbers: [960],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // `deno test` → test/high; `pull_request.branches: [main]` misses
    // milestone branches; top-level scoped permissions and no push / no
    // checkout / no upload / no third-party uses keep the other pre-filers
    // quiet, isolating the milestone finding.
    const validateYml = [
      "name: Validate",
      "on:",
      "  pull_request:",
      "    branches: [Develop, main]",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/validate.yml",
            rawText: validateYml,
            parsed: {
              name: "Validate",
              on: { pull_request: { branches: ["Develop", "main"] } },
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-MILESTONE-FILTER-validate -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:medium"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(scanReceived!.knownOpen.includes("BP-MILESTONE-FILTER-validate"));
  },
);

Deno.test(
  "runTask - milestone pre-filer leaves a milestone-covered filter untouched",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const validateYml = [
      "name: Validate",
      "on:",
      "  pull_request:",
      "    branches: [Develop, main, 'milestone/*']",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: deno test",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/validate.yml",
            rawText: validateYml,
            parsed: {
              name: "Validate",
              on: {
                pull_request: { branches: ["Develop", "main", "milestone/*"] },
              },
              permissions: { contents: "read" },
              jobs: {
                test: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "deno test" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Native gitleaks-drift pre-filer (Issue #598, part of #566)
// ---------------------------------------------------------------------------

/** A gitleaks workflow with the given action ref and branch filter. */
function gitleaksFixture(ref: string, branches: string[]) {
  const rawText = [
    "name: Gitleaks",
    "on:",
    "  pull_request:",
    `    branches: [${branches.join(", ")}]`,
    "permissions:",
    "  contents: read",
    "jobs:",
    "  gitleaks:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: gitleaks/gitleaks-action@${ref}`,
    "      - name: Gitleaks (open-source CLI fallback)",
    "        run: ./gitleaks git --redact --no-banner --exit-code 1 .",
  ].join("\n");
  return {
    path: ".github/workflows/gitleaks.yml",
    rawText,
    parsed: {
      name: "Gitleaks",
      on: { pull_request: { branches } },
      permissions: { contents: "read" },
      jobs: {
        gitleaks: {
          "runs-on": "ubuntu-latest",
          steps: [
            { uses: `gitleaks/gitleaks-action@${ref}` },
            {
              name: "Gitleaks (open-source CLI fallback)",
              run: "./gitleaks git --redact --no-banner --exit-code 1 .",
            },
          ],
        },
      },
    },
    kind: "workflow" as const,
  };
}

Deno.test(
  "runTask - gitleaks pre-filer files a stale action pin and joins seenIds",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [970],
      knownOpen: [],
      issueCreateNumbers: [970],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // SHA-pinned (so the SHA-pin pre-filer stays quiet) but not the SHA
    // `pinnedAction()` resolves today, and milestone-covered so the branch
    // finding stays quiet — isolating the stale-pin finding.
    const stale = gitleaksFixture("c".repeat(40), [
      "Develop",
      "main",
      "milestone/*",
    ]);
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () => Promise.resolve([stale]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-GITLEAKS-ACTION-STALE-gitleaks -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:medium"));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(
      scanReceived!.knownOpen.includes("BP-GITLEAKS-ACTION-STALE-gitleaks"),
    );
  },
);

Deno.test(
  "runTask - gitleaks branch gap is not double-filed beside the milestone finding",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [971],
      knownOpen: [],
      issueCreateNumbers: [971],
    });
    // `["*"]` never matches `milestone/<slug>`, so both the milestone
    // pre-filer and the gitleaks drift scanner see the same gap. Only the
    // milestone finding may be filed. The action is pinned to the current
    // SHA and the CLI fallback is present, so no other drift class fires.
    const current = PINNED_ACTIONS["gitleaks/gitleaks-action"]!.sha;
    const drifted = gitleaksFixture(current, ['"*"']);
    drifted.parsed.on.pull_request.branches = ["*"];
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () => Promise.resolve([drifted]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    assertStringIncludes(
      creates[0]!.body,
      "<!-- finding-id: BP-MILESTONE-FILTER-gitleaks -->",
    );
  },
);

Deno.test(
  "runTask - gitleaks PR-coverage pre-filer files the finding and joins seenIds (Issue #601)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [972],
      knownOpen: [],
      issueCreateNumbers: [972],
    });
    // Canonical shape, so no drift class fires — this isolates the
    // observed-coverage finding.
    const current = PINNED_ACTIONS["gitleaks/gitleaks-action"]!.sha;
    const canonical = gitleaksFixture(current, [
      "Develop",
      "main",
      "milestone/*",
    ]);
    let scanReceived: { knownOpen: string[] } | undefined;
    let coverageArgs: { repo: string; fileCount: number } | undefined;
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () => Promise.resolve([canonical]),
      scanGitleaksPrCoverageFn: (repo, files, _ghFn, options) => {
        coverageArgs = { repo, fileCount: files.length };
        assert(
          !Array.from(options.knownOpenFindingIds).includes(
            "BP-GITLEAKS-NOT-OBSERVED",
          ),
        );
        return Promise.resolve([{
          findingId: "BP-GITLEAKS-NOT-OBSERVED",
          severity: "medium" as const,
          title:
            "🟠 Gitleaks workflow is present but never reported on a recent pull request",
          file: ".github/workflows/gitleaks.yml",
          lines: 3,
          whyItMatters: "why",
          suggestedFix: "fix",
          evidence: "Sampled #12, #11; no gitleaks check reported.",
        }]);
      },
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(coverageArgs, { repo: "org/repo", fileCount: 1 });
    assertEquals(
      creates.length,
      1,
      JSON.stringify(creates.map((c) => c.title)),
    );
    const created = creates[0]!;
    assertStringIncludes(
      created.body,
      "<!-- finding-id: BP-GITLEAKS-NOT-OBSERVED -->",
    );
    assertStringIncludes(created.body, "#12");
    assert(created.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(created.labels.includes("severity:medium"));
    assert(scanReceived!.knownOpen.includes("BP-GITLEAKS-NOT-OBSERVED"));
  },
);

Deno.test(
  "runTask - a degraded gitleaks coverage sample is logged, never silent (Issue #601)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const { logger, records } = makeLogger();
    const current = PINNED_ACTIONS["gitleaks/gitleaks-action"]!.sha;
    const canonical = gitleaksFixture(current, [
      "Develop",
      "main",
      "milestone/*",
    ]);
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () => Promise.resolve([canonical]),
      scanGitleaksPrCoverageFn: (_repo, _files, _ghFn, options) => {
        options.onSamplingNote(
          "gitleaks PR coverage: could not list closed pull requests for " +
            "org/repo: HTTP 403: Forbidden — coverage is unknown, not clean",
        );
        return Promise.resolve([]);
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 0);
    assert(
      records.some((r) =>
        r.startsWith("warn:") && r.includes("HTTP 403: Forbidden")
      ),
      JSON.stringify(records),
    );
  },
);

Deno.test(
  "runTask - artefact-upload pre-filer leaves a scoped path untouched",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const sha = "b".repeat(40);
    const ciYml = [
      "name: CI",
      "on: pull_request",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: actions/upload-artifact@${sha}`,
      "        with:",
      "          path: dist/",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: {
              name: "CI",
              on: "pull_request",
              permissions: { contents: "read" },
              jobs: {
                build: {
                  "runs-on": "ubuntu-latest",
                  steps: [
                    {
                      uses: `actions/upload-artifact@${sha}`,
                      with: { path: "dist/" },
                    },
                  ],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - SHA-pin coordinate already in existingIds is NOT re-filed",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [42],
      afterSnapshot: [42],
      knownOpen: [
        {
          number: 42,
          body: "<!-- finding-id: BP-SHA-PIN-actions-checkout -->\n\nExisting.",
        },
      ],
      issueCreateNumbers: [], // must NOT be called
    });
    const ciYml = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/ci.yml",
            rawText: ciYml,
            parsed: null,
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 0);
  },
);

Deno.test(
  "runTask - runner finding already in existingIds is NOT re-filed",
  async () => {
    const finding: DeprecationFinding = {
      stableId: "BP-RUNNER-actions-checkout-node20",
      action: "actions/checkout",
      pinnedRef: "v3",
      reason: "node20",
      runUrl: "https://github.com/org/repo/actions/runs/1",
      evidence: "evidence",
    };
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [70],
      afterSnapshot: [70],
      knownOpen: [
        {
          number: 70,
          body: `<!-- finding-id: ${finding.stableId} -->\n\nExisting.`,
        },
      ],
      issueCreateNumbers: [], // must NOT be called
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([finding]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // No new issues filed by the pre-filer (the existing one is in
    // existingIds).
    assertEquals(creates.length, 0);
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, [finding.stableId]);
    // No runner pre-files mentioned in the summary.
    assert(!result.summary.includes("Runner-deprecation pre-files:"));
  },
);

Deno.test(
  "runTask - runner-deprecation scanner throws → run completes, error in summary",
  async () => {
    const { gh } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
    });
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.reject(new Error("api timeout")),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertStringIncludes(result.summary, "no findings");
    assertStringIncludes(
      result.summary,
      "Runner-deprecation scan failed: api timeout.",
    );
  },
);

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
  const t = makeAuditTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    checkLinterInCIFn: linterOk,
    scanRunnerDeprecationsFn: () => Promise.resolve([]),
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
  assertStringIncludes(result.summary, "github-actions-audit failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ beforeSnapshot: [5], afterSnapshot: [5] });
  const t = makeAuditTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    checkLinterInCIFn: linterOk,
    scanRunnerDeprecationsFn: () => Promise.resolve([]),
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

Deno.test(
  "shouldFile - vetoes when open wrapper exists",
  async () => {
    const calls: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      calls.push([...args]);
      return Promise.resolve(
        JSON.stringify([
          {
            number: 9,
            title: GITHUB_ACTIONS_AUDIT_ISSUE_TITLE,
            // The veto now counts a title match only when the fleet wrote
            // it — a title alone is text anybody may write.
            author: { login: "vibe-bot" },
          },
        ]),
      );
    };
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      dedupAuthors: { fleetAuthors: ["vibe-bot"] },
    });
    const ok = await t.shouldFile?.({ repo: "acme/widget" }) ?? true;
    assertEquals(ok, false);
  },
);

Deno.test(
  "shouldFile - allows filing when no open wrapper exists",
  async () => {
    const gh = (_args: string[]): Promise<string> => Promise.resolve("[]");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
    });
    const ok = await t.shouldFile?.({ repo: "acme/widget" }) ?? false;
    assertEquals(ok, true);
  },
);

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test(
  "claim handler - dispatches a GitHub Actions audit wrapper to runTask",
  async () => {
    const { gh } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [11],
    });
    const template = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
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
        issueTitle: GITHUB_ACTIONS_AUDIT_ISSUE_TITLE,
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
      "GitHub Actions audit complete. Filed 1 issues: #11",
    );
  },
);

Deno.test(
  "runTask - native readers use the repo checkout, not the parent work dir (Issue #3292)",
  async () => {
    // `opts.workDir` is the PARENT holding every clone; the native
    // actionlint and workflow readers must be pointed at
    // `${workDir}/${repoName}` so they read the target repo's own
    // `.github/workflows` rather than the empty parent.
    const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
    const linterPaths: string[] = [];
    const workflowPaths: string[] = [];
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: (workDir: string) => {
        linterPaths.push(workDir);
        return linterOk();
      },
      readWorkflowFilesFn: (workDir: string) => {
        workflowPaths.push(workDir);
        return Promise.resolve([]);
      },
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    await t.runTask({
      repo: "stSoftwareAU/private-repo-9",
      workDir: "/work",
      idleTaskIssueNumber: 100,
    });

    assertEquals(linterPaths, ["/work/private-repo-9"]);
    assertEquals(workflowPaths, ["/work/private-repo-9"]);
  },
);

// ---------------------------------------------------------------------------
// Native unpinned-CI-install pre-filer (Issue #3668)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - CI-install pre-filer files an unpinned `run:` install",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [970],
      knownOpen: [],
      issueCreateNumbers: [970],
    });
    let scanReceived: { knownOpen: string[] } | undefined;
    // Scoped permissions, a milestone-covered filter, and no checkout /
    // upload / third-party `uses:` keep the other pre-filers quiet, so the
    // unpinned `gem install` is the only finding.
    const auditYml = [
      "name: Audit",
      "on:",
      "  pull_request:",
      "    branches: [main, 'milestone/*']",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: gem install bundler-audit",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/audit.yml",
            rawText: auditYml,
            parsed: {
              name: "Audit",
              on: { pull_request: { branches: ["main", "milestone/*"] } },
              permissions: { contents: "read" },
              jobs: {
                audit: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "gem install bundler-audit" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 1);
    const c = creates[0]!;
    assertStringIncludes(
      c.body,
      "<!-- finding-id: BP-CI-INSTALL-PIN-gem-bundler-audit -->",
    );
    assert(c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL));
    assert(c.labels.includes("severity:medium"));
    assert(!c.labels.some((l) => l.startsWith("lang:")));
    // The pre-filed id is in Claude's known-open list so the LLM does not
    // double-file it.
    assert(scanReceived !== undefined);
    assert(
      scanReceived!.knownOpen.includes("BP-CI-INSTALL-PIN-gem-bundler-audit"),
    );
  },
);

Deno.test(
  "runTask - CI-install pre-filer leaves an exactly-pinned install alone",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueCreateNumbers: [], // must NOT be called
    });
    const auditYml = [
      "name: Audit",
      "on:",
      "  pull_request:",
      "    branches: [main, 'milestone/*']",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: gem install bundler-audit -v 0.9.3",
    ].join("\n");
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      getDefaultBranchFn: branchMain,
      readWorkflowFilesFn: () =>
        Promise.resolve([
          {
            path: ".github/workflows/audit.yml",
            rawText: auditYml,
            parsed: {
              name: "Audit",
              on: { pull_request: { branches: ["main", "milestone/*"] } },
              permissions: { contents: "read" },
              jobs: {
                audit: {
                  "runs-on": "ubuntu-latest",
                  steps: [{ run: "gem install bundler-audit -v 0.9.3" }],
                },
              },
            },
            kind: "workflow" as const,
          },
        ]),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Native pre-filer failure is logged, not swallowed (Issue #3953)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - a throwing native pre-filer is logged, not swallowed",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
    });
    const { logger, records } = makeLogger();
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      // The workflow read feeding every native scanner blows up.
      readWorkflowFilesFn: () =>
        Promise.reject(new Error("workflow read exploded")),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    // The run still completes — the failure must not abort it …
    assert(result.ok);
    assertEquals(creates.length, 0);
    // … but it must be visible in the log rather than read as a clean audit.
    const errors = records.filter((r) => r.startsWith("error:"));
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0] as string, "native pre-filer block failed");
    assertStringIncludes(errors[0] as string, "workflow read exploded");
  },
);

// ---------------------------------------------------------------------------
// Model tier threading (Issue #4010)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - a stamped modelTier reaches the scan runner as `model`",
  async () => {
    const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
    const captured: Array<Record<string, unknown>> = [];
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      runScanFn: (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true, value: true });
      },
    });

    await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget",
      idleTaskIssueNumber: 100,
      modelTier: "sonnet",
    });
    assertEquals(captured.length, 1);
    assertEquals(captured[0]!.model, "sonnet");
  },
);

Deno.test(
  "runTask - an unstamped wrapper passes no `model` to the scan runner",
  async () => {
    const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
    const captured: Array<Record<string, unknown>> = [];
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      runScanFn: (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true, value: true });
      },
    });

    await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget",
      idleTaskIssueNumber: 100,
    });
    assert(
      !Object.hasOwn(captured[0]!, "model"),
      "expected no model key on the scan options",
    );
  },
);

Deno.test(
  "runGitHubActionsAuditScan - the tier becomes RunClaudeOptions.model",
  async () => {
    const captured: RunClaudeOptions[] = [];
    const result = await runGitHubActionsAuditScan(
      {
        repo: "acme/widget",
        workDir: "/tmp/widget",
        knownOpenFindingIds: [],
        openIssueTitles: [],
        suppressedIds: [],
        model: "fable",
      },
      okPrompt,
      (options) => {
        captured.push(options);
        return Promise.resolve({
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        });
      },
    );
    assertEquals(result.ok, true);
    assertEquals(captured[0]!.model, "fable");
    assert(
      (captured[0]!.timeoutSeconds ?? 0) > 0,
      "expected the idle-task timeout to be applied",
    );
  },
);

Deno.test(
  "runGitHubActionsAuditScan - no tier means no `model` key (regression pin)",
  async () => {
    const captured: RunClaudeOptions[] = [];
    await runGitHubActionsAuditScan(
      {
        repo: "acme/widget",
        workDir: "/tmp/widget",
        knownOpenFindingIds: [],
        openIssueTitles: [],
        suppressedIds: [],
      },
      okPrompt,
      (options) => {
        captured.push(options);
        return Promise.resolve({
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        });
      },
    );
    const options = captured[0] as unknown as Record<string, unknown>;
    assertEquals(Object.hasOwn(options, "model"), false);
  },
);

// ---------------------------------------------------------------------------
// GHSA cross-check (Issue #4405) and repository-settings drift
// (Issues #4397, #4398, #4401) are filed by the native pre-filers
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - a GHSA advisory against a pinned action and a repository-settings gap are filed as audit findings (Issues #4405, #4397, #4398, #4401)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      issueCreateNumbers: [901, 902],
    });
    const { logger, records } = makeLogger();
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () =>
        Promise.resolve([{
          path: ".github/workflows/ci.yml",
          rawText: "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@" +
            "3d3c42e5aac5ba805825da76410c181273ba90b1\n",
          parsed: null,
          kind: "workflow" as const,
        }]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "Develop" }),
      scanActionAdvisoriesFn: (files, _gh, known) => {
        assertEquals(files.length, 1);
        assert(
          !Array.from(known).includes(
            "BP-GHSA-actions-checkout-GHSA-test-0000-0000",
          ),
        );
        return Promise.resolve([{
          findingId: "BP-GHSA-actions-checkout-GHSA-test-0000-0000",
          coordinate: "actions/checkout",
          ghsaId: "GHSA-test-0000-0000",
          severity: "high" as const,
          title:
            "🔴 Pinned action `actions/checkout` has a disclosed advisory GHSA-test-0000-0000",
          file: ".github/workflows/ci.yml",
          lines: 4,
          whyItMatters: "why",
          suggestedFix: "fix",
          evidence: "evidence",
        }]);
      },
      scanRepoSettingsFn: (repo, _gh, options) => {
        assertEquals(repo, "org/repo");
        assertEquals(options.defaultBranch, "Develop");
        return Promise.resolve([{
          findingId: "BP-REPO-DEFAULT-TOKEN-WRITE",
          severity: "high" as const,
          title: "🔴 Repository default GITHUB_TOKEN is read-write",
          file: "repository settings",
          lines: 0,
          whyItMatters: "why",
          suggestedFix: "Repository admin action.",
          evidence: "default_workflow_permissions=write",
        }]);
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });
    assert(result.ok);
    assertEquals(
      creates.length,
      2,
      JSON.stringify(creates.map((c) => c.title)),
    );
    assert(creates.some((c) => c.title.includes("GHSA-test-0000-0000")));
    assert(creates.some((c) => c.title.includes("read-write")));
    assert(creates.every((c) => c.labels.includes(GITHUB_ACTIONS_AUDIT_LABEL)));
    assertEquals(records.filter((r) => r.startsWith("error:")), []);
  },
);

Deno.test(
  "runTask - a failing GHSA lookup or settings read is logged loud and files nothing (Issues #4405, #4398)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
    });
    const { logger, records } = makeLogger();
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "Develop" }),
      scanActionAdvisoriesFn: (_f, _g, _k, onLookupFailure) => {
        onLookupFailure("actions/checkout", "HTTP 403");
        return Promise.resolve([]);
      },
      scanRepoSettingsFn: () => Promise.reject(new Error("settings exploded")),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });
    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });
    assert(result.ok);
    assertEquals(creates.length, 0);
    const errors = records.filter((r) => r.startsWith("error:"));
    assert(
      errors.some((e) =>
        e.includes("GHSA lookup failed for actions/checkout") &&
        e.includes("HTTP 403")
      ),
      JSON.stringify(errors),
    );
    assert(
      errors.some((e) =>
        e.includes("repository-settings pre-filer failed") &&
        e.includes("settings exploded")
      ),
      JSON.stringify(errors),
    );
  },
);

// ---------------------------------------------------------------------------
// Worker-token privilege escalation (Issue #599)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - an over-privileged worker token is filed as a needs-human security escalation (Issue #599)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      issueCreateNumbers: [910],
    });
    const { logger, records } = makeLogger();
    const ensured: string[] = [];
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () => Promise.resolve([]),
      scanActionAdvisoriesFn: () => Promise.resolve([]),
      scanRepoSettingsFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "Develop" }),
      ensureFindingLabelsFn: (_repo, labels) => {
        ensured.push(...labels);
        return Promise.resolve();
      },
      scanWorkerTokenPrivilegesFn: (repo, _gh, options) => {
        assertEquals(repo, "org/repo");
        assert(
          !Array.from(options.knownOpenFindingIds).includes(
            "BP-WORKER-TOKEN-CAN-EDIT-RULESETS",
          ),
        );
        return Promise.resolve([{
          findingId: "BP-WORKER-TOKEN-CAN-EDIT-RULESETS",
          severity: "high" as const,
          title:
            "🔴 The worker's GitHub token holds `admin` on org/repo — it can delete the ruleset that gates merges",
          file: "worker GitHub token",
          lines: 0,
          whyItMatters: "why",
          suggestedFix: "Human action — downgrade to write.",
          evidence: "repos/org/repo .permissions: admin=true",
          labels: ["needs-human", "security"] as const,
        }]);
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });
    assert(result.ok);
    assertEquals(creates.length, 1);
    const created = creates[0]!;
    assert(created.title.includes("ruleset"), created.title);
    for (const label of ["needs-human", "security", "severity:high"]) {
      assert(created.labels.includes(label), created.labels.join(","));
    }
    assertEquals(ensured.sort(), ["needs-human", "security"]);
    assertEquals(records.filter((r) => r.startsWith("error:")), []);
  },
);

Deno.test(
  "runTask - a failing worker-token privilege check is logged loud and files nothing (Issue #599)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
    });
    const { logger, records } = makeLogger();
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () => Promise.resolve([]),
      scanActionAdvisoriesFn: () => Promise.resolve([]),
      scanRepoSettingsFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "Develop" }),
      scanWorkerTokenPrivilegesFn: (_repo, _gh, options) => {
        options.onLookupFailure("repos/org/repo (.permissions)", "HTTP 403");
        return Promise.resolve([]);
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });
    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });
    assert(result.ok);
    assertEquals(creates.length, 0);
    assert(
      records.some((r) =>
        r.startsWith("error:") &&
        r.includes("worker token privilege lookup failed") &&
        r.includes("HTTP 403")
      ),
      JSON.stringify(records),
    );
  },
);

// ---------------------------------------------------------------------------
// Repo-wide open-issue titles (Issue #537)
// ---------------------------------------------------------------------------

/**
 * Wrap the shared gh stub so the repo-wide open-issue title lookup —
 * `issue list --json number,title` with neither `--label` nor `--search` —
 * answers with `titles`. `fail` makes that lookup (and only that lookup)
 * throw, so the degrade-to-empty path can be exercised.
 */
function withTitleLookup(
  gh: (args: string[]) => Promise<string>,
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
    return gh(args);
  };
}

Deno.test(
  "assembleGitHubActionsAuditPrompt - open issue titles are substituted",
  () => {
    const out = assembleGitHubActionsAuditPrompt(
      "Already open:\n{{OPEN_ISSUE_TITLES}}",
      {
        suppressedIds: [],
        knownOpenFindingIds: [],
        openIssueTitles: [{ number: 37, title: "Add a CODEOWNERS file" }],
      },
    );
    assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
    assertStringIncludes(out, "#37 — Add a CODEOWNERS file");
  },
);

Deno.test(
  "assembleGitHubActionsAuditPrompt - an empty open-issue list renders (none)",
  () => {
    const out = assembleGitHubActionsAuditPrompt(
      "Already open:\n{{OPEN_ISSUE_TITLES}}",
      {
        suppressedIds: [],
        knownOpenFindingIds: [],
        openIssueTitles: [],
      },
    );
    assertEquals(out, "Already open:\n(none)");
  },
);

Deno.test(
  "runTask - repo-wide open issue titles reach the scan runner",
  async () => {
    const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
    const seen: OpenIssueTitle[][] = [];
    const t = makeAuditTemplate({
      ghCommandFn: withTitleLookup(gh, [
        { number: 37, title: "Add a CODEOWNERS file" },
      ]),
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
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
  },
);

Deno.test(
  "runTask - a gh failure listing titles degrades to an empty list",
  async () => {
    const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
    const seen: OpenIssueTitle[][] = [];
    const t = makeAuditTemplate({
      ghCommandFn: withTitleLookup(gh, [], true),
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
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
  },
);

// ---------------------------------------------------------------------------
// A check the token may not run is skipped LOUDLY, never reported clean
// (Issue #1094)
// ---------------------------------------------------------------------------

Deno.test(
  "isNotPermittedLookup - a 403 is a permission limit; a 5xx, a network fault and a parse fault are not (Issue #1094)",
  () => {
    assert(isNotPermittedLookup(
      "gh command failed (exit 1): gh: You must have repository read " +
        "permissions or have the repository Actions policies fine-grained " +
        "permission. (HTTP 403)",
    ));
    assert(isNotPermittedLookup("Resource not accessible by integration"));
    assertEquals(isNotPermittedLookup("HTTP 500 Internal Server Error"), false);
    assertEquals(isNotPermittedLookup("HTTP 404 Not Found"), false);
    assertEquals(isNotPermittedLookup("connection reset by peer"), false);
    assertEquals(isNotPermittedLookup("Unexpected token < in JSON"), false);
  },
);

Deno.test(
  "renderGitHubActionsAuditSummary - a skipped check is named in the result, so a partial audit never reads as a clean one (Issue #1094)",
  () => {
    const summary = renderGitHubActionsAuditSummary([], {
      skippedChecks: [
        {
          check: "actions/permissions/workflow",
          reason: "HTTP 403",
          notPermitted: true,
        },
        {
          check: "rules/branches/Develop",
          reason: "HTTP 500",
          notPermitted: false,
        },
      ],
    });
    // Still says "no findings" — and immediately says what it did not look at.
    assertStringIncludes(summary, "no findings");
    assertStringIncludes(summary, "NOT covered by this audit");
    assertStringIncludes(summary, "actions/permissions/workflow");
    assertStringIncludes(summary, ACTIONS_POLICY_PERMISSION);
    assertStringIncludes(summary, "rules/branches/Develop");
    assertStringIncludes(summary, "HTTP 500");
  },
);

Deno.test(
  "runTask - a 403 on the Actions policy endpoints logs no ERROR and names the skipped checks in the summary (Issue #1094)",
  async () => {
    const { gh, creates } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
    });
    const { logger, records } = makeLogger();
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () => Promise.resolve([]),
      scanActionAdvisoriesFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "Develop" }),
      scanRepoSettingsFn: (_repo, _gh, options) => {
        options.onLookupFailure(
          "actions/permissions/workflow",
          "gh command failed (exit 1): gh: You must have repository read " +
            "permissions or have the repository Actions policies " +
            "fine-grained permission. (HTTP 403)",
        );
        options.onLookupFailure(
          "actions/permissions",
          "gh command failed (exit 1): (HTTP 403)",
        );
        return Promise.resolve([]);
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(creates.length, 0);
    // Acceptance 1: no ERROR line at all for a permission limit.
    assertEquals(records.filter((r) => r.startsWith("error:")), []);
    // Logged once per endpoint at WARNING, naming the scope to grant.
    const warnings = records.filter((r) =>
      r.startsWith("warn:") && r.includes("not permitted")
    );
    assertEquals(warnings.length, 2, JSON.stringify(warnings));
    assert(
      warnings.every((w) => w.includes(ACTIONS_POLICY_PERMISSION)),
      JSON.stringify(warnings),
    );
    // Acceptance 2: the audit's own result names what it could not run.
    assertStringIncludes(result.summary, "NOT covered by this audit");
    assertStringIncludes(result.summary, "actions/permissions/workflow");
    assertStringIncludes(result.summary, "actions/permissions (");
  },
);

Deno.test(
  "runTask - a non-403 settings lookup failure still logs ERROR and is still named as skipped (Issue #1094)",
  async () => {
    const { gh } = makeGhStub({ beforeSnapshot: [], afterSnapshot: [] });
    const { logger, records } = makeLogger();
    const t = makeAuditTemplate({
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      checkLinterInCIFn: linterOk,
      scanRunnerDeprecationsFn: () => Promise.resolve([]),
      readWorkflowFilesFn: () => Promise.resolve([]),
      scanActionAdvisoriesFn: () => Promise.resolve([]),
      getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "Develop" }),
      scanRepoSettingsFn: (_repo, _gh, options) => {
        options.onLookupFailure(
          "actions/permissions",
          "HTTP 500 Internal Server Error",
        );
        return Promise.resolve([]);
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
      logger,
    });

    const result = await t.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Acceptance 3: a genuine fault is still loud.
    assert(
      records.some((r) =>
        r.startsWith("error:") &&
        r.includes("repository settings lookup failed (actions/permissions)")
      ),
      JSON.stringify(records),
    );
    assertStringIncludes(result.summary, "NOT covered by this audit");
    assertStringIncludes(result.summary, "HTTP 500");
  },
);
