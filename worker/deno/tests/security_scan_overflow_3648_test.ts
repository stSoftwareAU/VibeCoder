/**
 * Regression tests for the security-scan overflow findings (Issue #3648).
 *
 * Each block reproduces one finding from the tracker: the assertions fail
 * against the pre-fix code and pass after it. Every test calls the real
 * function with real data — none inspect source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import { capFormattedComments } from "../lib/comment_rate_limiter.ts";
import { formatIssueComments } from "../commands/work_on_issue.ts";
import { prepareQuestionComments } from "../lib/comment_filter.ts";
import {
  DEFAULT_MAX_BODY_LENGTH,
  enforceIssueBodyLimit,
} from "../lib/security.ts";
import {
  formatCiAnnotations,
  MAX_CI_ANNOTATIONS,
} from "../lib/pr_ci_processor.ts";
import { formatCiFailureContext } from "../lib/ci_failure_issue.ts";
import {
  isOperationalLabel,
  verifyOperationalLabels,
} from "../lib/label_security.ts";
import {
  checkDailySpendCeiling,
  logInvocation,
} from "../lib/credit_tracker.ts";
import { recordFaultEvent } from "../lib/fault_tolerance_counters.ts";

// ---------------------------------------------------------------------------
// SEC-1dc0aa2c964f — secret-redaction gap: space-separated CLI flag
// ---------------------------------------------------------------------------

Deno.test("SEC-1dc0aa2c964f - redacts a space-separated secret CLI flag", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const out = redactSecrets(`pr-manager --imgbb-api-key ${key} --repo o/r`);
  assertEquals(out.includes(key), false);
  assertStringIncludes(out, "--imgbb-api-key");
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
  // The unrelated flag after it must survive untouched.
  assertStringIncludes(out, "--repo o/r");
});

Deno.test("SEC-1dc0aa2c964f - redacts quoted and other secret-ish flags", () => {
  for (
    const flag of ["--api-token", "--auth-password", "--gh-access-key"]
  ) {
    const out = redactSecrets(`cmd ${flag} "s3cret-value-here"`);
    assertEquals(out.includes("s3cret-value-here"), false, flag);
    assertStringIncludes(out, REDACTION_PLACEHOLDER);
  }
});

Deno.test("SEC-1dc0aa2c964f - leaves an adjacent flag alone", () => {
  const out = redactSecrets("cmd --api-key --verbose");
  assertEquals(out, "cmd --api-key --verbose");
});

Deno.test("SEC-1dc0aa2c964f - leaves non-secret flags untouched", () => {
  const line = "deno test --allow-read --filter foo --repo owner/name";
  assertEquals(redactSecrets(line), line);
});

// ---------------------------------------------------------------------------
// SEC-137aa191a0f3 — security-logging failure: unredacted fault-event context
// ---------------------------------------------------------------------------

Deno.test("SEC-137aa191a0f3 - recordFaultEvent redacts its context line", () => {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    recordFaultEvent(
      "timeout",
      "command timed out: git clone https://x:ghp_" + "A".repeat(36) +
        "@github.com/o/r",
    );
  } finally {
    console.warn = original;
  }
  assertEquals(lines.length, 1);
  assertEquals(lines[0]!.includes("ghp_"), false);
  assertStringIncludes(lines[0]!, REDACTION_PLACEHOLDER);
});

// ---------------------------------------------------------------------------
// SEC-3edee182987d — unbounded comment concatenation on the no-trust path
// ---------------------------------------------------------------------------

Deno.test("SEC-3edee182987d - capFormattedComments passes short input through", () => {
  assertEquals(capFormattedComments("short", 100), "short");
});

Deno.test("SEC-3edee182987d - capFormattedComments truncates and announces", () => {
  const out = capFormattedComments("x".repeat(500), 100);
  assert(out.length < 500);
  assertStringIncludes(out, "Comment context truncated");
  assertStringIncludes(out, "400 characters omitted");
});

Deno.test("SEC-3edee182987d - formatIssueComments caps the total blob", () => {
  const comments = Array.from({ length: 20 }, (_, i) => ({
    author: `attacker${i}`,
    body: "A".repeat(5_000),
  }));
  const out = formatIssueComments(comments, 1_000);
  assert(
    out.length < 2_000,
    `expected a bounded blob, got ${out.length} characters`,
  );
  assertStringIncludes(out, "Comment context truncated");
});

Deno.test("SEC-3edee182987d - formatIssueComments uses the 20k default cap", () => {
  const comments = Array.from({ length: 40 }, (_, i) => ({
    author: `attacker${i}`,
    body: "A".repeat(10_000),
  }));
  const out = formatIssueComments(comments);
  assert(
    out.length < 21_000,
    `expected the default cap to apply, got ${out.length} characters`,
  );
});

Deno.test("SEC-3edee182987d - prepareQuestionComments caps the total blob", () => {
  const json = JSON.stringify({
    comments: Array.from({ length: 20 }, (_, i) => ({
      body: "B".repeat(5_000),
      author: { login: `attacker${i}` },
    })),
  });
  const out = prepareQuestionComments(json, undefined, 1_000);
  assert(
    out.length < 2_000,
    `expected a bounded blob, got ${out.length} characters`,
  );
  assertStringIncludes(out, "Comment context truncated");
});

Deno.test("SEC-3edee182987d - prepareQuestionComments preserves small input", () => {
  const json = JSON.stringify({
    comments: [{ body: "hello", author: { login: "alice" } }],
  });
  assertEquals(prepareQuestionComments(json), "[alice]: hello");
});

// ---------------------------------------------------------------------------
// SEC-901dd1fad19d — DEFAULT_MAX_BODY_LENGTH was never enforced
// ---------------------------------------------------------------------------

Deno.test("SEC-901dd1fad19d - enforceIssueBodyLimit leaves a normal body alone", () => {
  const result = enforceIssueBodyLimit("a short issue body");
  assertEquals(result.truncated, false);
  assertEquals(result.body, "a short issue body");
  assertEquals(result.maxBodyLength, DEFAULT_MAX_BODY_LENGTH);
});

Deno.test("SEC-901dd1fad19d - enforceIssueBodyLimit truncates an oversized body", () => {
  const body = "z".repeat(DEFAULT_MAX_BODY_LENGTH + 5_000);
  const result = enforceIssueBodyLimit(body);
  assertEquals(result.truncated, true);
  assertEquals(result.originalLength, DEFAULT_MAX_BODY_LENGTH + 5_000);
  assert(result.body.length < body.length);
  assertStringIncludes(result.body, "Issue body truncated");
  assertStringIncludes(result.body, "5000 bytes omitted");
});

Deno.test("SEC-901dd1fad19d - enforceIssueBodyLimit never splits a multi-byte character", () => {
  // Each emoji is 4 bytes; a 10-byte limit must cut on a character boundary.
  const result = enforceIssueBodyLimit("😀😀😀😀", 10);
  assertEquals(result.truncated, true);
  assertEquals(result.body.startsWith("😀😀"), true);
  assertEquals(result.body.includes("�"), false);
});

Deno.test("SEC-901dd1fad19d - enforceIssueBodyLimit handles an empty body", () => {
  const result = enforceIssueBodyLimit("");
  assertEquals(result.truncated, false);
  assertEquals(result.originalLength, 0);
});

// ---------------------------------------------------------------------------
// SEC-4024fa7fea0a — unbounded CI annotation rendering
// ---------------------------------------------------------------------------

const annotation = (i: number, messageLength = 40) => ({
  path: `src/file${i}.ts`,
  start_line: i,
  end_line: i,
  annotation_level: "failure",
  message: "m".repeat(messageLength),
});

Deno.test("SEC-4024fa7fea0a - formatCiAnnotations caps the annotation count", () => {
  const annotations = Array.from({ length: 500 }, (_, i) => annotation(i));
  const out = formatCiAnnotations(annotations);
  const rendered = out.split("\n").filter((l) => l.startsWith("- **")).length;
  assert(
    rendered <= MAX_CI_ANNOTATIONS,
    `expected at most ${MAX_CI_ANNOTATIONS} lines, got ${rendered}`,
  );
  assertStringIncludes(out, "further annotation(s) omitted");
});

Deno.test("SEC-4024fa7fea0a - formatCiAnnotations caps total bytes", () => {
  const annotations = Array.from(
    { length: MAX_CI_ANNOTATIONS },
    (_, i) => annotation(i, 100_000),
  );
  const out = formatCiAnnotations(annotations);
  assert(
    out.length < 200_000,
    `expected a byte-bounded blob, got ${out.length} characters`,
  );
  assertStringIncludes(out, "further annotation(s) omitted");
});

Deno.test("SEC-4024fa7fea0a - formatCiAnnotations renders a small list in full", () => {
  const out = formatCiAnnotations([annotation(1), annotation(2)]);
  assertStringIncludes(out, "src/file1.ts:1");
  assertStringIncludes(out, "src/file2.ts:2");
  assertEquals(out.includes("omitted"), false);
});

Deno.test("SEC-4024fa7fea0a - formatCiAnnotations still reports a single oversized annotation", () => {
  const out = formatCiAnnotations([annotation(7, 100_000)]);
  assertStringIncludes(out, "src/file7.ts:7");
  assert(out.length < 100_000);
});

Deno.test("SEC-4024fa7fea0a - formatCiAnnotations keeps the empty-list message", () => {
  assertStringIncludes(
    formatCiAnnotations([]),
    "No specific annotations were available",
  );
});

// ---------------------------------------------------------------------------
// SEC-3c3c066cff69 — Jenkins console log rendered into the prompt unredacted
// ---------------------------------------------------------------------------

Deno.test("SEC-3c3c066cff69 - formatCiFailureContext redacts secrets in the log tail", () => {
  const token = "ghp_" + "C".repeat(36);
  const out = formatCiFailureContext({
    build: { number: 42, result: "FAILURE", url: "https://ci/42" },
    log: `Started build\nfetching https://x:${token}@github.com/o/r\ndone`,
    boundaryId: "BOUNDARY_TEST",
  });
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
  // The diagnostic framing must survive redaction.
  assertStringIncludes(out, "fetched build #42");
});

Deno.test("SEC-3c3c066cff69 - formatCiFailureContext redacts an assignment-style secret", () => {
  const out = formatCiFailureContext({
    build: { number: 7, result: "FAILURE", url: "https://ci/7" },
    log: "+ export DEPLOY_TOKEN=super-secret-value\nerror: build failed",
    boundaryId: "BOUNDARY_TEST",
  });
  assertEquals(out.includes("super-secret-value"), false);
  assertStringIncludes(out, "error: build failed");
});

// ---------------------------------------------------------------------------
// SEC-a359b609bc63 — blocking labels were never trust-verified
// ---------------------------------------------------------------------------

Deno.test("SEC-a359b609bc63 - blocking labels are operational labels", () => {
  for (const label of ["refine-issue", "failed", "failed-once"]) {
    assertEquals(isOperationalLabel(label), true, label);
  }
});

/** Build a `gh` stub returning a one-page timeline of `labeled` events. */
function timelineGh(
  events: Array<{ label: string; actor: string }>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[1]?.includes("page=1")) {
      return Promise.resolve(JSON.stringify(
        events.map((e) => ({
          event: "labeled",
          label: { name: e.label },
          actor: { login: e.actor },
        })),
      ));
    }
    return Promise.resolve("[]");
  };
}

Deno.test("SEC-a359b609bc63 - refine-issue from an untrusted actor is stripped", async () => {
  const result = await verifyOperationalLabels(
    "o/r",
    1,
    ["refine-issue"],
    ["trusted-human"],
    timelineGh([{ label: "refine-issue", actor: "drive-by-triager" }]),
    "vibe-worker",
    ["vibe-worker"],
  );
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]!.addedBy, "drive-by-triager");
});

Deno.test("SEC-a359b609bc63 - refine-issue from a trusted human is honoured", async () => {
  const result = await verifyOperationalLabels(
    "o/r",
    1,
    ["refine-issue"],
    ["trusted-human"],
    timelineGh([{ label: "refine-issue", actor: "trusted-human" }]),
    "vibe-worker",
    ["vibe-worker"],
  );
  assertEquals(result.trustedLabels, ["refine-issue"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("SEC-a359b609bc63 - failed from an untrusted actor is stripped", async () => {
  const result = await verifyOperationalLabels(
    "o/r",
    2,
    ["failed"],
    ["trusted-human"],
    timelineGh([{ label: "failed", actor: "attacker" }]),
    "vibe-worker",
    ["vibe-worker"],
  );
  assertEquals(result.trustedLabels, []);
  assertEquals(result.untrustedLabels[0]!.label, "failed");
});

Deno.test("SEC-a359b609bc63 - the worker's own failed mark stays trusted", async () => {
  const result = await verifyOperationalLabels(
    "o/r",
    3,
    ["failed", "failed-once"],
    ["trusted-human"],
    timelineGh([
      { label: "failed", actor: "vibe-worker" },
      { label: "failed-once", actor: "vibe-worker" },
    ]),
    "vibe-worker",
    ["vibe-worker"],
  );
  assertEquals(result.trustedLabels.sort(), ["failed", "failed-once"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("SEC-a359b609bc63 - a sibling fleet worker's failed mark stays trusted", async () => {
  const result = await verifyOperationalLabels(
    "o/r",
    4,
    ["failed"],
    ["trusted-human"],
    timelineGh([{ label: "failed", actor: "vibe-worker-2" }]),
    "vibe-worker",
    ["vibe-worker", "vibe-worker-2"],
  );
  assertEquals(result.trustedLabels, ["failed"]);
  assertEquals(result.untrustedLabels, []);
});

// ---------------------------------------------------------------------------
// SEC-888ae4c269f9 — no spend ceiling existed anywhere
// ---------------------------------------------------------------------------

async function withCreditLog(
  entries: Array<{ model: string; inputTokens: number; outputTokens: number }>,
  fn: (logDir: string) => Promise<void>,
): Promise<void> {
  const logDir = await Deno.makeTempDir();
  try {
    for (const entry of entries) {
      await logInvocation({
        logDir,
        workerName: "worker-1",
        phase: "issue",
        repo: "o/r",
        model: entry.model,
        tokenUsage: {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      });
    }
    await fn(logDir);
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
}

Deno.test("SEC-888ae4c269f9 - a ceiling of 0 disables the check", async () => {
  const logDir = await Deno.makeTempDir();
  try {
    const result = await checkDailySpendCeiling({ logDir, ceilingUsd: 0 });
    assert(result.ok);
    assertEquals(result.value.enabled, false);
    assertEquals(result.value.exceeded, false);
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
});

Deno.test("SEC-888ae4c269f9 - a missing log is zero spend, not a failure", async () => {
  const logDir = await Deno.makeTempDir();
  try {
    const result = await checkDailySpendCeiling({ logDir, ceilingUsd: 10 });
    assert(result.ok);
    assertEquals(result.value.enabled, true);
    assertEquals(result.value.exceeded, false);
    assertEquals(result.value.spentUsd, 0);
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
});

Deno.test("SEC-888ae4c269f9 - spend below the ceiling does not trip it", async () => {
  await withCreditLog(
    [{ model: "claude-sonnet-4-5", inputTokens: 1_000, outputTokens: 1_000 }],
    async (logDir) => {
      const result = await checkDailySpendCeiling({
        logDir,
        ceilingUsd: 1_000_000,
      });
      assert(result.ok);
      assertEquals(result.value.exceeded, false);
      assertEquals(result.value.message, undefined);
    },
  );
});

Deno.test("SEC-888ae4c269f9 - spend at or above the ceiling trips it loudly", async () => {
  await withCreditLog(
    [{
      model: "claude-sonnet-4-5",
      inputTokens: 50_000_000,
      outputTokens: 10_000_000,
    }],
    async (logDir) => {
      const result = await checkDailySpendCeiling({ logDir, ceilingUsd: 1 });
      assert(result.ok);
      assertEquals(result.value.exceeded, true);
      assert(result.value.spentUsd >= 1);
      assertStringIncludes(
        result.value.message ?? "",
        "Daily spend ceiling reached",
      );
    },
  );
});

Deno.test("SEC-a359b609bc63 - an unverifiable blocking label is kept, not stripped", async () => {
  // No `labeled` event for `failed` at all — authorship cannot be established.
  // Stripping here would fail OPEN and hand the issue back for another run.
  const result = await verifyOperationalLabels(
    "o/r",
    5,
    ["failed", "refine-issue"],
    ["trusted-human"],
    timelineGh([{ label: "work-on", actor: "alice" }]),
    "vibe-worker",
    ["vibe-worker"],
  );
  assertEquals(result.trustedLabels.sort(), ["failed", "refine-issue"]);
  assertEquals(result.untrustedLabels, []);
});

Deno.test("SEC-a359b609bc63 - a timeline read failure keeps blocking labels", async () => {
  const result = await verifyOperationalLabels(
    "o/r",
    6,
    ["failed", "planning"],
    ["trusted-human"],
    () => Promise.reject(new Error("gh api exploded")),
    "vibe-worker",
    ["vibe-worker"],
  );
  // `failed` is blocking-only — keep it. `planning` routes into a privileged
  // phase, so the existing fail-closed strip still applies.
  assertEquals(result.trustedLabels, ["failed"]);
  assertEquals(result.untrustedLabels.length, 1);
  assertEquals(result.untrustedLabels[0]!.label, "planning");
});

// ---------------------------------------------------------------------------
// SEC-b5022d94c871 — CI-executed scripts outside code-owner review
// ---------------------------------------------------------------------------

/**
 * Parse a CODEOWNERS file into `[pattern, owners]` pairs, ignoring comments
 * and blank lines.
 */
function parseCodeowners(text: string): Array<[string, string[]]> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return [pattern!, owners] as [string, string[]];
    });
}

/** Whether any CODEOWNERS rule claims ownership of `path`. */
function ownersFor(
  rules: Array<[string, string[]]>,
  path: string,
): string[] {
  // Last matching rule wins, per GitHub's CODEOWNERS semantics.
  let owners: string[] = [];
  for (const [pattern, ruleOwners] of rules) {
    const prefix = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    if (path === prefix || path.startsWith(prefix)) owners = ruleOwners;
  }
  return owners;
}

Deno.test("SEC-888ae4c269f9 - an unknown worker name contributes no spend", async () => {
  await withCreditLog(
    [{
      model: "claude-sonnet-4-5",
      inputTokens: 50_000_000,
      outputTokens: 10_000_000,
    }],
    async (logDir) => {
      const result = await checkDailySpendCeiling({
        logDir,
        ceilingUsd: 1,
        workerName: "worker-does-not-exist",
      });
      assert(result.ok);
      assertEquals(result.value.spentUsd, 0);
      assertEquals(result.value.exceeded, false);
    },
  );
});
