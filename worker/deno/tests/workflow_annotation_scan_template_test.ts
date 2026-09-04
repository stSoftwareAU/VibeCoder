/**
 * Tests for the workflow-annotation-scan idle-task template (Issue #3488).
 *
 * Covers:
 *   - registration under the exact name at module load;
 *   - the canonical wrapper contract (title, cooldown, skipMilestone,
 *     outputLabel, requiresStructuredOutput, body fingerprint);
 *   - runTask orchestration (fetch → classify → file) verified by snapshot-diff;
 *   - per-class dedup (a class already open is skipped);
 *   - the fail-loud contract (a fetcher throw forces `ok: false`);
 *   - shouldFile veto when findings or a wrapper are already open;
 *   - pure marker / body / summary helpers.
 *
 * All dependencies are injected so the tests never touch the network.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { getTemplate } from "../lib/idle_task_template.ts";
import {
  annotationClassMarker,
  createWorkflowAnnotationScanTemplate,
  renderFindingBody,
  renderWorkflowAnnotationScanSummary,
  WORKFLOW_ANNOTATION_SCAN_BODY_FINGERPRINT,
  WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
  WORKFLOW_ANNOTATION_SCAN_LABEL,
  type WorkflowAnnotationFinding,
} from "../lib/idle_task_templates/workflow_annotation_scan_template.ts";
import type { WorkflowRunAnnotation } from "../lib/workflow_annotation_fetcher.ts";
import { pinPromptsToThisCheckout } from "./support/repo_prompts.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
pinPromptsToThisCheckout();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

function annotation(
  overrides: Partial<WorkflowRunAnnotation> = {},
): WorkflowRunAnnotation {
  return {
    level: "warning",
    message: "Node.js 16 actions are deprecated",
    title: "",
    path: "",
    rawDetails: "",
    runId: 1,
    runUrl: "https://github.com/org/repo/actions/runs/1",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    ...overrides,
  };
}

function finding(
  overrides: Partial<WorkflowAnnotationFinding> = {},
): WorkflowAnnotationFinding {
  return {
    classKey: "deprecated-runtime",
    title: "🟠 Deprecated runtime warning on passing runs",
    body: "A passing run still emits a deprecated-runtime warning.",
    severity: "medium",
    ...overrides,
  };
}

/**
 * gh stub that answers the two `issue list --label` snapshots (before/after)
 * with a caller-supplied sequence and records `issue create` calls. Any other
 * list query returns `[]`.
 */
function makeGh(opts: {
  labelListResponses?: string[];
  classKeyBodies?: string[];
} = {}) {
  const calls: GhCall[] = [];
  const labelListResponses = [...(opts.labelListResponses ?? [])];
  let created = 5000;
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "create") {
      created += 1;
      return Promise.resolve(
        `https://github.com/org/repo/issues/${created}\n`,
      );
    }
    if (args[0] === "issue" && args[1] === "list") {
      const jsonIdx = args.indexOf("--json");
      const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
      // Dedup query: `--json body` filtered to the scan label.
      if (fields === "body") {
        const bodies = (opts.classKeyBodies ?? []).map((k) => ({
          body: annotationClassMarker(k),
        }));
        return Promise.resolve(JSON.stringify(bodies));
      }
      // before/after snapshot query: `--json number`.
      if (labelListResponses.length > 0) {
        return Promise.resolve(labelListResponses.shift()!);
      }
      return Promise.resolve("[]");
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

const createCalls = (calls: GhCall[]): GhCall[] =>
  calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("workflow-annotation-scan registers under its exact name at module load", () => {
  const template = getTemplate("workflow-annotation-scan");
  assert(template !== undefined, "template must be registered");
  assertEquals(template!.name, "workflow-annotation-scan");
});

Deno.test("workflow-annotation-scan honours the canonical wrapper contract", () => {
  const t = createWorkflowAnnotationScanTemplate();
  assertEquals(
    t.buildIssueTitle("org/repo"),
    WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
  );
  assertEquals(t.cooldownHours, 168);
  assertEquals(t.skipMilestone, true);
  assertEquals(t.outputLabel, WORKFLOW_ANNOTATION_SCAN_LABEL);
  assertEquals(t.requiresStructuredOutput, true);
});

Deno.test("workflow-annotation-scan body fingerprint matches the prompt H1", async () => {
  const t = createWorkflowAnnotationScanTemplate();
  const body = await t.buildIssueBody({
    repo: "org/repo",
    pickedAt: "2026-07-17T00:00:00.000Z",
    workerUser: "vibe-bot",
  });
  assert(
    WORKFLOW_ANNOTATION_SCAN_BODY_FINGERPRINT.test(body),
    "wrapper body must match the body fingerprint",
  );
  assert(t.matchesIdleTaskBody!(body));
  assert(!t.matchesIdleTaskBody!("# Something Else"));
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("annotationClassMarker embeds the class key in a hidden marker", () => {
  assertEquals(
    annotationClassMarker("deprecated-runtime"),
    "<!-- annotation-class: deprecated-runtime -->",
  );
});

Deno.test("renderFindingBody leads with the class marker and ends with the footer", () => {
  const body = renderFindingBody(finding(), "— footer —");
  assertStringIncludes(body, "<!-- annotation-class: deprecated-runtime -->");
  assertStringIncludes(body, "A passing run still emits");
  assert(body.trimEnd().endsWith("— footer —"));
});

Deno.test("renderWorkflowAnnotationScanSummary wording", () => {
  assertEquals(renderWorkflowAnnotationScanSummary([]), "no findings");
  assertEquals(
    renderWorkflowAnnotationScanSummary([9, 7]),
    "Workflow-annotation scan complete. Filed 2 issues: #7, #9",
  );
});

// ---------------------------------------------------------------------------
// runTask orchestration
// ---------------------------------------------------------------------------

Deno.test("runTask fetches, classifies, files new classes, and reports the diff", async () => {
  // before: [], after: two new issues.
  const gh = makeGh({
    labelListResponses: ["[]", '[{"number":11},{"number":12}]'],
  });
  const fetched: string[] = [];
  const t = createWorkflowAnnotationScanTemplate({
    ghCommandFn: gh.fn,
    ensureLabelsFn: () => Promise.resolve(),
    fetchAnnotationsFn: (repo) => {
      fetched.push(repo);
      return Promise.resolve([annotation()]);
    },
    classifyAnnotationsFn: () => [
      finding({ classKey: "class-a" }),
      finding({ classKey: "class-b" }),
    ],
  });

  const result = await t.runTask({
    repo: "org/repo",
    workDir: "/tmp/work",
    idleTaskIssueNumber: 1,
  });

  assert(result.ok);
  assertEquals(fetched, ["org/repo"]);
  // Two findings → two issue create calls.
  assertEquals(createCalls(gh.calls).length, 2);
  assertStringIncludes(result.summary, "Filed 2 issues: #11, #12");
});

Deno.test("runTask skips a class whose marker is already open (per-class dedup)", async () => {
  const gh = makeGh({
    labelListResponses: ["[]", "[]"],
    classKeyBodies: ["class-a"],
  });
  const t = createWorkflowAnnotationScanTemplate({
    ghCommandFn: gh.fn,
    ensureLabelsFn: () => Promise.resolve(),
    fetchAnnotationsFn: () => Promise.resolve([annotation()]),
    classifyAnnotationsFn: () => [
      finding({ classKey: "class-a" }), // already open — skipped
      finding({ classKey: "class-b" }), // new — filed
    ],
  });

  const result = await t.runTask({
    repo: "org/repo",
    workDir: "/tmp/work",
    idleTaskIssueNumber: 1,
  });

  assert(result.ok);
  assertEquals(createCalls(gh.calls).length, 1);
});

Deno.test("runTask fails loud when the fetcher throws (Issue #3234)", async () => {
  const gh = makeGh();
  const t = createWorkflowAnnotationScanTemplate({
    ghCommandFn: gh.fn,
    ensureLabelsFn: () => Promise.resolve(),
    fetchAnnotationsFn: () => Promise.reject(new Error("gh api 502")),
  });

  const result = await t.runTask({
    repo: "org/repo",
    workDir: "/tmp/work",
    idleTaskIssueNumber: 1,
  });

  assert(!result.ok, "a fetcher throw must not be reconciled as success");
  assertStringIncludes(result.summary, "gh api 502");
  assertEquals(createCalls(gh.calls).length, 0);
});

Deno.test("runTask reports no findings when the classifier returns nothing", async () => {
  const gh = makeGh({ labelListResponses: ["[]", "[]"] });
  const t = createWorkflowAnnotationScanTemplate({
    ghCommandFn: gh.fn,
    ensureLabelsFn: () => Promise.resolve(),
    fetchAnnotationsFn: () => Promise.resolve([annotation()]),
    classifyAnnotationsFn: () => [],
  });
  const result = await t.runTask({
    repo: "org/repo",
    workDir: "/tmp/work",
    idleTaskIssueNumber: 1,
  });
  assert(result.ok);
  assertEquals(result.summary, "no findings");
  assertEquals(createCalls(gh.calls).length, 0);
});

// ---------------------------------------------------------------------------
// shouldFile veto
// ---------------------------------------------------------------------------

Deno.test("shouldFile vetoes while an un-triaged batch of findings is open", async () => {
  const gh = makeGh({ classKeyBodies: ["class-a"] });
  const t = createWorkflowAnnotationScanTemplate({ ghCommandFn: gh.fn });
  assertEquals(await t.shouldFile!({ repo: "org/repo" }), false);
});

Deno.test("shouldFile vetoes while a prior wrapper is still open", async () => {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const jsonIdx = args.indexOf("--json");
    const fields = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (fields === "body") return Promise.resolve("[]"); // no open findings
    // wrapper title search returns the open wrapper.
    return Promise.resolve(
      JSON.stringify([
        { number: 3, title: WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE },
      ]),
    );
  };
  const t = createWorkflowAnnotationScanTemplate({ ghCommandFn: fn });
  assertEquals(await t.shouldFile!({ repo: "org/repo" }), false);
});

Deno.test("shouldFile allows filing on a clean repo", async () => {
  const gh = makeGh(); // no findings, no wrapper
  const t = createWorkflowAnnotationScanTemplate({ ghCommandFn: gh.fn });
  assertEquals(await t.shouldFile!({ repo: "org/repo" }), true);
});
