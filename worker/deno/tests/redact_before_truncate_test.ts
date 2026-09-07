/**
 * Regression tests for the truncate-before-redact inversions (Issue #1257).
 *
 * `SECURITY.md` requires a sink that trims output to a size limit to run
 * `redactSecrets()` **first**: cutting first splits a credential, and the
 * surviving fragment has lost the anchor every signature rule keys on, so the
 * later pass at the sink matches nothing and publishes it verbatim.
 *
 * Every test here drives a real sink formatter with a secret positioned so the
 * cut lands inside it, and asserts the credential cannot be read out of the
 * finished text. Each failed against the inverted code and passes after the
 * fix.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { formatCiFailureContext } from "../lib/ci_failure_issue.ts";
import { formatPrFailureActionsExcerpt } from "../lib/pr_failure_actions.ts";
import { buildFailureOutputTail } from "../lib/execute_claude_phase.ts";
import { buildClaudeFailureLog } from "../lib/claude_runner.ts";
import {
  formatBaselineQualityNote,
  formatQualityFailureMessage,
} from "../lib/quality_helpers.ts";
import { buildBumpRejectionComment } from "../lib/bump_deps.ts";
import { summariseHealthFailure } from "../lib/claude_health_message.ts";
import { gitFailureDetail } from "../lib/git_push_recovery.ts";
import { captureTimeoutDiagnostics } from "../lib/claude_executor.ts";
import { formatConflictGitDetail } from "../lib/dependency_conflict_apply.ts";
import { formatRunFailureExcerpt } from "../lib/run_failure_issue.ts";
import { buildGhStatusMessage } from "../lib/github_status.ts";

/** A GitHub token shape `redactSecrets` masks whole. */
const TOKEN = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";

/** Two wrapped base64 lines of a PEM private key. */
const PEM_BODY_A =
  "MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy";
const PEM_BODY_B =
  "vGZlGJpmn65+A4xHXInJYiPuKzrKUnApeLZ+vw1HocOAZtWK0z3r26uA8kQYOKX9";

/**
 * A PEM block followed by `trailingLines` ordinary log lines.
 *
 * Sized so a tail cut of `tailLines` lines keeps {@link PEM_BODY_B} and the
 * `END` marker but drops the `BEGIN` marker and the first body line: the
 * whole-block rule needs `BEGIN`, and the markerless body fallback needs two
 * wrapped lines, so the surviving fragment matches nothing once the cut has
 * happened first.
 */
function pemThenLines(tailLines: number): string {
  const trailing = Array.from(
    { length: tailLines - 2 },
    (_, i) => `log line ${i}`,
  );
  return [
    "-----BEGIN RSA PRIVATE KEY-----",
    PEM_BODY_A,
    PEM_BODY_B,
    "-----END RSA PRIVATE KEY-----",
    ...trailing,
  ].join("\n");
}

/** Does `text` carry a readable run of the secret's own characters? */
function leaksWindow(text: string, secret: string, window = 24): boolean {
  for (let i = 0; i + window <= secret.length; i++) {
    if (text.includes(secret.slice(i, i + window))) return true;
  }
  return false;
}

Deno.test("formatCiFailureContext - no byte cap leaks a split PEM body", () => {
  const log = pemThenLines(6);
  for (let maxBytes = 60; maxBytes <= 400; maxBytes += 5) {
    const rendered = formatCiFailureContext({
      build: { number: "42", result: "failure" },
      log,
      maxExcerptBytes: maxBytes,
      boundaryId: "abc123",
    });
    assert(
      !leaksWindow(rendered, PEM_BODY_B),
      `PEM body survived the ${maxBytes}-byte cut`,
    );
  }
});

Deno.test("formatPrFailureActionsExcerpt - no byte cap leaks a split PEM body", () => {
  const logText = pemThenLines(6);
  for (let maxBytes = 60; maxBytes <= 400; maxBytes += 5) {
    const rendered = formatPrFailureActionsExcerpt([
      {
        providerId: "github-actions",
        ok: true,
        excerpt: {
          providerId: "github-actions",
          buildId: "7",
          url: "https://example.test/7",
          logText,
        },
      },
    ], maxBytes);
    assert(
      !leaksWindow(rendered, PEM_BODY_B),
      `PEM body survived the ${maxBytes}-byte cut`,
    );
  }
});

Deno.test("buildFailureOutputTail - masks a PEM the 100-line cut would split", () => {
  const tail = buildFailureOutputTail(pemThenLines(100));
  assert(!leaksWindow(tail, PEM_BODY_B));
  assert(tail.includes("log line 97"), "keeps the diagnostic tail");
});

Deno.test("buildFailureOutputTail - empty output stays empty", () => {
  assertEquals(buildFailureOutputTail(""), "");
});

Deno.test("buildClaudeFailureLog - masks a PEM the 5-line stderr cut would split", () => {
  const message = buildClaudeFailureLog({
    exitCode: 1,
    stderr: pemThenLines(5),
    output: "some output",
    wallClockMs: 60_000,
  });
  assert(!leaksWindow(message, PEM_BODY_B));
});

Deno.test("formatQualityFailureMessage - masks a token in the quoted tail", () => {
  const output = [
    ...Array.from({ length: 300 }, (_, i) => `check ${i} ok`),
    `error: authentication failed for ${TOKEN}`,
  ].join("\n");
  const message = formatQualityFailureMessage(output);
  assert(!message.includes(TOKEN));
  assert(message.includes("authentication failed"));
});

Deno.test("formatBaselineQualityNote - masks a token in the quoted tail", () => {
  const output = [
    ...Array.from({ length: 80 }, (_, i) => `baseline ${i}`),
    `export GH_TOKEN=${TOKEN}`,
  ].join("\n");
  const note = formatBaselineQualityNote(output);
  assert(!note.includes(TOKEN));
});

Deno.test("buildBumpRejectionComment - masks a token in the output tail", () => {
  const comment = buildBumpRejectionComment({
    status: "rejected_by_script",
    files: ["deno.lock"],
    output: `${"filler\n".repeat(50)}fatal: bad credentials ${TOKEN}`,
    rejectionReason: "script exited 1",
  });
  assert(!comment.includes(TOKEN));
  assert(comment.includes("bad credentials"));
});

Deno.test("summariseHealthFailure - masks a token in the stderr preview", () => {
  const summary = summariseHealthFailure(
    1,
    "",
    `claude: request failed with Authorization: Bearer ${TOKEN}`,
  );
  assert(!summary.stderrPreview.includes(TOKEN));
  assert(!summary.message.includes(TOKEN));
});

Deno.test("gitFailureDetail - masks a tokenised push URL", () => {
  const detail = gitFailureDetail({
    ok: true,
    value: {
      code: 128,
      stdout: "",
      stderr: `remote: Invalid username or password\n` +
        `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/o/r.git/'`,
    },
  });
  assert(!detail.includes(TOKEN));
  assert(detail.includes("Invalid username or password"));
});

Deno.test("captureTimeoutDiagnostics - masks a token in the captured tail", () => {
  const diagnostics = captureTimeoutDiagnostics(
    `${"work\n".repeat(60)}error: token ${TOKEN} rejected`,
    "quality gate",
    50,
  );
  assert(!diagnostics.report.includes(TOKEN));
});

Deno.test("formatConflictGitDetail - masks a token in the bounded git output", () => {
  const detail = formatConflictGitDetail({
    code: 1,
    stdout: "",
    stderr: `error: remote rejected (token ${TOKEN})`,
  });
  assert(!detail.includes(TOKEN));
});

Deno.test("formatRunFailureExcerpt - masks a token in the bounded excerpt", () => {
  const excerpt = formatRunFailureExcerpt(
    `run failed: gh auth refused for ${TOKEN}`,
  );
  assert(!excerpt.includes(TOKEN));
});

Deno.test("buildGhStatusMessage - masks a token pasted into an issue title", () => {
  const message = buildGhStatusMessage(
    "working",
    "owner/repo",
    "42",
    `rotate ${TOKEN} everywhere`,
  );
  assert(!message.includes(TOKEN));
  assert(message.startsWith("Working on owner/repo#42"));
});
