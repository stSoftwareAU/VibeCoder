/**
 * Tests for the version command module.
 *
 * Following TDD: These tests verify the version command behaviour.
 * Issue #218 — Every TypeScript source file should have a corresponding test file.
 * Issue #226 — Version is sourced from deno.json at runtime.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { VERSION, versionCommand } from "../commands/version.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

Deno.test("version - VERSION is included in command output (Issue #226)", async () => {
  const result = await versionCommand.execute({}, createMockConfig());
  assertEquals(result.success, true);
  assertStringIncludes(result.message, VERSION);
  const data = result.data as Record<string, unknown>;
  assertEquals(data.version, VERSION);
});

Deno.test("version - VERSION is a valid semver string", () => {
  const semverPattern = /^\d+\.\d+\.\d+$/;
  assertEquals(semverPattern.test(VERSION), true);
});

Deno.test("version - command has correct name", () => {
  assertEquals(versionCommand.name, "version");
});

Deno.test("version - command has a description", () => {
  assertEquals(typeof versionCommand.description, "string");
  assertEquals(versionCommand.description.length > 0, true);
});

Deno.test("version - execute returns success", async () => {
  const result = await versionCommand.execute({}, createMockConfig());
  assertEquals(result.success, true);
});

Deno.test("version - execute message includes version number", async () => {
  const result = await versionCommand.execute({}, createMockConfig());
  assertStringIncludes(result.message, VERSION);
});

Deno.test("version - execute message includes worker name", async () => {
  const result = await versionCommand.execute({}, createMockConfig());
  assertStringIncludes(result.message, "Vibe Coder Worker");
});

Deno.test("version - execute returns runtime data", async () => {
  const result = await versionCommand.execute({}, createMockConfig());
  const data = result.data as Record<string, unknown>;
  assertEquals(data.runtime, "Deno");
  assertEquals(data.version, VERSION);
  assertEquals(typeof data.denoVersion, "string");
  assertEquals(typeof data.v8Version, "string");
  assertEquals(typeof data.typescriptVersion, "string");
});

Deno.test("version - execute ignores args parameter", async () => {
  const result = await versionCommand.execute(
    { unknown: "arg", verbose: true },
    createMockConfig(),
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, VERSION);
});

Deno.test("version - execute ignores config parameter", async () => {
  const emptyConfig: WorkerConfig = buildDefaultWorkerConfig({
    allowedAuthors: [],
    allowedAuthor: "",
    prReviewer: "",
    repos: [],
    issueLabels: [],
    workOnLabel: "",
    failedOnceLabel: "",
    failedLabel: "",
    refineIssueLabel: "",
    workDir: "",
    claudeTimeout: 0,
    maxClarificationRounds: 0,
    claudeModel: "",
  }) as WorkerConfig;

  const result = await versionCommand.execute({}, emptyConfig);
  assertEquals(result.success, true);
});
