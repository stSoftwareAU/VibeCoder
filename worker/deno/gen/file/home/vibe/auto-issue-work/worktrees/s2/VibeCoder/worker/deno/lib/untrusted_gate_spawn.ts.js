/**
 * Running repository code at the milestone gates (Issue #4659).
 *
 * `spawnTask` (milestone_resolution_gate.ts) and `spawnTypeCheck`
 * (milestone_merge_gate.ts) run the repository's own commands. They used to
 * inherit the worker's whole environment, so a credential such as `GH_TOKEN`
 * or `ANTHROPIC_API_KEY` reached code the repository controls. This helper
 * runs them with the allowlist of Issue #572 and `clearEnv`, as the `agent`
 * account where that account can use the checkout.
 *
 * Access failures leave commands to CI and never select the worker account.
 * A refusal names the topmost directory the account cannot traverse (Issue #4733).
 * A directory the account cannot write leaves a command to CI only for a command
 * that needs the write probe (cargo's Cargo.lock, a repository script). A Deno
 * check with a committed deno.lock may run without it; its caller leaves a
 * lockfile write refusal to CI. Git-created directories inside a clone are not
 * group-writable (Issue #4782).
 * Only the absence of an agent account selects the restricted worker
 * environment. Declared credentials cannot, and neither can tree-controlled
 * layouts or permissions. Declared credentials reach an agent command through
 * the stdin channel of credential_channel.ts (Issue #4705).
 * Unwritable cargo targets use the configured, persistent per-account cache.
 *
 * Australian English spelling used throughout.
 */ import { carryEnvThroughSudo, sudoCarriedEnv, untrustedAccountOf, untrustedQualityCommandEnv, untrustedSpawn } from "./quality_gate_phase.ts";
import { carryCredentialsThroughSudo, credentialChannelFault } from "./credential_channel.ts";
import { cargoTargetDirForCheckout } from "./ephemeral_build_cache.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
let gateCredentialSource;
/** Register the source {@link runRepositoryCommand} reads declared credentials from. */ export function setGateCredentialSource(source) {
  gateCredentialSource = source;
}
/** A host access probe could not safely run the command as the chosen account. */ export class GateAccountUnavailable extends Error {
}
/** The access probe found that a writing command cannot write its checkout. */ export class GateCheckoutUnwritable extends GateAccountUnavailable {
}
/** The probe exits with this when the account cannot read the checkout. */ const PROBE_UNREADABLE = 1;
/** The probe exits with this when the account cannot write the cargo target. */ const PROBE_TARGET_UNWRITABLE = 2;
/**
 * The probe exits with this when the account cannot write the checkout and the
 * command writes there (Issue #4782). A read-only command never gets it.
 * Project access can be shaped by the tree; never use it to select an account.
 */ const PROBE_CHECKOUT_UNWRITABLE = 3;
/** The probe is a few `test` and `find` calls. Seconds. */ const PROBE_TIMEOUT_MS = 15_000;
async function workerUid(deps) {
  if (deps.workerUid) return await deps.workerUid();
  const uid = await runWithTimeout("id", [
    "-u"
  ], {
    timeoutMs: PROBE_TIMEOUT_MS
  });
  const value = uid.ok ? uid.value.stdout.trim() : "";
  if (!uid.ok || uid.value.code !== 0 || uid.value.timedOut || !/^\d+$/.test(value)) {
    throw new Error("cannot determine worker uid");
  }
  return Number(value);
}
/** A manifest name the probe script may embed in its text. */ const SAFE_MANIFEST = /^[A-Za-z0-9._-]+$/;
/** Stat `path`, or undefined when it is absent. Other errors propagate. */ async function statOrUndefined(path) {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
/** Lstat `path`, or undefined when it is absent. Other errors propagate. */ async function lstatOrUndefined(path) {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
/**
 * The manifests a gate probes for in a checkout.
 *
 * @param kind - `cargo` gives `Cargo.toml`, `script` gives `quality.sh`, and
 *   `deno` gives whichever of `deno.json` and `deno.jsonc` exists as a file.
 * @param dir - The checkout to look in.
 * @returns The manifest names; empty for a `deno` checkout with neither.
 * @throws When a stat fails for any reason other than the file being absent.
 */ export async function manifestsFor(kind, dir) {
  if (kind === "cargo") return [
    "Cargo.toml"
  ];
  if (kind === "script") return [
    "quality.sh"
  ];
  const found = [];
  for (const name of [
    "deno.json",
    "deno.jsonc"
  ]){
    if ((await statOrUndefined(`${dir}/${name}`))?.isFile) found.push(name);
  }
  return found;
}
/**
 * The shell fragment that checks a cargo build can write its target.
 *
 * Without a `target` directory the checkout itself must be writable, because
 * cargo creates one. With one, every entry in it must be. A failure here is
 * not a reason to run the tree's code as the worker: the tree can cause it
 * (a committed `target/` file), so the caller gives the account a target of
 * its own instead.
 */ async function targetWriteCheck(cwd) {
  const exists = await statOrUndefined(`${cwd}/target`) !== undefined;
  return exists ? `[ -z "$(find "$1/target" ! -exec test -w {} \\; -print -quit)" ]` : `test -w "$1"`;
}
/**
 * Prints the topmost ancestor of `$1` the account cannot traverse, or nothing.
 * It walks down from `/`: a deeper `test -x` fails for every descendant of a
 * blocked ancestor, so only the first failure is the cause (Issue #4733).
 * Read-only POSIX sh; `$1` is an argument and is never embedded in the text.
 */ const TRAVERSAL_WALK = `( IFS=/; set -f; p=; for c in $1; do [ -n "$c" ] || continue; p="$p/$c"; [ -x "$p" ] || { printf '%s\\n' "$p"; break; }; done )`;
/**
 * The directory a probe named as untraversable, or undefined when its stdout
 * is not one plausible absolute path. The first line, trimmed, must start with
 * `/`, hold no control characters, and be at most 300 characters (Issue #4733).
 */ function blockedDirectoryOf(stdout) {
  const line = (stdout.split("\n")[0] ?? "").trim();
  if (!line.startsWith("/") || line.length > 300) return undefined;
  for(let i = 0; i < line.length; i++){
    const code = line.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return line;
}
/**
 * The probe script. `$1` is the checkout and is passed as an argument, never
 * interpolated, so a path cannot change the script.
 *
 * @param requireWrite - Whether the checkout must be writable by the account.
 *   Only a command that writes there needs it (Issue #4782).
 * @throws When a manifest name is not a plain file name.
 */ function probeScript(manifests, tail, requireWrite) {
  const reads = manifests.map((name)=>{
    if (!SAFE_MANIFEST.test(name)) {
      throw new Error(`refusing to probe manifest '${name}': only a plain file name may be ` + `embedded in the probe (Issue #4659)`);
    }
    return ` -a -r "$1/${name}"`;
  });
  const writable = requireWrite ? `; test -w "$1" || exit ${PROBE_CHECKOUT_UNWRITABLE}` : "";
  const readable = `${TRAVERSAL_WALK}; test -r "$1" -a -x "$1"${reads.join("")} || exit ${PROBE_UNREADABLE}${writable}`;
  return tail === "" ? readable : `${readable}; ${tail} || exit ${PROBE_TARGET_UNWRITABLE}`;
}
/**
 * Run a repository command with the allowlisted environment and explicitly
 * declared credentials, as `agent` when it can use the checkout. Declared
 * credentials cross sudo's environment reset on the stdin channel (Issue
 * #4705), so they never select the worker account.
 *
 * The account is probed with a command of its own. Access faults leave the
 * command to CI, without changing its account. A refusal names the topmost
 * directory the account cannot traverse, when the probe reports one. A
 * directory the account cannot write leaves a command to CI only when that
 * command needs the write probe (cargo's Cargo.lock, a repository script). A
 * Deno check with a committed deno.lock may run without it; its caller leaves
 * a lockfile write refusal to CI. Git-created directories inside a clone are
 * not group-writable (Issue #4782).
 *
 * @param executable - The command, e.g. `cargo` or `deno`.
 * @param args - Its arguments.
 * @param options.cwd - The checkout the command runs in.
 * @param options.timeoutMs - The budget for the command itself.
 * @param options.manifests - Files the command reads from the checkout; each
 *   must be readable by the account the command runs as.
 * @param options.readOnlyCheckout - Allow a command to run without a writable
 *   checkout directory. Its caller must leave any expected write refusal to CI
 *   (caches live elsewhere, e.g. DENO_DIR). The probe does not require the
 *   account to be able to write the directory.
 *   Omitted or false keeps the requirement, so a caller that forgets it fails
 *   closed to CI (Issue #4782).
 * @param deps - Injection seams. Production omits them.
 * @returns The spawn result of the command.
 * @throws When a manifest name is not a plain file name.
 */ export async function runRepositoryCommand(executable, args, options, deps = {}) {
  const spawn = deps.spawn ?? runWithTimeout;
  const drop = deps.drop ?? untrustedSpawn;
  const manifests = options.manifests ?? [];
  // A manifest that is a link can point at a file the account cannot read, so
  // the tree would choose which account runs its code. Refuse it (Issue #4659).
  for (const name of manifests){
    if (!SAFE_MANIFEST.test(name)) probeScript([
      name
    ], "", true);
    let info;
    try {
      info = await lstatOrUndefined(`${options.cwd}/${name}`);
    } catch (error) {
      return {
        ok: false,
        error: new Error(`cannot inspect '${name}' in '${options.cwd}': ${error instanceof Error ? error.message : String(error)}`)
      };
    }
    if (info && info.uid !== null) {
      const ownerUid = await workerUid(deps);
      if (info.uid !== ownerUid) {
        return {
          ok: false,
          error: new Error(`refusing to run '${executable}': '${name}' is not owned by the worker (Issue #4659)`)
        };
      }
    }
    if (info?.isSymlink) {
      return {
        ok: false,
        error: new Error(`refusing to run '${executable}': '${name}' in '${options.cwd}' is ` + `a symbolic link (Issue #4659)`)
      };
    }
  }
  let declared;
  try {
    declared = await (deps.credentials ?? gateCredentialSource)?.(options.cwd) ?? {};
  } catch (error) {
    return {
      ok: false,
      error: new Error(`the repository's quality_credentials could not be resolved ` + `(${error instanceof Error ? error.message : String(error)})`)
    };
  }
  const buildEnv = (spawnable)=>untrustedQualityCommandEnv({
      spawnable,
      cwd: options.cwd,
      repoCredentialEnv: declared,
      ...deps.source === undefined ? {} : {
        source: deps.source
      },
      ...deps.trimRefused === undefined ? {} : {
        trimRefused: deps.trimRefused
      },
      ...deps.root === undefined ? {} : {
        root: deps.root
      }
    });
  let privateTarget;
  {
    const spawnable = await drop([
      executable,
      ...args
    ]);
    if (untrustedAccountOf(spawnable) !== undefined) {
      const writesTarget = executable === "cargo" && buildEnv(spawnable)["CARGO_TARGET_DIR"] === undefined;
      const probe = await drop([
        "sh",
        "-c",
        probeScript(manifests, writesTarget ? await targetWriteCheck(options.cwd) : "", options.readOnlyCheckout !== true),
        "sh",
        options.cwd
      ]);
      const [probeCommand = "", ...probeArgs] = probe;
      const verdict = await spawn(probeCommand, probeArgs, {
        cwd: options.cwd,
        timeoutMs: PROBE_TIMEOUT_MS,
        env: buildEnv(spawnable),
        clearEnv: true
      });
      const code = verdict.ok ? verdict.value.code : undefined;
      if (verdict.ok && code === PROBE_TARGET_UNWRITABLE && !verdict.value.timedOut) {
        // The tree can make its own `target` unwritable (a committed file), so
        // that never chooses the account: the account builds elsewhere.
        if (deps.privateTargetRoot !== undefined) {
          try {
            try {
              await Deno.mkdir(deps.privateTargetRoot);
            } catch (error) {
              if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
            }
            const root = await Deno.lstat(deps.privateTargetRoot);
            if (!root.isDirectory || root.uid === null || root.uid !== await workerUid(deps)) {
              throw new Error("private target is not a worker-owned directory");
            }
            await Deno.chmod(deps.privateTargetRoot, 0o1777);
          } catch  {
            return {
              ok: false,
              error: new GateAccountUnavailable(`cannot provision private cargo target '${deps.privateTargetRoot}' — left to CI (Issue #4697)`)
            };
          }
        }
        privateTarget = cargoTargetDirForCheckout(options.cwd, {
          root: deps.privateTargetRoot ?? deps.root ?? `${options.cwd}/.vibe-cargo-target`,
          account: untrustedAccountOf(spawnable)
        });
      } else if (!verdict.ok || code !== 0 || verdict.value.timedOut) {
        // Only the unreadable verdict says which directory blocks the account.
        const blocked = verdict.ok && code === PROBE_UNREADABLE && !verdict.value.timedOut ? blockedDirectoryOf(verdict.value.stdout) : undefined;
        const cause = `probe ${code ?? "failed"}`;
        const reason = blocked === undefined ? cause : `${cause}; cannot traverse '${blocked}'`;
        return {
          ok: false,
          error: new (code === PROBE_CHECKOUT_UNWRITABLE && verdict.ok && !verdict.value.timedOut ? GateCheckoutUnwritable : GateAccountUnavailable)(`untrusted account cannot use '${options.cwd}' (${reason}) — left to CI (Issue #4659)`)
        };
      }
    }
    const env = {
      ...buildEnv(spawnable),
      ...privateTarget === undefined ? {} : {
        CARGO_TARGET_DIR: privateTarget
      }
    };
    // The placement and the egress proxy past sudo's env_reset (Issues
    // #2247, #4877): without the proxy every registry fetch fails to resolve.
    const final = carryEnvThroughSudo(spawnable, sudoCarriedEnv(env));
    let channelled;
    try {
      channelled = carryCredentialsThroughSudo(final, declared);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
    const [command = "", ...commandArgs] = channelled.argv;
    const result = await spawn(command, commandArgs, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env,
      clearEnv: true,
      stdin: channelled.stdin
    });
    const fault = result.ok && channelled.stdin !== undefined ? credentialChannelFault(result.value) : undefined;
    if (fault !== undefined) {
      return {
        ok: false,
        error: new GateAccountUnavailable(`the repository's declared quality_credentials could not be ` + `delivered to the untrusted account (${fault}) — left to CI ` + `(Issue #4705)`)
      };
    }
    return result;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi91bnRydXN0ZWRfZ2F0ZV9zcGF3bi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJ1bm5pbmcgcmVwb3NpdG9yeSBjb2RlIGF0IHRoZSBtaWxlc3RvbmUgZ2F0ZXMgKElzc3VlICM0NjU5KS5cbiAqXG4gKiBgc3Bhd25UYXNrYCAobWlsZXN0b25lX3Jlc29sdXRpb25fZ2F0ZS50cykgYW5kIGBzcGF3blR5cGVDaGVja2BcbiAqIChtaWxlc3RvbmVfbWVyZ2VfZ2F0ZS50cykgcnVuIHRoZSByZXBvc2l0b3J5J3Mgb3duIGNvbW1hbmRzLiBUaGV5IHVzZWQgdG9cbiAqIGluaGVyaXQgdGhlIHdvcmtlcidzIHdob2xlIGVudmlyb25tZW50LCBzbyBhIGNyZWRlbnRpYWwgc3VjaCBhcyBgR0hfVE9LRU5gXG4gKiBvciBgQU5USFJPUElDX0FQSV9LRVlgIHJlYWNoZWQgY29kZSB0aGUgcmVwb3NpdG9yeSBjb250cm9scy4gVGhpcyBoZWxwZXJcbiAqIHJ1bnMgdGhlbSB3aXRoIHRoZSBhbGxvd2xpc3Qgb2YgSXNzdWUgIzU3MiBhbmQgYGNsZWFyRW52YCwgYXMgdGhlIGBhZ2VudGBcbiAqIGFjY291bnQgd2hlcmUgdGhhdCBhY2NvdW50IGNhbiB1c2UgdGhlIGNoZWNrb3V0LlxuICpcbiAqIEFjY2VzcyBmYWlsdXJlcyBsZWF2ZSBjb21tYW5kcyB0byBDSSBhbmQgbmV2ZXIgc2VsZWN0IHRoZSB3b3JrZXIgYWNjb3VudC5cbiAqIEEgcmVmdXNhbCBuYW1lcyB0aGUgdG9wbW9zdCBkaXJlY3RvcnkgdGhlIGFjY291bnQgY2Fubm90IHRyYXZlcnNlIChJc3N1ZSAjNDczMykuXG4gKiBBIGRpcmVjdG9yeSB0aGUgYWNjb3VudCBjYW5ub3Qgd3JpdGUgbGVhdmVzIGEgY29tbWFuZCB0byBDSSBvbmx5IGZvciBhIGNvbW1hbmRcbiAqIHRoYXQgbmVlZHMgdGhlIHdyaXRlIHByb2JlIChjYXJnbydzIENhcmdvLmxvY2ssIGEgcmVwb3NpdG9yeSBzY3JpcHQpLiBBIERlbm9cbiAqIGNoZWNrIHdpdGggYSBjb21taXR0ZWQgZGVuby5sb2NrIG1heSBydW4gd2l0aG91dCBpdDsgaXRzIGNhbGxlciBsZWF2ZXMgYVxuICogbG9ja2ZpbGUgd3JpdGUgcmVmdXNhbCB0byBDSS4gR2l0LWNyZWF0ZWQgZGlyZWN0b3JpZXMgaW5zaWRlIGEgY2xvbmUgYXJlIG5vdFxuICogZ3JvdXAtd3JpdGFibGUgKElzc3VlICM0NzgyKS5cbiAqIE9ubHkgdGhlIGFic2VuY2Ugb2YgYW4gYWdlbnQgYWNjb3VudCBzZWxlY3RzIHRoZSByZXN0cmljdGVkIHdvcmtlclxuICogZW52aXJvbm1lbnQuIERlY2xhcmVkIGNyZWRlbnRpYWxzIGNhbm5vdCwgYW5kIG5laXRoZXIgY2FuIHRyZWUtY29udHJvbGxlZFxuICogbGF5b3V0cyBvciBwZXJtaXNzaW9ucy4gRGVjbGFyZWQgY3JlZGVudGlhbHMgcmVhY2ggYW4gYWdlbnQgY29tbWFuZCB0aHJvdWdoXG4gKiB0aGUgc3RkaW4gY2hhbm5lbCBvZiBjcmVkZW50aWFsX2NoYW5uZWwudHMgKElzc3VlICM0NzA1KS5cbiAqIFVud3JpdGFibGUgY2FyZ28gdGFyZ2V0cyB1c2UgdGhlIGNvbmZpZ3VyZWQsIHBlcnNpc3RlbnQgcGVyLWFjY291bnQgY2FjaGUuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dC5cbiAqL1xuXG5pbXBvcnQge1xuICBjYXJyeUVudlRocm91Z2hTdWRvLFxuICBzdWRvQ2FycmllZEVudixcbiAgdW50cnVzdGVkQWNjb3VudE9mLFxuICB1bnRydXN0ZWRRdWFsaXR5Q29tbWFuZEVudixcbiAgdW50cnVzdGVkU3Bhd24sXG59IGZyb20gXCIuL3F1YWxpdHlfZ2F0ZV9waGFzZS50c1wiO1xuaW1wb3J0IHtcbiAgY2FycnlDcmVkZW50aWFsc1Rocm91Z2hTdWRvLFxuICBjcmVkZW50aWFsQ2hhbm5lbEZhdWx0LFxufSBmcm9tIFwiLi9jcmVkZW50aWFsX2NoYW5uZWwudHNcIjtcbmltcG9ydCB0eXBlIHsgQ2hhbm5lbGxlZENvbW1hbmQgfSBmcm9tIFwiLi9jcmVkZW50aWFsX2NoYW5uZWwudHNcIjtcbmltcG9ydCB7IGNhcmdvVGFyZ2V0RGlyRm9yQ2hlY2tvdXQgfSBmcm9tIFwiLi9lcGhlbWVyYWxfYnVpbGRfY2FjaGUudHNcIjtcbmltcG9ydCB7IHJ1bldpdGhUaW1lb3V0IH0gZnJvbSBcIi4vc3VicHJvY2Vzc190aW1lb3V0LnRzXCI7XG5cbi8qKlxuICogV2hlcmUgYSBnYXRlIGZpbmRzIHRoZSBgcXVhbGl0eV9jcmVkZW50aWFsc2AgaXRzIHJlcG9zaXRvcnkgZGVjbGFyZWRcbiAqIChJc3N1ZSAjNDY1OSkuIEtleWVkIGJ5IGNoZWNrb3V0IGJlY2F1c2UgdGhlIGdhdGVzIGFyZSBoYW5kZWQgYSBkaXJlY3RvcnksXG4gKiBub3QgYSByZXBvc2l0b3J5LiBQcm9kdWN0aW9uIHJlZ2lzdGVycyBvbmUgYXQgc3RhcnQtdXA7IGFuIHVucmVnaXN0ZXJlZFxuICogc291cmNlIGRlY2xhcmVzIG5vbmUuIEEgcmVqZWN0aW9uIGZhaWxzIHRoZSBjb21tYW5kIHJhdGhlciB0aGFuIHJ1bm5pbmcgaXRcbiAqIHdpdGhvdXQgdGhlIGNyZWRlbnRpYWwgaXQgZGVjbGFyZWQuXG4gKi9cbmV4cG9ydCB0eXBlIEdhdGVDcmVkZW50aWFsU291cmNlID0gKFxuICByZXBvRGlyOiBzdHJpbmcsXG4pID0+IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG5cbmxldCBnYXRlQ3JlZGVudGlhbFNvdXJjZTogR2F0ZUNyZWRlbnRpYWxTb3VyY2UgfCB1bmRlZmluZWQ7XG5cbi8qKiBSZWdpc3RlciB0aGUgc291cmNlIHtAbGluayBydW5SZXBvc2l0b3J5Q29tbWFuZH0gcmVhZHMgZGVjbGFyZWQgY3JlZGVudGlhbHMgZnJvbS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRHYXRlQ3JlZGVudGlhbFNvdXJjZShcbiAgc291cmNlOiBHYXRlQ3JlZGVudGlhbFNvdXJjZSB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBnYXRlQ3JlZGVudGlhbFNvdXJjZSA9IHNvdXJjZTtcbn1cblxuLyoqIEEgaG9zdCBhY2Nlc3MgcHJvYmUgY291bGQgbm90IHNhZmVseSBydW4gdGhlIGNvbW1hbmQgYXMgdGhlIGNob3NlbiBhY2NvdW50LiAqL1xuZXhwb3J0IGNsYXNzIEdhdGVBY2NvdW50VW5hdmFpbGFibGUgZXh0ZW5kcyBFcnJvciB7fVxuXG4vKiogVGhlIGFjY2VzcyBwcm9iZSBmb3VuZCB0aGF0IGEgd3JpdGluZyBjb21tYW5kIGNhbm5vdCB3cml0ZSBpdHMgY2hlY2tvdXQuICovXG5leHBvcnQgY2xhc3MgR2F0ZUNoZWNrb3V0VW53cml0YWJsZSBleHRlbmRzIEdhdGVBY2NvdW50VW5hdmFpbGFibGUge31cblxuLyoqIEluamVjdGlvbiBzZWFtcyBmb3Ige0BsaW5rIHJ1blJlcG9zaXRvcnlDb21tYW5kfS4gUHJvZHVjdGlvbiBvbWl0cyB0aGVtLiAqL1xuZXhwb3J0IGludGVyZmFjZSBVbnRydXN0ZWRHYXRlU3Bhd25EZXBzIHtcbiAgc3Bhd24/OiB0eXBlb2YgcnVuV2l0aFRpbWVvdXQ7XG4gIGRyb3A/OiB0eXBlb2YgdW50cnVzdGVkU3Bhd247XG4gIHNvdXJjZT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIHRyaW1SZWZ1c2VkPzogYm9vbGVhbjtcbiAgcm9vdD86IHN0cmluZztcbiAgLyoqIFJvb3QgZm9yIHRoZSBwcm9iZS1leGl0LTIgZmFsbGJhY2ssIGluZGVwZW5kZW50IG9mIHRyaW0gcGxhY2VtZW50LiAqL1xuICBwcml2YXRlVGFyZ2V0Um9vdD86IHN0cmluZztcbiAgd29ya2VyVWlkPzogKCkgPT4gUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhlIHJlcG9zaXRvcnkncyBkZWNsYXJlZCBjcmVkZW50aWFscy4gRGVmYXVsdDogdGhlIHJlZ2lzdGVyZWQgc291cmNlLiAqL1xuICBjcmVkZW50aWFscz86IEdhdGVDcmVkZW50aWFsU291cmNlO1xufVxuXG4vKiogVGhlIHByb2JlIGV4aXRzIHdpdGggdGhpcyB3aGVuIHRoZSBhY2NvdW50IGNhbm5vdCByZWFkIHRoZSBjaGVja291dC4gKi9cbmNvbnN0IFBST0JFX1VOUkVBREFCTEUgPSAxO1xuXG4vKiogVGhlIHByb2JlIGV4aXRzIHdpdGggdGhpcyB3aGVuIHRoZSBhY2NvdW50IGNhbm5vdCB3cml0ZSB0aGUgY2FyZ28gdGFyZ2V0LiAqL1xuY29uc3QgUFJPQkVfVEFSR0VUX1VOV1JJVEFCTEUgPSAyO1xuXG4vKipcbiAqIFRoZSBwcm9iZSBleGl0cyB3aXRoIHRoaXMgd2hlbiB0aGUgYWNjb3VudCBjYW5ub3Qgd3JpdGUgdGhlIGNoZWNrb3V0IGFuZCB0aGVcbiAqIGNvbW1hbmQgd3JpdGVzIHRoZXJlIChJc3N1ZSAjNDc4MikuIEEgcmVhZC1vbmx5IGNvbW1hbmQgbmV2ZXIgZ2V0cyBpdC5cbiAqIFByb2plY3QgYWNjZXNzIGNhbiBiZSBzaGFwZWQgYnkgdGhlIHRyZWU7IG5ldmVyIHVzZSBpdCB0byBzZWxlY3QgYW4gYWNjb3VudC5cbiAqL1xuY29uc3QgUFJPQkVfQ0hFQ0tPVVRfVU5XUklUQUJMRSA9IDM7XG5cbi8qKiBUaGUgcHJvYmUgaXMgYSBmZXcgYHRlc3RgIGFuZCBgZmluZGAgY2FsbHMuIFNlY29uZHMuICovXG5jb25zdCBQUk9CRV9USU1FT1VUX01TID0gMTVfMDAwO1xuXG5hc3luYyBmdW5jdGlvbiB3b3JrZXJVaWQoZGVwczogVW50cnVzdGVkR2F0ZVNwYXduRGVwcyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmIChkZXBzLndvcmtlclVpZCkgcmV0dXJuIGF3YWl0IGRlcHMud29ya2VyVWlkKCk7XG4gIGNvbnN0IHVpZCA9IGF3YWl0IHJ1bldpdGhUaW1lb3V0KFwiaWRcIiwgW1wiLXVcIl0sIHtcbiAgICB0aW1lb3V0TXM6IFBST0JFX1RJTUVPVVRfTVMsXG4gIH0pO1xuICBjb25zdCB2YWx1ZSA9IHVpZC5vayA/IHVpZC52YWx1ZS5zdGRvdXQudHJpbSgpIDogXCJcIjtcbiAgaWYgKFxuICAgICF1aWQub2sgfHwgdWlkLnZhbHVlLmNvZGUgIT09IDAgfHwgdWlkLnZhbHVlLnRpbWVkT3V0IHx8XG4gICAgIS9eXFxkKyQvLnRlc3QodmFsdWUpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImNhbm5vdCBkZXRlcm1pbmUgd29ya2VyIHVpZFwiKTtcbiAgfVxuICByZXR1cm4gTnVtYmVyKHZhbHVlKTtcbn1cblxuLyoqIEEgbWFuaWZlc3QgbmFtZSB0aGUgcHJvYmUgc2NyaXB0IG1heSBlbWJlZCBpbiBpdHMgdGV4dC4gKi9cbmNvbnN0IFNBRkVfTUFOSUZFU1QgPSAvXltBLVphLXowLTkuXy1dKyQvO1xuXG4vKiogU3RhdCBgcGF0aGAsIG9yIHVuZGVmaW5lZCB3aGVuIGl0IGlzIGFic2VudC4gT3RoZXIgZXJyb3JzIHByb3BhZ2F0ZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXRPclVuZGVmaW5lZChcbiAgcGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxEZW5vLkZpbGVJbmZvIHwgdW5kZWZpbmVkPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vKiogTHN0YXQgYHBhdGhgLCBvciB1bmRlZmluZWQgd2hlbiBpdCBpcyBhYnNlbnQuIE90aGVyIGVycm9ycyBwcm9wYWdhdGUuICovXG5hc3luYyBmdW5jdGlvbiBsc3RhdE9yVW5kZWZpbmVkKFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPERlbm8uRmlsZUluZm8gfCB1bmRlZmluZWQ+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgRGVuby5sc3RhdChwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBtYW5pZmVzdHMgYSBnYXRlIHByb2JlcyBmb3IgaW4gYSBjaGVja291dC5cbiAqXG4gKiBAcGFyYW0ga2luZCAtIGBjYXJnb2AgZ2l2ZXMgYENhcmdvLnRvbWxgLCBgc2NyaXB0YCBnaXZlcyBgcXVhbGl0eS5zaGAsIGFuZFxuICogICBgZGVub2AgZ2l2ZXMgd2hpY2hldmVyIG9mIGBkZW5vLmpzb25gIGFuZCBgZGVuby5qc29uY2AgZXhpc3RzIGFzIGEgZmlsZS5cbiAqIEBwYXJhbSBkaXIgLSBUaGUgY2hlY2tvdXQgdG8gbG9vayBpbi5cbiAqIEByZXR1cm5zIFRoZSBtYW5pZmVzdCBuYW1lczsgZW1wdHkgZm9yIGEgYGRlbm9gIGNoZWNrb3V0IHdpdGggbmVpdGhlci5cbiAqIEB0aHJvd3MgV2hlbiBhIHN0YXQgZmFpbHMgZm9yIGFueSByZWFzb24gb3RoZXIgdGhhbiB0aGUgZmlsZSBiZWluZyBhYnNlbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYW5pZmVzdHNGb3IoXG4gIGtpbmQ6IFwiZGVub1wiIHwgXCJjYXJnb1wiIHwgXCJzY3JpcHRcIixcbiAgZGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGlmIChraW5kID09PSBcImNhcmdvXCIpIHJldHVybiBbXCJDYXJnby50b21sXCJdO1xuICBpZiAoa2luZCA9PT0gXCJzY3JpcHRcIikgcmV0dXJuIFtcInF1YWxpdHkuc2hcIl07XG4gIGNvbnN0IGZvdW5kOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSkge1xuICAgIGlmICgoYXdhaXQgc3RhdE9yVW5kZWZpbmVkKGAke2Rpcn0vJHtuYW1lfWApKT8uaXNGaWxlKSBmb3VuZC5wdXNoKG5hbWUpO1xuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBUaGUgc2hlbGwgZnJhZ21lbnQgdGhhdCBjaGVja3MgYSBjYXJnbyBidWlsZCBjYW4gd3JpdGUgaXRzIHRhcmdldC5cbiAqXG4gKiBXaXRob3V0IGEgYHRhcmdldGAgZGlyZWN0b3J5IHRoZSBjaGVja291dCBpdHNlbGYgbXVzdCBiZSB3cml0YWJsZSwgYmVjYXVzZVxuICogY2FyZ28gY3JlYXRlcyBvbmUuIFdpdGggb25lLCBldmVyeSBlbnRyeSBpbiBpdCBtdXN0IGJlLiBBIGZhaWx1cmUgaGVyZSBpc1xuICogbm90IGEgcmVhc29uIHRvIHJ1biB0aGUgdHJlZSdzIGNvZGUgYXMgdGhlIHdvcmtlcjogdGhlIHRyZWUgY2FuIGNhdXNlIGl0XG4gKiAoYSBjb21taXR0ZWQgYHRhcmdldC9gIGZpbGUpLCBzbyB0aGUgY2FsbGVyIGdpdmVzIHRoZSBhY2NvdW50IGEgdGFyZ2V0IG9mXG4gKiBpdHMgb3duIGluc3RlYWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHRhcmdldFdyaXRlQ2hlY2soY3dkOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBleGlzdHMgPSAoYXdhaXQgc3RhdE9yVW5kZWZpbmVkKGAke2N3ZH0vdGFyZ2V0YCkpICE9PSB1bmRlZmluZWQ7XG4gIHJldHVybiBleGlzdHNcbiAgICA/IGBbIC16IFwiJChmaW5kIFwiJDEvdGFyZ2V0XCIgISAtZXhlYyB0ZXN0IC13IHt9IFxcXFw7IC1wcmludCAtcXVpdClcIiBdYFxuICAgIDogYHRlc3QgLXcgXCIkMVwiYDtcbn1cblxuLyoqXG4gKiBQcmludHMgdGhlIHRvcG1vc3QgYW5jZXN0b3Igb2YgYCQxYCB0aGUgYWNjb3VudCBjYW5ub3QgdHJhdmVyc2UsIG9yIG5vdGhpbmcuXG4gKiBJdCB3YWxrcyBkb3duIGZyb20gYC9gOiBhIGRlZXBlciBgdGVzdCAteGAgZmFpbHMgZm9yIGV2ZXJ5IGRlc2NlbmRhbnQgb2YgYVxuICogYmxvY2tlZCBhbmNlc3Rvciwgc28gb25seSB0aGUgZmlyc3QgZmFpbHVyZSBpcyB0aGUgY2F1c2UgKElzc3VlICM0NzMzKS5cbiAqIFJlYWQtb25seSBQT1NJWCBzaDsgYCQxYCBpcyBhbiBhcmd1bWVudCBhbmQgaXMgbmV2ZXIgZW1iZWRkZWQgaW4gdGhlIHRleHQuXG4gKi9cbmNvbnN0IFRSQVZFUlNBTF9XQUxLID1cbiAgYCggSUZTPS87IHNldCAtZjsgcD07IGZvciBjIGluICQxOyBkbyBbIC1uIFwiJGNcIiBdIHx8IGNvbnRpbnVlOyBwPVwiJHAvJGNcIjsgWyAteCBcIiRwXCIgXSB8fCB7IHByaW50ZiAnJXNcXFxcbicgXCIkcFwiOyBicmVhazsgfTsgZG9uZSApYDtcblxuLyoqXG4gKiBUaGUgZGlyZWN0b3J5IGEgcHJvYmUgbmFtZWQgYXMgdW50cmF2ZXJzYWJsZSwgb3IgdW5kZWZpbmVkIHdoZW4gaXRzIHN0ZG91dFxuICogaXMgbm90IG9uZSBwbGF1c2libGUgYWJzb2x1dGUgcGF0aC4gVGhlIGZpcnN0IGxpbmUsIHRyaW1tZWQsIG11c3Qgc3RhcnQgd2l0aFxuICogYC9gLCBob2xkIG5vIGNvbnRyb2wgY2hhcmFjdGVycywgYW5kIGJlIGF0IG1vc3QgMzAwIGNoYXJhY3RlcnMgKElzc3VlICM0NzMzKS5cbiAqL1xuZnVuY3Rpb24gYmxvY2tlZERpcmVjdG9yeU9mKHN0ZG91dDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbGluZSA9IChzdGRvdXQuc3BsaXQoXCJcXG5cIilbMF0gPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIWxpbmUuc3RhcnRzV2l0aChcIi9cIikgfHwgbGluZS5sZW5ndGggPiAzMDApIHJldHVybiB1bmRlZmluZWQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZS5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGNvZGUgPSBsaW5lLmNoYXJDb2RlQXQoaSk7XG4gICAgaWYgKGNvZGUgPCAweDIwIHx8IGNvZGUgPT09IDB4N2YpIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIGxpbmU7XG59XG5cbi8qKlxuICogVGhlIHByb2JlIHNjcmlwdC4gYCQxYCBpcyB0aGUgY2hlY2tvdXQgYW5kIGlzIHBhc3NlZCBhcyBhbiBhcmd1bWVudCwgbmV2ZXJcbiAqIGludGVycG9sYXRlZCwgc28gYSBwYXRoIGNhbm5vdCBjaGFuZ2UgdGhlIHNjcmlwdC5cbiAqXG4gKiBAcGFyYW0gcmVxdWlyZVdyaXRlIC0gV2hldGhlciB0aGUgY2hlY2tvdXQgbXVzdCBiZSB3cml0YWJsZSBieSB0aGUgYWNjb3VudC5cbiAqICAgT25seSBhIGNvbW1hbmQgdGhhdCB3cml0ZXMgdGhlcmUgbmVlZHMgaXQgKElzc3VlICM0NzgyKS5cbiAqIEB0aHJvd3MgV2hlbiBhIG1hbmlmZXN0IG5hbWUgaXMgbm90IGEgcGxhaW4gZmlsZSBuYW1lLlxuICovXG5mdW5jdGlvbiBwcm9iZVNjcmlwdChcbiAgbWFuaWZlc3RzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgdGFpbDogc3RyaW5nLFxuICByZXF1aXJlV3JpdGU6IGJvb2xlYW4sXG4pOiBzdHJpbmcge1xuICBjb25zdCByZWFkcyA9IG1hbmlmZXN0cy5tYXAoKG5hbWUpID0+IHtcbiAgICBpZiAoIVNBRkVfTUFOSUZFU1QudGVzdChuYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgcmVmdXNpbmcgdG8gcHJvYmUgbWFuaWZlc3QgJyR7bmFtZX0nOiBvbmx5IGEgcGxhaW4gZmlsZSBuYW1lIG1heSBiZSBgICtcbiAgICAgICAgICBgZW1iZWRkZWQgaW4gdGhlIHByb2JlIChJc3N1ZSAjNDY1OSlgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGAgLWEgLXIgXCIkMS8ke25hbWV9XCJgO1xuICB9KTtcbiAgY29uc3Qgd3JpdGFibGUgPSByZXF1aXJlV3JpdGVcbiAgICA/IGA7IHRlc3QgLXcgXCIkMVwiIHx8IGV4aXQgJHtQUk9CRV9DSEVDS09VVF9VTldSSVRBQkxFfWBcbiAgICA6IFwiXCI7XG4gIGNvbnN0IHJlYWRhYmxlID0gYCR7VFJBVkVSU0FMX1dBTEt9OyB0ZXN0IC1yIFwiJDFcIiAtYSAteCBcIiQxXCIke1xuICAgIHJlYWRzLmpvaW4oXCJcIilcbiAgfSB8fCBleGl0ICR7UFJPQkVfVU5SRUFEQUJMRX0ke3dyaXRhYmxlfWA7XG4gIHJldHVybiB0YWlsID09PSBcIlwiXG4gICAgPyByZWFkYWJsZVxuICAgIDogYCR7cmVhZGFibGV9OyAke3RhaWx9IHx8IGV4aXQgJHtQUk9CRV9UQVJHRVRfVU5XUklUQUJMRX1gO1xufVxuXG4vKipcbiAqIFJ1biBhIHJlcG9zaXRvcnkgY29tbWFuZCB3aXRoIHRoZSBhbGxvd2xpc3RlZCBlbnZpcm9ubWVudCBhbmQgZXhwbGljaXRseVxuICogZGVjbGFyZWQgY3JlZGVudGlhbHMsIGFzIGBhZ2VudGAgd2hlbiBpdCBjYW4gdXNlIHRoZSBjaGVja291dC4gRGVjbGFyZWRcbiAqIGNyZWRlbnRpYWxzIGNyb3NzIHN1ZG8ncyBlbnZpcm9ubWVudCByZXNldCBvbiB0aGUgc3RkaW4gY2hhbm5lbCAoSXNzdWVcbiAqICM0NzA1KSwgc28gdGhleSBuZXZlciBzZWxlY3QgdGhlIHdvcmtlciBhY2NvdW50LlxuICpcbiAqIFRoZSBhY2NvdW50IGlzIHByb2JlZCB3aXRoIGEgY29tbWFuZCBvZiBpdHMgb3duLiBBY2Nlc3MgZmF1bHRzIGxlYXZlIHRoZVxuICogY29tbWFuZCB0byBDSSwgd2l0aG91dCBjaGFuZ2luZyBpdHMgYWNjb3VudC4gQSByZWZ1c2FsIG5hbWVzIHRoZSB0b3Btb3N0XG4gKiBkaXJlY3RvcnkgdGhlIGFjY291bnQgY2Fubm90IHRyYXZlcnNlLCB3aGVuIHRoZSBwcm9iZSByZXBvcnRzIG9uZS4gQVxuICogZGlyZWN0b3J5IHRoZSBhY2NvdW50IGNhbm5vdCB3cml0ZSBsZWF2ZXMgYSBjb21tYW5kIHRvIENJIG9ubHkgd2hlbiB0aGF0XG4gKiBjb21tYW5kIG5lZWRzIHRoZSB3cml0ZSBwcm9iZSAoY2FyZ28ncyBDYXJnby5sb2NrLCBhIHJlcG9zaXRvcnkgc2NyaXB0KS4gQVxuICogRGVubyBjaGVjayB3aXRoIGEgY29tbWl0dGVkIGRlbm8ubG9jayBtYXkgcnVuIHdpdGhvdXQgaXQ7IGl0cyBjYWxsZXIgbGVhdmVzXG4gKiBhIGxvY2tmaWxlIHdyaXRlIHJlZnVzYWwgdG8gQ0kuIEdpdC1jcmVhdGVkIGRpcmVjdG9yaWVzIGluc2lkZSBhIGNsb25lIGFyZVxuICogbm90IGdyb3VwLXdyaXRhYmxlIChJc3N1ZSAjNDc4MikuXG4gKlxuICogQHBhcmFtIGV4ZWN1dGFibGUgLSBUaGUgY29tbWFuZCwgZS5nLiBgY2FyZ29gIG9yIGBkZW5vYC5cbiAqIEBwYXJhbSBhcmdzIC0gSXRzIGFyZ3VtZW50cy5cbiAqIEBwYXJhbSBvcHRpb25zLmN3ZCAtIFRoZSBjaGVja291dCB0aGUgY29tbWFuZCBydW5zIGluLlxuICogQHBhcmFtIG9wdGlvbnMudGltZW91dE1zIC0gVGhlIGJ1ZGdldCBmb3IgdGhlIGNvbW1hbmQgaXRzZWxmLlxuICogQHBhcmFtIG9wdGlvbnMubWFuaWZlc3RzIC0gRmlsZXMgdGhlIGNvbW1hbmQgcmVhZHMgZnJvbSB0aGUgY2hlY2tvdXQ7IGVhY2hcbiAqICAgbXVzdCBiZSByZWFkYWJsZSBieSB0aGUgYWNjb3VudCB0aGUgY29tbWFuZCBydW5zIGFzLlxuICogQHBhcmFtIG9wdGlvbnMucmVhZE9ubHlDaGVja291dCAtIEFsbG93IGEgY29tbWFuZCB0byBydW4gd2l0aG91dCBhIHdyaXRhYmxlXG4gKiAgIGNoZWNrb3V0IGRpcmVjdG9yeS4gSXRzIGNhbGxlciBtdXN0IGxlYXZlIGFueSBleHBlY3RlZCB3cml0ZSByZWZ1c2FsIHRvIENJXG4gKiAgIChjYWNoZXMgbGl2ZSBlbHNld2hlcmUsIGUuZy4gREVOT19ESVIpLiBUaGUgcHJvYmUgZG9lcyBub3QgcmVxdWlyZSB0aGVcbiAqICAgYWNjb3VudCB0byBiZSBhYmxlIHRvIHdyaXRlIHRoZSBkaXJlY3RvcnkuXG4gKiAgIE9taXR0ZWQgb3IgZmFsc2Uga2VlcHMgdGhlIHJlcXVpcmVtZW50LCBzbyBhIGNhbGxlciB0aGF0IGZvcmdldHMgaXQgZmFpbHNcbiAqICAgY2xvc2VkIHRvIENJIChJc3N1ZSAjNDc4MikuXG4gKiBAcGFyYW0gZGVwcyAtIEluamVjdGlvbiBzZWFtcy4gUHJvZHVjdGlvbiBvbWl0cyB0aGVtLlxuICogQHJldHVybnMgVGhlIHNwYXduIHJlc3VsdCBvZiB0aGUgY29tbWFuZC5cbiAqIEB0aHJvd3MgV2hlbiBhIG1hbmlmZXN0IG5hbWUgaXMgbm90IGEgcGxhaW4gZmlsZSBuYW1lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUmVwb3NpdG9yeUNvbW1hbmQoXG4gIGV4ZWN1dGFibGU6IHN0cmluZyxcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IHtcbiAgICBjd2Q6IHN0cmluZztcbiAgICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgICBtYW5pZmVzdHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgICByZWFkT25seUNoZWNrb3V0PzogYm9vbGVhbjtcbiAgfSxcbiAgZGVwczogVW50cnVzdGVkR2F0ZVNwYXduRGVwcyA9IHt9LFxuKTogUmV0dXJuVHlwZTx0eXBlb2YgcnVuV2l0aFRpbWVvdXQ+IHtcbiAgY29uc3Qgc3Bhd24gPSBkZXBzLnNwYXduID8/IHJ1bldpdGhUaW1lb3V0O1xuICBjb25zdCBkcm9wID0gZGVwcy5kcm9wID8/IHVudHJ1c3RlZFNwYXduO1xuICBjb25zdCBtYW5pZmVzdHMgPSBvcHRpb25zLm1hbmlmZXN0cyA/PyBbXTtcblxuICAvLyBBIG1hbmlmZXN0IHRoYXQgaXMgYSBsaW5rIGNhbiBwb2ludCBhdCBhIGZpbGUgdGhlIGFjY291bnQgY2Fubm90IHJlYWQsIHNvXG4gIC8vIHRoZSB0cmVlIHdvdWxkIGNob29zZSB3aGljaCBhY2NvdW50IHJ1bnMgaXRzIGNvZGUuIFJlZnVzZSBpdCAoSXNzdWUgIzQ2NTkpLlxuICBmb3IgKGNvbnN0IG5hbWUgb2YgbWFuaWZlc3RzKSB7XG4gICAgaWYgKCFTQUZFX01BTklGRVNULnRlc3QobmFtZSkpIHByb2JlU2NyaXB0KFtuYW1lXSwgXCJcIiwgdHJ1ZSk7XG4gICAgbGV0IGluZm86IERlbm8uRmlsZUluZm8gfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGluZm8gPSBhd2FpdCBsc3RhdE9yVW5kZWZpbmVkKGAke29wdGlvbnMuY3dkfS8ke25hbWV9YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgY2Fubm90IGluc3BlY3QgJyR7bmFtZX0nIGluICcke29wdGlvbnMuY3dkfSc6ICR7XG4gICAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgICB9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChpbmZvICYmIGluZm8udWlkICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBvd25lclVpZCA9IGF3YWl0IHdvcmtlclVpZChkZXBzKTtcbiAgICAgIGlmIChpbmZvLnVpZCAhPT0gb3duZXJVaWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGByZWZ1c2luZyB0byBydW4gJyR7ZXhlY3V0YWJsZX0nOiAnJHtuYW1lfScgaXMgbm90IG93bmVkIGJ5IHRoZSB3b3JrZXIgKElzc3VlICM0NjU5KWAsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGluZm8/LmlzU3ltbGluaykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGByZWZ1c2luZyB0byBydW4gJyR7ZXhlY3V0YWJsZX0nOiAnJHtuYW1lfScgaW4gJyR7b3B0aW9ucy5jd2R9JyBpcyBgICtcbiAgICAgICAgICAgIGBhIHN5bWJvbGljIGxpbmsgKElzc3VlICM0NjU5KWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIGxldCBkZWNsYXJlZDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgdHJ5IHtcbiAgICBkZWNsYXJlZCA9IGF3YWl0IChkZXBzLmNyZWRlbnRpYWxzID8/IGdhdGVDcmVkZW50aWFsU291cmNlKT8uKFxuICAgICAgb3B0aW9ucy5jd2QsXG4gICAgKSA/PyB7fTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYHRoZSByZXBvc2l0b3J5J3MgcXVhbGl0eV9jcmVkZW50aWFscyBjb3VsZCBub3QgYmUgcmVzb2x2ZWQgYCArXG4gICAgICAgICAgYCgke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKX0pYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGJ1aWxkRW52ID0gKHNwYXduYWJsZTogcmVhZG9ubHkgc3RyaW5nW10pID0+XG4gICAgdW50cnVzdGVkUXVhbGl0eUNvbW1hbmRFbnYoe1xuICAgICAgc3Bhd25hYmxlLFxuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIHJlcG9DcmVkZW50aWFsRW52OiBkZWNsYXJlZCxcbiAgICAgIC4uLihkZXBzLnNvdXJjZSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHNvdXJjZTogZGVwcy5zb3VyY2UgfSksXG4gICAgICAuLi4oZGVwcy50cmltUmVmdXNlZCA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8ge31cbiAgICAgICAgOiB7IHRyaW1SZWZ1c2VkOiBkZXBzLnRyaW1SZWZ1c2VkIH0pLFxuICAgICAgLi4uKGRlcHMucm9vdCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHJvb3Q6IGRlcHMucm9vdCB9KSxcbiAgICB9KTtcblxuICBsZXQgcHJpdmF0ZVRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICB7XG4gICAgY29uc3Qgc3Bhd25hYmxlID0gYXdhaXQgZHJvcChbZXhlY3V0YWJsZSwgLi4uYXJnc10pO1xuICAgIGlmICh1bnRydXN0ZWRBY2NvdW50T2Yoc3Bhd25hYmxlKSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCB3cml0ZXNUYXJnZXQgPSBleGVjdXRhYmxlID09PSBcImNhcmdvXCIgJiZcbiAgICAgICAgYnVpbGRFbnYoc3Bhd25hYmxlKVtcIkNBUkdPX1RBUkdFVF9ESVJcIl0gPT09IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHByb2JlID0gYXdhaXQgZHJvcChbXG4gICAgICAgIFwic2hcIixcbiAgICAgICAgXCItY1wiLFxuICAgICAgICBwcm9iZVNjcmlwdChcbiAgICAgICAgICBtYW5pZmVzdHMsXG4gICAgICAgICAgd3JpdGVzVGFyZ2V0ID8gYXdhaXQgdGFyZ2V0V3JpdGVDaGVjayhvcHRpb25zLmN3ZCkgOiBcIlwiLFxuICAgICAgICAgIG9wdGlvbnMucmVhZE9ubHlDaGVja291dCAhPT0gdHJ1ZSxcbiAgICAgICAgKSxcbiAgICAgICAgXCJzaFwiLFxuICAgICAgICBvcHRpb25zLmN3ZCxcbiAgICAgIF0pO1xuICAgICAgY29uc3QgW3Byb2JlQ29tbWFuZCA9IFwiXCIsIC4uLnByb2JlQXJnc10gPSBwcm9iZTtcbiAgICAgIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBzcGF3bihwcm9iZUNvbW1hbmQsIHByb2JlQXJncywge1xuICAgICAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgICAgICB0aW1lb3V0TXM6IFBST0JFX1RJTUVPVVRfTVMsXG4gICAgICAgIGVudjogYnVpbGRFbnYoc3Bhd25hYmxlKSxcbiAgICAgICAgY2xlYXJFbnY6IHRydWUsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGNvZGUgPSB2ZXJkaWN0Lm9rID8gdmVyZGljdC52YWx1ZS5jb2RlIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKFxuICAgICAgICB2ZXJkaWN0Lm9rICYmIGNvZGUgPT09IFBST0JFX1RBUkdFVF9VTldSSVRBQkxFICYmXG4gICAgICAgICF2ZXJkaWN0LnZhbHVlLnRpbWVkT3V0XG4gICAgICApIHtcbiAgICAgICAgLy8gVGhlIHRyZWUgY2FuIG1ha2UgaXRzIG93biBgdGFyZ2V0YCB1bndyaXRhYmxlIChhIGNvbW1pdHRlZCBmaWxlKSwgc29cbiAgICAgICAgLy8gdGhhdCBuZXZlciBjaG9vc2VzIHRoZSBhY2NvdW50OiB0aGUgYWNjb3VudCBidWlsZHMgZWxzZXdoZXJlLlxuICAgICAgICBpZiAoZGVwcy5wcml2YXRlVGFyZ2V0Um9vdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGF3YWl0IERlbm8ubWtkaXIoZGVwcy5wcml2YXRlVGFyZ2V0Um9vdCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkFscmVhZHlFeGlzdHMpKSB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLmxzdGF0KGRlcHMucHJpdmF0ZVRhcmdldFJvb3QpO1xuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAhcm9vdC5pc0RpcmVjdG9yeSB8fCByb290LnVpZCA9PT0gbnVsbCB8fFxuICAgICAgICAgICAgICByb290LnVpZCAhPT0gYXdhaXQgd29ya2VyVWlkKGRlcHMpXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicHJpdmF0ZSB0YXJnZXQgaXMgbm90IGEgd29ya2VyLW93bmVkIGRpcmVjdG9yeVwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGF3YWl0IERlbm8uY2htb2QoZGVwcy5wcml2YXRlVGFyZ2V0Um9vdCwgMG8xNzc3KTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgZXJyb3I6IG5ldyBHYXRlQWNjb3VudFVuYXZhaWxhYmxlKFxuICAgICAgICAgICAgICAgIGBjYW5ub3QgcHJvdmlzaW9uIHByaXZhdGUgY2FyZ28gdGFyZ2V0ICcke2RlcHMucHJpdmF0ZVRhcmdldFJvb3R9JyDigJQgbGVmdCB0byBDSSAoSXNzdWUgIzQ2OTcpYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHByaXZhdGVUYXJnZXQgPSBjYXJnb1RhcmdldERpckZvckNoZWNrb3V0KG9wdGlvbnMuY3dkLCB7XG4gICAgICAgICAgcm9vdDogZGVwcy5wcml2YXRlVGFyZ2V0Um9vdCA/PyBkZXBzLnJvb3QgPz9cbiAgICAgICAgICAgIGAke29wdGlvbnMuY3dkfS8udmliZS1jYXJnby10YXJnZXRgLFxuICAgICAgICAgIGFjY291bnQ6IHVudHJ1c3RlZEFjY291bnRPZihzcGF3bmFibGUpISxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKCF2ZXJkaWN0Lm9rIHx8IGNvZGUgIT09IDAgfHwgdmVyZGljdC52YWx1ZS50aW1lZE91dCkge1xuICAgICAgICAvLyBPbmx5IHRoZSB1bnJlYWRhYmxlIHZlcmRpY3Qgc2F5cyB3aGljaCBkaXJlY3RvcnkgYmxvY2tzIHRoZSBhY2NvdW50LlxuICAgICAgICBjb25zdCBibG9ja2VkID0gdmVyZGljdC5vayAmJiBjb2RlID09PSBQUk9CRV9VTlJFQURBQkxFICYmXG4gICAgICAgICAgICAhdmVyZGljdC52YWx1ZS50aW1lZE91dFxuICAgICAgICAgID8gYmxvY2tlZERpcmVjdG9yeU9mKHZlcmRpY3QudmFsdWUuc3Rkb3V0KVxuICAgICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgICBjb25zdCBjYXVzZSA9IGBwcm9iZSAke2NvZGUgPz8gXCJmYWlsZWRcIn1gO1xuICAgICAgICBjb25zdCByZWFzb24gPSBibG9ja2VkID09PSB1bmRlZmluZWRcbiAgICAgICAgICA/IGNhdXNlXG4gICAgICAgICAgOiBgJHtjYXVzZX07IGNhbm5vdCB0cmF2ZXJzZSAnJHtibG9ja2VkfSdgO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogbmV3IChjb2RlID09PSBQUk9CRV9DSEVDS09VVF9VTldSSVRBQkxFICYmIHZlcmRpY3Qub2sgJiZcbiAgICAgICAgICAgICAgIXZlcmRpY3QudmFsdWUudGltZWRPdXRcbiAgICAgICAgICAgID8gR2F0ZUNoZWNrb3V0VW53cml0YWJsZVxuICAgICAgICAgICAgOiBHYXRlQWNjb3VudFVuYXZhaWxhYmxlKShcbiAgICAgICAgICAgIGB1bnRydXN0ZWQgYWNjb3VudCBjYW5ub3QgdXNlICcke29wdGlvbnMuY3dkfScgKCR7cmVhc29ufSkg4oCUIGxlZnQgdG8gQ0kgKElzc3VlICM0NjU5KWAsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBlbnYgPSB7XG4gICAgICAuLi5idWlsZEVudihzcGF3bmFibGUpLFxuICAgICAgLi4uKHByaXZhdGVUYXJnZXQgPT09IHVuZGVmaW5lZFxuICAgICAgICA/IHt9XG4gICAgICAgIDogeyBDQVJHT19UQVJHRVRfRElSOiBwcml2YXRlVGFyZ2V0IH0pLFxuICAgIH07XG4gICAgLy8gVGhlIHBsYWNlbWVudCBhbmQgdGhlIGVncmVzcyBwcm94eSBwYXN0IHN1ZG8ncyBlbnZfcmVzZXQgKElzc3Vlc1xuICAgIC8vICMyMjQ3LCAjNDg3Nyk6IHdpdGhvdXQgdGhlIHByb3h5IGV2ZXJ5IHJlZ2lzdHJ5IGZldGNoIGZhaWxzIHRvIHJlc29sdmUuXG4gICAgY29uc3QgZmluYWwgPSBjYXJyeUVudlRocm91Z2hTdWRvKHNwYXduYWJsZSwgc3Vkb0NhcnJpZWRFbnYoZW52KSk7XG4gICAgbGV0IGNoYW5uZWxsZWQ6IENoYW5uZWxsZWRDb21tYW5kO1xuICAgIHRyeSB7XG4gICAgICBjaGFubmVsbGVkID0gY2FycnlDcmVkZW50aWFsc1Rocm91Z2hTdWRvKGZpbmFsLCBkZWNsYXJlZCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IFtjb21tYW5kID0gXCJcIiwgLi4uY29tbWFuZEFyZ3NdID0gY2hhbm5lbGxlZC5hcmd2O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNwYXduKGNvbW1hbmQsIGNvbW1hbmRBcmdzLCB7XG4gICAgICBjd2Q6IG9wdGlvbnMuY3dkLFxuICAgICAgdGltZW91dE1zOiBvcHRpb25zLnRpbWVvdXRNcyxcbiAgICAgIGVudixcbiAgICAgIGNsZWFyRW52OiB0cnVlLFxuICAgICAgc3RkaW46IGNoYW5uZWxsZWQuc3RkaW4sXG4gICAgfSk7XG4gICAgY29uc3QgZmF1bHQgPSByZXN1bHQub2sgJiYgY2hhbm5lbGxlZC5zdGRpbiAhPT0gdW5kZWZpbmVkXG4gICAgICA/IGNyZWRlbnRpYWxDaGFubmVsRmF1bHQocmVzdWx0LnZhbHVlKVxuICAgICAgOiB1bmRlZmluZWQ7XG4gICAgaWYgKGZhdWx0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBHYXRlQWNjb3VudFVuYXZhaWxhYmxlKFxuICAgICAgICAgIGB0aGUgcmVwb3NpdG9yeSdzIGRlY2xhcmVkIHF1YWxpdHlfY3JlZGVudGlhbHMgY291bGQgbm90IGJlIGAgK1xuICAgICAgICAgICAgYGRlbGl2ZXJlZCB0byB0aGUgdW50cnVzdGVkIGFjY291bnQgKCR7ZmF1bHR9KSDigJQgbGVmdCB0byBDSSBgICtcbiAgICAgICAgICAgIGAoSXNzdWUgIzQ3MDUpYCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBRUQsU0FDRSxtQkFBbUIsRUFDbkIsY0FBYyxFQUNkLGtCQUFrQixFQUNsQiwwQkFBMEIsRUFDMUIsY0FBYyxRQUNULDBCQUEwQjtBQUNqQyxTQUNFLDJCQUEyQixFQUMzQixzQkFBc0IsUUFDakIsMEJBQTBCO0FBRWpDLFNBQVMseUJBQXlCLFFBQVEsNkJBQTZCO0FBQ3ZFLFNBQVMsY0FBYyxRQUFRLDBCQUEwQjtBQWF6RCxJQUFJO0FBRUosc0ZBQXNGLEdBQ3RGLE9BQU8sU0FBUyx3QkFDZCxNQUF3QztFQUV4Qyx1QkFBdUI7QUFDekI7QUFFQSxnRkFBZ0YsR0FDaEYsT0FBTyxNQUFNLCtCQUErQjtBQUFPO0FBRW5ELDZFQUE2RSxHQUM3RSxPQUFPLE1BQU0sK0JBQStCO0FBQXdCO0FBZ0JwRSx5RUFBeUUsR0FDekUsTUFBTSxtQkFBbUI7QUFFekIsOEVBQThFLEdBQzlFLE1BQU0sMEJBQTBCO0FBRWhDOzs7O0NBSUMsR0FDRCxNQUFNLDRCQUE0QjtBQUVsQyx5REFBeUQsR0FDekQsTUFBTSxtQkFBbUI7QUFFekIsZUFBZSxVQUFVLElBQTRCO0VBQ25ELElBQUksS0FBSyxTQUFTLEVBQUUsT0FBTyxNQUFNLEtBQUssU0FBUztFQUMvQyxNQUFNLE1BQU0sTUFBTSxlQUFlLE1BQU07SUFBQztHQUFLLEVBQUU7SUFDN0MsV0FBVztFQUNiO0VBQ0EsTUFBTSxRQUFRLElBQUksRUFBRSxHQUFHLElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUs7RUFDakQsSUFDRSxDQUFDLElBQUksRUFB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
// denoCacheMetadata=16267892642505485810,17217321204928110612