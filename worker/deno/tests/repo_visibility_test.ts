/**
 * Tests for repo_visibility.ts — GitHub repository visibility detection.
 *
 * Issue #1752: Add repository visibility detection library.
 */

import { assertEquals } from "@std/assert";
import {
  type CommandOutput,
  getRepoVisibility,
  isRepoPublic,
  type RepoVisibilityOptions,
} from "../lib/repo_visibility.ts";

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
}

function runner(
  output: CommandOutput,
): (cmd: string[]) => Promise<CommandOutput> {
  return (_cmd: string[]) => Promise.resolve(output);
}

Deno.test("repo_visibility - returns 'public' when gh reports public", async () => {
  const opts: RepoVisibilityOptions = { runCommand: runner(ok("public")) };
  const result = await getRepoVisibility("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, "public");
});

Deno.test("repo_visibility - returns 'private' when gh reports private", async () => {
  const opts: RepoVisibilityOptions = { runCommand: runner(ok("private")) };
  const result = await getRepoVisibility("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, "private");
});

Deno.test("repo_visibility - returns Result.err when gh fails", async () => {
  const opts: RepoVisibilityOptions = {
    runCommand: runner(fail("HTTP 404: Not Found")),
  };
  const result = await getRepoVisibility("owner/repo", opts);
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(typeof result.error, "string");
  assertEquals(result.error.length > 0, true);
});

Deno.test("repo_visibility - unknown visibility string defaults to 'private' (fail-safe)", async () => {
  const opts: RepoVisibilityOptions = { runCommand: runner(ok("internal")) };
  const result = await getRepoVisibility("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, "private");
});

Deno.test("repo_visibility - empty visibility string defaults to 'private' (fail-safe)", async () => {
  const opts: RepoVisibilityOptions = { runCommand: runner(ok("")) };
  const result = await getRepoVisibility("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, "private");
});

Deno.test("repo_visibility - calls gh REST API (not GraphQL) with --jq filter", async () => {
  let capturedCmd: string[] = [];
  const opts: RepoVisibilityOptions = {
    runCommand: (cmd: string[]) => {
      capturedCmd = cmd;
      return Promise.resolve(ok("public"));
    },
  };
  const result = await getRepoVisibility("owner/repo", opts);
  assertEquals(result.ok, true);
  assertEquals(capturedCmd[0], "gh");
  assertEquals(capturedCmd[1], "api");
  assertEquals(capturedCmd[2], "repos/owner/repo");
  // Must use --jq to extract .visibility
  assertEquals(capturedCmd.includes("--jq"), true);
  const jqIdx = capturedCmd.indexOf("--jq");
  assertEquals(capturedCmd[jqIdx + 1], ".visibility");
});

Deno.test("isRepoPublic - true only when the lookup resolves 'public'", async () => {
  let capturedArgs: string[] = [];
  const result = await isRepoPublic("owner/repo", (args) => {
    capturedArgs = args;
    return Promise.resolve("public\n");
  });
  assertEquals(result, true);
  // The leading "gh" is stripped: ghFn receives only the gh arguments.
  assertEquals(capturedArgs, [
    "api",
    "repos/owner/repo",
    "--jq",
    ".visibility",
  ]);
});

Deno.test("isRepoPublic - false for a private repository", async () => {
  assertEquals(
    await isRepoPublic("owner/repo", () => Promise.resolve("private")),
    false,
  );
});

Deno.test("isRepoPublic - false for an unrecognised visibility (fail-safe)", async () => {
  assertEquals(
    await isRepoPublic("owner/repo", () => Promise.resolve("internal")),
    false,
  );
});

Deno.test("isRepoPublic - false when the gh call rejects with an Error", async () => {
  assertEquals(
    await isRepoPublic("owner/repo", () => Promise.reject(new Error("boom"))),
    false,
  );
});

Deno.test("isRepoPublic - false when the gh call rejects with a non-Error", async () => {
  assertEquals(
    await isRepoPublic("owner/repo", () => Promise.reject("boom")),
    false,
  );
});
