/**
 * `resolve-cross-repo-dep` command (Issue #2941).
 *
 * Thin CLI wrapper over {@link resolveCrossRepoTarget} so an operator can
 * dry-run the resolve + reachability probe for a dependency spec without any
 * side effects (no clone, no PR). It answers the first half of the cross-repo
 * fix capability: "is this dep an internal `stSoftwareAU/*` repo the worker can
 * clone and open a PR against?".
 *
 * The PR-raising half ({@link openCrossRepoFixPr}) needs an `applyFix` callback
 * and therefore lives in the library only — it is driven from the consuming
 * issue-fix flow, not the CLI.
 *
 * Usage:
 *   deno run … mod.ts resolve-cross-repo-dep --package jsr:@stsoftware/neat-ai
 *
 * Australian English used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type CommandOutput,
  type CrossRepoTarget,
  resolveCrossRepoTarget,
  type RunCommand,
} from "../lib/cross_repo_fix.ts";
import { spawnGh } from "../lib/gh_spawn.ts";

/**
 * Default command runner using `Deno.Command`.
 *
 * Issue #3703: a `gh` command is delegated to the shared chokepoint so the
 * cross-repo PR it opens is allowlist-checked and journalled.
 */
const defaultRunCommand: RunCommand = async (
  cmd: string[],
): Promise<CommandOutput> => {
  if (cmd[0] === "gh") {
    const result = await spawnGh(cmd.slice(1));
    return {
      success: result.success,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }
  const command = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
};

/** Typed data returned by the command. */
export interface ResolveCrossRepoDepData {
  package: string;
  target: CrossRepoTarget;
}

export const resolveCrossRepoDepCommand: Command = {
  name: "resolve-cross-repo-dep",
  description:
    "Resolve a dependency spec to its stSoftwareAU repo and probe whether the " +
    "worker can clone + open a PR there (Issue #2941). Dry-run, no side effects.",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<ResolveCrossRepoDepData>> {
    const pkg = String(args["package"] ?? "");
    if (pkg.length === 0) {
      return {
        success: false,
        message: "Missing required argument: --package",
      };
    }

    const runner: RunCommand =
      (args["__testRunner"] as RunCommand | undefined) ?? defaultRunCommand;

    const target = await resolveCrossRepoTarget(pkg, runner);

    const message = target.kind === "internal-reachable"
      ? `internal-reachable: ${pkg} -> ${target.repo} (can clone + open a PR)`
      : `external: ${pkg} (${target.reason})`;

    return { success: true, message, data: { package: pkg, target } };
  },
};
