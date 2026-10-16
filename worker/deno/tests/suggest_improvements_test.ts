/**
 * Tests for the suggest-improvements command.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 * Issue #192 — Initial suggest improvements command.
 * Issue #209 — Updated with prompt and workflow improvement suggestions.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger, WorkerConfig } from "../types.ts";
import type {
  Improvement,
  SuggestImprovementsData,
} from "../commands/suggest_improvements.ts";
import {
  createSuggestImprovementsCommand,
  formatImprovementAsIssueBody,
  generateImprovements,
  suggestImprovementsCommand,
} from "../commands/suggest_improvements.ts";
import { createGitHubIssuesWithPartialFailures } from "../lib/github.ts";
import { createLogger } from "../lib/logger.ts";
import {
  buildDefaultWorkerConfig,
  RESERVED_LABELS,
} from "../lib/config_defaults.ts";
import {
  addIssue,
  fakeStore,
  isWriteCall,
  routingFakeGh,
} from "./support/routing_fake_gh.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const GRQ = "stSoftwareAU/GRQ";
const NOW = () => new Date("2026-10-15T00:00:00Z");
const CTX = { vibeCoderRepo: VIBE, productRepos: [GRQ] };
/** A worker change: the router files it in VibeCoder (Issue #3745). */
const WORKER_NOTE = "`worker/deno/lib/foo.ts` needs work.";

// Mock config for tests
function createMockConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
    ...overrides,
  }) as WorkerConfig;
}

// =============================================================================
// generateImprovements() — Core logic tests
// =============================================================================

Deno.test("suggest-improvements - generates a non-empty list of improvements", () => {
  const improvements = generateImprovements();

  assertEquals(improvements.length > 0, true);
});

Deno.test("suggest-improvements - each improvement has required fields", () => {
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    assertEquals(typeof improvement.title, "string");
    assertEquals(improvement.title.length > 0, true);

    assertEquals(typeof improvement.description, "string");
    assertEquals(improvement.description.length > 0, true);

    assertEquals(typeof improvement.category, "string");
    assertEquals(improvement.category.length > 0, true);

    assertEquals(Array.isArray(improvement.labels), true);
    assertEquals(improvement.labels.length > 0, true);
  }
});

Deno.test("suggest-improvements - improvements have valid categories", () => {
  const validCategories = [
    "observability",
    "resilience",
    "testing",
    "developer-experience",
    "security",
    "maintainability",
  ];
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    assertEquals(
      validCategories.includes(improvement.category),
      true,
      `Invalid category: ${improvement.category}`,
    );
  }
});

Deno.test("suggest-improvements - improvements have unique titles", () => {
  const improvements = generateImprovements();
  const titles = improvements.map((i) => i.title);
  const uniqueTitles = new Set(titles);

  assertEquals(titles.length, uniqueTitles.size, "Duplicate titles found");
});

Deno.test("suggest-improvements - all improvements include 'enhancement' label", () => {
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    assertEquals(
      improvement.labels.includes("enhancement"),
      true,
      `Improvement "${improvement.title}" missing 'enhancement' label`,
    );
  }
});

// =============================================================================
// formatImprovementAsIssueBody() — Formatting tests
// =============================================================================

Deno.test("suggest-improvements - formats improvement as markdown issue body", () => {
  const improvement: Improvement = {
    title: "Add operational metrics",
    description: "Track success/failure counts and processing times.",
    category: "observability",
    labels: ["enhancement"],
  };

  const body = formatImprovementAsIssueBody(improvement);

  assertStringIncludes(body, "## Description");
  assertStringIncludes(body, improvement.description);
  assertStringIncludes(body, "## Category");
  assertStringIncludes(body, improvement.category);
});

Deno.test("suggest-improvements - formatted body uses Australian English", () => {
  const improvement: Improvement = {
    title: "Improve error handling",
    description: "Standardise error recovery behaviour across modules.",
    category: "resilience",
    labels: ["enhancement"],
  };

  const body = formatImprovementAsIssueBody(improvement);

  // Body should contain the description as-is (which uses Australian English)
  assertStringIncludes(body, "Standardise");
  assertStringIncludes(body, "behaviour");
});

// =============================================================================
// suggestImprovementsCommand.execute() — Command integration tests
// =============================================================================

Deno.test("suggest-improvements - command returns success with dry-run", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  assertStringIncludes(result.message, "improvement");
});

Deno.test("suggest-improvements - command data contains improvements array", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  const data = result.data as { improvements: Improvement[] };
  assertEquals(Array.isArray(data.improvements), true);
  assertEquals(data.improvements.length > 0, true);
});

Deno.test("suggest-improvements - command includes repo in args when provided", async () => {
  // With a repo, the dry run reaches the router, so it runs against a fake gh.
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: NOW,
  }).execute(
    { "dry-run": true, repo: VIBE },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  const data = result.data as { repo: string };
  assertEquals(data.repo, VIBE);
});

Deno.test("suggest-improvements - a dry run without a repo reports the plural count and a null repo (Issue #3745)", async () => {
  const count = generateImprovements().length;
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true },
    createMockConfig(),
  );

  assertEquals(count > 1, true);
  assertEquals(
    result.message,
    `Generated ${count} improvement suggestions (dry-run)`,
  );
  const data = result.data as SuggestImprovementsData;
  assertEquals(data.repo, null);
});

Deno.test("suggest-improvements - invalid arguments fail with the validation message (Issue #3745)", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": "yes" },
    createMockConfig(),
  );

  assertEquals(result.success, false);
  assertEquals(result.message, "Argument 'dry-run' must be a boolean");
  assertEquals(result.data, undefined);
});

Deno.test("suggest-improvements - command name is correct", () => {
  assertEquals(suggestImprovementsCommand.name, "suggest-improvements");
});

Deno.test("suggest-improvements - command has a description", () => {
  assertEquals(typeof suggestImprovementsCommand.description, "string");
  assertEquals(suggestImprovementsCommand.description.length > 0, true);
});

// =============================================================================
// Issue #209 — Prompt and workflow improvement coverage
// =============================================================================

// Issue #1531 — The previous assertion required a "security" category entry.
// Both security-category entries in the Issue #209 list referenced retired
// shell files (`worker/shared/feature_availability.sh`, `worker/shared/security.sh`)
// and were removed during the post-Deno-migration refresh. This test now
// verifies that any security suggestion that is added does not regress to
// referencing the retired shell modules.
Deno.test("suggest-improvements - security suggestions do not reference retired shell modules", () => {
  const improvements = generateImprovements();
  const retiredShellFiles = [
    "worker/shared/feature_availability.sh",
    "worker/shared/security.sh",
    "worker/shared/retry.sh",
    "worker/shared/dry_run.sh",
    "worker/shared/claude_runner.sh",
    "prompt_builder.sh",
  ];

  for (const improvement of improvements) {
    for (const retired of retiredShellFiles) {
      assertEquals(
        improvement.description.includes(retired),
        false,
        `Improvement "${improvement.title}" references retired shell module "${retired}"`,
      );
    }
  }
});

Deno.test("suggest-improvements - includes prompt-related improvements", () => {
  const improvements = generateImprovements();
  const promptImprovements = improvements.filter(
    (i) =>
      i.title.toLowerCase().includes("prompt") ||
      i.description.toLowerCase().includes("prompt"),
  );

  assertEquals(
    promptImprovements.length > 0,
    true,
    "Should include at least one prompt-related improvement",
  );
});

Deno.test("suggest-improvements - includes testing category improvements", () => {
  const improvements = generateImprovements();
  const testImprovements = improvements.filter(
    (i) => i.category === "testing",
  );

  assertEquals(
    testImprovements.length > 0,
    true,
    "Should include at least one testing improvement",
  );
});

Deno.test("suggest-improvements - covers multiple categories", () => {
  const improvements = generateImprovements();
  const categories = new Set(improvements.map((i) => i.category));

  // Should cover at least 4 different categories
  assertEquals(
    categories.size >= 4,
    true,
    `Expected at least 4 categories, got ${categories.size}: ${
      [...categories].join(", ")
    }`,
  );
});

// =============================================================================
// Issue #297 — No reserved labels on generated improvements
// =============================================================================

Deno.test("suggest-improvements - no improvement uses reserved labels", () => {
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    for (const label of improvement.labels) {
      assertEquals(
        RESERVED_LABELS.includes(label),
        false,
        `Improvement "${improvement.title}" uses reserved label "${label}" — ` +
          `reserved labels should only be applied by the repository owner`,
      );
    }
  }
});

// Issue #1531 — Every concrete file path mentioned in the suggestions must
// exist in the current working tree. This prevents the canned list drifting
// again after future migrations.
Deno.test("suggest-improvements - every referenced file path exists in the repo", async () => {
  const improvements = generateImprovements();
  // Resolve paths relative to the repo root (two levels above this test file).
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  // Match paths starting with known top-level directories of this repo.
  // We restrict to these roots to avoid false positives on fragments that
  // aren't real path references.
  const pathPattern =
    /\b(?:worker\/(?:deno|shared)|prompts|docs|tests|logs|hooks)\/[\w./-]+?\.(?:ts|sh|md|json|yml)\b/g;

  const missing: string[] = [];
  for (const improvement of improvements) {
    const haystack = `${improvement.title}\n${improvement.description}`;
    const matches = haystack.match(pathPattern) ?? [];
    const proposedIdx = haystack.indexOf("Proposed Solution");
    for (const candidate of matches) {
      // "Proposed Solution" sections may describe files that do not yet
      // exist (e.g., prompts/pr_feedback/v6.md, logs/prompt-versions.log).
      // Skip paths that appear only in that section.
      const appearsOnlyInProposal = proposedIdx >= 0 &&
        haystack.indexOf(candidate) >= proposedIdx;
      if (candidate.startsWith("logs/") && appearsOnlyInProposal) continue;
      if (/\/v\d+\.md$/.test(candidate) && appearsOnlyInProposal) continue;
      try {
        await Deno.stat(`${repoRoot}${candidate}`);
      } catch {
        missing.push(`"${improvement.title}" → ${candidate}`);
      }
    }
  }

  assertEquals(
    missing.length,
    0,
    `Suggestions reference files that do not exist:\n${missing.join("\n")}`,
  );
});

Deno.test("suggest-improvements - formatted body includes issue reference", () => {
  const improvement: Improvement = {
    title: "Test improvement",
    description: "Test description for validation.",
    category: "testing",
    labels: ["enhancement"],
  };

  const body = formatImprovementAsIssueBody(improvement);

  assertStringIncludes(body, "suggest-improvements");
  assertStringIncludes(body, "Issue #209");
});

// =============================================================================
// Issue #3745 — suggest-improvements files through the issue router
// =============================================================================

Deno.test("suggest-improvements - a worker improvement drafted against GRQ is filed in VibeCoder (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE", [GRQ]: "WRITE" }));
  const result = await createGitHubIssuesWithPartialFailures(
    [{
      title: "Worker fix",
      description: WORKER_NOTE,
      category: "testing",
      labels: ["enhancement"],
    }],
    GRQ,
    {
      routingContext: CTX,
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
    },
  );

  assertEquals(result.createdIssues, [1]);
  assertEquals(result.routed[0]?.repository, VIBE);
  assertEquals(result.routed[0]?.action, "created");
  assertEquals(gh.store.issues.map((i) => i.repo), [VIBE]);
});

Deno.test("suggest-improvements - an ambiguous improvement files nothing and is reported as a failure (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const warnings: string[] = [];
  const logger: Logger = {
    ...createLogger({ write: () => {} }),
    warn: (message: string) => {
      warnings.push(message);
    },
  };
  const result = await createGitHubIssuesWithPartialFailures(
    [{
      title: "Tidy things up",
      description: "Make it nicer.",
      category: "maintainability",
      labels: ["enhancement"],
    }],
    VIBE,
    {
      routingContext: CTX,
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
      logger,
    },
  );

  assertEquals(gh.calls.filter(isWriteCall), []);
  assertEquals(result.createdIssues, []);
  assertEquals(result.routed, []);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.title, "Tidy things up");
  // The injected logger reaches the router, which warns about the ambiguous owner.
  assertEquals(warnings, [
    "Issue routing filed nothing: the owner is ambiguous",
  ]);
  assertStringIncludes(result.failures[0]!.error, "Routing filed nothing");
  assertStringIncludes(result.failures[0]!.error, "ambiguous owner");
});

Deno.test("suggest-improvements - a routing error is reported in failures[] with its step and routing reason, not dropped (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "READ" }));
  const improvement = (title: string) => ({
    title,
    description: WORKER_NOTE,
    category: "testing" as const,
    labels: ["enhancement"],
  });
  const result = await createGitHubIssuesWithPartialFailures(
    [improvement("Worker one"), improvement("Worker two")],
    VIBE,
    {
      routingContext: CTX,
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
    },
  );

  assertEquals(result.failures.length, 2);
  for (const failure of result.failures) {
    assertStringIncludes(failure.error, 'step "permission"');
    assertStringIncludes(failure.error, "(routing: ");
    assertStringIncludes(failure.error, "belongs in stSoftwareAU/VibeCoder");
  }
  assertEquals(result.createdIssues, []);
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("suggest-improvements - a classify failure is reported with its step and no routing reason (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const result = await createGitHubIssuesWithPartialFailures(
    [{
      title: "Worker one",
      description: WORKER_NOTE,
      category: "testing",
      labels: [],
    }],
    VIBE,
    {
      routingContext: { vibeCoderRepo: VIBE, productRepos: ["not a repo"] },
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
    },
  );

  assertEquals(result.failures.length, 1);
  assertStringIncludes(result.failures[0]!.error, 'step "classify"');
  assertEquals(result.failures[0]!.error.includes("(routing:"), false);
  assertEquals(gh.calls, []);
});

Deno.test("suggest-improvements - an error thrown outside the router is reported with its own message (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const result = await createGitHubIssuesWithPartialFailures(
    [
      {
        title: "Broken labels",
        description: WORKER_NOTE,
        category: "testing",
        labels: undefined as unknown as string[],
      },
      {
        title: "Worker two",
        description: WORKER_NOTE,
        category: "testing",
        labels: ["enhancement"],
      },
    ],
    VIBE,
    {
      routingContext: CTX,
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
    },
  );

  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.title, "Broken labels");
  const error = result.failures[0]!.error;
  // The TypeError from iterating `undefined` in the reserved-label pre-filter.
  assertStringIncludes(error, "iterable");
  assertEquals(error.includes("Routed issue filing failed"), false);
  assertEquals(error.includes("(routing: "), false);
  assertEquals(result.createdIssues.length, 1);
});

Deno.test("suggest-improvements - a non-Error thrown outside the router is reported as text (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const logger: Logger = {
    ...createLogger({ write: () => {} }),
    warn: () => {
      // deno-lint-ignore no-throw-literal
      throw "logger down";
    },
  };
  const result = await createGitHubIssuesWithPartialFailures(
    [{
      title: "Worker one",
      description: WORKER_NOTE,
      category: "testing",
      labels: ["enhancement", "work-on"],
    }],
    VIBE,
    {
      routingContext: CTX,
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
      logger,
    },
  );

  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.error, "logger down");
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("suggest-improvements - an existing open issue with the same title is reused, not refiled (Issue #3745)", async () => {
  const store = fakeStore([], { [VIBE]: "WRITE" });
  const existing = addIssue(store, VIBE, "Worker one");
  const gh = routingFakeGh(store);
  const result = await createGitHubIssuesWithPartialFailures(
    [{
      title: "Worker one",
      description: WORKER_NOTE,
      category: "testing",
      labels: ["enhancement"],
    }],
    VIBE,
    {
      routingContext: CTX,
      dryRun: false,
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
    },
  );

  assertEquals(result.createdIssues, []);
  assertEquals(result.failures, []);
  assertEquals(result.routed, [{
    title: "Worker one",
    action: "reused",
    repository: VIBE,
    number: existing.number,
  }]);
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("suggest-improvements - dry-run with a repo makes no write call and reports what it would file (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: NOW,
  }).execute({ "dry-run": true, repo: VIBE }, createMockConfig());

  assertEquals(gh.calls.filter(isWriteCall), []);
  assertEquals(result.success, true);
  const data = result.data as SuggestImprovementsData;
  const routed = data.routed ?? [];
  assertEquals(routed.length, generateImprovements().length);
  assertEquals(routed.every((r) => r.action === "would-create"), true);
  assertStringIncludes(result.message, "would be created");
});

Deno.test("suggest-improvements - a real run files every suggestion in VibeCoder, whatever repo it was drafted for (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE", [GRQ]: "WRITE" }));
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: NOW,
  }).execute({ repo: GRQ }, createMockConfig({ repos: [GRQ] }));

  assertEquals(result.success, true);
  assertEquals(result.message.startsWith("Created "), true);
  assertEquals(gh.store.issues.length, generateImprovements().length);
  assertEquals(gh.store.issues.every((i) => i.repo === VIBE), true);
  const data = result.data as SuggestImprovementsData;
  assertEquals(data.createdIssues, gh.store.issues.map((i) => i.number));
});

Deno.test("suggest-improvements - a configured custom label is never self-applied to a filed issue (Issue #847)", async () => {
  // Positive control: with no custom label, the generated `enhancement` stays.
  const plain = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  await createSuggestImprovementsCommand({
    ghCommandFn: plain.ghCommandFn,
    now: NOW,
  }).execute({ repo: VIBE }, createMockConfig());
  assertEquals(plain.store.issues.length, generateImprovements().length);
  assertEquals(
    plain.store.issues.every((i) => i.labels.includes("enhancement")),
    true,
  );

  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const config = createMockConfig({
    customLabelPrompts: [{
      label: "enhancement",
      promptPath: "/tmp/prompt.md",
      targetPhase: "issue",
    }],
  });
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: NOW,
  }).execute({ repo: VIBE }, config);

  assertEquals(result.success, true);
  assertEquals(gh.store.issues.length, generateImprovements().length);
  assertEquals(
    gh.store.issues.some((i) => i.labels.includes("enhancement")),
    false,
  );
});

Deno.test("suggest-improvements - a real run with failures says so and reports success false (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "READ" }));
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: NOW,
  }).execute({ repo: VIBE }, createMockConfig());

  assertEquals(result.success, false);
  assertEquals(
    result.message,
    "Created 0 improvement issues and reused 0 existing issues, routed from stSoftwareAU/VibeCoder (7 failed)",
  );
  assertEquals(gh.calls.filter(isWriteCall), []);
});

Deno.test("suggest-improvements - the summary counts created, reused and would-be issues with the right plurals (Issue #3745)", async () => {
  const cases: Array<
    { name: string; dryRun: boolean; seeded: number; message: string }
  > = [
    {
      name: "real run, none seeded",
      dryRun: false,
      seeded: 0,
      message:
        "Created 7 improvement issues and reused 0 existing issues, routed from stSoftwareAU/VibeCoder",
    },
    {
      name: "real run, one seeded",
      dryRun: false,
      seeded: 1,
      message:
        "Created 6 improvement issues and reused 1 existing issue, routed from stSoftwareAU/VibeCoder",
    },
    {
      name: "real run, six seeded",
      dryRun: false,
      seeded: 6,
      message:
        "Created 1 improvement issue and reused 6 existing issues, routed from stSoftwareAU/VibeCoder",
    },
    {
      name: "dry run, one seeded",
      dryRun: true,
      seeded: 1,
      message:
        "Dry run: 6 improvement issues would be created and 1 existing issue reused, routed from stSoftwareAU/VibeCoder",
    },
    {
      name: "dry run, six seeded",
      dryRun: true,
      seeded: 6,
      message:
        "Dry run: 1 improvement issue would be created and 6 existing issues reused, routed from stSoftwareAU/VibeCoder",
    },
  ];

  for (const c of cases) {
    const store = fakeStore([], { [VIBE]: "WRITE" });
    for (const improvement of generateImprovements().slice(0, c.seeded)) {
      addIssue(store, VIBE, improvement.title);
    }
    const gh = routingFakeGh(store);
    const result = await createSuggestImprovementsCommand({
      ghCommandFn: gh.ghCommandFn,
      now: NOW,
    }).execute({ repo: VIBE, "dry-run": c.dryRun }, createMockConfig());

    assertEquals(result.success, true, c.name);
    assertEquals(result.message, c.message, c.name);
  }
});

// Issue #3745 — config.repos reaches the router as the product repositories.
// A malformed configured repo is how the test proves it: the classifier rejects it.
Deno.test("suggest-improvements - the command routes against the configured repos as product repositories (Issue #3745)", async () => {
  const gh = routingFakeGh(fakeStore([], { [VIBE]: "WRITE" }));
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: NOW,
  }).execute({ repo: VIBE }, createMockConfig({ repos: ["not a repo"] }));

  assertEquals(result.success, false);
  const data = result.data as SuggestImprovementsData;
  const failures = data.failures ?? [];
  assertEquals(failures.length, generateImprovements().length);
  for (const failure of failures) {
    assertStringIncludes(failure.error, 'step "classify"');
    assertStringIncludes(failure.error, "ctx.productRepos[0]");
  }
});

Deno.test("suggest-improvements - the command's injected clock sets the duplicate-search window (Issue #3745)", async () => {
  // Under the injected clock (2020-01-15) a close on 2020-01-01 sits inside the
  // 30-day duplicate window, so the existing issue is reused. On the wall clock
  // (2026) it is far outside the window, so a new issue would be filed instead.
  const title = generateImprovements()[0]!.title;
  const store = fakeStore([], { [VIBE]: "WRITE" });
  const existing = addIssue(store, VIBE, title);
  existing.closedAt = "2020-01-01T00:00:00Z";
  const gh = routingFakeGh(store);
  const result = await createSuggestImprovementsCommand({
    ghCommandFn: gh.ghCommandFn,
    now: () => new Date("2020-01-15T00:00:00Z"),
  }).execute({ repo: VIBE }, createMockConfig());

  const data = result.data as SuggestImprovementsData;
  const routed = (data.routed ?? []).find((r) => r.title === title);
  assertEquals(routed?.action, "reused");
  assertEquals(routed?.number, existing.number);
  assertEquals(
    gh.store.issues.filter((i) => i.title === title).map((i) => i.number),
    [existing.number],
  );
});
