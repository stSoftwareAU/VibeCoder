/**
 * Conformance tests for the canonical `gitleaks` workflow template
 * (Issue #594).
 *
 * The template in `worker/deno/lib/workflow_definitions.ts` is pushed into
 * every repository the fleet sets up, so a regression here silently
 * disables secret detection fleet-wide. Four invariants are locked:
 *
 *   1. The `pull_request` branch filter covers milestone feature branches
 *      (`milestone/<slug>`, Issue #1300) — the dominant merge path.
 *   2. The filter is not the bare `["*"]`, which reads as "every branch"
 *      but never matches a `/`.
 *   3. Both scan paths survive — the licensed `gitleaks-action` and the
 *      licence-less open-source CLI fallback (Issue #2981).
 *   4. Every `uses:` is pinned to a 40-character commit SHA (Issue #1756).
 *
 * Branch-filter matching reuses `anyBranchMatches` from
 * `workflow_branch_glob.ts` — the same matcher the milestone-branch-filter
 * pre-filer runs — rather than string-matching the rendered YAML.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import { anyBranchMatches } from "../lib/workflow_branch_glob.ts";

/** Representative milestone branch (Issue #1300: `milestone/<slug>`). */
const MILESTONE_SAMPLE_BRANCH = "milestone/example";

function gitleaksTemplate(): string {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
  assertNotEquals(spec, undefined, "gitleaks spec missing");
  return spec!.template;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read `on.pull_request.branches` from the rendered template.
 *
 * `@std/yaml` keeps `on` as a string key (YAML 1.2 core schema); a YAML 1.1
 * parser would coerce it to the boolean `true`, so both spellings are read.
 */
function pullRequestBranches(template: string): unknown {
  const parsed = parseYaml(template);
  assert(isRecord(parsed), "template did not parse as a YAML mapping");
  const onBlock = "on" in parsed ? parsed["on"] : parsed["true"];
  assert(isRecord(onBlock), "template has no `on:` mapping");
  const pullRequest = onBlock["pull_request"];
  assert(isRecord(pullRequest), "template has no `on.pull_request:` mapping");
  return pullRequest["branches"];
}

Deno.test(
  "gitleaks template - pull_request filter matches milestone branches",
  () => {
    const branches = pullRequestBranches(gitleaksTemplate());
    assert(
      Array.isArray(branches),
      "gitleaks template must declare an explicit pull_request branch filter",
    );
    assert(
      anyBranchMatches(branches, MILESTONE_SAMPLE_BRANCH),
      `gitleaks template branch filter ${JSON.stringify(branches)} never ` +
        `matches ${MILESTONE_SAMPLE_BRANCH} — milestone PRs would skip the ` +
        `secret scan (Issue #594)`,
    );
    // Develop and main remain covered.
    for (const branch of ["Develop", "main"]) {
      assert(
        anyBranchMatches(branches, branch),
        `gitleaks template branch filter must still match ${branch}`,
      );
    }
  },
);

Deno.test(
  "gitleaks template - branch filter is not the bare star glob",
  () => {
    const branches = pullRequestBranches(gitleaksTemplate());
    assertNotEquals(
      JSON.stringify(branches),
      JSON.stringify(["*"]),
      'gitleaks template must not use `branches: ["*"]` — a GitHub `*` ' +
        "never matches a `/`, so milestone PRs go unscanned (Issue #594)",
    );
  },
);

Deno.test(
  "gitleaks template - keeps both the licensed and licence-less scan paths",
  () => {
    const template = gitleaksTemplate();
    assert(
      template.includes("Gitleaks (licensed action)") &&
        template.includes("env.GITLEAKS_LICENSE != ''") &&
        template.includes("gitleaks/gitleaks-action"),
      "gitleaks template must keep the licensed gitleaks-action path",
    );
    assert(
      template.includes("Gitleaks (open-source CLI fallback)") &&
        template.includes("env.GITLEAKS_LICENSE == ''") &&
        template.includes("gitleaks git"),
      "gitleaks template must keep the licence-less CLI fallback " +
        "(Issue #2981 — Dependabot PRs receive no Actions secrets)",
    );
  },
);

Deno.test(
  "gitleaks template - every uses: is pinned to a 40-character SHA",
  () => {
    const usesLines = gitleaksTemplate()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- uses:") || line.startsWith("uses:"));
    assertNotEquals(usesLines.length, 0, "expected at least one uses: line");
    for (const line of usesLines) {
      const match = /uses:\s+\S+@([0-9a-f]{40})(\s|$)/i.exec(line);
      assertNotEquals(
        match,
        null,
        `gitleaks template uses: line is not pinned to a 40-char SHA: ` +
          `"${line}" — a tag pin (@v3) is hijackable (Issue #1756)`,
      );
    }
  },
);

Deno.test(
  "gitleaks template - checkout disables credential persistence",
  () => {
    const template = gitleaksTemplate();
    const parsed = parseYaml(template);
    assert(isRecord(parsed), "template did not parse as a YAML mapping");
    const jobs = parsed["jobs"];
    assert(isRecord(jobs), "template has no jobs");
    let checkoutSteps = 0;
    for (const job of Object.values(jobs)) {
      if (!isRecord(job) || !Array.isArray(job["steps"])) continue;
      for (const step of job["steps"]) {
        if (!isRecord(step)) continue;
        const uses = step["uses"];
        if (typeof uses !== "string" || !uses.startsWith("actions/checkout@")) {
          continue;
        }
        checkoutSteps++;
        const withBlock = step["with"];
        assert(isRecord(withBlock), "checkout step has no `with:` block");
        assertEquals(
          withBlock["persist-credentials"],
          false,
          "checkout must set `persist-credentials: false` so the job token " +
            "is not left in .git/config (Issue #594)",
        );
      }
    }
    assertNotEquals(checkoutSteps, 0, "template has no checkout step");
  },
);

Deno.test(
  "gitleaks template - declares a cancelling concurrency group",
  () => {
    const parsed = parseYaml(gitleaksTemplate());
    assert(isRecord(parsed), "template did not parse as a YAML mapping");
    const concurrency = parsed["concurrency"];
    assert(
      isRecord(concurrency),
      "gitleaks template must declare a `concurrency:` block so rapid " +
        "pushes do not spawn redundant parallel runs (Issue #594)",
    );
    const group = concurrency["group"];
    assert(typeof group === "string", "concurrency group must be a string");
    assert(
      group.includes("github.workflow") && group.includes("github.ref"),
      `concurrency group must key on workflow + ref, got "${group}"`,
    );
    assertEquals(concurrency["cancel-in-progress"], true);
  },
);

Deno.test(
  "gitleaks template - comments describe gitleaks-action v3, not v2",
  () => {
    const template = gitleaksTemplate();
    assert(
      template.includes("gitleaks-action@v3"),
      "template comments must describe the v3 action that is actually pinned",
    );
    assertFalse(
      template.includes("gitleaks-action@v2"),
      "template comments must not describe the superseded v2 action",
    );
  },
);

Deno.test(
  "gitleaks template - records the environment/config omission decision",
  () => {
    const template = gitleaksTemplate();
    // A freshly set-up repo has neither the GitHub Environment nor a
    // .github/gitleaks.toml, so the template must run unmodified on first
    // push — and must say why it omits both.
    assert(
      template.includes("scanning-secrets") &&
        template.includes("GITLEAKS_CONFIG"),
      "template must record the decision to omit the `scanning-secrets` " +
        "environment gate and the GITLEAKS_CONFIG path (Issue #594)",
    );
    const parsed = parseYaml(template);
    assert(isRecord(parsed), "template did not parse as a YAML mapping");
    const jobs = parsed["jobs"];
    assert(isRecord(jobs), "template has no jobs");
    for (const job of Object.values(jobs)) {
      if (!isRecord(job)) continue;
      assertEquals(
        job["environment"],
        undefined,
        "template must not gate on a GitHub Environment a fresh repo lacks",
      );
      const env = job["env"];
      if (isRecord(env)) {
        assertEquals(
          env["GITLEAKS_CONFIG"],
          undefined,
          "template must not point at a .github/gitleaks.toml a fresh repo " +
            "lacks",
        );
      }
    }
  },
);
