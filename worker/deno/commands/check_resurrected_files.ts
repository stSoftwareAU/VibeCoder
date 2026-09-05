/**
 * check-resurrected-files command (Issue #1048).
 *
 * Fails when a branch carries a file the default branch deleted and whose
 * deleting commit is already in the branch's ancestry — the signature of a
 * modify/delete conflict resolved by keeping the file.
 *
 * Usage:
 *   deno run --allow-read --allow-run --allow-env mod.ts check-resurrected-files \
 *     [--branch HEAD] [--default-branch main] [--repo-dir .]
 *
 * Exits non-zero, naming every file and the commit that deleted it, so the
 * gate on a milestone PR says exactly what came back and where it went.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  findResurrectedFiles,
  formatResurrectionReport,
  type ResurrectionReport,
} from "../lib/resurrected_file_check.ts";

/** Read a string argument, falling back when it is absent or not a string. */
function stringArg(
  args: Record<string, unknown>,
  name: string,
  fallback: string,
): string {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export const checkResurrectedFilesCommand: Command = {
  name: "check-resurrected-files",
  description:
    "Fail when a branch revives a file the default branch deleted (Issue #1048)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ResurrectionReport>> {
    const cwd = stringArg(args, "repo-dir", Deno.cwd());
    const branch = stringArg(args, "branch", "HEAD");
    const defaultBranch = stringArg(args, "default-branch", "main");

    const result = await findResurrectedFiles(
      branch,
      defaultBranch,
      async (gitArgs) => {
        const run = await runGitCommand(gitArgs, { cwd });
        // A runner that could not start git is a failure, never a clean
        // answer — report it as a non-zero exit with git's own message.
        return run.ok
          ? run.value
          : { code: 127, stdout: "", stderr: run.error.message };
      },
    );

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    return {
      success: result.value.resurrected.length === 0,
      message: formatResurrectionReport(result.value),
      data: result.value,
    };
  },
};
