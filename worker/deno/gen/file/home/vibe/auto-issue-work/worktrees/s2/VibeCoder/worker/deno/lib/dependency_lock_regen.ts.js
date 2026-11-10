/**
 * Lock-file regeneration for merge conflicts (Issue #465, part of #456).
 *
 * A conflicted lock file is **never** text-merged. `deno.lock`,
 * `package-lock.json`, `Cargo.lock` and `go.sum` carry integrity hashes over a
 * resolved dependency graph, so picking hunks produces a file that looks clean
 * — no conflict markers — while describing a graph that never existed. The
 * only correct resolution is to throw the conflicted lock away and let the
 * ecosystem's own tool regenerate it from the already-merged manifest.
 *
 * The sequence for one lock file is:
 *
 * ```mermaid
 * flowchart TD
 *     A[Conflicted lock file] --> B{Manifest rule-resolved<br/>or never conflicted?}
 *     B -- no --> U[unresolved]
 *     B -- yes --> C{Toolchain on PATH?}
 *     C -- no --> U
 *     C -- yes --> D[git checkout --ours -- lock]
 *     D --> E[Run the ecosystem tool<br/>bounded by a timeout]
 *     E -- non-zero --> R[git checkout --merge -- lock] --> U
 *     E -- zero --> F{Marker-free lock on disk?}
 *     F -- no --> R
 *     F -- yes --> G[git add -- lock] --> H[regenerated]
 * ```
 *
 * Every deferral returns `unresolved`, which routes the file to the existing
 * AI-fallback and `needs-human` escalation path in
 * `pr_merge_conflict_processor.ts` — a failed regeneration is visible on the
 * PR rather than silent, and never leaves a half-written lock staged.
 *
 * `container/tools.json` registers `deno`, `node`/`npm` and `rust`/`cargo` but
 * has **no Go entry**, so `go.sum` falls through the toolchain probe today.
 * That is the probe working, not a special case: the rule is registered and
 * starts working the day the image ships Go.
 *
 * The command runner, toolchain probe and lock-file reader are all injected,
 * so the module is fully unit-testable without shelling out.
 *
 * Australian English is used throughout (behaviour, normalised, organisation).
 */ import { runGitCommand } from "./git_timeout.ts";
import { truncateLogTail } from "./log_tail.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Default ceiling on a single regeneration command (5 minutes). */ export const DEFAULT_LOCK_REGEN_TIMEOUT_MS = 300_000;
/** Lines of command output kept in a failure reason. */ export const LOCK_REGEN_OUTPUT_TAIL_LINES = 20;
/** Byte ceiling on that tail, so one runaway line cannot flood the log. */ export const LOCK_REGEN_OUTPUT_TAIL_BYTES = 2048;
/**
 * Any conflict marker at the start of a line.
 *
 * Deliberately a literal — it is the same shape the CI "Check for merge
 * conflict markers" step greps for, and a dynamically built regex would be the
 * wrong primitive for a fixed set of four markers.
 */ const CONFLICT_MARKER_PATTERN = /^(<{7}|\|{7}|={7}|>{7})/m;
/** The lock files this module knows how to regenerate. */ export const LOCK_FILE_SPECS = [
  {
    ecosystem: "deno",
    lockFile: "deno.lock",
    binary: "deno",
    manifests: [
      "deno.json",
      "deno.jsonc"
    ],
    commands: [
      {
        bin: "deno",
        args: [
          "install"
        ]
      }
    ]
  },
  {
    ecosystem: "npm",
    lockFile: "package-lock.json",
    binary: "npm",
    manifests: [
      "package.json"
    ],
    commands: [
      {
        bin: "npm",
        args: [
          "install",
          "--package-lock-only"
        ]
      }
    ]
  },
  {
    ecosystem: "cargo",
    lockFile: "Cargo.lock",
    binary: "cargo",
    manifests: [
      "Cargo.toml"
    ],
    workspace: true,
    commands: [
      {
        bin: "cargo",
        args: [
          "update",
          "--workspace",
          "--offline"
        ]
      },
      {
        bin: "cargo",
        args: [
          "update",
          "--workspace"
        ]
      }
    ]
  },
  {
    ecosystem: "go",
    lockFile: "go.sum",
    binary: "go",
    manifests: [
      "go.mod"
    ],
    commands: [
      {
        bin: "go",
        args: [
          "mod",
          "tidy"
        ]
      }
    ]
  }
];
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
/**
 * Whether a path is a safe repository-relative path.
 *
 * Exported because the deterministic pass (Issue #466) guards the manifest
 * paths it writes with exactly the same rule — one definition, not two.
 *
 * The paths arrive from `git diff --name-only` on a conflicted merge, but they
 * decide a `cwd` and a filesystem read, so they are validated rather than
 * trusted: no absolute path, no drive letter, no backslash, and no `.`/`..`
 * segment that could escape the working directory.
 */ export function isSafeRepoRelativePath(path) {
  if (path === "" || path.startsWith("/") || path.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part)=>part !== "" && part !== "." && part !== "..");
}
/** Basename of a repository-relative path. */ function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
/** Directory of a repository-relative path, `""` at the repository root. */ function dirname(path) {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
/** Join a working directory with a repository-relative path. */ function joinPath(workingDir, relative) {
  const base = workingDir.replace(/\/+$/, "");
  return relative === "" ? base : `${base}/${relative}`;
}
/** The spec owning a lock-file path, or undefined when there is none. */ export function lockSpecForPath(path) {
  const name = basename(path);
  return LOCK_FILE_SPECS.find((spec)=>spec.lockFile === name);
}
// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------
/**
 * Redact and bound a command's combined output before it is reported.
 *
 * Redaction runs over the **whole** text before truncation — the
 * redact-before-truncate standard in SECURITY.md — so a secret straddling the
 * cut cannot survive in the kept tail. Both the line and the byte ceiling are
 * announced when they bite, so a bounded tail is never mistaken for the whole
 * output.
 */ export function formatLockRegenOutput(stdout, stderr) {
  const combined = [
    stdout ?? "",
    stderr ?? ""
  ].filter((part)=>part.trim().length > 0).join("\n");
  const redacted = redactSecrets(combined).trimEnd();
  if (redacted.length === 0) return "";
  const lines = redacted.split("\n");
  const dropped = Math.max(0, lines.length - LOCK_REGEN_OUTPUT_TAIL_LINES);
  const marker = dropped > 0 ? `[...truncated ${dropped} lines — showing tail...]\n` : "";
  const tail = lines.slice(-LOCK_REGEN_OUTPUT_TAIL_LINES).join("\n");
  return truncateLogTail(marker + tail, LOCK_REGEN_OUTPUT_TAIL_BYTES);
}
/** Render a command for a message: `` `deno install` ``. */ function describe(command) {
  return `\`${[
    command.bin,
    ...command.args
  ].join(" ")}\``;
}
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
/**
 * Default runner — spawns the command, bounded by an abort signal.
 *
 * A spawn failure throws rather than being reported as a clean exit: the
 * caller turns it into `unresolved`, so a missing or broken toolchain can
 * never look like a successful regeneration.
 *
 * Issue #1227: the binary comes from `call.bin`, and the lock checkout/stage
 * steps pass `"git"` — direct `git` spawns the literal-matching chokepoint
 * gate could not see. They are delegated to `runGitCommand`, which owns the
 * timeout, the audit journal and the work-volume fault detector. The
 * untrusted-environment build below stays with the ecosystem tools it was
 * written for: `git` is the worker's own binary, not repository-supplied code.
 */ export const defaultRunner = async (call)=>{
  if (call.bin === "git") {
    const result = await runGitCommand([
      ...call.args
    ], {
      cwd: call.cwd,
      timeoutSeconds: Math.max(1, Math.ceil(call.timeoutMs / 1000))
    });
    // Fail loud, matching the spawn-failure contract above.
    if (!result.ok) throw result.error;
    return result.value;
  }
  const output = await new Deno.Command(call.bin, {
    args: [
      ...call.args
    ],
    cwd: call.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    // `npm install`, `deno install`, `cargo update` and `go mod tidy` run
    // install hooks declared by a manifest the repository controls, so this
    // is code the worker did not write. Its environment is BUILT from the
    // allowlist rather than inherited (Issues #572, #1214) — a postinstall
    // script has no credential in scope to echo.
    env: buildUntrustedCommandEnv(),
    clearEnv: true,
    signal: AbortSignal.timeout(call.timeoutMs)
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr)
  };
};
/**
 * Default probe — whether `bin` is an executable entry on `PATH`.
 *
 * POSIX `PATH` semantics; the worker container is Linux. An unexpected stat
 * error is re-raised rather than being read as "absent".
 */ const defaultToolProbe = async (bin)=>{
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")){
    if (dir === "") continue;
    try {
      const info = await Deno.stat(`${dir}/${bin}`);
      if (info.isFile || info.isSymlink) return true;
    } catch (error) {
      const absent = error instanceof Deno.errors.NotFound || error instanceof Deno.errors.PermissionDenied;
      if (!absent) throw error;
    }
  }
  return false;
};
/** Default reader — reads the lock file under `workingDir`, null when absent. */ function defaultReader(workingDir) {
  return async (path)=>{
    try {
      return await Deno.readTextFile(joinPath(workingDir, path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
}
// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------
/**
 * Regenerate one conflicted lock file from its already-merged manifest.
 *
 * Returns `regenerated` only when the ecosystem's tool wrote a marker-free
 * lock file that is now staged. Every other path — an unresolved manifest, an
 * absent toolchain, a failing command, a lock that still carries markers —
 * returns `unresolved` with a reason, having staged nothing.
 */ export async function regenerateLockFile(lockPath, options) {
  const { workingDir, manifestOutcomes, runner = defaultRunner, hasTool = defaultToolProbe, readLockFile = defaultReader(workingDir), timeoutMs = DEFAULT_LOCK_REGEN_TIMEOUT_MS, logger } = options;
  const defer = (reason)=>{
    logger?.warn(`Lock file left for the AI fallback: ${reason}`, {
      lockPath,
      reason
    });
    return {
      kind: "unresolved",
      path: lockPath,
      reason
    };
  };
  if (!isSafeRepoRelativePath(lockPath)) {
    return defer(`unsafe path outside the working directory: ${lockPath}`);
  }
  const spec = lockSpecForPath(lockPath);
  if (!spec) return defer(`no lock-file rule for ${lockPath}`);
  const directory = dirname(lockPath);
  // A lock is only regenerated against a manifest that is actually merged.
  for (const manifest of spec.manifests){
    const manifestPath = directory === "" ? manifest : `${directory}/${manifest}`;
    if (manifestOutcomes.get(manifestPath) === "unresolved") {
      return defer(`its manifest ${manifestPath} is unresolved, so a regenerated lock ` + `would describe the wrong dependency set`);
    }
  }
  // Issue #1903: a workspace lock is regenerated from every member manifest
  // under it, not only the one beside it.
  if (spec.workspace) {
    const prefix = directory === "" ? "" : `${directory}/`;
    for (const [path, status] of manifestOutcomes){
      if (status !== "unresolved" || !path.startsWith(prefix)) continue;
      const isMember = spec.manifests.some((manifest)=>path.endsWith(`/${manifest}`) && path !== `${prefix}${manifest}`);
      if (!isMember) continue;
      return defer(`its workspace manifest ${path} is unresolved, so a regenerated ` + `lock would describe the wrong dependency set`);
    }
  }
  if (!await hasTool(spec.binary)) {
    return defer(`the ${spec.ecosystem} toolchain binary \`${spec.binary}\` is not on ` + `PATH in this container`);
  }
  const cwd = joinPath(workingDir, directory);
  const run = async (command)=>{
    try {
      return await runner({
        bin: command.bin,
        args: command.args,
        cwd,
        timeoutMs,
        lockPath
      });
    } catch (error) {
      return {
        thrown: error.message
      };
    }
  };
  /** Restore the conflicted lock so the AI fallback sees the real conflict. */ const restore = async ()=>{
    await run({
      bin: "git",
      args: [
        "checkout",
        "--merge",
        "--",
        lockPath
      ]
    });
  };
  // Check the lock out to a known state: a marker-riddled file is not valid
  // input for any of these tools.
  const checkout = await run({
    bin: "git",
    args: [
      "checkout",
      "--ours",
      "--",
      lockPath
    ]
  });
  if ("thrown" in checkout) {
    return defer(`git checkout of ${lockPath} failed: ${checkout.thrown}`);
  }
  if (checkout.code !== 0) {
    return defer(`git checkout --ours of ${lockPath} exited ${checkout.code}: ` + formatLockRegenOutput(checkout.stdout, checkout.stderr));
  }
  let succeeded;
  let lastFailure = "";
  for (const command of spec.commands){
    const result = await run(command);
    if ("thrown" in result) {
      lastFailure = `${describe(command)} could not be run: ${result.thrown}`;
      continue;
    }
    if (result.code === 0) {
      succeeded = command;
      break;
    }
    lastFailure = `${describe(command)} exited non-zero (exit ${result.code})` + `: ${formatLockRegenOutput(result.stdout, result.stderr)}`;
  }
  if (!succeeded) {
    await restore();
    return defer(`regenerating ${lockPath} failed — ${lastFailure}`);
  }
  const content = await readLockFile(lockPath);
  if (content === null) {
    await restore();
    return defer(`${describe(succeeded)} exited zero but ${lockPath} could not be read`);
  }
  if (CONFLICT_MARKER_PATTERN.test(content)) {
    await restore();
    return defer(`${describe(succeeded)} exited zero but ${lockPath} still contains ` + `conflict markers`);
  }
  const staged = await run({
    bin: "git",
    args: [
      "add",
      "--",
      lockPath
    ]
  });
  if ("thrown" in staged || staged.code !== 0) {
    await restore();
    const detail = "thrown" in staged ? staged.thrown : `exit ${staged.code}: ${formatLockRegenOutput(staged.stdout, staged.stderr)}`;
    return defer(`staging the regenerated ${lockPath} failed — ${detail}`);
  }
  logger?.info?.(`Regenerated ${lockPath} from its merged manifest`, {
    lockPath,
    ecosystem: spec.ecosystem,
    command: [
      succeeded.bin,
      ...succeeded.args
    ].join(" ")
  });
  return {
    kind: "regenerated",
    path: lockPath,
    ecosystem: spec.ecosystem,
    command: succeeded
  };
}
/**
 * Regenerate every conflicted lock file, in the order given.
 *
 * Each lock file is independent: one deferral never blocks another, and the
 * caller decides what to do with a mixed set — today, any `unresolved` sends
 * the whole merge to the AI fallback.
 */ export async function regenerateLockFiles(options) {
  const outcomes = [];
  for (const lockPath of options.lockFiles){
    outcomes.push(await regenerateLockFile(lockPath, options));
  }
  return outcomes;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZXBlbmRlbmN5X2xvY2tfcmVnZW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBMb2NrLWZpbGUgcmVnZW5lcmF0aW9uIGZvciBtZXJnZSBjb25mbGljdHMgKElzc3VlICM0NjUsIHBhcnQgb2YgIzQ1NikuXG4gKlxuICogQSBjb25mbGljdGVkIGxvY2sgZmlsZSBpcyAqKm5ldmVyKiogdGV4dC1tZXJnZWQuIGBkZW5vLmxvY2tgLFxuICogYHBhY2thZ2UtbG9jay5qc29uYCwgYENhcmdvLmxvY2tgIGFuZCBgZ28uc3VtYCBjYXJyeSBpbnRlZ3JpdHkgaGFzaGVzIG92ZXIgYVxuICogcmVzb2x2ZWQgZGVwZW5kZW5jeSBncmFwaCwgc28gcGlja2luZyBodW5rcyBwcm9kdWNlcyBhIGZpbGUgdGhhdCBsb29rcyBjbGVhblxuICog4oCUIG5vIGNvbmZsaWN0IG1hcmtlcnMg4oCUIHdoaWxlIGRlc2NyaWJpbmcgYSBncmFwaCB0aGF0IG5ldmVyIGV4aXN0ZWQuIFRoZVxuICogb25seSBjb3JyZWN0IHJlc29sdXRpb24gaXMgdG8gdGhyb3cgdGhlIGNvbmZsaWN0ZWQgbG9jayBhd2F5IGFuZCBsZXQgdGhlXG4gKiBlY29zeXN0ZW0ncyBvd24gdG9vbCByZWdlbmVyYXRlIGl0IGZyb20gdGhlIGFscmVhZHktbWVyZ2VkIG1hbmlmZXN0LlxuICpcbiAqIFRoZSBzZXF1ZW5jZSBmb3Igb25lIGxvY2sgZmlsZSBpczpcbiAqXG4gKiBgYGBtZXJtYWlkXG4gKiBmbG93Y2hhcnQgVERcbiAqICAgICBBW0NvbmZsaWN0ZWQgbG9jayBmaWxlXSAtLT4gQntNYW5pZmVzdCBydWxlLXJlc29sdmVkPGJyLz5vciBuZXZlciBjb25mbGljdGVkP31cbiAqICAgICBCIC0tIG5vIC0tPiBVW3VucmVzb2x2ZWRdXG4gKiAgICAgQiAtLSB5ZXMgLS0+IEN7VG9vbGNoYWluIG9uIFBBVEg/fVxuICogICAgIEMgLS0gbm8gLS0+IFVcbiAqICAgICBDIC0tIHllcyAtLT4gRFtnaXQgY2hlY2tvdXQgLS1vdXJzIC0tIGxvY2tdXG4gKiAgICAgRCAtLT4gRVtSdW4gdGhlIGVjb3N5c3RlbSB0b29sPGJyLz5ib3VuZGVkIGJ5IGEgdGltZW91dF1cbiAqICAgICBFIC0tIG5vbi16ZXJvIC0tPiBSW2dpdCBjaGVja291dCAtLW1lcmdlIC0tIGxvY2tdIC0tPiBVXG4gKiAgICAgRSAtLSB6ZXJvIC0tPiBGe01hcmtlci1mcmVlIGxvY2sgb24gZGlzaz99XG4gKiAgICAgRiAtLSBubyAtLT4gUlxuICogICAgIEYgLS0geWVzIC0tPiBHW2dpdCBhZGQgLS0gbG9ja10gLS0+IEhbcmVnZW5lcmF0ZWRdXG4gKiBgYGBcbiAqXG4gKiBFdmVyeSBkZWZlcnJhbCByZXR1cm5zIGB1bnJlc29sdmVkYCwgd2hpY2ggcm91dGVzIHRoZSBmaWxlIHRvIHRoZSBleGlzdGluZ1xuICogQUktZmFsbGJhY2sgYW5kIGBuZWVkcy1odW1hbmAgZXNjYWxhdGlvbiBwYXRoIGluXG4gKiBgcHJfbWVyZ2VfY29uZmxpY3RfcHJvY2Vzc29yLnRzYCDigJQgYSBmYWlsZWQgcmVnZW5lcmF0aW9uIGlzIHZpc2libGUgb24gdGhlXG4gKiBQUiByYXRoZXIgdGhhbiBzaWxlbnQsIGFuZCBuZXZlciBsZWF2ZXMgYSBoYWxmLXdyaXR0ZW4gbG9jayBzdGFnZWQuXG4gKlxuICogYGNvbnRhaW5lci90b29scy5qc29uYCByZWdpc3RlcnMgYGRlbm9gLCBgbm9kZWAvYG5wbWAgYW5kIGBydXN0YC9gY2FyZ29gIGJ1dFxuICogaGFzICoqbm8gR28gZW50cnkqKiwgc28gYGdvLnN1bWAgZmFsbHMgdGhyb3VnaCB0aGUgdG9vbGNoYWluIHByb2JlIHRvZGF5LlxuICogVGhhdCBpcyB0aGUgcHJvYmUgd29ya2luZywgbm90IGEgc3BlY2lhbCBjYXNlOiB0aGUgcnVsZSBpcyByZWdpc3RlcmVkIGFuZFxuICogc3RhcnRzIHdvcmtpbmcgdGhlIGRheSB0aGUgaW1hZ2Ugc2hpcHMgR28uXG4gKlxuICogVGhlIGNvbW1hbmQgcnVubmVyLCB0b29sY2hhaW4gcHJvYmUgYW5kIGxvY2stZmlsZSByZWFkZXIgYXJlIGFsbCBpbmplY3RlZCxcbiAqIHNvIHRoZSBtb2R1bGUgaXMgZnVsbHkgdW5pdC10ZXN0YWJsZSB3aXRob3V0IHNoZWxsaW5nIG91dC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggaXMgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG5vcm1hbGlzZWQsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSdWxlT3V0Y29tZSB9IGZyb20gXCIuL2RlcGVuZGVuY3lfY29uZmxpY3RfcnVsZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHsgdHJ1bmNhdGVMb2dUYWlsIH0gZnJvbSBcIi4vbG9nX3RhaWwudHNcIjtcbmltcG9ydCB7IHJlZGFjdFNlY3JldHMgfSBmcm9tIFwiLi9zZWNyZXRfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQgeyBidWlsZFVudHJ1c3RlZENvbW1hbmRFbnYgfSBmcm9tIFwiLi91bnRydXN0ZWRfY29tbWFuZF9lbnYudHNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUeXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBQYWNrYWdlIGVjb3N5c3RlbSBvd25pbmcgYSBsb2NrIGZpbGUuICovXG5leHBvcnQgdHlwZSBMb2NrRWNvc3lzdGVtID0gXCJkZW5vXCIgfCBcIm5wbVwiIHwgXCJjYXJnb1wiIHwgXCJnb1wiO1xuXG4vKiogT25lIHJlZ2VuZXJhdGlvbiBpbnZvY2F0aW9uLCBhcyBkYXRhIHNvIGl0IGNhbiBiZSBhc3NlcnRlZCBvbiBhbmQgc3R1YmJlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVnZW5Db21tYW5kIHtcbiAgYmluOiBzdHJpbmc7XG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIEhvdyBhIHBhaXJlZCBtYW5pZmVzdCBjYW1lIG91dCBvZiB0aGUgZGV0ZXJtaW5pc3RpYyBydWxlIHBhc3MuXG4gKlxuICogRGVyaXZlZCBmcm9tIGBSdWxlT3V0Y29tZWAgc28gdGhpcyBzZWFtIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBydWxlIGNvcmUgaW5cbiAqIGBkZXBlbmRlbmN5X2NvbmZsaWN0X3J1bGVzLnRzYC5cbiAqL1xuZXhwb3J0IHR5cGUgTWFuaWZlc3RTdGF0dXMgPSBSdWxlT3V0Y29tZVtcImtpbmRcIl07XG5cbi8qKiBXaGF0IGEgbG9jayBmaWxlIG5lZWRzIHRvIGJlIHJlZ2VuZXJhdGVkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBMb2NrRmlsZVNwZWMge1xuICBlY29zeXN0ZW06IExvY2tFY29zeXN0ZW07XG4gIC8qKiBCYXNlbmFtZSBvZiB0aGUgbG9jayBmaWxlIHRoaXMgc3BlYyBvd25zLiAqL1xuICBsb2NrRmlsZTogc3RyaW5nO1xuICAvKiogQmluYXJ5IHRoYXQgbXVzdCBiZSBvbiBgUEFUSGAgYmVmb3JlIGFueXRoaW5nIGlzIHJ1bi4gKi9cbiAgYmluYXJ5OiBzdHJpbmc7XG4gIC8qKiBNYW5pZmVzdCBiYXNlbmFtZXMgYmVzaWRlIHRoZSBsb2NrLCBpbiBwcmVmZXJlbmNlIG9yZGVyLiAqL1xuICBtYW5pZmVzdHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogVGhlIGxvY2sgZGVzY3JpYmVzIGEgd2hvbGUgd29ya3NwYWNlIChJc3N1ZSAjMTkwMyk6IGl0cyBkZXBlbmRlbmN5XG4gICAqIHRhYmxlcyBsaXZlIGluIG1lbWJlciBtYW5pZmVzdHMgYmVsb3cgdGhlIGxvY2sncyBkaXJlY3RvcnksIGFuZCB0aGVcbiAgICogcmVnZW5lcmF0aW9uIGNvbW1hbmQgcmVhZHMgZXZlcnkgb25lIG9mIHRoZW0uIEFuIHVucmVzb2x2ZWQgbWVtYmVyXG4gICAqIG1hbmlmZXN0IHRoZXJlZm9yZSBkZWZlcnMgdGhlIGxvY2sgZXhhY3RseSBhcyBhbiB1bnJlc29sdmVkIG1hbmlmZXN0XG4gICAqIGJlc2lkZSBpdCBkb2VzIOKAlCBgY2FyZ28gdXBkYXRlIC0td29ya3NwYWNlYCBvbiBhIHRyZWUgdGhhdCBzdGlsbCBjYXJyaWVzXG4gICAqIGNvbmZsaWN0IG1hcmtlcnMgZmFpbHMgd2l0aCBcImtleSB3aXRoIG5vIHZhbHVlLCBleHBlY3RlZCBgPWBcIiwgd2hpY2hcbiAgICogdXNlZCB0byBiZSByZWNvcmRlZCBhcyB0aGUgcmVnZW5lcmF0aW9uIGhhdmluZyBmYWlsZWQuXG4gICAqL1xuICB3b3Jrc3BhY2U/OiB0cnVlO1xuICAvKipcbiAgICogUmVnZW5lcmF0aW9uIGNvbW1hbmRzLCB0cmllZCBpbiBvcmRlciB1bnRpbCBvbmUgZXhpdHMgemVyby5cbiAgICpcbiAgICogT25seSBgY2FyZ29gIGhhcyBtb3JlIHRoYW4gb25lOiB0aGUgb2ZmbGluZSByZWZyZXNoIGlzIHByZWZlcnJlZCwgYW5kIHRoZVxuICAgKiBuZXR3b3JrLXBlcm1pdHRlZCByZWZyZXNoIGlzIHRoZSBmYWxsYmFjayB3aGVuIHRoZSBvZmZsaW5lIGNhY2hlIGNhbm5vdFxuICAgKiBzYXRpc2Z5IHRoZSBtZXJnZWQgbWFuaWZlc3QuXG4gICAqL1xuICBjb21tYW5kczogcmVhZG9ubHkgUmVnZW5Db21tYW5kW107XG59XG5cbi8qKiBBIGNvbW1hbmQgdGhlIHJ1bm5lciBpcyBhc2tlZCB0byBleGVjdXRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5uZXJDYWxsIHtcbiAgYmluOiBzdHJpbmc7XG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogQWJzb2x1dGUgZGlyZWN0b3J5IHRvIHJ1biBpbiDigJQgdGhlIGxvY2sgZmlsZSdzIG93biBkaXJlY3RvcnkuICovXG4gIGN3ZDogc3RyaW5nO1xuICAvKiogSGFyZCBjZWlsaW5nIG9uIHRoZSBydW4sIGluIG1pbGxpc2Vjb25kcy4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG4gIC8qKiBSZXBvc2l0b3J5LXJlbGF0aXZlIGxvY2sgZmlsZSB0aGlzIGNhbGwgaXMgcGFydCBvZiwgZm9yIGxvZ2dpbmcuICovXG4gIGxvY2tQYXRoOiBzdHJpbmc7XG59XG5cbi8qKiBSZXN1bHQgb2YgcnVubmluZyBhIHtAbGluayBSdW5uZXJDYWxsfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVubmVyT3V0Y29tZSB7XG4gIGNvZGU6IG51bWJlcjtcbiAgc3Rkb3V0OiBzdHJpbmc7XG4gIHN0ZGVycjogc3RyaW5nO1xufVxuXG4vKiogUnVucyBhIGNvbW1hbmQuIEluamVjdGVkIHNvIHRlc3RzIG5ldmVyIHNoZWxsIG91dC4gKi9cbmV4cG9ydCB0eXBlIExvY2tDb21tYW5kUnVubmVyID0gKGNhbGw6IFJ1bm5lckNhbGwpID0+IFByb21pc2U8UnVubmVyT3V0Y29tZT47XG5cbi8qKiBXaGV0aGVyIGEgYmluYXJ5IGlzIGF2YWlsYWJsZSBpbiB0aGUgY29udGFpbmVyLiBJbmplY3RlZCBmb3IgdGVzdHMuICovXG5leHBvcnQgdHlwZSBUb29sUHJvYmUgPSAoYmluOiBzdHJpbmcpID0+IFByb21pc2U8Ym9vbGVhbj47XG5cbi8qKlxuICogVGhlIGxvZ2dpbmcgc3VyZmFjZSB0aGlzIG1vZHVsZSBuZWVkcy5cbiAqXG4gKiBTdHJ1Y3R1cmFsbHkgc2F0aXNmaWVkIGJ5IHRoZSB3b3JrZXIncyBgTG9nZ2VyYCwgc28gY2FsbGVycyBwYXNzIHRoZWlyc1xuICogc3RyYWlnaHQgdGhyb3VnaDsgdGVzdHMgcGFzcyBhIG9uZS1tZXRob2Qgc3R1Yi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBMb2NrUmVnZW5Mb2dnZXIge1xuICB3YXJuKG1lc3NhZ2U6IHN0cmluZywgY29udGV4dD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZDtcbiAgaW5mbz8obWVzc2FnZTogc3RyaW5nLCBjb250ZXh0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIHJlZ2VuZXJhdGVMb2NrRmlsZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIExvY2tSZWdlbk9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgcGF0aCBvZiB0aGUgcmVwb3NpdG9yeSB3b3JraW5nIGRpcmVjdG9yeS4gKi9cbiAgd29ya2luZ0Rpcjogc3RyaW5nO1xuICAvKipcbiAgICogUnVsZSBvdXRjb21lIHBlciAqKmNvbmZsaWN0ZWQqKiBtYW5pZmVzdCwga2V5ZWQgb24gcmVwb3NpdG9yeS1yZWxhdGl2ZVxuICAgKiBwYXRoLiBBIG1hbmlmZXN0IHRoYXQgd2FzIG5vdCBjb25mbGljdGVkIGF0IGFsbCBpcyBzaW1wbHkgYWJzZW50LlxuICAgKi9cbiAgbWFuaWZlc3RPdXRjb21lczogUmVhZG9ubHlNYXA8c3RyaW5nLCBNYW5pZmVzdFN0YXR1cz47XG4gIC8qKiBDb21tYW5kIHJ1bm5lciDigJQgZGVmYXVsdHMgdG8gYSByZWFsLCB0aW1lb3V0LWJvdW5kZWQgc3VicHJvY2VzcyBydW5uZXIuICovXG4gIHJ1bm5lcj86IExvY2tDb21tYW5kUnVubmVyO1xuICAvKiogVG9vbGNoYWluIHByb2JlIOKAlCBkZWZhdWx0cyB0byBhIGBQQVRIYCBsb29rdXAuICovXG4gIGhhc1Rvb2w/OiBUb29sUHJvYmU7XG4gIC8qKiBMb2NrLWZpbGUgcmVhZGVyIOKAlCBkZWZhdWx0cyB0byByZWFkaW5nIHVuZGVyIGB3b3JraW5nRGlyYC4gKi9cbiAgcmVhZExvY2tGaWxlPzogKHBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqIFBlci1jb21tYW5kIHRpbWVvdXQ7IGRlZmF1bHRzIHRvIHtAbGluayBERUZBVUxUX0xPQ0tfUkVHRU5fVElNRU9VVF9NU30uICovXG4gIHRpbWVvdXRNcz86IG51bWJlcjtcbiAgbG9nZ2VyPzogTG9ja1JlZ2VuTG9nZ2VyO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIHJlZ2VuZXJhdGVMb2NrRmlsZXN9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBMb2NrUmVnZW5CYXRjaE9wdGlvbnMgZXh0ZW5kcyBMb2NrUmVnZW5PcHRpb25zIHtcbiAgLyoqIFJlcG9zaXRvcnktcmVsYXRpdmUgcGF0aHMgb2YgdGhlIGNvbmZsaWN0ZWQgbG9jayBmaWxlcy4gKi9cbiAgbG9ja0ZpbGVzOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBPdXRjb21lIGZvciBvbmUgbG9jayBmaWxlLlxuICpcbiAqIFRoZXJlIGlzIGRlbGliZXJhdGVseSAqKm5vIHRleHQgZmllbGQqKjogdGhlIGVjb3N5c3RlbSB0b29sIGlzIHRoZSBvbmx5XG4gKiB3cml0ZXIgb2YgbG9jayBjb250ZW50LCBzbyBubyBjYWxsZXIgY2FuIGJlIGhhbmRlZCBodW5rLWRlcml2ZWQgdGV4dCB0b1xuICogd3JpdGUuIFRoYXQgaXMgdGhlIFwibmV2ZXIgdGV4dC1tZXJnZVwiIHJ1bGUgZXhwcmVzc2VkIGluIHRoZSB0eXBlLlxuICovXG5leHBvcnQgdHlwZSBMb2NrUmVnZW5PdXRjb21lID1cbiAgfCB7XG4gICAga2luZDogXCJyZWdlbmVyYXRlZFwiO1xuICAgIHBhdGg6IHN0cmluZztcbiAgICBlY29zeXN0ZW06IExvY2tFY29zeXN0ZW07XG4gICAgLyoqIFRoZSBjb21tYW5kIHRoYXQgYWN0dWFsbHkgc3VjY2VlZGVkLiAqL1xuICAgIGNvbW1hbmQ6IFJlZ2VuQ29tbWFuZDtcbiAgfVxuICB8IHsga2luZDogXCJ1bnJlc29sdmVkXCI7IHBhdGg6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDb25zdGFudHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogRGVmYXVsdCBjZWlsaW5nIG9uIGEgc2luZ2xlIHJlZ2VuZXJhdGlvbiBjb21tYW5kICg1IG1pbnV0ZXMpLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTE9DS19SRUdFTl9USU1FT1VUX01TID0gMzAwXzAwMDtcblxuLyoqIExpbmVzIG9mIGNvbW1hbmQgb3V0cHV0IGtlcHQgaW4gYSBmYWlsdXJlIHJlYXNvbi4gKi9cbmV4cG9ydCBjb25zdCBMT0NLX1JFR0VOX09VVFBVVF9UQUlMX0xJTkVTID0gMjA7XG5cbi8qKiBCeXRlIGNlaWxpbmcgb24gdGhhdCB0YWlsLCBzbyBvbmUgcnVuYXdheSBsaW5lIGNhbm5vdCBmbG9vZCB0aGUgbG9nLiAqL1xuZXhwb3J0IGNvbnN0IExPQ0tfUkVHRU5fT1VUUFVUX1RBSUxfQllURVMgPSAyMDQ4O1xuXG4vKipcbiAqIEFueSBjb25mbGljdCBtYXJrZXIgYXQgdGhlIHN0YXJ0IG9mIGEgbGluZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgYSBsaXRlcmFsIOKAlCBpdCBpcyB0aGUgc2FtZSBzaGFwZSB0aGUgQ0kgXCJDaGVjayBmb3IgbWVyZ2VcbiAqIGNvbmZsaWN0IG1hcmtlcnNcIiBzdGVwIGdyZXBzIGZvciwgYW5kIGEgZHluYW1pY2FsbHkgYnVpbHQgcmVnZXggd291bGQgYmUgdGhlXG4gKiB3cm9uZyBwcmltaXRpdmUgZm9yIGEgZml4ZWQgc2V0IG9mIGZvdXIgbWFya2Vycy5cbiAqL1xuY29uc3QgQ09ORkxJQ1RfTUFSS0VSX1BBVFRFUk4gPSAvXig8ezd9fFxcfHs3fXw9ezd9fD57N30pL207XG5cbi8qKiBUaGUgbG9jayBmaWxlcyB0aGlzIG1vZHVsZSBrbm93cyBob3cgdG8gcmVnZW5lcmF0ZS4gKi9cbmV4cG9ydCBjb25zdCBMT0NLX0ZJTEVfU1BFQ1M6IHJlYWRvbmx5IExvY2tGaWxlU3BlY1tdID0gW1xuICB7XG4gICAgZWNvc3lzdGVtOiBcImRlbm9cIixcbiAgICBsb2NrRmlsZTogXCJkZW5vLmxvY2tcIixcbiAgICBiaW5hcnk6IFwiZGVub1wiLFxuICAgIG1hbmlmZXN0czogW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSxcbiAgICBjb21tYW5kczogW3sgYmluOiBcImRlbm9cIiwgYXJnczogW1wiaW5zdGFsbFwiXSB9XSxcbiAgfSxcbiAge1xuICAgIGVjb3N5c3RlbTogXCJucG1cIixcbiAgICBsb2NrRmlsZTogXCJwYWNrYWdlLWxvY2suanNvblwiLFxuICAgIGJpbmFyeTogXCJucG1cIixcbiAgICBtYW5pZmVzdHM6IFtcInBhY2thZ2UuanNvblwiXSxcbiAgICBjb21tYW5kczogW3sgYmluOiBcIm5wbVwiLCBhcmdzOiBbXCJpbnN0YWxsXCIsIFwiLS1wYWNrYWdlLWxvY2stb25seVwiXSB9XSxcbiAgfSxcbiAge1xuICAgIGVjb3N5c3RlbTogXCJjYXJnb1wiLFxuICAgIGxvY2tGaWxlOiBcIkNhcmdvLmxvY2tcIixcbiAgICBiaW5hcnk6IFwiY2FyZ29cIixcbiAgICBtYW5pZmVzdHM6IFtcIkNhcmdvLnRvbWxcIl0sXG4gICAgd29ya3NwYWNlOiB0cnVlLFxuICAgIGNvbW1hbmRzOiBbXG4gICAgICB7IGJpbjogXCJjYXJnb1wiLCBhcmdzOiBbXCJ1cGRhdGVcIiwgXCItLXdvcmtzcGFjZVwiLCBcIi0tb2ZmbGluZVwiXSB9LFxuICAgICAgeyBiaW46IFwiY2FyZ29cIiwgYXJnczogW1widXBkYXRlXCIsIFwiLS13b3Jrc3BhY2VcIl0gfSxcbiAgICBdLFxuICB9LFxuICB7XG4gICAgZWNvc3lzdGVtOiBcImdvXCIsXG4gICAgbG9ja0ZpbGU6IFwiZ28uc3VtXCIsXG4gICAgYmluYXJ5OiBcImdvXCIsXG4gICAgbWFuaWZlc3RzOiBbXCJnby5tb2RcIl0sXG4gICAgY29tbWFuZHM6IFt7IGJpbjogXCJnb1wiLCBhcmdzOiBbXCJtb2RcIiwgXCJ0aWR5XCJdIH1dLFxuICB9LFxuXTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQYXRoIGhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFdoZXRoZXIgYSBwYXRoIGlzIGEgc2FmZSByZXBvc2l0b3J5LXJlbGF0aXZlIHBhdGguXG4gKlxuICogRXhwb3J0ZWQgYmVjYXVzZSB0aGUgZGV0ZXJtaW5pc3RpYyBwYXNzIChJc3N1ZSAjNDY2KSBndWFyZHMgdGhlIG1hbmlmZXN0XG4gKiBwYXRocyBpdCB3cml0ZXMgd2l0aCBleGFjdGx5IHRoZSBzYW1lIHJ1bGUg4oCUIG9uZSBkZWZpbml0aW9uLCBub3QgdHdvLlxuICpcbiAqIFRoZSBwYXRocyBhcnJpdmUgZnJvbSBgZ2l0IGRpZmYgLS1uYW1lLW9ubHlgIG9uIGEgY29uZmxpY3RlZCBtZXJnZSwgYnV0IHRoZXlcbiAqIGRlY2lkZSBhIGBjd2RgIGFuZCBhIGZpbGVzeXN0ZW0gcmVhZCwgc28gdGhleSBhcmUgdmFsaWRhdGVkIHJhdGhlciB0aGFuXG4gKiB0cnVzdGVkOiBubyBhYnNvbHV0ZSBwYXRoLCBubyBkcml2ZSBsZXR0ZXIsIG5vIGJhY2tzbGFzaCwgYW5kIG5vIGAuYC9gLi5gXG4gKiBzZWdtZW50IHRoYXQgY291bGQgZXNjYXBlIHRoZSB3b3JraW5nIGRpcmVjdG9yeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2FmZVJlcG9SZWxhdGl2ZVBhdGgocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChwYXRoID09PSBcIlwiIHx8IHBhdGguc3RhcnRzV2l0aChcIi9cIikgfHwgcGF0aC5pbmNsdWRlcyhcIlxcXFxcIikpIHJldHVybiBmYWxzZTtcbiAgaWYgKC9eW0EtWmEtel06Ly50ZXN0KHBhdGgpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBwYXRoLnNwbGl0KFwiL1wiKS5ldmVyeSgocGFydCkgPT5cbiAgICBwYXJ0ICE9PSBcIlwiICYmIHBhcnQgIT09IFwiLlwiICYmIHBhcnQgIT09IFwiLi5cIlxuICApO1xufVxuXG4vKiogQmFzZW5hbWUgb2YgYSByZXBvc2l0b3J5LXJlbGF0aXZlIHBhdGguICovXG5mdW5jdGlvbiBiYXNlbmFtZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5zbGljZShwYXRoLmxhc3RJbmRleE9mKFwiL1wiKSArIDEpO1xufVxuXG4vKiogRGlyZWN0b3J5IG9mIGEgcmVwb3NpdG9yeS1yZWxhdGl2ZSBwYXRoLCBgXCJcImAgYXQgdGhlIHJlcG9zaXRvcnkgcm9vdC4gKi9cbmZ1bmN0aW9uIGRpcm5hbWUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYXQgPSBwYXRoLmxhc3RJbmRleE9mKFwiL1wiKTtcbiAgcmV0dXJuIGF0ID09PSAtMSA/IFwiXCIgOiBwYXRoLnNsaWNlKDAsIGF0KTtcbn1cblxuLyoqIEpvaW4gYSB3b3JraW5nIGRpcmVjdG9yeSB3aXRoIGEgcmVwb3NpdG9yeS1yZWxhdGl2ZSBwYXRoLiAqL1xuZnVuY3Rpb24gam9pblBhdGgod29ya2luZ0Rpcjogc3RyaW5nLCByZWxhdGl2ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IHdvcmtpbmdEaXIucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgcmV0dXJuIHJlbGF0aXZlID09PSBcIlwiID8gYmFzZSA6IGAke2Jhc2V9LyR7cmVsYXRpdmV9YDtcbn1cblxuLyoqIFRoZSBzcGVjIG93bmluZyBhIGxvY2stZmlsZSBwYXRoLCBvciB1bmRlZmluZWQgd2hlbiB0aGVyZSBpcyBub25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2tTcGVjRm9yUGF0aChwYXRoOiBzdHJpbmcpOiBMb2NrRmlsZVNwZWMgfCB1bmRlZmluZWQge1xuICBjb25zdCBuYW1lID0gYmFzZW5hbWUocGF0aCk7XG4gIHJldHVybiBMT0NLX0ZJTEVfU1BFQ1MuZmluZCgoc3BlYykgPT4gc3BlYy5sb2NrRmlsZSA9PT0gbmFtZSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gT3V0cHV0IGZvcm1hdHRpbmdcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFJlZGFjdCBhbmQgYm91bmQgYSBjb21tYW5kJ3MgY29tYmluZWQgb3V0cHV0IGJlZm9yZSBpdCBpcyByZXBvcnRlZC5cbiAqXG4gKiBSZWRhY3Rpb24gcnVucyBvdmVyIHRoZSAqKndob2xlKiogdGV4dCBiZWZvcmUgdHJ1bmNhdGlvbiDigJQgdGhlXG4gKiByZWRhY3QtYmVmb3JlLXRydW5jYXRlIHN0YW5kYXJkIGluIFNFQ1VSSVRZLm1kIOKAlCBzbyBhIHNlY3JldCBzdHJhZGRsaW5nIHRoZVxuICogY3V0IGNhbm5vdCBzdXJ2aXZlIGluIHRoZSBrZXB0IHRhaWwuIEJvdGggdGhlIGxpbmUgYW5kIHRoZSBieXRlIGNlaWxpbmcgYXJlXG4gKiBhbm5vdW5jZWQgd2hlbiB0aGV5IGJpdGUsIHNvIGEgYm91bmRlZCB0YWlsIGlzIG5ldmVyIG1pc3Rha2VuIGZvciB0aGUgd2hvbGVcbiAqIG91dHB1dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdExvY2tSZWdlbk91dHB1dChcbiAgc3Rkb3V0OiBzdHJpbmcsXG4gIHN0ZGVycjogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgY29tYmluZWQgPSBbc3Rkb3V0ID8/IFwiXCIsIHN0ZGVyciA/PyBcIlwiXS5maWx0ZXIoKHBhcnQpID0+XG4gICAgcGFydC50cmltKCkubGVuZ3RoID4gMFxuICApLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHJlZGFjdGVkID0gcmVkYWN0U2VjcmV0cyhjb21iaW5lZCkudHJpbUVuZCgpO1xuICBpZiAocmVkYWN0ZWQubGVuZ3RoID09PSAwKSByZXR1cm4gXCJcIjtcblxuICBjb25zdCBsaW5lcyA9IHJlZGFjdGVkLnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBkcm9wcGVkID0gTWF0aC5tYXgoMCwgbGluZXMubGVuZ3RoIC0gTE9DS19SRUdFTl9PVVRQVVRfVEFJTF9MSU5FUyk7XG4gIGNvbnN0IG1hcmtlciA9IGRyb3BwZWQgPiAwXG4gICAgPyBgWy4uLnRydW5jYXRlZCAke2Ryb3BwZWR9IGxpbmVzIOKAlCBzaG93aW5nIHRhaWwuLi5dXFxuYFxuICAgIDogXCJcIjtcbiAgY29uc3QgdGFpbCA9IGxpbmVzLnNsaWNlKC1MT0NLX1JFR0VOX09VVFBVVF9UQUlMX0xJTkVTKS5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gdHJ1bmNhdGVMb2dUYWlsKG1hcmtlciArIHRhaWwsIExPQ0tfUkVHRU5fT1VUUFVUX1RBSUxfQllURVMpO1xufVxuXG4vKiogUmVuZGVyIGEgY29tbWFuZCBmb3IgYSBtZXNzYWdlOiBgYCBgZGVubyBpbnN0YWxsYCBgYC4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlKGNvbW1hbmQ6IFJlZ2VuQ29tbWFuZCk6IHN0cmluZyB7XG4gIHJldHVybiBgXFxgJHtbY29tbWFuZC5iaW4sIC4uLmNvbW1hbmQuYXJnc10uam9pbihcIiBcIil9XFxgYDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBEZWZhdWx0c1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRGVmYXVsdCBydW5uZXIg4oCUIHNwYXducyB0aGUgY29tbWFuZCwgYm91bmRlZCBieSBhbiBhYm9ydCBzaWduYWwuXG4gKlxuICogQSBzcGF3biBmYWlsdXJlIHRocm93cyByYXRoZXIgdGhhbiBiZWluZyByZXBvcnRlZCBhcyBhIGNsZWFuIGV4aXQ6IHRoZVxuICogY2FsbGVyIHR1cm5zIGl0IGludG8gYHVucmVzb2x2ZWRgLCBzbyBhIG1pc3Npbmcgb3IgYnJva2VuIHRvb2xjaGFpbiBjYW5cbiAqIG5ldmVyIGxvb2sgbGlrZSBhIHN1Y2Nlc3NmdWwgcmVnZW5lcmF0aW9uLlxuICpcbiAqIElzc3VlICMxMjI3OiB0aGUgYmluYXJ5IGNvbWVzIGZyb20gYGNhbGwuYmluYCwgYW5kIHRoZSBsb2NrIGNoZWNrb3V0L3N0YWdlXG4gKiBzdGVwcyBwYXNzIGBcImdpdFwiYCDigJQgZGlyZWN0IGBnaXRgIHNwYXducyB0aGUgbGl0ZXJhbC1tYXRjaGluZyBjaG9rZXBvaW50XG4gKiBnYXRlIGNvdWxkIG5vdCBzZWUuIFRoZXkgYXJlIGRlbGVnYXRlZCB0byBgcnVuR2l0Q29tbWFuZGAsIHdoaWNoIG93bnMgdGhlXG4gKiB0aW1lb3V0LCB0aGUgYXVkaXQgam91cm5hbCBhbmQgdGhlIHdvcmstdm9sdW1lIGZhdWx0IGRldGVjdG9yLiBUaGVcbiAqIHVudHJ1c3RlZC1lbnZpcm9ubWVudCBidWlsZCBiZWxvdyBzdGF5cyB3aXRoIHRoZSBlY29zeXN0ZW0gdG9vbHMgaXQgd2FzXG4gKiB3cml0dGVuIGZvcjogYGdpdGAgaXMgdGhlIHdvcmtlcidzIG93biBiaW5hcnksIG5vdCByZXBvc2l0b3J5LXN1cHBsaWVkIGNvZGUuXG4gKi9cbmV4cG9ydCBjb25zdCBkZWZhdWx0UnVubmVyOiBMb2NrQ29tbWFuZFJ1bm5lciA9IGFzeW5jIChjYWxsKSA9PiB7XG4gIGlmIChjYWxsLmJpbiA9PT0gXCJnaXRcIikge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoWy4uLmNhbGwuYXJnc10sIHtcbiAgICAgIGN3ZDogY2FsbC5jd2QsXG4gICAgICB0aW1lb3V0U2Vjb25kczogTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGNhbGwudGltZW91dE1zIC8gMTAwMCkpLFxuICAgIH0pO1xuICAgIC8vIEZhaWwgbG91ZCwgbWF0Y2hpbmcgdGhlIHNwYXduLWZhaWx1cmUgY29udHJhY3QgYWJvdmUuXG4gICAgaWYgKCFyZXN1bHQub2spIHRocm93IHJlc3VsdC5lcnJvcjtcbiAgICByZXR1cm4gcmVzdWx0LnZhbHVlO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgbmV3IERlbm8uQ29tbWFuZChjYWxsLmJpbiwge1xuICAgIGFyZ3M6IFsuLi5jYWxsLmFyZ3NdLFxuICAgIGN3ZDogY2FsbC5jd2QsXG4gICAgc3RkaW46IFwibnVsbFwiLFxuICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgIC8vIGBucG0gaW5zdGFsbGAsIGBkZW5vIGluc3RhbGxgLCBgY2FyZ28gdXBkYXRlYCBhbmQgYGdvIG1vZCB0aWR5YCBydW5cbiAgICAvLyBpbnN0YWxsIGhvb2tzIGRlY2xhcmVkIGJ5IGEgbWFuaWZlc3QgdGhlIHJlcG9zaXRvcnkgY29udHJvbHMsIHNvIHRoaXNcbiAgICAvLyBpcyBjb2RlIHRoZSB3b3JrZXIgZGlkIG5vdCB3cml0ZS4gSXRzIGVudmlyb25tZW50IGlzIEJVSUxUIGZyb20gdGhlXG4gICAgLy8gYWxsb3dsaXN0IHJhdGhlciB0aGFuIGluaGVyaXRlZCAoSXNzdWVzICM1NzIsICMxMjE0KSDigJQgYSBwb3N0aW5zdGFsbFxuICAgIC8vIHNjcmlwdCBoYXMgbm8gY3JlZGVudGlhbCBpbiBzY29wZSB0byBlY2hvLlxuICAgIGVudjogYnVpbGRVbnRydXN0ZWRDb21tYW5kRW52KCksXG4gICAgY2xlYXJFbnY6IHRydWUsXG4gICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KGNhbGwudGltZW91dE1zKSxcbiAgfSkub3V0cHV0KCk7XG5cbiAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICByZXR1cm4ge1xuICAgIGNvZGU6IG91dHB1dC5jb2RlLFxuICAgIHN0ZG91dDogZGVjb2Rlci5kZWNvZGUob3V0cHV0LnN0ZG91dCksXG4gICAgc3RkZXJyOiBkZWNvZGVyLmRlY29kZShvdXRwdXQuc3RkZXJyKSxcbiAgfTtcbn07XG5cbi8qKlxuICogRGVmYXVsdCBwcm9iZSDigJQgd2hldGhlciBgYmluYCBpcyBhbiBleGVjdXRhYmxlIGVudHJ5IG9uIGBQQVRIYC5cbiAqXG4gKiBQT1NJWCBgUEFUSGAgc2VtYW50aWNzOyB0aGUgd29ya2VyIGNvbnRhaW5lciBpcyBMaW51eC4gQW4gdW5leHBlY3RlZCBzdGF0XG4gKiBlcnJvciBpcyByZS1yYWlzZWQgcmF0aGVyIHRoYW4gYmVpbmcgcmVhZCBhcyBcImFic2VudFwiLlxuICovXG5jb25zdCBkZWZhdWx0VG9vbFByb2JlOiBUb29sUHJvYmUgPSBhc3luYyAoYmluKSA9PiB7XG4gIGZvciAoY29uc3QgZGlyIG9mIChEZW5vLmVudi5nZXQoXCJQQVRIXCIpID8/IFwiXCIpLnNwbGl0KFwiOlwiKSkge1xuICAgIGlmIChkaXIgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbmZvID0gYXdhaXQgRGVuby5zdGF0KGAke2Rpcn0vJHtiaW59YCk7XG4gICAgICBpZiAoaW5mby5pc0ZpbGUgfHwgaW5mby5pc1N5bWxpbmspIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBhYnNlbnQgPSBlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kIHx8XG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuUGVybWlzc2lvbkRlbmllZDtcbiAgICAgIGlmICghYWJzZW50KSB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufTtcblxuLyoqIERlZmF1bHQgcmVhZGVyIOKAlCByZWFkcyB0aGUgbG9jayBmaWxlIHVuZGVyIGB3b3JraW5nRGlyYCwgbnVsbCB3aGVuIGFic2VudC4gKi9cbmZ1bmN0aW9uIGRlZmF1bHRSZWFkZXIoXG4gIHdvcmtpbmdEaXI6IHN0cmluZyxcbik6IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICByZXR1cm4gYXN5bmMgKHBhdGgpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGpvaW5QYXRoKHdvcmtpbmdEaXIsIHBhdGgpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHJldHVybiBudWxsO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFJlZ2VuZXJhdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogUmVnZW5lcmF0ZSBvbmUgY29uZmxpY3RlZCBsb2NrIGZpbGUgZnJvbSBpdHMgYWxyZWFkeS1tZXJnZWQgbWFuaWZlc3QuXG4gKlxuICogUmV0dXJucyBgcmVnZW5lcmF0ZWRgIG9ubHkgd2hlbiB0aGUgZWNvc3lzdGVtJ3MgdG9vbCB3cm90ZSBhIG1hcmtlci1mcmVlXG4gKiBsb2NrIGZpbGUgdGhhdCBpcyBub3cgc3RhZ2VkLiBFdmVyeSBvdGhlciBwYXRoIOKAlCBhbiB1bnJlc29sdmVkIG1hbmlmZXN0LCBhblxuICogYWJzZW50IHRvb2xjaGFpbiwgYSBmYWlsaW5nIGNvbW1hbmQsIGEgbG9jayB0aGF0IHN0aWxsIGNhcnJpZXMgbWFya2VycyDigJRcbiAqIHJldHVybnMgYHVucmVzb2x2ZWRgIHdpdGggYSByZWFzb24sIGhhdmluZyBzdGFnZWQgbm90aGluZy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZ2VuZXJhdGVMb2NrRmlsZShcbiAgbG9ja1BhdGg6IHN0cmluZyxcbiAgb3B0aW9uczogTG9ja1JlZ2VuT3B0aW9ucyxcbik6IFByb21pc2U8TG9ja1JlZ2VuT3V0Y29tZT4ge1xuICBjb25zdCB7XG4gICAgd29ya2luZ0RpcixcbiAgICBtYW5pZmVzdE91dGNvbWVzLFxuICAgIHJ1bm5lciA9IGRlZmF1bHRSdW5uZXIsXG4gICAgaGFzVG9vbCA9IGRlZmF1bHRUb29sUHJvYmUsXG4gICAgcmVhZExvY2tGaWxlID0gZGVmYXVsdFJlYWRlcih3b3JraW5nRGlyKSxcbiAgICB0aW1lb3V0TXMgPSBERUZBVUxUX0xPQ0tfUkVHRU5fVElNRU9VVF9NUyxcbiAgICBsb2dnZXIsXG4gIH0gPSBvcHRpb25zO1xuXG4gIGNvbnN0IGRlZmVyID0gKHJlYXNvbjogc3RyaW5nKTogTG9ja1JlZ2VuT3V0Y29tZSA9PiB7XG4gICAgbG9nZ2VyPy53YXJuKGBMb2NrIGZpbGUgbGVmdCBmb3IgdGhlIEFJIGZhbGxiYWNrOiAke3JlYXNvbn1gLCB7XG4gICAgICBsb2NrUGF0aCxcbiAgICAgIHJlYXNvbixcbiAgICB9KTtcbiAgICByZXR1cm4geyBraW5kOiBcInVucmVzb2x2ZWRcIiwgcGF0aDogbG9ja1BhdGgsIHJlYXNvbiB9O1xuICB9O1xuXG4gIGlmICghaXNTYWZlUmVwb1JlbGF0aXZlUGF0aChsb2NrUGF0aCkpIHtcbiAgICByZXR1cm4gZGVmZXIoYHVuc2FmZSBwYXRoIG91dHNpZGUgdGhlIHdvcmtpbmcgZGlyZWN0b3J5OiAke2xvY2tQYXRofWApO1xuICB9XG5cbiAgY29uc3Qgc3BlYyA9IGxvY2tTcGVjRm9yUGF0aChsb2NrUGF0aCk7XG4gIGlmICghc3BlYykgcmV0dXJuIGRlZmVyKGBubyBsb2NrLWZpbGUgcnVsZSBmb3IgJHtsb2NrUGF0aH1gKTtcblxuICBjb25zdCBkaXJlY3RvcnkgPSBkaXJuYW1lKGxvY2tQYXRoKTtcblxuICAvLyBBIGxvY2sgaXMgb25seSByZWdlbmVyYXRlZCBhZ2FpbnN0IGEgbWFuaWZlc3QgdGhhdCBpcyBhY3R1YWxseSBtZXJnZWQuXG4gIGZvciAoY29uc3QgbWFuaWZlc3Qgb2Ygc3BlYy5tYW5pZmVzdHMpIHtcbiAgICBjb25zdCBtYW5pZmVzdFBhdGggPSBkaXJlY3RvcnkgPT09IFwiXCJcbiAgICAgID8gbWFuaWZlc3RcbiAgICAgIDogYCR7ZGlyZWN0b3J5fS8ke21hbmlmZXN0fWA7XG4gICAgaWYgKG1hbmlmZXN0T3V0Y29tZXMuZ2V0KG1hbmlmZXN0UGF0aCkgPT09IFwidW5yZXNvbHZlZFwiKSB7XG4gICAgICByZXR1cm4gZGVmZXIoXG4gICAgICAgIGBpdHMgbWFuaWZlc3QgJHttYW5pZmVzdFBhdGh9IGlzIHVucmVzb2x2ZWQsIHNvIGEgcmVnZW5lcmF0ZWQgbG9jayBgICtcbiAgICAgICAgICBgd291bGQgZGVzY3JpYmUgdGhlIHdyb25nIGRlcGVuZGVuY3kgc2V0YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gSXNzdWUgIzE5MDM6IGEgd29ya3NwYWNlIGxvY2sgaXMgcmVnZW5lcmF0ZWQgZnJvbSBldmVyeSBtZW1iZXIgbWFuaWZlc3RcbiAgLy8gdW5kZXIgaXQsIG5vdCBvbmx5IHRoZSBvbmUgYmVzaWRlIGl0LlxuICBpZiAoc3BlYy53b3Jrc3BhY2UpIHtcbiAgICBjb25zdCBwcmVmaXggPSBkaXJlY3RvcnkgPT09IFwiXCIgPyBcIlwiIDogYCR7ZGlyZWN0b3J5fS9gO1xuICAgIGZvciAoY29uc3QgW3BhdGgsIHN0YXR1c10gb2YgbWFuaWZlc3RPdXRjb21lcykge1xuICAgICAgaWYgKHN0YXR1cyAhPT0gXCJ1bnJlc29sdmVkXCIgfHwgIXBhdGguc3RhcnRzV2l0aChwcmVmaXgpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGlzTWVtYmVyID0gc3BlYy5tYW5pZmVzdHMuc29tZSgobWFuaWZlc3QpID0+XG4gICAgICAgIHBhdGguZW5kc1dpdGgoYC8ke21hbmlmZXN0fWApICYmIHBhdGggIT09IGAke3ByZWZpeH0ke21hbmlmZXN0fWBcbiAgICAgICk7XG4gICAgICBpZiAoIWlzTWVtYmVyKSBjb250aW51ZTtcbiAgICAgIHJldHVybiBkZWZlcihcbiAgICAgICAgYGl0cyB3b3Jrc3BhY2UgbWFuaWZlc3QgJHtwYXRofSBpcyB1bnJlc29sdmVkLCBzbyBhIHJlZ2VuZXJhdGVkIGAgK1xuICAgICAgICAgIGBsb2NrIHdvdWxkIGRlc2NyaWJlIHRoZSB3cm9uZyBkZXBlbmRlbmN5IHNldGAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGlmICghYXdhaXQgaGFzVG9vbChzcGVjLmJpbmFyeSkpIHtcbiAgICByZXR1cm4gZGVmZXIoXG4gICAgICBgdGhlICR7c3BlYy5lY29zeXN0ZW19IHRvb2xjaGFpbiBiaW5hcnkgXFxgJHtzcGVjLmJpbmFyeX1cXGAgaXMgbm90IG9uIGAgK1xuICAgICAgICBgUEFUSCBpbiB0aGlzIGNvbnRhaW5lcmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGN3ZCA9IGpvaW5QYXRoKHdvcmtpbmdEaXIsIGRpcmVjdG9yeSk7XG4gIGNvbnN0IHJ1biA9IGFzeW5jIChcbiAgICBjb21tYW5kOiBSZWdlbkNvbW1hbmQsXG4gICk6IFByb21pc2U8UnVubmVyT3V0Y29tZSB8IHsgdGhyb3duOiBzdHJpbmcgfT4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgcnVubmVyKHtcbiAgICAgICAgYmluOiBjb21tYW5kLmJpbixcbiAgICAgICAgYXJnczogY29tbWFuZC5hcmdzLFxuICAgICAgICBjd2QsXG4gICAgICAgIHRpbWVvdXRNcyxcbiAgICAgICAgbG9ja1BhdGgsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIHsgdGhyb3duOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UgfTtcbiAgICB9XG4gIH07XG5cbiAgLyoqIFJlc3RvcmUgdGhlIGNvbmZsaWN0ZWQgbG9jayBzbyB0aGUgQUkgZmFsbGJhY2sgc2VlcyB0aGUgcmVhbCBjb25mbGljdC4gKi9cbiAgY29uc3QgcmVzdG9yZSA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBhd2FpdCBydW4oeyBiaW46IFwiZ2l0XCIsIGFyZ3M6IFtcImNoZWNrb3V0XCIsIFwiLS1tZXJnZVwiLCBcIi0tXCIsIGxvY2tQYXRoXSB9KTtcbiAgfTtcblxuICAvLyBDaGVjayB0aGUgbG9jayBvdXQgdG8gYSBrbm93biBzdGF0ZTogYSBtYXJrZXItcmlkZGxlZCBmaWxlIGlzIG5vdCB2YWxpZFxuICAvLyBpbnB1dCBmb3IgYW55IG9mIHRoZXNlIHRvb2xzLlxuICBjb25zdCBjaGVja291dCA9IGF3YWl0IHJ1bih7XG4gICAgYmluOiBcImdpdFwiLFxuICAgIGFyZ3M6IFtcImNoZWNrb3V0XCIsIFwiLS1vdXJzXCIsIFwiLS1cIiwgbG9ja1BhdGhdLFxuICB9KTtcbiAgaWYgKFwidGhyb3duXCIgaW4gY2hlY2tvdXQpIHtcbiAgICByZXR1cm4gZGVmZXIoYGdpdCBjaGVja291dCBvZiAke2xvY2tQYXRofSBmYWlsZWQ6ICR7Y2hlY2tvdXQudGhyb3dufWApO1xuICB9XG4gIGlmIChjaGVja291dC5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIGRlZmVyKFxuICAgICAgYGdpdCBjaGVja291dCAtLW91cnMgb2YgJHtsb2NrUGF0aH0gZXhpdGVkICR7Y2hlY2tvdXQuY29kZX06IGAgK1xuICAgICAgICBmb3JtYXRMb2NrUmVnZW5PdXRwdXQoY2hlY2tvdXQuc3Rkb3V0LCBjaGVja291dC5zdGRlcnIpLFxuICAgICk7XG4gIH1cblxuICBsZXQgc3VjY2VlZGVkOiBSZWdlbkNvbW1hbmQgfCB1bmRlZmluZWQ7XG4gIGxldCBsYXN0RmFpbHVyZSA9IFwiXCI7XG4gIGZvciAoY29uc3QgY29tbWFuZCBvZiBzcGVjLmNvbW1hbmRzKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuKGNvbW1hbmQpO1xuICAgIGlmIChcInRocm93blwiIGluIHJlc3VsdCkge1xuICAgICAgbGFzdEZhaWx1cmUgPSBgJHtkZXNjcmliZShjb21tYW5kKX0gY291bGQgbm90IGJlIHJ1bjogJHtyZXN1bHQudGhyb3dufWA7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHJlc3VsdC5jb2RlID09PSAwKSB7XG4gICAgICBzdWNjZWVkZWQgPSBjb21tYW5kO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGxhc3RGYWlsdXJlID0gYCR7ZGVzY3JpYmUoY29tbWFuZCl9IGV4aXRlZCBub24temVybyAoZXhpdCAke3Jlc3VsdC5jb2RlfSlgICtcbiAgICAgIGA6ICR7Zm9ybWF0TG9ja1JlZ2VuT3V0cHV0KHJlc3VsdC5zdGRvdXQsIHJlc3VsdC5zdGRlcnIpfWA7XG4gIH1cblxuICBpZiAoIXN1Y2NlZWRlZCkge1xuICAgIGF3YWl0IHJlc3RvcmUoKTtcbiAgICByZXR1cm4gZGVmZXIoYHJlZ2VuZXJhdGluZyAke2xvY2tQYXRofSBmYWlsZWQg4oCUICR7bGFzdEZhaWx1cmV9YCk7XG4gIH1cblxuICBjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZExvY2tGaWxlKGxvY2tQYXRoKTtcbiAgaWYgKGNvbnRlbnQgPT09IG51bGwpIHtcbiAgICBhd2FpdCByZXN0b3JlKCk7XG4gICAgcmV0dXJuIGRlZmVyKFxuICAgICAgYCR7ZGVzY3JpYmUoc3VjY2VlZGVkKX0gZXhpdGVkIHplcm8gYnV0ICR7bG9ja1BhdGh9IGNvdWxkIG5vdCBiZSByZWFkYCxcbiAgICApO1xuICB9XG4gIGlmIChDT05GTElDVF9NQVJLRVJfUEFUVEVSTi50ZXN0KGNvbnRlbnQpKSB7XG4gICAgYXdhaXQgcmVzdG9yZSgpO1xuICAgIHJldHVybiBkZWZlcihcbiAgICAgIGAke2Rlc2NyaWJlKHN1Y2NlZWRlZCl9IGV4aXRlZCB6ZXJvIGJ1dCAke2xvY2tQYXRofSBzdGlsbCBjb250YWlucyBgICtcbiAgICAgICAgYGNvbmZsaWN0IG1hcmtlcnNgLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBzdGFnZWQgPSBhd2FpdCBydW4oeyBiaW46IFwiZ2l0XCIsIGFyZ3M6IFtcImFkZFwiLCBcIi0tXCIsIGxvY2tQYXRoXSB9KTtcbiAgaWYgKFwidGhyb3duXCIgaW4gc3RhZ2VkIHx8IHN0YWdlZC5jb2RlICE9PSAwKSB7XG4gICAgYXdhaXQgcmVzdG9yZSgpO1xuICAgIGNvbnN0IGRldGFpbCA9IFwidGhyb3duXCIgaW4gc3RhZ2VkXG4gICAgICA/IHN0YWdlZC50aHJvd25cbiAgICAgIDogYGV4aXQgJHtzdGFnZWQuY29kZX06ICR7XG4gICAgICAgIGZvcm1hdExvY2tSZWdlbk91dHB1dChzdGFnZWQuc3Rkb3V0LCBzdGFnZWQuc3RkZXJyKVxuICAgICAgfWA7XG4gICAgcmV0dXJuIGRlZmVyKGBzdGFnaW5nIHRoZSByZWdlbmVyYXRlZCAke2xvY2tQYXRofSBmYWlsZWQg4oCUICR7ZGV0YWlsfWApO1xuICB9XG5cbiAgbG9nZ2VyPy5pbmZvPy4oYFJlZ2VuZXJhdGVkICR7bG9ja1BhdGh9IGZyb20gaXRzIG1lcmdlZCBtYW5pZmVzdGAsIHtcbiAgICBsb2NrUGF0aCxcbiAgICBlY29zeXN0ZW06IHNwZWMuZWNvc3lzdGVtLFxuICAgIGNvbW1hbmQ6IFtzdWNjZWVkZWQuYmluLCAuLi5zdWNjZWVkZWQuYXJnc10uam9pbihcIiBcIiksXG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAga2luZDogXCJyZWdlbmVyYXRlZFwiLFxuICAgIHBhdGg6IGxvY2tQYXRoLFxuICAgIGVjb3N5c3RlbTogc3BlYy5lY29zeXN0ZW0sXG4gICAgY29tbWFuZDogc3VjY2VlZGVkLFxuICB9O1xufVxuXG4vKipcbiAqIFJlZ2VuZXJhdGUgZXZlcnkgY29uZmxpY3RlZCBsb2NrIGZpbGUsIGluIHRoZSBvcmRlciBnaXZlbi5cbiAqXG4gKiBFYWNoIGxvY2sgZmlsZSBpcyBpbmRlcGVuZGVudDogb25lIGRlZmVycmFsIG5ldmVyIGJsb2NrcyBhbm90aGVyLCBhbmQgdGhlXG4gKiBjYWxsZXIgZGVjaWRlcyB3aGF0IHRvIGRvIHdpdGggYSBtaXhlZCBzZXQg4oCUIHRvZGF5LCBhbnkgYHVucmVzb2x2ZWRgIHNlbmRzXG4gKiB0aGUgd2hvbGUgbWVyZ2UgdG8gdGhlIEFJIGZhbGxiYWNrLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVnZW5lcmF0ZUxvY2tGaWxlcyhcbiAgb3B0aW9uczogTG9ja1JlZ2VuQmF0Y2hPcHRpb25zLFxuKTogUHJvbWlzZTxMb2NrUmVnZW5PdXRjb21lW10+IHtcbiAgY29uc3Qgb3V0Y29tZXM6IExvY2tSZWdlbk91dGNvbWVbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxvY2tQYXRoIG9mIG9wdGlvbnMubG9ja0ZpbGVzKSB7XG4gICAgb3V0Y29tZXMucHVzaChhd2FpdCByZWdlbmVyYXRlTG9ja0ZpbGUobG9ja1BhdGgsIG9wdGlvbnMpKTtcbiAgfVxuICByZXR1cm4gb3V0Y29tZXM7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F3Q0MsR0FHRCxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFDakQsU0FBUyxlQUFlLFFBQVEsZ0JBQWdCO0FBQ2hELFNBQVMsYUFBYSxRQUFRLHdCQUF3QjtBQUN0RCxTQUFTLHdCQUF3QixRQUFRLDZCQUE2QjtBQW1JdEUsOEVBQThFO0FBQzlFLFlBQVk7QUFDWiw4RUFBOEU7QUFFOUUsa0VBQWtFLEdBQ2xFLE9BQU8sTUFBTSxnQ0FBZ0MsUUFBUTtBQUVyRCxzREFBc0QsR0FDdEQsT0FBTyxNQUFNLCtCQUErQixHQUFHO0FBRS9DLHlFQUF5RSxHQUN6RSxPQUFPLE1BQU0sK0JBQStCLEtBQUs7QUFFakQ7Ozs7OztDQU1DLEdBQ0QsTUFBTSwwQkFBMEI7QUFFaEMsd0RBQXdELEdBQ3hELE9BQU8sTUFBTSxrQkFBMkM7RUFDdEQ7SUFDRSxXQUFXO0lBQ1gsVUFBVTtJQUNWLFFBQVE7SUFDUixXQUFXO01BQUM7TUFBYTtLQUFhO0lBQ3RDLFVBQVU7TUFBQztRQUFFLEtBQUs7UUFBUSxNQUFNO1VBQUM7U0FBVTtNQUFDO0tBQUU7RUFDaEQ7RUFDQTtJQUNFLFdBQVc7SUFDWCxVQUFVO0lBQ1YsUUFBUTtJQUNSLFdBQVc7TUFBQztLQUFlO0lBQzNCLFVBQVU7TUFBQztRQUFFLEtBQUs7UUFBTyxNQUFNO1VBQUM7VUFBVztTQUFzQjtNQUFDO0tBQUU7RUFDdEU7RUFDQTtJQUNFLFdBQVc7SUFDWCxVQUFVO0lBQ1YsUUFBUTtJQUNSLFdBQVc7TUFBQztLQUFhO0lBQ3pCLFdBQVc7SUFDWCxVQUFVO01BQ1I7UUFBRSxLQUFLO1FBQVMsTUFBTTtVQUFDO1VBQVU7VUFBZTtTQUFZO01BQUM7TUFDN0Q7UUFBRSxLQUFLO1FBQVMsTUFBTTtVQUFDO1VBQVU7U0FBYztNQUFDO0tBQ2pEO0VBQ0g7RUFDQTtJQUNFLFdBQVc7SUFDWCxVQUFVO0lBQ1YsUUFBUTtJQUNSLFdBQVc7TUFBQztLQUFTO0lBQ3JCLFVBQVU7TUFBQztRQUFFLEtBQUs7UUFBTSxNQUFNO1VBQUM7VUFBTztTQUFPO01BQUM7S0FBRTtFQUNsRDtDQUNELENBQUM7QUFFRiw4RUFBOEU7QUFDOUUsZUFBZTtBQUNmLDhFQUE4RTtBQUU5RTs7Ozs7Ozs7OztDQVVDLEdBQ0QsT0FBTyxTQUFTLHVCQUF1QixJQUFZO0VBQ2pELElBQUksU0FBUyxNQUFNLEtBQUssVUFBVSxDQUFDLFFBQVEsS0FBSyxRQUFRLENBQUMsT0FBTyxPQUFPO0VBQ3ZFLElBQUksYUFBYSxJQUFJLENBQUMsT0FBTyxPQUFPO0VBQ3BDLE9BQU8sS0FBSyxLQUFLLENBQUMsS0FBSyxLQUFLLENBQUMsQ0FBQyxPQUM1QixTQUFTLE1BQU0sU0FBUyxPQUFPLFNBQVM7QUFFNUM7QUFFQSw0Q0FBNEMsR0FDNUMsU0FBUyxTQUFTLElBQVk7RUFDNUIsT0FBTyxLQUFLLEtBQUssQ0FBQyxLQUFLLFdBQVcsQ0FBQyxPQUFPO0FBQzVDO0FBRUEsMEVBQTBFLEdBQzFFLFNBQVMsUUFBUSxJQUFZO0VBQzNCLE1BQU0sS0FBSyxLQUFLLFdBQVcsQ0FBQztFQUM1QixPQUFPLE9BQU8sQ0FBQyxJQUFJLEtBQUssS0FBSyxLQUFLLENBQUMsR0FBRztBQUN4QztBQUVBLDhEQUE4RCxHQUM5RCxTQUFTLFNBQVMsVUFBa0IsRUFBRSxRQUFnQjtFQUNwRCxNQUFNLE9BQU8sV0FBVyxPQUFPLENBQUMsUUFBUTtFQUN4QyxPQUFPLGFBQWEsS0FBSyxPQUFPLEdBQUcsS0FBSyxDQUFDLEVBQUUsVUFBVTtBQUN2RDtBQUVBLHVFQUF1RSxHQUN2RSxPQUFPLFNBQVMsZ0JBQWdCLElBQVk7RUFDMUMsTUFBTSxPQUFPLFNBQVM7RUFDdEIsT0FBTyxnQkFBZ0IsSUFBSSxDQUFDLENBQUMsT0FBUyxLQUFLLFFBQVEsS0FBSztBQUMxRDtBQUVBLDhFQUE4RTtBQUM5RSxvQkFBb0I7QUFDcEIsOEVBQThFO0FBRTlFOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLHNCQUNkLE1BQWMsRUFDZCxNQUFjO0VBRWQsTUFBTSxXQUFXO0lBQUMsVUFBVTtJQUFJLFVBQVU7R0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE9BQ3BELEtBQUssSUFBSSxHQUFHLE1BQU0sR0FBRyxHQUNyQixJQUFJLENBQUM7RUFDUCxNQUFNLFdBQVcsY0FBYyxVQUFVLE9BQU87RUFDaEQsSUFBSSxTQUFTLE1BQU0sS0FBSyxHQUFHLE9BQU87RUFFbEMsTUFBTSxRQUFRLFNBQVMsS0FBSyxDQUFDO0VBQzdCLE1BQU0sVUFBVSxLQUFLLEdBQUcsQ0FBQyxHQUFHLE1BQU0sTUFBTSxHQUFHO0VBQzNDLE1BQU0sU0FBUyxVQUFVLElBQ3JCLENBQUMsY0FBYyxFQUFFLFFBQVEsMkJBQTJCLENBQUMsR0FDckQ7RUFDSixNQUFNLE9BQU8sTUFBTSxLQUFLLENBQUMsQ0FBQyw4QkFBOEIsSUFBSSxDQUFDO0VBQzdELE9BQU8sZ0JBQWdCLFNBQVMsTUFBTTtBQUN4QztBQUVBLDBEQUEwRCxHQUMxRCxTQUFTLFNBQVMsT0FBcUI7RUFDckMsT0FBTyxDQUFDLEVBQUUsRUFBRTtJQUFDLFFBQVEsR0FBRztPQUFLLFFBQVEsSUFBSTtHQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQzFEO0FBRUEsOEVBQThFO0FBQzlFLFdBQVc7QUFDWCw4RUFBOEU7QUFFOUU7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUNELE9BQU8sTUFBTSxnQkFBbUMsT0FBTztFQUNyRCxJQUFJLEtBQUssR0FBRyxLQUFLLE9BQU87SUFDdEIsTUFBTSxTQUFTLE1BQU0sY0FBYztTQUFJLEtBQUssSUFBSTtLQUFDLEVBQUU7TUFDakQsS0FBSyxLQUFLLEdBQUc7TUFDYixnQkFBZ0IsS0FBSyxHQUFHLENBQUMsR0FBRyxLQUFLLElBQUksQ0FBQyxLQUFLLFNBQVMsR0FBRztJQUN6RDtJQUNBLHdEQUF3RDtJQUN4RCxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUUsTUFBTSxPQUFPLEtBQUs7SUFDbEMsT0FBTyxPQUFPLEtBQUs7RUFDckI7RUFFQSxNQUFNLFNBQVMsTUFBTSxJQUFJLEtBQUssT0FBTyxDQUFDLEtBQUssR0FBRyxFQUFFO0lBQzlDLE1BQU07U0FBSSxLQUFLLElBQUk7S0FBQztJQUNwQixLQUFLLEtBQUssR0FBRztJQUNiLE9BQU87SUFDUCxRQUFRO0lBQ1IsUUFBUTtJQUNSLHNFQUFzRTtJQUN0RSx3RUFBd0U7SUFDeEUsc0VBQXNFO0lBQ3RFLHVFQUF1RTtJQUN2RSw2Q0FBNkM7SUFDN0MsS0FBSztJQUNMLFVBQVU7SUFDVixRQUFRLFlBQVksT0FBTyxDQUFDLEtBQUssU0FBUztFQUM1QyxHQUFHLE1BQU07RUFFVCxNQUFNLFVBQVUsSUFBSTtFQUNwQixPQUFPO0lBQ0wsTUFBTSxPQUFPLElBQUk7SUFDakIsUUFBUSxRQUFRLE1BQU0sQ0FBQyxPQUFPLE1BQU07SUFDcEMsUUFBUSxRQUFRLE1BQU0sQ0FBQyxPQUFPLE1BQU07RUFDdEM7QUFDRixFQUFFO0FBRUY7Ozs7O0NBS0MsR0FDRCxNQUFNLG1CQUE4QixPQUFPO0VBQ3pDLEtBQUssTUFBTSxPQUFPLENBQUMsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxFQUFFLEtBQUssQ0FBQyxLQUFNO0lBQ3pELElBQUksUUFBUSxJQUFJO0lBQ2hCLElBQUk7TUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQyxFQUFFLEtBQUs7TUFDNUMsSUFBSSxLQUFLLE1BQU0sSUFBSSxLQUFLLFNBQVMsRUFBRSxPQUFPO0lBQzVDLEVBQUUsT0FBTyxPQUFPO01BQ2QsTUFBTSxTQUFTLGlCQUFpQixLQUFLLE1BQU0sQ0FBQyxRQUFRLElBQ2xELGlCQUFpQixLQUFLLE1BQU0sQ0FBQyxnQkFBZ0I7TUFDL0MsSUFBSSxDQUFDLFFBQVEsTUFBTTtJQUNyQjtFQUNGO0VBQ0EsT0FBTztBQUNUO0FBRUEsK0VBQStFLEdBQy9FLFNBQVMsY0FDUCxVQUFrQjtFQUVsQixPQUFPLE9BQU87SUFDWixJQUFJO01BQ0YsT0FBTyxNQUFNLEtBQUssWUFBWSxDQUFDLFNBQVMsWUFBWTtJQUN0RCxFQUFFLE9BQU8sT0FBTztNQUNkLElBQUksaUJBQWlCLEtBQUssTUFBTSxDQUFDLFFBQVEsRUFBRSxPQUFPO01BQ2xELE1BQU07SUFDUjtFQUNGO0FBQ0Y7QUFFQSw4RUFBOEU7QUFDOUUsZUFBZTtBQUNmLDhFQUE4RTtBQUU5RTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxlQUFlLG1CQUNwQixRQUFnQixFQUNoQixPQUF5QjtFQUV6QixNQUFNLEVBQ0osVUFBVSxFQUNWLGdCQUFnQixFQUNoQixTQUFTLGFBQWEsRUFDdEIsVUFBVSxnQkFBZ0IsRUFDMUIsZUFBZSxjQUFjLFdBQVcsRUFDeEMsWUFBWSw2QkFBNkIsRUFDekMsTUFBTSxFQUNQLEdBQUc7RUFFSixNQUFNLFFBQVEsQ0FBQztJQUNiLFFBQVEsS0FBSyxDQUFDLG9DQUFvQyxFQUFFLFFBQVEsRUFBRTtNQUM1RDtNQUNBO0lBQ0Y7SUFDQSxPQUFPO01BQUUsTUFBTTtNQUFjLE1BQU07TUFBVTtJQUFPO0VBQ3REO0VBRUEsSUFBSSxDQUFDLHVCQUF1QixXQUFXO0lBQ3JDLE9BQU8sTUFBTSxDQUFDLDJDQUEyQyxFQUFFLFVBQVU7RUFDdkU7RUFFQSxNQUFNLE9BQU8sZ0JBQWdCO0VBQzdCLElBQUksQ0FBQyxNQUFNLE9BQU8sTUFBTSxDQUFDLHNCQUFzQixFQUFFLFVBQVU7RUFFM0QsTUFBTSxZQUFZLFFBQVE7RUFFMUIseUVBQXlFO0VBQ3pFLEtBQUssTUFBTSxZQUFZLEtBQUssU0FBUyxDQUFFO0lBQ3JDLE1BQU0sZUFBZSxjQUFjLEtBQy9CLFdBQ0EsR0FBRyxVQUFVLENBQUMsRUFBRSxVQUFVO0lBQzlCLElBQUksaUJBQWlCLEdBQUcsQ0FBQyxrQkFBa0IsY0FBYztNQUN2RCxPQUFPLE1BQ0wsQ0FBQyxhQUFhLEVBQUUsYUFBYSxzQ0FBc0MsQ0FBQyxHQUNsRSxDQUFDLHVDQUF1QyxDQUFDO0lBRS9DO0VBQ0Y7RUFFQSwwRUFBMEU7RUFDMUUsd0NBQXdDO0VBQ3hDLElBQUksS0FBSyxTQUFTLEVBQUU7SUFDbEIsTUFBTSxTQUFTLGNBQWMsS0FBSyxLQUFLLEdBQUcsVUFBVSxDQUFDLENBQUM7SUFDdEQsS0FBSyxNQUFNLENBQUMsTUFBTSxPQUFPLElBQUksaUJBQWtCO01BQzdDLElBQUksV0FBVyxnQkFBZ0IsQ0FBQyxLQUFLLFVBQVUsQ0FBQyxTQUFTO01BQ3pELE1BQU0sV0FBVyxLQUFLLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxXQUNwQyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxVQUFVLEtBQUssU0FBUyxHQUFHLFNBQVMsVUFBVTtNQUVsRSxJQUFJLENBQUMsVUFBVTtNQUNmLE9BQU8sTUFDTCxDQUFDLHVCQUF1QixFQUFFLEtBQUssaUNBQWlDLENBQUMsR0FDL0QsQ0FBQyw0Q0FBNEMsQ0FBQztJQUVwRDtFQUNGO0VBRUEsSUFBSSxDQUFDLE1BQU0sUUFBUSxLQUFLLE1BQU0sR0FBRztJQUMvQixPQUFPLE1BQ0wsQ0FBQyxJQUFJLEVBQUUsS0FBSyxTQUFTLENBQUMsb0JBQW9CLEVBQUUsS0FBSyxNQUFNLENBQUMsYUFBYSxDQUFDLEdBQ3BFLENBQUMsc0JBQXNCLENBQUM7RUFFOUI7RUFFQSxNQUFNLE1BQU0sU0FBUyxZQUFZO0VBQ2pDLE1BQU0sTUFBTSxPQUNWO0lBRUEsSUFBSTtNQUNGLE9BQU8sTUFBTSxPQUFPO1FBQ2xCLEtBQUssUUFBUSxHQUFHO1FBQ2hCLE1BQU0sUUFBUSxJQUFJO1FBQ2xCO1FBQ0E7UUFDQTtNQUNGO0lBQ0YsRUFBRSxPQUFPLE9BQU87TUFDZCxPQUFPO1FBQUUsUUFBUSxBQUFDLE1BQWdCLE9BQU87TUFBQztJQUM1QztFQUNGO0VBRUEsMkVBQTJFLEdBQzNFLE1BQU0sVUFBVTtJQUNkLE1BQU0sSUFBSTtNQUFFLEtBQUs7TUFBTyxNQUFNO1FBQUM7UUFBWTtRQUFXO1FBQU07T0FBUztJQUFDO0VBQ3hFO0VBRUEsMEVBQTBFO0VBQzFFLGdDQUFnQztFQUNoQyxNQUFNLFdBQVcsTUFBTSxJQUFJO0lBQ3pCLEtBQUs7SUFDTCxNQUFNO01BQUM7TUFBWTtNQUFVO01BQU07S0FBUztFQUM5QztFQUNBLElBQUksWUFBWSxVQUFVO0lBQ3hCLE9BQU8sTUFBTSxDQUFDLGdCQUFnQixFQUFFLFNBQVMsU0FBUyxFQUFFLFNBQVMsTUFBTSxFQUFFO0VBQ3ZFO0VBQ0EsSUFBSSxTQUFTLElBQUksS0FBSyxHQUFHO0lBQ3ZCLE9BQU8sTUFDTCxDQUFDLHVCQUF1QixFQUFFLFNBQVMsUUFBUSxFQUFFLFNBQVMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxHQUM1RCxzQkFBc0IsU0FBUyxNQUFNLEVBQUUsU0FBUyxNQUFNO0VBRTVEO0VBRUEsSUFBSTtFQUNKLElBQUksY0FBYztFQUNsQixLQUFLLE1BQU0sV0FBVyxLQUFLLFFBQVEsQ0FBRTtJQUNuQyxNQUFNLFNBQVMsTUFBTSxJQUFJO0lBQ3pCLElBQUksWUFBWSxRQUFRO01BQ3RCLGNBQWMsR0FBRyxTQUFTLFNBQVMsbUJBQW1CLEVBQUUsT0FBTyxNQUFNLEVBQUU7TUFDdkU7SUFDRjtJQUNBLElBQUksT0FBTyxJQUFJLEtBQUssR0FBRztNQUNyQixZQUFZO01BQ1o7SUFDRjtJQUNBLGNBQWMsR0FBRyxTQUFTLFNBQVMsdUJBQXVCLEVBQUUsT0FBTyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQ3hFLENBQUMsRUFBRSxFQUFFLHNCQUFzQixPQUFPLE1BQU0sRUFBRSxPQUFPLE1BQU0sR0FBRztFQUM5RDtFQUVBLElBQUksQ0FBQyxXQUFXO0lBQ2QsTUFBTTtJQUNOLE9BQU8sTUFBTSxDQUFDLGFBQWEsRUFBRSxTQUFTLFVBQVUsRUFBRSxhQUFhO0VBQ2pFO0VBRUEsTUFBTSxVQUFVLE1BQU0sYUFBYTtFQUNuQyxJQUFJLFlBQVksTUFBTTtJQUNwQixNQUFNO0lBQ04sT0FBTyxNQUNMLEdBQUcsU0FBUyxXQUFXLGlCQUFpQixFQUFFLFNBQVMsa0JBQWtCLENBQUM7RUFFMUU7RUFDQSxJQUFJLHdCQUF3QixJQUFJLENBQUMsVUFBVTtJQUN6QyxNQUFNO0lBQ04sT0FBTyxNQUNMLEdBQUcsU0FBUyxXQUFXLGlCQUFpQixFQUFFLFNBQVMsZ0JBQWdCLENBQUMsR0FDbEUsQ0FBQyxnQkFBZ0IsQ0FBQztFQUV4QjtFQUVBLE1BQU0sU0FBUyxNQUFNLElBQUk7SUFBRSxLQUFLO0lBQU8sTUFBTTtNQUFDO01BQU87TUFBTTtLQUFTO0VBQUM7RUFDckUsSUFBSSxZQUFZLFVBQVUsT0FBTyxJQUFJLEtBQUssR0FBRztJQUMzQyxNQUFNO0lBQ04sTUFBTSxTQUFTLFlBQVksU0FDdkIsT0FBTyxNQUFNLEdBQ2IsQ0FBQyxLQUFLLEVBQUUsT0FBTyxJQUFJLENBQUMsRUFBRSxFQUN0QixzQkFBc0IsT0FBTyxNQUFNLEVBQUUsT0FBTyxNQUFNLEdBQ2xEO0lBQ0osT0FBTyxNQUFNLENBQUMsd0JBQXdCLEVBQUUsU0FBUyxVQUFVLEVBQUUsUUFBUTtFQUN2RTtFQUVBLFFBQVEsT0FBTyxDQUFDLFlBQVksRUFBRSxTQUFTLHlCQUF5QixDQUFDLEVBQUU7SUFDakU7SUFDQSxXQUFXLEtBQUssU0FBUztJQUN6QixTQUFTO01BQUMsVUFBVSxHQUFHO1NBQUssVUFBVSxJQUFJO0tBQUMsQ0FBQyxJQUFJLENBQUM7RUFDbkQ7RUFFQSxPQUFPO0lBQ0wsTUFBTTtJQUNOLE1BQU07SUFDTixXQUFXLEtBQUssU0FBUztJQUN6QixTQUFTO0VBQ1g7QUFDRjtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sZUFBZSxvQkFDcEIsT0FBOEI7RUFFOUIsTUFBTSxXQUErQixFQUFFO0VBQ3ZDLEtBQUssTUFBTSxZQUFZLFFBQVEsU0FBUyxDQUFFO0lBQ3hDLFNBQVMsSUFBSSxDQUFDLE1BQU0sbUJBQW1CLFVBQVU7RUFDbkQ7RUFDQSxPQUFPO0FBQ1QifQ==
// denoCacheMetadata=15961230294098869352,5774884374921080759