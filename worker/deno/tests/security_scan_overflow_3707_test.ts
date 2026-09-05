/**
 * Regression tests for the secret-exposure findings (Issue #3707).
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
import { buildClaudeChildEnv, CLAUDE_ENV_DENYLIST } from "../lib/claude_env.ts";
import { buildClaudeChildEnv as buildClaudeChildEnvFromRunner } from "../lib/claude_runner.ts";
import { redactGhBodyArgs } from "../lib/gh_body_redaction.ts";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  spawnGh,
} from "../lib/gh_spawn.ts";
import {
  markPrCommentAsFailed,
  markPrCommentAsFailedOnce,
} from "../lib/pr_comments.ts";
import { buildQuestionFailureComment } from "../lib/label_question_failure.ts";
import {
  buildCrashMessage,
  type CrashNotificationParams,
} from "../lib/crash_notification.ts";
import { readImgbbApiKeyFromEnv } from "../lib/imgbb_upload.ts";

/** A realistic GitHub token shape used across the redaction assertions. */
const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

// ---------------------------------------------------------------------------
// SEC-7e148c3ba692 — child-environment denylist covered only two variables
// ---------------------------------------------------------------------------

Deno.test("SEC-7e148c3ba692 - drops the worker-only credentials and an extension's", () => {
  const child = buildClaudeChildEnv({
    // A private extension's own CI credentials. Core does not name them —
    // it cannot, it does not know what an operator installed (Issue #986) —
    // so the credential-shape rule is what has to hold.
    EXTENSION_CI_URL: "https://ci.example.com",
    EXTENSION_CI_TOKEN: "11abcdef0123456789",
    GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    VIBE_IMGBB_API_KEY: "0123456789abcdef0123456789abcdef",
    PATH: "/usr/bin",
  });
  assertEquals(child["EXTENSION_CI_TOKEN"], undefined);
  assertEquals(child["GITHUB_APP_PRIVATE_KEY_PATH"], undefined);
  assertEquals(child["VIBE_IMGBB_API_KEY"], undefined);
  // Non-secret siblings survive so the agent keeps working context.
  assertEquals(child["EXTENSION_CI_URL"], "https://ci.example.com");
  assertEquals(child["PATH"], "/usr/bin");
});

Deno.test("SEC-7e148c3ba692 - denies unlisted secret-shaped variable names", () => {
  const child = buildClaudeChildEnv({
    ACME_API_TOKEN: "s3cret",
    DEPLOY_PASSWORD: "s3cret",
    AWS_SECRET_ACCESS_KEY: "s3cret",
    SOME_CREDENTIAL: "s3cret",
    REPO_NAME: "org/repo",
  });
  assertEquals(child["ACME_API_TOKEN"], undefined);
  assertEquals(child["DEPLOY_PASSWORD"], undefined);
  assertEquals(child["AWS_SECRET_ACCESS_KEY"], undefined);
  assertEquals(child["SOME_CREDENTIAL"], undefined);
  assertEquals(child["REPO_NAME"], "org/repo");
});

Deno.test("SEC-7e148c3ba692 - keeps the credentials the agent legitimately needs", () => {
  const child = buildClaudeChildEnv({
    GH_TOKEN: "gh-installation-token",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  });
  assertEquals(child["GH_TOKEN"], "gh-installation-token");
  assertEquals(child["ANTHROPIC_API_KEY"], "sk-ant-test");
  assertEquals(child["CLAUDE_CODE_OAUTH_TOKEN"], "oauth-token");
});

Deno.test("SEC-7e148c3ba692 - runner and env module share one denylist", () => {
  assert(CLAUDE_ENV_DENYLIST.includes("GITHUB_APP_PRIVATE_KEY"));
  assert(CLAUDE_ENV_DENYLIST.includes("VIBE_IMGBB_API_KEY"));
  const parent = { VIBE_IMGBB_API_KEY: "s3cret", PATH: "/usr/bin" };
  assertEquals(
    buildClaudeChildEnvFromRunner(parent),
    buildClaudeChildEnv(parent),
  );
  assertEquals(
    buildClaudeChildEnvFromRunner(parent)["VIBE_IMGBB_API_KEY"],
    undefined,
  );
});

// ---------------------------------------------------------------------------
// SEC-c250e91f7ab8 — public comment sinks with no redaction
// ---------------------------------------------------------------------------

/** Capture the `--body` a `gh` call would have posted. */
function capturingGh(calls: string[][]): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push([...args]);
    return Promise.resolve("");
  };
}

function bodyOf(calls: string[][]): string {
  for (const call of calls) {
    const i = call.indexOf("--body");
    const body = i >= 0 ? call[i + 1] : undefined;
    if (body !== undefined) return body;
  }
  return "";
}

Deno.test("SEC-c250e91f7ab8 - first-attempt PR failure reply redacts secrets", async () => {
  const calls: string[][] = [];
  await markPrCommentAsFailedOnce(
    "org/repo",
    7,
    "issue",
    "12345",
    `clone failed: GH_TOKEN=${GH_TOKEN_SAMPLE}`,
    capturingGh(calls),
  );
  const body = bodyOf(calls);
  assertEquals(body.includes(GH_TOKEN_SAMPLE), false);
  assertStringIncludes(body, REDACTION_PLACEHOLDER);
});

Deno.test("SEC-c250e91f7ab8 - permanent PR failure reply redacts secrets", async () => {
  const calls: string[][] = [];
  await markPrCommentAsFailed(
    "org/repo",
    7,
    "issue",
    "12345",
    `clone failed: GH_TOKEN=${GH_TOKEN_SAMPLE}`,
    capturingGh(calls),
  );
  const body = bodyOf(calls);
  assertEquals(body.includes(GH_TOKEN_SAMPLE), false);
  assertStringIncludes(body, REDACTION_PLACEHOLDER);
});

Deno.test("SEC-c250e91f7ab8 - question failure comment redacts secrets", () => {
  const body = buildQuestionFailureComment(
    `Error: auth failed with ${GH_TOKEN_SAMPLE}`,
    false,
  );
  assertEquals(body.includes(GH_TOKEN_SAMPLE), false);
  assertStringIncludes(body, REDACTION_PLACEHOLDER);
});

Deno.test("SEC-c250e91f7ab8 - gh chokepoint redacts comment and PR bodies", async () => {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    return Promise.resolve({ code: 0, success: true, stdout: "", stderr: "" });
  });
  try {
    await spawnGh([
      "pr",
      "comment",
      "7",
      "--repo",
      "org/repo",
      "--body",
      `failed: GH_TOKEN=${GH_TOKEN_SAMPLE}`,
    ]);
    await spawnGh([
      "api",
      "-X",
      "POST",
      "repos/org/repo/issues/7/comments",
      "-f",
      `body=leaked ${GH_TOKEN_SAMPLE}`,
    ]);
  } finally {
    _resetGhSpawnRunner();
  }
  const flat = calls.flat().join(" ");
  assertEquals(flat.includes(GH_TOKEN_SAMPLE), false);
  assertStringIncludes(flat, REDACTION_PLACEHOLDER);
  // The routing arguments are untouched.
  assertStringIncludes(flat, "org/repo");
});

Deno.test("redactGhBodyArgs - leaves non-body arguments alone", () => {
  const args = [
    "api",
    "-X",
    "POST",
    `repos/org/repo-${GH_TOKEN_SAMPLE}/issues`,
    "-f",
    "content=confused",
  ];
  // Only body-carrying arguments are rewritten; a repo path is routing data.
  assertEquals(redactGhBodyArgs(args), args);
});

Deno.test("redactGhBodyArgs - redacts -b short form and --field body", () => {
  assertEquals(
    redactGhBodyArgs(["pr", "create", "-b", `x ${GH_TOKEN_SAMPLE}`]),
    ["pr", "create", "-b", `x ${REDACTION_PLACEHOLDER}`],
  );
  assertEquals(
    redactGhBodyArgs(["api", "--field", `message=${GH_TOKEN_SAMPLE}`]),
    ["api", "--field", `message=${REDACTION_PLACEHOLDER}`],
  );
});

// ---------------------------------------------------------------------------
// SEC-4e8710db3c96 — JSON key/value form never matched
// ---------------------------------------------------------------------------

Deno.test("SEC-4e8710db3c96 - redacts the JSON key/value secret form", () => {
  const out = redactSecrets(`{"token": "${GH_TOKEN_SAMPLE}", "id": 7}`);
  assertEquals(out.includes(GH_TOKEN_SAMPLE), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
  assertStringIncludes(out, `"id": 7`);
});

Deno.test("SEC-4e8710db3c96 - redacts JSON secret keys regardless of spacing", () => {
  const cases = [
    `"api_key":"abcdef0123456789abcd"`,
    `"password" : "hunter2-hunter2"`,
    `'access_key': 'abcdef0123456789abcd'`,
    `"GITHUB_TOKEN" = "abcdef0123456789abcd"`,
  ];
  for (const text of cases) {
    const out = redactSecrets(text);
    assertStringIncludes(out, REDACTION_PLACEHOLDER);
    assertEquals(out.includes("hunter2-hunter2"), false, text);
    assertEquals(out.includes("abcdef0123456789abcd"), false, text);
  }
});

Deno.test("SEC-4e8710db3c96 - ordinary JSON is left untouched", () => {
  const text = `{"repo": "org/repo", "issue": 3707, "state": "open"}`;
  assertEquals(redactSecrets(text), text);
});

// ---------------------------------------------------------------------------
// SEC-b7f1602e9d4a — PEM rule required both markers; truncation preceded
// redaction
// ---------------------------------------------------------------------------

/** A PEM body shaped like a real key: 64-character base64 lines. */
const PEM_BODY = [
  "MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy",
  "vGZlGJpmn65+A4xHXInJYiPuKzrKUnApeLZ+vw1HocOAZtWK0z3r26uA8kQYOKX9",
  "Qt/DbCdvsF9wF8gRK0ptx9M6R13NvBxvVUUvbY4bF9Fd3l8mWJqUM4vLb0hVGgWv",
].join("\n");

Deno.test("SEC-b7f1602e9d4a - redacts a PEM block missing its END marker", () => {
  const text =
    `error: -----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n... (truncated)`;
  const out = redactSecrets(text);
  assertEquals(out.includes("MIIEowIBAAKCAQEA"), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("SEC-b7f1602e9d4a - redacts a bare PEM body with no markers at all", () => {
  const out = redactSecrets(`captured key material:\n${PEM_BODY}\nend`);
  assertEquals(out.includes("MIIEowIBAAKCAQEA"), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
  assertStringIncludes(out, "captured key material:");
});

Deno.test("SEC-b7f1602e9d4a - a complete PEM block is still redacted whole", () => {
  const out = redactSecrets(
    `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
  );
  assertEquals(out, REDACTION_PLACEHOLDER);
});

Deno.test("SEC-b7f1602e9d4a - ordinary prose and short base64 survive", () => {
  const text =
    "Applying patch aGVsbG8gd29ybGQ= to the build — 3 tests passed in 1.2s";
  assertEquals(redactSecrets(text), text);
});

function crashParams(
  overrides: Partial<CrashNotificationParams> = {},
): CrashNotificationParams {
  return {
    exitCode: 1,
    repo: "org/repo",
    issueNumber: 7,
    logTail: "",
    claudeOutput: "",
    workStage: "running_claude",
    workStartTime: 0,
    plannedShutdown: false,
    ...overrides,
  };
}

Deno.test("SEC-b7f1602e9d4a - a secret straddling the truncation cut is redacted", () => {
  const padding = "x".repeat(60);
  const logTail =
    `${padding}\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\n`;
  const body = buildCrashMessage(
    {
      workerName: "w1",
      cooldownSeconds: 600,
      // Cut mid-key so the END marker never reaches the redaction pass.
      logTailMaxBytes: 140,
      stateDir: "/tmp",
    },
    crashParams({ logTail }),
    () => 0,
  );
  assertEquals(body.includes("MIIEowIBAAKCAQEA"), false);
  assertStringIncludes(body, REDACTION_PLACEHOLDER);
});

Deno.test("SEC-b7f1602e9d4a - a token straddling the Claude-output cut is redacted", () => {
  const claudeOutput = `${"y".repeat(50)} GH_TOKEN=${GH_TOKEN_SAMPLE} done`;
  const body = buildCrashMessage(
    {
      workerName: "w1",
      cooldownSeconds: 600,
      logTailMaxBytes: 70,
      stateDir: "/tmp",
    },
    crashParams({ claudeOutput }),
    () => 0,
  );
  assertEquals(body.includes(GH_TOKEN_SAMPLE.substring(0, 20)), false);
  assertStringIncludes(body, REDACTION_PLACEHOLDER);
});

// ---------------------------------------------------------------------------
// SEC-f5170c39ae86 — ImgBB key passed on the command line
// ---------------------------------------------------------------------------

Deno.test("SEC-f5170c39ae86 - ImgBB key is read from the environment", () => {
  const env = (name: string) =>
    name === "VIBE_IMGBB_API_KEY" ? " 0123456789abcdef " : undefined;
  assertEquals(readImgbbApiKeyFromEnv(env), "0123456789abcdef");
});

Deno.test("SEC-f5170c39ae86 - missing or blank ImgBB key yields an empty string", () => {
  assertEquals(readImgbbApiKeyFromEnv(() => undefined), "");
  assertEquals(readImgbbApiKeyFromEnv(() => "   "), "");
});
