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
 */ import { redactGhBodyArgs, UnredactableBodyError } from "./gh_body_redaction.ts";
// Shared with `spawnGh` (Issue #1254) so the two chokepoints cannot drift.
import { bodyFileWriterIn, denoBodyFileReader } from "./gh_body_file_io.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { encodeNulFields } from "./guard_field_encoding.ts";
import { evaluateGhCommand } from "./gh_guard_decision.ts";
import { recordMutation } from "./audit_journal.ts";
import { redactSecrets } from "./secret_redaction.ts";
/** Printed on stdout when — and only when — the command may proceed. */ export const GH_GUARD_ALLOW_MARKER = "VIBE_GH_GUARD_ALLOW";
/** Printed on stdout when a control refused the command. */ export const GH_GUARD_REFUSE_MARKER = "VIBE_GH_GUARD_REFUSE";
/** Audit-journal verb for a `gh` command the guard refused (Issue #1604). */ export const GH_GUARD_REFUSAL_AUDIT_VERB = "gh-guard-refused";
/** Cap on the argv quoted in a refusal's journal entry (Issue #1604). */ export const GH_GUARD_REFUSAL_TARGET_CHARS = 400;
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
 */ export function encodeGuardStdout(result) {
  return encodeNulFields([
    result.stdout,
    ...result.ghArgs ?? []
  ]);
}
/** `owner/repo#N` as passed to `--claimed-issue`. */ function parseClaimedIssue(value) {
  const match = value.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (!match) return undefined;
  return {
    repo: match[1],
    issueNumber: parseInt(match[2], 10),
    allowedVerbs: []
  };
}
/**
 * Parse the guard's own flags up to the `--` separator.
 *
 * `--active` / `--allow-repo <slug>` carry the write-repo allowlist;
 * `--claimed-issue <owner/repo#N>` and `--allow-issue-verb <verb>` carry the
 * claimed-issue lifecycle guard (Issue #222); `--body-dir <dir>` names the
 * caller-owned directory a masked `--input` body is written to (Issue #1364).
 */ function parseArgv(argv) {
  const allowedRepos = [];
  const allowedVerbs = [];
  let claimedIssue;
  let bodyDir;
  let auditDir;
  let auditWorker;
  let auditRun;
  let active = false;
  let i = 0;
  const fail = (error)=>({
      active,
      allowedRepos,
      ghArgs: [],
      error
    });
  const finish = (ghArgs)=>({
      active,
      allowedRepos,
      ...claimedIssue ? {
        claimedIssue: {
          ...claimedIssue,
          allowedVerbs
        }
      } : {},
      ...bodyDir ? {
        bodyDir
      } : {},
      ...auditDir && auditWorker && auditRun ? {
        audit: {
          baseDir: auditDir,
          workerId: auditWorker,
          runId: auditRun
        }
      } : {},
      ghArgs
    });
  for(; i < argv.length; i++){
    const token = argv[i];
    if (token === "--") return finish(argv.slice(i + 1));
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
    if (token === "--audit-dir" || token === "--audit-worker" || token === "--audit-run") {
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
 */ export function runGhGuardCli(argv, readBodyFile = denoBodyFileReader, writeBodyFile) {
  const parsed = parseArgv(argv);
  if (parsed.error) {
    return {
      exitCode: 2,
      stdout: GH_GUARD_REFUSE_MARKER,
      stderr: `[SECURITY] [GH_GUARD_ERROR] ${parsed.error}`
    };
  }
  const decision = evaluateGhCommand(parsed.ghArgs, {
    active: parsed.active,
    allowedRepos: parsed.allowedRepos,
    // Issue #222: the claimed issue's lifecycle guard, when the run seeded one.
    ...parsed.claimedIssue ? {
      claimedIssue: parsed.claimedIssue
    } : {},
    // Issue #91: let the decision scan a readable `--input <file>` body for
    // reserved labels instead of failing closed on every one. The decision
    // module stays pure; the filesystem reader is injected here.
    readBodyFile
  });
  if (decision.allowed) {
    return allowWithRedactedBody(parsed, readBodyFile, writeBodyFile ?? (parsed.bodyDir ? bodyFileWriterIn(parsed.bodyDir) : undefined));
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
      ghArgs: parsed.ghArgs
    },
    ...parsed.audit ? {
      audit: parsed.audit
    } : {}
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
 */ export async function journalGuardRefusal(result, record = recordMutation) {
  const { refusal, audit } = result;
  if (refusal === undefined || audit === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }
  const argv = refusal.ghArgs.join(" ");
  const bounded = argv.length > GH_GUARD_REFUSAL_TARGET_CHARS ? `${argv.slice(0, GH_GUARD_REFUSAL_TARGET_CHARS)}…` : argv;
  const mutation = {
    runId: audit.runId,
    verb: GH_GUARD_REFUSAL_AUDIT_VERB,
    outcome: "error",
    exitCode: result.exitCode,
    target: `${refusal.marker}: gh ${redactSecrets(bounded)}`,
    caller: "worker/deno/lib/gh_guard_cli.ts"
  };
  try {
    const appended = await record(mutation, {
      baseDir: audit.baseDir,
      workerId: audit.workerId,
      // No `--allow-env` in the guard child: every environment question the
      // journal could ask is answered "unset" rather than thrown.
      env: ()=>undefined
    });
    if (!appended.ok) return {
      ok: false,
      error: appended.error
    };
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
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
 */ function allowWithRedactedBody(parsed, readBodyFile, writeBodyFile) {
  let ghArgs;
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
        ghArgs: parsed.ghArgs
      },
      ...parsed.audit ? {
        audit: parsed.audit
      } : {}
    };
  }
  const redacted = ghArgs.some((arg, i)=>arg !== parsed.ghArgs[i]);
  return {
    exitCode: 0,
    stdout: GH_GUARD_ALLOW_MARKER,
    stderr: redacted ? "[SECURITY] [GH_BODY_REDACTED] a secret was masked in the body of " + "this gh command before it reached GitHub." : "",
    ghArgs
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
    console.error(`[SECURITY] [AUDIT_JOURNAL_REFUSED] ${GH_GUARD_REFUSAL_AUDIT_VERB}: ` + journaled.error.message);
  }
  Deno.exit(result.exitCode);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9ndWFyZF9jbGkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFbnRyeSBwb2ludCBpbnZva2VkIGJ5IHRoZSBhZ2VudC1zaWRlIGBnaGAgc2hpbSAoSXNzdWUgIzM2NDMpLlxuICpcbiAqIFRoZSBzaGltIHJ1bnMgdGhpcyBtb2R1bGUgb25jZSBwZXIgYGdoYCBpbnZvY2F0aW9uIHRoZSBhZ2VudCBtYWtlcywgcGFzc2luZ1xuICogdGhlIHJ1bidzIGFsbG93bGlzdCBzdGF0ZSBhbmQgdGhlIGBnaGAgYXJndW1lbnRzIG9uIGFyZ3Yg4oCUIG5ldmVyIHRocm91Z2ggdGhlXG4gKiBlbnZpcm9ubWVudCwgd2hpY2ggdGhlIGFnZW50IGNvdWxkIHRyaXZpYWxseSBhbHRlci4gRXZlcnl0aGluZyBpdCBkZWNpZGVzIG9uXG4gKiBhcnJpdmVzIGFzIGFyZ3VtZW50cywgc28gaXRzIERlbm8gcGVybWlzc2lvbnMgYXJlIGAtLWFsbG93LXJlYWRgLCB0byBzY2FuIHRoZVxuICogYm9keSBmaWxlcyBuYW1lZCBpbiB0aGF0IGFyZ3YgKElzc3VlICMzOTM4KSwgYW5kIHdyaXRlIGFjY2VzcyB0byB0aGUgb25lXG4gKiBkaXJlY3RvcnkgYC0tYm9keS1kaXJgIG5hbWVzLCB3aGVyZSBhIG1hc2tlZCBgLS1pbnB1dGAgY29weSBsYW5kcyAoSXNzdWVcbiAqICMxMzY0KS5cbiAqXG4gKiBUaGUgY29udHJhY3Qgd2l0aCB0aGUgc2hpbSBpcyBhICoqcG9zaXRpdmUgdmVyZGljdCBtYXJrZXIgb24gc3Rkb3V0KiosIG5vdFxuICogYW4gZXhpdCBjb2RlOiBgZGVub2AgaXRzZWxmIGV4aXRzIDEgb24gYSBtb2R1bGUtcmVzb2x1dGlvbiBvciBydW50aW1lIGVycm9yLFxuICogc28gXCJleGl0IDAvMVwiIGFsb25lIGNhbm5vdCBkaXN0aW5ndWlzaCBhIHZlcmRpY3QgZnJvbSBhIGJyb2tlbiBndWFyZC4gVGhlXG4gKiBzaGltIG9ubHkgcHJvY2VlZHMgb24ge0BsaW5rIEdIX0dVQVJEX0FMTE9XX01BUktFUn07IGFueXRoaW5nIGVsc2Ug4oCUIGFcbiAqIHJlZnVzYWwsIGEgY3Jhc2gsIGFuIGVtcHR5IHN0ZG91dCDigJQgcmVmdXNlcyB0aGUgYGdoYCBjYWxsLlxuICpcbiAqIEV4aXQgY29kZXMgYWNjb21wYW55IHRoZSBtYXJrZXI6IGAwYCBhbGxvd2VkLCBgMWAgcmVmdXNlZCBieSBhIGNvbnRyb2xcbiAqIChyZWFzb24gb24gc3RkZXJyKSwgYDJgIG1hbGZvcm1lZCBpbnZvY2F0aW9uLlxuICpcbiAqICoqVGhlIGd1YXJkIGFsc28gcmVkYWN0cyAoSXNzdWUgIzM5MzgpLioqIFNlY3JldCBtYXNraW5nIGZvciBwdWJsaXNoZWRcbiAqIGJvZGllcyB1c2VkIHRvIGJlIHdpcmVkIGluc2lkZSBgc3Bhd25HaGAgYWxvbmUsIHdoaWNoIHRoZSBhZ2VudCBzdWJwcm9jZXNzXG4gKiBieXBhc3NlcyBlbnRpcmVseSDigJQgc28gdGhlIG9uZSBjbGFzcyBvZiBib2R5IG1vc3QgbGlrZWx5IHRvIGNhcnJ5IGEgbGVha2VkXG4gKiBjcmVkZW50aWFsLCBtb2RlbCBvdXRwdXQsIHdhcyB0aGUgb25lIGNsYXNzIG5ldmVyIHNjYW5uZWQuIEFuIGFsbG93ZWRcbiAqIGNvbW1hbmQgdGhlcmVmb3JlIGNvbWVzIGJhY2sgd2l0aCBpdHMgYXJndiByZXdyaXR0ZW46IHRoZSB2ZXJkaWN0IG1hcmtlciBhbmRcbiAqIHRoZSBhcmd1bWVudHMgdGhlIHNoaW0gbXVzdCBgZXhlY2AgYXJlIHdyaXR0ZW4gdG8gc3Rkb3V0IGFzIE5VTC10ZXJtaW5hdGVkXG4gKiBmaWVsZHMgKHNlZSB7QGxpbmsgZW5jb2RlR3VhcmRTdGRvdXR9KSwgYmVjYXVzZSBhIHJlZGFjdGVkIGJvZHkgbWF5IGNvbnRhaW5cbiAqIG5ld2xpbmVzIGFuZCBtdXN0IHN1cnZpdmUgYnl0ZS1mb3ItYnl0ZS4gUmVhZGluZyBgLS1ib2R5LWZpbGVgIGNvbnRlbnRzIGlzXG4gKiB3aHkgdGhlIGd1YXJkIGNoaWxkIG5vdyBydW5zIHdpdGggYC0tYWxsb3ctcmVhZGAuXG4gKlxuICogKipBIHJlZnVzYWwgaXMgam91cm5hbGVkIChJc3N1ZSAjMTYwNCkuKiogVGhlIHZlcmRpY3QgdXNlZCB0byBiZSBhIHNpbmdsZVxuICogc3RkZXJyIGxpbmUgZnJvbSB0aGlzIHNob3J0LWxpdmVkIHByb2Nlc3Mg4oCUIHRoZSBvbmUgZXZlbnQgdGhlIHRocmVhdFxuICogbW9kZWwncyBjb250cm9sIEMxNiBleGlzdHMgdG8gcHJvdmUgaGFwcGVuZWQsIGFuZCB0aGUgb25lIHRoYXQgbGVmdCBub1xuICogZHVyYWJsZSB0cmFjZS4gV2hlbiB0aGUgc2hpbSBoYW5kcyBvdmVyIGAtLWF1ZGl0LWRpcmAsIGAtLWF1ZGl0LXdvcmtlcmBcbiAqIGFuZCBgLS1hdWRpdC1ydW5gIChpdCBkb2VzIHdoZW5ldmVyIHRoZSB3b3JrZXIncyBvd24gam91cm5hbCBpcyBvbiksIGFcbiAqIHJlZnVzZWQgY29tbWFuZCBpcyBhcHBlbmRlZCB0byB0aGUgc2FtZSBoYXNoLWNoYWluZWQgam91cm5hbCBhcyBldmVyeVxuICogb3RoZXIgY2xhc3NpZmllZCBtdXRhdGlvbiwgdW5kZXIge0BsaW5rIEdIX0dVQVJEX1JFRlVTQUxfQVVESVRfVkVSQn0uIFRoZVxuICogc2hpbSB3aWRlbnMgYC0tYWxsb3ctd3JpdGVgIHRvIGV4YWN0bHkgdGhlIGpvdXJuYWwncyBmb290cHJpbnQgZm9yIGl0LiBBXG4gKiBqb3VybmFsIHRoYXQgY2Fubm90IGJlIHdyaXR0ZW4gbmV2ZXIgY2hhbmdlcyB0aGUgdmVyZGljdCDigJQgdGhlIHJlZnVzYWxcbiAqIHN0YW5kcyBhbmQgYFtTRUNVUklUWV0gW0FVRElUX0pPVVJOQUxfUkVGVVNFRF1gIHNheXMgd2hhdCB3YXMgbG9zdC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQge1xuICB0eXBlIEJvZHlGaWxlUmVhZGVyLFxuICB0eXBlIEJvZHlGaWxlV3JpdGVyLFxuICByZWRhY3RHaEJvZHlBcmdzLFxuICBVbnJlZGFjdGFibGVCb2R5RXJyb3IsXG59IGZyb20gXCIuL2doX2JvZHlfcmVkYWN0aW9uLnRzXCI7XG4vLyBTaGFyZWQgd2l0aCBgc3Bhd25HaGAgKElzc3VlICMxMjU0KSBzbyB0aGUgdHdvIGNob2tlcG9pbnRzIGNhbm5vdCBkcmlmdC5cbmltcG9ydCB7IGJvZHlGaWxlV3JpdGVySW4sIGRlbm9Cb2R5RmlsZVJlYWRlciB9IGZyb20gXCIuL2doX2JvZHlfZmlsZV9pby50c1wiO1xuaW1wb3J0IHsgaW5zdGFsbENvbnNvbGVSZWRhY3Rpb24gfSBmcm9tIFwiLi9jb25zb2xlX3JlZGFjdGlvbi50c1wiO1xuaW1wb3J0IHsgZW5jb2RlTnVsRmllbGRzIH0gZnJvbSBcIi4vZ3VhcmRfZmllbGRfZW5jb2RpbmcudHNcIjtcbmltcG9ydCB7IGV2YWx1YXRlR2hDb21tYW5kIH0gZnJvbSBcIi4vZ2hfZ3VhcmRfZGVjaXNpb24udHNcIjtcbmltcG9ydCB0eXBlIHsgQ2xhaW1lZElzc3VlIH0gZnJvbSBcIi4vY2xhaW1lZF9pc3N1ZV9ndWFyZC50c1wiO1xuaW1wb3J0IHR5cGUgeyBBdWRpdE11dGF0aW9uIH0gZnJvbSBcIi4vYXVkaXRfZW50cnkudHNcIjtcbmltcG9ydCB7IHJlY29yZE11dGF0aW9uIH0gZnJvbSBcIi4vYXVkaXRfam91cm5hbC50c1wiO1xuaW1wb3J0IHsgcmVkYWN0U2VjcmV0cyB9IGZyb20gXCIuL3NlY3JldF9yZWRhY3Rpb24udHNcIjtcbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKiBQcmludGVkIG9uIHN0ZG91dCB3aGVuIOKAlCBhbmQgb25seSB3aGVuIOKAlCB0aGUgY29tbWFuZCBtYXkgcHJvY2VlZC4gKi9cbmV4cG9ydCBjb25zdCBHSF9HVUFSRF9BTExPV19NQVJLRVIgPSBcIlZJQkVfR0hfR1VBUkRfQUxMT1dcIjtcblxuLyoqIFByaW50ZWQgb24gc3Rkb3V0IHdoZW4gYSBjb250cm9sIHJlZnVzZWQgdGhlIGNvbW1hbmQuICovXG5leHBvcnQgY29uc3QgR0hfR1VBUkRfUkVGVVNFX01BUktFUiA9IFwiVklCRV9HSF9HVUFSRF9SRUZVU0VcIjtcblxuLyoqIEF1ZGl0LWpvdXJuYWwgdmVyYiBmb3IgYSBgZ2hgIGNvbW1hbmQgdGhlIGd1YXJkIHJlZnVzZWQgKElzc3VlICMxNjA0KS4gKi9cbmV4cG9ydCBjb25zdCBHSF9HVUFSRF9SRUZVU0FMX0FVRElUX1ZFUkIgPSBcImdoLWd1YXJkLXJlZnVzZWRcIjtcblxuLyoqIENhcCBvbiB0aGUgYXJndiBxdW90ZWQgaW4gYSByZWZ1c2FsJ3Mgam91cm5hbCBlbnRyeSAoSXNzdWUgIzE2MDQpLiAqL1xuZXhwb3J0IGNvbnN0IEdIX0dVQVJEX1JFRlVTQUxfVEFSR0VUX0NIQVJTID0gNDAwO1xuXG4vKipcbiAqIFdoZXJlIGEgcmVmdXNhbCBpcyBqb3VybmFsZWQgKElzc3VlICMxNjA0KTogdGhlIGpvdXJuYWwgZGlyZWN0b3J5LCB0aGVcbiAqIHdvcmtlciBwYXJ0aXRpb24gYW5kIHRoZSBydW4gaWQsIGFsbCBoYW5kZWQgb3ZlciBvbiBhcmd2IGJ5IHRoZSBzaGltIOKAlFxuICogdGhlIGNoaWxkIGhhcyBubyBgLS1hbGxvdy1lbnZgIHRvIHJlc29sdmUgYW55IG9mIHRoZW0gaXRzZWxmLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEd1YXJkQXVkaXRUYXJnZXQge1xuICBiYXNlRGlyOiBzdHJpbmc7XG4gIHdvcmtlcklkOiBzdHJpbmc7XG4gIHJ1bklkOiBzdHJpbmc7XG59XG5cbi8qKiBUaGUgY29udHJvbCB0aGF0IHJlZnVzZWQgYSBjb21tYW5kLCBmb3IgdGhlIGpvdXJuYWwgKElzc3VlICMxNjA0KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR3VhcmRSZWZ1c2FsIHtcbiAgLyoqIFRoZSBkZWNpc2lvbiBtYXJrZXIsIGUuZy4gYFdSSVRFX1JFUE9fQkxPQ0tFRGAuICovXG4gIG1hcmtlcjogc3RyaW5nO1xuICAvKiogVGhlIHJlYXNvbiB0aGUgY29udHJvbCBnYXZlLiAqL1xuICByZWFzb246IHN0cmluZztcbiAgLyoqIFRoZSBgZ2hgIGFyZ3YgYXMgdGhlIGFnZW50IGlzc3VlZCBpdC4gKi9cbiAgZ2hBcmdzOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuLyoqIE91dGNvbWUgb2Ygb25lIGd1YXJkIGV2YWx1YXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEdoR3VhcmRDbGlSZXN1bHQge1xuICAvKiogUHJvY2VzcyBleGl0IGNvZGUgKHNlZSB0aGUgbW9kdWxlIGNvbW1lbnQgZm9yIHRoZSBjb250cmFjdCkuICovXG4gIGV4aXRDb2RlOiBudW1iZXI7XG4gIC8qKiBWZXJkaWN0IG1hcmtlciB0byB3cml0ZSB0byBzdGRvdXQuICovXG4gIHN0ZG91dDogc3RyaW5nO1xuICAvKiogTGluZSB0byB3cml0ZSB0byBzdGRlcnIsIG9yIGVtcHR5IHdoZW4gdGhlIGNvbW1hbmQgaXMgYWxsb3dlZC4gKi9cbiAgc3RkZXJyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgYXJndW1lbnRzIHRoZSBzaGltIG11c3QgcnVuIOKAlCBib2R5IGFyZ3VtZW50cyByZWRhY3RlZCAoSXNzdWUgIzM5MzgpLlxuICAgKiBQcmVzZW50IG9ubHkgd2hlbiB0aGUgY29tbWFuZCBpcyBhbGxvd2VkLlxuICAgKi9cbiAgZ2hBcmdzPzogc3RyaW5nW107XG4gIC8qKiBQcmVzZW50IHdoZW4gYSBjb250cm9sIHJlZnVzZWQgdGhlIGNvbW1hbmQgKElzc3VlICMxNjA0KS4gKi9cbiAgcmVmdXNhbD86IEd1YXJkUmVmdXNhbDtcbiAgLyoqIFByZXNlbnQgd2hlbiB0aGUgc2hpbSBhc2tlZCBmb3IgcmVmdXNhbHMgdG8gYmUgam91cm5hbGVkIChJc3N1ZSAjMTYwNCkuICovXG4gIGF1ZGl0PzogR3VhcmRBdWRpdFRhcmdldDtcbn1cblxuLyoqXG4gKiBGcmFtZSBhIHZlcmRpY3QgZm9yIHRoZSBzaGltOiB0aGUgbWFya2VyLCB0aGVuIHRoZSBhcmd2IHRvIHJ1biwgZWFjaCBmaWVsZFxuICogTlVMLXRlcm1pbmF0ZWQuXG4gKlxuICogQSBOVUwgY2Fubm90IG9jY3VyIGluc2lkZSBhbiBhcmd1bWVudCwgc28gdGhpcyBpcyB0aGUgb25lIGZyYW1pbmcgdGhhdFxuICogc3Vydml2ZXMgYW4gYXJiaXRyYXJ5IHJlZGFjdGVkIGJvZHkgKG5ld2xpbmVzLCBxdW90ZXMsIGJhY2tzbGFzaGVzKSB3aXRob3V0XG4gKiBhbiBlbmNvZGluZyBzdGVwIGluIHRoZSB3cmFwcGVyLlxuICpcbiAqIEBwYXJhbSByZXN1bHQgLSBUaGUgZXZhbHVhdGlvbiB0byBmcmFtZS5cbiAqIEByZXR1cm5zIFRoZSBleGFjdCBieXRlcyB0byB3cml0ZSB0byBzdGRvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmNvZGVHdWFyZFN0ZG91dChyZXN1bHQ6IEdoR3VhcmRDbGlSZXN1bHQpOiBzdHJpbmcge1xuICByZXR1cm4gZW5jb2RlTnVsRmllbGRzKFtyZXN1bHQuc3Rkb3V0LCAuLi4ocmVzdWx0LmdoQXJncyA/PyBbXSldKTtcbn1cblxuLyoqIFRoZSBndWFyZCdzIG93biBhcmd2LCBzcGxpdCBmcm9tIHRoZSBgZ2hgIGFyZ3VtZW50cyB0aGF0IGZvbGxvdyBgLS1gLiAqL1xuaW50ZXJmYWNlIFBhcnNlZEFyZ3Yge1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIGFsbG93ZWRSZXBvczogc3RyaW5nW107XG4gIC8qKiBUaGUgcnVuJ3MgY2xhaW1lZCBpc3N1ZSwgd2hlbiBgLS1jbGFpbWVkLWlzc3VlYCBuYW1lZCBvbmUgKElzc3VlICMyMjIpLiAqL1xuICBjbGFpbWVkSXNzdWU/OiBDbGFpbWVkSXNzdWU7XG4gIC8qKlxuICAgKiBEaXJlY3RvcnkgYSBtYXNrZWQgYC0taW5wdXRgIGJvZHkgaXMgd3JpdHRlbiB0byAoSXNzdWUgIzEzNjQpLiBBYnNlbnRcbiAgICogbWVhbnMgbm8gd3JpdGVyOiBhIGJvZHkgbmVlZGluZyBtYXNraW5nIGlzIHJlZnVzZWQgcmF0aGVyIHRoYW4gbGVmdFxuICAgKiBsb29zZSBpbiBUTVBESVIgd2l0aCBub3RoaW5nIHRvIHJlbW92ZSBpdC5cbiAgICovXG4gIGJvZHlEaXI/OiBzdHJpbmc7XG4gIC8qKiBXaGVyZSB0byBqb3VybmFsIGEgcmVmdXNhbCAoSXNzdWUgIzE2MDQpLCB3aGVuIHRoZSBzaGltIGFza2VkIGZvciBpdC4gKi9cbiAgYXVkaXQ/OiBHdWFyZEF1ZGl0VGFyZ2V0O1xuICBnaEFyZ3M6IHN0cmluZ1tdO1xuICAvKiogU2V0IHdoZW4gdGhlIGludm9jYXRpb24gaXMgbWFsZm9ybWVkLiAqL1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqIGBvd25lci9yZXBvI05gIGFzIHBhc3NlZCB0byBgLS1jbGFpbWVkLWlzc3VlYC4gKi9cbmZ1bmN0aW9uIHBhcnNlQ2xhaW1lZElzc3VlKHZhbHVlOiBzdHJpbmcpOiBDbGFpbWVkSXNzdWUgfCB1bmRlZmluZWQge1xuICBjb25zdCBtYXRjaCA9IHZhbHVlLm1hdGNoKC9eKFteL1xcc10rXFwvW14jXFxzXSspIyhcXGQrKSQvKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICByZXBvOiBtYXRjaFsxXSEsXG4gICAgaXNzdWVOdW1iZXI6IHBhcnNlSW50KG1hdGNoWzJdISwgMTApLFxuICAgIGFsbG93ZWRWZXJiczogW10sXG4gIH07XG59XG5cbi8qKlxuICogUGFyc2UgdGhlIGd1YXJkJ3Mgb3duIGZsYWdzIHVwIHRvIHRoZSBgLS1gIHNlcGFyYXRvci5cbiAqXG4gKiBgLS1hY3RpdmVgIC8gYC0tYWxsb3ctcmVwbyA8c2x1Zz5gIGNhcnJ5IHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdDtcbiAqIGAtLWNsYWltZWQtaXNzdWUgPG93bmVyL3JlcG8jTj5gIGFuZCBgLS1hbGxvdy1pc3N1ZS12ZXJiIDx2ZXJiPmAgY2FycnkgdGhlXG4gKiBjbGFpbWVkLWlzc3VlIGxpZmVjeWNsZSBndWFyZCAoSXNzdWUgIzIyMik7IGAtLWJvZHktZGlyIDxkaXI+YCBuYW1lcyB0aGVcbiAqIGNhbGxlci1vd25lZCBkaXJlY3RvcnkgYSBtYXNrZWQgYC0taW5wdXRgIGJvZHkgaXMgd3JpdHRlbiB0byAoSXNzdWUgIzEzNjQpLlxuICovXG5mdW5jdGlvbiBwYXJzZUFyZ3YoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBQYXJzZWRBcmd2IHtcbiAgY29uc3QgYWxsb3dlZFJlcG9zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBhbGxvd2VkVmVyYnM6IHN0cmluZ1tdID0gW107XG4gIGxldCBjbGFpbWVkSXNzdWU6IENsYWltZWRJc3N1ZSB8IHVuZGVmaW5lZDtcbiAgbGV0IGJvZHlEaXI6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGF1ZGl0RGlyOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBhdWRpdFdvcmtlcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgYXVkaXRSdW46IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGFjdGl2ZSA9IGZhbHNlO1xuICBsZXQgaSA9IDA7XG4gIGNvbnN0IGZhaWwgPSAoZXJyb3I6IHN0cmluZyk6IFBhcnNlZEFyZ3YgPT4gKHtcbiAgICBhY3RpdmUsXG4gICAgYWxsb3dlZFJlcG9zLFxuICAgIGdoQXJnczogW10sXG4gICAgZXJyb3IsXG4gIH0pO1xuICBjb25zdCBmaW5pc2ggPSAoZ2hBcmdzOiBzdHJpbmdbXSk6IFBhcnNlZEFyZ3YgPT4gKHtcbiAgICBhY3RpdmUsXG4gICAgYWxsb3dlZFJlcG9zLFxuICAgIC4uLihjbGFpbWVkSXNzdWVcbiAgICAgID8geyBjbGFpbWVkSXNzdWU6IHsgLi4uY2xhaW1lZElzc3VlLCBhbGxvd2VkVmVyYnMgfSB9XG4gICAgICA6IHt9KSxcbiAgICAuLi4oYm9keURpciA/IHsgYm9keURpciB9IDoge30pLFxuICAgIC4uLihhdWRpdERpciAmJiBhdWRpdFdvcmtlciAmJiBhdWRpdFJ1blxuICAgICAgPyB7IGF1ZGl0OiB7IGJhc2VEaXI6IGF1ZGl0RGlyLCB3b3JrZXJJZDogYXVkaXRXb3JrZXIsIHJ1bklkOiBhdWRpdFJ1biB9IH1cbiAgICAgIDoge30pLFxuICAgIGdoQXJncyxcbiAgfSk7XG4gIGZvciAoOyBpIDwgYXJndi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJndltpXTtcbiAgICBpZiAodG9rZW4gPT09IFwiLS1cIikgcmV0dXJuIGZpbmlzaChhcmd2LnNsaWNlKGkgKyAxKSBhcyBzdHJpbmdbXSk7XG4gICAgaWYgKHRva2VuID09PSBcIi0tYWN0aXZlXCIpIHtcbiAgICAgIGFjdGl2ZSA9IHRydWU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuID09PSBcIi0tYWxsb3ctcmVwb1wiKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGFyZ3ZbaSArIDFdO1xuICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiBmYWlsKFwiLS1hbGxvdy1yZXBvIHJlcXVpcmVzIGEgdmFsdWVcIik7XG4gICAgICBhbGxvd2VkUmVwb3MucHVzaCh2YWx1ZSk7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuID09PSBcIi0tY2xhaW1lZC1pc3N1ZVwiKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGFyZ3ZbaSArIDFdO1xuICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiBmYWlsKFwiLS1jbGFpbWVkLWlzc3VlIHJlcXVpcmVzIGEgdmFsdWVcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUNsYWltZWRJc3N1ZSh2YWx1ZSk7XG4gICAgICBpZiAoIXBhcnNlZCkge1xuICAgICAgICByZXR1cm4gZmFpbChgLS1jbGFpbWVkLWlzc3VlIGV4cGVjdHMgb3duZXIvcmVwbyNOLCBnb3Q6ICR7dmFsdWV9YCk7XG4gICAgICB9XG4gICAgICBjbGFpbWVkSXNzdWUgPSBwYXJzZWQ7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuID09PSBcIi0tYm9keS1kaXJcIikge1xuICAgICAgY29uc3QgdmFsdWUgPSBhcmd2W2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBcIlwiKSB7XG4gICAgICAgIHJldHVybiBmYWlsKFwiLS1ib2R5LWRpciByZXF1aXJlcyBhIHZhbHVlXCIpO1xuICAgICAgfVxuICAgICAgYm9keURpciA9IHZhbHVlO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIElzc3VlICMxNjA0IOKAlCB0aGUgdGhyZWUgdHJhdmVsIHRvZ2V0aGVyOyBhIGpvdXJuYWwgZW50cnkgd2l0aCBhXG4gICAgLy8gbWFkZS11cCBwYXJ0aXRpb24gb3IgcnVuIGlkIHdvdWxkIGJlIGEgcmVjb3JkIHRoYXQgbGllcyByYXRoZXIgdGhhblxuICAgIC8vIG9uZSB0aGF0IGlzIG1pc3NpbmcsIHNvIGBmaW5pc2hgIG9ubHkgam91cm5hbHMgd2hlbiBhbGwgdGhyZWUgYXJyaXZlZC5cbiAgICBpZiAoXG4gICAgICB0b2tlbiA9PT0gXCItLWF1ZGl0LWRpclwiIHx8IHRva2VuID09PSBcIi0tYXVkaXQtd29ya2VyXCIgfHxcbiAgICAgIHRva2VuID09PSBcIi0tYXVkaXQtcnVuXCJcbiAgICApIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gYXJndltpICsgMV07XG4gICAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gXCJcIikge1xuICAgICAgICByZXR1cm4gZmFpbChgJHt0b2tlbn0gcmVxdWlyZXMgYSB2YWx1ZWApO1xuICAgICAgfVxuICAgICAgaWYgKHRva2VuID09PSBcIi0tYXVkaXQtZGlyXCIpIGF1ZGl0RGlyID0gdmFsdWU7XG4gICAgICBlbHNlIGlmICh0b2tlbiA9PT0gXCItLWF1ZGl0LXdvcmtlclwiKSBhdWRpdFdvcmtlciA9IHZhbHVlO1xuICAgICAgZWxzZSBhdWRpdFJ1biA9IHZhbHVlO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2tlbiA9PT0gXCItLWFsbG93LWlzc3VlLXZlcmJcIikge1xuICAgICAgY29uc3QgdmFsdWUgPSBhcmd2W2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBmYWlsKFwiLS1hbGxvdy1pc3N1ZS12ZXJiIHJlcXVpcmVzIGEgdmFsdWVcIik7XG4gICAgICB9XG4gICAgICBhbGxvd2VkVmVyYnMucHVzaCh2YWx1ZSk7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhaWwoYHVua25vd24gZ3VhcmQgYXJndW1lbnQ6ICR7dG9rZW59YCk7XG4gIH1cbiAgcmV0dXJuIGZhaWwoXCJtaXNzaW5nICctLScgc2VwYXJhdG9yIGJlZm9yZSB0aGUgZ2ggYXJndW1lbnRzXCIpO1xufVxuXG4vKipcbiAqIEV2YWx1YXRlIG9uZSBzaGltIGludm9jYXRpb24uXG4gKlxuICogQHBhcmFtIGFyZ3YgLSBUaGUgZ3VhcmQncyBvd24gYXJndiAoZ3VhcmQgZmxhZ3MsIGAtLWAsIHRoZW4gYGdoYCBhcmd1bWVudHMpLlxuICogQHBhcmFtIHJlYWRCb2R5RmlsZSAtIFJlYWRlciBmb3IgYC0tYm9keS1maWxlYCBjb250ZW50cyAodGVzdCBzZWFtKS5cbiAqIEBwYXJhbSB3cml0ZUJvZHlGaWxlIC0gV3JpdGVyIGZvciBhIG1hc2tlZCBgLS1pbnB1dGAgYm9keSAodGVzdCBzZWFtKS5cbiAqICAgRGVmYXVsdHMgdG8gb25lIHNjb3BlZCB0byBgLS1ib2R5LWRpcmA7IHdpdGggbmVpdGhlciwgYW4gYC0taW5wdXRgIGJvZHlcbiAqICAgdGhhdCBuZWVkcyBtYXNraW5nIGlzIHJlZnVzZWQgcmF0aGVyIHRoYW4gd3JpdHRlbiBzb21ld2hlcmUgdW5vd25lZFxuICogICAoSXNzdWUgIzEzNjQpLlxuICogQHJldHVybnMgVGhlIGV4aXQgY29kZSwgdGhlIHN0ZGVyciBsaW5lIHRvIGVtaXQsIGFuZCDigJQgd2hlbiBhbGxvd2VkIOKAlCB0aGVcbiAqICAgYXJndW1lbnRzIHRoZSBzaGltIG11c3QgcnVuLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVuR2hHdWFyZENsaShcbiAgYXJndjogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHJlYWRCb2R5RmlsZTogQm9keUZpbGVSZWFkZXIgPSBkZW5vQm9keUZpbGVSZWFkZXIsXG4gIHdyaXRlQm9keUZpbGU/OiBCb2R5RmlsZVdyaXRlcixcbik6IEdoR3VhcmRDbGlSZXN1bHQge1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZUFyZ3YoYXJndik7XG4gIGlmIChwYXJzZWQuZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgZXhpdENvZGU6IDIsXG4gICAgICBzdGRvdXQ6IEdIX0dVQVJEX1JFRlVTRV9NQVJLRVIsXG4gICAgICBzdGRlcnI6IGBbU0VDVVJJVFldIFtHSF9HVUFSRF9FUlJPUl0gJHtwYXJzZWQuZXJyb3J9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZGVjaXNpb24gPSBldmFsdWF0ZUdoQ29tbWFuZChwYXJzZWQuZ2hBcmdzLCB7XG4gICAgYWN0aXZlOiBwYXJzZWQuYWN0aXZlLFxuICAgIGFsbG93ZWRSZXBvczogcGFyc2VkLmFsbG93ZWRSZXBvcyxcbiAgICAvLyBJc3N1ZSAjMjIyOiB0aGUgY2xhaW1lZCBpc3N1ZSdzIGxpZmVjeWNsZSBndWFyZCwgd2hlbiB0aGUgcnVuIHNlZWRlZCBvbmUuXG4gICAgLi4uKHBhcnNlZC5jbGFpbWVkSXNzdWUgPyB7IGNsYWltZWRJc3N1ZTogcGFyc2VkLmNsYWltZWRJc3N1ZSB9IDoge30pLFxuICAgIC8vIElzc3VlICM5MTogbGV0IHRoZSBkZWNpc2lvbiBzY2FuIGEgcmVhZGFibGUgYC0taW5wdXQgPGZpbGU+YCBib2R5IGZvclxuICAgIC8vIHJlc2VydmVkIGxhYmVscyBpbnN0ZWFkIG9mIGZhaWxpbmcgY2xvc2VkIG9uIGV2ZXJ5IG9uZS4gVGhlIGRlY2lzaW9uXG4gICAgLy8gbW9kdWxlIHN0YXlzIHB1cmU7IHRoZSBmaWxlc3lzdGVtIHJlYWRlciBpcyBpbmplY3RlZCBoZXJlLlxuICAgIHJlYWRCb2R5RmlsZSxcbiAgfSk7XG4gIGlmIChkZWNpc2lvbi5hbGxvd2VkKSB7XG4gICAgcmV0dXJuIGFsbG93V2l0aFJlZGFjdGVkQm9keShcbiAgICAgIHBhcnNlZCxcbiAgICAgIHJlYWRCb2R5RmlsZSxcbiAgICAgIHdyaXRlQm9keUZpbGUgPz9cbiAgICAgICAgKHBhcnNlZC5ib2R5RGlyID8gYm9keUZpbGVXcml0ZXJJbihwYXJzZWQuYm9keURpcikgOiB1bmRlZmluZWQpLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGV4aXRDb2RlOiAxLFxuICAgIHN0ZG91dDogR0hfR1VBUkRfUkVGVVNFX01BUktFUixcbiAgICBzdGRlcnI6IGBbU0VDVVJJVFldIFske2RlY2lzaW9uLm1hcmtlcn1dICR7ZGVjaXNpb24ucmVhc29ufWAsXG4gICAgcmVmdXNhbDoge1xuICAgICAgLy8gQWx3YXlzIHNldCBvbiBhIHJlZnVzYWw7IHRoZSBkZWNpc2lvbiB0eXBlIGxlYXZlcyB0aGVtIG9wdGlvbmFsIGZvclxuICAgICAgLy8gdGhlIGFsbG93ZWQgc2hhcGUuXG4gICAgICBtYXJrZXI6IGRlY2lzaW9uLm1hcmtlciA/PyBcIkdIX0dVQVJEX1JFRlVTRURcIixcbiAgICAgIHJlYXNvbjogZGVjaXNpb24ucmVhc29uID8/IFwiXCIsXG4gICAgICBnaEFyZ3M6IHBhcnNlZC5naEFyZ3MsXG4gICAgfSxcbiAgICAuLi4ocGFyc2VkLmF1ZGl0ID8geyBhdWRpdDogcGFyc2VkLmF1ZGl0IH0gOiB7fSksXG4gIH07XG59XG5cbi8qKlxuICogQXBwZW5kIGEgcmVmdXNlZCBjb21tYW5kIHRvIHRoZSBhdWRpdCBqb3VybmFsIChJc3N1ZSAjMTYwNCkuXG4gKlxuICogUnVucyBpbiB0aGUgZ3VhcmQgY2hpbGQgYWZ0ZXIgdGhlIHZlcmRpY3QgaGFzIGJlZW4gd3JpdHRlbiwgd2l0aCB0aGVcbiAqIGpvdXJuYWwgbG9jYXRpb24gdGhlIHNoaW0gaGFuZGVkIG92ZXIuIFRoZSBlbnRyeSBuYW1lcyB0aGUgY29udHJvbCwgdGhlXG4gKiByZWFzb24gYW5kIHRoZSBhcmd2IHRoZSBhZ2VudCBpc3N1ZWQg4oCUIHRoZSBhcmd2IHBhc3NlZCB0aHJvdWdoIHRoZSBzYW1lXG4gKiBzZWNyZXQgcmVkYWN0aW9uIHRoZSBzdGRlcnIgbGluZSBnZXRzLCBhbmQgY2FwcGVkLCBiZWNhdXNlIGl0IGlzXG4gKiBhZ2VudC1hdXRob3JlZCB0ZXh0IHRoYXQgYSBjcmVkZW50aWFsIGNvdWxkIHJpZGUgaW4uIE5ldmVyIHRocm93cywgYW5kXG4gKiBuZXZlciBjaGFuZ2VzIHRoZSB2ZXJkaWN0OiBhIGpvdXJuYWwgdGhhdCBjYW5ub3QgYmUgd3JpdHRlbiBpcyByZXBvcnRlZFxuICogdGhyb3VnaCB0aGUgUmVzdWx0LCBhbmQgdGhlIGNhbGxlciBzYXlzIHNvIG9uIHN0ZGVyci5cbiAqXG4gKiBAcGFyYW0gcmVzdWx0IC0gVGhlIGV2YWx1YXRpb24sIGNhcnJ5aW5nIGByZWZ1c2FsYCBhbmQgYGF1ZGl0YC5cbiAqIEBwYXJhbSByZWNvcmQgLSBUaGUgam91cm5hbCBhcHBlbmQgKHRlc3Qgc2VhbTsgZGVmYXVsdHMgdG8gdGhlIHJlYWwgb25lKS5cbiAqIEByZXR1cm5zIGBvazogdHJ1ZWAgd2hlbiBqb3VybmFsZWQgb3Igd2hlbiB0aGVyZSB3YXMgbm90aGluZyB0byBqb3VybmFsO1xuICogICBgb2s6IGZhbHNlYCB3aXRoIHRoZSByZWFzb24gd2hlbiB0aGUgYXBwZW5kIGZhaWxlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGpvdXJuYWxHdWFyZFJlZnVzYWwoXG4gIHJlc3VsdDogR2hHdWFyZENsaVJlc3VsdCxcbiAgcmVjb3JkOiB0eXBlb2YgcmVjb3JkTXV0YXRpb24gPSByZWNvcmRNdXRhdGlvbixcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IHsgcmVmdXNhbCwgYXVkaXQgfSA9IHJlc3VsdDtcbiAgaWYgKHJlZnVzYWwgPT09IHVuZGVmaW5lZCB8fCBhdWRpdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuICBjb25zdCBhcmd2ID0gcmVmdXNhbC5naEFyZ3Muam9pbihcIiBcIik7XG4gIGNvbnN0IGJvdW5kZWQgPSBhcmd2Lmxlbmd0aCA+IEdIX0dVQVJEX1JFRlVTQUxfVEFSR0VUX0NIQVJTXG4gICAgPyBgJHthcmd2LnNsaWNlKDAsIEdIX0dVQVJEX1JFRlVTQUxfVEFSR0VUX0NIQVJTKX3igKZgXG4gICAgOiBhcmd2O1xuICBjb25zdCBtdXRhdGlvbjogQXVkaXRNdXRhdGlvbiA9IHtcbiAgICBydW5JZDogYXVkaXQucnVuSWQsXG4gICAgdmVyYjogR0hfR1VBUkRfUkVGVVNBTF9BVURJVF9WRVJCLFxuICAgIG91dGNvbWU6IFwiZXJyb3JcIixcbiAgICBleGl0Q29kZTogcmVzdWx0LmV4aXRDb2RlLFxuICAgIHRhcmdldDogYCR7cmVmdXNhbC5tYXJrZXJ9OiBnaCAke3JlZGFjdFNlY3JldHMoYm91bmRlZCl9YCxcbiAgICBjYWxsZXI6IFwid29ya2VyL2Rlbm8vbGliL2doX2d1YXJkX2NsaS50c1wiLFxuICB9O1xuICB0cnkge1xuICAgIGNvbnN0IGFwcGVuZGVkID0gYXdhaXQgcmVjb3JkKG11dGF0aW9uLCB7XG4gICAgICBiYXNlRGlyOiBhdWRpdC5iYXNlRGlyLFxuICAgICAgd29ya2VySWQ6IGF1ZGl0LndvcmtlcklkLFxuICAgICAgLy8gTm8gYC0tYWxsb3ctZW52YCBpbiB0aGUgZ3VhcmQgY2hpbGQ6IGV2ZXJ5IGVudmlyb25tZW50IHF1ZXN0aW9uIHRoZVxuICAgICAgLy8gam91cm5hbCBjb3VsZCBhc2sgaXMgYW5zd2VyZWQgXCJ1bnNldFwiIHJhdGhlciB0aGFuIHRocm93bi5cbiAgICAgIGVudjogKCkgPT4gdW5kZWZpbmVkLFxuICAgIH0pO1xuICAgIGlmICghYXBwZW5kZWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGFwcGVuZGVkLmVycm9yIH07XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIE1hc2sgdGhlIHB1Ymxpc2hlZCBib2RpZXMgb2YgYW4gYWxsb3dlZCBjb21tYW5kIChJc3N1ZSAjMzkzOCkuXG4gKlxuICogQSBib2R5IHRoYXQgY2Fubm90IGJlIHNjYW5uZWQgYXQgYWxsIHJlZnVzZXMgdGhlIGNhbGw6IHB1Ymxpc2hpbmcgaXQgYW55d2F5XG4gKiB3b3VsZCByZXBvcnQgYSBmYWlsZWQgY29udHJvbCBhcyBhIHN1Y2Nlc3MuIFNvIGRvZXMgYSBib2R5IHRoYXQgbmVlZHNcbiAqIG1hc2tpbmcgd2hlbiBubyB3cml0ZXIgZXhpc3RzIChJc3N1ZSAjMTM2NCkg4oCUIHRoZSByZWRhY3RlZCBjb3B5IGhhcyBub3doZXJlXG4gKiBvd25lZCB0byBsaXZlLCBhbmQgYW4gdW5vd25lZCB0ZW1wIGZpbGUgaXMgbm90IHRoZSBhbnN3ZXIuXG4gKi9cbmZ1bmN0aW9uIGFsbG93V2l0aFJlZGFjdGVkQm9keShcbiAgcGFyc2VkOiBQYXJzZWRBcmd2LFxuICByZWFkQm9keUZpbGU6IEJvZHlGaWxlUmVhZGVyLFxuICB3cml0ZUJvZHlGaWxlOiBCb2R5RmlsZVdyaXRlciB8IHVuZGVmaW5lZCxcbik6IEdoR3VhcmRDbGlSZXN1bHQge1xuICBsZXQgZ2hBcmdzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBnaEFyZ3MgPSByZWRhY3RHaEJvZHlBcmdzKHBhcnNlZC5naEFyZ3MsIHJlYWRCb2R5RmlsZSwgd3JpdGVCb2R5RmlsZSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghKGVyciBpbnN0YW5jZW9mIFVucmVkYWN0YWJsZUJvZHlFcnJvcikpIHRocm93IGVycjtcbiAgICByZXR1cm4ge1xuICAgICAgZXhpdENvZGU6IDEsXG4gICAgICBzdGRvdXQ6IEdIX0dVQVJEX1JFRlVTRV9NQVJLRVIsXG4gICAgICBzdGRlcnI6IGBbU0VDVVJJVFldIFtHSF9CT0RZX1VOUkVEQUNUQUJMRV0gJHtlcnIubWVzc2FnZX1gLFxuICAgICAgLy8gQSBib2R5IHRoZSBndWFyZCBjb3VsZCBub3Qgc2NhbiBpcyBhIHJlZnVzYWwgbGlrZSBhbnkgb3RoZXJcbiAgICAgIC8vIChJc3N1ZSAjMTYwNCk6IGpvdXJuYWxlZCwgc28gdGhlIGxvc3MgaXMgdmlzaWJsZSBhZnRlciB0aGUgZmFjdC5cbiAgICAgIHJlZnVzYWw6IHtcbiAgICAgICAgbWFya2VyOiBcIkdIX0JPRFlfVU5SRURBQ1RBQkxFXCIsXG4gICAgICAgIHJlYXNvbjogZXJyLm1lc3NhZ2UsXG4gICAgICAgIGdoQXJnczogcGFyc2VkLmdoQXJncyxcbiAgICAgIH0sXG4gICAgICAuLi4ocGFyc2VkLmF1ZGl0ID8geyBhdWRpdDogcGFyc2VkLmF1ZGl0IH0gOiB7fSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHJlZGFjdGVkID0gZ2hBcmdzLnNvbWUoKGFyZywgaSkgPT4gYXJnICE9PSBwYXJzZWQuZ2hBcmdzW2ldKTtcbiAgcmV0dXJuIHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IEdIX0dVQVJEX0FMTE9XX01BUktFUixcbiAgICBzdGRlcnI6IHJlZGFjdGVkXG4gICAgICA/IFwiW1NFQ1VSSVRZXSBbR0hfQk9EWV9SRURBQ1RFRF0gYSBzZWNyZXQgd2FzIG1hc2tlZCBpbiB0aGUgYm9keSBvZiBcIiArXG4gICAgICAgIFwidGhpcyBnaCBjb21tYW5kIGJlZm9yZSBpdCByZWFjaGVkIEdpdEh1Yi5cIlxuICAgICAgOiBcIlwiLFxuICAgIGdoQXJncyxcbiAgfTtcbn1cblxuaWYgKGltcG9ydC5tZXRhLm1haW4pIHtcbiAgLy8gSXNzdWUgIzEyODAgKFNFQy0xMjE3LTEyKTogdGhlIGd1YXJkIGNoaWxkIGlzIGl0cyBvd24gcHJvY2Vzcy4gSXRzXG4gIC8vIHN0ZG91dCBpcyB0aGUgTlVMLWVuY29kZWQgdmVyZGljdCB3cml0dGVuIHRocm91Z2ggYERlbm8uc3Rkb3V0YCBhbmQgaXNcbiAgLy8gdW50b3VjaGVkIGJ5IHRoZSBwYXRjaDsgdGhlIHJlZnVzYWwgcmVhc29uIG9uIHN0ZGVyciBxdW90ZXMgdGhlIGFnZW50J3NcbiAgLy8gb3duIGFyZ3YsIHdoaWNoIGlzIHdoZXJlIGEgY3JlZGVudGlhbCBjYW4gcmlkZSBpbi5cbiAgaW5zdGFsbENvbnNvbGVSZWRhY3Rpb24oKTtcblxuICBjb25zdCByZXN1bHQgPSBydW5HaEd1YXJkQ2xpKERlbm8uYXJncyk7XG4gIGF3YWl0IERlbm8uc3Rkb3V0LndyaXRlKG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShlbmNvZGVHdWFyZFN0ZG91dChyZXN1bHQpKSk7XG4gIGlmIChyZXN1bHQuc3RkZXJyKSBjb25zb2xlLmVycm9yKHJlc3VsdC5zdGRlcnIpO1xuICAvLyBJc3N1ZSAjMTYwNDogdGhlIHJlZnVzYWwgb3V0bGl2ZXMgdGhpcyBwcm9jZXNzIGluIHRoZSBqb3VybmFsLCBvciB0aGVcbiAgLy8gZmFpbHVyZSB0byByZWNvcmQgaXQgaXMgc2FpZCBvdXQgbG91ZCDigJQgYWZ0ZXIgdGhlIHZlcmRpY3QsIG5ldmVyIGluc3RlYWRcbiAgLy8gb2YgaXQuXG4gIGNvbnN0IGpvdXJuYWxlZCA9IGF3YWl0IGpvdXJuYWxHdWFyZFJlZnVzYWwocmVzdWx0KTtcbiAgaWYgKCFqb3VybmFsZWQub2spIHtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgYFtTRUNVUklUWV0gW0FVRElUX0pPVVJOQUxfUkVGVVNFRF0gJHtHSF9HVUFSRF9SRUZVU0FMX0FVRElUX1ZFUkJ9OiBgICtcbiAgICAgICAgam91cm5hbGVkLmVycm9yLm1lc3NhZ2UsXG4gICAgKTtcbiAgfVxuICBEZW5vLmV4aXQocmVzdWx0LmV4aXRDb2RlKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMENDLEdBRUQsU0FHRSxnQkFBZ0IsRUFDaEIscUJBQXFCLFFBQ2hCLHlCQUF5QjtBQUNoQywyRUFBMkU7QUFDM0UsU0FBUyxnQkFBZ0IsRUFBRSxrQkFBa0IsUUFBUSx1QkFBdUI7QUFDNUUsU0FBUyx1QkFBdUIsUUFBUSx5QkFBeUI7QUFDakUsU0FBUyxlQUFlLFFBQVEsNEJBQTRCO0FBQzVELFNBQVMsaUJBQWlCLFFBQVEseUJBQXlCO0FBRzNELFNBQVMsY0FBYyxRQUFRLHFCQUFxQjtBQUNwRCxTQUFTLGFBQWEsUUFBUSx3QkFBd0I7QUFHdEQsc0VBQXNFLEdBQ3RFLE9BQU8sTUFBTSx3QkFBd0Isc0JBQXNCO0FBRTNELDBEQUEwRCxHQUMxRCxPQUFPLE1BQU0seUJBQXlCLHVCQUF1QjtBQUU3RCwyRUFBMkUsR0FDM0UsT0FBTyxNQUFNLDhCQUE4QixtQkFBbUI7QUFFOUQsdUVBQXVFLEdBQ3ZFLE9BQU8sTUFBTSxnQ0FBZ0MsSUFBSTtBQTBDakQ7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sU0FBUyxrQkFBa0IsTUFBd0I7RUFDeEQsT0FBTyxnQkFBZ0I7SUFBQyxPQUFPLE1BQU07T0FBTSxPQUFPLE1BQU0sSUFBSSxFQUFFO0dBQUU7QUFDbEU7QUFxQkEsbURBQW1ELEdBQ25ELFNBQVMsa0JBQWtCLEtBQWE7RUFDdEMsTUFBTSxRQUFRLE1BQU0sS0FBSyxDQUFDO0VBQzFCLElBQUksQ0FBQyxPQUFPLE9BQU87RUFDbkIsT0FBTztJQUNMLE1BQU0sS0FBSyxDQUFDLEVBQUU7SUFDZCxhQUFhLFNBQVMsS0FBSyxDQUFDLEVBQUUsRUFBRztJ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
// denoCacheMetadata=18101068658360083386,100135053764830609