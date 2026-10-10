/**
 * CLI for `deno task pr-summary-check` (Issue #3423).
 *
 * Usage: pr-summary-check --base <branch> [--issue-body-file <path>]
 *          [--labels <a,b>] <summary-file>
 *
 * Exit codes: 0 no gate blocked, 1 a gate blocked, 2 bad args or git/IO
 * failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { runGitCommand } from "./git_timeout.ts";
import {
  formatReport,
  hasBlock,
  runPrSummaryCheck,
} from "./pr_summary_check.ts";

const USAGE = "usage: pr-summary-check --base <branch> " +
  "[--issue-body-file <path>] [--labels <a,b>] <summary-file>";

/** Parsed command line. */
export interface CliArgs {
  summaryFile: string;
  baseBranch: string;
  issueBodyFile: string | null;
  labels: string | null;
}

/** Parse argv (without the program name). */
export function parseArgs(argv: string[]): Result<CliArgs, Error> {
  let baseBranch: string | null = null;
  let issueBodyFile: string | null = null;
  let labels: string | null = null;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base" || arg === "--issue-body-file" || arg === "--labels") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: new Error(`${arg} needs a value. ${USAGE}`),
        };
      }
      i++;
      if (arg === "--base") baseBranch = value;
      else if (arg === "--labels") labels = value;
      else issueBodyFile = value;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: new Error(`unknown flag ${arg}. ${USAGE}`) };
    } else {
      positionals.push(arg);
    }
  }

  if (baseBranch === null) {
    return { ok: false, error: new Error(`--base is required. ${USAGE}`) };
  }
  if (positionals.length !== 1) {
    return {
      ok: false,
      error: new Error(
        `expected exactly one summary file, got ${positionals.length}. ${USAGE}`,
      ),
    };
  }
  return {
    ok: true,
    value: {
      summaryFile: positionals[0]!,
      baseBranch,
      issueBodyFile,
      labels,
    },
  };
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

  let summaryContent: string;
  let issueBody: string | null = null;
  try {
    summaryContent = await deps.readTextFile(args.value.summaryFile);
    if (args.value.issueBodyFile !== null) {
      issueBody = await deps.readTextFile(args.value.issueBodyFile);
    }
  } catch (error: unknown) {
    deps.stderr(
      `cannot read input file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }

  const root = await deps.repoRoot();
  if (!root.ok) {
    deps.stderr(`cannot find the repository root: ${root.error.message}`);
    return 2;
  }

  const checked = await runPrSummaryCheck({
    summaryContent,
    baseBranch: args.value.baseBranch,
    issueBody,
    issueLabels: args.value.labels,
    runGit: deps.runGit,
    repoRoot: root.value,
  });
  if (!checked.ok) {
    deps.stderr(checked.error.message);
    return 2;
  }

  deps.stdout(formatReport(checked.value));
  return hasBlock(checked.value) ? 1 : 0;
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
