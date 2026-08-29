/**
 * Tests for the best-practices idle-task template (Issue #2148).
 *
 * Coverage:
 *   - registration: the template is registered at module load
 *   - title is the literal "Run a best-practices scan" (used for
 *     dispatch in `idle_task_claim_handler`)
 *   - buildIssueBody picks a bucket, inlines the bucket guide, records
 *     the bucket via `**Bucket:** \`<b>\`` so runTask can recover it,
 *     and leaves no raw `{{...}}` placeholders
 *   - parseBucketFromBody round-trips
 *   - skipMilestone, outputLabel, and the body-fingerprint matcher
 *     report the correct contract
 *   - runTask happy path with language bucket + mixed-severity findings:
 *       linter check passes, Claude scan succeeds, snapshot diff lists
 *       the newly-filed issue numbers
 *   - runTask general bucket: linter check is NOT invoked
 *   - runTask language bucket with missing linter: a synthetic
 *     missing-linter issue is filed first, its finding id flows into
 *     the known-open list passed to the scan runner, and it appears in
 *     the close summary
 *   - runTask dedup: existing open `best-practices` issues with `BP-…`
 *     finding markers are passed to the scan runner so Claude skips
 *     them
 *   - runTask no findings: summary is "no findings"
 *   - runTask refuses without a bucket line
 *   - assembleBestPracticesPrompt substitutes placeholders and inlines
 *     the bucket guide
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleBestPracticesPrompt,
  BEST_PRACTICES_ISSUE_TITLE,
  bucketSlug,
  createBestPracticesTemplate,
  isLanguageBucket,
  parseBucketFromBody,
  renderBestPracticesSummary,
} from "../lib/idle_task_templates/best_practices_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import type {
  BucketPick,
  SupportedLanguage,
} from "../lib/best_practices_bucket_picker.ts";
import type { LinterCheckResult } from "../lib/linter_in_ci_check.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";
import type { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal `RepoLanguages` stub. */
const LANGS_TS: RepoLanguages = {
  detected: [],
  primary: "TypeScript",
  raw: { TypeScript: 10000 },
};

/** Deterministic `BucketPick` stub factory. */
function pickLanguage(language: SupportedLanguage): BucketPick {
  return { kind: "language", language };
}

const PICK_GENERAL: BucketPick = { kind: "general" };

/** Stub bucket-guide content used as the inlined section. */
const STUB_GUIDE = "# Bucket guide stub\n\nChecks for the bucket go here.\n";

/** Stub prompt body containing the four placeholders the template needs. */
const STUB_PROMPT = [
  "# Best-Practices Review — Bucket-Scoped (v4)",
  "",
  "Bucket for this run: `{{BUCKET}}`",
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

/**
 * Run-time scenario shape — wraps a gh stub and (optional) scan stub so
 * each runTask test can declare exactly the gh responses it expects.
 *
 * The gh stub matches against the leading arg tuple and returns the
 * scenario's response. Anything unmatched falls through to a default
 * `"[]"` (empty JSON array) so tests do not need to enumerate every
 * defence-in-depth call.
 */
interface GhCall {
  args: string[];
  response: string;
}

function makeGhStub(scenario: {
  beforeSnapshot?: number[];
  afterSnapshot?: number[];
  knownOpen?: Array<{ number: number; body: string }>;
  issueView?: { number: number; body: string };
  fileMissingLinterReturnsNumber?: number;
}): { gh: (args: string[]) => Promise<string>; calls: GhCall[] } {
  const calls: GhCall[] = [];
  let snapshotCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push({ args: [...args], response: "" });
    // Snapshot calls: `issue list --label best-practices --json number`
    const isSnapshot = args[0] === "issue" && args[1] === "list" &&
      args.includes("--label") &&
      args[args.indexOf("--label") + 1] === "best-practices" &&
      args.includes("--json") &&
      args[args.indexOf("--json") + 1] === "number" &&
      !args.includes("--search");
    if (isSnapshot) {
      snapshotCount += 1;
      const nums = snapshotCount === 1
        ? scenario.beforeSnapshot ?? []
        : scenario.afterSnapshot ?? scenario.beforeSnapshot ?? [];
      return Promise.resolve(
        JSON.stringify(nums.map((n) => ({ number: n }))),
      );
    }
    // Known-open lookup: `issue list --json number,body` — repo-wide since
    // Issue #539, so it carries no `--label` argument.
    const isKnownOpen = args[0] === "issue" && args[1] === "list" &&
      args.includes("--json") &&
      args[args.indexOf("--json") + 1] === "number,body";
    if (isKnownOpen) {
      return Promise.resolve(JSON.stringify(scenario.knownOpen ?? []));
    }
    // Wrapper body lookup: `issue view <n> --json body`
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({ body: scenario.issueView?.body ?? "" }),
      );
    }
    // Missing-linter file: `issue create ... --label best-practices ...`
    if (args[0] === "issue" && args[1] === "create") {
      const n = scenario.fileMissingLinterReturnsNumber ?? 0;
      if (n > 0) {
        return Promise.resolve(
          `https://github.com/org/repo/issues/${n}\n`,
        );
      }
      throw new Error("gh issue create not expected in this scenario");
    }
    // Wrapper-presence search.
    if (
      args[0] === "issue" && args[1] === "list" && args.includes("--search")
    ) {
      return Promise.resolve("[]");
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function stubLinterConfigured(): Promise<LinterCheckResult> {
  return Promise.resolve({
    configured: true,
    linter: "ESLint",
    details: "ESLint configured and invoked in CI.",
  });
}

function stubLinterMissing(): Promise<LinterCheckResult> {
  return Promise.resolve({
    configured: false,
    linter: "ESLint",
    details: "No GitHub Actions workflow invokes ESLint.",
  });
}

/**
 * Stub for a Rust check where only the linter gate is missing — the
 * compile gate (e.g. `cargo check`) is present.
 */
function stubLintMissingCompilePresent(): Promise<LinterCheckResult> {
  return Promise.resolve({
    configured: false,
    linter: "cargo clippy",
    details:
      "Rust CI is missing no linter gate: no `cargo clippy` invocation. " +
      "Without both gates, lint and syntax regressions can land on main " +
      "unnoticed (see issue #2175).",
    gates: { linter: false, compile: true },
  });
}

/**
 * Stub for a Rust check where only the compile gate is missing — the
 * linter gate (`cargo clippy`) is present.
 */
function stubCompileMissingLintPresent(): Promise<LinterCheckResult> {
  return Promise.resolve({
    configured: false,
    linter: "cargo clippy",
    details:
      "Rust CI is missing no compile gate: no compile gate (issue #2175). " +
      "Without both gates, lint and syntax regressions can land on main " +
      "unnoticed (see issue #2175).",
    gates: { linter: true, compile: false },
  });
}

/**
 * Stub for a Rust check where BOTH gates are missing.
 */
function stubBothGatesMissing(): Promise<LinterCheckResult> {
  return Promise.resolve({
    configured: false,
    linter: "cargo clippy",
    details:
      "Rust CI is missing no linter and no compile gate: no `cargo clippy` " +
      "invocation; AND no compile gate (issue #2175). Without both gates, " +
      "lint and syntax regressions can land on main unnoticed (see issue " +
      "#2175).",
    gates: { linter: false, compile: false },
  });
}

/**
 * Stub for the fail-safe case (Issue #2881): zero workflow files loaded.
 * Both gates report `false`, but `workflowsLoaded: false` flags the result
 * as a likely scan glitch so the consumer must not file severity:high.
 */
function stubZeroWorkflowsLoaded(): Promise<LinterCheckResult> {
  return Promise.resolve({
    configured: false,
    linter: "cargo clippy",
    details:
      "No GitHub Actions workflows were found under `.github/workflows/`, " +
      "so the standard Rust linter (cargo clippy) cannot be invoked in CI.",
    gates: { linter: false, compile: false },
    workflowsLoaded: false,
  });
}

/**
 * Pull the `--title` and `--body` values out of a captured
 * `gh issue create` call. Returns `null` when no call matches.
 */
function readIssueCreate(
  calls: GhCall[],
): { title: string; body: string; labels: string[] } | null {
  const call = calls.find((c) =>
    c.args[0] === "issue" && c.args[1] === "create"
  );
  if (!call) return null;
  const args = call.args;
  const titleIdx = args.indexOf("--title");
  const bodyIdx = args.indexOf("--body");
  if (titleIdx < 0 || bodyIdx < 0) return null;
  const labels: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--label") labels.push(args[i + 1] ?? "");
  }
  return {
    title: args[titleIdx + 1] ?? "",
    body: args[bodyIdx + 1] ?? "",
    labels,
  };
}

// ---------------------------------------------------------------------------
// Registration / contract
// ---------------------------------------------------------------------------

Deno.test("best-practices - template is registered at module load", () => {
  const tpl = getTemplate("best-practices");
  assert(tpl !== undefined, "best-practices template must be registered");
  assertEquals(tpl!.name, "best-practices");
  assertEquals(tpl!.skipMilestone, true);
  assertEquals(tpl!.outputLabel, "best-practices");
  assertEquals(tpl!.requiresStructuredOutput, true);
});

Deno.test("best-practices - listTemplates includes best-practices", () => {
  const names = listTemplates().map((t) => t.name);
  assert(names.includes("best-practices"));
});

Deno.test("best-practices - title is the literal static string", () => {
  const tpl = createBestPracticesTemplate();
  assertEquals(tpl.buildIssueTitle("acme/widget"), BEST_PRACTICES_ISSUE_TITLE);
  assertEquals(tpl.buildIssueTitle("other/proj"), BEST_PRACTICES_ISSUE_TITLE);
});

Deno.test(
  "best-practices - matchesIdleTaskBody recognises the prompt heading",
  () => {
    const tpl = createBestPracticesTemplate();
    assert(tpl.matchesIdleTaskBody !== undefined);
    assert(tpl.matchesIdleTaskBody!(
      "# Best-Practices Review — Bucket-Scoped (v1)\n\nbody",
    ));
    assert(!tpl.matchesIdleTaskBody!("# Some unrelated heading"));
  },
);

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

Deno.test("bucketSlug - returns 'general' for the general pick", () => {
  assertEquals(bucketSlug({ kind: "general" }), "general");
});

Deno.test("bucketSlug - returns the language name for a language pick", () => {
  assertEquals(bucketSlug({ kind: "language", language: "rust" }), "rust");
});

Deno.test("parseBucketFromBody - extracts the bucket from a wrapper body", () => {
  const body = "**Bucket:** `rust`\n\n# Best-Practices Review";
  assertEquals(parseBucketFromBody(body), "rust");
});

Deno.test("parseBucketFromBody - hyphenated buckets parse correctly", () => {
  const body = "**Bucket:** `aws-cloudformation`";
  assertEquals(parseBucketFromBody(body), "aws-cloudformation");
});

Deno.test("parseBucketFromBody - returns null when no bucket line", () => {
  assertEquals(parseBucketFromBody("# heading\n\nno bucket here"), null);
});

Deno.test("isLanguageBucket - general is NOT a language bucket", () => {
  assertEquals(isLanguageBucket("general"), false);
});

Deno.test("isLanguageBucket - language buckets are recognised", () => {
  assertEquals(isLanguageBucket("rust"), true);
  assertEquals(isLanguageBucket("typescript"), true);
  assertEquals(isLanguageBucket("react"), true);
  assertEquals(isLanguageBucket("java"), true);
  assertEquals(isLanguageBucket("html"), true);
  assertEquals(isLanguageBucket("aws-cloudformation"), true);
  assertEquals(isLanguageBucket("terraform"), true);
});

Deno.test("isLanguageBucket - github-actions is retired (Issue #2257)", () => {
  // The daily best-practices scan no longer picks the github-actions
  // bucket — the dedicated weekly github-actions-audit template owns it.
  assertEquals(isLanguageBucket("github-actions"), false);
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test(
  "assembleBestPracticesPrompt - substitutes placeholders and inlines the guide",
  () => {
    const out = assembleBestPracticesPrompt(STUB_PROMPT, STUB_GUIDE, {
      bucket: "rust",
      suppressedIds: [],
      knownOpenFindingIds: [],
    });
    assertStringIncludes(out, "**Bucket:** `rust`");
    assertStringIncludes(out, "Bucket for this run: `rust`");
    assertStringIncludes(out, "## Bucket Guide — `rust` (inlined)");
    assertStringIncludes(out, "Bucket guide stub");
    // No raw placeholders survive.
    assertEquals(/\{\{[A-Z_]+\}\}/.test(out), false);
    // Empty id lists render as `(none)`.
    assertStringIncludes(out, "(none)");
  },
);

Deno.test(
  "assembleBestPracticesPrompt - populated id lists join with newlines",
  () => {
    const out = assembleBestPracticesPrompt(STUB_PROMPT, STUB_GUIDE, {
      bucket: "typescript",
      suppressedIds: ["BP-aaa", "BP-bbb"],
      knownOpenFindingIds: ["BP-ccc"],
    });
    assertStringIncludes(out, "BP-aaa\nBP-bbb");
    assertStringIncludes(out, "BP-ccc");
  },
);

Deno.test(
  "assembleBestPracticesPrompt - attribution footer is substituted",
  () => {
    const footer =
      "🏷️ Filed by idle-task template: `best-practices` · Run id: `vibe-bp-test`";
    const out = assembleBestPracticesPrompt(STUB_PROMPT, STUB_GUIDE, {
      bucket: "rust",
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter: footer,
    });
    assert(!out.includes("{{ATTRIBUTION_FOOTER}}"));
    assertStringIncludes(out, footer);
  },
);

// ---------------------------------------------------------------------------
// buildIssueBody
// ---------------------------------------------------------------------------

Deno.test(
  "buildIssueBody - picks a bucket, inlines the guide, and records the bucket line",
  async () => {
    const tpl = createBestPracticesTemplate({
      detectLanguagesFn: () => Promise.resolve({ ok: true, value: LANGS_TS }),
      pickBucketFn: () => pickLanguage("typescript"),
      loadPromptFn: () => Promise.resolve({ ok: true, value: STUB_PROMPT }),
      readBucketGuideFn: () => Promise.resolve(STUB_GUIDE),
    });
    const body = await tpl.buildIssueBody({
      repo: "org/repo",
      pickedAt: "2026-05-22T00:00:00Z",
      workerUser: "vibe-coder-bot",
    });
    assertStringIncludes(body, "**Bucket:** `typescript`");
    assertStringIncludes(body, "Bucket for this run: `typescript`");
    assertStringIncludes(body, "## Bucket Guide — `typescript` (inlined)");
    assertStringIncludes(body, "Bucket guide stub");
    assertEquals(parseBucketFromBody(body), "typescript");
    // No raw `{{...}}` placeholders.
    assertEquals(/\{\{[A-Z_]+\}\}/.test(body), false);
    // Issue #2439 — attribution footer is substituted in the wrapper
    // body so Claude sees the literal footer line every filed finding
    // must end with.
    assertStringIncludes(
      body,
      "🏷️ Filed by idle-task template: `best-practices`",
    );
    assertStringIncludes(body, "Run id:");
  },
);

Deno.test(
  "buildIssueBody - falls back to general when language detection fails",
  async () => {
    const tpl = createBestPracticesTemplate({
      detectLanguagesFn: () =>
        Promise.resolve({ ok: false, error: "no auth" } as Result<
          RepoLanguages,
          string
        >),
      // Picker receives the empty-langs fallback and the test forces general.
      pickBucketFn: () => PICK_GENERAL,
      loadPromptFn: () => Promise.resolve({ ok: true, value: STUB_PROMPT }),
      readBucketGuideFn: () => Promise.resolve(STUB_GUIDE),
    });
    const body = await tpl.buildIssueBody({
      repo: "org/repo",
      pickedAt: "2026-05-22T00:00:00Z",
      workerUser: "vibe-coder-bot",
    });
    assertStringIncludes(body, "**Bucket:** `general`");
  },
);

// ---------------------------------------------------------------------------
// runTask — happy path (language bucket, linter present)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - language bucket with mixed-severity findings lists newly-filed issues",
  async () => {
    const wrapperBody = "**Bucket:** `typescript`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      // Claude (mocked) "files" 3 issues; the snapshot diff picks them
      // up regardless of severity.
      afterSnapshot: [101, 102, 103],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
    });

    let scanReceived:
      | { bucket: string; knownOpen: string[] }
      | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      runScanFn: (opts) => {
        scanReceived = {
          bucket: opts.bucket,
          knownOpen: [...opts.knownOpenFindingIds],
        };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(
      result.summary,
      "Best-practices scan complete (bucket: typescript). Filed 3 issues: " +
        "#101, #102, #103",
    );
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.bucket, "typescript");
    assertEquals(scanReceived!.knownOpen, []);
    // Linter pre-check did not file anything.
    assertEquals(
      calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// runTask — linter pre-check receives the repo checkout path (Issue #2880)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - linter pre-check is given the repo checkout path, not the parent workDir",
  async () => {
    // Regression for the false BP-LINTER-typescript finding: the call
    // site passed the parent `workDir` (which holds the clones) instead
    // of `${workDir}/${repoName}` (the checked-out repo root), so the
    // check read a non-existent `.github/workflows`, loaded zero
    // workflows, and filed a bogus finding.
    const wrapperBody = "**Bucket:** `typescript`\n\n# Best-Practices Review";
    const { gh } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
    });

    let receivedPath: string | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: (repoPath: string) => {
        receivedPath = repoPath;
        return stubLinterConfigured();
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "stSoftwareAU/private-repo-14",
      workDir: "/home/vibe/auto-issue-work",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(receivedPath, "/home/vibe/auto-issue-work/private-repo-14");
  },
);

// ---------------------------------------------------------------------------
// runTask — general bucket skips the linter pre-check
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - general bucket does NOT invoke the linter-in-CI pre-check",
  async () => {
    const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
    const { gh } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
    });

    let linterInvoked = false;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: () => {
        linterInvoked = true;
        return stubLinterMissing();
      },
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(linterInvoked, false);
    assertEquals(result.summary, "no findings");
  },
);

// ---------------------------------------------------------------------------
// runTask — language bucket with missing CI gates pre-files the finding
//
// Issue #2178: the pre-filed missing-CI-gate finding must cover three
// failure modes (linter-only missing, compile-only missing, both
// missing). The id `BP-LINTER-<bucket>` is preserved across all modes
// to keep dedup working against findings filed before the split.
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - lint-only missing: title names lint gate, body cites only the linter",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [200, 201, 202],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 200,
    });

    let scanReceived:
      | { bucket: string; knownOpen: string[] }
      | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubLintMissingCompilePresent,
      runScanFn: (opts) => {
        scanReceived = {
          bucket: opts.bucket,
          knownOpen: [...opts.knownOpenFindingIds],
        };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // The pre-filed stable id is threaded into known-open — single id
    // even though two gates may fail. Counts once toward the 6-cap.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-LINTER-rust"]);
    assertStringIncludes(result.summary, "#200");

    const created = readIssueCreate(calls);
    assert(created !== null, "missing-CI-gate issue must be filed");
    // Title distinguishes the failure mode.
    assertEquals(created!.title, "🟠 Missing CI lint gate for `rust`");
    // Body's "Why this matters" carries the extended details verbatim
    // and names only the missing linter.
    assertStringIncludes(created!.body, "## Why this matters");
    assertStringIncludes(created!.body, "no linter gate");
    assertStringIncludes(created!.body, "cargo clippy");
    assertEquals(created!.body.includes("no compile gate"), false);
    // Suggested fix mentions the linter, not the compile gate.
    assertStringIncludes(created!.body, "## Suggested fix");
    assertStringIncludes(created!.body, "standard linter");
    assertEquals(
      created!.body.includes("cargo check") ||
        created!.body.includes("cargo build"),
      false,
      "compile-only suggestion must not appear when compile gate is present",
    );
    // Labels unchanged from the prior implementation.
    assert(created!.labels.includes("best-practices"));
    assert(created!.labels.includes("lang:rust"));
    assert(created!.labels.includes("severity:high"));
    // Stable id preserved for dedup.
    assertStringIncludes(created!.body, "<!-- finding-id: BP-LINTER-rust -->");
  },
);

Deno.test(
  "runTask - compile-only missing: title names compile/syntax gate, body cites only the compile gate",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [300],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 300,
    });

    let scanReceived: { knownOpen: string[] } | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubCompileMissingLintPresent,
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Single pre-filed id even when only the compile gate is missing.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-LINTER-rust"]);

    const created = readIssueCreate(calls);
    assert(created !== null);
    assertEquals(
      created!.title,
      "🟠 Missing CI compile/syntax gate for `rust`",
    );
    assertStringIncludes(created!.body, "## Why this matters");
    assertStringIncludes(created!.body, "no compile gate");
    // Linter is present, so "no linter gate" must not appear.
    assertEquals(created!.body.includes("no linter gate"), false);
    // Suggested fix lists the accepted compile-gate commands for Rust.
    assertStringIncludes(created!.body, "cargo check --all-targets");
    assertStringIncludes(created!.body, "cargo build");
    // Stable id preserved.
    assertStringIncludes(created!.body, "<!-- finding-id: BP-LINTER-rust -->");
  },
);

Deno.test(
  "runTask - both gates missing: title and body call out lint + compile gates",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [400],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 400,
    });

    let scanReceived: { knownOpen: string[] } | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubBothGatesMissing,
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // Combined-gate finding still counts as a single pre-filed id.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-LINTER-rust"]);

    const created = readIssueCreate(calls);
    assert(created !== null);
    assertEquals(
      created!.title,
      "🟠 Missing CI lint + compile gates for `rust`",
    );
    assertStringIncludes(created!.body, "## Why this matters");
    // Both gates appear in the details.
    assertStringIncludes(created!.body, "no linter and no compile gate");
    // Suggested fix mentions both the linter step AND the compile-gate
    // commands for Rust.
    assertStringIncludes(created!.body, "standard linter");
    assertStringIncludes(created!.body, "cargo check --all-targets");
  },
);

// ---------------------------------------------------------------------------
// Issue #2881 — fail safe on zero workflows loaded
//
// A zero-workflow load is far more likely a scan glitch than a genuine
// absence of CI, so the consumer must NOT file a severity:high
// BP-LINTER-<bucket> finding off the back of it. The scan still proceeds.
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - zero workflows loaded: no severity:high BP-LINTER issue is filed",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      // No fileMissingLinterReturnsNumber: a `gh issue create` here throws,
      // proving the fail-safe path never attempts to file.
    });

    let scanReceived: { knownOpen: string[] } | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubZeroWorkflowsLoaded,
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // No missing-CI-gate issue filed despite `configured: false`.
    assertEquals(readIssueCreate(calls), null);
    // The scan still runs, with no pre-filed id in the known-open list.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, []);
  },
);

Deno.test(
  "runTask - workflows present but gate missing still files severity:high",
  async () => {
    // The genuine case is unchanged: workflows loaded (workflowsLoaded
    // absent/true), a gate truly missing ⇒ still files severity:high.
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [700],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 700,
    });

    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubBothGatesMissing,
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    const created = readIssueCreate(calls);
    assert(created !== null, "missing-gate issue must still be filed");
    assert(created!.labels.includes("severity:high"));
    assertStringIncludes(created!.body, "<!-- finding-id: BP-LINTER-rust -->");
  },
);

Deno.test(
  "runTask - all gates present: no missing-CI-gate issue is filed",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
    });

    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: () =>
        Promise.resolve({
          configured: true,
          linter: "cargo clippy",
          details: "Both gates present.",
          gates: { linter: true, compile: true },
        }),
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(readIssueCreate(calls), null);
  },
);

// Back-compat: a check result without the `gates` field (older
// buckets like `html`) still produces the "lint gate" title.
Deno.test(
  "runTask - check result without `gates` field maps to 'lint gate' title",
  async () => {
    const wrapperBody = "**Bucket:** `html`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [500],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 500,
    });

    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      // stubLinterMissing returns no `gates` field — mirrors the HTML
      // bucket's behaviour in `linter_in_ci_check.ts`.
      checkLinterInCIFn: stubLinterMissing,
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    const created = readIssueCreate(calls);
    assert(created !== null);
    assertEquals(created!.title, "🟠 Missing CI lint gate for `html`");
    assertStringIncludes(created!.body, "<!-- finding-id: BP-LINTER-html -->");
  },
);

// ---------------------------------------------------------------------------
// runTask — pre-file dedup by finding-id (Issue #2882)
//
// The CI-gate pre-filer must not create a second issue when an OPEN issue
// with the same finding-id already exists (the observed BP-LINTER-typescript
// duplicate private-repo-14#2990/#2991). A CLOSED prior issue must not suppress a
// genuine re-file.
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - pre-filer skips when an OPEN issue with the same finding-id exists",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [55],
      afterSnapshot: [55],
      // An open best-practices issue already carries BP-LINTER-rust.
      knownOpen: [{ number: 55, body: "<!-- finding-id: BP-LINTER-rust -->" }],
      issueView: { number: 50, body: wrapperBody },
      // No fileMissingLinterReturnsNumber: a create attempt would throw,
      // proving the pre-filer never reaches `gh issue create`.
    });

    let scanReceived: { knownOpen: string[] } | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubBothGatesMissing,
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    // No second issue is created — the open duplicate suppresses it.
    assertEquals(readIssueCreate(calls), null);
    // The id still flows into the known-open list for Claude.
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-LINTER-rust"]);
  },
);

Deno.test(
  "runTask - pre-filer files when only a CLOSED issue carried the finding-id",
  async () => {
    const wrapperBody = "**Bucket:** `rust`\n\n# Best-Practices Review";
    // A closed prior issue is NOT returned by the open-state look-up, so
    // `knownOpen` is empty and the recurring finding files again.
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [808],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 808,
    });

    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubBothGatesMissing,
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    const created = readIssueCreate(calls);
    assert(created !== null, "a recurring finding must re-file");
    assertStringIncludes(created!.body, "<!-- finding-id: BP-LINTER-rust -->");
    assertStringIncludes(result.summary, "#808");
  },
);

// ---------------------------------------------------------------------------
// runTask — dedup against existing best-practices issues
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - existing open best-practices findings flow into the known-open list",
  async () => {
    const wrapperBody = "**Bucket:** `typescript`\n\n# Best-Practices Review";
    const { gh } = makeGhStub({
      beforeSnapshot: [90],
      afterSnapshot: [90, 91],
      knownOpen: [
        {
          number: 90,
          body:
            "<!-- finding-id: BP-deadbeef0001 -->\n\nExisting finding body.",
        },
      ],
      issueView: { number: 50, body: wrapperBody },
    });

    let scanReceived: { knownOpen: string[] } | undefined;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      runScanFn: (opts) => {
        scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assert(scanReceived !== undefined);
    assertEquals(scanReceived!.knownOpen, ["BP-deadbeef0001"]);
    // The newly-filed issue (#91) appears in the summary; the existing
    // open (#90) does not because the before-snapshot already included
    // it.
    assertStringIncludes(result.summary, "#91");
    assertEquals(result.summary.includes("#90"), false);
  },
);

// ---------------------------------------------------------------------------
// runTask — no findings
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - zero newly-filed issues yields 'no findings' summary",
  async () => {
    const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
    const { gh } = makeGhStub({
      beforeSnapshot: [10, 11],
      afterSnapshot: [10, 11],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
    });

    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(result.ok);
    assertEquals(result.summary, "no findings");
  },
);

// ---------------------------------------------------------------------------
// runTask — refuses when the wrapper body lacks a bucket
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - missing bucket line surfaces a refusal summary",
  async () => {
    const { gh } = makeGhStub({
      beforeSnapshot: [],
      issueView: { number: 50, body: "# wrapper without a bucket" },
    });

    let scanInvoked = false;
    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      runScanFn: () => {
        scanInvoked = true;
        return Promise.resolve({ ok: true, value: true });
      },
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(!result.ok);
    assertStringIncludes(result.summary, "did not declare a bucket");
    assertEquals(scanInvoked, false);
  },
);

// ---------------------------------------------------------------------------
// runTask — scan failure surfaces a structured summary
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - scan failure surfaces a 'best-practices failed' summary",
  async () => {
    const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
    const { gh } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      issueView: { number: 50, body: wrapperBody },
    });

    const tpl = createBestPracticesTemplate({
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      runScanFn: () =>
        Promise.resolve({
          ok: false,
          error: { kind: "timeout", message: "wall clock exceeded" },
        }),
    });

    const result = await tpl.runTask({
      repo: "org/repo",
      workDir: "/tmp/repo",
      idleTaskIssueNumber: 50,
    });

    assert(!result.ok);
    assertStringIncludes(result.summary, "best-practices failed");
    assertStringIncludes(result.summary, "timeout");
    assertStringIncludes(result.summary, "wall clock exceeded");
  },
);

// ---------------------------------------------------------------------------
// renderBestPracticesSummary - pure builder
// ---------------------------------------------------------------------------

Deno.test("renderBestPracticesSummary - zero issues returns 'no findings'", () => {
  assertEquals(renderBestPracticesSummary("rust", []), "no findings");
});

Deno.test("renderBestPracticesSummary - issues sort ascending", () => {
  assertEquals(
    renderBestPracticesSummary("typescript", [202, 200, 201]),
    "Best-practices scan complete (bucket: typescript). Filed 3 issues: " +
      "#200, #201, #202",
  );
});
