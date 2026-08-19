/**
 * Tests for workflow_definitions.ts — GitHub Actions workflow specifications.
 *
 * Issue #1392: Define expected GitHub Actions workflow specifications per language.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  getWorkflowsForLanguages,
  getWorkflowsForLanguagesAndVisibility,
  WORKFLOW_SPECS,
  type WorkflowSpec,
} from "../lib/workflow_definitions.ts";
import {
  CANONICAL_MINIMUM_DEPENDENCY_AGE,
  INTERNAL_SCOPE_EXCLUDES,
} from "../lib/deno_minimum_dependency_age.ts";

// ---------------------------------------------------------------------------
// Universal workflow specs
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - includes gitleaks universal spec", () => {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
  assertNotEquals(spec, undefined);
  assertEquals(spec!.appliesTo, "universal");
  assertEquals(spec!.category, "security");
  assertEquals(spec!.triggers.length > 0, true);
  assertEquals(spec!.detectionPatternGroups.length > 0, true);
});

Deno.test("workflow_definitions - includes semgrep universal spec", () => {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "semgrep");
  assertNotEquals(spec, undefined);
  assertEquals(spec!.appliesTo, "universal");
  assertEquals(spec!.category, "security");
});

// ---------------------------------------------------------------------------
// Dependency-review universal spec — public-only (Issue #1754)
// ---------------------------------------------------------------------------

Deno.test(
  "workflow_definitions - includes dependency-review universal spec",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "dependency-review");
    assertNotEquals(spec, undefined, "dependency-review spec missing");
    assertEquals(spec!.appliesTo, "universal");
    assertEquals(spec!.category, "security");
    assertEquals(spec!.suggestedFilename, "dependency-review.yml");
    assertEquals(spec!.triggers.includes("pull_request"), true);
  },
);

Deno.test(
  "workflow_definitions - dependency-review spec is public-only",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "dependency-review");
    assertNotEquals(spec, undefined, "dependency-review spec missing");
    assertEquals(
      spec!.visibilityScope,
      "public-only",
      "dependency-review must be public-only — GHAS not available on private repos",
    );
  },
);

Deno.test(
  "workflow_definitions - dependency-review excluded from private repos",
  () => {
    const specs = getWorkflowsForLanguagesAndVisibility([], "private");
    const ids = specs.map((s) => s.id);
    assertEquals(
      ids.includes("dependency-review"),
      false,
      "dependency-review must NOT be returned for private repos",
    );
  },
);

Deno.test(
  "workflow_definitions - dependency-review included for public repos",
  () => {
    const specs = getWorkflowsForLanguagesAndVisibility([], "public");
    const ids = specs.map((s) => s.id);
    assertEquals(
      ids.includes("dependency-review"),
      true,
      "dependency-review must be returned for public repos",
    );
  },
);

Deno.test(
  "workflow_definitions - dependency-review template references dependency-review-action",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "dependency-review");
    assertNotEquals(spec, undefined, "dependency-review spec missing");
    assertEquals(
      spec!.template.includes("actions/dependency-review-action"),
      true,
      "template must invoke actions/dependency-review-action",
    );
  },
);

// ---------------------------------------------------------------------------
// Markdown lint universal spec (Issue #1686)
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - includes markdown-lint universal spec", () => {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
  assertNotEquals(spec, undefined, "markdown-lint spec missing");
  assertEquals(spec!.appliesTo, "universal");
  assertEquals(spec!.category, "quality");
  assertEquals(
    spec!.triggers.includes("pull_request"),
    true,
    "markdown-lint should trigger on pull_request",
  );
  assertEquals(
    spec!.triggers.includes("push"),
    true,
    "markdown-lint should trigger on push to default branch",
  );
});

Deno.test(
  "workflow_definitions - markdown-lint detection patterns match markdownlint-cli2",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");
    assertEquals(
      spec!.detectionPatternGroups.length,
      1,
      "markdown-lint should expose a single detection group",
    );
    assertEquals(
      spec!.detectionPatternGroups[0]!.includes("markdownlint-cli2"),
      true,
      "markdown-lint detection group should include markdownlint-cli2",
    );
  },
);

Deno.test(
  "workflow_definitions - markdown-lint template invokes markdownlint-cli2",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");
    assertEquals(
      spec!.template.includes("markdownlint-cli2"),
      true,
      "markdown-lint template should invoke markdownlint-cli2",
    );
  },
);

Deno.test(
  "workflow_definitions - markdown-lint template pins all uses: lines to commit SHAs",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");
    // Every `uses:` line must reference a 40-character hex commit SHA,
    // not a `@vN` tag, to defeat tag-hijack supply-chain attacks.
    const usesLines = spec!.template
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));
    assertNotEquals(usesLines.length, 0, "Expected at least one uses: line");
    for (const line of usesLines) {
      const match = /uses:\s+\S+@([0-9a-f]+)/i.exec(line);
      assertNotEquals(match, null, `uses: line not parseable: "${line}"`);
      assertEquals(
        match![1]!.length,
        40,
        `uses: line not pinned to 40-char SHA: "${line}"`,
      );
    }
  },
);

Deno.test(
  "workflow_definitions - markdown-lint template parses as YAML",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");
    const parsed = parseYaml(spec!.template);
    assertNotEquals(parsed, null, "markdown-lint template parsed to null");
    assertNotEquals(
      parsed,
      undefined,
      "markdown-lint template parsed to undefined",
    );
  },
);

Deno.test(
  "workflow_definitions - local markdown-lint.yml satisfies markdown-lint spec",
  async () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");

    const workflowUrl = new URL(
      "../../../.github/workflows/markdown-lint.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    const lower = content.toLowerCase();

    for (const group of spec!.detectionPatternGroups) {
      const matched = group.some((p) => lower.includes(p.toLowerCase()));
      assertEquals(
        matched,
        true,
        `markdown-lint.yml missing all alternatives in group: ${
          group.join(", ")
        }`,
      );
    }

    // Local file must also be valid YAML and pin actions to SHAs.
    const parsed = parseYaml(content);
    assertNotEquals(parsed, null, "markdown-lint.yml parsed to null");

    const usesLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));
    assertNotEquals(usesLines.length, 0, "Expected at least one uses: line");
    for (const line of usesLines) {
      const match = /uses:\s+\S+@([0-9a-f]+)/i.exec(line);
      assertNotEquals(match, null, `uses: line not parseable: "${line}"`);
      assertEquals(
        match![1]!.length,
        40,
        `uses: line not pinned to 40-char SHA: "${line}"`,
      );
    }
  },
);

// Issue #2195: the local markdown-lint.yml trigger must watch the
// repository's actual default branch (`Develop`), not the generic
// `[main, master]` list. Without this the gate never fires on the working
// default branch and the safety net is silently absent.
//
// Issue #3332 moved the branch filter this asserts on from `push:` to
// `pull_request:`: markdownlint is a required status check, so the
// post-merge push run only duplicated the run that already gated the PR
// (docs/MERGE.md — "No post-merge re-run of required checks"). The #2195
// behaviour is unchanged — the filter must still name `Develop` and never
// `master`; it is now read off the trigger that actually survives.
Deno.test(
  "workflow_definitions - local markdown-lint.yml trigger watches Develop (Issues #2195, #3332)",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/markdown-lint.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    const parsed = parseYaml(content) as Record<string, unknown>;

    // YAML 1.1 parses bare `on` as boolean `true`; the parser exposes
    // the block under whichever key actually materialised, so check both.
    const onBlock = (parsed["on"] ?? parsed[true as unknown as string]) as
      | Record<string, { branches?: string[] }>
      | undefined;
    assertNotEquals(onBlock, undefined, "markdown-lint.yml missing on: block");

    assertEquals(
      onBlock!["push"],
      undefined,
      "markdown-lint.yml must not re-run on push — it gates the PR only " +
        "(Issue #3332)",
    );

    const prBranches = onBlock!["pull_request"]?.branches ?? [];
    assertEquals(
      prBranches.includes("Develop"),
      true,
      `pull_request.branches must include "Develop" (repo default branch); ` +
        `got: ${JSON.stringify(prBranches)}`,
    );
    assertEquals(
      prBranches.includes("master"),
      false,
      `pull_request.branches must not include "master" (repo has no master ` +
        `branch); got: ${JSON.stringify(prBranches)}`,
    );
  },
);

// Issue #2317: the deprecated `actions/setup-node@v4` SHA ran on Node 20.
// GitHub-hosted runners auto-upgrade Node 20 actions to Node 24 on
// 2026-06-02 and remove Node 20 on 2026-09-16. The markdown-lint workflow
// and its template must pin to a Node 24 runtime (setup-node @v5+).
const DEPRECATED_SETUP_NODE_V4_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";

Deno.test(
  "workflow_definitions - markdown-lint template does not pin deprecated setup-node@v4 SHA (Issue #2317)",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");
    assertEquals(
      spec!.template.includes(DEPRECATED_SETUP_NODE_V4_SHA),
      false,
      "markdown-lint template still pins setup-node@v4 (Node 20 runner); " +
        "bump to setup-node@v5+ for the Node 24 runtime",
    );
    // The template must still reference setup-node so the markdownlint-cli2
    // step has a Node interpreter available.
    assertEquals(
      /actions\/setup-node@[0-9a-f]{40}/i.test(spec!.template),
      true,
      "markdown-lint template must pin actions/setup-node to a SHA",
    );
  },
);

Deno.test(
  "workflow_definitions - local markdown-lint.yml does not pin deprecated setup-node@v4 SHA (Issue #2317)",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/markdown-lint.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    assertEquals(
      content.includes(DEPRECATED_SETUP_NODE_V4_SHA),
      false,
      ".github/workflows/markdown-lint.yml still pins setup-node@v4 " +
        "(Node 20 runner deprecated by 2026-09-16); bump to setup-node@v5+",
    );
    assertEquals(
      /actions\/setup-node@[0-9a-f]{40}/i.test(content),
      true,
      "markdown-lint.yml must pin actions/setup-node to a SHA",
    );
  },
);

// Issue #2316: the deprecated `actions/checkout@v4` SHA ran on Node 20.
// GitHub-hosted runners auto-upgrade Node 20 actions to Node 24 on
// 2026-06-02 and remove Node 20 on 2026-09-16. The markdown-lint
// template must pin actions/checkout to a Node 24 runtime (v5+/v6+).
const DEPRECATED_CHECKOUT_V4_SHA = "34e114876b0b11c390a56381ad16ebd13914f8d5";

Deno.test(
  "workflow_definitions - markdown-lint template does not pin deprecated actions/checkout@v4 SHA (Issue #2316)",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "markdown-lint");
    assertNotEquals(spec, undefined, "markdown-lint spec missing");
    assertEquals(
      spec!.template.includes(DEPRECATED_CHECKOUT_V4_SHA),
      false,
      "markdown-lint template still pins actions/checkout@v4 (Node 20 " +
        "runner); bump to actions/checkout@v5+ for the Node 24 runtime",
    );
    // The template must still reference actions/checkout so the lint step
    // has the repo content on the runner.
    assertEquals(
      /actions\/checkout@[0-9a-f]{40}/i.test(spec!.template),
      true,
      "markdown-lint template must pin actions/checkout to a SHA",
    );
  },
);

Deno.test(
  "workflow_definitions - getWorkflowsForLanguages returns markdown-lint for any language",
  () => {
    const specs = getWorkflowsForLanguages(["Bash"]);
    const ids = specs.map((s) => s.id);
    assertEquals(
      ids.includes("markdown-lint"),
      true,
      "markdown-lint should be returned as a universal spec",
    );
  },
);

// ---------------------------------------------------------------------------
// Language-specific workflow specs
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - includes Rust workflow specs", () => {
  const rustSpecs = WORKFLOW_SPECS.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Rust"),
  );
  assertEquals(rustSpecs.length >= 3, true, "Expected at least 3 Rust specs");

  const ids = rustSpecs.map((s) => s.id);
  assertEquals(ids.includes("cargo-audit"), true, "Missing cargo-audit");
  assertEquals(ids.includes("cargo-upgrade"), true, "Missing cargo-upgrade");
  assertEquals(ids.includes("cargo-quality"), true, "Missing cargo-quality");
});

Deno.test("workflow_definitions - includes Deno workflow specs", () => {
  const denoSpecs = WORKFLOW_SPECS.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Deno"),
  );
  assertEquals(denoSpecs.length >= 2, true, "Expected at least 2 Deno specs");

  const ids = denoSpecs.map((s) => s.id);
  assertEquals(ids.includes("deno-outdated"), true, "Missing deno-outdated");
  assertEquals(ids.includes("deno-quality"), true, "Missing deno-quality");
});

Deno.test("workflow_definitions - includes Node workflow specs", () => {
  const nodeSpecs = WORKFLOW_SPECS.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Node"),
  );
  assertEquals(nodeSpecs.length >= 3, true, "Expected at least 3 Node specs");

  const ids = nodeSpecs.map((s) => s.id);
  assertEquals(ids.includes("npm-audit"), true, "Missing npm-audit");
  assertEquals(
    ids.includes("npm-dependency-updates"),
    true,
    "Missing npm-dependency-updates",
  );
  assertEquals(ids.includes("eslint-quality"), true, "Missing eslint-quality");
});

Deno.test("workflow_definitions - includes Java workflow specs", () => {
  const javaSpecs = WORKFLOW_SPECS.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Java"),
  );
  assertEquals(javaSpecs.length >= 2, true, "Expected at least 2 Java specs");

  const ids = javaSpecs.map((s) => s.id);
  assertEquals(
    ids.includes("java-dependency-check"),
    true,
    "Missing java-dependency-check",
  );
  assertEquals(
    ids.includes("java-dependency-updates"),
    true,
    "Missing java-dependency-updates",
  );
});

Deno.test("workflow_definitions - includes Bash workflow specs", () => {
  const bashSpecs = WORKFLOW_SPECS.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Bash"),
  );
  assertEquals(bashSpecs.length >= 1, true, "Expected at least 1 Bash spec");

  const ids = bashSpecs.map((s) => s.id);
  assertEquals(ids.includes("shellcheck"), true, "Missing shellcheck");
});

Deno.test("workflow_definitions - includes React/Web workflow specs", () => {
  const reactSpecs = WORKFLOW_SPECS.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("React/Web"),
  );
  assertEquals(
    reactSpecs.length >= 1,
    true,
    "Expected at least 1 React/Web spec",
  );
});

// ---------------------------------------------------------------------------
// Detection patterns validation
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - all specs have non-empty detection pattern groups", () => {
  for (const spec of WORKFLOW_SPECS) {
    assertEquals(
      spec.detectionPatternGroups.length > 0,
      true,
      `Spec "${spec.id}" has empty detectionPatternGroups`,
    );
    for (const group of spec.detectionPatternGroups) {
      assertEquals(
        group.length > 0,
        true,
        `Spec "${spec.id}" has an empty group inside detectionPatternGroups`,
      );
    }
  }
});

Deno.test(
  "workflow_definitions - alternative-implementation specs use a single OR group",
  () => {
    // Specs identified in issue #1578 where named GitHub Actions and the
    // underlying CLI tool are equally valid alternatives — each should
    // be modelled as a single OR group, not as separate AND groups.
    const alternativesByLineage: Record<string, string[]> = {
      "gitleaks": ["gitleaks/gitleaks-action", "gitleaks"],
      "semgrep": ["semgrep/semgrep-action", "semgrep"],
      "cargo-audit": ["cargo audit", "cargo-audit", "rustsec/audit-check"],
      "shellcheck": ["shellcheck", "ludeeus/action-shellcheck"],
    };

    for (
      const [id, expectedAlternatives] of Object.entries(alternativesByLineage)
    ) {
      const spec = WORKFLOW_SPECS.find((s) => s.id === id);
      assertNotEquals(spec, undefined, `Spec "${id}" missing`);
      assertEquals(
        spec!.detectionPatternGroups.length,
        1,
        `Spec "${id}" should expose a single alternative group`,
      );
      for (const alt of expectedAlternatives) {
        assertEquals(
          spec!.detectionPatternGroups[0]!.includes(alt),
          true,
          `Spec "${id}" alternative group should contain "${alt}"`,
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Template YAML validity
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - all templates are valid YAML", () => {
  for (const spec of WORKFLOW_SPECS) {
    try {
      const parsed = parseYaml(spec.template);
      assertNotEquals(
        parsed,
        null,
        `Spec "${spec.id}" template parsed to null`,
      );
      assertNotEquals(
        parsed,
        undefined,
        `Spec "${spec.id}" template parsed to undefined`,
      );
    } catch (err) {
      throw new Error(
        `Spec "${spec.id}" has invalid YAML template: ${
          (err as Error).message
        }`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Local workflow file satisfies its corresponding spec (Issue #1464)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Issue #2249 — Bats has been fully migrated to Deno. The validate-scripts.yml
// workflow must not retain dead Bats stages (path filters that never match,
// Node + bats-core installs that produce no signal, benchmark-audit scans of a
// missing `tests/` directory, or the silent `else echo "No tests directory
// found"` gate). These tests fail until the dead pipeline is removed.
// ---------------------------------------------------------------------------

Deno.test(
  "validate-scripts.yml has no dead Bats stages (Issue #2249)",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/validate-scripts.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);

    // (a) Path filter must not reference tests/**.bats — no such files exist.
    assertEquals(
      /tests\/\*\*\.bats/.test(content),
      false,
      "validate-scripts.yml must not filter on 'tests/**.bats' " +
        "(Bats migrated to Deno; no .bats files exist)",
    );

    // (b) No Node 24 / bats-core install — the install produced no signal
    //     and cost CI minutes on every PR.
    assertEquals(
      /actions\/setup-node@/.test(content),
      false,
      "validate-scripts.yml must not set up Node (only used to install Bats)",
    );
    assertEquals(
      /bats-core|npm install -g bats|bats@latest/.test(content),
      false,
      "validate-scripts.yml must not install bats-core (Bats migrated to Deno)",
    );

    // (c) Benchmark audit must not scan the (missing) top-level tests/
    //     directory. Match `+ "/tests"` (no slash after) but not
    //     `/worker/deno/tests`.
    assertEquals(
      /\+\s*"\/tests"/.test(content),
      false,
      "Benchmark audit must not scan workspace/tests (directory does not exist)",
    );
    assertEquals(
      /batsPattern/.test(content),
      false,
      "Benchmark audit must not declare batsPattern (no .bats files exist)",
    );

    // (d) No "Run bats tests" step — it silently no-ops on every run.
    assertEquals(
      /Run bats tests|bats --jobs/.test(content),
      false,
      "validate-scripts.yml must not retain the 'Run bats tests' step",
    );
    assertEquals(
      /No tests directory found/.test(content),
      false,
      "validate-scripts.yml must not retain the 'No tests directory found' " +
        "fallback (the silent gate that hid the dead Bats stage)",
    );

    // (e) GNU parallel was only needed for the bats --jobs invocation; it must
    //     not be installed any more.
    assertEquals(
      /apt-get install[^\n]*\bparallel\b/.test(content),
      false,
      "validate-scripts.yml must not apt-install GNU parallel (only used by Bats)",
    );
  },
);

Deno.test(
  "workflow_definitions - validate-scripts.yml satisfies shellcheck spec patterns",
  async () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "shellcheck");
    assertNotEquals(spec, undefined, "shellcheck spec missing");

    // Resolve the workflow file relative to the repo root (this test file
    // lives at worker/deno/tests/, so go up three levels).
    const workflowUrl = new URL(
      "../../../.github/workflows/validate-scripts.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    const lower = content.toLowerCase();

    for (const group of spec!.detectionPatternGroups) {
      const matched = group.some((p) => lower.includes(p.toLowerCase()));
      assertEquals(
        matched,
        true,
        `validate-scripts.yml missing all alternatives in group: ${
          group.join(", ")
        }`,
      );
    }

    // Issue #1464 specifically requires the upstream koalaman/shellcheck
    // reference to satisfy the audit's named-source pattern.
    assertEquals(
      lower.includes("koalaman/shellcheck"),
      true,
      "validate-scripts.yml should reference koalaman/shellcheck",
    );
  },
);

Deno.test(
  "workflow_definitions - semgrep.yml satisfies semgrep spec patterns",
  async () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "semgrep");
    assertNotEquals(spec, undefined, "semgrep spec missing");

    const workflowUrl = new URL(
      "../../../.github/workflows/semgrep.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    const lower = content.toLowerCase();

    for (const group of spec!.detectionPatternGroups) {
      const matched = group.some((p) => lower.includes(p.toLowerCase()));
      assertEquals(
        matched,
        true,
        `semgrep.yml missing all alternatives in group: ${group.join(", ")}`,
      );
    }

    // The workflow file must be valid YAML.
    const parsed = parseYaml(content);
    assertNotEquals(parsed, null, "semgrep.yml parsed to null");
    assertNotEquals(parsed, undefined, "semgrep.yml parsed to undefined");
  },
);

// ---------------------------------------------------------------------------
// No duplicate IDs
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - no duplicate IDs across all specs", () => {
  const seen = new Set<string>();
  for (const spec of WORKFLOW_SPECS) {
    assertEquals(
      seen.has(spec.id),
      false,
      `Duplicate workflow spec ID: "${spec.id}"`,
    );
    seen.add(spec.id);
  }
});

// ---------------------------------------------------------------------------
// Required fields validation
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - all specs have required fields", () => {
  for (const spec of WORKFLOW_SPECS) {
    assertNotEquals(spec.id, "", `Spec has empty id`);
    assertNotEquals(spec.name, "", `Spec "${spec.id}" has empty name`);
    assertEquals(
      spec.triggers.length > 0,
      true,
      `Spec "${spec.id}" has no triggers`,
    );
    assertNotEquals(
      spec.suggestedFilename,
      "",
      `Spec "${spec.id}" has empty suggestedFilename`,
    );
    assertNotEquals(spec.template, "", `Spec "${spec.id}" has empty template`);
    assertEquals(
      ["security", "dependency-update", "quality"].includes(spec.category),
      true,
      `Spec "${spec.id}" has invalid category: "${spec.category}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// getWorkflowsForLanguages()
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - getWorkflowsForLanguages returns universal specs for any language", () => {
  const specs = getWorkflowsForLanguages(["Rust"]);
  const universalSpecs = specs.filter((s) => s.appliesTo === "universal");
  assertEquals(
    universalSpecs.length >= 2,
    true,
    "Expected at least 2 universal specs",
  );
});

Deno.test("workflow_definitions - getWorkflowsForLanguages returns Rust-specific specs", () => {
  const specs = getWorkflowsForLanguages(["Rust"]);
  const rustSpecs = specs.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Rust"),
  );
  assertEquals(rustSpecs.length >= 3, true, "Expected at least 3 Rust specs");
});

Deno.test("workflow_definitions - getWorkflowsForLanguages excludes unrelated languages", () => {
  const specs = getWorkflowsForLanguages(["Bash"]);
  const rustSpecs = specs.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Rust"),
  );
  // Bash-only query should not include Rust-only specs
  const rustOnly = rustSpecs.filter(
    (s) => Array.isArray(s.appliesTo) && !s.appliesTo.includes("Bash"),
  );
  assertEquals(
    rustOnly.length,
    0,
    "Should not include Rust-only specs for Bash query",
  );
});

Deno.test("workflow_definitions - getWorkflowsForLanguages handles multiple languages", () => {
  const specs = getWorkflowsForLanguages(["Rust", "Deno"]);
  const rustSpecs = specs.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Rust"),
  );
  const denoSpecs = specs.filter(
    (s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Deno"),
  );
  assertEquals(rustSpecs.length >= 3, true, "Expected Rust specs");
  assertEquals(denoSpecs.length >= 2, true, "Expected Deno specs");
});

Deno.test("workflow_definitions - getWorkflowsForLanguages returns no duplicates", () => {
  const specs = getWorkflowsForLanguages(["Node", "React/Web"]);
  const ids = specs.map((s) => s.id);
  const unique = new Set(ids);
  assertEquals(
    ids.length,
    unique.size,
    "Should have no duplicate specs in result",
  );
});

Deno.test("workflow_definitions - getWorkflowsForLanguages returns empty language-specific for unknown language", () => {
  const specs = getWorkflowsForLanguages(["UnknownLang"]);
  // Should still include universal specs
  const universalSpecs = specs.filter((s) => s.appliesTo === "universal");
  assertEquals(
    universalSpecs.length >= 2,
    true,
    "Expected universal specs even for unknown language",
  );
  // Should not include any language-specific specs
  const langSpecs = specs.filter((s) => Array.isArray(s.appliesTo));
  assertEquals(
    langSpecs.length,
    0,
    "Should have no language-specific specs for unknown language",
  );
});

Deno.test("workflow_definitions - getWorkflowsForLanguages returns empty array for empty input", () => {
  const specs = getWorkflowsForLanguages([]);
  // With no languages, should still return universal specs
  const universalSpecs = specs.filter((s) => s.appliesTo === "universal");
  assertEquals(
    universalSpecs.length >= 2,
    true,
    "Expected universal specs even for empty languages",
  );
});

Deno.test("workflow_definitions - React/Web inherits Node workflow specs", () => {
  const reactSpecs = getWorkflowsForLanguages(["React/Web"]);
  const nodeIds = reactSpecs
    .filter((s) => Array.isArray(s.appliesTo) && s.appliesTo.includes("Node"))
    .map((s) => s.id);
  // React/Web specs that also include Node should be present
  assertEquals(
    nodeIds.length >= 1,
    true,
    "React/Web should share some Node specs",
  );
});

// ---------------------------------------------------------------------------
// Category distribution
// ---------------------------------------------------------------------------

Deno.test("workflow_definitions - has specs in all three categories", () => {
  const categories = new Set(WORKFLOW_SPECS.map((s) => s.category));
  assertEquals(categories.has("security"), true, "Missing security category");
  assertEquals(
    categories.has("dependency-update"),
    true,
    "Missing dependency-update category",
  );
  assertEquals(categories.has("quality"), true, "Missing quality category");
});

// ---------------------------------------------------------------------------
// Org-level secret wiring (Issue #1636)
// ---------------------------------------------------------------------------
//
// The organisation provides three standard secrets that the standard
// workflow templates must wire up where applicable:
// - GITLEAKS_LICENSE  — required by gitleaks/gitleaks-action for org licensing.
// - ACTIONS_PUSH      — PAT used by PR-creation actions so downstream
//                       workflows fire on the resulting PR.
// - CODECOV_TOKEN     — uploads coverage reports to Codecov.

Deno.test(
  "workflow_definitions - gitleaks template wires GITLEAKS_LICENSE secret",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    assertNotEquals(spec, undefined, "gitleaks spec missing");
    assertEquals(
      spec!.template.includes("GITLEAKS_LICENSE"),
      true,
      "gitleaks template should reference GITLEAKS_LICENSE",
    );
    assertEquals(
      spec!.template.includes("secrets.GITLEAKS_LICENSE"),
      true,
      "gitleaks template should pull GITLEAKS_LICENSE from secrets",
    );
  },
);

Deno.test(
  "workflow_definitions - cargo-upgrade template uses ACTIONS_PUSH for PR creation",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "cargo-upgrade");
    assertNotEquals(spec, undefined, "cargo-upgrade spec missing");
    assertEquals(
      spec!.template.includes("secrets.ACTIONS_PUSH"),
      true,
      "cargo-upgrade template should pass ACTIONS_PUSH as the PR token",
    );
  },
);

Deno.test(
  "workflow_definitions - deno-outdated template uses ACTIONS_PUSH for PR creation",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "deno-outdated");
    assertNotEquals(spec, undefined, "deno-outdated spec missing");
    assertEquals(
      spec!.template.includes("secrets.ACTIONS_PUSH"),
      true,
      "deno-outdated template should pass ACTIONS_PUSH as the PR token",
    );
  },
);

Deno.test(
  "workflow_definitions - deno-outdated template enforces 24h native minimum-age (Issue #2540)",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "deno-outdated");
    assertNotEquals(spec, undefined, "deno-outdated spec missing");
    assertEquals(
      spec!.template.includes(
        `--minimum-dependency-age=${CANONICAL_MINIMUM_DEPENDENCY_AGE}`,
      ),
      true,
      "deno-outdated template should pass the canonical 24h (P1D) minimum-age flag",
    );
  },
);

Deno.test(
  "workflow_definitions - deno-outdated template exempts internal stSoftwareAU scopes (Issue #2540)",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "deno-outdated");
    assertNotEquals(spec, undefined, "deno-outdated spec missing");
    for (const glob of INTERNAL_SCOPE_EXCLUDES) {
      assertEquals(
        spec!.template.includes(glob),
        true,
        `deno-outdated template should name internal exclusion ${glob}`,
      );
    }
  },
);

Deno.test(
  "workflow_definitions - deno-quality template uploads coverage with CODECOV_TOKEN",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "deno-quality");
    assertNotEquals(spec, undefined, "deno-quality spec missing");
    assertEquals(
      spec!.template.includes("codecov/codecov-action"),
      true,
      "deno-quality template should use codecov/codecov-action",
    );
    assertEquals(
      spec!.template.includes("secrets.CODECOV_TOKEN"),
      true,
      "deno-quality template should pass CODECOV_TOKEN to codecov upload",
    );
  },
);

Deno.test(
  "workflow_definitions - cargo-quality template uploads coverage with CODECOV_TOKEN",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "cargo-quality");
    assertNotEquals(spec, undefined, "cargo-quality spec missing");
    assertEquals(
      spec!.template.includes("codecov/codecov-action"),
      true,
      "cargo-quality template should use codecov/codecov-action",
    );
    assertEquals(
      spec!.template.includes("secrets.CODECOV_TOKEN"),
      true,
      "cargo-quality template should pass CODECOV_TOKEN to codecov upload",
    );
  },
);

// ---------------------------------------------------------------------------
// Issue #1756 — gitleaks-action's computed `<base_sha>^..<head_sha>` rev-range
// fails on the runner unless the PR base branch is explicitly fetched
// before the action runs. Mirror the private-repo-14 quality.yml pattern.
// ---------------------------------------------------------------------------

Deno.test(
  "workflow_definitions - gitleaks template fetches PR base branch before action",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    assertNotEquals(spec, undefined, "gitleaks spec missing");
    const t = spec!.template;
    assertEquals(
      t.includes("Fetch base branch"),
      true,
      "gitleaks template must include 'Fetch base branch' step (Issue #1756)",
    );
    assertEquals(
      t.includes("github.base_ref"),
      true,
      "gitleaks template must use github.base_ref to fetch base branch",
    );
    assertEquals(
      t.includes("github.event_name == 'pull_request'"),
      true,
      "gitleaks fetch-base step must be guarded by pull_request event",
    );
    // The fetch must happen BEFORE the gitleaks-action invocation,
    // otherwise the rev-range still fails.
    const fetchIdx = t.indexOf("Fetch base branch");
    const actionIdx = t.indexOf("gitleaks/gitleaks-action");
    assertEquals(
      fetchIdx >= 0 && actionIdx >= 0 && fetchIdx < actionIdx,
      true,
      "Fetch base branch step must precede gitleaks-action invocation",
    );
  },
);

Deno.test(
  "workflow_definitions - gitleaks template parses as valid YAML",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    assertNotEquals(spec, undefined, "gitleaks spec missing");
    // parseYaml throws on invalid YAML — this catches indentation regressions.
    const parsed = parseYaml(spec!.template);
    assertNotEquals(parsed, undefined);
  },
);

Deno.test(
  "workflow_definitions - local gitleaks.yml fetches PR base branch before action",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/gitleaks.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    assertEquals(
      content.includes("Fetch base branch"),
      true,
      "local gitleaks.yml must include 'Fetch base branch' step (Issue #1756)",
    );
    const fetchIdx = content.indexOf("Fetch base branch");
    const actionIdx = content.indexOf("gitleaks/gitleaks-action");
    assertEquals(
      fetchIdx >= 0 && actionIdx >= 0 && fetchIdx < actionIdx,
      true,
      "Fetch base branch step must precede gitleaks-action invocation",
    );
  },
);

Deno.test(
  "workflow_definitions - local gitleaks.yml wires GITLEAKS_LICENSE secret",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/gitleaks.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    assertEquals(
      content.includes("secrets.GITLEAKS_LICENSE"),
      true,
      "local gitleaks.yml should pull GITLEAKS_LICENSE from secrets",
    );
    // Detection pattern still satisfied
    const lower = content.toLowerCase();
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    for (const group of spec!.detectionPatternGroups) {
      const matched = group.some((p) => lower.includes(p.toLowerCase()));
      assertEquals(
        matched,
        true,
        `gitleaks.yml missing all alternatives in group: ${group.join(", ")}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Gitleaks licence-less CLI fallback (Issue #2981)
// ---------------------------------------------------------------------------
//
// gitleaks-action@v2 requires an org licence on org-owned repos, but
// Dependabot-authored PRs never receive Actions secrets, so the licence
// is empty and the action fails. The workflow must keep the licensed
// action for normal PRs (licence present) AND fall back to the free,
// open-source gitleaks CLI when the licence is absent.

Deno.test(
  "workflow_definitions - gitleaks template falls back to the open-source CLI when unlicensed",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    assertNotEquals(spec, undefined, "gitleaks spec missing");
    const t = spec!.template;
    // Both branches must be present and mutually exclusive.
    assertEquals(
      t.includes("env.GITLEAKS_LICENSE != ''"),
      true,
      "licensed action must be gated on a present licence",
    );
    assertEquals(
      t.includes("env.GITLEAKS_LICENSE == ''"),
      true,
      "CLI fallback must be gated on an absent licence",
    );
    // The fallback uses the gitleaks CLI binary, not the action.
    assertEquals(
      t.includes("gitleaks git"),
      true,
      "fallback must invoke the gitleaks CLI",
    );
    // Pinned version + checksum verification (supply-chain hardening).
    assertEquals(
      t.includes("GITLEAKS_VERSION"),
      true,
      "fallback must pin a gitleaks version",
    );
    assertEquals(
      t.includes("sha256sum -c"),
      true,
      "fallback must verify the downloaded binary against a checksum",
    );
    // Job-level env exposes the licence so step `if:` can read it.
    assertEquals(
      /env:\s*\n\s*GITLEAKS_LICENSE:/.test(t),
      true,
      "GITLEAKS_LICENSE must be exposed at job level for the if: guard",
    );
  },
);

Deno.test(
  "workflow_definitions - local gitleaks.yml falls back to the open-source CLI when unlicensed",
  async () => {
    const content = await Deno.readTextFile(
      new URL("../../../.github/workflows/gitleaks.yml", import.meta.url),
    );
    assertEquals(
      content.includes("env.GITLEAKS_LICENSE != ''"),
      true,
      "licensed action must be gated on a present licence",
    );
    assertEquals(
      content.includes("env.GITLEAKS_LICENSE == ''"),
      true,
      "CLI fallback must be gated on an absent licence",
    );
    assertEquals(
      content.includes("gitleaks git"),
      true,
      "fallback must invoke the gitleaks CLI",
    );
    assertEquals(
      content.includes("sha256sum -c"),
      true,
      "fallback must verify the downloaded binary against a checksum",
    );
    // Must still parse as valid YAML.
    assertNotEquals(parseYaml(content), undefined);
  },
);

// ---------------------------------------------------------------------------
// Gitleaks supply-chain hardening (Issue #1756)
// ---------------------------------------------------------------------------
//
// The gitleaks workflow is security-sensitive — a hijacked third-party
// action tag could exfiltrate secrets from any consumer repository. The
// canonical private-repo-14 pattern pins both `actions/checkout` and
// `gitleaks/gitleaks-action` to 40-character commit SHAs (see
// stSoftwareAU/private-repo-14/.github/workflows/quality.yml). The Vibe Coder must
// emit the same hardening for every repository it sets up.

Deno.test(
  "workflow_definitions - gitleaks template pins all uses: lines to commit SHAs",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    assertNotEquals(spec, undefined, "gitleaks spec missing");
    const usesLines = spec!.template
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));
    assertNotEquals(usesLines.length, 0, "Expected at least one uses: line");
    for (const line of usesLines) {
      const match = /uses:\s+\S+@([0-9a-f]+)/i.exec(line);
      assertNotEquals(match, null, `uses: line not parseable: "${line}"`);
      assertEquals(
        match![1]!.length,
        40,
        `gitleaks template uses: line not pinned to 40-char SHA: "${line}"`,
      );
    }
  },
);

Deno.test(
  "workflow_definitions - gitleaks template references private-repo-14 canonical pattern",
  () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
    assertNotEquals(spec, undefined, "gitleaks spec missing");
    // The template must point reviewers at the canonical reference so a
    // future regression is easy to diagnose.
    assertEquals(
      spec!.template.includes("private-repo-14"),
      true,
      "gitleaks template should reference the canonical private-repo-14 pattern",
    );
  },
);

Deno.test(
  "workflow_definitions - local gitleaks.yml pins all uses: lines to commit SHAs",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/gitleaks.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);
    const usesLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));
    assertNotEquals(usesLines.length, 0, "Expected at least one uses: line");
    for (const line of usesLines) {
      const match = /uses:\s+\S+@([0-9a-f]+)/i.exec(line);
      assertNotEquals(match, null, `uses: line not parseable: "${line}"`);
      assertEquals(
        match![1]!.length,
        40,
        `gitleaks.yml uses: line not pinned to 40-char SHA: "${line}"`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Repo-wide supply-chain hardening (Issue #2123)
// ---------------------------------------------------------------------------
//
// Every workflow file under .github/workflows/ must pin third-party
// actions to a 40-character commit SHA, not a floating tag. The
// gitleaks.yml comment lays out the rationale: a hijacked tag could
// repoint at malicious code on the next CI run.
//
// First-party reusable workflows referenced with `./.github/workflows/...`
// are exempt — they live in the same repo and are already content-locked
// by the commit that introduces them.
//
// Issue #3661 (SEC-43556fb212fc): this test reads VibeCoder's own
// `.github/workflows/` directory — it says nothing about the `template:`
// string literals in `workflow_definitions.ts` that the worker installs into
// managed repos. Its old name ("every workflow …") implied coverage it did
// not provide, which is how #3645 survived. The template catalogue is
// covered separately by the "every template pins uses: refs …" test below;
// keep both names honest about which surface they check.

Deno.test(
  "workflow_definitions - VibeCoder's own .github/workflows pin third-party actions to 40-char SHAs",
  async () => {
    const workflowsDirUrl = new URL(
      "../../../.github/workflows/",
      import.meta.url,
    );
    const workflowsDir = workflowsDirUrl.pathname;
    const files: string[] = [];
    for await (const entry of Deno.readDir(workflowsDir)) {
      if (
        entry.isFile &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
      ) {
        files.push(entry.name);
      }
    }
    assertNotEquals(files.length, 0, "Expected at least one workflow file");

    for (const name of files) {
      const content = await Deno.readTextFile(workflowsDir + name);
      const usesLines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));

      for (const line of usesLines) {
        // Strip the leading "- " if present so we always parse "uses: ...".
        const target = line.replace(/^-\s+/, "");
        const refMatch = /uses:\s+(\S+)/.exec(target);
        assertNotEquals(refMatch, null, `${name}: unparseable uses: "${line}"`);
        const ref = refMatch![1]!;
        // First-party reusable workflows are exempt.
        if (ref.startsWith("./")) continue;
        const shaMatch = /@([0-9a-f]+)$/i.exec(ref);
        assertNotEquals(
          shaMatch,
          null,
          `${name}: uses: not pinned to SHA: "${line}"`,
        );
        assertEquals(
          shaMatch![1]!.length,
          40,
          `${name}: uses: not pinned to 40-char SHA: "${line}"`,
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Emitted-template supply-chain hardening (Issue #3645)
// ---------------------------------------------------------------------------
//
// The per-spec assertions above cover gitleaks and markdown-lint only, so
// thirteen other templates were free to reference third-party components
// by mutable tag or branch. These tests iterate the whole catalogue, so a
// new template cannot regress to a floating ref.

/** Every `uses:` value in a template, with the leading "- " stripped. */
function usesRefs(template: string): string[] {
  return template
    .split("\n")
    .map((l) => l.trim().replace(/^-\s+/, ""))
    .filter((l) => l.startsWith("uses:"))
    .map((l) => /uses:\s+(\S+)/.exec(l)?.[1] ?? "");
}

Deno.test(
  "workflow_definitions - every template pins uses: refs to 40-char SHAs",
  () => {
    for (const spec of WORKFLOW_SPECS) {
      for (const ref of usesRefs(spec.template)) {
        assertNotEquals(ref, "", `${spec.id}: unparseable uses: line`);
        const shaMatch = /@([0-9a-f]{40})$/.exec(ref);
        assertNotEquals(
          shaMatch,
          null,
          `${spec.id}: "${ref}" is not pinned to a 40-character commit ` +
            `SHA — a mutable tag or branch lets an upstream hijack run in ` +
            `every managed repository (Issue #3645)`,
        );
      }
    }
  },
);

Deno.test(
  "workflow_definitions - no template references a branch or tag ref",
  () => {
    // Branch refs are the sharpest case: a push to the upstream default
    // branch propagates on the next scheduled run, with no tag re-point.
    for (const spec of WORKFLOW_SPECS) {
      for (const ref of usesRefs(spec.template)) {
        const suffix = ref.split("@")[1] ?? "";
        assertEquals(
          /^(main|master|stable|nightly|beta|v\d[\w.-]*)$/.test(suffix),
          false,
          `${spec.id}: "${ref}" uses a mutable branch/tag ref`,
        );
      }
    }
  },
);

Deno.test(
  "workflow_definitions - every container image is digest-pinned",
  () => {
    // An untagged `image:` resolves to `:latest`, so a hijacked registry
    // tag runs with whatever secrets the job holds.
    let checked = 0;
    for (const spec of WORKFLOW_SPECS) {
      const images = spec.template
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("image:"))
        .map((l) => /image:\s+(\S+)/.exec(l)?.[1] ?? "");
      for (const image of images) {
        checked++;
        assertEquals(
          /@sha256:[0-9a-f]{64}$/.test(image),
          true,
          `${spec.id}: container image "${image}" is not digest-pinned`,
        );
      }
    }
    assertNotEquals(checked, 0, "Expected at least one container image");
  },
);

Deno.test(
  "workflow_definitions - semgrep template and local semgrep.yml share a digest",
  async () => {
    const spec = WORKFLOW_SPECS.find((s) => s.id === "semgrep");
    assertNotEquals(spec, undefined, "semgrep spec missing");
    const localUrl = new URL(
      "../../../.github/workflows/semgrep.yml",
      import.meta.url,
    );
    const local = await Deno.readTextFile(localUrl);
    // Tag+digest form since Issue #4403 (`semgrep/semgrep:<tag>@sha256:…`).
    const digestOf = (content: string) =>
      /semgrep\/semgrep(?::[^@\s]+)?@(sha256:[0-9a-f]{64})/.exec(content)?.[1];

    const localDigest = digestOf(local);
    assertNotEquals(localDigest, undefined, "semgrep.yml has no image digest");
    assertEquals(
      digestOf(spec!.template),
      localDigest,
      "The emitted semgrep template and .github/workflows/semgrep.yml must " +
        "reference the same image digest so the local hardening cannot " +
        "drift from what is emitted (Issue #3645)",
    );
  },
);

Deno.test(
  "workflow_definitions - SHA-pinned refs name their toolchain and tool",
  () => {
    // `dtolnay/rust-toolchain@stable` and `taiki-e/install-action@cargo-
    // llvm-cov` derive their behaviour from the ref name. Once pinned to a
    // SHA the ref carries no name, so the input must be explicit or the
    // step fails at run time.
    const inputByAction: Record<string, string> = {
      "dtolnay/rust-toolchain": "toolchain",
      "taiki-e/install-action": "tool",
    };
    let checked = 0;
    for (const spec of WORKFLOW_SPECS) {
      const parsed = parseYaml(spec.template) as
        | { jobs?: Record<string, { steps?: Record<string, unknown>[] }> }
        | undefined;
      for (const job of Object.values(parsed?.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const uses = String(step.uses ?? "");
          const action = uses.split("@")[0] ?? "";
          const input = inputByAction[action];
          if (!input) continue;
          checked++;
          const withBlock = step.with as Record<string, unknown> | undefined;
          assertNotEquals(
            withBlock?.[input],
            undefined,
            `${spec.id}: ${action} is SHA-pinned but does not pass an ` +
              `explicit "${input}:" input`,
          );
        }
      }
    }
    assertNotEquals(checked, 0, "Expected ref-named actions in the catalogue");
  },
);

// ---------------------------------------------------------------------------
// Visibility-aware workflow filtering (Issue #1753)
// ---------------------------------------------------------------------------

Deno.test(
  "workflow_definitions - default visibilityScope is treated as 'any'",
  () => {
    // Specs that omit visibilityScope must apply to both public and
    // private repos. Public visibility always returns the baseline.
    // Private visibility filters out specs marked `public-only`
    // (Issue #1754 introduced the first such spec, dependency-review).
    const publicSpecs = getWorkflowsForLanguagesAndVisibility(
      ["Rust"],
      "public",
    );
    const privateSpecs = getWorkflowsForLanguagesAndVisibility(
      ["Rust"],
      "private",
    );
    const baselineSpecs = getWorkflowsForLanguages(["Rust"]);

    assertEquals(
      publicSpecs.map((s) => s.id),
      baselineSpecs.map((s) => s.id),
      "Public visibility should match the unfiltered baseline",
    );

    const expectedPrivate = baselineSpecs
      .filter((s) => s.visibilityScope !== "public-only")
      .map((s) => s.id);
    assertEquals(
      privateSpecs.map((s) => s.id),
      expectedPrivate,
      "Private visibility should drop public-only specs and keep the rest",
    );

    // Every spec without an explicit visibilityScope must default to
    // applying to all repos (i.e. never filtered out by the visibility
    // filter). This mirrors the contract documented on the WorkflowSpec
    // type.
    for (const spec of WORKFLOW_SPECS) {
      if (spec.visibilityScope === undefined) {
        // Implicit "any" — must appear in both visibilities.
        const scopes = getWorkflowsForLanguagesAndVisibility(
          Array.isArray(spec.appliesTo) ? spec.appliesTo : [],
          "private",
        );
        assertEquals(
          scopes.some((s) => s.id === spec.id),
          true,
          `Spec "${spec.id}" without visibilityScope must apply to private repos`,
        );
      }
    }
  },
);

Deno.test(
  "workflow_definitions - getWorkflowsForLanguagesAndVisibility excludes public-only specs for private repos",
  () => {
    const stub: WorkflowSpec = {
      id: "stub-public-only",
      name: "Stub Public Only",
      appliesTo: "universal",
      triggers: ["pull_request"],
      detectionPatternGroups: [["stub-only-pattern"]],
      suggestedFilename: "stub-public-only.yml",
      template: "name: stub\n",
      category: "security",
      visibilityScope: "public-only",
    };

    // Treat the stub as if it had been added to the catalogue. Use a
    // helper that filters a custom list to mirror the production filter.
    const filtered = filterByVisibility([stub], "private");
    assertEquals(
      filtered.length,
      0,
      "public-only spec must be excluded for private",
    );

    const allowed = filterByVisibility([stub], "public");
    assertEquals(
      allowed.length,
      1,
      "public-only spec must be included for public",
    );
    assertEquals(allowed[0]!.id, "stub-public-only");
  },
);

Deno.test(
  "workflow_definitions - getWorkflowsForLanguagesAndVisibility includes 'any' specs for both visibilities",
  () => {
    const stubAny: WorkflowSpec = {
      id: "stub-any",
      name: "Stub Any",
      appliesTo: "universal",
      triggers: ["pull_request"],
      detectionPatternGroups: [["stub-any-pattern"]],
      suggestedFilename: "stub-any.yml",
      template: "name: stub\n",
      category: "security",
      visibilityScope: "any",
    };

    assertEquals(filterByVisibility([stubAny], "private").length, 1);
    assertEquals(filterByVisibility([stubAny], "public").length, 1);
  },
);

// ---------------------------------------------------------------------------
// CI invocation must not drift from the canonical `deno task test` (Issue #2194)
// ---------------------------------------------------------------------------
//
// The local quality gate (worker/deno/lib/quality_gate.ts) and the canonical
// task in worker/deno/deno.json both invoke `deno test` with
// `--allow-sys=hostname`. Production code paths exercised by the suite call
// `Deno.hostname()` (worker_identity.ts, idle_detect_diagnostics.ts,
// fault_tolerance_counters.ts, fleet_health.ts), so any test that drives them
// needs the permission in CI as well. The simplest way to keep them aligned
// is to invoke `deno task test` from CI; this test guards against drift.

Deno.test(
  "validate-scripts.yml Deno tests step uses canonical task or includes --allow-sys=hostname",
  async () => {
    const workflowUrl = new URL(
      "../../../.github/workflows/validate-scripts.yml",
      import.meta.url,
    );
    const content = await Deno.readTextFile(workflowUrl);

    // Extract the "Deno tests" step body. Issue #4334 sharded the suite
    // across a matrix, so the step is `Deno tests (shard N of 4)` and it
    // delegates to `.github/scripts/deno-test-shard.sh`; the guard follows
    // the delegation so it verifies the real invocation, not a step name.
    // We accept either:
    //   (a) `deno task test` — the preferred form (no drift possible), or
    //   (b) `deno test ... --allow-sys=hostname ...` — explicit equivalence.
    const stepMatch =
      /- name: Deno tests[^\n]*\n([\s\S]*?)(?:\n {6}- name:|\n {2}[a-z-]+:|\n$)/
        .exec(content);
    assertNotEquals(
      stepMatch,
      null,
      "validate-scripts.yml must define a 'Deno tests' step",
    );
    let body = stepMatch![1]!;
    const delegate = /\.github\/scripts\/deno-test-shard\.sh/.test(body);
    if (delegate) {
      body += "\n" + await Deno.readTextFile(
        new URL(
          "../../../.github/scripts/deno-test-shard.sh",
          import.meta.url,
        ),
      );
    }

    const usesTask = /\bdeno\s+task\s+test\b/.test(body);
    const hasAllowSys = /--allow-sys=hostname\b/.test(body);

    assertEquals(
      usesTask || hasAllowSys,
      true,
      "CI 'Deno tests' step must run `deno task test` or pass " +
        "--allow-sys=hostname (Issue #2194: required by Deno.hostname() " +
        "call sites; must match deno.json and quality_gate.ts).",
    );
  },
);

Deno.test(
  "deno.json test task includes --allow-sys=hostname",
  async () => {
    // Defence in depth: the canonical task itself must keep the flag.
    const denoJsonUrl = new URL("../deno.json", import.meta.url);
    const content = await Deno.readTextFile(denoJsonUrl);
    const parsed = JSON.parse(content) as { tasks?: Record<string, string> };
    const testTask = parsed.tasks?.test ?? "";
    assertEquals(
      testTask.includes("--allow-sys=hostname"),
      true,
      "deno.json `test` task must pass --allow-sys=hostname (Issue #2194)",
    );
  },
);

/**
 * Helper that exercises the same filter rule as
 * `getWorkflowsForLanguagesAndVisibility` against a custom spec list.
 * Mirrors the production filter so a stub spec can be tested without
 * mutating the exported catalogue.
 */
function filterByVisibility(
  specs: WorkflowSpec[],
  visibility: "public" | "private",
): WorkflowSpec[] {
  return specs.filter(
    (s) => visibility === "public" || s.visibilityScope !== "public-only",
  );
}

// ---------------------------------------------------------------------------
// CI shellcheck pin must match the container manifest (Issue #4334)
// ---------------------------------------------------------------------------

Deno.test(
  "validate-scripts.yml installs the same pinned shellcheck as container/tools.json",
  async () => {
    const root = new URL("../../../", import.meta.url);
    const workflow = await Deno.readTextFile(
      new URL(".github/workflows/validate-scripts.yml", root),
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(new URL("container/tools.json", root)),
    ) as {
      toolchains: Array<
        { id: string; version: string; sha256: Record<string, string> }
      >;
    };
    const pinned = manifest.toolchains.find((t) => t.id === "shellcheck");
    assertNotEquals(pinned, undefined, "tools.json must pin shellcheck");

    const version = /SHELLCHECK_VERSION:\s*"([^"]+)"/.exec(workflow)?.[1];
    const sha = /SHELLCHECK_SHA256:\s*"([^"]+)"/.exec(workflow)?.[1];
    assertEquals(
      version,
      pinned!.version,
      "CI shellcheck version drifted from tools.json",
    );
    assertEquals(
      sha,
      pinned!.sha256.amd64,
      "CI shellcheck sha256 drifted from tools.json",
    );
    // And never the apt lottery.
    assertEquals(
      /apt-get\s+install\s+-y\s+shellcheck/.test(workflow),
      false,
      "shellcheck must come from the pinned release, not apt",
    );
  },
);
