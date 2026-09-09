/**
 * Entry point invoked by the agent-side `gh` shim (Issue #3643).
 *
 * The shim runs this module once per `gh` invocation the agent makes, passing
 * the run's allowlist state and the `gh` arguments on argv — never through the
 * environment, which the agent could trivially alter. Everything it decides on
 * arrives as arguments, so its Deno permissions are `--allow-read`, to scan the
 * body files named in that argv (Issue #3938), and write access to the one
 * directory `--body-dir` names, where a masked `--input` copy lands (Issue
 * #1364).
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
 * **A refusal is journaled (Issue #1604).** The verdict used to be a single
 * stderr line from this short-lived process — the one event the threat
 * model's control C16 exists to prove happened, and the one that left no
 * durable trace. When the shim hands over `--audit-dir`, `--audit-worker`
 * and `--audit-run` (it does whenever the worker's own journal is on), a
 * refused command is appended to the same hash-chained journal as every
 * other classified mutation, under {@link GH_GUARD_REFUSAL_AUDIT_VERB}. The
 * shim widens `--allow-write` to exactly the journal's footprint for it. A
 * journal that cannot be written never changes the verdict — the refusal
 * stands and `[SECURITY] [AUDIT_JOURNAL_REFUSED]` says what was lost.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type BodyFileReader,
  type BodyFileWriter,
  redactGhBodyArgs,
  UnredactableBodyError,
} from "./gh_body_redaction.ts";
// Shared with `spawnGh` (Issue #1254) so the two chokepoints cannot drift.
import { bodyFileWriterIn, denoBodyFileReader } from "./gh_body_file_io.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { encodeNulFields } from "./guard_field_encoding.ts";
import { evaluateGhCommand } from "./gh_guard_decision.ts";
import type { ClaimedIssue } from "./claimed_issue_guard.ts";
import type { AuditMutation } from "./audit_entry.ts";
import { recordMutation } from "./audit_journal.ts";
import { redactSecrets } from "./secret_redaction.ts";
import type { Result } from "../types.ts";

/** Printed on stdout when — and only when — the command may proceed. */
export const GH_GUARD_ALLOW_MARKER = "VIBE_GH_GUARD_ALLOW";

/** Printed on stdout when a control refused the command. */
export const GH_GUARD_REFUSE_MARKER = "VIBE_GH_GUARD_REFUSE";

/** Audit-journal verb for a `gh` command the guard refused (Issue #1604). */
export const GH_GUARD_REFUSAL_AUDIT_VERB = "gh-guard-refused";

/** Cap on the argv quoted in a refusal's journal entry (Issue #1604). */
export const GH_GUARD_REFUSAL_TARGET_CHARS = 400;

/**
 * Where a refusal is journaled (Issue #1604): the journal directory, the
 * worker partition and the run id, all handed over on argv by the shim —
 * the child has no `--allow-env` to resolve any of them itself.
 */
export interface GuardAuditTarget {
  baseDir: string;
  workerId: string;
  runId: string;
}

/** The control that refused a command, for the journal (Issue #1604). */
export interface GuardRefusal {
  /** The decision marker, e.g. `WRITE_REPO_BLOCKED`. */
  marker: string;
  /** The reason the control gave. */
  reason: string;
  /** The `gh` argv as the agent issued it. */
  ghArgs: readonly string[];
}

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
  /** Present when a control refused the command (Issue #1604). */
  refusal?: GuardRefusal;
  /** Present when the shim asked for refusals to be journaled (Issue #1604). */
  audit?: GuardAuditTarget;
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
  return encodeNulFields([result.stdout, ...(result.ghArgs ?? [])]);
}

/** The guard's own argv, split from the `gh` arguments that follow `--`. */
interface ParsedArgv {
  active: boolean;
  allowedRepos: string[];
  /** The run's claimed issue, when `--claimed-issue` named one (Issue #222). */
  claimedIssue?: ClaimedIssue;
  /**
   * Directory a masked `--input` body is written to (Issue #1364). Absent
   * means no writer: a body needing masking is refused rather than left
   * loose in TMPDIR with nothing to remove it.
   */
  bodyDir?: string;
  /** Where to journal a refusal (Issue #1604), when the shim asked for it. */
  audit?: GuardAuditTarget;
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
 * claimed-issue lifecycle guard (Issue #222); `--body-dir <dir>` names the
 * caller-owned directory a masked `--input` body is written to (Issue #1364).
 */
function parseArgv(argv: readonly string[]): ParsedArgv {
  const allowedRepos: string[] = [];
  const allowedVerbs: string[] = [];
  let claimedIssue: ClaimedIssue | undefined;
  let bodyDir: string | undefined;
  let auditDir: string | undefined;
  let auditWorker: string | undefined;
  let auditRun: string | undefined;
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
    ...(bodyDir ? { bodyDir } : {}),
    ...(auditDir && auditWorker && auditRun
      ? { audit: { baseDir: auditDir, workerId: auditWorker, runId: auditRun } }
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
    if (token === "--body-dir") {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        return fail("--body-dir requires a value");
      }
      bodyDir = value;
      i++;
      continue;
    }
    // Issue #1604 — the three travel together; a journal entry with a
    // made-up partition or run id would be a record that lies rather than
    // one that is missing, so `finish` only journals when all three arrived.
    if (
      token === "--audit-dir" || token === "--audit-worker" ||
      token === "--audit-run"
    ) {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        return fail(`${token} requires a value`);
      }
      if (token === "--audit-dir") auditDir = value;
      else if (token === "--audit-worker") auditWorker = value;
      else auditRun = value;
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
 * @param writeBodyFile - Writer for a masked `--input` body (test seam).
 *   Defaults to one scoped to `--body-dir`; with neither, an `--input` body
 *   that needs masking is refused rather than written somewhere unowned
 *   (Issue #1364).
 * @returns The exit code, the stderr line to emit, and — when allowed — the
 *   arguments the shim must run.
 */
export function runGhGuardCli(
  argv: readonly string[],
  readBodyFile: BodyFileReader = denoBodyFileReader,
  writeBodyFile?: BodyFileWriter,
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
    return allowWithRedactedBody(
      parsed,
      readBodyFile,
      writeBodyFile ??
        (parsed.bodyDir ? bodyFileWriterIn(parsed.bodyDir) : undefined),
    );
  }

  return {
    exitCode: 1,
    stdout: GH_GUARD_REFUSE_MARKER,
    stderr: `[SECURITY] [${decision.marker}] ${decision.reason}`,
    refusal: {
      // Always set on a refusal; the decision type leaves them optional for
      // the allowed shape.
      marker: decision.marker ?? "GH_GUARD_REFUSED",
      reason: decision.reason ?? "",
      ghArgs: parsed.ghArgs,
    },
    ...(parsed.audit ? { audit: parsed.audit } : {}),
  };
}

/**
 * Append a refused command to the audit journal (Issue #1604).
 *
 * Runs in the guard child after the verdict has been written, with the
 * journal location the shim handed over. The entry names the control, the
 * reason and the argv the agent issued — the argv passed through the same
 * secret redaction the stderr line gets, and capped, because it is
 * agent-authored text that a credential could ride in. Never throws, and
 * never changes the verdict: a journal that cannot be written is reported
 * through the Result, and the caller says so on stderr.
 *
 * @param result - The evaluation, carrying `refusal` and `audit`.
 * @param record - The journal append (test seam; defaults to the real one).
 * @returns `ok: true` when journaled or when there was nothing to journal;
 *   `ok: false` with the reason when the append failed.
 */
export async function journalGuardRefusal(
  result: GhGuardCliResult,
  record: typeof recordMutation = recordMutation,
): Promise<Result<void>> {
  const { refusal, audit } = result;
  if (refusal === undefined || audit === undefined) {
    return { ok: true, value: undefined };
  }
  const argv = refusal.ghArgs.join(" ");
  const bounded = argv.length > GH_GUARD_REFUSAL_TARGET_CHARS
    ? `${argv.slice(0, GH_GUARD_REFUSAL_TARGET_CHARS)}…`
    : argv;
  const mutation: AuditMutation = {
    runId: audit.runId,
    verb: GH_GUARD_REFUSAL_AUDIT_VERB,
    outcome: "error",
    exitCode: result.exitCode,
    target: `${refusal.marker}: gh ${redactSecrets(bounded)}`,
    caller: "worker/deno/lib/gh_guard_cli.ts",
  };
  try {
    const appended = await record(mutation, {
      baseDir: audit.baseDir,
      workerId: audit.workerId,
      // No `--allow-env` in the guard child: every environment question the
      // journal could ask is answered "unset" rather than thrown.
      env: () => undefined,
    });
    if (!appended.ok) return { ok: false, error: appended.error };
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Mask the published bodies of an allowed command (Issue #3938).
 *
 * A body that cannot be scanned at all refuses the call: publishing it anyway
 * would report a failed control as a success. So does a body that needs
 * masking when no writer exists (Issue #1364) — the redacted copy has nowhere
 * owned to live, and an unowned temp file is not the answer.
 */
function allowWithRedactedBody(
  parsed: ParsedArgv,
  readBodyFile: BodyFileReader,
  writeBodyFile: BodyFileWriter | undefined,
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
      // A body the guard could not scan is a refusal like any other
      // (Issue #1604): journaled, so the loss is visible after the fact.
      refusal: {
        marker: "GH_BODY_UNREDACTABLE",
        reason: err.message,
        ghArgs: parsed.ghArgs,
      },
      ...(parsed.audit ? { audit: parsed.audit } : {}),
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
  // Issue #1280 (SEC-1217-12): the guard child is its own process. Its
  // stdout is the NUL-encoded verdict written through `Deno.stdout` and is
  // untouched by the patch; the refusal reason on stderr quotes the agent's
  // own argv, which is where a credential can ride in.
  installConsoleRedaction();

  const result = runGhGuardCli(Deno.args);
  await Deno.stdout.write(new TextEncoder().encode(encodeGuardStdout(result)));
  if (result.stderr) console.error(result.stderr);
  // Issue #1604: the refusal outlives this process in the journal, or the
  // failure to record it is said out loud — after the verdict, never instead
  // of it.
  const journaled = await journalGuardRefusal(result);
  if (!journaled.ok) {
    console.error(
      `[SECURITY] [AUDIT_JOURNAL_REFUSED] ${GH_GUARD_REFUSAL_AUDIT_VERB}: ` +
        journaled.error.message,
    );
  }
  Deno.exit(result.exitCode);
}
