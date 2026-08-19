/**
 * Tests for the main module entry point.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 *
 * Issue #223: execute() now returns Result<CommandResult> — updated the
 * version command integration test to unwrap the Result.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDefaultRegistry, parseArgs } from "../mod.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Command } from "../types.ts";

Deno.test("mod - parseArgs returns help for empty args", () => {
  const result = parseArgs([]);
  assertEquals(result.command, "help");
  assertEquals(result.args, {});
});

Deno.test("mod - parseArgs extracts command name", () => {
  const result = parseArgs(["version"]);
  assertEquals(result.command, "version");
  assertEquals(result.args, {});
});

Deno.test("mod - parseArgs extracts string arguments", () => {
  const result = parseArgs([
    "assess-clarity",
    "--title",
    "Fix bug",
    "--body",
    "Description",
  ]);
  assertEquals(result.command, "assess-clarity");
  assertEquals(result.args.title, "Fix bug");
  assertEquals(result.args.body, "Description");
});

Deno.test("mod - parseArgs handles flags without values", () => {
  const result = parseArgs(["command", "--verbose", "--debug"]);
  assertEquals(result.command, "command");
  assertEquals(result.args.verbose, true);
  assertEquals(result.args.debug, true);
});

Deno.test("mod - parseArgs handles JSON array arguments", () => {
  const result = parseArgs(["command", "--labels", '["bug","help wanted"]']);
  assertEquals(result.command, "command");
  assertEquals(result.args.labels, ["bug", "help wanted"]);
});

Deno.test("mod - createDefaultRegistry includes version command", () => {
  const registry = createDefaultRegistry();
  assertEquals(registry.has("version"), true);
});

Deno.test("mod - createDefaultRegistry includes assess-clarity command", () => {
  const registry = createDefaultRegistry();
  assertEquals(registry.has("assess-clarity"), true);
});

Deno.test("mod - version command returns version info", async () => {
  const registry = createDefaultRegistry();
  const config = buildDefaultWorkerConfig({
    allowedAuthors: ["test"],
    allowedAuthor: "test",
    prReviewer: "test",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    workDir: "/tmp",
  });

  // Issue #223: execute() returns Result<CommandResult>
  const result = await registry.execute("version", {}, config);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.success, true);
    assertStringIncludes(result.value.message, "Vibe Coder Worker");
    assertStringIncludes(result.value.message, "1.0.0");
  }
});

// =============================================================================
// Additional parseArgs edge cases (Issue #218)
// =============================================================================

Deno.test("mod - parseArgs handles flag at end of args", () => {
  const result = parseArgs(["command", "--title", "value", "--verbose"]);
  assertEquals(result.command, "command");
  assertEquals(result.args.title, "value");
  assertEquals(result.args.verbose, true);
});

Deno.test("mod - parseArgs handles JSON object arguments", () => {
  const result = parseArgs(["command", "--data", '{"key":"value","num":42}']);
  assertEquals(result.command, "command");
  assertEquals(result.args.data, { key: "value", num: 42 });
});

Deno.test("mod - parseArgs handles numeric string as plain string", () => {
  // JSON.parse("42") succeeds and returns number, so this gets parsed as a number
  const result = parseArgs(["command", "--count", "42"]);
  assertEquals(result.command, "command");
  assertEquals(result.args.count, 42);
});

Deno.test("mod - parseArgs handles flag-like value with preceding flag", () => {
  // "--body" followed by "--not-a-flag" - the second is treated as a flag
  const result = parseArgs(["command", "--verbose", "--debug"]);
  assertEquals(result.args.verbose, true);
  assertEquals(result.args.debug, true);
});

Deno.test("mod - parseArgs treats non-dash args after command as ignored", () => {
  // Only --key value pairs are parsed, not positional args after command
  const result = parseArgs(["command", "positional"]);
  assertEquals(result.command, "command");
  // "positional" doesn't start with -- so it's skipped in the loop
  assertEquals(Object.keys(result.args).length, 0);
});

Deno.test("mod - parseArgs preserves empty string values", () => {
  const result = parseArgs(["command", "--title", ""]);
  assertEquals(result.command, "command");
  // Empty string is a valid value (e.g., --work-dir "" when WORK_DIR is unset)
  assertEquals(result.args.title, "");
});

// =============================================================================
// createDefaultRegistry additional checks (Issue #218)
// =============================================================================

Deno.test("mod - createDefaultRegistry includes suggest-improvements command", () => {
  const registry = createDefaultRegistry();
  assertEquals(registry.has("suggest-improvements"), true);
});

Deno.test("mod - createDefaultRegistry has all built-in commands registered", () => {
  const registry = createDefaultRegistry();
  const commands = registry.list();
  // Issue #2403/#2431 added `bulk-triage-security` (count 99 → 100);
  // Issue #2405 added `backlog-report` (count 100 → 101);
  // Issue #2578 added `process-add-repo` (count 101 → 102);
  // Issue #2691 added `notify-audit-failure` (count 102 → 103);
  // Issue #2870 added `create-all-idle-task-wrappers` (count 103 → 104);
  // Issue #2933 added `raise-boy-scout-idle-tasks` (count 104 → 105);
  // Issue #2941 added `resolve-cross-repo-dep` (count 105 → 106);
  // Issue #3129 removed `shellcheck-fix` (count 106 → 105).
  // Issue #3196 added `raise-all-idle-tasks` (count 105 → 106).
  // Issue #3320 added `raise-single-idle-task` (count 106 → 107).
  // Issue #3501 added `run-bootstrap` (count 107 → 108).
  // Issue #3502 added `run-housekeeping` (count 108 → 109).
  // Issue #3583 added `check-jenkins-access` (count 109 → 110).
  // Issue #3712 added `audit-chain-verify` (count 110 → 111).
  // Issue #3755 added `sweep-heartbeat-comments` (count 111 → 112).
  // Issue #3860 added `process-seed-idle-tasks` (count 112 → 113).
  // Issue #3864 added `idle-task-freshness` (count 113 → 114).
  // Issue #3939 removed the orphaned `pr-completion-phase` (count 114 → 113).
  // Issue #4062 added `container-image-hash` (count 113 → 114).
  // Issue #4063 added `container-runtime-detect` (count 114 → 115).
  // Issue #4065 added `container-launch-plan` (count 115 → 116).
  // Issue #4072 added `container-restart-backoff` (count 116 → 117).
  // Issue #4146 added `run-mode` (count 117 → 118).
  // Issue #4173 added `container-reap` (count 118 → 119).
  // Issue #4162 added `container-image-prune` (count 119 → 120).
  // Issue #4302 added `deno-cache-guard` (count 120 → 121).
  // Issue #4299 added `benchmark` (count 121 → 122).
  // Issue #4300 added `seatbelt-profile` (count 122 → 123).
  // Issue #4356 added `audit-default-branch-rulesets` (count 123 → 124).
  // Issue #4189 added `green-gate-report` (count 124 → 125).
  // Issue #4393 added `strip-containerfile` (count 125 → 126).
  // Issues #4397/#4398/#4401 added `repo-settings-harden` (count 126 → 127).
  // Keep this assertion in step with the registry.
  // Issue #4190 added `secrets-history-scan` (count 127 → 128).
  // Issue #4194 added `security-tabletop` (count 128 → 129).
  // Issue #4200 added `publish-decision-check` (count 129 → 130).
  // Issue #4192 added `supply-chain-gate` (count 130 → 131).
  // Issue #4193 added `security-tree-sweep` (count 131 → 132).
  // Issues #4196/#4197 added `export-scrub-gate` + `export-branding` (132 → 134).
  // Issues #4196/#4197 added `export-redact` (134 → 135).
  // Issues #4197/#4198 added `export-links` (135 → 136).
  assertEquals(commands.length, 136);
  assertEquals(commands.includes("security-tree-sweep"), true);
  assertEquals(commands.includes("green-gate-report"), true);
  assertEquals(commands.includes("security-tabletop"), true);
  assertEquals(commands.includes("deno-cache-guard"), true);
  assertEquals(commands.includes("benchmark"), true);
  assertEquals(commands.includes("seatbelt-profile"), true);
  assertEquals(commands.includes("container-image-hash"), true);
  assertEquals(commands.includes("container-runtime-detect"), true);
  assertEquals(commands.includes("container-launch-plan"), true);
  assertEquals(commands.includes("container-restart-backoff"), true);
  assertEquals(commands.includes("container-reap"), true);
  assertEquals(commands.includes("container-image-prune"), true);
  assertEquals(commands.includes("run-mode"), true);
  assertEquals(commands.includes("idle-task-freshness"), true);
  assertEquals(commands.includes("process-seed-idle-tasks"), true);
  assertEquals(commands.includes("audit-chain-verify"), true);
  assertEquals(commands.includes("sweep-heartbeat-comments"), true);
  assertEquals(commands.includes("check-jenkins-access"), true);
  assertEquals(commands.includes("run-bootstrap"), true);
  assertEquals(commands.includes("run-housekeeping"), true);
  assertEquals(commands.includes("bulk-triage-security"), true);
  assertEquals(commands.includes("backlog-report"), true);
  assertEquals(commands.includes("process-add-repo"), true);
  assertEquals(commands.includes("resolve-cross-repo-dep"), true);
  assertEquals(commands.includes("notify-audit-failure"), true);
  assertEquals(commands.includes("create-all-idle-task-wrappers"), true);
  assertEquals(commands.includes("raise-boy-scout-idle-tasks"), true);
  assertEquals(commands.includes("raise-all-idle-tasks"), true);
  assertEquals(commands.includes("raise-single-idle-task"), true);
  assertEquals(commands.includes("collect-security-batch"), true);
  assertEquals(commands.includes("run-id"), true);
  assertEquals(commands.includes("diagnose"), true);
  assertEquals(commands.includes("grill-me-processor"), true);
  assertEquals(commands.includes("version"), true);
  assertEquals(commands.includes("stale-workdir"), true);
  assertEquals(commands.includes("worktree-cleanup"), true);
  assertEquals(commands.includes("claude-tail-cleanup"), true);
  assertEquals(commands.includes("session-sweep"), true);
  assertEquals(commands.includes("assess-clarity"), true);
  assertEquals(commands.includes("suggest-improvements"), true);
  assertEquals(commands.includes("check-parent-deps"), true);
  assertEquals(commands.includes("check-repo-availability"), true);
  assertEquals(commands.includes("maybe-file-idle-task"), true);
  assertEquals(commands.includes("backfill-idle-task-labels"), true);
  assertEquals(commands.includes("check-pages-liquid"), true);
  assertEquals(commands.includes("check-mermaid"), true);
  assertEquals(commands.includes("merge-if-checks-passed"), true);
  assertEquals(commands.includes("worker-identity"), true);
  assertEquals(commands.includes("terminal-title"), true);
  assertEquals(commands.includes("disk-space"), true);
  assertEquals(commands.includes("clean-deno-cache"), true);
  assertEquals(commands.includes("log-rotation"), true);
  assertEquals(commands.includes("worker-log-cleanup"), true);
  assertEquals(commands.includes("self-heal-summary"), true);
  assertEquals(commands.includes("path-bootstrap"), true);
  assertEquals(commands.includes("security"), true);
  assertEquals(commands.includes("run-security-scan"), true);
  assertEquals(commands.includes("pid-guard"), true);
  assertEquals(commands.includes("load-config"), true);
  assertEquals(commands.includes("gh-auth"), true);
  assertEquals(commands.includes("gh-wrapper"), true);
  assertEquals(commands.includes("github-status"), true);
  assertEquals(commands.includes("feature-availability"), true);
  assertEquals(commands.includes("circuit-breaker"), true);
  assertEquals(commands.includes("failure-tracker"), true);
  assertEquals(commands.includes("cooldown-state"), true);
  assertEquals(commands.includes("failure-diagnosis"), true);
  assertEquals(commands.includes("repo-failure-tracker"), true);
  assertEquals(commands.includes("crash-cleanup"), true);
  assertEquals(commands.includes("crash-notification"), true);
  assertEquals(commands.includes("stuck-issue-detector"), true);
  assertEquals(commands.includes("repo-blocked-alert"), true);
  assertEquals(commands.includes("claim-issue"), true);
  assertEquals(commands.includes("label-manager"), true);
  assertEquals(commands.includes("find-issues"), true);
  assertEquals(commands.includes("find-issues-by-label"), true);
  assertEquals(commands.includes("fetch-issue-data"), true);
  assertEquals(commands.includes("health-check-cache"), true);
  assertEquals(commands.includes("shuffle-repos"), true);
  assertEquals(commands.includes("software-updates"), true);
  assertEquals(commands.includes("atomic-write"), true);
  assertEquals(commands.includes("cleanup-stale-temp-files"), true);
  assertEquals(commands.includes("git-operations"), true);
  assertEquals(commands.includes("branch-cleanup"), true);
  assertEquals(commands.includes("prompt-builder"), true);
  assertEquals(commands.includes("prompt-manager"), true);
  assertEquals(commands.includes("comment-filter"), true);
  assertEquals(commands.includes("question-clarification"), true);
  assertEquals(commands.includes("mermaid-validator"), true);
  assertEquals(commands.includes("pr-manager"), true);
  assertEquals(commands.includes("quality-helpers"), true);
  assertEquals(commands.includes("run-entrypoint"), true);
  assertEquals(commands.includes("repo-config"), true);
  assertEquals(commands.includes("refinement-processor"), true);
  assertEquals(commands.includes("revision-processor"), true);
  assertEquals(commands.includes("planning-processor"), true);
  assertEquals(commands.includes("question-processor"), true);
  assertEquals(commands.includes("credit-summary"), true);
  assertEquals(commands.includes("sync-milestone-branches"), true);
  assertEquals(commands.includes("clarity-phase"), true);
  assertEquals(commands.includes("quality-gate-phase"), true);
  assertEquals(commands.includes("execute-claude-phase"), true);
  assertEquals(commands.includes("work-on-issue"), true);
  assertEquals(commands.includes("purge-stale-workflow-issues"), true);
  assertEquals(commands.includes("audit-default-branch-rulesets"), true);
  assertEquals(commands.includes("secrets-history-scan"), true);
});

/**
 * Structural test for a runtime Command object: a string `name`, a string
 * `description`, and an `execute` function. Used to discover the real
 * command(s) exported by each module rather than parsing source text.
 */
function isCommandLike(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.execute === "function"
  );
}

Deno.test("mod - every command file in commands/ is registered in the registry", async () => {
  // Quality gate: prevents regressions where a command file is created during
  // migration but not wired into mod.ts. This was the root cause of the
  // find-issues regression that blocked all work pickup.
  //
  // Issue #2689: rewritten to verify behaviour. Each command module is
  // imported and its real exported `name` value is checked against the
  // live registry — no source-text grep. This survives declaration-syntax
  // refactors (renaming the `name:` field, building the value from a
  // constant, splitting the call across lines) that the previous regex
  // would silently miss.
  const registry = createDefaultRegistry();
  const registeredCommands = registry.list();

  const commandsDir = new URL("../commands/", import.meta.url);
  const unregistered: string[] = [];

  for await (const entry of Deno.readDir(commandsDir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // Skip test files
    if (entry.name.endsWith("_test.ts")) continue;

    // Import the module and inspect its real exports for Command objects.
    const moduleUrl = new URL(entry.name, commandsDir).href;
    const mod: Record<string, unknown> = await import(moduleUrl);

    for (const exported of Object.values(mod)) {
      if (!isCommandLike(exported)) continue;
      if (!registeredCommands.includes(exported.name)) {
        unregistered.push(`${entry.name} (command: "${exported.name}")`);
      }
    }
  }

  assertEquals(
    unregistered.length,
    0,
    `Unregistered commands found — add them to createDefaultRegistry() in mod.ts:\n  ${
      unregistered.join("\n  ")
    }`,
  );
});

Deno.test("mod - createDefaultRegistry commands have descriptions", () => {
  const registry = createDefaultRegistry();
  const descriptions = registry.listWithDescriptions();

  for (const { description } of descriptions) {
    assertEquals(typeof description, "string");
    assertEquals(description.length > 0, true);
  }
});
