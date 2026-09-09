/**
 * Conformance tests: every provisioned workflow template must pass the
 * fleet's own GitHub Actions audit (Issue #1639).
 *
 * The templates in `worker/deno/lib/workflow_definitions.ts` are pushed
 * into every repository the fleet sets up. Until this test existed only
 * the gitleaks template was hardened to the audit's shape (Issue #594),
 * so a freshly provisioned repository immediately accrued a pile of
 * audit findings against workflows the fleet itself had just written.
 *
 * Rather than hand-writing per-template assertions — which drift from the
 * audit the moment a scanner changes — this test renders every template
 * and runs the audit's own native pre-filers over the rendered YAML:
 *
 *   - `scanCheckoutPersistCredentials` — credential persistence on checkout
 *   - `scanMilestoneBranchFilters`     — `pull_request` branch filter gaps
 *   - `scanActionPins`                 — 40-char SHA pins on `uses:`
 *   - `scanCiInstallPins`              — exact version pins on `run:` installs
 *   - `scanWorkflowPermissions`        — least-privilege `permissions:`
 *   - `scanWorkflowTriggers`           — push-to-default-branch triggers
 *
 * A scanner change that starts flagging a template fails here — the
 * templates and the audit cannot drift apart unnoticed.
 *
 * Two of those pre-filers only act on workflows `classifyWorkflow` rates
 * `test`/`high`, so the three templates that classify `ambiguous`
 * (dependency-review, java-dependency-check, shellcheck) would slip past
 * them. The branch-filter and push-trigger rules are therefore *also*
 * asserted structurally over every template, using the scanner's own
 * coverage decision — otherwise a regression in those three would go
 * unnoticed.
 *
 * The two remaining audit checks the pre-filers do not cover natively —
 * concurrency groups and job `timeout-minutes` (audit checks #4 and #5) —
 * are asserted structurally too. Every structural assertion is a loop over
 * the whole catalogue, never a hand-written per-template expectation.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import type { WorkflowSpec } from "../lib/workflow_definitions.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";
import { scanCheckoutPersistCredentials } from "../lib/checkout_persist_credentials_scanner.ts";
import { scanMilestoneBranchFilters } from "../lib/milestone_branch_filter_scanner.ts";
import { scanActionPins } from "../lib/action_pin_scanner.ts";
import { scanCiInstallPins } from "../lib/ci_install_pin_scanner.ts";
import { scanWorkflowPermissions } from "../lib/workflow_permissions_scanner.ts";
import {
  readOnBlock,
  scanWorkflowTriggers,
} from "../lib/workflow_trigger_scanner.ts";
import { workflowMilestoneCoverage } from "../lib/milestone_branch_filter_scanner.ts";

/**
 * Specs whose template is a Dependabot **configuration** file rather than
 * a GitHub Actions workflow. They have no `jobs:`, so no workflow-shaped
 * audit check applies to them.
 */
const NON_WORKFLOW_SPEC_IDS: readonly string[] = [
  "npm-dependency-updates",
  "java-dependency-updates",
];

/**
 * Default branches a provisioned repository may carry. The trigger
 * pre-filer needs one to decide whether a `push:` reaches the default
 * branch, and templates must be clean against either.
 */
const DEFAULT_BRANCHES: readonly string[] = ["Develop", "main"];

/** Job timeout budget per spec category (Issue #1639). */
const TIMEOUT_BY_CATEGORY: Readonly<Record<WorkflowSpec["category"], number>> =
  {
    security: 10,
    quality: 10,
    // A dependency-update job resolves the whole graph and opens a PR.
    "dependency-update": 20,
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every spec whose template is an actual GitHub Actions workflow. */
function workflowSpecs(): WorkflowSpec[] {
  return WORKFLOW_SPECS.filter((s) => !NON_WORKFLOW_SPEC_IDS.includes(s.id));
}

/**
 * Render each workflow template as the {@link WorkflowFile} the audit's
 * pre-filers consume — exactly what `readWorkflowFiles` would produce for
 * a repository the fleet has just provisioned.
 */
function renderedWorkflowFiles(): WorkflowFile[] {
  return workflowSpecs().map((spec) => ({
    path: `.github/workflows/${spec.suggestedFilename}`,
    rawText: spec.template,
    parsed: parseYaml(spec.template),
    kind: "workflow" as const,
  }));
}

/** Format scanner findings into an assertion message. */
function describe(
  findings: ReadonlyArray<{ findingId: string; file: string; lines: number }>,
): string {
  return findings
    .map((f) => `${f.findingId} (${f.file}:${f.lines})`)
    .join("; ");
}

Deno.test(
  "workflow templates - the non-workflow specs are exactly the Dependabot configs",
  () => {
    // Guards the exclusion list above: a new spec without `jobs:` must be
    // declared here deliberately, never silently skipped by the scans.
    const withoutJobs = WORKFLOW_SPECS.filter((spec) => {
      const parsed = parseYaml(spec.template);
      return !isRecord(parsed) || !isRecord(parsed["jobs"]);
    }).map((s) => s.id).sort();
    assertEquals(
      withoutJobs,
      [...NON_WORKFLOW_SPEC_IDS].sort(),
      "a workflow template with no `jobs:` mapping escapes every audit " +
        "pre-filer — add it to NON_WORKFLOW_SPEC_IDS only if it really is a " +
        "Dependabot config",
    );
  },
);

Deno.test(
  "workflow templates - no checkout persists credentials",
  () => {
    const findings = scanCheckoutPersistCredentials(renderedWorkflowFiles());
    assertEquals(
      findings.length,
      0,
      "provisioned templates leave the job token in .git/config — add " +
        `\`persist-credentials: false\` to: ${describe(findings)}`,
    );
  },
);

Deno.test(
  "workflow templates - no pull_request branch filter skips milestone PRs",
  () => {
    const findings = scanMilestoneBranchFilters(renderedWorkflowFiles());
    assertEquals(
      findings.length,
      0,
      "provisioned templates never gate milestone/<slug> PRs — list the " +
        `targets explicitly as [Develop, main, milestone/*]: ${
          describe(findings)
        }`,
    );
  },
);

Deno.test(
  "workflow templates - every action reference is SHA-pinned",
  () => {
    const findings = scanActionPins(renderedWorkflowFiles());
    assertEquals(
      findings.length,
      0,
      `provisioned templates reference a mutable action ref: ${
        describe(findings)
      }`,
    );
  },
);

Deno.test(
  "workflow templates - every run: install is pinned to an exact version",
  () => {
    const findings = scanCiInstallPins(renderedWorkflowFiles());
    assertEquals(
      findings.length,
      0,
      "provisioned templates fetch a package outside the dependency " +
        `quarantine: ${describe(findings)}`,
    );
  },
);

Deno.test(
  "workflow templates - every workflow declares least-privilege permissions",
  () => {
    const findings = scanWorkflowPermissions(renderedWorkflowFiles());
    assertEquals(
      findings.length,
      0,
      `provisioned templates inherit the broad default token: ${
        describe(findings)
      }`,
    );
  },
);

Deno.test(
  "workflow templates - no test/lint workflow triggers on push to default",
  () => {
    for (const defaultBranch of DEFAULT_BRANCHES) {
      const findings = scanWorkflowTriggers(renderedWorkflowFiles(), {
        defaultBranch,
      });
      assertEquals(
        findings.length,
        0,
        `provisioned templates re-run post-merge on ${defaultBranch}: ${
          describe(findings)
        }`,
      );
    }
  },
);

Deno.test(
  "workflow templates - the markdownlint-cli2 pin matches the fleet's pin",
  async () => {
    // The install-pin scanner only asks for *an* exact version; nothing
    // else ties the emitted pin to the one the container and this repo's
    // own workflow use, so the three would drift apart silently.
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assert(spec !== undefined, "markdown-lint spec missing");
    const tools = JSON.parse(
      await Deno.readTextFile(
        new URL("../../../container/tools.json", import.meta.url),
      ),
    ) as { toolchains?: Array<{ id?: string; version?: string }> };
    const pinned = tools.toolchains?.find((t) => t.id === "markdownlint-cli2");
    assert(
      pinned?.version !== undefined,
      "container/tools.json has no markdownlint-cli2 entry",
    );
    assert(
      spec.template.includes(`markdownlint-cli2@${pinned.version}`),
      `markdown-lint template must install markdownlint-cli2@${pinned.version} ` +
        "— the version container/tools.json pins — so the container, this " +
        "repo's own workflow and every provisioned repo report identical " +
        "findings (Issue #1639)",
    );
  },
);

// ---------------------------------------------------------------------------
// Structural cover for what the pre-filers cannot reach
// ---------------------------------------------------------------------------
//
// `scanMilestoneBranchFilters` and `scanWorkflowTriggers` only act on
// workflows `classifyWorkflow` rates `test`/`high`. The dependency-review,
// java-dependency-check and shellcheck templates classify `ambiguous`, so
// the two scans above are silent about them. These loops apply the same
// two rules to every template, using the scanner's own coverage decision.

Deno.test(
  "workflow templates - every pull_request filter covers milestone branches",
  () => {
    for (const spec of workflowSpecs()) {
      // `"gap"` is the only failing verdict: `"covered"` gates milestone
      // PRs and `"none"` means no `pull_request` trigger at all.
      const coverage = workflowMilestoneCoverage(parseYaml(spec.template));
      assert(
        coverage !== "gap",
        `${spec.id}: the \`pull_request\` branch filter never matches ` +
          "`milestone/<slug>`, so milestone sub-issue PRs merge ungated " +
          "(Issue #1639)",
      );
    }
  },
);

Deno.test(
  "workflow templates - no template triggers on push",
  () => {
    for (const spec of workflowSpecs()) {
      const parsed = parseYaml(spec.template);
      assert(isRecord(parsed), `${spec.id}: template is not a YAML mapping`);
      const onBlock = readOnBlock(parsed);
      const triggersOnPush = typeof onBlock === "string"
        ? onBlock === "push"
        : Array.isArray(onBlock)
        ? onBlock.includes("push")
        : isRecord(onBlock) && "push" in onBlock;
      assertEquals(
        triggersOnPush,
        false,
        `${spec.id}: re-running a required check on the post-merge push ` +
          "duplicates the PR run with no enforcement value (Issue #1639)",
      );
      // The spec's declared triggers must not advertise one the template
      // does not actually carry.
      assertEquals(
        spec.triggers.includes("push"),
        false,
        `${spec.id}: spec.triggers still advertises \`push\``,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Audit checks #4 and #5 — no native pre-filer, so asserted structurally
// ---------------------------------------------------------------------------

Deno.test(
  "workflow templates - every workflow declares a cancelling concurrency group",
  () => {
    for (const spec of workflowSpecs()) {
      const parsed = parseYaml(spec.template);
      assert(isRecord(parsed), `${spec.id}: template is not a YAML mapping`);
      const concurrency = parsed["concurrency"];
      assert(
        isRecord(concurrency),
        `${spec.id}: template must declare a \`concurrency:\` block so ` +
          "rapid pushes do not spawn redundant parallel runs (Issue #1639)",
      );
      const group = concurrency["group"];
      assert(
        typeof group === "string" && group.includes("github.workflow") &&
          group.includes("github.ref"),
        `${spec.id}: concurrency group must key on workflow + ref, got ` +
          `${JSON.stringify(group)}`,
      );
      assertEquals(
        concurrency["cancel-in-progress"],
        true,
        `${spec.id}: concurrency group must cancel superseded runs`,
      );
    }
  },
);

Deno.test(
  "workflow templates - every job declares its category's timeout-minutes",
  () => {
    for (const spec of workflowSpecs()) {
      const parsed = parseYaml(spec.template);
      assert(isRecord(parsed), `${spec.id}: template is not a YAML mapping`);
      const jobs = parsed["jobs"];
      assert(isRecord(jobs), `${spec.id}: template declares no jobs`);
      const expected = TIMEOUT_BY_CATEGORY[spec.category];
      for (const [jobName, job] of Object.entries(jobs)) {
        assert(isRecord(job), `${spec.id}: job ${jobName} is not a mapping`);
        assertEquals(
          job["timeout-minutes"],
          expected,
          `${spec.id}: job \`${jobName}\` (${spec.category}) must declare ` +
            `\`timeout-minutes: ${expected}\` so a wedged run cannot hold a ` +
            "runner for the six-hour default (Issue #1639)",
        );
      }
    }
  },
);
