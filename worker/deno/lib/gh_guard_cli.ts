/**
 * Entry point invoked by the agent-side `gh` shim (Issue #3643).
 *
 * The shim runs this module once per `gh` invocation the agent makes, passing
 * the run's allowlist state and the `gh` arguments on argv — never through the
 * environment, which the agent could trivially alter. Everything it decides on
 * arrives as arguments, so its only Deno permission is `--allow-read`, and
 * only to scan the body files named in that argv (Issue #3938).
 *
 * The contract with the shim is a **positive verdict marker on stdout**, not
 * an exit code: `deno` itself exits 1 on a module-resolution or runtime error,
 * so "exit 0/1" alone cannot distinguish a verdict from a broken guard. The
 * shim only proceeds on {@link GH_GUARD_ALLOW_MARKER}; anything else — a
 * refusal, a crash, an empty stdout — refuses the `gh` call.
 *
 * Exit codes accompany the marker: `0` allowed, `1` refused by a control
 * (reason on stderr), `2` malformed invocation.
 *
 * **The guard also redacts (Issue #3938).** Secret masking for published
 * bodies used to be wired inside `spawnGh` alone, which the agent subprocess
 * bypasses entirely — so the one class of body most likely to carry a leaked
 * credential, model output, was the one class never scanned. An allowed
 * command therefore comes back with its argv rewritten: the verdict marker and
 * the arguments the shim must `exec` are written to stdout as NUL-terminated
 * fields (see {@link encodeGuardStdout}), because a redacted body may contain
 * newlines and must survive byte-for-byte. Reading `--body-file` contents is
 * why the guard child now runs with `--allow-read`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type BodyFileReader,
  type BodyFileWriter,
  redactGhBodyArgs,
  UnredactableBodyError,
} from "./gh_body_redaction.ts";
import { evaluateGhCommand } from "./gh_guard_decision.ts";
import type { ClaimedIssue } from "./claimed_issue_guard.ts";

/** Printed on stdout when — and only when — the command may proceed. */
export const GH_GUARD_ALLOW_MARKER = "VIBE_GH_GUARD_ALLOW";

/** Printed on stdout when a control refused the command. */
export const GH_GUARD_REFUSE_MARKER = "VIBE_GH_GUARD_REFUSE";

/** Outcome of one guard evaluation. */
export interface GhGuardCliResult {
  /** Process exit code (see the module comment for the contract). */
  exitCode: number;
  /** Verdict marker to write to stdout. */
  stdout: string;
  /** Line to write to stderr, or empty when the command is allowed. */
  stderr: string;
  /**
   * The arguments the shim must run — body arguments redacted (Issue #3938).
   * Present only when the command is allowed.
   */
  ghArgs?: string[];
}

/**
 * Frame a verdict for the shim: the marker, then the argv to run, each field
 * NUL-terminated.
 *
 * A NUL cannot occur inside an argument, so this is the one framing that
 * survives an arbitrary redacted body (newlines, quotes, backslashes) without
 * an encoding step in the wrapper.
 *
 * @param result - The evaluation to frame.
 * @returns The exact bytes to write to stdout.
 */
export function encodeGuardStdout(result: GhGuardCliResult): string {
  return [result.stdout, ...(result.ghArgs ?? [])]
    .map((field) => `${field}\0`)
    .join("");
}

/** Production body-file reader — used when the caller supplies none. */
const denoBodyFileReader: BodyFileReader = (path) =>
  Deno.readTextFileSync(path);

/**
 * Production writer for a masked `--input` body (Issue #92): a fresh temp file
 * the redacted JSON lands in, so the agent's own file is never rewritten.
 */
const denoBodyFileWriter: BodyFileWriter = (content) => {
  const path = Deno.makeTempFileSync({ prefix: "gh-input-", suffix: ".json" });
  Deno.writeTextFileSync(path, content);
  return path;
};

/** The guard's own argv, split from the `gh` arguments that follow `--`. */
interface ParsedArgv {
  active: boolean;
  allowedRepos: string[];
  /** The run's claimed issue, when `--claimed-issue` named one (Issue #222). */
  claimedIssue?: ClaimedIssue;
  ghArgs: string[];
  /** Set when the invocation is malformed. */
  error?: string;
}

/** `owner/repo#N` as passed to `--claimed-issue`. */
function parseClaimedIssue(value: string): ClaimedIssue | undefined {
  const match = value.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (!match) return undefined;
  return {
    repo: match[1]!,
    issueNumber: parseInt(match[2]!, 10),
    allowedVerbs: [],
  };
}

/**
 * Parse the guard's own flags up to the `--` separator.
 *
 * `--active` / `--allow-repo <slug>` carry the write-repo allowlist;
 * `--claimed-issue <owner/repo#N>` and `--allow-issue-verb <verb>` carry the
 * claimed-issue lifecycle guard (Issue #222).
 */
function parseArgv(argv: readonly string[]): ParsedArgv {
  const allowedRepos: string[] = [];
  const allowedVerbs: string[] = [];
  let claimedIssue: ClaimedIssue | undefined;
  let active = false;
  let i = 0;
  const fail = (error: string): ParsedArgv => ({
    active,
    allowedRepos,
    ghArgs: [],
    error,
  });
  const finish = (ghArgs: string[]): ParsedArgv => ({
    active,
    allowedRepos,
    ...(claimedIssue
      ? { claimedIssue: { ...claimedIssue, allowedVerbs } }
      : {}),
    ghArgs,
  });
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") return finish(argv.slice(i + 1) as string[]);
    if (token === "--active") {
      active = true;
      continue;
    }
    if (token === "--allow-repo") {
      const value = argv[i + 1];
      if (value === undefined) return fail("--allow-repo requires a value");
      allowedRepos.push(value);
      i++;
      continue;
    }
    if (token === "--claimed-issue") {
      const value = argv[i + 1];
      if (value === undefined) return fail("--claimed-issue requires a value");
      const parsed = parseClaimedIssue(value);
      if (!parsed) {
        return fail(`--claimed-issue expects owner/repo#N, got: ${value}`);
      }
      claimedIssue = parsed;
      i++;
      continue;
    }
    if (token === "--allow-issue-verb") {
      const value = argv[i + 1];
      if (value === undefined) {
        return fail("--allow-issue-verb requires a value");
      }
      allowedVerbs.push(value);
      i++;
      continue;
    }
    return fail(`unknown guard argument: ${token}`);
  }
  return fail("missing '--' separator before the gh arguments");
}

/**
 * Evaluate one shim invocation.
 *
 * @param argv - The guard's own argv (guard flags, `--`, then `gh` arguments).
 * @param readBodyFile - Reader for `--body-file` contents (test seam).
 * @returns The exit code, the stderr line to emit, and — when allowed — the
 *   arguments the shim must run.
 */
export function runGhGuardCli(
  argv: readonly string[],
  readBodyFile: BodyFileReader = denoBodyFileReader,
  writeBodyFile: BodyFileWriter = denoBodyFileWriter,
): GhGuardCliResult {
  const parsed = parseArgv(argv);
  if (parsed.error) {
    return {
      exitCode: 2,
      stdout: GH_GUARD_REFUSE_MARKER,
      stderr: `[SECURITY] [GH_GUARD_ERROR] ${parsed.error}`,
    };
  }

  const decision = evaluateGhCommand(parsed.ghArgs, {
    active: parsed.active,
    allowedRepos: parsed.allowedRepos,
    // Issue #222: the claimed issue's lifecycle guard, when the run seeded one.
    ...(parsed.claimedIssue ? { claimedIssue: parsed.claimedIssue } : {}),
    // Issue #91: let the decision scan a readable `--input <file>` body for
    // reserved labels instead of failing closed on every one. The decision
    // module stays pure; the filesystem reader is injected here.
    readBodyFile,
  });
  if (decision.allowed) {
    return allowWithRedactedBody(parsed, readBodyFile, writeBodyFile);
  }

  return {
    exitCode: 1,
    stdout: GH_GUARD_REFUSE_MARKER,
    stderr: `[SECURITY] [${decision.marker}] ${decision.reason}`,
  };
}

/**
 * Mask the published bodies of an allowed command (Issue #3938).
 *
 * A body that cannot be scanned at all refuses the call: publishing it anyway
 * would report a failed control as a success.
 */
function allowWithRedactedBody(
  parsed: ParsedArgv,
  readBodyFile: BodyFileReader,
  writeBodyFile: BodyFileWriter,
): GhGuardCliResult {
  let ghArgs: string[];
  try {
    ghArgs = redactGhBodyArgs(parsed.ghArgs, readBodyFile, writeBodyFile);
  } catch (err) {
    if (!(err instanceof UnredactableBodyError)) throw err;
    return {
      exitCode: 1,
      stdout: GH_GUARD_REFUSE_MARKER,
      stderr: `[SECURITY] [GH_BODY_UNREDACTABLE] ${err.message}`,
    };
  }

  const redacted = ghArgs.some((arg, i) => arg !== parsed.ghArgs[i]);
  return {
    exitCode: 0,
    stdout: GH_GUARD_ALLOW_MARKER,
    stderr: redacted
      ? "[SECURITY] [GH_BODY_REDACTED] a secret was masked in the body of " +
        "this gh command before it reached GitHub."
      : "",
    ghArgs,
  };
}

if (import.meta.main) {
  const result = runGhGuardCli(Deno.args);
  await Deno.stdout.write(new TextEncoder().encode(encodeGuardStdout(result)));
  if (result.stderr) console.error(result.stderr);
  Deno.exit(result.exitCode);
}
