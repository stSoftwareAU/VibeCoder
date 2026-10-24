/**
 * CLI for `deno task pr-summary-check` (Issue #3423, extended by Issue #4234).
 *
 * Usage: pr-summary-check --base <branch> [--issue-body-file <path>]
 *          [--issue-title <text>] [--labels <a,b>]
 *          [--claim-check | --no-claim-check] [--verifier] <summary-file>
 *
 * The summary claim check runs by default, as one model call the worker also
 * makes when it raises the PR. `--no-claim-check` skips it, and the report
 * then says not checked, never passed. `--verifier` runs the pre-PR verifier
 * too, which is opt-in because it runs the reviewer brief with execution
 * rights in a disposable checkout.
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
import { createLogger } from "./logger.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import {
  type RetryOptions,
  type RunClaudeOptions,
  runClaudeWithRetry,
} from "./claude_runner.ts";
import {
  formatReport,
  hasBlock,
  runPrSummaryCheck,
  type SummaryGateContext,
} from "./pr_summary_check.ts";
import {
  type PrePrVerifierInput,
  type PrePrVerifierResult,
  runPrePrVerifier,
} from "./pre_pr_verifier.ts";
import {
  runSummaryClaimCheck,
  type SummaryClaimCheckResult,
} from "./summary_claim_check.ts";
import { DRIFT_CHECK_DISALLOWED_TOOLS } from "./pr_feedback_drift_check.ts";

const USAGE = "usage: pr-summary-check --base <branch> " +
  "[--issue-body-file <path>] [--issue-title <text>] [--labels <a,b>] " +
  "[--claim-check | --no-claim-check] [--verifier] <summary-file>";

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  "--base",
  "--issue-body-file",
  "--issue-title",
  "--labels",
]);

/** Parsed command line. */
export interface CliArgs {
  summaryFile: string;
  baseBranch: string;
  issueBodyFile: string | null;
  issueTitle: string | null;
  labels: string | null;
  /** Run the summary claim check (a model call). On unless `--no-claim-check`. */
  claimCheck: boolean;
  /** Run the pre-PR verifier (a model call). Off unless `--verifier`. */
  verifier: boolean;
}

/** Parse argv (without the program name). */
export function parseArgs(argv: string[]): Result<CliArgs, Error> {
  let baseBranch: string | null = null;
  let issueBodyFile: string | null = null;
  let issueTitle: string | null = null;
  let labels: string | null = null;
  let claimFlag: "--claim-check" | "--no-claim-check" | null = null;
  let verifier = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (VALUE_FLAGS.has(arg)) {
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
      else if (arg === "--issue-title") issueTitle = value;
      else issueBodyFile = value;
    } else if (arg === "--claim-check" || arg === "--no-claim-check") {
      if (claimFlag !== null && claimFlag !== arg) {
        return {
          ok: false,
          error: new Error(
            `--claim-check and --no-claim-check cannot both be given. ${USAGE}`,
          ),
        };
      }
      claimFlag = arg;
    } else if (arg === "--verifier") {
      verifier = true;
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
      issueTitle,
      labels,
      claimCheck: claimFlag !== "--no-claim-check",
      verifier,
    },
  };
}

/** Issue number from a `pr-summary-<N>.md` path, or `null` when absent. */
export function issueNumberFromSummaryPath(path: string): number | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = /^pr-summary-(\d+)\.md$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Collapse `.` and `..` segments and empty ones, keeping a leading `/`. */
function normalisePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/**
 * The summary file's path relative to the repository root, or `null` when it
 * lies outside the root. The model-backed checks name the summary by this
 * repo-relative path, as the completion phase does.
 */
export function repoRelativePath(
  file: string,
  repoRoot: string,
  cwd: string,
): string | null {
  const absolute = normalisePath(
    file.startsWith("/") ? file : `${cwd}/${file}`,
  );
  const root = normalisePath(repoRoot);
  if (!absolute.startsWith(`${root}/`)) return null;
  return absolute.slice(root.length + 1);
}

/** Injected effects, so the entry is testable without a process. */
export interface CliDeps {
  readTextFile: (path: string) => Promise<string>;
  runGit: GitRunner;
  repoRoot: () => Promise<Result<string>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Working directory, for resolving the summary path. Defaults to `Deno.cwd()`. */
  cwd?: () => string;
  /**
   * The one model call behind the claim check. The real one is
   * `runClaudeWithRetry`, which the completion phase also uses.
   */
  askModel: (
    options: RunClaudeOptions,
    retryOptions?: RetryOptions,
  ) => Promise<Result<{ output?: string }>>;
  /** The pre-PR verifier. The real one is `runPrePrVerifier`. */
  runVerifier: (input: PrePrVerifierInput) => Promise<PrePrVerifierResult>;
}

/** A claim check result that reports one reason it did not run. */
function claimNotRun(reason: string): SummaryClaimCheckResult {
  return {
    findings: [],
    docFindings: [],
    unconfirmedFindings: [],
    testPlanProblems: [],
    notChecked: [reason],
  };
}

/** The repository's name, for the model prompts (`repo#N`). */
function repoLabel(repoRoot: string): string {
  return repoRoot.split(/[\\/]/).filter((part) => part.length > 0).pop() ??
    repoRoot;
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

  const repoRoot = root.value;
  const issueNumber = issueNumberFromSummaryPath(args.value.summaryFile);
  const summaryPath = repoRelativePath(
    args.value.summaryFile,
    repoRoot,
    (deps.cwd ?? (() => Deno.cwd()))(),
  );
  const repo = repoLabel(repoRoot);
  const logger = createLogger({
    write: deps.stderr,
    host: "",
    logLevel: "WARNING",
  });

  const claimCheck = args.value.claimCheck
    ? async (ctx: SummaryGateContext): Promise<SummaryClaimCheckResult> => {
      if (ctx.summaryPath === null) {
        return claimNotRun(
          "the summary file lies outside the repository root, so the claim check cannot name it",
        );
      }
      if (issueNumber === null) {
        return claimNotRun(
          "the summary file name carries no issue number (pr-summary-<N>.md), which the claim check needs",
        );
      }
      return await runSummaryClaimCheck(
        {
          repo,
          issueNumber,
          repoPath: repoRoot,
          baseRef: ctx.baseRef,
          summaryPath: ctx.summaryPath,
          summaryContent: ctx.summaryContent,
          changedFiles: ctx.changedFiles,
        },
        {
          runGit: async (gitArgs) => {
            const r = await deps.runGit(gitArgs, { cwd: repoRoot });
            return r.ok ? r.value : null;
          },
          askQuestion: async (prompt) => {
            const r = await deps.askModel(
              {
                prompt,
                phase: "issue",
                repo,
                issueNumber,
                timeoutSeconds: OPERATIONAL_DEFAULTS.claudeTimeout,
                killAfterSeconds: OPERATIONAL_DEFAULTS.claudeKillAfter,
                cwd: repoRoot,
                logger,
                disallowedTools: [...DRIFT_CHECK_DISALLOWED_TOOLS],
              },
              { maxRetries: OPERATIONAL_DEFAULTS.maxRateLimitRetries },
            );
            if (!r.ok) return r;
            return { ok: true, value: r.value.output ?? "" };
          },
          logger,
        },
      );
    }
    : undefined;

  const verifier = args.value.verifier
    ? async (ctx: SummaryGateContext): Promise<PrePrVerifierResult> => {
      if (ctx.summaryPath === null) {
        return {
          status: "not_checked",
          reason:
            "the summary file lies outside the repository root, so the verifier cannot name it",
        };
      }
      if (issueNumber === null) {
        return {
          status: "not_checked",
          reason:
            "the summary file name carries no issue number (pr-summary-<N>.md), which the verifier needs",
        };
      }
      return await deps.runVerifier({
        repo,
        issueNumber,
        issueTitle: args.value.issueTitle ?? "",
        issueBody: issueBody ?? "",
        repoPath: repoRoot,
        baseRef: ctx.baseRef,
        summaryPath: ctx.summaryPath,
        summaryContent: ctx.summaryContent,
        changedFiles: ctx.changedFiles,
        timeoutSeconds: OPERATIONAL_DEFAULTS.claudeTimeout,
        killAfterSeconds: OPERATIONAL_DEFAULTS.claudeKillAfter,
        maxRetries: OPERATIONAL_DEFAULTS.maxRateLimitRetries,
        logger,
      });
    }
    : undefined;

  const checked = await runPrSummaryCheck({
    summaryContent,
    issueNumber,
    summaryPath,
    baseBranch: args.value.baseBranch,
    issueBody,
    issueTitle: args.value.issueTitle,
    issueLabels: args.value.labels,
    runGit: deps.runGit,
    repoRoot,
    logger,
    claimCheck,
    verifier,
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
    cwd: () => Deno.cwd(),
    askModel: runClaudeWithRetry,
    runVerifier: (input) => runPrePrVerifier(input),
  });
  Deno.exit(code);
}
