/**
 * Tests for the `issue_executor_split` config key and its resolver
 * (Issue #2341).
 *
 * The key is registered host-wide with a per-repository override under
 * `repo_config`, defaults to `false`, and resolves only for the `issue`
 * phase. Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isIssueExecutorSplitEnabled } from "../lib/issue_executor_split.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { validateConfigFileJson } from "../lib/validation.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { RepoConfig } from "../types.ts";

const OFF = { issueExecutorSplit: false };
const ON = { issueExecutorSplit: true };

Deno.test("issue_executor_split - defaults to disabled for the issue phase", () => {
  assertEquals(isIssueExecutorSplitEnabled("issue", undefined, OFF), false);
});

Deno.test("issue_executor_split - buildDefaultWorkerConfig defaults the key to false", () => {
  assertEquals(buildDefaultWorkerConfig().issueExecutorSplit, false);
});

Deno.test("issue_executor_split - host-wide true enables the issue phase", () => {
  assertEquals(isIssueExecutorSplitEnabled("issue", undefined, ON), true);
});

Deno.test("issue_executor_split - every other phase resolves false", () => {
  for (const phase of ["planning", "pr_feedback", "ci_fix", "health", ""]) {
    assertEquals(
      isIssueExecutorSplitEnabled(phase, undefined, ON),
      false,
      `${phase} must never enable the split`,
    );
    assertEquals(
      isIssueExecutorSplitEnabled(phase, { issueExecutorSplit: true }, ON),
      false,
      `${phase} must never enable the split from repo_config either`,
    );
  }
  assertEquals(isIssueExecutorSplitEnabled(undefined, undefined, ON), false);
});

Deno.test("issue_executor_split - per-repo false beats a host-wide true", () => {
  assertEquals(
    isIssueExecutorSplitEnabled("issue", { issueExecutorSplit: false }, ON),
    false,
  );
});

Deno.test("issue_executor_split - per-repo true beats a host-wide false or unset", () => {
  assertEquals(
    isIssueExecutorSplitEnabled("issue", { issueExecutorSplit: true }, OFF),
    true,
  );
  assertEquals(
    isIssueExecutorSplitEnabled(
      "issue",
      { issueExecutorSplit: true },
      {} as { issueExecutorSplit: boolean },
    ),
    true,
  );
});

Deno.test("issue_executor_split - a repo entry without the key falls through to the host", () => {
  const repoConfig: RepoConfig = { skipQualityCheck: true };
  assertEquals(isIssueExecutorSplitEnabled("issue", repoConfig, ON), true);
  assertEquals(isIssueExecutorSplitEnabled("issue", repoConfig, OFF), false);
});

Deno.test("issue_executor_split - a non-boolean repo value is refused loudly", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
  try {
    const repoConfig = { issueExecutorSplit: "yes" } as unknown as RepoConfig;
    assertEquals(isIssueExecutorSplitEnabled("issue", repoConfig, OFF), false);
    assertEquals(isIssueExecutorSplitEnabled("issue", repoConfig, ON), true);
  } finally {
    console.warn = original;
  }
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0] ?? "", "issue_executor_split");
});

Deno.test("issue_executor_split - is a recognised config key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("issue_executor_split"), true);
});

Deno.test("issue_executor_split - validateConfigFileJson accepts a boolean", () => {
  for (const issue_executor_split of [true, false]) {
    const result = validateConfigFileJson({ issue_executor_split });
    assertEquals(result.ok, true);
  }
});

Deno.test("issue_executor_split - validateConfigFileJson rejects a non-boolean", () => {
  const result = validateConfigFileJson({ issue_executor_split: "yes" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "issue_executor_split");
  }
});

Deno.test("issue_executor_split - documented in docs/CONFIGURATION.md", async () => {
  const docs = await Deno.readTextFile(
    new URL("../../../docs/CONFIGURATION.md", import.meta.url),
  );
  const rows = docs.split("\n").filter((line) =>
    line.startsWith("| `issue_executor_split`")
  );
  assert(
    rows.length >= 2,
    "CONFIGURATION.md must document the host-wide key and its repo_config override",
  );
});
