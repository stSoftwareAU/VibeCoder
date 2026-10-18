/**
 * CLI for `deno task pr-summary-ci` (Issue #3768).
 *
 * Usage: pr-summary-ci --base <branch> --head-branch <name>
 *
 * Exit codes: 0 nothing blocked (a not-checked summary is reported, never
 * passed), 1 the summary is stale or missing, or a gate blocked, 2 bad args
 * or git/IO failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { runGitCommand } from "./git_timeout.ts";
import { ciFailed, formatCiReport, runPrSummaryCi } from "./pr_summary_ci.ts";

const USAGE = "usage: pr-summary-ci --base <branch> --head-branch <name>";

/** Parsed command line. */
export interface CliArgs {
  baseBranch: string;
  headBranch: string;
}

/** Parse argv (without the program name). */
export function parseArgs(argv: string[]): Result<CliArgs, Error> {
  let baseBranch: string | null = null;
  let headBranch: string | null = null;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base" || arg === "--head-branch") {
      const value = argv[i + 1];
      // A value that is empty or looks like a flag is a missing value: git
      // would read it as an option, and the ref guard throws rather than
      // returning an error.
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        return {
          ok: false,
          error: new Error(`${arg} needs a value. ${USAGE}`),
        };
      }
      i++;
      if (arg === "--base") baseBranch = value;
      else headBranch = value;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: new Error(`unknown flag ${arg}. ${USAGE}`) };
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    return {
      ok: false,
      error: new Error(`unexpected argument ${positionals[0]}. ${USAGE}`),
    };
  }
  if (baseBranch === null) {
    return { ok: false, error: new Error(`--base is required. ${USAGE}`) };
  }
  if (headBranch === null) {
    return {
      ok: false,
      error: new Error(`--head-branch is required. ${USAGE}`),
    };
  }
  return { ok: true, value: { baseBranch, headBranch } };
}

/** Injected effects, so the entry is testable without a process. */
export interface CliDeps {
  readTextFile: (path: string) => Promise<string>;
  runGit: GitRunner;
  repoRoot: () => Promise<Result<string>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Run the check; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    deps.stderr(args.error.message);
    return 2;
  }

  const root = await deps.repoRoot();
  if (!root.ok) {
    deps.stderr(`cannot find the repository root: ${root.error.message}`);
    return 2;
  }

  const checked = await runPrSummaryCi({
    baseBranch: args.value.baseBranch,
    headBranch: args.value.headBranch,
    runGit: deps.runGit,
    repoRoot: root.value,
    readTextFile: deps.readTextFile,
  });
  if (!checked.ok) {
    deps.stderr(checked.error.message);
    return 2;
  }

  deps.stdout(formatCiReport(checked.value));
  return ciFailed(checked.value) ? 1 : 0;
}

if (import.meta.main) {
  installConsoleRedaction();
  const code = await main(Deno.args, {
    readTextFile: (path) => Deno.readTextFile(path),
    runGit: runGitCommand,
    repoRoot: async () => {
      const r = await runGitCommand(["rev-parse", "--show-toplevel"]);
      if (!r.ok) return r;
      if (r.value.code !== 0) {
        return { ok: false, error: new Error(r.value.stderr.trim()) };
      }
      return { ok: true, value: r.value.stdout.trim() };
    },
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  Deno.exit(code);
}
