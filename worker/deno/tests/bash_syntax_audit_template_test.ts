/**
 * Tests for the bash syntax-audit idle-task template (Issue #3238,
 * parent #3223 — template #11).
 *
 * Coverage:
 *   - registration at module load; contract flags
 *   - title + body fingerprint dispatch signals; no raw placeholders
 *   - pure finding assembly from stubbed detector results (severity, ids,
 *     unknown/not-applicable fail-safe)
 *   - runTask happy path: missing gate → files a finding with the correct
 *     label + severity
 *   - runTask edge case: all gates present → "no findings"
 *   - runTask fail-loud path: a detector throw → ok:false (never throws)
 *   - suppression: a suppressed gate id is not filed
 *   - claim handler dispatches the wrapper to runTask
 *
 * Every test exercises the real functions against injected stubs — no
 * network, no filesystem, no Claude. Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  BASH_SHELLCHECK_GATE_FINDING_ID,
  BASH_SYNTAX_AUDIT_BODY_FINGERPRINT,
  BASH_SYNTAX_AUDIT_ISSUE_TITLE,
  BASH_SYNTAX_AUDIT_LABEL,
  BASH_SYNTAX_GATE_FINDING_ID,
  bashGateFindings,
  bashSyntaxAuditTemplate,
  createBashSyntaxAuditTemplate,
  languageGateFindings,
  renderBashSyntaxAuditSummary,
  validityGateFindingId,
} from "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import type { BashCiGateResult } from "../lib/bash_ci_gate_scanner.ts";
import type { LanguageValidityResult } from "../lib/language_validity_gate.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_PROMPT = [
  "# Bash Syntax Audit (v1)",
  "",
  "Body describing the native audit.",
  "",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

const EMPTY_LANGS: RepoLanguages = {
  detected: [],
  primary: "unknown",
  raw: {},
};

function bashResult(
  overrides: Partial<BashCiGateResult> = {},
): BashCiGateResult {
  return {
    applicable: true,
    scriptCount: 3,
    configured: false,
    gates: { syntax: "present", shellcheck: "present" },
    workflowsLoaded: true,
    details: "Bash gate detector details.",
    ...overrides,
  };
}

function langResult(
  overrides: Partial<LanguageValidityResult> = {},
): LanguageValidityResult {
  return {
    language: "rust",
    present: true,
    details: "Rust validity detail.",
    workflowsLoaded: true,
    ...overrides,
  };
}

/** A fleet login, so a stubbed wrapper reads as one the fleet filed. */
const FLEET_DEDUP_AUTHOR = "vibe-bot";
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * gh stub. `--json number` calls are the before/after snapshots; the
 * `--json number,body,author` call is the dedup lookup; `issue create` returns a
 * synthetic issue URL from `createNumbers`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  dedup?: Array<{ number: number; body: string }>;
  createNumbers?: number[];
  wrapperOpen?: boolean;
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  let snapshotCount = 0;
  let createCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "create") {
      const nums = scenario.createNumbers ?? [];
      const n = nums[createCount] ?? 999;
      createCount += 1;
      return Promise.resolve(`https://github.com/acme/widget/issues/${n}`);
    }
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (jsonField === "number,body,author") {
      // Finding-id dedup look-up. Author-verified since Issue #1243, so the
      // stub answers as a fleet account — a marker anybody could write is not
      // evidence the fleet filed the finding.
      return Promise.resolve(
        JSON.stringify(
          (scenario.dedup ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    if (jsonField === "number,title" || (jsonField ?? "").includes("author")) {
      // Wrapper-open lookup used by shouldFile. The search now also asks for
      // `author`, because a title alone is text anybody may write and only
      // the author is authenticated; the stub answers as a fleet account so
      // the veto under test is a genuine fleet-filed wrapper.
      return Promise.resolve(
        scenario.wrapperOpen
          ? JSON.stringify([{
            number: 1,
            title: BASH_SYNTAX_AUDIT_ISSUE_TITLE,
            author: { login: FLEET_DEDUP_AUTHOR },
          }])
          : "[]",
      );
    }
    if (jsonField === "number") {
      const snap = scenario.snapshots ?? [[], []];
      const result = snapshotCount === 0 ? snap[0] : snap[1];
      snapshotCount += 1;
      return Promise.resolve(
        JSON.stringify(result.map((n) => ({ number: n }))),
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

const okLabel = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("bash-syntax-audit - registered at module load", () => {
  const t = getTemplate("bash-syntax-audit");
  assert(t !== undefined);
  assertEquals(t, bashSyntaxAuditTemplate);
  assert(listTemplates().some((x) => x.name === "bash-syntax-audit"));
});

Deno.test("bash-syntax-audit - contract flags", () => {
  assertEquals(bashSyntaxAuditTemplate.cooldownHours, 168);
  assertEquals(bashSyntaxAuditTemplate.skipMilestone, true);
  assertEquals(bashSyntaxAuditTemplate.outputLabel, BASH_SYNTAX_AUDIT_LABEL);
  assertEquals(bashSyntaxAuditTemplate.requiresStructuredOutput, true);
  assertEquals(
    bashSyntaxAuditTemplate.buildIssueTitle("acme/widget"),
    BASH_SYNTAX_AUDIT_ISSUE_TITLE,
  );
});

Deno.test("bash-syntax-audit - buildIssueBody matches title and fingerprint", async () => {
  const t = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    loadPromptFn: okPrompt,
  });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-05T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    BASH_SYNTAX_AUDIT_ISSUE_TITLE,
  );
  assert(t.matchesIdleTaskBody?.(body) === true);
  assert(BASH_SYNTAX_AUDIT_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders");
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `bash-syntax-audit`",
  );
});

// ---------------------------------------------------------------------------
// Pure finding assembly
// ---------------------------------------------------------------------------

Deno.test("bashGateFindings - missing syntax gate → high, missing shellcheck → medium", () => {
  const findings = bashGateFindings(
    bashResult({ gates: { syntax: "missing", shellcheck: "missing" } }),
  );
  assertEquals(findings.length, 2);
  const syntax = findings.find((f) =>
    f.findingId === BASH_SYNTAX_GATE_FINDING_ID
  );
  const shellcheck = findings.find((f) =>
    f.findingId === BASH_SHELLCHECK_GATE_FINDING_ID
  );
  assert(syntax !== undefined);
  assert(shellcheck !== undefined);
  assertEquals(syntax.severity, "high");
  assertEquals(shellcheck.severity, "medium");
});

Deno.test("bashGateFindings - unknown/not-applicable never files a finding", () => {
  // Unknown gates (e.g. zero workflows loaded) → no false positive.
  assertEquals(
    bashGateFindings(
      bashResult({ gates: { syntax: "unknown", shellcheck: "unknown" } }),
    ).length,
    0,
  );
  // No bash scripts → not applicable → no finding.
  assertEquals(
    bashGateFindings(bashResult({ applicable: false })).length,
    0,
  );
  // Both gates present → no finding.
  assertEquals(bashGateFindings(bashResult()).length, 0);
});

Deno.test("languageGateFindings - missing gate → high, present or unknown → none", () => {
  const findings = languageGateFindings([
    langResult({ language: "rust", present: false }),
    langResult({ language: "java", present: true }),
    // workflowsLoaded=false → status unknown → no false positive.
    langResult({ language: "python", present: false, workflowsLoaded: false }),
  ]);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.findingId, validityGateFindingId("rust"));
  assertEquals(findings[0]!.severity, "high");
});

Deno.test("renderBashSyntaxAuditSummary - wording", () => {
  assertEquals(renderBashSyntaxAuditSummary([]), "no findings");
  assertEquals(
    renderBashSyntaxAuditSummary([7, 3]),
    "Bash syntax audit complete. Filed 2 issues: #3, #7",
  );
  assertStringIncludes(
    renderBashSyntaxAuditSummary([], ["bash CI-gate detector failed: boom"]),
    "Detector errors: bash CI-gate detector failed: boom.",
  );
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("bash-syntax-audit runTask - missing gate files a finding with correct label + severity", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[], [50]],
    createNumbers: [50],
  });
  const t = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    checkBashCiGatesFn: () =>
      Promise.resolve(
        bashResult({ gates: { syntax: "missing", shellcheck: "present" } }),
      ),
    detectLanguagesFn: () => Promise.resolve({ ok: true, value: EMPTY_LANGS }),
    checkLanguageValidityGatesFn: () => Promise.resolve([]),
    collectSuppressedIdsFn: () => Promise.resolve(new Set<string>()),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Filed 1 issues: #50");
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create !== undefined, "expected an issue create call");
  assert(create.includes(BASH_SYNTAX_AUDIT_LABEL));
  assert(create.includes("severity:high"));
  const bodyIdx = create.indexOf("--body");
  assertStringIncludes(
    create[bodyIdx + 1]!,
    `<!-- finding-id: ${BASH_SYNTAX_GATE_FINDING_ID} -->`,
  );
});

Deno.test("bash-syntax-audit runTask - all gates present → no findings", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  const t = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    checkBashCiGatesFn: () => Promise.resolve(bashResult()),
    detectLanguagesFn: () => Promise.resolve({ ok: true, value: EMPTY_LANGS }),
    checkLanguageValidityGatesFn: () =>
      Promise.resolve([langResult({ present: true })]),
    collectSuppressedIdsFn: () => Promise.resolve(new Set<string>()),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "expected no issue create call",
  );
});

Deno.test("bash-syntax-audit runTask - detector throw → ok:false, never throws", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    checkBashCiGatesFn: () => {
      throw new Error("scanner exploded");
    },
    detectLanguagesFn: () => Promise.resolve({ ok: true, value: EMPTY_LANGS }),
    checkLanguageValidityGatesFn: () => Promise.resolve([]),
    collectSuppressedIdsFn: () => Promise.resolve(new Set<string>()),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "bash CI-gate detector failed");
  assertStringIncludes(result.summary, "scanner exploded");
});

Deno.test("bash-syntax-audit runTask - suppressed gate id is not filed", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  const t = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    checkBashCiGatesFn: () =>
      Promise.resolve(
        bashResult({ gates: { syntax: "missing", shellcheck: "present" } }),
      ),
    detectLanguagesFn: () => Promise.resolve({ ok: true, value: EMPTY_LANGS }),
    checkLanguageValidityGatesFn: () => Promise.resolve([]),
    collectSuppressedIdsFn: () =>
      Promise.resolve(new Set([BASH_SYNTAX_GATE_FINDING_ID])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "suppressed finding must not be filed",
  );
});

Deno.test("bash-syntax-audit runTask - native detectors use the repo checkout, not the parent work dir (Issue #3292)", async () => {
  // `opts.workDir` is the PARENT holding every clone; the three native
  // detectors must be pointed at `${workDir}/${repoName}` so they walk the
  // target repo's own tree rather than the wrong parent directory.
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const bashPaths: string[] = [];
  const langPaths: string[] = [];
  const suppressPaths: string[] = [];
  const t = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    checkBashCiGatesFn: (workDir: string) => {
      bashPaths.push(workDir);
      return Promise.resolve(bashResult());
    },
    detectLanguagesFn: () => Promise.resolve({ ok: true, value: EMPTY_LANGS }),
    checkLanguageValidityGatesFn: (workDir: string) => {
      langPaths.push(workDir);
      return Promise.resolve([]);
    },
    collectSuppressedIdsFn: (workDir: string) => {
      suppressPaths.push(workDir);
      return Promise.resolve(new Set<string>());
    },
  });

  await t.runTask({
    repo: "stSoftwareAU/private-repo-9",
    workDir: "/work",
    idleTaskIssueNumber: 1,
  });

  assertEquals(bashPaths, ["/work/private-repo-9"]);
  assertEquals(langPaths, ["/work/private-repo-9"]);
  assertEquals(suppressPaths, ["/work/private-repo-9"]);
});

// ---------------------------------------------------------------------------
// shouldFile veto
// ---------------------------------------------------------------------------

Deno.test("bash-syntax-audit shouldFile - vetoes while a wrapper is open", async () => {
  const openStub = makeGhStub({ wrapperOpen: true });
  const cleanStub = makeGhStub({ wrapperOpen: false });
  const openT = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    // The wrapper veto now counts a title match only when the fleet
    // authored it, so the test states the fleet rather than writing
    // a config file.
    dedupAuthors: { fleetAuthors: [FLEET_DEDUP_AUTHOR] },
    ghCommandFn: openStub.gh,
  });
  const cleanT = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: cleanStub.gh,
  });
  assertEquals(await openT.shouldFile!({ repo: "acme/widget" }), false);
  assertEquals(await cleanT.shouldFile!({ repo: "acme/widget" }), true);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("bash-syntax-audit - claim handler dispatches wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const template = createBashSyntaxAuditTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    checkBashCiGatesFn: () => Promise.resolve(bashResult()),
    detectLanguagesFn: () => Promise.resolve({ ok: true, value: EMPTY_LANGS }),
    checkLanguageValidityGatesFn: () => Promise.resolve([]),
    collectSuppressedIdsFn: () => Promise.resolve(new Set<string>()),
  });
  const deps: HandleIdleTaskIssueDeps = {
    logger: makeLogger(),
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue({
    repo: "acme/widget",
    issueNumber: 7,
    issueTitle: BASH_SYNTAX_AUDIT_ISSUE_TITLE,
    issueLabels: ["idle-task"],
    issueBody: "",
    workDir: "/tmp/widget",
  }, deps);

  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
});
