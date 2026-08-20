/**
 * Repo config command for the Vibe Coder worker (Issue #964).
 *
 * Exposes per-repo configuration utilities to shell scripts via the Deno CLI
 * (`deno run mod.ts <command>`). Operations include config queries, quality
 * instructions, reviewer flags, default branch lookup, and
 * pre-setup command execution.
 */

import type {
  Command,
  CommandResult,
  ConfigFile,
  WorkerConfig,
} from "../types.ts";
import {
  buildQualityInstructions,
  buildReviewerFlags,
  buildReviewerFlagsForRepo,
  getCustomInstructions,
  getRepoConfig,
  runPreSetupCommand,
} from "../lib/repo_config.ts";
import { getRepoDefaultBranch } from "../lib/shell_helpers.ts";

/**
 * Load repo_config from the config file path.
 *
 * @param configPath - Path to .config.json
 * @returns The repo_config map, or undefined
 */
async function loadRepoConfigs(
  configPath: string | undefined,
): Promise<ConfigFile["repo_config"]> {
  if (!configPath) return undefined;
  try {
    const content = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(content) as ConfigFile;
    return parsed.repo_config;
  } catch {
    return undefined;
  }
}

export const repoConfigCommand: Command = {
  name: "repo-config",
  description:
    "Per-repo configuration utilities — queries, quality, reviewers (Issue #964)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");
    const repo = String(args["repo"] ?? "");
    const configPath = args["config-path"] as string | undefined;

    // Load repo configs from file for operations that need them
    const repoConfigs = await loadRepoConfigs(configPath);

    switch (operation) {
      case "get-config": {
        const key = String(args["key"] ?? "");
        if (!repo || !key) {
          return {
            success: false,
            message: "Missing --repo or --key argument",
          };
        }
        const value = getRepoConfig(
          repoConfigs,
          repo,
          key as keyof import("../types.ts").RepoConfig,
        );
        return { success: true, message: value };
      }

      case "get-custom-instructions": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const instructions = getCustomInstructions(repoConfigs, repo);
        return { success: true, message: instructions };
      }

      case "get-default-branch": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const result = await getRepoDefaultBranch(repo);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      case "build-quality-instructions": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const instructions = buildQualityInstructions(repoConfigs, repo);
        return { success: true, message: instructions };
      }

      case "build-reviewer-flags": {
        const flags = buildReviewerFlags(config.prReviewers);
        return { success: true, message: flags };
      }

      case "build-reviewer-flags-for-repo": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const flags = buildReviewerFlagsForRepo(
          repoConfigs,
          repo,
          config.prReviewers,
        );
        return { success: true, message: flags };
      }

      case "run-pre-setup": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const repoPath = String(args["repo-path"] ?? "");
        if (!repoPath) {
          return { success: false, message: "Missing --repo-path argument" };
        }
        const timeout = typeof args["timeout"] === "number"
          ? args["timeout"]
          : 300;
        const result = await runPreSetupCommand(
          repo,
          repoPath,
          repoConfigs,
          timeout,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: result.value };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid operations: get-config, get-custom-instructions, get-default-branch, build-quality-instructions, build-reviewer-flags, build-reviewer-flags-for-repo, run-pre-setup`,
        };
    }
  },
};
