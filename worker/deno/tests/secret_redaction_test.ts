/**
 * Tests for the secret-redaction module (Issue #2417).
 *
 * The worker writes structured logs to stderr, which are captured into
 * worker-*.log and, for the CI surfaces, into GitHub Actions output. A
 * secret reaching any log line (e.g. a tokenised git clone URL inside a
 * `git`/`gh` error, or a logged command-output tail) would leak into those
 * logs. `redactSecrets` is the single chokepoint that masks known secret
 * shapes before any bytes are written.
 *
 * Following TDD: these tests define the expected behaviour first.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

Deno.test("redactSecrets - masks a classic GitHub personal access token", () => {
  const token = "ghp_" + "A".repeat(36);
  const out = redactSecrets(`cloning with token ${token} now`);
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks each GitHub token prefix ( gho/ghu/ghs/ghr )", () => {
  for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_"]) {
    const token = prefix + "b".repeat(36);
    const out = redactSecrets(`value=${token}`);
    assertEquals(
      out.includes(token),
      false,
      `prefix ${prefix} should be redacted`,
    );
  }
});

Deno.test("redactSecrets - masks a fine-grained github_pat_ token", () => {
  const token = "github_pat_" + "1234567890abcDEF".repeat(4);
  const out = redactSecrets(`Authorization uses ${token}`);
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks an Anthropic API key", () => {
  const key = "sk-ant-api03-" + "x".repeat(40);
  const out = redactSecrets(`ANTHROPIC_API_KEY set to ${key}`);
  assertEquals(out.includes(key), false);
});

/** Number of times the shared placeholder appears in `text`. */
function placeholderCount(text: string): number {
  return text.split(REDACTION_PLACEHOLDER).length - 1;
}

Deno.test("redactSecrets - masks a bare OpenAI sk- API key (Issue #36)", () => {
  // The shape a CLI echoes into stderr: no assignment, flag or Bearer scheme
  // around it, so before Issue #36 no rule matched and the key was logged
  // verbatim.
  const key = "sk-" + "A1b2C3d4E5f6G7h8I9j0".repeat(2) + "KLmnOPqr";
  const out = redactSecrets(`codex exited: invalid api key ${key} (401)`);
  assertEquals(out.includes(key), false);
  assertEquals(placeholderCount(out), 1);
  assertStringIncludes(out, "codex exited: invalid api key");
});

Deno.test("redactSecrets - masks a bare sk-proj- project-scoped OpenAI key (Issue #36)", () => {
  const key = "sk-proj-" + "aB3-_".repeat(20);
  const out = redactSecrets(`Error: Incorrect API key provided: ${key}`);
  assertEquals(out.includes(key), false);
  assertEquals(placeholderCount(out), 1);
});

Deno.test("redactSecrets - masks a bare Google/Gemini AIzaSy API key (Issue #36)", () => {
  // Google keys are a fixed 39 characters: `AIzaSy` plus 33 more.
  const key = "AIzaSy" + "C9x-_Qd7".repeat(4) + "b";
  assertEquals(key.length, 39);
  const out = redactSecrets(`gemini: API key not valid (${key})`);
  assertEquals(out.includes(key), false);
  assertEquals(placeholderCount(out), 1);
  assertStringIncludes(out, "API key not valid");
});

Deno.test("redactSecrets - masks OpenAI and Google keys inside an assignment exactly once (Issue #36)", () => {
  for (
    const [name, key] of [
      ["OPENAI_API_KEY", "sk-" + "Z".repeat(48)],
      ["CODEX_API_KEY", "sk-proj-" + "y".repeat(60)],
      ["GEMINI_API_KEY", "AIzaSy" + "d".repeat(33)],
      ["GOOGLE_API_KEY", "AIzaSy" + "e".repeat(33)],
    ] as const
  ) {
    const out = redactSecrets(`${name}=${key}`);
    assertEquals(out.includes(key), false, `${name} value should be masked`);
    assertEquals(
      placeholderCount(out),
      1,
      `${name} should yield exactly one placeholder, got: ${out}`,
    );
  }
});

Deno.test("redactSecrets - an Anthropic key still redacts to exactly one placeholder (Issue #36)", () => {
  // Regression guard: the `openai-key` rule's `sk-` prefix overlaps
  // `sk-ant-`, so a second substitution would nest placeholders.
  const key = "sk-ant-api03-" + "x".repeat(40);
  assertEquals(redactSecrets(key), REDACTION_PLACEHOLDER);
  const inLine = redactSecrets(`ANTHROPIC_API_KEY set to ${key}`);
  assertEquals(inLine.includes(key), false);
  assertEquals(placeholderCount(inLine), 1);
  assertEquals(inLine, `ANTHROPIC_API_KEY set to ${REDACTION_PLACEHOLDER}`);
});

Deno.test("redactSecrets - leaves short sk- and AIzaSy-like fragments untouched (Issue #36)", () => {
  for (
    const text of [
      "renamed task-sk-notes to task-sk-todo",
      "the sk-cache was flushed",
      "sk-",
      "AIzaSyShort",
      "AIzaSy",
      "prefix AIzaSy0123456789 truncated",
    ]
  ) {
    assertEquals(redactSecrets(text), text, `should be unchanged: ${text}`);
    assertEquals(containsSecret(text), false, `not a secret: ${text}`);
  }
});

Deno.test("redactSecrets - masks a multi-line PEM private-key block (Issue #3203)", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----", // gitleaks:allow fake fixture, not a real key
    "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn0",
    "abcdEFGH1234567890ijklMNOPqrst==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(`the App key is:\n${pem}\nend`);
  assertEquals(out.includes("MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn0"), false);
  assertEquals(out.includes("BEGIN RSA PRIVATE KEY"), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks a PKCS#8 PRIVATE KEY block (Issue #3203)", () => {
  const pem = [
    "-----BEGIN PRIVATE KEY-----", // gitleaks:allow fake fixture, not a real key
    "MIIBVwIBADANBgkqhkiG9w0BAQEFAASC",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(pem);
  assertEquals(out.includes("MIIBVwIBADANBgkqhkiG9w0BAQEFAASC"), false);
  assertEquals(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks an EC PRIVATE KEY block (Issue #3203)", () => {
  const pem = [
    "-----BEGIN EC PRIVATE KEY-----", // gitleaks:allow fake fixture, not a real key
    "MHcCAQEEIHkm5U7c1secretMaterial0",
    "-----END EC PRIVATE KEY-----",
  ].join("\n");
  assertEquals(redactSecrets(pem), REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks an AWS access key id", () => {
  const key = "AKIAIOSFODNN7EXAMPLE";
  const out = redactSecrets(`aws key ${key} configured`);
  assertEquals(out.includes(key), false);
});

Deno.test("redactSecrets - masks credentials embedded in a clone URL", () => {
  // The most likely real leak: gh/git error echoing the tokenised remote.
  const token = "ghp_" + "c".repeat(36);
  const url = `https://x-access-token:${token}@github.com/org/repo.git`;
  const out = redactSecrets(`fatal: unable to access '${url}'`);
  assertEquals(out.includes(token), false);
  // Host and path stay visible so the diagnostic is still useful.
  assertStringIncludes(out, "github.com/org/repo.git");
});

Deno.test("redactSecrets - masks userinfo credentials in a generic URL", () => {
  const out = redactSecrets(
    "connecting to https://alice:s3cr3tPassw0rd@db.example.com/app",
  );
  assertEquals(out.includes("s3cr3tPassw0rd"), false);
  assertStringIncludes(out, "db.example.com/app");
});

Deno.test("redactSecrets - masks a Bearer token but keeps the scheme", () => {
  const out = redactSecrets(
    "Authorization: Bearer abc123DEF456ghi789JKL012mno345",
  );
  assertEquals(out.includes("abc123DEF456ghi789JKL012mno345"), false);
  assertStringIncludes(out, "Bearer");
});

Deno.test("redactSecrets - masks a Basic auth credential but keeps the scheme (Issue #3427)", () => {
  const encoded = btoa("jenkins-user:s3cr3t-jenkins-token");
  const out = redactSecrets(`Authorization: Basic ${encoded}`);
  assertEquals(out.includes(encoded), false);
  assertStringIncludes(out, "Basic");
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - leaves ordinary prose starting with 'Basic' untouched (Issue #3427)", () => {
  const text = "Basic authentication is required for this endpoint.";
  assertEquals(redactSecrets(text), text);
});

Deno.test("redactSecrets - masks the value of a TOKEN-style assignment, keeps the key", () => {
  const out = redactSecrets("GITHUB_TOKEN=ghs_supersecretvalue1234567890abcd");
  assertEquals(out.includes("ghs_supersecretvalue1234567890abcd"), false);
  assertStringIncludes(out, "GITHUB_TOKEN=");
});

Deno.test("redactSecrets - masks SECRET/PASSWORD/API_KEY assignments", () => {
  for (
    const key of ["MY_SECRET", "DB_PASSWORD", "SOME_API_KEY", "ACCESS_KEY"]
  ) {
    const out = redactSecrets(`${key}=hunter2hunter2hunter2`);
    assertEquals(
      out.includes("hunter2hunter2hunter2"),
      false,
      `${key} value should be redacted`,
    );
    assertStringIncludes(out, `${key}=`);
  }
});

Deno.test("redactSecrets - masks a multi-line PEM private key block (Issue #3203)", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEArandombase64contentthatlookslikeakeybody0123456789",
    "abcDEFghiJKLmnoPQRstuVWXyz+/=abcDEFghiJKLmnoPQRstuVWXyz+/=abcDEFgh",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(`the app key is\n${pem}\nend`);
  assertEquals(out.includes("MIIEpAIBAAKCAQEA"), false);
  assertEquals(out.includes("BEGIN RSA PRIVATE KEY"), false);
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});

Deno.test("redactSecrets - masks PEM variants (EC / OPENSSH / plain / encrypted)", () => {
  for (
    const label of [
      "EC PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
      "PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
    ]
  ) {
    const body = "c".repeat(64);
    const pem = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
    const out = redactSecrets(`key:\n${pem}`);
    assertEquals(out.includes(body), false, `${label} body should be redacted`);
    assertStringIncludes(out, REDACTION_PLACEHOLDER);
  }
});

Deno.test("redactSecrets - masks two PEM blocks without merging them", () => {
  const a = "aaaa".repeat(16);
  const b = "bbbb".repeat(16);
  const block = (body: string) =>
    `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  const out = redactSecrets(`${block(a)}\nmiddle text\n${block(b)}`);
  assertEquals(out.includes(a), false);
  assertEquals(out.includes(b), false);
  // The lazy match must not swallow the text between the two blocks.
  assertStringIncludes(out, "middle text");
});

Deno.test("containsSecret - true for a PEM private key block (Issue #3203)", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\n" + "z".repeat(64) +
    "\n-----END RSA PRIVATE KEY-----";
  assertEquals(containsSecret(pem), true);
});

Deno.test("redactSecrets - leaves ordinary log text untouched", () => {
  const ordinary =
    "[2024-01-15 10:30:45Z] INFO: Processing issue #2417 repo=org/repo phase=planning duration=12s";
  assertEquals(redactSecrets(ordinary), ordinary);
});

Deno.test("redactSecrets - does not redact short non-secret words ending in token", () => {
  // Guard against over-redaction: an ordinary sentence must survive.
  const text = "the broken token was replaced and the build is green";
  assertEquals(redactSecrets(text), text);
});

Deno.test("redactSecrets - leaves a bold markdown label untouched (Issue #4004)", () => {
  // The run-stats comment renders `- **Tokens:** …`. The bold closer is not a
  // credential, so the label must survive the chokepoint verbatim.
  const line =
    "- **Tokens:** input 27 · output 11,901 · cache write 0 · cache read 1,234";
  assertEquals(redactSecrets(line), line);
  assertEquals(containsSecret(line), false);
});

Deno.test("redactSecrets - leaves punctuation-only assignment values untouched (Issue #4004)", () => {
  // A value with no alphanumeric character cannot be a credential.
  for (
    const line of [
      "**Secret:** none recorded",
      "*password:* -- not set",
      "API_KEY= ***",
      "credential: ---",
    ]
  ) {
    assertEquals(redactSecrets(line), line, `should be unchanged: ${line}`);
  }
});

Deno.test("redactSecrets - still masks a bold-wrapped secret value (Issue #4004)", () => {
  // The relaxation is about punctuation-only values, not about markdown: a
  // value carrying real characters is still masked inside emphasis markers.
  const out = redactSecrets("PASSWORD: **hunter2hunter2**");
  assertEquals(out.includes("hunter2hunter2"), false);
  assertStringIncludes(out, `PASSWORD: ${REDACTION_PLACEHOLDER}`);
});

Deno.test("redactSecrets - handles empty string", () => {
  assertEquals(redactSecrets(""), "");
});

Deno.test("redactSecrets - redacts multiple secrets in one line", () => {
  const t1 = "ghp_" + "d".repeat(36);
  const t2 = "AKIAIOSFODNN7EXAMPLE";
  const out = redactSecrets(`first ${t1} then ${t2}`);
  assertEquals(out.includes(t1), false);
  assertEquals(out.includes(t2), false);
});

Deno.test("containsSecret - true when a secret is present, false otherwise", () => {
  assertEquals(containsSecret("ghp_" + "e".repeat(36)), true);
  assertEquals(containsSecret("a perfectly ordinary log line"), false);
});
