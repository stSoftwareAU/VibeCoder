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
 *   - AWS-emulator pre-check (Issue #3368): files BP-AWS-EMULATOR-MISSING
 *     at severity:medium when AWS usage is detected and no workflow runs
 *     Floci; skips filing when there is no AWS usage, the emulator is
 *     configured, no workflow loaded, an existing open issue already
 *     carries the finding id, or a valid `best-practice-ignore` waiver
 *     covers it; a detector throw fails the run without invoking the
 *     scan; BP-LINTER findings remain severity:high; the default
 *     `checkAwsEmulatorFn` runs the real detector against the repo
 *     checkout.
 *   - hasAwsEmulatorWaiver: rejects an evidence path escaping the repo
 *     root or an absolute evidence path, rejects an evidence path that
 *     resolves outside the repo root via a symlink, skips (without
 *     throwing) an evidence path that does not exist on disk, and throws
 *     naming the path when a read fails for a reason other than
 *     NotFound; binds a waiver committed before the tip of a `--depth=1`
 *     clone to its real author via the default `git blame`.
 *   - buildAwsEmulatorFinding: lists at most 50 evidence paths, then a
 *     `… and N more` line.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import {
  assembleBestPracticesPrompt,
  AWS_EMULATOR_FINDING_ID,
  awsEmulatorUpdateMarker,
  BEST_PRACTICES_ISSUE_TITLE,
  type BlameFileFn,
  bucketSlug,
  buildAwsEmulatorFinding,
  createBestPracticesTemplate,
  findEquivalentAwsEmulatorIssue,
  hasAwsEmulatorWaiver,
  isLanguageBucket,
  parseBucketFromBody,
  reconcileAwsEmulatorIssue,
  renderBestPracticesSummary,
} from "../lib/idle_task_templates/best_practices_template.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import { upsertWorkerRecordLine } from "../lib/worker_record_block.ts";
import {
  findOpenIssueByFindingId,
  listKnownOpenFindingIds,
  type OpenIssueTitle,
} from "../lib/idle_task_snapshot.ts";
import type {
  BucketPick,
  SupportedLanguage,
} from "../lib/best_practices_bucket_picker.ts";
import type { LinterCheckResult } from "../lib/linter_in_ci_check.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";
import type { AwsEmulatorCheckResult } from "../lib/aws_emulator_in_ci_check.ts";
import { repoCheckoutPath } from "../lib/repo_checkout_path.ts";
import {
  _resetSuppressionAuthorAllowlist,
  findSuppressions,
  setSuppressionAuthorAllowlist,
} from "../lib/suppression_comments.ts";
import type { Logger, Result } from "../types.ts";

/**
 * The fleet identity the finding-id dedup verifies against (Issue #1243).
 *
 * The stubbed known-open issues are ones the fleet filed, so they are
 * attributed to a fleet login and the templates are handed the same list.
 */
const FLEET_DEDUP_AUTHOR = "vibe-bot";
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

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
  /** The AWS Emulator title lookup (Issue #5112): its rows, or a simulated gh failure. */
  awsEmulatorTitleLookup?: {
    rows?: Array<{
      number: number;
      title: string;
      login: string;
      body?: string;
    }>;
    fail?: boolean;
  };
  /** Comments on the reused AWS Emulator issue (`issue view --json comments`). */
  awsEmulatorComments?: Array<{ body: string }>;
  /** A simulated failure on the reused issue: the comments read, its payload, or the comment post. */
  awsEmulatorCommentFault?: "read" | "no-list" | "post";
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
    // Known-open lookup: `issue list --json number,body,author` — repo-wide
    // since Issue #539, so it carries no `--label` argument, and
    // author-bearing since Issue #1243, because a finding-id marker in a body
    // anybody may write is not evidence the fleet filed the finding.
    const isKnownOpen = args[0] === "issue" && args[1] === "list" &&
      args.includes("--json") &&
      args[args.indexOf("--json") + 1] === "number,body,author";
    if (isKnownOpen) {
      return Promise.resolve(
        JSON.stringify(
          (scenario.knownOpen ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    // Comments on the reused AWS Emulator issue (Issue #5112 reconcile).
    if (
      args[0] === "issue" && args[1] === "view" &&
      args[args.indexOf("--json") + 1] === "comments"
    ) {
      if (scenario.awsEmulatorCommentFault === "read") {
        return Promise.reject(new Error("gh: simulated comments read failure"));
      }
      if (scenario.awsEmulatorCommentFault === "no-list") {
        return Promise.resolve(JSON.stringify({ body: "no comments field" }));
      }
      return Promise.resolve(
        JSON.stringify({ comments: scenario.awsEmulatorComments ?? [] }),
      );
    }
    if (args[0] === "issue" && args[1] === "comment") {
      if (scenario.awsEmulatorCommentFault === "post") {
        return Promise.reject(new Error("gh: simulated comment post failure"));
      }
      return Promise.resolve("");
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
    // AWS Emulator title lookup (Issue #5112): `issue list --search "\"AWS Emulator\" in:title"`.
    if (
      args[0] === "issue" && args[1] === "list" &&
      args[args.indexOf("--search") + 1] === `"AWS Emulator" in:title`
    ) {
      if (scenario.awsEmulatorTitleLookup?.fail) {
        return Promise.reject(
          new Error("gh: simulated AWS Emulator lookup failure"),
        );
      }
      return Promise.resolve(
        JSON.stringify(
          (scenario.awsEmulatorTitleLookup?.rows ?? []).map((r) => ({
            number: r.number,
            title: r.title,
            body: r.body ?? "",
            author: { login: r.login },
          })),
        ),
      );
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

/** No-AWS stub — the default `checkAwsEmulatorFn` for tests not exercising the AWS pre-check. */
function stubNoAws(): Promise<AwsEmulatorCheckResult> {
  return Promise.resolve({
    usesAws: false,
    awsEvidence: [],
    wiring: "missing",
    wiringEvidence: [],
    wiringDiagnostics: [],
    unreadableWorkflows: [],
    workflowsLoaded: true,
  });
}

/** Spy logger collecting `info()` messages in call order. */
function spyLogger(): { logger: Logger; infoMessages: string[] } {
  const infoMessages: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: (message: string) => {
      infoMessages.push(message);
    },
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, infoMessages };
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

Deno.test("bucketSlug - returns 'design' for the design pick (Issue #662)", () => {
  assertEquals(bucketSlug({ kind: "design" }), "design");
});

Deno.test("parseBucketFromBody - recovers the design bucket", () => {
  assertEquals(parseBucketFromBody("**Bucket:** `design`"), "design");
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

Deno.test("isLanguageBucket - design is NOT a language bucket (Issue #662)", () => {
  // Language-agnostic, so a design run has no linter/compile gate to check.
  assertEquals(isLanguageBucket("design"), false);
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
      dedupAuthors: DEDUP_AUTHORS,
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
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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

/** Stub for a TS/React check where only the compile gate is missing. */
function stubTsCompileMissing(linter: string) {
  return (): Promise<LinterCheckResult> =>
    Promise.resolve({
      configured: false,
      linter,
      details: "CI is missing a compile gate (issue #4997 regression stub).",
      gates: { linter: true, compile: false },
    });
}

for (const bucket of ["typescript", "react"]) {
  Deno.test(
    `runTask - #4997 ${bucket} compile gate suggestion uses no shell glob`,
    async () => {
      const wrapperBody =
        `**Bucket:** \`${bucket}\`\n\n# Best-Practices Review`;
      const { gh, calls } = makeGhStub({
        beforeSnapshot: [],
        afterSnapshot: [300],
        knownOpen: [],
        issueView: { number: 50, body: wrapperBody },
        fileMissingLinterReturnsNumber: 300,
      });
      const tpl = createBestPracticesTemplate({
        checkAwsEmulatorFn: stubNoAws,
        dedupAuthors: DEDUP_AUTHORS,
        ghCommandFn: gh,
        checkLinterInCIFn: stubTsCompileMissing("eslint"),
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
      assertStringIncludes(created!.body, "`deno check .`");
      assertStringIncludes(created!.body, "`npx tsc --noEmit`");
      assertEquals(created!.body.includes("**/*"), false);
    },
  );
}

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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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
      checkAwsEmulatorFn: stubNoAws,
      dedupAuthors: DEDUP_AUTHORS,
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

// ---------------------------------------------------------------------------
// Repo-wide open-issue titles (Issue #537)
// ---------------------------------------------------------------------------

/**
 * gh stub for the repo-wide open-issue title lookup — `issue list --json
 * number,title` with neither `--label` nor `--search`. The wrapper-body view
 * still returns a typescript bucket so `runTask` reaches the scan; every
 * other call returns an empty list. `fail` makes the title lookup (and only
 * that lookup) throw.
 */
function makeTitleGhStub(
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
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({
          body: "**Bucket:** `typescript`\n\n# Best-Practices Review",
        }),
      );
    }
    return Promise.resolve("[]");
  };
}

Deno.test("assembleBestPracticesPrompt - open issue titles are substituted", () => {
  const out = assembleBestPracticesPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    STUB_GUIDE,
    {
      bucket: "typescript",
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [{ number: 37, title: "Add a CODEOWNERS file" }],
    },
  );
  assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
  assertStringIncludes(out, "#37 — Add a CODEOWNERS file");
});

Deno.test("assembleBestPracticesPrompt - an empty open-issue list renders (none)", () => {
  const out = assembleBestPracticesPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    STUB_GUIDE,
    {
      bucket: "typescript",
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [],
    },
  );
  assertStringIncludes(out, "Already open:\n(none)");
});

Deno.test("runTask - repo-wide open issue titles reach the scan runner", async () => {
  const seen: OpenIssueTitle[][] = [];
  const tpl = createBestPracticesTemplate({
    checkAwsEmulatorFn: stubNoAws,
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([
      { number: 37, title: "Add a CODEOWNERS file" },
    ]),
    checkLinterInCIFn: stubLinterConfigured,
    runScanFn: (opts) => {
      seen.push(opts.openIssueTitles);
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await tpl.runTask({
    repo: "org/repo",
    workDir: "/tmp/repo",
    idleTaskIssueNumber: 50,
  });

  assert(result.ok);
  assertEquals(seen, [[{ number: 37, title: "Add a CODEOWNERS file" }]]);
});

Deno.test("runTask - a gh failure listing titles degrades to an empty list", async () => {
  const seen: OpenIssueTitle[][] = [];
  const tpl = createBestPracticesTemplate({
    checkAwsEmulatorFn: stubNoAws,
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([], true),
    checkLinterInCIFn: stubLinterConfigured,
    runScanFn: (opts) => {
      seen.push(opts.openIssueTitles);
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await tpl.runTask({
    repo: "org/repo",
    workDir: "/tmp/repo",
    idleTaskIssueNumber: 50,
  });

  // The scan still ran, with the `(none)` sentinel's empty list.
  assert(result.ok);
  assertEquals(seen, [[]]);
});

// ---------------------------------------------------------------------------
// CloudFormation cost pre-scan (Issue #2579)
// ---------------------------------------------------------------------------

Deno.test("assembleBestPracticesPrompt - pre-scan candidates render under their own heading (Issue #2579)", () => {
  const line = "`infra/api.yaml:3` Lambda `ApiFunction` is not on arm64";
  const out = assembleBestPracticesPrompt(STUB_PROMPT, STUB_GUIDE, {
    bucket: "aws-cloudformation",
    suppressedIds: [],
    knownOpenFindingIds: [],
    preScanCandidates: [line],
  });
  assertStringIncludes(out, "## Deterministic pre-scan candidates");
  assertStringIncludes(out, `- ${line}`);
});

Deno.test("assembleBestPracticesPrompt - no candidates, no pre-scan heading (Issue #2579)", () => {
  const out = assembleBestPracticesPrompt(STUB_PROMPT, STUB_GUIDE, {
    bucket: "aws-cloudformation",
    suppressedIds: [],
    knownOpenFindingIds: [],
    preScanCandidates: [],
  });
  assertEquals(out.includes("pre-scan candidates"), false);
});

for (
  const [bucket, expected] of [
    ["aws-cloudformation", ["cand"]],
    ["typescript", []],
  ] as const
) {
  Deno.test(
    `runTask - ${bucket} run ${
      expected.length ? "passes" : "skips"
    } the CloudFormation cost pre-scan (Issue #2579)`,
    async () => {
      const { gh } = makeGhStub({
        beforeSnapshot: [],
        afterSnapshot: [],
        knownOpen: [],
        issueView: {
          number: 50,
          body: `**Bucket:** \`${bucket}\`\n\n# Best-Practices Review`,
        },
      });
      const scannedPaths: string[] = [];
      let received: readonly string[] | undefined;
      const tpl = createBestPracticesTemplate({
        checkAwsEmulatorFn: stubNoAws,
        dedupAuthors: DEDUP_AUTHORS,
        ghCommandFn: gh,
        checkLinterInCIFn: stubLinterConfigured,
        scanCfnCostFn: (path) => {
          scannedPaths.push(path);
          return Promise.resolve(["cand"]);
        },
        runScanFn: (opts) => {
          received = opts.preScanCandidates ?? [];
          return Promise.resolve({ ok: true, value: true });
        },
      });
      const result = await tpl.runTask({
        repo: "org/repo",
        workDir: "/tmp/work",
        idleTaskIssueNumber: 50,
      });
      assert(result.ok);
      assertEquals(received, [...expected]);
      assertEquals(scannedPaths, expected.length ? ["/tmp/work/repo"] : []);
    },
  );
}

// ---------------------------------------------------------------------------
// AWS-emulator pre-check (Issue #3368)
// ---------------------------------------------------------------------------

function stubAwsNoFloci(
  evidence: readonly string[] = ["infra/template.yaml", "Cargo.toml"],
): Promise<AwsEmulatorCheckResult> {
  return Promise.resolve({
    usesAws: true,
    awsEvidence: [...evidence],
    wiring: "missing",
    wiringEvidence: [],
    wiringDiagnostics: [],
    unreadableWorkflows: [],
    workflowsLoaded: true,
  });
}

Deno.test(
  "runTask - AWS repo with no Floci files BP-AWS-EMULATOR-MISSING at severity:medium",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
      const { gh, calls } = makeGhStub({
        beforeSnapshot: [],
        afterSnapshot: [900],
        knownOpen: [],
        issueView: { number: 50, body: wrapperBody },
        fileMissingLinterReturnsNumber: 900,
      });

      let scanReceived: { knownOpen: string[] } | undefined;
      const tpl = createBestPracticesTemplate({
        dedupAuthors: DEDUP_AUTHORS,
        ghCommandFn: gh,
        checkLinterInCIFn: stubLinterConfigured,
        checkAwsEmulatorFn: () =>
          stubAwsNoFloci(["infra/template.yaml", "Cargo.toml"]),
        runScanFn: (opts) => {
          scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
          return Promise.resolve({ ok: true, value: true });
        },
      });

      const result = await tpl.runTask({
        repo: "org/repo",
        workDir,
        idleTaskIssueNumber: 50,
      });

      assert(result.ok);
      const createCalls = calls.filter((c) =>
        c.args[0] === "issue" && c.args[1] === "create"
      );
      assertEquals(createCalls.length, 1);

      const created = readIssueCreate(calls);
      assert(created !== null);
      assert(created!.labels.includes("best-practices"));
      assert(created!.labels.includes("lang:general"));
      assert(created!.labels.includes("severity:medium"));
      assertEquals(created!.labels.includes("severity:high"), false);

      assertStringIncludes(
        created!.body,
        `<!-- finding-id: ${AWS_EMULATOR_FINDING_ID} -->`,
      );
      assertStringIncludes(created!.body, "**Severity:** medium");
      assertStringIncludes(created!.body, "## Why this matters");
      assertStringIncludes(created!.body, "## Suggested fix");
      assertStringIncludes(created!.body, "infra/template.yaml");
      assertStringIncludes(created!.body, "Cargo.toml");
      // Issue #5112: the suggested fix names the AWS Emulator wiring and
      // no longer carries the Floci-as-default, stub-pass or Docker guidance.
      assertStringIncludes(
        created!.body,
        "`aws-emulator-run [--timeout N] -- <test command>`",
      );
      assert(!created!.body.includes("::warning::"));
      assert(!created!.body.includes("SKIPPED (needs Docker)"));
      assert(!/floci\/floci@sha256:/.test(created!.body));

      assert(scanReceived !== undefined);
      assert(scanReceived!.knownOpen.includes(AWS_EMULATOR_FINDING_ID));
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "runTask - AWS finding already open under its finding-id is not re-filed",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
      const { gh, calls } = makeGhStub({
        beforeSnapshot: [55],
        afterSnapshot: [55],
        knownOpen: [
          {
            number: 55,
            body: `<!-- finding-id: ${AWS_EMULATOR_FINDING_ID} -->`,
          },
        ],
        issueView: { number: 50, body: wrapperBody },
        // No fileMissingLinterReturnsNumber: a create attempt would throw,
        // proving the pre-filer never reaches `gh issue create`.
      });

      let scanReceived: { knownOpen: string[] } | undefined;
      const tpl = createBestPracticesTemplate({
        dedupAuthors: DEDUP_AUTHORS,
        ghCommandFn: gh,
        checkLinterInCIFn: stubLinterConfigured,
        checkAwsEmulatorFn: () => stubAwsNoFloci(),
        runScanFn: (opts) => {
          scanReceived = { knownOpen: [...opts.knownOpenFindingIds] };
          return Promise.resolve({ ok: true, value: true });
        },
      });

      const result = await tpl.runTask({
        repo: "org/repo",
        workDir,
        idleTaskIssueNumber: 50,
      });

      assert(result.ok);
      assertEquals(readIssueCreate(calls), null);
      assert(scanReceived !== undefined);
      assertEquals(scanReceived!.knownOpen, [AWS_EMULATOR_FINDING_ID]);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "runTask - AWS-emulator pre-check skips filing and logs why (static wiring / unreadable workflow / no AWS / no workflow)",
  async () => {
    const scenarios: Array<
      [string, () => Promise<AwsEmulatorCheckResult>, string]
    > = [
      [
        "floci gap recorded",
        () =>
          Promise.resolve({
            usesAws: true,
            awsEvidence: ["Cargo.toml"],
            wiring: "floci-gap",
            wiringEvidence: [
              "`ci.yml`: `# aws-emulator-gap: version=2.1.0; behaviour=x; evidence=y; alternative=z; recheck=2027-01-01`",
            ],
            wiringDiagnostics: [],
            unreadableWorkflows: [],
            workflowsLoaded: true,
          }),
        "floci-gap wiring (static wiring evidence; no CI result observed)",
      ],
      [
        "official server wiring",
        () =>
          Promise.resolve({
            usesAws: true,
            awsEvidence: ["infra/template.yaml"],
            wiring: "official-server",
            wiringEvidence: [
              "`aws-emulator.yml` job `test`: `aws-emulator-run -- ./t.sh`",
            ],
            wiringDiagnostics: [],
            unreadableWorkflows: [],
            workflowsLoaded: true,
          }),
        "official-server wiring",
      ],
      [
        "official embedded wiring",
        () =>
          Promise.resolve({
            usesAws: true,
            awsEvidence: ["Cargo.toml"],
            wiring: "official-embedded",
            wiringEvidence: ["`ci.yml` job `rust`: `cargo test`"],
            wiringDiagnostics: [],
            unreadableWorkflows: [],
            workflowsLoaded: true,
          }),
        "official-embedded wiring",
      ],
      [
        "unreadable workflow",
        () =>
          Promise.resolve({
            usesAws: true,
            awsEvidence: ["Cargo.toml"],
            wiring: "missing",
            wiringEvidence: [],
            wiringDiagnostics: [],
            unreadableWorkflows: ["broken.yml"],
            workflowsLoaded: true,
          }),
        "unreadable workflow(s) broken.yml",
      ],
      ["no AWS usage", stubNoAws, "no AWS"],
      [
        "no workflow loaded",
        () =>
          Promise.resolve({
            usesAws: true,
            awsEvidence: ["Cargo.toml"],
            wiring: "missing",
            wiringEvidence: [],
            wiringDiagnostics: [],
            unreadableWorkflows: [],
            workflowsLoaded: false,
          }),
        "no workflow",
      ],
    ];

    for (const [_label, checkFn, expectedSubstring] of scenarios) {
      const workDir = await Deno.makeTempDir();
      try {
        const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
        const { gh, calls } = makeGhStub({
          beforeSnapshot: [],
          afterSnapshot: [],
          knownOpen: [],
          issueView: { number: 50, body: wrapperBody },
        });
        const { logger, infoMessages } = spyLogger();

        const tpl = createBestPracticesTemplate({
          dedupAuthors: DEDUP_AUTHORS,
          ghCommandFn: gh,
          checkLinterInCIFn: stubLinterConfigured,
          checkAwsEmulatorFn: checkFn,
          logger,
          runScanFn: () => Promise.resolve({ ok: true, value: true }),
        });

        const result = await tpl.runTask({
          repo: "org/repo",
          workDir,
          idleTaskIssueNumber: 50,
        });

        assert(result.ok);
        assertEquals(readIssueCreate(calls), null);
        assert(
          infoMessages.some((m) => m.includes(expectedSubstring)),
          `expected an info message containing "${expectedSubstring}", got: ${
            infoMessages.join(" | ")
          }`,
        );
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    }
  },
);

// ---------------------------------------------------------------------------
// AWS-emulator waiver (Issue #3368)
// ---------------------------------------------------------------------------

async function withAwsWaiverGovernance<T>(fn: () => Promise<T>): Promise<T> {
  setSuppressionAuthorAllowlist(["nigel"]);
  try {
    return await fn();
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
}

/**
 * Stub {@link BlameFileFn} binding a marker's commit identity without a
 * real git checkout (Issue #269) — mirrors how production blames each
 * waiver candidate file. Only `file` blames as `login`; every other
 * candidate blames empty, so a waiver on the wrong file still fails
 * closed (no process-wide commit-author fallback is configured in these
 * tests any more).
 */
function stubBlame(file: string, line: number, login: string): BlameFileFn {
  return (_repoPath, candidateFile) =>
    Promise.resolve(candidateFile === file ? { [line]: login } : {});
}

/**
 * The governance rejection reason recorded for the AWS-emulator marker in
 * `text`, bound to the same blamed identity the template run used — so a
 * test can pin *which* gate rejected it, not merely that it was rejected.
 */
async function awsMarkerRejection(
  text: string,
  file: string,
  blameFileFn: BlameFileFn,
): Promise<string | undefined> {
  const lineAuthors = await blameFileFn("unused", file);
  const marker = findSuppressions(text, "sh", { file, lineAuthors }).find(
    (s) => s.id === AWS_EMULATOR_FINDING_ID,
  );
  assert(marker, "expected an AWS-emulator marker to be parsed");
  assertEquals(marker.valid, false);
  return marker.invalidReason;
}

Deno.test(
  "runTask - a valid unexpired waiver marker in a workflow suppresses the AWS finding",
  async () => {
    await withAwsWaiverGovernance(async () => {
      const workDir = await Deno.makeTempDir();
      try {
        await Deno.mkdir(`${workDir}/repo/.github/workflows`, {
          recursive: true,
        });
        await Deno.writeTextFile(
          `${workDir}/repo/.github/workflows/ci.yml`,
          [
            "name: ci",
            "on: pull_request",
            "jobs: {}",
            "# best-practice-ignore: BP-AWS-EMULATOR-MISSING — " +
            "author=nigel expires=2099-12-31 emulator runs in a separate repo",
            "",
          ].join("\n"),
        );

        const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
        const { gh, calls } = makeGhStub({
          beforeSnapshot: [],
          afterSnapshot: [],
          knownOpen: [],
          issueView: { number: 50, body: wrapperBody },
        });
        const { logger, infoMessages } = spyLogger();

        const tpl = createBestPracticesTemplate({
          dedupAuthors: DEDUP_AUTHORS,
          ghCommandFn: gh,
          checkLinterInCIFn: stubLinterConfigured,
          checkAwsEmulatorFn: () => stubAwsNoFloci(["Cargo.toml"]),
          blameFileFn: stubBlame(
            ".github/workflows/ci.yml",
            4,
            "nigel",
          ),
          logger,
          runScanFn: () => Promise.resolve({ ok: true, value: true }),
        });

        const result = await tpl.runTask({
          repo: "org/repo",
          workDir,
          idleTaskIssueNumber: 50,
        });

        assert(result.ok);
        assertEquals(readIssueCreate(calls), null);
        assert(infoMessages.some((m) => m.includes("waived")));
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    });
  },
);

Deno.test(
  "runTask - an expired waiver marker does not suppress: exactly one issue is filed",
  async () => {
    await withAwsWaiverGovernance(async () => {
      const workDir = await Deno.makeTempDir();
      try {
        await Deno.mkdir(`${workDir}/repo/.github/workflows`, {
          recursive: true,
        });
        const ciText = [
          "name: ci",
          "on: pull_request",
          "jobs: {}",
          "# best-practice-ignore: BP-AWS-EMULATOR-MISSING — " +
          "author=nigel expires=2020-01-01 emulator runs in a separate repo",
          "",
        ].join("\n");
        await Deno.writeTextFile(
          `${workDir}/repo/.github/workflows/ci.yml`,
          ciText,
        );
        // Bind a valid identity so the gate under test is the only one
        // that can reject the marker.
        const blame = stubBlame(".github/workflows/ci.yml", 4, "nigel");

        const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
        const { gh, calls } = makeGhStub({
          beforeSnapshot: [],
          afterSnapshot: [901],
          knownOpen: [],
          issueView: { number: 50, body: wrapperBody },
          fileMissingLinterReturnsNumber: 901,
        });

        const tpl = createBestPracticesTemplate({
          dedupAuthors: DEDUP_AUTHORS,
          ghCommandFn: gh,
          checkLinterInCIFn: stubLinterConfigured,
          checkAwsEmulatorFn: () => stubAwsNoFloci(["Cargo.toml"]),
          blameFileFn: blame,
          runScanFn: () => Promise.resolve({ ok: true, value: true }),
        });

        const result = await tpl.runTask({
          repo: "org/repo",
          workDir,
          idleTaskIssueNumber: 50,
        });

        assert(result.ok);
        const createCalls = calls.filter((c) =>
          c.args[0] === "issue" && c.args[1] === "create"
        );
        assertEquals(createCalls.length, 1);
        assert(
          (await awsMarkerRejection(ciText, ".github/workflows/ci.yml", blame))
            ?.startsWith("expired on"),
          "the marker must be rejected for its expiry, not its identity",
        );
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    });
  },
);

Deno.test(
  "runTask - a waiver marker missing author= does not suppress: one issue is filed",
  async () => {
    await withAwsWaiverGovernance(async () => {
      const workDir = await Deno.makeTempDir();
      try {
        await Deno.mkdir(`${workDir}/repo/.github/workflows`, {
          recursive: true,
        });
        const ciText = [
          "name: ci",
          "on: pull_request",
          "jobs: {}",
          "# best-practice-ignore: BP-AWS-EMULATOR-MISSING — " +
          "expires=2099-12-31 emulator runs in a separate repo",
          "",
        ].join("\n");
        await Deno.writeTextFile(
          `${workDir}/repo/.github/workflows/ci.yml`,
          ciText,
        );
        // Bind a valid identity so the gate under test is the only one
        // that can reject the marker.
        const blame = stubBlame(".github/workflows/ci.yml", 4, "nigel");

        const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
        const { gh, calls } = makeGhStub({
          beforeSnapshot: [],
          afterSnapshot: [902],
          knownOpen: [],
          issueView: { number: 50, body: wrapperBody },
          fileMissingLinterReturnsNumber: 902,
        });

        const tpl = createBestPracticesTemplate({
          dedupAuthors: DEDUP_AUTHORS,
          ghCommandFn: gh,
          checkLinterInCIFn: stubLinterConfigured,
          checkAwsEmulatorFn: () => stubAwsNoFloci(["Cargo.toml"]),
          blameFileFn: blame,
          runScanFn: () => Promise.resolve({ ok: true, value: true }),
        });

        const result = await tpl.runTask({
          repo: "org/repo",
          workDir,
          idleTaskIssueNumber: 50,
        });

        assert(result.ok);
        const createCalls = calls.filter((c) =>
          c.args[0] === "issue" && c.args[1] === "create"
        );
        assertEquals(createCalls.length, 1);
        assert(
          (await awsMarkerRejection(ciText, ".github/workflows/ci.yml", blame))
            ?.startsWith("missing author"),
          "the marker must be rejected for its missing author",
        );
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    });
  },
);

Deno.test(
  "runTask - a valid waiver marker in an evidence file suppresses the AWS finding",
  async () => {
    await withAwsWaiverGovernance(async () => {
      const workDir = await Deno.makeTempDir();
      try {
        await Deno.mkdir(`${workDir}/repo`, { recursive: true });
        await Deno.writeTextFile(
          `${workDir}/repo/main.tf`,
          [
            'resource "aws_s3_bucket" "example" {}',
            "# best-practice-ignore: BP-AWS-EMULATOR-MISSING — " +
            "author=nigel expires=2099-12-31 emulator runs in a separate repo",
            "",
          ].join("\n"),
        );

        const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
        const { gh, calls } = makeGhStub({
          beforeSnapshot: [],
          afterSnapshot: [],
          knownOpen: [],
          issueView: { number: 50, body: wrapperBody },
        });

        const tpl = createBestPracticesTemplate({
          dedupAuthors: DEDUP_AUTHORS,
          ghCommandFn: gh,
          checkLinterInCIFn: stubLinterConfigured,
          checkAwsEmulatorFn: () => stubAwsNoFloci(["main.tf"]),
          blameFileFn: stubBlame("main.tf", 2, "nigel"),
          runScanFn: () => Promise.resolve({ ok: true, value: true }),
        });

        const result = await tpl.runTask({
          repo: "org/repo",
          workDir,
          idleTaskIssueNumber: 50,
        });

        assert(result.ok);
        assertEquals(readIssueCreate(calls), null);
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    });
  },
);

Deno.test(
  "runTask - a detector throw fails the run without invoking the scan",
  async () => {
    const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
    });

    let scanInvoked = false;
    const tpl = createBestPracticesTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      checkAwsEmulatorFn: () => Promise.reject(new Error("boom")),
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
    assertStringIncludes(result.summary, "boom");
    assertEquals(scanInvoked, false);
    assertEquals(
      calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
      false,
    );
  },
);

Deno.test(
  "runTask - BP-LINTER missing-linter finding remains severity:high, not severity:medium",
  async () => {
    const wrapperBody = "**Bucket:** `typescript`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [600],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 600,
    });

    const tpl = createBestPracticesTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterMissing,
      checkAwsEmulatorFn: stubNoAws,
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
    assert(created!.labels.includes("severity:high"));
    assertEquals(created!.labels.includes("severity:medium"), false);
    assertStringIncludes(
      created!.body,
      "<!-- finding-id: BP-LINTER-typescript -->",
    );
  },
);

// ---------------------------------------------------------------------------
// hasAwsEmulatorWaiver (Issue #3368)
// ---------------------------------------------------------------------------

async function gitAs(
  cwd: string,
  args: string[],
  login: string,
): Promise<void> {
  const email = `${login}@users.noreply.github.com`;
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: login,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: login,
      GIT_COMMITTER_EMAIL: email,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).output();
  assertEquals(
    out.code,
    0,
    `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
  );
}

Deno.test(
  "hasAwsEmulatorWaiver - a waiver committed before the tip of a --depth=1 clone is bound to its real author",
  async () => {
    await withAwsWaiverGovernance(async () => {
      const tmp = await Deno.makeTempDir();
      try {
        const origin = `${tmp}/origin`;
        const clone = `${tmp}/clone`;
        const ci = ".github/workflows/ci.yml";
        await Deno.mkdir(`${origin}/.github/workflows`, { recursive: true });
        await gitAs(origin, ["init", "-q", "-b", "main"], "nigel");
        const marker = "# best-practice-ignore: BP-AWS-EMULATOR-MISSING — " +
          "author=nigel expires=2099-12-31 emulator runs in a separate repo";
        await Deno.writeTextFile(
          `${origin}/${ci}`,
          ["name: ci", "on: pull_request", "jobs: {}", marker, ""].join("\n"),
        );
        await gitAs(origin, ["add", ci], "nigel");
        await gitAs(origin, ["commit", "-q", "-m", "waiver"], "nigel");
        // A later commit by someone else makes it the shallow boundary.
        await Deno.writeTextFile(`${origin}/README.md`, "hello\n");
        await gitAs(origin, ["add", "README.md"], "mallory");
        await gitAs(origin, ["commit", "-q", "-m", "readme"], "mallory");
        await gitAs(
          tmp,
          ["clone", "-q", "--depth=1", `file://${origin}`, clone],
          "nigel",
        );

        // Default blameFileFn — real `git blame` on the shallow clone.
        assertEquals(await hasAwsEmulatorWaiver(clone, []), true);
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    });
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - an evidence path escaping the repo root rejects",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await assertRejects(
        () => hasAwsEmulatorWaiver(workDir, ["../outside.tf"]),
        Error,
        "../outside.tf",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - a non-existent evidence path is skipped, not thrown",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      const result = await hasAwsEmulatorWaiver(workDir, ["nope.tf"]);
      assertEquals(result, false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - an absolute evidence path rejects",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await assertRejects(
        () => hasAwsEmulatorWaiver(workDir, ["/etc/passwd"]),
        Error,
        "is absolute",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - an unreadable evidence path other than NotFound throws naming the path",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/infra.tf`);
      await assertRejects(
        () => hasAwsEmulatorWaiver(workDir, ["infra.tf"]),
        Error,
        "cannot read AWS-evidence file infra.tf",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - an evidence symlink pointing outside the repo rejects",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const repoPath = `${tmp}/repo`;
      const outsidePath = `${tmp}/outside`;
      await Deno.mkdir(repoPath);
      await Deno.mkdir(outsidePath);
      await Deno.writeTextFile(
        `${outsidePath}/secret.tf`,
        "# best-practice-ignore: BP-AWS-EMULATOR-MISSING\n",
      );
      await Deno.symlink(
        "../outside/secret.tf",
        `${repoPath}/infra.tf`,
      );
      await assertRejects(
        () => hasAwsEmulatorWaiver(repoPath, ["infra.tf"]),
        Error,
        "resolves outside the repo root",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - an evidence path through a symlinked directory pointing outside rejects",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const repoPath = `${tmp}/repo`;
      const outsidePath = `${tmp}/outside`;
      await Deno.mkdir(repoPath);
      await Deno.mkdir(outsidePath);
      await Deno.writeTextFile(`${outsidePath}/main.tf`, "");
      await Deno.symlink("../outside", `${repoPath}/link`, {
        type: "dir",
      });
      await assertRejects(
        () => hasAwsEmulatorWaiver(repoPath, ["link/main.tf"]),
        Error,
        "resolves outside the repo root",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - '..' after a missing component landing on an outward symlink rejects",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const repoPath = `${tmp}/repo`;
      const outsidePath = `${tmp}/outside`;
      await Deno.mkdir(repoPath);
      await Deno.mkdir(outsidePath);
      await Deno.writeTextFile(`${outsidePath}/main.tf`, "");
      await Deno.symlink("../outside", `${repoPath}/link`, {
        type: "dir",
      });
      await assertRejects(
        () => hasAwsEmulatorWaiver(repoPath, ["missing/../link/main.tf"]),
        Error,
        "escapes the repo root",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hasAwsEmulatorWaiver - a symlink to a file inside the repo is read",
  async () => {
    const tmp = await Deno.makeTempDir();
    try {
      const repoPath = `${tmp}/repo`;
      await Deno.mkdir(repoPath);
      await Deno.writeTextFile(`${repoPath}/real.tf`, "");
      await Deno.symlink("real.tf", `${repoPath}/alias.tf`);
      const result = await hasAwsEmulatorWaiver(repoPath, ["alias.tf"]);
      assertEquals(result, false);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// buildAwsEmulatorFinding (Issue #3368)
// ---------------------------------------------------------------------------

Deno.test(
  "buildAwsEmulatorFinding - lists 50 evidence paths then '… and N more'",
  () => {
    const awsEvidence = Array.from(
      { length: 52 },
      (_, i) => `a${i}.tf`,
    );
    const finding = buildAwsEmulatorFinding({
      usesAws: true,
      awsEvidence,
      wiring: "missing",
      wiringEvidence: [],
      wiringDiagnostics: [],
      unreadableWorkflows: [],
      workflowsLoaded: true,
    });
    assertStringIncludes(finding.body, "`a49.tf`");
    assert(!finding.body.includes("`a50.tf`"));
    assertStringIncludes(finding.body, "- … and 2 more");
  },
);

Deno.test(
  "buildAwsEmulatorFinding - an HTML comment in a diagnostic or path never becomes a second finding-id marker",
  async () => {
    const planted = "<!-- finding-id: BP-OTHER-FINDING -->";
    const finding = buildAwsEmulatorFinding({
      usesAws: true,
      awsEvidence: [`infra/${planted}.tf`],
      wiring: "missing",
      wiringEvidence: [],
      wiringDiagnostics: [`\`ci.yml\` job \`test\` runs echo ${planted}`],
      unreadableWorkflows: [],
      workflowsLoaded: true,
    });
    // The body still names the planted text, but inert.
    assertStringIncludes(finding.body, "finding-id: BP-OTHER-FINDING");
    assertEquals(finding.body.split("<!--").length - 1, 1);
    const gh = (args: string[]) =>
      Promise.resolve(
        args[0] === "issue" && args[1] === "list"
          ? JSON.stringify([{
            number: 7,
            body: finding.body,
            author: { login: FLEET_DEDUP_AUTHOR },
          }])
          : "[]",
      );
    assertEquals(
      await listKnownOpenFindingIds(
        "org/repo",
        "aws",
        gh,
        "BP-",
        DEDUP_AUTHORS,
      ),
      [AWS_EMULATOR_FINDING_ID],
    );
    assertEquals(
      await findOpenIssueByFindingId(
        "org/repo",
        "aws",
        "BP-OTHER-FINDING",
        gh,
        DEDUP_AUTHORS,
      ),
      null,
    );
    assertEquals(
      await findOpenIssueByFindingId(
        "org/repo",
        "aws",
        AWS_EMULATOR_FINDING_ID,
        gh,
        DEDUP_AUTHORS,
      ),
      7,
    );
  },
);

Deno.test(
  "buildAwsEmulatorFinding - exactly 50 evidence paths has no '… and more' line",
  () => {
    const awsEvidence = Array.from(
      { length: 50 },
      (_, i) => `a${i}.tf`,
    );
    const finding = buildAwsEmulatorFinding({
      usesAws: true,
      awsEvidence,
      wiring: "missing",
      wiringEvidence: [],
      wiringDiagnostics: [],
      unreadableWorkflows: [],
      workflowsLoaded: true,
    });
    assert(!/- … and \d+ more/.test(finding.body));
  },
);

Deno.test(
  "runTask - the default checkAwsEmulatorFn runs the real detector against the repo checkout",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      const repo = "org/repo";
      const repoPath = repoCheckoutPath(workDir, repo);
      await Deno.mkdir(`${repoPath}/.github/workflows`, { recursive: true });
      await Deno.writeTextFile(
        `${repoPath}/Cargo.toml`,
        '[dependencies]\naws-sdk-s3 = "1"\n',
      );
      await Deno.writeTextFile(
        `${repoPath}/.github/workflows/ci.yml`,
        "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n" +
          "    steps:\n      - run: echo hi\n",
      );

      const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
      const { gh, calls } = makeGhStub({
        beforeSnapshot: [],
        afterSnapshot: [900],
        knownOpen: [],
        issueView: { number: 50, body: wrapperBody },
        fileMissingLinterReturnsNumber: 900,
      });

      const tpl = createBestPracticesTemplate({
        dedupAuthors: DEDUP_AUTHORS,
        ghCommandFn: gh,
        checkLinterInCIFn: stubLinterConfigured,
        runScanFn: () => Promise.resolve({ ok: true, value: true }),
      });

      const result = await tpl.runTask({
        repo,
        workDir,
        idleTaskIssueNumber: 50,
      });

      assert(result.ok);
      const createCalls = calls.filter((c) =>
        c.args[0] === "issue" && c.args[1] === "create"
      );
      assertEquals(createCalls.length, 1);

      const created = readIssueCreate(calls);
      assert(created !== null);
      assert(created!.labels.includes("severity:medium"));
      assertStringIncludes(
        created!.body,
        `<!-- finding-id: ${AWS_EMULATOR_FINDING_ID} -->`,
      );
      assertStringIncludes(created!.body, "Cargo.toml");
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// AWS Emulator wiring migration (Issue #5112)
// ---------------------------------------------------------------------------

/**
 * Run the AWS pre-filer once with a fixed check result and an optional AWS
 * Emulator title lookup. Returns the run outcome, every gh call and the info
 * log lines.
 */
async function runAwsPreFiler(
  check: AwsEmulatorCheckResult,
  titleLookup?: {
    rows?: Array<{
      number: number;
      title: string;
      login: string;
      body?: string;
    }>;
    fail?: boolean;
  },
  awsEmulatorComments?: Array<{ body: string }>,
  awsEmulatorCommentFault?: "read" | "no-list" | "post",
): Promise<{ ok: boolean; calls: GhCall[]; infoMessages: string[] }> {
  const workDir = await Deno.makeTempDir();
  try {
    const wrapperBody = "**Bucket:** `general`\n\n# Best-Practices Review";
    const { gh, calls } = makeGhStub({
      beforeSnapshot: [],
      afterSnapshot: [900],
      knownOpen: [],
      issueView: { number: 50, body: wrapperBody },
      fileMissingLinterReturnsNumber: 900,
      awsEmulatorTitleLookup: titleLookup,
      awsEmulatorComments,
      awsEmulatorCommentFault,
    });
    const { logger, infoMessages } = spyLogger();
    const tpl = createBestPracticesTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      checkLinterInCIFn: stubLinterConfigured,
      checkAwsEmulatorFn: () => Promise.resolve(check),
      logger,
      runScanFn: () => Promise.resolve({ ok: true, value: true }),
    });
    const result = await tpl.runTask({
      repo: "org/repo",
      workDir,
      idleTaskIssueNumber: 50,
    });
    return { ok: result.ok, calls, infoMessages };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/** A check result for a repo with AWS usage and the given wiring. */
function awsCheck(
  wiring: AwsEmulatorCheckResult["wiring"],
  wiringDiagnostics: string[] = [],
): AwsEmulatorCheckResult {
  return {
    usesAws: true,
    awsEvidence: ["infra/template.yaml"],
    wiring,
    wiringEvidence: [],
    wiringDiagnostics,
    unreadableWorkflows: [],
    workflowsLoaded: true,
  };
}

/** Count the `issue create` calls in a gh call log. */
function createCount(calls: GhCall[]): number {
  return calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create")
    .length;
}

Deno.test(
  "runTask - floci-only files ONE finding with the migration title and no Floci-default, docker.sock or stub-pass text",
  async () => {
    const run = await runAwsPreFiler(
      awsCheck("floci-only", ["`ci.yml` job `test` runs floci/floci"]),
    );
    assert(run.ok);
    assertEquals(createCount(run.calls), 1);
    const created = readIssueCreate(run.calls);
    assert(created !== null);
    assertEquals(
      created!.title,
      "🟡 Migrate Floci-only AWS tests to AWS Emulator",
    );
    assert(created!.labels.includes("severity:medium"));
    for (
      const banned of [
        "docker.sock",
        "::warning::",
        "ALLOW_STUB",
        "FLOCI_SERVICES",
        "SKIPPED (needs Docker)",
        "one test per AWS service",
        "Run `floci/floci@sha256",
        "start `floci`",
      ]
    ) {
      assert(
        !created!.body.includes(banned),
        `body must not contain ${banned}`,
      );
    }
  },
);

Deno.test(
  "runTask - missing wiring files the no-test-wiring title, not the Floci migration title",
  async () => {
    const run = await runAwsPreFiler(awsCheck("missing"));
    assert(run.ok);
    assertEquals(createCount(run.calls), 1);
    assertEquals(
      readIssueCreate(run.calls)!.title,
      "🟡 No AWS Emulator test wiring in CI",
    );
  },
);

Deno.test(
  "runTask - a fleet-authored open AWS Emulator issue with another title suppresses filing and is logged by number",
  async () => {
    const run = await runAwsPreFiler(awsCheck("missing"), {
      rows: [{
        number: 77,
        title: "Add AWS Emulator tests to the CI pipeline",
        login: FLEET_DEDUP_AUTHOR,
      }],
    });
    assert(run.ok);
    assertEquals(createCount(run.calls), 0);
    assert(
      run.infoMessages.some((m) => m.includes("#77")),
      `expected #77 in the log, got: ${run.infoMessages.join(" | ")}`,
    );
  },
);

/** The body the base code filed for BP-AWS-EMULATOR-MISSING before #5112: it told the repo to run Floci. */
/** An older scan-filed body: the marker on its first line, Floci advice below. */
const OLD_FLOCI_FINDING_BODY = [
  "<!-- finding-id: BP-AWS-EMULATOR-MISSING -->",
  "",
  "Run floci/floci as a service container; mount /var/run/docker.sock.",
].join("\n");

function editCalls(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args[0] === "issue" && c.args[1] === "edit");
}

function commentCalls(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args[0] === "issue" && c.args[1] === "comment");
}

/** The `--body` of a gh call. */
function bodyArg(call: GhCall | undefined): string {
  const args = call?.args ?? [];
  return args[args.indexOf("--body") + 1] ?? "";
}

async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test(
  "runTask - an open old-body AWS finding ('No AWS emulator (Floci) in CI') gets the current finding as one comment, is not edited and is not re-filed",
  async () => {
    const check = awsCheck("floci-only");
    const run = await runAwsPreFiler(check, {
      rows: [{
        number: 81,
        title: "🟡 No AWS emulator (Floci) in CI",
        login: FLEET_DEDUP_AUTHOR,
        body: OLD_FLOCI_FINDING_BODY,
      }],
    });
    assert(run.ok);
    assertEquals(createCount(run.calls), 0);
    assertEquals(editCalls(run.calls).length, 0);
    const comments = commentCalls(run.calls);
    assertEquals(comments.length, 1);
    assertEquals(comments[0]?.args.slice(0, 5), [
      "issue",
      "comment",
      "81",
      "--repo",
      "org/repo",
    ]);
    const finding = buildAwsEmulatorFinding(check);
    const posted = bodyArg(comments[0]);
    assertEquals(
      posted.split("\n", 1)[0],
      awsEmulatorUpdateMarker(
        finding.findingId,
        await sha256HexOf(finding.body),
      ),
    );
    assert(posted.includes(finding.title));
    assert(posted.includes("## Why this matters"));
    // The comment is never read as a second finding.
    assert(!posted.includes("<!-- finding-id:"));
    assert(!posted.includes("docker.sock"));
    assert(
      run.infoMessages.some((m) =>
        m.includes("#81") && m.includes("posted on it as a comment")
      ),
    );
  },
);

Deno.test(
  "runTask - the same current finding is not commented twice on a reused AWS Emulator issue",
  async () => {
    const check = awsCheck("floci-only");
    const finding = buildAwsEmulatorFinding(check);
    const marker = awsEmulatorUpdateMarker(
      finding.findingId,
      await sha256HexOf(finding.body),
    );
    const run = await runAwsPreFiler(check, {
      rows: [{
        number: 81,
        title: "🟡 No AWS emulator (Floci) in CI",
        login: FLEET_DEDUP_AUTHOR,
        body: OLD_FLOCI_FINDING_BODY,
      }],
    }, [{ body: `${marker}\n\nThe current finding.` }]);
    assert(run.ok);
    assertEquals(commentCalls(run.calls).length, 0);
    assertEquals(editCalls(run.calls).length, 0);
    assertEquals(createCount(run.calls), 0);
    // A comment that only quotes the marker further down does not count.
    const quoted = await runAwsPreFiler(check, {
      rows: [{
        number: 81,
        title: "🟡 No AWS emulator (Floci) in CI",
        login: FLEET_DEDUP_AUTHOR,
        body: OLD_FLOCI_FINDING_BODY,
      }],
    }, [{ body: `Someone pasted \`${marker}\` here.` }]);
    assertEquals(commentCalls(quoted.calls).length, 1);
  },
);

Deno.test(
  "runTask - a reused AWS finding whose body carries a worker record block keeps it: the body is never edited",
  async () => {
    const check = awsCheck("missing");
    const current = buildAwsEmulatorFinding(check);
    const deferred = upsertWorkerRecordLine(
      current.body,
      "Deferred until 2026-12-01T00:00:00Z",
    );
    // The current finding plus a record block is up to date: nothing is posted.
    const upToDate = await runAwsPreFiler(check, {
      rows: [{
        number: 84,
        title: current.title,
        login: FLEET_DEDUP_AUTHOR,
        body: deferred,
      }],
    });
    assert(upToDate.ok);
    assertEquals(editCalls(upToDate.calls).length, 0);
    assertEquals(commentCalls(upToDate.calls).length, 0);
    // An older finding with a record block gets a comment; the body, and so
    // the record discovery reads, is not rewritten.
    const older = await runAwsPreFiler(check, {
      rows: [{
        number: 85,
        title: "🟡 No AWS emulator (Floci) in CI",
        login: FLEET_DEDUP_AUTHOR,
        body: upsertWorkerRecordLine(
          OLD_FLOCI_FINDING_BODY,
          "Deferred until 2026-12-01T00:00:00Z",
        ),
      }],
    });
    assert(older.ok);
    assertEquals(editCalls(older.calls).length, 0);
    assertEquals(commentCalls(older.calls).length, 1);
    assertEquals(createCount(older.calls), 0);
  },
);

Deno.test(
  "runTask - a failed comments read, a comments payload with no list, or a failed comment post on a reused AWS finding fails the run and files nothing",
  async () => {
    const check = awsCheck("floci-only");
    for (const fault of ["read", "no-list", "post"] as const) {
      const run = await runAwsPreFiler(
        check,
        {
          rows: [{
            number: 81,
            title: "🟡 No AWS emulator (Floci) in CI",
            login: FLEET_DEDUP_AUTHOR,
            body: OLD_FLOCI_FINDING_BODY,
          }],
        },
        [],
        fault,
      );
      assertEquals(run.ok, false, fault);
      assertEquals(createCount(run.calls), 0, fault);
      assertEquals(editCalls(run.calls).length, 0, fault);
      // The post was attempted only in the "post" case, and it failed.
      assertEquals(
        commentCalls(run.calls).length,
        fault === "post" ? 1 : 0,
        fault,
      );
    }
  },
);

Deno.test(
  "reconcileAwsEmulatorIssue - each gh fault throws an error naming the issue and the cause",
  async () => {
    const check = awsCheck("floci-only");
    const finding = buildAwsEmulatorFinding(check);
    const issue = {
      number: 81,
      title: "🟡 No AWS emulator (Floci) in CI",
      body: OLD_FLOCI_FINDING_BODY,
    };
    const cases: Array<
      [string, (args: string[]) => Promise<string>, string[]]
    > = [
      [
        "comments read rejects",
        (args) =>
          args[1] === "view"
            ? Promise.reject(new Error("gh: HTTP 502"))
            : Promise.resolve(""),
        ["cannot read the comments", "#81", "org/repo", "HTTP 502"],
      ],
      [
        "comments payload has no list",
        (args) =>
          args[1] === "view"
            ? Promise.resolve(JSON.stringify({ body: "x" }))
            : Promise.resolve(""),
        ["cannot read the comments", "#81", "org/repo", "no comments list"],
      ],
      [
        "comment post rejects",
        (args) =>
          args[1] === "view"
            ? Promise.resolve(JSON.stringify({ comments: [] }))
            : Promise.reject(new Error("gh: HTTP 403")),
        ["cannot comment the current finding", "#81", "org/repo", "HTTP 403"],
      ],
    ];
    for (const [label, gh, fragments] of cases) {
      const err = await assertRejects(
        () => reconcileAwsEmulatorIssue("org/repo", issue, finding, gh),
        Error,
      );
      for (const fragment of fragments) {
        assert(err.message.includes(fragment), `${label}: ${err.message}`);
      }
    }
  },
);

Deno.test(
  "runTask - a reused AWS Emulator issue whose marker is not its first line is left alone",
  async () => {
    const check = awsCheck("missing");
    for (
      const body of [
        // An owner's paragraph above the generated text.
        "Owner note: we will wire this after the Q1 freeze.\n\n" +
        OLD_FLOCI_FINDING_BODY,
        // A body that only quotes the marker in a code span.
        "Tracking `<!-- finding-id: BP-AWS-EMULATOR-MISSING -->` from the scan.",
      ]
    ) {
      const run = await runAwsPreFiler(check, {
        rows: [{
          number: 86,
          title: "AWS Emulator wiring",
          login: FLEET_DEDUP_AUTHOR,
          body,
        }],
      });
      assert(run.ok);
      assertEquals(editCalls(run.calls).length, 0, body);
      assertEquals(commentCalls(run.calls).length, 0, body);
      assertEquals(createCount(run.calls), 0, body);
    }
  },
);

Deno.test(
  "runTask - an open AWS finding already matching the current finding, or a hand-written AWS Emulator issue, is not edited",
  async () => {
    const check = awsCheck("missing");
    const current = buildAwsEmulatorFinding(check);
    const upToDate = await runAwsPreFiler(check, {
      rows: [{
        number: 82,
        title: current.title,
        login: FLEET_DEDUP_AUTHOR,
        body: current.body,
      }],
    });
    assert(upToDate.ok);
    assertEquals(editCalls(upToDate.calls).length, 0);
    assertEquals(createCount(upToDate.calls), 0);
    const handWritten = await runAwsPreFiler(check, {
      rows: [{
        number: 83,
        title: "Add AWS Emulator tests",
        login: FLEET_DEDUP_AUTHOR,
        body: "Please wire the AWS Emulator into CI.",
      }],
    });
    assert(handWritten.ok);
    assertEquals(editCalls(handWritten.calls).length, 0);
    assertEquals(createCount(handWritten.calls), 0);
  },
);

Deno.test(
  "runTask - a non-fleet-authored open AWS Emulator issue does not suppress filing",
  async () => {
    const run = await runAwsPreFiler(awsCheck("missing"), {
      rows: [{
        number: 78,
        title: "AWS Emulator tests please",
        login: "a-stranger",
      }],
    });
    assert(run.ok);
    assertEquals(createCount(run.calls), 1);
  },
);

Deno.test(
  "runTask - an open issue whose title does not name the AWS Emulator does not suppress filing",
  async () => {
    const run = await runAwsPreFiler(awsCheck("missing"), {
      rows: [{
        number: 79,
        title: "Fix the login page",
        login: FLEET_DEDUP_AUTHOR,
      }],
    });
    assert(run.ok);
    assertEquals(createCount(run.calls), 1);
  },
);

Deno.test(
  "runTask - a gh failure in the AWS Emulator issue lookup fails the run and files nothing",
  async () => {
    const run = await runAwsPreFiler(awsCheck("missing"), { fail: true });
    assertEquals(run.ok, false);
    assertEquals(createCount(run.calls), 0);
  },
);

Deno.test(
  "findEquivalentAwsEmulatorIssue - queries open issues by AWS Emulator title and returns the fleet-authored number",
  async () => {
    const seen: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      seen.push([...args]);
      return Promise.resolve(JSON.stringify([
        { number: 5, title: "AWS Emulator", author: { login: "a-stranger" } },
        {
          number: 6,
          title: "Use the aws emulator in CI",
          author: { login: FLEET_DEDUP_AUTHOR },
        },
      ]));
    };
    const found = await findEquivalentAwsEmulatorIssue(
      "org/repo",
      gh,
      DEDUP_AUTHORS,
    );
    assertEquals(found?.number, 6);
    const args = seen[0] ?? [];
    assertEquals(args.slice(0, 3), ["issue", "list", "--repo"]);
    assertEquals(
      args[args.indexOf("--search") + 1],
      `"AWS Emulator" in:title`,
    );
    assertEquals(args[args.indexOf("--state") + 1], "open");
    assertEquals(args[args.indexOf("--limit") + 1], "50");
    assert(args[args.indexOf("--json") + 1]?.includes("title"));
  },
);

Deno.test(
  "findEquivalentAwsEmulatorIssue - a gh failure throws with context, so the lookup never reads as no match",
  async () => {
    await assertRejects(
      () =>
        findEquivalentAwsEmulatorIssue(
          "org/repo",
          () => Promise.reject(new Error("rate limited")),
          DEDUP_AUTHORS,
        ),
      Error,
      "cannot look up open AWS Emulator issues in org/repo",
    );
  },
);

Deno.test(
  "buildAwsEmulatorFinding - body lists diagnostics, states what was checked, links the standard and is medium",
  () => {
    const finding = buildAwsEmulatorFinding(awsCheck("missing", [
      "`ci.yml` job `test`: step running `aws-emulator-run -- x` sets continue-on-error",
    ]));
    assertStringIncludes(finding.body, "**Severity:** medium");
    assertStringIncludes(finding.body, "## What the scan found");
    // Backticks in a diagnostic are escaped so the code span cannot break.
    assertStringIncludes(
      finding.body,
      "- 'ci.yml' job 'test': step running 'aws-emulator-run -- x' sets continue-on-error",
    );
    assertStringIncludes(
      finding.body,
      "configured execution, not an observed green CI run",
    );
    assertStringIncludes(
      finding.body,
      "https://github.com/stSoftwareAU/VibeCoder/blob/main/CODING-STANDARDS.md#aws-integration-testing",
    );
    assertStringIncludes(
      finding.body,
      "`aws-emulator-run [--timeout N] -- <test command>`",
    );
    assertStringIncludes(finding.body, "`cargo test` or `cargo nextest`");
    assert(!finding.body.includes("docker.sock"));
    assert(!finding.body.includes("::warning::"));
    assert(!finding.body.includes("SKIPPED (needs Docker)"));
  },
);

Deno.test(
  "buildAwsEmulatorFinding - a missing wiring finding says so when there are no diagnostics",
  () => {
    const finding = buildAwsEmulatorFinding(awsCheck("missing"));
    assertStringIncludes(finding.body, "- No AWS Emulator wiring was found.");
  },
);
