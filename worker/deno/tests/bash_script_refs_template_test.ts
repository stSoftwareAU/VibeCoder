/**
 * Tests for the bash script-reference idle-task template
 * (Issue #3228, parent #3224 — layer 2 of the bash compile-equivalent
 * checks).
 *
 * Coverage:
 *   - registration at module load; contract flags
 *   - title + body fingerprint dispatch signals; no raw placeholders
 *   - prevention-first finding body leads with the fix + CI-guard advice
 *   - runTask happy path: ensures the label, files one issue per missing
 *     path, returns the before/after diff summary
 *   - runTask fail-loud path: a scanner error surfaces as ok:false
 *   - runTask edge case: no findings → "no findings"
 *   - claim handler dispatches the wrapper to runTask
 *
 * Every test exercises the real functions against injected stubs — no
 * network, no filesystem, no Claude. Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  BASH_MISSING_SCRIPT_LABEL,
  BASH_SCRIPT_REFS_BODY_FINGERPRINT,
  BASH_SCRIPT_REFS_ISSUE_TITLE,
  bashScriptRefsTemplate,
  createBashScriptRefsTemplate,
  renderBashScriptRefsSummary,
  renderMissingScriptBody,
  renderMissingScriptTitle,
} from "../lib/idle_task_templates/bash_script_refs_template.ts";
import type { BashMissingScriptFinding } from "../lib/bash_script_refs_scanner.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_PROMPT = [
  "# Bash Script-Reference Scan (v1)",
  "",
  "Body describing the native scan.",
  "",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

const finding = (
  missingPath: string,
  id: string,
): BashMissingScriptFinding => ({
  findingId: id,
  missingPath,
  references: [
    {
      sourceFile: "worker/run.sh",
      line: 42,
      rawRef: "${BASE_DIR}/shared/helper.sh",
      kind: "source",
      shellcheckSource: null,
    },
  ],
  candidatesTried: [missingPath, `alt/${missingPath}`],
});

/**
 * gh stub. `--json number` calls are the before/after snapshots (first and
 * second entry of `snapshots`); `--json number,body` is the dedup lookup;
 * `issue create` returns a synthetic issue URL from `createNumbers`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  dedup?: Array<{ number: number; body: string }>;
  createNumbers?: number[];
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
    if (jsonField === "number") {
      const snap = scenario.snapshots ?? [[], []];
      const result = snapshotCount === 0 ? snap[0] : snap[1];
      snapshotCount += 1;
      return Promise.resolve(
        JSON.stringify(result.map((n) => ({ number: n }))),
      );
    }
    if (jsonField === "number,body") {
      return Promise.resolve(JSON.stringify(scenario.dedup ?? []));
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

Deno.test("bash-script-refs - registered at module load", () => {
  const t = getTemplate("bash-script-refs");
  assert(t !== undefined);
  assertEquals(t, bashScriptRefsTemplate);
  assert(listTemplates().some((x) => x.name === "bash-script-refs"));
});

Deno.test("bash-script-refs - contract flags", () => {
  assertEquals(bashScriptRefsTemplate.cooldownHours, 168);
  assertEquals(bashScriptRefsTemplate.skipMilestone, true);
  assertEquals(bashScriptRefsTemplate.outputLabel, BASH_MISSING_SCRIPT_LABEL);
  assertEquals(bashScriptRefsTemplate.requiresStructuredOutput, true);
  assertEquals(
    bashScriptRefsTemplate.buildIssueTitle("acme/widget"),
    BASH_SCRIPT_REFS_ISSUE_TITLE,
  );
});

Deno.test("bash-script-refs - buildIssueBody matches title and fingerprint", async () => {
  const t = createBashScriptRefsTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-05T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(t.buildIssueTitle("acme/widget"), BASH_SCRIPT_REFS_ISSUE_TITLE);
  assert(t.matchesIdleTaskBody?.(body) === true);
  assert(BASH_SCRIPT_REFS_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders");
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `bash-script-refs`",
  );
});

// ---------------------------------------------------------------------------
// Finding rendering (prevention-first)
// ---------------------------------------------------------------------------

Deno.test("renderMissingScriptTitle - names the missing path", () => {
  const f = finding("worker/shared/helper.sh", "BP-abc123abc123");
  assertEquals(
    renderMissingScriptTitle(f),
    "Bash: missing sourced/called script `worker/shared/helper.sh`",
  );
});

Deno.test("renderMissingScriptBody - leads with fix + CI-guard, lists sites", () => {
  const f = finding("worker/shared/helper.sh", "BP-abc123abc123");
  const body = renderMissingScriptBody(f, "FOOTER-LINE");
  // finding-id marker on its own line at the top.
  assertStringIncludes(body, "<!-- finding-id: BP-abc123abc123 -->");
  // Prevention-first: Fix section precedes the reference list.
  const fixIdx = body.indexOf("## Fix (do this first)");
  const preventIdx = body.indexOf("## Prevent recurrence");
  const refIdx = body.indexOf("## Referenced from");
  assert(fixIdx >= 0 && preventIdx >= 0 && refIdx >= 0);
  assert(fixIdx < refIdx, "fix must lead the reference list");
  assert(preventIdx < refIdx, "prevention must lead the reference list");
  // CI-guard recommendation references the FLEET patterns.
  assertStringIncludes(body, "WorkerSourcePathsExist");
  assertStringIncludes(body, "fleet_source_or_fail");
  // Site is cited with file:line and the raw reference.
  assertStringIncludes(body, "`worker/run.sh`:42");
  assertStringIncludes(body, "**Severity:** high");
  assertStringIncludes(body, "FOOTER-LINE");
});

Deno.test("renderBashScriptRefsSummary - wording", () => {
  assertEquals(renderBashScriptRefsSummary([]), "no findings");
  assertEquals(
    renderBashScriptRefsSummary([12, 3]),
    "Bash script-reference scan complete. Filed 2 issues: #3, #12",
  );
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("runTask - files one issue per missing path and diffs snapshot", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[], [11]],
    createNumbers: [11],
  });
  const ensureCalls: string[] = [];
  const t = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: (repo) => {
      ensureCalls.push(repo);
      return Promise.resolve({ ok: true, value: undefined });
    },
    scanFn: () =>
      Promise.resolve({
        ok: true,
        value: {
          findings: [finding("worker/shared/helper.sh", "BP-aaaaaaaaaaaa")],
          filesScanned: 3,
          skippedDynamic: [],
        },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(
    result.summary,
    "Bash script-reference scan complete. Filed 1 issues: #11",
  );
  assertEquals(ensureCalls, ["acme/widget"]);
  // A create call carried the label + severity.
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create !== undefined);
  assert(create!.includes(BASH_MISSING_SCRIPT_LABEL));
  assert(create!.includes("severity:high"));
});

Deno.test("runTask - dedup skips a missing path with an existing open issue", async () => {
  // The dedup lookup returns an open issue carrying the finding id, so no
  // new create call is made.
  const { gh, calls } = makeGhStub({
    snapshots: [[7], [7]],
    dedup: [{ number: 7, body: "<!-- finding-id: BP-aaaaaaaaaaaa -->" }],
  });
  const t = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    scanFn: () =>
      Promise.resolve({
        ok: true,
        value: {
          findings: [finding("worker/shared/helper.sh", "BP-aaaaaaaaaaaa")],
          filesScanned: 3,
          skippedDynamic: [],
        },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "expected no create call when the finding id already has an open issue",
  );
});

Deno.test("runTask - fail-loud when the scanner errors", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    scanFn: () =>
      Promise.resolve({
        ok: false,
        error: { kind: "read", message: "read denied" },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "bash-script-refs scan failed");
  assertStringIncludes(result.summary, "read");
  assertStringIncludes(result.summary, "read denied");
});

Deno.test("runTask - no findings reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    scanFn: () =>
      Promise.resolve({
        ok: true,
        value: { findings: [], filesScanned: 5, skippedDynamic: [] },
      }),
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
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => {
      throw new Error("kaboom");
    },
    scanFn: () =>
      Promise.resolve({
        ok: true,
        value: { findings: [], filesScanned: 0, skippedDynamic: [] },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "bash-script-refs threw");
  assertStringIncludes(result.summary, "kaboom");
});

Deno.test("runTask - scans the repo's own checkout, not the parent work dir (Issue #3292)", async () => {
  // Regression for the cross-repo false positives (#3292): `opts.workDir`
  // is the PARENT directory holding every clone side by side; the scanner
  // must be pointed at `${workDir}/${repoName}` so it never sweeps sibling
  // checkouts (NEAT-AI, VibeCoder, …) and files against the wrong repo.
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const scanRoots: string[] = [];
  const t = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    scanFn: (workDir, _repo) => {
      scanRoots.push(workDir);
      return Promise.resolve({
        ok: true,
        value: { findings: [], filesScanned: 0, skippedDynamic: [] },
      });
    },
  });

  await t.runTask({
    repo: "example-org/private-repo-21",
    workDir: "/work",
    idleTaskIssueNumber: 100,
  });

  // Derived from the parent work dir + repo name — never the bare parent.
  assertEquals(scanRoots, ["/work/FLEET-taxation"]);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a bash-script-refs wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]], createNumbers: [11] });
  const template = createBashScriptRefsTemplate({
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    scanFn: () =>
      Promise.resolve({
        ok: true,
        value: {
          findings: [finding("worker/shared/helper.sh", "BP-aaaaaaaaaaaa")],
          filesScanned: 3,
          skippedDynamic: [],
        },
      }),
  });
  const deps: HandleIdleTaskIssueDeps = {
    logger: makeLogger(),
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 100,
      issueTitle: BASH_SCRIPT_REFS_ISSUE_TITLE,
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
    "Bash script-reference scan complete. Filed 1 issues: #11",
  );
});
