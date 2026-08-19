/**
 * Tests for security_sarif_upload.ts — gzip+base64 payload encoding, git
 * commit/ref resolution, and the code-scanning SARIF upload (Issue #3538).
 *
 * The git runner and `gh` executor are dependency-injected so every test is
 * hermetic — no real `git`, no `gh api`. The fail-loud contract is pinned:
 * 403/404 surface as `code-scanning-unavailable`, other failures as `error`,
 * and success carries the returned SARIF id.
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type GhExec,
  type GitRunner,
  gzipBase64,
  resolveGitRef,
  uploadSecuritySarif,
} from "../lib/security_sarif_upload.ts";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

function gitStub(
  responses: Record<string, { code: number; stdout: string; stderr: string }>,
): GitRunner {
  return (args: string[]) => {
    const key = args.join(" ");
    const r = responses[key];
    if (!r) throw new Error(`unexpected git call: ${key}`);
    return Promise.resolve(r);
  };
}

// ---------------------------------------------------------------------------
// gzipBase64
// ---------------------------------------------------------------------------

Deno.test("gzipBase64 - round-trips through gunzip to the original text", async () => {
  const text = '{"hello":"wörld","n":42}';
  const encoded = await gzipBase64(text);
  // Base64 of a gzip stream (starts with 0x1f 0x8b → 'H4sI' in base64).
  assertStringIncludes(encoded, "H4sI");
  // Decode + gunzip to prove it is a valid gzip payload of the input.
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const stream = new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  );
  assertEquals(await stream.text(), text);
});

// ---------------------------------------------------------------------------
// resolveGitRef
// ---------------------------------------------------------------------------

Deno.test("resolveGitRef - resolves commit sha and fully-qualified ref", async () => {
  const runGit = gitStub({
    "rev-parse HEAD": { code: 0, stdout: `${FULL_SHA}\n`, stderr: "" },
    "symbolic-ref -q HEAD": {
      code: 0,
      stdout: "refs/heads/main\n",
      stderr: "",
    },
  });
  const result = await resolveGitRef("/repo", runGit);
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.commitSha, FULL_SHA);
    assertEquals(result.value.ref, "refs/heads/main");
  }
});

Deno.test("resolveGitRef - detached HEAD surfaces an error (never guesses a ref)", async () => {
  const runGit = gitStub({
    "rev-parse HEAD": { code: 0, stdout: `${FULL_SHA}\n`, stderr: "" },
    "symbolic-ref -q HEAD": { code: 1, stdout: "", stderr: "" },
  });
  const result = await resolveGitRef("/repo", runGit);
  assert(!result.ok);
  if (!result.ok) assertStringIncludes(result.error, "symbolic-ref");
});

Deno.test("resolveGitRef - non-SHA rev-parse output is a surfaced error", async () => {
  const runGit = gitStub({
    "rev-parse HEAD": { code: 0, stdout: "not-a-sha\n", stderr: "" },
  });
  const result = await resolveGitRef("/repo", runGit);
  assert(!result.ok);
  if (!result.ok) assertStringIncludes(result.error, "non-SHA");
});

// ---------------------------------------------------------------------------
// uploadSecuritySarif
// ---------------------------------------------------------------------------

const UPLOAD_OPTS = {
  repo: "org/repo",
  commitSha: FULL_SHA,
  ref: "refs/heads/main",
  sarifJson: '{"version":"2.1.0","runs":[]}',
};

Deno.test("uploadSecuritySarif - posts gzipped sarif and returns the id", async () => {
  let captured: { args: string[]; stdin?: string } | null = null;
  const ghExec: GhExec = (args, stdin) => {
    captured = { args, stdin };
    return Promise.resolve('{"id":"sarif-123","url":"https://api"}');
  };
  const result = await uploadSecuritySarif(UPLOAD_OPTS, ghExec);
  assertEquals(result, { kind: "uploaded", id: "sarif-123" });
  assert(captured);
  const call = captured as { args: string[]; stdin?: string };
  assertEquals(call.args[0], "api");
  assert(call.args.includes("repos/org/repo/code-scanning/sarifs"));
  // The stdin body carries commit_sha, ref, and a gzipped base64 sarif.
  const body = JSON.parse(call.stdin ?? "{}");
  assertEquals(body.commit_sha, FULL_SHA);
  assertEquals(body.ref, "refs/heads/main");
  assertStringIncludes(body.sarif, "H4sI");
});

Deno.test("uploadSecuritySarif - 403 surfaces code-scanning-unavailable", async () => {
  const ghExec: GhExec = () =>
    Promise.reject(new Error("gh: Code Security must be enabled (HTTP 403)"));
  const result = await uploadSecuritySarif(UPLOAD_OPTS, ghExec);
  assertEquals(result.kind, "code-scanning-unavailable");
  if (result.kind === "code-scanning-unavailable") {
    assertEquals(result.status, 403);
  }
});

Deno.test("uploadSecuritySarif - 404 surfaces code-scanning-unavailable", async () => {
  const ghExec: GhExec = () =>
    Promise.reject(new Error("gh: Not Found (HTTP 404)"));
  const result = await uploadSecuritySarif(UPLOAD_OPTS, ghExec);
  assertEquals(result.kind, "code-scanning-unavailable");
  if (result.kind === "code-scanning-unavailable") {
    assertEquals(result.status, 404);
  }
});

Deno.test("uploadSecuritySarif - other failure surfaces a hard error (never silent)", async () => {
  const ghExec: GhExec = () =>
    Promise.reject(new Error("gh: server error (HTTP 500)"));
  const result = await uploadSecuritySarif(UPLOAD_OPTS, ghExec);
  assertEquals(result.kind, "error");
  if (result.kind === "error") assertStringIncludes(result.error, "500");
});

Deno.test("uploadSecuritySarif - rejects an invalid repo slug before any gh call", async () => {
  let called = false;
  const ghExec: GhExec = () => {
    called = true;
    return Promise.resolve("{}");
  };
  const result = await uploadSecuritySarif(
    { ...UPLOAD_OPTS, repo: "not a slug" },
    ghExec,
  );
  assertEquals(result.kind, "error");
  assert(!called, "must not invoke gh with an invalid slug");
});

Deno.test("uploadSecuritySarif - rejects a non-40-hex commit sha", async () => {
  const ghExec: GhExec = () => Promise.resolve("{}");
  const result = await uploadSecuritySarif(
    { ...UPLOAD_OPTS, commitSha: "abc" },
    ghExec,
  );
  assertEquals(result.kind, "error");
});
